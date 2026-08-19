/**
 * migrationMachine.ts
 * ---------------------------------------------------------------------------
 * The defensible core of Kigali Digital Infrastructure Ltd.
 *
 * Two onboarding paths share ONE machine and the same guard discipline:
 *
 *   MIGRATION  (existing app moving off offshore hosting — the original flow)
 *     Pillar 1 Pre-Flight Audit:      discovery -> auditReady
 *     Pillar 2 Background Sync:       provisioning -> replicating -> staging
 *     Pillar 3 Zero-Downtime Cutover: cutover -> monitoring (+ Safe Rollback)
 *
 *   GREENFIELD (brand-new app, never hosted anywhere — no source to migrate)
 *     Pillar 1 Requirements & Sizing: intake -> sizingReady
 *     Pillar 2 Environment Setup:     provisioning -> smokeTest
 *     Pillar 3 Go-Live:               launch -> monitoring (+ guarantee window)
 *
 * Both paths converge at 'provisioning' (same provider aggregation logic serves
 * both) and diverge again for pillar 3, because a migration needs a *cutover*
 * from somewhere, while a greenfield app just needs a verified *launch*. Both
 * are still gated: MIGRATION cannot cut over without integrity + sign-off;
 * GREENFIELD cannot go live without a passed smoke test. The same immutable
 * audit trail, the same Safe Rollback / guarantee-window logic, apply to both.
 * ---------------------------------------------------------------------------
 */
import { createMachine, assign } from 'xstate';

export type MigrationType = 'MIGRATION' | 'GREENFIELD';

export type MigrationContext = {
  migrationId: string;
  clientId: string;
  migrationType: MigrationType;
  providerId: string | null;        // which data center (AOS / ADC / PAIX)
  dataVolumeGB: number | null;
  estimatedDowntimeMin: number | null;
  replicationLagSec: number | null;
  integrityPassed: boolean;         // MIGRATION gate
  clientSignedOff: boolean;         // MIGRATION gate
  smokeTestPassed: boolean;         // GREENFIELD gate
  cutoverAt: string | null;         // ISO timestamp — MIGRATION go-live
  goLiveAt: string | null;          // ISO timestamp — GREENFIELD go-live
  guaranteeWindowDays: number;      // Safe Rollback / guarantee window (default 30)
  latencyBeforeMs: number | null;   // offshore baseline (MIGRATION only)
  latencyAfterMs: number | null;
  targetEndpoint: string | null;    // REAL local URL monitored once live
  error: string | null;
};

export type MigrationEvent =
  // shared pillar 1 kick-off (guarded by migrationType)
  | { type: 'START_AUDIT' }
  | { type: 'AUDIT_COMPLETE'; dataVolumeGB: number; estimatedDowntimeMin: number; latencyBeforeMs: number }
  | { type: 'APPROVE_AUDIT'; providerId: string }
  | { type: 'START_INTAKE' }
  | { type: 'INTAKE_COMPLETE'; dataVolumeGB: number }
  | { type: 'APPROVE_SIZING'; providerId: string }
  // shared pillar 2
  | { type: 'PROVISION_DONE'; targetEndpoint?: string }
  | { type: 'REPLICATION_HEALTHY'; replicationLagSec: number }
  | { type: 'INTEGRITY_PASS' }
  | { type: 'INTEGRITY_FAIL'; reason: string }
  | { type: 'CLIENT_SIGN_OFF' }
  | { type: 'SMOKE_TEST_PASS' }
  | { type: 'SMOKE_TEST_FAIL'; reason: string }
  // pillar 3 — diverges by type
  | { type: 'EXECUTE_CUTOVER'; latencyAfterMs: number }   // MIGRATION only
  | { type: 'GO_LIVE'; latencyAfterMs: number }           // GREENFIELD only
  | { type: 'ROLLBACK'; reason: string }
  | { type: 'RETRY' };

/** Guard: MIGRATION cutover requires integrity pass AND client sign-off. */
function canCutover(ctx: MigrationContext): boolean {
  return ctx.integrityPassed === true && ctx.clientSignedOff === true;
}

/** Guard: GREENFIELD go-live requires a passed smoke test. */
function canGoLive(ctx: MigrationContext): boolean {
  return ctx.smokeTestPassed === true;
}

/** The timestamp that started the guarantee clock, whichever path was taken. */
function liveAt(ctx: MigrationContext): string | null {
  return ctx.cutoverAt ?? ctx.goLiveAt;
}

/** Guard: Safe Rollback / guarantee window is only free within N days of going live. */
export function withinGuaranteeWindow(ctx: MigrationContext, nowIso?: string): boolean {
  const startedAt = liveAt(ctx);
  if (!startedAt) return true; // pre-launch rollback always allowed
  const now = new Date(nowIso ?? new Date().toISOString()).getTime();
  const start = new Date(startedAt).getTime();
  const days = (now - start) / (1000 * 60 * 60 * 24);
  return days <= ctx.guaranteeWindowDays;
}

export const migrationMachine = createMachine(
  {
    id: 'migration',
    types: {} as { context: MigrationContext; events: MigrationEvent },
    context: ({ input }: any) => ({
      migrationId: input?.migrationId ?? 'unknown',
      clientId: input?.clientId ?? 'unknown',
      migrationType: (input?.migrationType as MigrationType) ?? 'MIGRATION',
      providerId: null,
      dataVolumeGB: null,
      estimatedDowntimeMin: null,
      replicationLagSec: null,
      integrityPassed: false,
      clientSignedOff: false,
      smokeTestPassed: false,
      cutoverAt: null,
      goLiveAt: null,
      guaranteeWindowDays: input?.guaranteeWindowDays ?? 30,
      latencyBeforeMs: null,
      latencyAfterMs: null,
      targetEndpoint: null,
      error: null,
    }),
    initial: 'created',
    states: {
      // ======================== PILLAR 1 ========================
      created: {
        meta: { pillar: 1, label: 'Client onboarded', description: 'Workspace created; ready to start.' },
        on: {
          START_AUDIT: { guard: 'isMigration', target: 'discovery' },
          START_INTAKE: { guard: 'isGreenfield', target: 'intake' },
        },
      },

      // ---- MIGRATION branch: Pre-Flight Data Readiness Audit ----
      discovery: {
        meta: { pillar: 1, label: 'Discovery running', description: 'Read-only inventory of the client\u2019s current (offshore) environment.' },
        on: {
          AUDIT_COMPLETE: {
            target: 'auditReady',
            actions: assign(({ event }: any) => ({
              dataVolumeGB: event.dataVolumeGB,
              estimatedDowntimeMin: event.estimatedDowntimeMin,
              latencyBeforeMs: event.latencyBeforeMs,
            })),
          },
        },
      },
      auditReady: {
        meta: { pillar: 1, label: 'Audit report ready', description: 'Readiness & risk report generated; awaiting go/no-go.' },
        on: {
          APPROVE_AUDIT: {
            target: 'provisioning',
            actions: assign(({ event }: any) => ({ providerId: event.providerId })),
          },
        },
      },

      // ---- GREENFIELD branch: Requirements & Sizing ----
      intake: {
        meta: { pillar: 1, label: 'Requirements intake', description: 'Capturing expected traffic, data volume, and compliance needs for the new app.' },
        on: {
          INTAKE_COMPLETE: {
            target: 'sizingReady',
            actions: assign(({ event }: any) => ({ dataVolumeGB: event.dataVolumeGB })),
          },
        },
      },
      sizingReady: {
        meta: { pillar: 1, label: 'Sizing report ready', description: 'Recommended environment size & tier generated; awaiting go/no-go.' },
        on: {
          APPROVE_SIZING: {
            target: 'provisioning',
            actions: assign(({ event }: any) => ({ providerId: event.providerId })),
          },
        },
      },

      // ======================== PILLAR 2 ========================
      // Shared: both paths provision on the same aggregated Tier III capacity.
      provisioning: {
        meta: { pillar: 2, label: 'Provisioning local env', description: '1-click provision of a target VM on the chosen Tier III provider.' },
        on: {
          PROVISION_DONE: [
            { guard: 'isGreenfield', target: 'smokeTest', actions: assign(({ event }: any) => ({ targetEndpoint: event.targetEndpoint ?? null })) },
            { target: 'replicating', actions: assign(({ event }: any) => ({ targetEndpoint: event.targetEndpoint ?? null })) },
          ],
        },
      },

      // ---- MIGRATION: Background Synchronization ----
      replicating: {
        meta: { pillar: 2, label: 'Replicating (live)', description: 'Continuous background replication; client stays online on the old server.' },
        on: {
          REPLICATION_HEALTHY: {
            target: 'staging',
            actions: assign(({ event }: any) => ({ replicationLagSec: event.replicationLagSec })),
          },
        },
      },
      staging: {
        meta: { pillar: 2, label: 'Staging & verification', description: 'Isolated mirror stood up; integrity check + client testing.' },
        on: {
          INTEGRITY_PASS: { actions: assign({ integrityPassed: () => true }) },
          INTEGRITY_FAIL: {
            target: 'failed',
            actions: assign(({ event }: any) => ({ error: event.reason, integrityPassed: false })),
          },
          CLIENT_SIGN_OFF: { actions: assign({ clientSignedOff: () => true }) },
          EXECUTE_CUTOVER: [
            {
              guard: 'canCutover',
              target: 'cutover',
              actions: assign(({ event }: any) => ({ latencyAfterMs: event.latencyAfterMs })),
            },
          ],
        },
      },

      // ---- GREENFIELD: Environment Setup & Verification ----
      smokeTest: {
        meta: { pillar: 2, label: 'Smoke test running', description: 'New environment verified healthy — no data to sync, nothing to migrate.' },
        on: {
          SMOKE_TEST_PASS: { actions: assign({ smokeTestPassed: () => true }) },
          SMOKE_TEST_FAIL: {
            target: 'failed',
            actions: assign(({ event }: any) => ({ error: event.reason, smokeTestPassed: false })),
          },
          GO_LIVE: [
            {
              guard: 'canGoLive',
              target: 'launch',
              actions: assign(({ event }: any) => ({ latencyAfterMs: event.latencyAfterMs })),
            },
          ],
        },
      },

      // ======================== PILLAR 3 ========================
      // ---- MIGRATION: Zero-Downtime Cutover ----
      cutover: {
        meta: { pillar: 3, label: 'Cutover executing', description: 'Orchestrated DNS re-point to Kigali; target < 5 min downtime.' },
        entry: assign({ cutoverAt: () => new Date().toISOString() }),
        on: { ROLLBACK: { target: 'rolledBack', actions: assign(({ event }: any) => ({ error: event.reason })) } },
        always: { target: 'monitoring' },
      },

      // ---- GREENFIELD: Go-Live ----
      launch: {
        meta: { pillar: 3, label: 'Launching', description: 'First-ever DNS point for this app to its new local home — no prior traffic to protect.' },
        entry: assign({ goLiveAt: () => new Date().toISOString() }),
        on: { ROLLBACK: { target: 'rolledBack', actions: assign(({ event }: any) => ({ error: event.reason })) } },
        always: { target: 'monitoring' },
      },

      // ---- Shared: Live & Monitored ----
      monitoring: {
        meta: { pillar: 3, label: 'Live & monitored', description: 'Client live locally; 24/7 uptime & latency tracked (Hypercare).' },
        on: {
          ROLLBACK: [
            { guard: 'withinGuaranteeWindow', target: 'rolledBack', actions: assign(({ event }: any) => ({ error: event.reason })) },
            { target: 'monitoring', actions: assign({ error: () => 'Rollback/decommission requested outside the 30-day guarantee window (paid change).' }) },
          ],
        },
      },

      // ---- Terminal / recovery states ----
      failed: {
        meta: { pillar: 2, label: 'Failed (verification)', description: 'Integrity or smoke test failed; nothing went live. Client stays safe on source (or not launched).' },
        on: { RETRY: [{ guard: 'isGreenfield', target: 'smokeTest' }, { target: 'replicating' }] },
      },
      rolledBack: {
        meta: { pillar: 3, label: 'Rolled back / decommissioned (safe)', description: 'MIGRATION: traffic restored to original provider. GREENFIELD: environment safely decommissioned. Either way, under the guarantee promise.' },
        type: 'final',
      },
    },
  },
  {
    guards: {
      isMigration: ({ context }: any) => context.migrationType === 'MIGRATION',
      isGreenfield: ({ context }: any) => context.migrationType === 'GREENFIELD',
      canCutover: ({ context }: any) => canCutover(context),
      canGoLive: ({ context }: any) => canGoLive(context),
      withinGuaranteeWindow: ({ context }: any) => withinGuaranteeWindow(context),
    },
  }
);

/** Ordered happy-path states per onboarding type, for UI progress rendering. */
export const HAPPY_PATH_MIGRATION = [
  'created', 'discovery', 'auditReady', 'provisioning', 'replicating', 'staging', 'cutover', 'monitoring',
] as const;

export const HAPPY_PATH_GREENFIELD = [
  'created', 'intake', 'sizingReady', 'provisioning', 'smokeTest', 'launch', 'monitoring',
] as const;

export function happyPathFor(type: MigrationType): readonly string[] {
  return type === 'GREENFIELD' ? HAPPY_PATH_GREENFIELD : HAPPY_PATH_MIGRATION;
}

/** Back-compat default export used by older callers that assumed one path. */
export const HAPPY_PATH = HAPPY_PATH_MIGRATION;

/** Human-readable metadata for every state, safe to send to the client. */
export const STATE_META: Record<string, { pillar: number; label: string; description: string }> = {
  created: { pillar: 1, label: 'Client onboarded', description: 'Workspace created; ready to start.' },
  discovery: { pillar: 1, label: 'Discovery running', description: 'Read-only inventory of the current (offshore) environment.' },
  auditReady: { pillar: 1, label: 'Audit report ready', description: 'Readiness & risk report generated; awaiting go/no-go.' },
  intake: { pillar: 1, label: 'Requirements intake', description: 'Capturing expected traffic, data volume, and compliance needs.' },
  sizingReady: { pillar: 1, label: 'Sizing report ready', description: 'Recommended environment size & tier generated; awaiting go/no-go.' },
  provisioning: { pillar: 2, label: 'Provisioning local env', description: '1-click provision on the chosen Tier III provider.' },
  replicating: { pillar: 2, label: 'Replicating (live)', description: 'Continuous background replication; client stays online.' },
  staging: { pillar: 2, label: 'Staging & verification', description: 'Integrity check + client testing and sign-off.' },
  smokeTest: { pillar: 2, label: 'Smoke test running', description: 'New environment verified healthy before first launch.' },
  cutover: { pillar: 3, label: 'Cutover executing', description: 'Orchestrated DNS re-point; target < 5 min downtime.' },
  launch: { pillar: 3, label: 'Launching', description: 'First-ever DNS point to the new local home.' },
  monitoring: { pillar: 3, label: 'Live & monitored', description: 'Live locally; 24/7 uptime & latency (Hypercare).' },
  failed: { pillar: 2, label: 'Failed (verification)', description: 'Integrity/smoke test failed; nothing went live.' },
  rolledBack: { pillar: 3, label: 'Rolled back / decommissioned (safe)', description: 'Restored or decommissioned under the guarantee promise.' },
};
