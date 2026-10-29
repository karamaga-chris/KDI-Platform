/**
 * billing.ts
 * ---------------------------------------------------------------------------
 * Usage metering + tiered "Concierge Premium" pricing, producing an
 * RWF-denominated invoice. Pricing is RWF-native (matches the KDI financial
 * model's Client Value & Pricing worksheet, built from AOS Ltd.'s published
 * wholesale tiers) — a USD-equivalent is derived only for display/reporting,
 * not the other way around.
 *   Tier      Retail (RWF/mo)   AOS Wholesale (RWF/mo)   Margin
 *   STARTUP   115,000           47,613                   58.6%
 *   GROWTH    220,000           79,463                   63.9%
 *   PREMIUM   365,000           95,388                   73.9%
 * ---------------------------------------------------------------------------
 */
import { prisma } from '../db/prisma.js';

export type Tier = 'STARTUP' | 'GROWTH' | 'PREMIUM';

const PRICING: Record<Tier, { retailRwf: number; wholesaleRwf: number }> = {
  STARTUP: { retailRwf: 115_000, wholesaleRwf: 47_613 },
  GROWTH: { retailRwf: 220_000, wholesaleRwf: 79_463 },
  PREMIUM: { retailRwf: 365_000, wholesaleRwf: 95_388 },
};

// Illustrative FX; in production pull from a rate source at issue time.
const USD_TO_RWF = Number(process.env.USD_TO_RWF ?? 1465);

export async function issueInvoice(clientId: string) {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) throw new Error('Client not found');
  const price = PRICING[client.tier as Tier];
  const marginRwf = price.retailRwf - price.wholesaleRwf;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  return prisma.invoice.create({
    data: {
      clientId,
      periodStart: start,
      periodEnd: end,
      wholesaleRwf: price.wholesaleRwf,
      retailRwf: price.retailRwf,
      marginRwf,
      rwfAmount: price.retailRwf,
      usdEquivalent: price.retailRwf / USD_TO_RWF,
      fxRate: USD_TO_RWF,
    },
  });
}

/** Aggregate MRR ledger across all clients — the pilot financial-validation view. */
export async function mrrLedger() {
  const clients = await prisma.client.findMany();
  const rows = clients.map((c: { orgName: string; tier: string }) => {
    const p = PRICING[c.tier as Tier];
    return {
      client: c.orgName,
      tier: c.tier,
      retailRwf: p.retailRwf,
      wholesaleRwf: p.wholesaleRwf,
      marginRwf: p.retailRwf - p.wholesaleRwf,
      usdEquivalent: p.retailRwf / USD_TO_RWF,
    };
  });
  const aggregateMrr = rows.reduce((s: number, r: { retailRwf: number }) => s + r.retailRwf, 0);
  const aggregateCogs = rows.reduce((s: number, r: { wholesaleRwf: number }) => s + r.wholesaleRwf, 0);
  const grossMargin = aggregateMrr ? (aggregateMrr - aggregateCogs) / aggregateMrr : 0;
  return {
    rows,
    aggregateMrr,
    aggregateCogs,
    grossProfit: aggregateMrr - aggregateCogs,
    grossMarginPct: Math.round(grossMargin * 1000) / 10,
    fxRate: USD_TO_RWF,
  };
}