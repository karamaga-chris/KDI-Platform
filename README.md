# Kigali Digital Infrastructure — Managed IT Concierge (MVP)

A working scaffold of the **API-Driven Platform Overlay (PaaS)** that operationalises
Kigali Digital Infrastructure's onboarding methodology — for both existing apps that
need to **migrate** off offshore hosting and brand-new apps being **hosted locally for
the first time**.

The defensible core is one **guarded workflow state machine**
(`server/src/engine/migrationMachine.ts`) that both onboarding paths share:

```
MIGRATION   (existing app, moving off offshore hosting)
  Pillar 1 Pre-Flight Audit       discovery -> auditReady
  Pillar 2 Background Sync        provisioning -> replicating -> staging (integrity + sign-off)
  Pillar 3 Zero-Downtime Cutover  cutover -> monitoring   (+ 30-day Safe Rollback)

GREENFIELD  (brand-new app, never hosted anywhere — no source to migrate)
  Pillar 1 Requirements & Sizing  intake -> sizingReady
  Pillar 2 Environment Setup      provisioning -> smokeTest
  Pillar 3 Go-Live                launch -> monitoring   (+ 30-day guarantee window)
```

Both paths converge at `provisioning` (same aggregated Tier III placement logic serves
both) and are gated the same way a bank would want: **MIGRATION cannot cut over without
an integrity pass and client sign-off; GREENFIELD cannot go live without a passed smoke
test.** Nothing skips the gate — it's enforced in code and proven by tests, not policy.

---

## Stack

| Layer | Tech | Cost |
|---|---|---|
| Workflow engine | **XState 5** (state machine + guards, 2 onboarding paths) | free / OSS |
| API | **Node + Fastify + TypeScript** | free / OSS |
| Database | **PostgreSQL + Prisma** | free / OSS |
| Provider aggregation | pluggable `ProviderAdapter` (AOS / ADC / PAIX mocks) | free / OSS |
| Monitoring | pluggable `MonitoringAdapter` — **UptimeRobot free tier**, a real **HTTP prober**, or a **local mock-origin** | **$0** |
| Reports | **pdfkit** — real PDF generation for the audit/sizing report | free / OSS |
| Frontend | **React + Vite + TypeScript** | free / OSS |
| Tests | **Vitest** — 18 tests across the machine, monitoring, and reports | free / OSS |

No paid service is required at any point in the pilot.

---

## Prerequisites

- Node.js 18+
- Docker (for Postgres) — or your own Postgres

## Run it

```bash
# 1. Start Postgres
docker compose up -d

# 2. Backend
cd server
cp .env.example .env
npm install
npx prisma generate        # generates the Prisma client from schema.prisma
npm run prisma:migrate     # creates tables (incl. migrationType, targetEndpoint, etc.)
npm run prisma:seed        # seeds 3 MIGRATION clients + 1 GREENFIELD client
npm run dev                # API on http://localhost:4000

# 3. Local "Tier III" mock origin — see "Fixing the latency demo" below (new terminal)
npm run dev:origin         # local target on http://localhost:5050/ping

# 4. Frontend (new terminal)
cd client
npm install
npm run dev                # console on http://localhost:5173
```

## Prove the core works

```bash
cd server
npm test
```

18 tests, three files:
- `engine/migrationMachine.test.ts` (10) — MIGRATION happy path + guards, GREENFIELD
  happy path + guards, and proof the two types can't cross-trigger each other's events.
- `adapters/monitoring.test.ts` (4) — proves the HTTP prober performs a **real** network
  request (not a mock).
- `lib/auditReport.test.ts` (4) — proves the report content correctly differs by
  onboarding type and escalates its verdict for large migrations.

---

## Fixing the latency demo (why Wikipedia showed ~779ms)

The `<100ms` target is a **Kigali-user → Kigali-local-server** measurement. Probing a
public global site (Wikipedia, Google, Cloudflare) can never validate that number —
you're measuring internet transit distance and a cold TLS handshake, not the thing the
product actually improves. That's not a bug, it's the wrong yardstick.

**The real fix** was a genuine gap: the app was monitoring the *original offshore URL*
even after "migration," instead of switching to a local target. That's now fixed
properly:

- `Client.endpoint` is **only** the pre-migration offshore baseline (used during
  `discovery`, feeds `latencyBeforeMs` in the audit report).
- `Migration.targetEndpoint` is the **real local address** the client runs on once
  live — set automatically at `provisioning`, and what `monitoring` actually probes.
- `server/src/mock-origin.ts` is a tiny local Fastify server (`npm run dev:origin`)
  that responds in single-digit milliseconds — standing in for "this client's app on
  local Tier III infrastructure" in the demo, the same way a real local VM would.

Once `dev:origin` is running and `MOCK_ORIGIN_URL` is set (default in `.env.example`),
any client that goes live will show genuine sub-20ms latency, because it's now probing
a target that's actually local. In production, `targetEndpoint` would be the real
provisioned VM's address from the AOS/ADC/PAIX API — same mechanism, real infrastructure.

---

## The two onboarding paths, end to end

**Migration** (existing app): Dashboard → "Migrate an existing app" → fill in the
current offshore provider and (optionally) its URL for baselining → the 3-pillar flow
runs discovery, audit, provisioning, replication, staged verification, and a gated
cutover.

**Greenfield** (new app): Dashboard → "Host a brand-new app" → no offshore fields shown
(there's nothing to migrate from) → runs requirements intake, sizing, provisioning, a
smoke test, and a gated go-live. The pillar labels and pipeline visually adapt
(`PillarPipeline.tsx` renders different stage sets per type), but the underlying
discipline — guarded, audited, reversible — is identical.

## Demo script (for the panel)

1. Open the console → onboard **one of each type** (or open the seeded ones).
2. Migration client: advance through Pillar 1, **download the Readiness Audit PDF**
   when it appears at `auditReady`, then continue to `staging` and try **Execute
   cutover** before sign-off — the guard rejects it. Sign off, cut over.
3. Greenfield client: advance through Pillar 1 (**download the Sizing Report PDF**
   at `sizingReady`), provision, then try **Go live** before the smoke test — rejected.
   Pass the smoke test, go live.
4. On `monitoring` for either, watch the **real** uptime % and latency sparkline
   (badge shows "Live · real HTTP probe" or "Live · UptimeRobot API") — genuinely
   sub-20ms once probing the local mock origin.
5. Back on the dashboard, show **Aggregate MRR** and blended margin reconciling to
   the Annex A.2 unit economics.

See `docs/ARCHITECTURE.md` for what is real vs. simulated and the path to production.

---

## Monitoring is a REAL adapter

Behind one `MonitoringAdapter` interface, `makeMonitor()` picks the most real option
available:

- `UPTIMEROBOT_API_KEY` set → **UptimeRobotAdapter** (real, persistent; free tier).
- `MONITOR_REAL_HTTP=1` (default in `.env.example`) → **HttpLatencyProber**, a genuine
  timed HTTP request. No account needed.
- neither → simulated `LatencyProber` (demo only).

The console shows a **data-source badge** so it's visible the numbers are real.

### Optional: use UptimeRobot instead of the local HTTP probe

1. Create a free account at https://uptimerobot.com
2. My Settings → API → **Main API Key**
3. Put it in `server/.env` as `UPTIMEROBOT_API_KEY=...` and restart the server.
