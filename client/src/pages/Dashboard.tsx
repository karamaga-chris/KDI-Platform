import { useEffect, useState } from 'react';
import { api } from '../lib/api';

export function Dashboard({ onOpen }: { onOpen: (migrationId: string) => void }) {
  const [clients, setClients] = useState<any[]>([]);
  const [ledger, setLedger] = useState<any>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [form, setForm] = useState({
    orgName: '',
    sector: 'fintech',
    migrationType: 'MIGRATION' as 'MIGRATION' | 'GREENFIELD',
    currentProvider: '',
    endpoint: '',
    dataVolumeGB: 60,
    tier: 'GROWTH',
  });
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 5;

  async function load() {
    const [c, l, p] = await Promise.all([api.clients(), api.ledger(), api.providers()]);
    setClients(c); setLedger(l); setProviders(p);
  }
  useEffect(() => { load(); }, []);

  async function create(e: any) {
    e.preventDefault();
    const payload: any = { ...form, dataVolumeGB: Number(form.dataVolumeGB) };
    if (form.migrationType === 'GREENFIELD') {
      // No existing host to describe for a brand-new app.
      delete payload.currentProvider;
      delete payload.endpoint;
    }
    const { migration } = await api.createClient(payload);
    await load();
    onOpen(migration.id);
  }

  const isGreenfield = form.migrationType === 'GREENFIELD';

  const totalPages = Math.max(1, Math.ceil(clients.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages); // clamp if the list shrinks
  const pagedClients = clients.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  return (
    <div>
      <div className="grid3">
        <div className="stat"><span className="big">{ledger?.aggregateMrr ? `$${ledger.aggregateMrr}` : '—'}</span><label>Aggregate MRR</label></div>
        <div className="stat"><span className="big">{ledger ? `${ledger.grossMarginPct}%` : '—'}</span><label>Blended gross margin</label></div>
        <div className="stat"><span className="big">{clients.length}</span><label>Pilot clients</label></div>
      </div>

      <div className="grid2">
        <div className="card">
          <h3>Clients & migrations</h3>
          <table className="audit">
            <thead><tr><th>Client</th><th>Sector</th><th>Path</th><th>Tier</th><th>State</th><th></th></tr></thead>
            <tbody>
              {pagedClients.map((c) => {
                const mig = c.migrations?.[0];
                return (
                  <tr key={c.id}>
                    <td>{c.orgName}</td>
                    <td>{c.sector}</td>
                    <td>
                      <span className={`type-pill ${mig?.migrationType === 'GREENFIELD' ? 'gf' : 'mg'}`}>
                        {mig?.migrationType === 'GREENFIELD' ? 'New app' : 'Migration'}
                      </span>
                    </td>
                    <td>{c.tier}</td>
                    <td>{mig?.state ?? '—'}</td>
                    <td>{mig && <button className="btn small" onClick={() => onOpen(mig.id)}>Open</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {clients.length > PAGE_SIZE && (
            <div className="pager">
              <button className="btn small" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>‹ Prev</button>
              <span className="muted">Page {currentPage} of {totalPages} · {clients.length} clients</span>
              <button className="btn small" disabled={currentPage === totalPages} onClick={() => setPage(currentPage + 1)}>Next ›</button>
            </div>
          )}
        </div>

        <div className="card">
          <h3>Provider capacity (placement pool)</h3>
          <table className="audit">
            <thead><tr><th>Provider</th><th>Utilisation</th><th>Wholesale $/VM</th></tr></thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>{p.name}</td>
                  <td>{p.metrics.utilizationPct.toFixed(0)}%</td>
                  <td>${p.metrics.wholesaleUsdPerVmMonth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>Onboard a new client</h3>
        <div className="type-toggle">
          <button
            type="button"
            className={`type-btn ${!isGreenfield ? 'active' : ''}`}
            onClick={() => setForm({ ...form, migrationType: 'MIGRATION' })}
          >
            Migrate an existing app
            <span>Already hosted elsewhere — runs the 3-pillar migration.</span>
          </button>
          <button
            type="button"
            className={`type-btn ${isGreenfield ? 'active' : ''}`}
            onClick={() => setForm({ ...form, migrationType: 'GREENFIELD' })}
          >
            Host a brand-new app
            <span>Never hosted anywhere — sizing &amp; direct go-live, no cutover needed.</span>
          </button>
        </div>

        <form className="form" onSubmit={create}>
          <input placeholder="Organisation name" value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} required />
          <select value={form.sector} onChange={(e) => setForm({ ...form, sector: e.target.value })}>
            <option value="fintech">fintech</option>
            <option value="e-commerce">e-commerce</option>
            <option value="digital-health">digital-health</option>
          </select>

          {!isGreenfield && (
            <>
              <input placeholder="Current provider (e.g. AWS eu-central-1)" value={form.currentProvider} onChange={(e) => setForm({ ...form, currentProvider: e.target.value })} required={!isGreenfield} />
              <input placeholder="Offshore endpoint to baseline (optional, e.g. https://app.client.rw)" value={form.endpoint} onChange={(e) => setForm({ ...form, endpoint: e.target.value })} />
            </>
          )}

          <input type="number" placeholder="Expected data GB" value={form.dataVolumeGB} onChange={(e) => setForm({ ...form, dataVolumeGB: Number(e.target.value) })} />
          <select value={form.tier} onChange={(e) => setForm({ ...form, tier: e.target.value })}>
            <option value="STARTUP">STARTUP ($150)</option>
            <option value="GROWTH">GROWTH ($300)</option>
            <option value="PREMIUM">PREMIUM ($500)</option>
          </select>
          <button className="btn primary" type="submit">
            {isGreenfield ? 'Create & start sizing' : 'Create & open migration'}
          </button>
        </form>
      </div>
    </div>
  );
}
