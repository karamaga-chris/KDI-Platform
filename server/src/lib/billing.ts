/**
 * billing.ts
 * ---------------------------------------------------------------------------
 * Usage metering + tiered "Concierge Premium" pricing, producing an
 * RWF-denominated invoice. Reconciles to the Annex A.2 unit economics:
 *   Tier      Retail MRR   Wholesale COGS   Margin
 *   STARTUP   $150         $60              60.0%
 *   GROWTH    $300         $150             50.0%
 *   PREMIUM   $500         $280             44.0%
 * ---------------------------------------------------------------------------
 */
import { prisma } from '../db/prisma.js';

export type Tier = 'STARTUP' | 'GROWTH' | 'PREMIUM';

const PRICING: Record<Tier, { retailUsd: number; wholesaleUsd: number }> = {
  STARTUP: { retailUsd: 150, wholesaleUsd: 60 },
  GROWTH: { retailUsd: 300, wholesaleUsd: 150 },
  PREMIUM: { retailUsd: 500, wholesaleUsd: 280 },
};

// Illustrative FX; in production pull from a rate source at issue time.
const USD_TO_RWF = Number(process.env.USD_TO_RWF ?? 1300);

export async function issueInvoice(clientId: string) {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) throw new Error('Client not found');
  const price = PRICING[client.tier as Tier];
  const marginUsd = price.retailUsd - price.wholesaleUsd;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);

  return prisma.invoice.create({
    data: {
      clientId,
      periodStart: start,
      periodEnd: end,
      wholesaleUsd: price.wholesaleUsd,
      retailUsd: price.retailUsd,
      marginUsd,
      rwfAmount: price.retailUsd * USD_TO_RWF,
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
      retailUsd: p.retailUsd,
      wholesaleUsd: p.wholesaleUsd,
      marginUsd: p.retailUsd - p.wholesaleUsd,
      rwfAmount: p.retailUsd * USD_TO_RWF,
    };
  });
  const aggregateMrr = rows.reduce((s: number, r: { retailUsd: number }) => s + r.retailUsd, 0);
  const aggregateCogs = rows.reduce((s: number, r: { wholesaleUsd: number }) => s + r.wholesaleUsd, 0);
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
