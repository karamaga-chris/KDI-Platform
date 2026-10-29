/**
 * monitoring.ts
 * ---------------------------------------------------------------------------
 * Pluggable monitoring behind one interface (same pattern as providers).
 *
 * Three implementations, in ascending order of "realness":
 *
 *   1. LatencyProber      — SIMULATED. Fabricates the offshore->local latency win
 *                           (~250ms -> ~42ms). Used only when no real endpoint and
 *                           no UptimeRobot key are configured (pure demo mode).
 *
 *   2. HttpLatencyProber  — REAL. Performs an actual timed HTTP request to a real
 *                           URL and reports true round-trip latency + up/down.
 *                           Needs no external account — works against any public URL.
 *
 *   3. UptimeRobotAdapter — REAL + persistent. Uses UptimeRobot's free-tier API to
 *                           create/track a monitor per client endpoint and reads
 *                           back real status + response times. Production-grade path.
 *
 * The factory picks the most real option available from environment configuration,
 * so the same code demos offline and runs for real once you add a key or endpoint.
 * At scale, a self-hosted Uptime Kuma / Grafana adapter implements this same
 * interface with no change to the rest of the app.
 * ---------------------------------------------------------------------------
 */

export type UptimeSample = { at: string; up: boolean; latencyMs: number; source: string };

export interface MonitoringAdapter {
  readonly id: string;
  /** Return a fresh sample for a monitored client endpoint (a URL). */
  sample(endpoint: string): Promise<UptimeSample>;
}

/* ------------------------------------------------------------------ */
/* 1. SIMULATED prober (demo fallback only)                            */
/* ------------------------------------------------------------------ */
export class LatencyProber implements MonitoringAdapter {
  readonly id = 'sim-latency-prober';
  constructor(private readonly localized = true) {}

  async sample(_endpoint: string): Promise<UptimeSample> {
    const base = this.localized ? 42 : 250;
    const jitter = (Math.random() - 0.5) * (this.localized ? 30 : 80);
    const latencyMs = Math.max(8, Math.round(base + jitter));
    const up = Math.random() > 0.003; // ~0.3% blips to exercise alerting
    return { at: new Date().toISOString(), up, latencyMs, source: 'simulated' };
  }
}

/* ------------------------------------------------------------------ */
/* 2. REAL HTTP prober — actual timed request, no account needed       */
/* ------------------------------------------------------------------ */
export class HttpLatencyProber implements MonitoringAdapter {
  readonly id = 'http-latency-prober';
  constructor(private readonly timeoutMs = 8000) {}

  async sample(endpoint: string): Promise<UptimeSample> {
    const url = normalizeUrl(endpoint);
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // HEAD is cheap; some servers reject it, so fall back to GET on failure.
      let res: Response;
      try {
        res = await fetch(url, { method: 'HEAD', signal: controller.signal, redirect: 'follow' });
      } catch {
        res = await fetch(url, { method: 'GET', signal: controller.signal, redirect: 'follow' });
      }
      const latencyMs = Math.round(performance.now() - started);
      // up=true only for status < 500 so server errors register as effectively down.
      const up = res.status < 500;
      return { at: new Date().toISOString(), up, latencyMs, source: 'http-probe' };
    } catch {
      const latencyMs = Math.round(performance.now() - started);
      return { at: new Date().toISOString(), up: false, latencyMs, source: 'http-probe' };
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. REAL UptimeRobot adapter (free tier) — create + read monitors    */
/* ------------------------------------------------------------------ */
type UrMonitor = { id: number; url: string; status: number; response_times?: { value: number }[] };

export class UptimeRobotAdapter implements MonitoringAdapter {
  readonly id = 'uptimerobot';
  private readonly base = 'https://api.uptimerobot.com/v2';
  // Cache endpoint URL -> UptimeRobot monitor id so we don't re-create monitors.
  private readonly monitorCache = new Map<string, number>();

  constructor(
    private readonly apiKey: string,
    private readonly timeoutMs = 8000,
    private readonly maxRetries = 1,
  ) {}

  private async postOnce(path: string, params: Record<string, string>): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.base}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cache-Control': 'no-cache' },
        body: new URLSearchParams({ api_key: this.apiKey, format: 'json', ...params }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`UptimeRobot HTTP ${res.status}`);
      const data = await res.json();
      if (data.stat === 'fail') {
        throw new Error(`UptimeRobot API error: ${data.error?.message ?? 'unknown'}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  /** A slow/unresponsive third party can't hang the caller: bounded by timeoutMs,
   * with one retry for transient failures (timeout, network error, HTTP 5xx). */
  private async post(path: string, params: Record<string, string>): Promise<any> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await this.postOnce(path, params);
      } catch (e: any) {
        lastErr = e;
        // Retry only what's plausibly transient: a timeout, a 5xx, or a raw
        // network failure. Not a 4xx or an API-level "stat: fail" (bad key,
        // bad params) — those won't succeed on retry.
        const msg = e?.message ?? '';
        const retryable = e?.name === 'AbortError' || /HTTP 5\d\d/.test(msg) || !/^UptimeRobot (HTTP|API error)/.test(msg);
        if (!retryable || attempt === this.maxRetries) break;
      }
    }
    throw lastErr;
  }

  /** Find an existing monitor for this exact URL, or create one. Returns monitor id. */
  private async ensureMonitor(url: string): Promise<number> {
    const cached = this.monitorCache.get(url);
    if (cached) return cached;

    // Look for an exact URL match among existing monitors.
    const list = await this.post('getMonitors', { search: url });
    const exact = (list.monitors as UrMonitor[] | undefined)?.find((m) => m.url === url);
    if (exact) {
      this.monitorCache.set(url, exact.id);
      return exact.id;
    }

    // Create a new HTTP monitor (type 1 = HTTP(s)). friendly_name is required.
    const created = await this.post('newMonitor', {
      friendly_name: `KDI ${new URL(url).host}`,
      url,
      type: '1',
    });
    const id = created.monitor?.id as number;
    if (!id) throw new Error('UptimeRobot did not return a monitor id');
    this.monitorCache.set(url, id);
    return id;
  }

  async sample(endpoint: string): Promise<UptimeSample> {
    const url = normalizeUrl(endpoint);
    const id = await this.ensureMonitor(url);
    const data = await this.post('getMonitors', {
      monitors: String(id),
      response_times: '1',
      response_times_limit: '1',
    });
    const m = (data.monitors as UrMonitor[])?.[0];
    // UptimeRobot status codes: 2 = up, 8/9 = down, 0/1 = paused/pending.
    const up = m ? m.status === 2 : false;
    const latencyMs = m?.response_times?.[0]?.value ?? 0;
    return { at: new Date().toISOString(), up, latencyMs, source: 'uptimerobot' };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers + factory                                                   */
/* ------------------------------------------------------------------ */
export function normalizeUrl(endpoint: string): string {
  // Allow callers to pass a bare host or a full URL.
  if (/^https?:\/\//i.test(endpoint)) return endpoint;
  return `https://${endpoint}`;
}

/**
 * Factory chooses the most REAL monitor available:
 *   - UPTIMEROBOT_API_KEY set   -> UptimeRobotAdapter (real, persistent)
 *   - MONITOR_REAL_HTTP=1       -> HttpLatencyProber  (real timed requests)
 *   - otherwise                 -> LatencyProber      (simulated demo)
 */
export function makeMonitor(): MonitoringAdapter {
  if (process.env.UPTIMEROBOT_API_KEY) {
    return new UptimeRobotAdapter(process.env.UPTIMEROBOT_API_KEY);
  }
  if (process.env.MONITOR_REAL_HTTP === '1') {
    return new HttpLatencyProber();
  }
  return new LatencyProber(true);
}
