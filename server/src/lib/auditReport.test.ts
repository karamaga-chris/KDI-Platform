import { describe, it, expect } from 'vitest';
import { buildAuditReport } from './auditReport.js';

const base = {
  migrationId: 'm1',
  currentProvider: 'AWS eu-central-1',
  dataVolumeGB: 60,
  estimatedDowntimeMin: 4,
  latencyBeforeMs: 250,
  recommendedProviderId: 'aos',
  generatedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
};

describe('buildAuditReport', () => {
  it('produces a MIGRATION readiness audit with an offshore-latency finding', () => {
    const r = buildAuditReport({ ...base, migrationType: 'MIGRATION', orgName: 'PesaFlow', sector: 'fintech' });
    expect(r.title).toMatch(/Readiness Audit/);
    expect(r.findings.some((f) => f.label.includes('baseline latency'))).toBe(true);
    // High offshore latency should be flagged as a risk finding (the case FOR migrating).
    const latencyFinding = r.findings.find((f) => f.label.includes('baseline latency'));
    expect(latencyFinding?.flag).toBe('risk');
  });

  it('produces a GREENFIELD sizing report with no offshore baseline finding', () => {
    const r = buildAuditReport({ ...base, migrationType: 'GREENFIELD', orgName: 'NiraPay', sector: 'fintech', currentProvider: 'none (new app)' });
    expect(r.title).toMatch(/Sizing/);
    expect(r.findings.some((f) => f.label.includes('baseline latency'))).toBe(false);
    expect(r.findings.some((f) => f.label === 'Hosting history')).toBe(true);
  });

  it('flags regulated sectors with a Law 058/2021 compliance note', () => {
    const r = buildAuditReport({ ...base, migrationType: 'MIGRATION', orgName: 'AfyaLink', sector: 'digital-health' });
    expect(r.complianceNote).toMatch(/058\/2021/);
    expect(r.complianceNote).toMatch(/regulated/i);
  });

  it('escalates verdict to GO_WITH_CONDITIONS for very large migrations', () => {
    const r = buildAuditReport({ ...base, migrationType: 'MIGRATION', orgName: 'BigCo', sector: 'e-commerce', dataVolumeGB: 800 });
    expect(r.recommendation.verdict).toBe('GO_WITH_CONDITIONS');
  });
});
