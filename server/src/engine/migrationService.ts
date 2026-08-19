/**
 * migrationService.ts
 * ---------------------------------------------------------------------------
 * Bridges the pure XState machine to persistence. Each time an event is applied:
 *   1. rebuild machine state from the DB row (including migrationType, so the
 *      correct branch — MIGRATION or GREENFIELD — is restored),
 *   2. send the event, letting guards decide if the transition is legal,
 *   3. persist the new state + an immutable AuditEvent,
 *   4. run side effects (provision, sample latency, generate report/certificate).
 *
 * Guards live in the machine, so illegal transitions (e.g. cutover without
 * sign-off, or go-live without a smoke test) are rejected here, not silently
 * allowed — the defensibility point, for BOTH onboarding paths.
 * ---------------------------------------------------------------------------
 */
import { createActor } from 'xstate';
import {
  migrationMachine, STATE_META,
  type MigrationContext, type MigrationEvent, type MigrationType,
} from './migrationMachine.js';
import { prisma } from '../db/prisma.js';
import { getProvider, recommendProvider } from '../adapters/provider.js';
import { makeMonitor } from '../adapters/monitoring.js';
import { buildAuditReport, type AuditReport } from '../lib/auditReport.js';

/** Rehydrate a machine actor at the persisted state with the persisted context. */
function actorFor(row: any) {
  const restored = {
    value: row.state,
    context: {
      migrationId: row.id,
      clientId: row.clientId,
      migrationType: row.migrationType as MigrationType,
      providerId: row.providerId,
      dataVolumeGB: row.dataVolumeGB,
      estimatedDowntimeMin: row.estimatedDowntimeMin,
      replicationLagSec: row.replicationLagSec,
      integrityPassed: row.integrityPassed,
      clientSignedOff: row.clientSignedOff,
      smokeTestPassed: row.smokeTestPassed,
      cutoverAt: row.cutoverAt ? new Date(row.cutoverAt).toISOString() : null,
      goLiveAt: row.goLiveAt ? new Date(row.goLiveAt).toISOString() : null,
      guaranteeWindowDays: row.guaranteeWindowDays,
      latencyBeforeMs: row.latencyBeforeMs,
      latencyAfterMs: row.latencyAfterMs,
      targetEndpoint: row.targetEndpoint,
      error: row.error,
    } as MigrationContext,
  };
  const actor = createActor(migrationMachine, {
    snapshot: migrationMachine.resolveState(restored as any),
  });
  return actor;
}

async function persist(migrationId: string, snapshot: any, event: MigrationEvent, fromState: string) {
  const ctx = snapshot.context as MigrationContext;
  const toState = String(snapshot.value);
  await prisma.$transaction([
    prisma.migration.update({
      where: { id: migrationId },
      data: {
        state: toState,
        providerId: ctx.providerId,
        dataVolumeGB: ctx.dataVolumeGB,
        estimatedDowntimeMin: ctx.estimatedDowntimeMin,
        replicationLagSec: ctx.replicationLagSec,
        integrityPassed: ctx.integrityPassed,
        clientSignedOff: ctx.clientSignedOff,
        smokeTestPassed: ctx.smokeTestPassed,
        cutoverAt: ctx.cutoverAt ? new Date(ctx.cutoverAt) : null,
        goLiveAt: ctx.goLiveAt ? new Date(ctx.goLiveAt) : null,
        latencyBeforeMs: ctx.latencyBeforeMs,
        latencyAfterMs: ctx.latencyAfterMs,
        targetEndpoint: ctx.targetEndpoint,
        error: ctx.error,
      },
    }),
    prisma.auditEvent.create({
      data: {
        migrationId,
        fromState,
        toState,
        eventType: event.type,
        pillar: STATE_META[toState]?.pillar ?? 0,
        detail: JSON.stringify({ context: ctx }),
      },
    }),
  ]);
}

/** Apply an event to a migration, enforcing all machine guards (either path). */
export async function applyEvent(migrationId: string, event: MigrationEvent) {
  const row = await prisma.migration.findUnique({ where: { id: migrationId } });
  if (!row) throw new Error('Migration not found');

  const actor = actorFor(row);
  actor.start();
  const before = String(actor.getSnapshot().value);

  actor.send(event as any);
  const after = actor.getSnapshot();
  const afterState = String(after.value);

  const inPlaceEvents = ['INTEGRITY_PASS', 'CLIENT_SIGN_OFF', 'SMOKE_TEST_PASS'];
  if (afterState === before && !inPlaceEvents.includes(event.type)) {
    // A guard blocked the transition (e.g. cutover before sign-off, or
    // go-live before a passed smoke test).
    actor.stop();
    throw new Error(
      `Transition '${event.type}' rejected in state '${before}'. ` +
        (after.context.error ? after.context.error : 'Guard not satisfied.'),
    );
  }

  await persist(migrationId, after, event, before);
  actor.stop();
  return { state: afterState, context: after.context };
}

/**
 * Build (and cache) the Pillar-1 report for either onboarding path:
 *   MIGRATION  -> "Pre-Flight Data Readiness Audit"  (state: auditReady)
 *   GREENFIELD -> "Sizing & Requirements Report"      (state: sizingReady)
 * Cached to Migration.auditReportJson so repeated fetches are free and stable.
 */
export async function getOrBuildAuditReport(migrationId: string): Promise<AuditReport> {
  const row = await prisma.migration.findUnique({ where: { id: migrationId }, include: { client: true } });
  if (!row) throw new Error('Migration not found');

  if (row.auditReportJson) {
    try {
      return JSON.parse(row.auditReportJson) as AuditReport;
    } catch {
      /* fall through and regenerate if the cache is somehow corrupt */
    }
  }

  const report = buildAuditReport({
    migrationId: row.id,
    migrationType: row.migrationType as MigrationType,
    orgName: row.client.orgName,
    sector: row.client.sector,
    currentProvider: row.client.currentProvider,
    dataVolumeGB: row.dataVolumeGB,
    estimatedDowntimeMin: row.estimatedDowntimeMin,
    latencyBeforeMs: row.latencyBeforeMs,
    recommendedProviderId: row.providerId,
    generatedAt: new Date().toISOString(),
  });

  await prisma.migration.update({
    where: { id: migrationId },
    data: { auditReportJson: JSON.stringify(report) },
  });

  return report;
}

/**
 * Convenience: run one automated step of the happy path for EITHER onboarding
 * type. In the real system each of these is triggered by a real side effect
 * (discovery finishing, replication going healthy, etc.). Here we simulate the
 * side effect then emit the event.
 */
export async function autoStep(migrationId: string, preferredProviderId?: string) {
  const row = await prisma.migration.findUnique({ where: { id: migrationId } });
  if (!row) throw new Error('Migration not found');
  const isGreenfield = row.migrationType === 'GREENFIELD';

  switch (row.state) {
    case 'created':
      return isGreenfield
        ? applyEvent(migrationId, { type: 'START_INTAKE' })
        : applyEvent(migrationId, { type: 'START_AUDIT' });

    // ---- MIGRATION: Pillar 1 ----
    case 'discovery': {
      const latencyBeforeMs = 240 + Math.floor(Math.random() * 40);
      const estimatedDowntimeMin = 3 + Math.floor(Math.random() * 2);
      const res = await applyEvent(migrationId, {
        type: 'AUDIT_COMPLETE',
        dataVolumeGB: row.dataVolumeGB,
        estimatedDowntimeMin,
        latencyBeforeMs,
      });
      await getOrBuildAuditReport(migrationId); // generate + cache the report now it's ready
      return res;
    }
    case 'auditReady': {
      // Operator can pick the Tier III partner explicitly (preferredProviderId);
      // falls back to the deterministic cheapest-viable recommendation otherwise.
      const { providerId, reason } = await recommendProvider(preferredProviderId);
      const res = await applyEvent(migrationId, { type: 'APPROVE_AUDIT', providerId });
      await prisma.auditEvent.create({
        data: { migrationId, fromState: 'auditReady', toState: 'provisioning', eventType: 'PLACEMENT', pillar: 2, detail: reason },
      });
      return res;
    }

    // ---- GREENFIELD: Pillar 1 ----
    case 'intake': {
      const res = await applyEvent(migrationId, { type: 'INTAKE_COMPLETE', dataVolumeGB: row.dataVolumeGB });
      await getOrBuildAuditReport(migrationId);
      return res;
    }
    case 'sizingReady': {
      // Operator can pick the Tier III partner explicitly (preferredProviderId);
      // falls back to the deterministic cheapest-viable recommendation otherwise.
      const { providerId, reason } = await recommendProvider(preferredProviderId);
      const res = await applyEvent(migrationId, { type: 'APPROVE_SIZING', providerId });
      await prisma.auditEvent.create({
        data: { migrationId, fromState: 'sizingReady', toState: 'provisioning', eventType: 'PLACEMENT', pillar: 2, detail: reason },
      });
      return res;
    }

    // ---- Shared Pillar 2 entry: provisioning sets the REAL local target endpoint ----
    case 'provisioning': {
      const provider = getProvider(row.providerId ?? 'aos')!;
      await provider.provision({ migrationId, dataVolumeGB: row.dataVolumeGB });
      // The local mock Tier III origin stands in for "this client's app on
      // local infrastructure." In production this would be the real
      // provisioned VM's address. See mock-origin.ts.
      const targetEndpoint = process.env.MOCK_ORIGIN_URL ?? 'http://localhost:5050/ping';
      return applyEvent(migrationId, { type: 'PROVISION_DONE', targetEndpoint });
    }

    // ---- MIGRATION: Pillar 2 continued ----
    case 'replicating':
      return applyEvent(migrationId, { type: 'REPLICATION_HEALTHY', replicationLagSec: 1 + Math.floor(Math.random() * 3) });

    case 'staging': {
      await applyEvent(migrationId, { type: 'INTEGRITY_PASS' });
      await applyEvent(migrationId, { type: 'CLIENT_SIGN_OFF' });
      const s = await probeTarget(row.targetEndpoint);
      return applyEvent(migrationId, { type: 'EXECUTE_CUTOVER', latencyAfterMs: s.latencyMs });
    }

    // ---- GREENFIELD: Pillar 2 continued ----
    case 'smokeTest': {
      await applyEvent(migrationId, { type: 'SMOKE_TEST_PASS' });
      const s = await probeTarget(row.targetEndpoint);
      return applyEvent(migrationId, { type: 'GO_LIVE', latencyAfterMs: s.latencyMs });
    }

    default:
      return { state: row.state, context: null, note: 'No further auto-step from this state.' };
  }
}

/** Sample the migration's real local target once, for the cutover/go-live latency figure. */
async function probeTarget(targetEndpoint: string | null) {
  const monitor = makeMonitor();
  return monitor.sample(targetEndpoint ?? process.env.MOCK_ORIGIN_URL ?? 'http://localhost:5050/ping');
}

/**
 * Record one uptime/latency sample for a live (monitoring) migration.
 *
 * IMPORTANT: once live, we probe the migration's own `targetEndpoint` — the
 * REAL local address this client now runs on — not the original offshore
 * `client.endpoint` used only for the pre-migration baseline. Monitoring the
 * old offshore URL after cutover would defeat the entire point of measuring
 * the improvement, and is exactly why a public site like Wikipedia will never
 * show the <100ms local target: it was never the right thing to probe here.
 */
export async function recordSample(migrationId: string) {
  const migration = await prisma.migration.findUnique({
    where: { id: migrationId },
    include: { client: true },
  });
  if (!migration) throw new Error('Migration not found');

  const endpoint =
    migration.targetEndpoint?.trim() ||
    process.env.MOCK_ORIGIN_URL ||
    migration.client.endpoint?.trim() ||
    `client-${migrationId}`;

  const monitor = makeMonitor();
  const s = await monitor.sample(endpoint);

  await prisma.uptimeSample.create({
    data: { migrationId, up: s.up, latencyMs: s.latencyMs, source: s.source, at: new Date(s.at) },
  });
  return s;
}
