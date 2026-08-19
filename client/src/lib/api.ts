const BASE = import.meta.env.VITE_API ?? 'http://localhost:4000';

async function j(path: string, opts?: RequestInit) {
  const headers: Record<string, string> = { ...(opts?.headers as Record<string, string> ?? {}) };
  if (opts?.body) headers['Content-Type'] = 'application/json'; // only set when there IS a body
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error?.message ?? body.error ?? `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  clients: () => j('/api/clients'),
  createClient: (data: any) => j('/api/clients', { method: 'POST', body: JSON.stringify(data) }),
  migration: (id: string) => j(`/api/migrations/${id}`),
  step: (id: string, providerId?: string) =>
    j(`/api/migrations/${id}/step`, {
      method: 'POST',
      body: providerId ? JSON.stringify({ providerId }) : undefined,
    }),
  event: (id: string, event: any) => j(`/api/migrations/${id}/event`, { method: 'POST', body: JSON.stringify(event) }),
  sample: (id: string) => j(`/api/migrations/${id}/sample`, { method: 'POST' }),
  providers: () => j('/api/providers'),
  stateMeta: () => j('/api/state-meta'),
  ledger: () => j('/api/ledger'),
  invoice: (clientId: string) => j(`/api/clients/${clientId}/invoice`, { method: 'POST' }),
  auditReport: (id: string) => j(`/api/migrations/${id}/audit-report`),
  auditReportPdfUrl: (id: string) => `${BASE}/api/migrations/${id}/audit-report.pdf`,
};
