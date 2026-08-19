/**
 * Proves the placement fix: recommendProvider() is deterministic (same inputs
 * -> same output, every time), moves only because of REAL provisioning events
 * (not random jitter), and an operator can override the recommendation.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, getProvider, recommendProvider } from './provider.js';

describe('provider placement (deterministic, not random)', () => {
  it('never uses Math.random anywhere in the source (regression guard)', () => {
    const path = fileURLToPath(new URL('./provider.ts', import.meta.url));
    const src = readFileSync(path, 'utf-8');
    expect(src).not.toMatch(/Math\.random/);
  });

  it('getMetrics() returns the IDENTICAL result across repeated calls with no state change', async () => {
    const aos = getProvider('aos')!;
    const first = await aos.getMetrics();
    const second = await aos.getMetrics();
    const third = await aos.getMetrics();
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it('recommends the same provider on repeated calls, with the same reasoning (no jitter)', async () => {
    const first = await recommendProvider();
    const second = await recommendProvider();
    expect(second.providerId).toBe(first.providerId);
    expect(second.reason).toBe(first.reason);
    expect(second.overridden).toBe(false);
  });

  it('recommends the cheapest viable partner by NEGOTIATED wholesale rate, deterministically', async () => {
    // AOS ($60/VM/mo) undercuts ADC ($70) and PAIX ($65) and starts well under
    // the viability ceiling, so it must be the default pick with a fresh pool.
    const { providerId, reason } = await recommendProvider();
    expect(providerId).toBe('aos');
    expect(reason).toMatch(/\$60\/VM\/mo/);
  });

  it('utilization moves ONLY when a real client is actually provisioned, by a fixed step', async () => {
    const adc = getProvider('adc')!;
    const before = await adc.getMetrics();
    await adc.provision({ migrationId: 'test-mig-1', dataVolumeGB: 10 });
    const after = await adc.getMetrics();
    expect(after.utilizationPct).toBe(before.utilizationPct + 2); // fixed, explainable step
    expect(after.availableVcpu).toBeLessThan(before.availableVcpu);
  });

  it('an operator can override the recommendation to a specific viable provider', async () => {
    const result = await recommendProvider('paix');
    expect(result.providerId).toBe('paix');
    expect(result.overridden).toBe(true);
    expect(result.reason).toMatch(/Operator-selected/);
  });

  it('rejects an override for an unknown provider id', async () => {
    await expect(recommendProvider('does-not-exist')).rejects.toThrow(/Unknown provider/);
  });

  it('exposes exactly the three named Rwandan Tier III partners', () => {
    expect(PROVIDERS.map((p) => p.id).sort()).toEqual(['adc', 'aos', 'paix']);
  });
});
