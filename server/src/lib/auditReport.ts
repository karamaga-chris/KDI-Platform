/**
 * auditReport.ts
 * ---------------------------------------------------------------------------
 * Generates the client-facing report at the end of Pillar 1:
 *   - MIGRATION:  the "Readiness & Risk" audit  (state: auditReady)
 *   - GREENFIELD: the "Sizing & Requirements" report (state: sizingReady)
 *
 * This is intentionally a small, deterministic function of the migration's
 * context — no external calls — so it can be regenerated identically at any
 * time and cached to the DB (Migration.auditReportJson).
 * ---------------------------------------------------------------------------
 */
import PDFDocument from 'pdfkit';
import { PassThrough } from 'node:stream';

export type ReportInput = {
  migrationId: string;
  migrationType: 'MIGRATION' | 'GREENFIELD';
  orgName: string;
  sector: string;
  currentProvider: string | null;
  dataVolumeGB: number | null;
  estimatedDowntimeMin: number | null;
  latencyBeforeMs: number | null;
  recommendedProviderId: string | null;
  generatedAt: string;
};

export type AuditReport = {
  title: string;
  generatedAt: string;
  client: { orgName: string; sector: string };
  summary: string;
  findings: { label: string; value: string; flag: 'ok' | 'watch' | 'risk' }[];
  complianceNote: string;
  recommendation: { verdict: 'GO' | 'GO_WITH_CONDITIONS' | 'HOLD'; reason: string };
};

const REGULATED_SECTORS = new Set(['fintech', 'digital-health', 'health', 'government', 'gov']);

export function buildAuditReport(input: ReportInput): AuditReport {
  const isMigration = input.migrationType === 'MIGRATION';
  const regulated = REGULATED_SECTORS.has(input.sector.toLowerCase());

  const findings: AuditReport['findings'] = [];

  if (isMigration) {
    findings.push({ label: 'Current hosting', value: input.currentProvider ?? 'unknown', flag: 'watch' });
    if (input.latencyBeforeMs != null) {
      findings.push({
        label: 'Measured baseline latency',
        value: `${input.latencyBeforeMs} ms round-trip`,
        flag: input.latencyBeforeMs > 150 ? 'risk' : 'ok',
      });
    }
    findings.push({
      label: 'Estimated cutover downtime',
      value: `${input.estimatedDowntimeMin ?? '\u2014'} min`,
      flag: (input.estimatedDowntimeMin ?? 0) <= 5 ? 'ok' : 'watch',
    });
  } else {
    findings.push({
      label: 'Hosting history',
      value: 'New application \u2014 no prior host, no legacy data to protect',
      flag: 'ok',
    });
    findings.push({
      label: 'Launch risk profile',
      value: 'Lower than a migration: no existing traffic or data to disrupt',
      flag: 'ok',
    });
  }

  findings.push({
    label: 'Data volume',
    value: `${input.dataVolumeGB ?? '\u2014'} GB`,
    flag: (input.dataVolumeGB ?? 0) > 200 ? 'watch' : 'ok',
  });

  findings.push({
    label: 'Recommended Tier III placement',
    value: input.recommendedProviderId?.toUpperCase() ?? 'pending',
    flag: 'ok',
  });

  const complianceNote = regulated
    ? `${input.sector} is a regulated data category under the Rwanda Data Protection and Privacy Law ` +
      `(Law No. 058/2021). Hosting locally with Kigali Digital Infrastructure satisfies data-residency ` +
      `obligations and produces the NCSA/RURA-ready compliance reporting automatically.`
    : `No elevated regulatory data-residency category detected for "${input.sector}", but local hosting ` +
      `still removes any ambiguity under Law No. 058/2021 and improves latency for Rwandan users.`;

  let verdict: AuditReport['recommendation']['verdict'] = 'GO';
  let reason = isMigration
    ? 'Discovery found no blocking compatibility issues; latency gain and compliance benefit justify migration.'
    : 'Requirements are well within a single Tier III environment; safe to provision directly.';

  if (isMigration && (input.dataVolumeGB ?? 0) > 500) {
    verdict = 'GO_WITH_CONDITIONS';
    reason = 'Large data volume \u2014 recommend an extended background-replication window before cutover.';
  }

  return {
    title: isMigration ? 'Pre-Flight Data Readiness Audit' : 'New Application Sizing & Requirements Report',
    generatedAt: input.generatedAt,
    client: { orgName: input.orgName, sector: input.sector },
    summary: isMigration
      ? `Automated discovery of ${input.orgName}'s current environment is complete. This report is the ` +
        `basis for the go/no-go decision to proceed to provisioning and migration.`
      : `Requirements intake for ${input.orgName}'s new application is complete. This report sizes the ` +
        `Tier III environment and confirms readiness to provision and launch.`,
    findings,
    complianceNote,
    recommendation: { verdict, reason },
  };
}

/** Render the report as a real PDF stream (for download / client hand-off). */
export function renderAuditReportPdf(report: AuditReport): NodeJS.ReadableStream {
  const doc = new PDFDocument({ margin: 50, size: 'A4' });
  const stream = new PassThrough();
  doc.pipe(stream);

  doc.fontSize(18).fillColor('#B11226').text('Kigali Digital Infrastructure Ltd.');
  doc.moveDown(0.2);
  doc.fontSize(14).fillColor('#111').text(report.title);
  doc.fontSize(9).fillColor('#666').text(`Generated ${new Date(report.generatedAt).toLocaleString()}`);
  doc.moveDown(1);

  doc.fontSize(11).fillColor('#111').text(`Client: ${report.client.orgName}  \u00b7  Sector: ${report.client.sector}`);
  doc.moveDown(0.5);
  doc.fontSize(10).fillColor('#333').text(report.summary, { align: 'left' });
  doc.moveDown(1);

  doc.fontSize(12).fillColor('#111').text('Findings');
  doc.moveDown(0.3);
  const flagColor: Record<string, string> = { ok: '#166534', watch: '#854d0e', risk: '#991b1b' };
  report.findings.forEach((f) => {
    doc
      .fontSize(10)
      .fillColor(flagColor[f.flag] ?? '#333')
      .text(`\u2022 ${f.label}: `, { continued: true })
      .fillColor('#333')
      .text(f.value);
  });
  doc.moveDown(1);

  doc.fontSize(12).fillColor('#111').text('Compliance');
  doc.moveDown(0.3);
  doc.fontSize(10).fillColor('#333').text(report.complianceNote);
  doc.moveDown(1);

  doc.fontSize(12).fillColor('#111').text('Recommendation');
  doc.moveDown(0.3);
  const verdictColor = report.recommendation.verdict === 'HOLD' ? '#991b1b'
    : report.recommendation.verdict === 'GO_WITH_CONDITIONS' ? '#854d0e' : '#166534';
  doc.fontSize(11).fillColor(verdictColor).text(report.recommendation.verdict.replace(/_/g, ' '));
  doc.fontSize(10).fillColor('#333').text(report.recommendation.reason);

  doc.end();
  return stream;
}
