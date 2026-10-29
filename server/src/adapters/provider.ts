/**
 * provider.ts
 * ---------------------------------------------------------------------------
 * The demand-aggregation abstraction.
 *
 * Every Tier III data center (AOS, ADC, PAIX) is reached through this single
 * interface. The migration engine never talks to a provider directly — it talks
 * to a ProviderAdapter. This is what lets Kigali Digital aggregate demand and
 * place / fail over a client across providers WITHOUT changing any workflow code.
 *
 * For the MVP these are mock adapters returning realistic, DETERMINISTIC figures
 * (no randomness) — negotiated wholesale rates and stable starting capacity, with
 * utilization moving only when a real provisioning event actually consumes
 * capacity. Swapping in a real API client later means implementing this same
 * interface — nothing in the engine, routes, or UI changes.
 * ---------------------------------------------------------------------------
 */

export type ProvisionResult = {
  environmentId: string;
  provider: string;
  region: string;
  ready: boolean;
};

export type ProviderMetrics = {
  utilizationPct: number;      // how full the provider is (for placement decisions)
  availableVcpu: number;
  wholesaleRwfPerVmMonth: number; // negotiated wholesale rate (COGS), RWF-native — fixed, per Annex A.2
};

export interface ProviderAdapter {
  readonly id: string;
  readonly name: string;
  readonly region: string;
  /** Stand up a target environment sized from the audit. */
  provision(input: { migrationId: string; dataVolumeGB: number }): Promise<ProvisionResult>;
  /** Current capacity + wholesale price, used for placement + billing. */
  getMetrics(): Promise<ProviderMetrics>;
}

/**
 * ---- Mock adapters for the three named Rwandan Tier III partners ----
 * Baseline utilization and wholesale rate are the venture's NEGOTIATED figures
 * (Annex A.2), not random numbers — they only change when a provisioning call
 * actually consumes capacity, tracked deterministically below.
 */
class MockProvider implements ProviderAdapter {
  private provisionedCount = 0; // real, tracked capacity consumption — not random drift

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly region: string,
    private readonly wholesaleRate: number, // fixed, negotiated RWF/VM/month
    private readonly baseUtilizationPct: number, // fixed starting utilization
    private readonly totalVcpu: number = 400, // total pool this facility offers
  ) {}

  async provision({ migrationId }: { migrationId: string; dataVolumeGB: number }): Promise<ProvisionResult> {
    // Simulate provisioning latency of a real API call.
    await new Promise((r) => setTimeout(r, 300));
    this.provisionedCount += 1; // deterministic: capacity moves because a real client was placed
    return {
      environmentId: `${this.id}-env-${migrationId.slice(0, 8)}`,
      provider: this.name,
      region: this.region,
      ready: true,
    };
  }

  async getMetrics(): Promise<ProviderMetrics> {
    // Utilization rises by a small, fixed step per client actually provisioned
    // here — a real, explainable number, not simulated noise.
    const utilizationPct = Math.min(95, this.baseUtilizationPct + this.provisionedCount * 2);
    const availableVcpu = Math.max(0, Math.round(this.totalVcpu * (1 - utilizationPct / 100)));
    return { utilizationPct, availableVcpu, wholesaleRwfPerVmMonth: this.wholesaleRate };
  }
}

// Negotiated USD rates ($60/$70/$65 per VM/mo) converted to RWF at the same
// illustrative FX rate used in billing.ts (1 USD = 1,465 RWF), per Annex A.2.
export const PROVIDERS: ProviderAdapter[] = [
  new MockProvider('aos', 'AOS Rwanda (National Data Center)', 'Kigali', 88_000, 55),
  new MockProvider('adc', 'ADC', 'Kigali', 102_500, 48),
  new MockProvider('paix', 'PAIX Rwanda', 'Kigali', 95_000, 62),
];

export function getProvider(id: string): ProviderAdapter | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Capacity headroom below which a provider is no longer considered viable for new placement. */
const VIABILITY_UTILIZATION_CEILING = 80;

/**
 * Placement decision: which Tier III partner should host this workload.
 *
 * This is a DETERMINISTIC rule, not a random pick: among providers with spare
 * capacity (utilization under the ceiling), choose the lowest negotiated
 * wholesale rate; ties broken by the most available vCPU. Given the same
 * provider state, this always returns the same answer — the only thing that
 * moves the outcome is a real change in capacity (an actual provisioning event),
 * never chance.
 *
 * An operator can also override the recommendation outright by passing
 * `preferredProviderId` — the system suggests a placement, it doesn't have to
 * be the one used. The override is still validated against real capacity so an
 * operator can't accidentally place a client on a full facility.
 */
export async function recommendProvider(
  preferredProviderId?: string,
): Promise<{ providerId: string; reason: string; overridden: boolean }> {
  const scored = await Promise.all(PROVIDERS.map(async (p) => ({ p, m: await p.getMetrics() })));

  if (preferredProviderId) {
    const chosen = scored.find((s) => s.p.id === preferredProviderId);
    if (!chosen) {
      throw new Error(`Unknown provider id "${preferredProviderId}".`);
    }
    if (chosen.m.utilizationPct >= VIABILITY_UTILIZATION_CEILING) {
      throw new Error(
        `${chosen.p.name} is at ${chosen.m.utilizationPct.toFixed(0)}% utilization and cannot take new placements right now.`,
      );
    }
    return {
      providerId: chosen.p.id,
      reason: `Operator-selected placement at ${chosen.p.name} (${chosen.m.utilizationPct.toFixed(0)}% utilized, RWF ${chosen.m.wholesaleRwfPerVmMonth.toLocaleString()}/VM/mo).`,
      overridden: true,
    };
  }

  const viable = scored.filter((s) => s.m.utilizationPct < VIABILITY_UTILIZATION_CEILING);
  const pool = viable.length ? viable : scored;
  // Deterministic ordering: cheapest wholesale rate first, ties broken by most spare vCPU.
  pool.sort((a, b) => a.m.wholesaleRwfPerVmMonth - b.m.wholesaleRwfPerVmMonth || b.m.availableVcpu - a.m.availableVcpu);
  const best = pool[0];

  if (!viable.length) {
    return {
      providerId: best.p.id,
      reason: `All partners are at or above ${VIABILITY_UTILIZATION_CEILING}% utilization; placing at ${best.p.name} as the least-loaded option (RWF ${best.m.wholesaleRwfPerVmMonth.toLocaleString()}/VM/mo, ${best.m.utilizationPct.toFixed(0)}% utilized). Consider onboarding an additional wholesale partner.`,
      overridden: false,
    };
  }

  return {
    providerId: best.p.id,
    reason: `Lowest negotiated wholesale rate (RWF ${best.m.wholesaleRwfPerVmMonth.toLocaleString()}/VM/mo) among partners with spare capacity (${best.m.utilizationPct.toFixed(0)}% utilized, ${best.m.availableVcpu} vCPU available).`,
    overridden: false,
  };
}
