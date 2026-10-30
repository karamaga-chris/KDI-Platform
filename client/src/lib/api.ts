const BASE = import.meta.env.VITE_API ?? 'http://localhost:4000';
const API_TOKEN = import.meta.env.VITE_API_TOKEN as string | undefined;

// Server errors are either a plain string, or a Zod `.flatten()` shape
// ({ formErrors: string[], fieldErrors: Record<string, string[]> }).
function formatApiError(error: unknown): string | undefined {
  if (!error) return undefined;
  if (typeof error === 'string') return error;
  if (typeof error === 'object') {
    const e = error as { message?: string; formErrors?: string[]; fieldErrors?: Record<string, string[]> };
    if (e.message) return e.message;
    const parts = [
      ...(e.formErrors ?? []),
      ...Object.entries(e.fieldErrors ?? {}).map(([field, msgs]) => `${field}: ${msgs.join(', ')}`),
    ];
    if (parts.length) return parts.join('; ');
  }
  return JSON.stringify(error);
}

async function j(path: string, opts?: RequestInit) {
  const headers: Record<string, string> = { ...(opts?.headers as Record<string, string> ?? {}) };
  if (opts?.body) headers['Content-Type'] = 'application/json'; // only set when there IS a body
  if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
  const res = await fetch(`${BASE}${path}`, { ...opts, headers });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(formatApiError(body.error) ?? `HTTP ${res.status}`);
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
  // Plain <a href> can't carry the Authorization header, so fetch the PDF as
  // a blob (with auth) and trigger the browser's save dialog manually.
  downloadAuditReportPdf: async (id: string, filename: string) => {
    const headers: Record<string, string> = {};
    if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
    const res = await fetch(`${BASE}/api/migrations/${id}/audit-report.pdf`, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  },
};
