import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  await prisma.uptimeSample.deleteMany();
  await prisma.auditEvent.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.migration.deleteMany();
  await prisma.client.deleteMany();

  // `endpoint` (offshore) is only meaningful for MIGRATION clients — it's the
  // pre-migration baseline probed during discovery. GREENFIELD clients have no
  // prior host, so `endpoint` is left null; their real target endpoint is set
  // automatically at provisioning time (see migrationService.ts / mock-origin.ts).
  const seed = [
    {
      orgName: 'PesaFlow (fintech)', sector: 'fintech', migrationType: 'MIGRATION' as const,
      currentProvider: 'AWS eu-central-1', endpoint: 'https://www.google.com',
      dataVolumeGB: 120, tier: 'PREMIUM' as const,
    },
    {
      orgName: 'KiviShop (e-commerce)', sector: 'e-commerce', migrationType: 'MIGRATION' as const,
      currentProvider: 'DigitalOcean LON1', endpoint: 'https://www.cloudflare.com',
      dataVolumeGB: 60, tier: 'GROWTH' as const,
    },
    {
      orgName: 'AfyaLink (digital health)', sector: 'digital-health', migrationType: 'MIGRATION' as const,
      currentProvider: 'Azure South Africa', endpoint: 'https://www.wikipedia.org',
      dataVolumeGB: 30, tier: 'STARTUP' as const,
    },
    {
      // A brand-new app, never hosted anywhere — the greenfield onboarding path.
      orgName: 'NiraPay (new fintech app)', sector: 'fintech', migrationType: 'GREENFIELD' as const,
      currentProvider: 'none (new app)', endpoint: null,
      dataVolumeGB: 10, tier: 'STARTUP' as const,
    },
  ];

  for (const c of seed) {
    const { migrationType, dataVolumeGB, ...clientData } = c;
    const client = await prisma.client.create({ data: { ...clientData, dataVolumeGB } });
    await prisma.migration.create({ data: { clientId: client.id, migrationType, dataVolumeGB } });
  }
  console.log('Seeded', seed.length, 'clients with migrations (3 MIGRATION, 1 GREENFIELD).');
}

main().finally(() => prisma.$disconnect());
