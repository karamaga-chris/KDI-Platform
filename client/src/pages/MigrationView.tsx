import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { PillarPipeline } from '../components/PillarPipeline';

const REPORT_STATES = new Set(['auditReady', 'sizingReady']);
// Same states — this is exactly the "which Tier III partner hosts this
// client" decision point, so the operator picker lives alongside the report.
const PLACEMENT_STATES = REPORT_STATES;

export function MigrationView({ id, onBack }: { id: string; onBack: () => void }) {
  const [m, setM] = useState<any>(null);
  const [meta, setMeta] = useState<any>({ meta: {}, happyPaths: { MIGRATION: [], GREENFIELD: [] } });
  const [report, setReport] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [mig, sm] = await Promise.all([api.migration(id), api.stateMeta()]);
    setM(mig);
    setMeta(sm);
    if (REPORT_STATES.has(mig.state)) {
      api.auditReport(id).then(setReport).catch(() => setReport(null));
    } else {
      setReport(null);
    }
    if (PLACEMENT_STATES.has(mig.state)) {
      api.providers().then(setProviders).catch(() => setProviders([]));
    } else {
      setProviders([]);
      setSelectedProviderId(null); // reset once we've moved past the placement decision
    }
  }, [id]);

  useEffect(() => { load(); }, [load]);

  // When live, poll a monitoring sample every 3s to feed the latency chart.
  useEffect(() => {
    if (m?.state !== 'monitoring') return;
    const t = setInterval(async () => {
      await api.sample(id).catch(() => {});
      await load();
    }, 3000);
    return () => clearInterval(t);
  }, [m?.state, id, load]);

  async function doStep() {
    setBusy(true); setErr(null);
    try {
      // At the placement step, send the operator's explicit pick (if any);
      // otherwise the server falls back to its deterministic recommendation.
      const providerId = PLACEMENT_STATES.has(m?.state) ? selectedProviderId ?? undefined : undefined;
      await api.step(id, providerId);
      await load();
    }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function doEvent(event: any) {
    setBusy(true); setErr(null);
    try { await api.event(id, event); await load(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }

  if (!m) return <div className="card">Loading…</div>;

  const isGreenfield = m.migrationType === 'GREENFIELD';
  const happyPath: string[] = meta.happyPaths?.[m.migrationType] ?? meta.happyPaths?.MIGRATION ?? [];

  const samples = m.uptime ?? [];
  const upPct = samples.length ? (100 * samples.filter((s: any) => s.up).length / samples.length) : 100;
  const avgLatency = samples.length ? Math.round(samples.reduce((a: number, s: any) => a + s.latencyMs, 0) / samples.length) : null;
  const lastSource = samples.length ? samples[samples.length - 1].source : null;
  const sourceLabel: Record<string, string> = {
    uptimerobot: 'Live · UptimeRobot API',
    'http-probe': 'Live · real HTTP probe',
    simulated: 'Simulated (demo mode)',
  };
  const meetsTarget = avgLatency != null && avgLatency < 100;

  return (
    <div>
      <button className="link" onClick={onBack}>← All clients</button>
      <div className="head-row">
        <div>
          <h2>{m.client.orgName}</h2>
          <div className="muted">
            {m.client.sector} · {m.dataVolumeGB ?? '—'} GB ·{' '}
            {isGreenfield ? 'new application (no prior host)' : `from ${m.client.currentProvider}`}
          </div>
        </div>
        <div className="state-badge">{meta.meta[m.state]?.label ?? m.state}</div>
      </div>

      <PillarPipeline current={m.state} meta={meta.meta} happyPath={happyPath} migrationType={m.migrationType} />

      {err && <div className="alert">{err}</div>}

      <div className="controls">
        <button className="btn primary" disabled={busy || ['monitoring', 'failed', 'rolledBack'].includes(m.state)} onClick={doStep}>
          {PLACEMENT_STATES.has(m.state)
            ? (selectedProviderId
                ? `▶ Provision with ${providers.find((p) => p.id === selectedProviderId)?.name ?? selectedProviderId}`
                : '▶ Advance one step (auto-recommend)')
            : '▶ Advance one step (auto)'}
        </button>

        {/* MIGRATION path: staging gates on integrity + sign-off, then cutover */}
        {m.state === 'staging' && (
          <>
            <button className="btn" disabled={busy} onClick={() => doEvent({ type: 'INTEGRITY_PASS' })}>Mark integrity ✓</button>
            <button className="btn" disabled={busy} onClick={() => doEvent({ type: 'CLIENT_SIGN_OFF' })}>Client sign-off ✓</button>
            <button className="btn" disabled={busy} onClick={() => doEvent({ type: 'EXECUTE_CUTOVER', latencyAfterMs: 40 })}>Execute cutover</button>
          </>
        )}

        {/* GREENFIELD path: smoke test gates go-live */}
        {m.state === 'smokeTest' && (
          <>
            <button className="btn" disabled={busy} onClick={() => doEvent({ type: 'SMOKE_TEST_PASS' })}>Mark smoke test ✓</button>
            <button className="btn" disabled={busy} onClick={() => doEvent({ type: 'GO_LIVE', latencyAfterMs: 12 })}>Go live</button>
          </>
        )}

        {m.state === 'monitoring' && (
          <button className="btn danger" disabled={busy} onClick={() => doEvent({ type: 'ROLLBACK', reason: isGreenfield ? 'Client requested decommission during trial' : 'Client requested during trial' })}>
            {isGreenfield ? 'Decommission (Safe)' : 'Safe Rollback'}
          </button>
        )}
      </div>

      {/* Placement decision: operator picks the Tier III partner, or leaves it
          on auto-recommend (cheapest viable, chosen deterministically). */}
      {PLACEMENT_STATES.has(m.state) && (
        <div className="card">
          <h3>Choose Tier III provider</h3>
          {!providers.length ? (
            <div className="muted">Loading provider capacity…</div>
          ) : (
            <div className="provider-picker">
              <label className="provider-option">
                <input
                  type="radio"
                  name="provider"
                  checked={selectedProviderId === null}
                  onChange={() => setSelectedProviderId(null)}
                />
                <div>
                  <strong>Auto-recommend</strong>
                  <div className="muted">Cheapest viable partner by negotiated wholesale rate, chosen deterministically.</div>
                </div>
              </label>
              {providers.map((p) => (
                <label className="provider-option" key={p.id}>
                  <input
                    type="radio"
                    name="provider"
                    checked={selectedProviderId === p.id}
                    onChange={() => setSelectedProviderId(p.id)}
                  />
                  <div>
                    <strong>{p.name}</strong>
                    <div className="muted">
                      {p.region} · {p.metrics.utilizationPct.toFixed(0)}% utilized · {p.metrics.availableVcpu} vCPU available · ${p.metrics.wholesaleUsdPerVmMonth}/VM/mo
                      {p.metrics.utilizationPct >= 80 && <span className="flag flag-warn"> · at capacity</span>}
                    </div>
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pillar-1 report: Readiness Audit (MIGRATION) or Sizing Report (GREENFIELD) */}
      {REPORT_STATES.has(m.state) && (
        <div className="card report-card">
          <div className="head-row">
            <h3>{report?.title ?? 'Report'}</h3>
            <a className="btn small" href={api.auditReportPdfUrl(id)} target="_blank" rel="noreferrer">⬇ Download PDF</a>
          </div>
          {!report ? <div className="muted">Generating…</div> : (
            <>
              <p className="muted">{report.summary}</p>
              <table className="audit">
                <thead><tr><th>Finding</th><th>Value</th><th></th></tr></thead>
                <tbody>
                  {report.findings.map((f: any, i: number) => (
                    <tr key={i}>
                      <td>{f.label}</td>
                      <td>{f.value}</td>
                      <td><span className={`flag ${f.flag}`}>{f.flag}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="muted" style={{ marginTop: 10 }}>{report.complianceNote}</p>
              <div className={`verdict ${report.recommendation.verdict.toLowerCase()}`}>
                {report.recommendation.verdict.replace(/_/g, ' ')} — {report.recommendation.reason}
              </div>
            </>
          )}
        </div>
      )}

      <div className="grid2">
        <div className="card">
          <h3>{isGreenfield ? 'Launch facts' : 'Migration facts'}</h3>
          <table className="kv">
            <tbody>
              <tr><td>Provider (placement)</td><td>{m.providerId ?? '—'}</td></tr>
              {!isGreenfield && <tr><td>Est. downtime</td><td>{m.estimatedDowntimeMin ? `${m.estimatedDowntimeMin} min` : '—'}</td></tr>}
              {!isGreenfield && <tr><td>Replication lag</td><td>{m.replicationLagSec != null ? `${m.replicationLagSec}s` : '—'}</td></tr>}
              {!isGreenfield && <tr><td>Integrity</td><td>{m.integrityPassed ? '✓ passed' : '—'}</td></tr>}
              {!isGreenfield && <tr><td>Client sign-off</td><td>{m.clientSignedOff ? '✓ signed' : '—'}</td></tr>}
              {isGreenfield && <tr><td>Smoke test</td><td>{m.smokeTestPassed ? '✓ passed' : '—'}</td></tr>}
              {!isGreenfield && <tr><td>Offshore baseline latency</td><td>{m.latencyBeforeMs ?? '—'}ms</td></tr>}
              <tr><td>Local target endpoint</td><td>{m.targetEndpoint ?? '— (set at provisioning)'}</td></tr>
              <tr><td>Latency at go-live</td><td>{m.latencyAfterMs ?? '—'}ms</td></tr>
            </tbody>
          </table>
        </div>

        <div className="card">
          <h3>Live monitoring (Hypercare)
            {lastSource && (
              <span className={`src-badge ${lastSource === 'simulated' ? 'sim' : 'real'}`}>
                {sourceLabel[lastSource] ?? lastSource}
              </span>
            )}
          </h3>
          {m.state === 'monitoring' ? (
            <>
              <div className="metrics">
                <div><span className="big">{upPct.toFixed(1)}%</span><label>Uptime (target &gt;99.5%)</label></div>
                <div>
                  <span className={`big ${meetsTarget ? 'good' : 'bad'}`}>{avgLatency ?? '—'}ms</span>
                  <label>Avg latency (target &lt;100ms)</label>
                </div>
              </div>
              <div className="muted">Probing local target: {m.targetEndpoint ?? '(none set)'}</div>
              {!meetsTarget && avgLatency != null && (
                <div className="hint">
                  Not hitting target? Make sure the mock origin is running (`npm run dev:origin` in server/)
                  and MOCK_ORIGIN_URL is set — see README "Fixing the latency demo."
                </div>
              )}
              <Sparkline samples={samples} />
            </>
          ) : <div className="muted">Available once the client is live.</div>}
        </div>
      </div>

      <div className="card">
        <h3>Immutable audit trail</h3>
        <table className="audit">
          <thead><tr><th>When</th><th>Pillar</th><th>Event</th><th>From → To</th><th>Detail</th></tr></thead>
          <tbody>
            {m.events.map((e: any) => (
              <tr key={e.id}>
                <td>{new Date(e.createdAt).toLocaleTimeString()}</td>
                <td><span className={`pill p${e.pillar}`}>{e.pillar || '—'}</span></td>
                <td>{e.eventType}</td>
                <td>{e.fromState} → {e.toState}</td>
                <td className="detail">{e.eventType === 'PLACEMENT' ? e.detail : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Sparkline({ samples }: { samples: any[] }) {
  const pts = samples.slice(-40);
  if (!pts.length) return <div className="muted">Collecting samples…</div>;
  const w = 320, h = 60, max = Math.max(120, ...pts.map((s) => s.latencyMs));
  const path = pts.map((s, i) => `${(i / (pts.length - 1)) * w},${h - (s.latencyMs / max) * h}`).join(' ');
  return (
    <svg width={w} height={h} className="spark">
      <line x1={0} y1={h - (100 / max) * h} x2={w} y2={h - (100 / max) * h} stroke="#e11d48" strokeDasharray="4 3" />
      <polyline fill="none" stroke="#059669" strokeWidth="2" points={path} />
    </svg>
  );
}
