/**
 * api.ts — REST surface for the operator console and client portal.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/prisma.js';
import { applyEvent, autoStep, recordSample, getOrBuildAuditReport } from '../engine/migrationService.js';
import { STATE_META, happyPathFor } from '../engine/migrationMachine.js';
import { PROVIDERS } from '../adapters/provider.js';
import { issueInvoice, mrrLedger } from '../lib/billing.js';
import { renderAuditReportPdf } from '../lib/auditReport.js';

const idParam = z.object({ id: z.string().min(1).max(64) });

/**
 * Mirrors MigrationEvent (engine/migrationMachine.ts) exactly — same event
 * shapes, just validated at the boundary before they reach the machine. Not a
 * change to what events are legal; the machine's guards still decide that.
 */
const migrationEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('START_AUDIT') }),
  z.object({
    type: z.literal('AUDIT_COMPLETE'),
    dataVolumeGB: z.number().finite().nonnegative(),
    estimatedDowntimeMin: z.number().finite().nonnegative(),
    latencyBeforeMs: z.number().finite().nonnegative(),
  }),
  z.object({ type: z.literal('APPROVE_AUDIT'), providerId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('START_INTAKE') }),
  z.object({ type: z.literal('INTAKE_COMPLETE'), dataVolumeGB: z.number().finite().nonnegative() }),
  z.object({ type: z.literal('APPROVE_SIZING'), providerId: z.string().min(1).max(64) }),
  z.object({ type: z.literal('PROVISION_DONE'), targetEndpoint: z.string().max(2048).optional() }),
  z.object({ type: z.literal('REPLICATION_HEALTHY'), replicationLagSec: z.number().finite().nonnegative() }),
  z.object({ type: z.literal('INTEGRITY_PASS') }),
  z.object({ type: z.literal('INTEGRITY_FAIL'), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('CLIENT_SIGN_OFF') }),
  z.object({ type: z.literal('SMOKE_TEST_PASS') }),
  z.object({ type: z.literal('SMOKE_TEST_FAIL'), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('EXECUTE_CUTOVER'), latencyAfterMs: z.number().finite().nonnegative() }),
  z.object({ type: z.literal('GO_LIVE'), latencyAfterMs: z.number().finite().nonnegative() }),
  z.object({ type: z.literal('ROLLBACK'), reason: z.string().min(1).max(500) }),
  z.object({ type: z.literal('RETRY') }),
]);

export async function registerApi(app: FastifyInstance) {
  // ---- meta ----
  // Verifies actual DB connectivity, not just process liveness — a hung/unreachable
  // Postgres should fail the health check so an orchestrator can act on it.
  app.get('/api/health', async (_req, reply) => {
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { ok: true, db: 'up' };
    } catch (e: any) {
      return reply.code(503).send({ ok: false, db: 'down' });
    }
  });
  app.get('/api/providers', async () => {
    const withMetrics = await Promise.all(
      PROVIDERS.map(async (p) => ({ id: p.id, name: p.name, region: p.region, metrics: await p.getMetrics() })),
    );
    return withMetrics;
  });
  app.get('/api/state-meta', async () => ({
    meta: STATE_META,
    happyPaths: { MIGRATION: happyPathFor('MIGRATION'), GREENFIELD: happyPathFor('GREENFIELD') },
  }));

  // ---- clients ----
  // Not N+1 — Prisma batches this `include` into one extra query (WHERE clientId IN (...)),
  // not one query per client. The real issue was unbounded payload size: every client's
  // FULL migration history was sent even though the console only ever reads migrations[0]
  // (Dashboard.tsx). `take: 1` cuts that to the one row actually used.
  app.get('/api/clients', async () => {
    return prisma.client.findMany({
      orderBy: { createdAt: 'desc' },
      include: { migrations: { orderBy: { createdAt: 'desc' }, take: 1 } },
    });
  });

  const createClient = z.object({
    orgName: z.string().min(1).max(200),
    sector: z.string().min(1).max(100),
    migrationType: z.enum(['MIGRATION', 'GREENFIELD']).default('MIGRATION'),
    // Only meaningful for MIGRATION — a greenfield app has no prior host.
    currentProvider: z.string().max(200).optional().or(z.literal('')),
    endpoint: z.string().url().max(2048).optional().or(z.literal('')),
    dataVolumeGB: z.number().int().positive().max(1_000_000),
    tier: z.enum(['STARTUP', 'GROWTH', 'PREMIUM']).default('STARTUP'),
  }).refine(
    (v) => v.migrationType !== 'MIGRATION' || (v.currentProvider && v.currentProvider.length > 0),
    { message: 'currentProvider is required when migrationType is MIGRATION', path: ['currentProvider'] },
  );

  app.post('/api/clients', async (req, reply) => {
    const parsed = createClient.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { endpoint, migrationType, ...rest } = parsed.data;
    const client = await prisma.client.create({
      data: {
        ...rest,
        currentProvider: rest.currentProvider || (migrationType === 'GREENFIELD' ? 'none (new app)' : ''),
        endpoint: endpoint && endpoint.length ? endpoint : null,
      },
    });
    // Auto-create the client's first migration in 'created', tagged with its onboarding type.
    const migration = await prisma.migration.create({
      data: { clientId: client.id, migrationType, dataVolumeGB: parsed.data.dataVolumeGB },
    });
    return { client, migration };
  });

  // ---- migrations ----
  app.get('/api/migrations/:id', async (req: any, reply) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const m = await prisma.migration.findUnique({
      where: { id: params.data.id },
      include: {
        client: true,
        events: { orderBy: { createdAt: 'asc' } },
        uptime: { orderBy: { at: 'asc' }, take: 200 },
      },
    });
    if (!m) return reply.code(404).send({ error: 'not found' });
    return m;
  });

  // Apply a raw event (used by the operator's manual controls).
  app.post('/api/migrations/:id/event', async (req: any, reply) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    const parsedEvent = migrationEvent.safeParse(req.body);
    if (!parsedEvent.success) return reply.code(400).send({ error: parsedEvent.error.flatten() });
    try {
      const result = await applyEvent(params.data.id, parsedEvent.data);
      return result;
    } catch (e: any) {
      return reply.code(409).send({ error: e.message }); // 409 = guard rejected
    }
  });

  // Advance one automated happy-path step. Optional { providerId } lets the
  // operator explicitly choose the Tier III partner at the placement step
  // (auditReady / sizingReady) instead of accepting the auto recommendation.
  const stepBody = z.object({ providerId: z.string().min(1).max(64).optional() });
  app.post('/api/migrations/:id/step', async (req: any, reply) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const parsed = stepBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      return await autoStep(params.data.id, parsed.data.providerId);
    } catch (e: any) {
      return reply.code(409).send({ error: e.message });
    }
  });

  // Record one monitoring sample (called on a timer by the client, or cron).
  // Tighter limit than the global default: this is polled every few seconds
  // per live client and is the easiest endpoint to accidentally hammer.
  app.post('/api/migrations/:id/sample', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req: any, reply) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      return await recordSample(params.data.id);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  // ---- Pillar-1 report (Readiness Audit for MIGRATION, Sizing Report for GREENFIELD) ----
  app.get('/api/migrations/:id/audit-report', async (req: any, reply) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      return await getOrBuildAuditReport(params.data.id);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  // PDF rendering is CPU work — tighter limit to prevent it being used to
  // burn CPU repeatedly even though the underlying report data is cached.
  app.get('/api/migrations/:id/audit-report.pdf', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req: any, reply) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      const report = await getOrBuildAuditReport(params.data.id);
      const stream = renderAuditReportPdf(report);
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="KDI-report-${params.data.id}.pdf"`);
      return reply.send(stream);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  // ---- billing ----
  app.post('/api/clients/:id/invoice', async (req: any, reply) => {
    const params = idParam.safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: params.error.flatten() });
    try {
      return await issueInvoice(params.data.id);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });
  app.get('/api/ledger', async () => mrrLedger());
}
