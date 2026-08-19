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

export async function registerApi(app: FastifyInstance) {
  // ---- meta ----
  app.get('/api/health', async () => ({ ok: true }));
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
  app.get('/api/clients', async () => {
    return prisma.client.findMany({
      orderBy: { createdAt: 'desc' },
      include: { migrations: { orderBy: { createdAt: 'desc' } } },
    });
  });

  const createClient = z.object({
    orgName: z.string().min(1),
    sector: z.string().min(1),
    migrationType: z.enum(['MIGRATION', 'GREENFIELD']).default('MIGRATION'),
    // Only meaningful for MIGRATION — a greenfield app has no prior host.
    currentProvider: z.string().optional().or(z.literal('')),
    endpoint: z.string().url().optional().or(z.literal('')),
    dataVolumeGB: z.number().int().positive(),
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
    const m = await prisma.migration.findUnique({
      where: { id: req.params.id },
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
    try {
      const result = await applyEvent(req.params.id, req.body);
      return result;
    } catch (e: any) {
      return reply.code(409).send({ error: e.message }); // 409 = guard rejected
    }
  });

  // Advance one automated happy-path step. Optional { providerId } lets the
  // operator explicitly choose the Tier III partner at the placement step
  // (auditReady / sizingReady) instead of accepting the auto recommendation.
  const stepBody = z.object({ providerId: z.string().min(1).optional() });
  app.post('/api/migrations/:id/step', async (req: any, reply) => {
    try {
      const parsed = stepBody.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
      return await autoStep(req.params.id, parsed.data.providerId);
    } catch (e: any) {
      return reply.code(409).send({ error: e.message });
    }
  });

  // Record one monitoring sample (called on a timer by the client, or cron).
  app.post('/api/migrations/:id/sample', async (req: any) => {
    return recordSample(req.params.id);
  });

  // ---- Pillar-1 report (Readiness Audit for MIGRATION, Sizing Report for GREENFIELD) ----
  app.get('/api/migrations/:id/audit-report', async (req: any, reply) => {
    try {
      return await getOrBuildAuditReport(req.params.id);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  app.get('/api/migrations/:id/audit-report.pdf', async (req: any, reply) => {
    try {
      const report = await getOrBuildAuditReport(req.params.id);
      const stream = renderAuditReportPdf(report);
      reply
        .header('Content-Type', 'application/pdf')
        .header('Content-Disposition', `attachment; filename="KDI-report-${req.params.id}.pdf"`);
      return reply.send(stream);
    } catch (e: any) {
      return reply.code(404).send({ error: e.message });
    }
  });

  // ---- billing ----
  app.post('/api/clients/:id/invoice', async (req: any) => issueInvoice(req.params.id));
  app.get('/api/ledger', async () => mrrLedger());
}
