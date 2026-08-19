/**
 * Proves the monitoring adapters behave correctly. The HTTP prober test does a
 * REAL network request, so it is the evidence that monitoring is not simulated.
 * (Skipped automatically in offline CI via the KDI_OFFLINE env guard.)
 */
import { describe, it, expect } from 'vitest';
import { HttpLatencyProber, LatencyProber, normalizeUrl } from './monitoring.js';

describe('monitoring adapters', () => {
  it('normalizes bare hosts to https URLs', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
    expect(normalizeUrl('http://x.rw')).toBe('http://x.rw');
    expect(normalizeUrl('https://y.rw')).toBe('https://y.rw');
  });

  it('simulated prober returns a plausible localized latency', async () => {
    const s = await new LatencyProber(true).sample('anything');
    expect(s.source).toBe('simulated');
    expect(s.latencyMs).toBeGreaterThan(0);
    expect(s.latencyMs).toBeLessThan(120);
  });

  const online = process.env.KDI_OFFLINE !== '1';
  it.runIf(online)('HTTP prober performs a REAL timed request', async () => {
    const s = await new HttpLatencyProber(8000).sample('https://www.cloudflare.com');
    expect(s.source).toBe('http-probe');
    expect(s.up).toBe(true);
    // A real round-trip is measurable and non-trivial (not the 0 a mock would give
    // if it did nothing). Bound loosely to avoid flakiness.
    expect(s.latencyMs).toBeGreaterThan(0);
    expect(s.latencyMs).toBeLessThan(8000);
  });

  it('HTTP prober reports down for an unreachable host', async () => {
    const s = await new HttpLatencyProber(1500).sample('https://this-host-does-not-exist-kdi.invalid');
    expect(s.up).toBe(false);
    expect(s.source).toBe('http-probe');
  });
});
