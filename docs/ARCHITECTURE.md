# Architecture & Defensibility

## The one thing that matters

The novel, defensible asset is **not** the infrastructure — AOS, ADC and PAIX own
that. It is the **codified, guarded migration workflow** plus the **demand-aggregation
placement layer**. Competitors can rent the same VMs; they cannot trivially reproduce
a workflow engine that guarantees a safe, zero-downtime, compliant migration that one
operator can run repeatably across many clients.

That asset lives in two files:

- `server/src/engine/migrationMachine.ts` — the three-pillar state machine with guards.
- `server/src/adapters/provider.ts` — the aggregation + placement logic.

Everything else is plumbing around them.

## Why a state machine (and not just status flags)

A status column (`state = 'staging'`) can be set to anything by any code path. A
**guarded state machine** makes illegal transitions structurally impossible:

- `EXECUTE_CUTOVER` only fires if `integrityPassed && clientSignedOff` (the `canCutover`
  guard). There is no code path that cuts over an unverified environment.
- `ROLLBACK` after cutover is only free inside the `withinGuaranteeWindow` guard.

These guarantees are unit-tested, so they are *evidence*, not claims — which is exactly
what an examiner or an early enterprise client wants to see.

## The adapter pattern = the moat, made swappable

Both external dependencies sit behind one interface each:

```
ProviderAdapter   provision() · getMetrics()      → AOS / ADC / PAIX (mock now, API later)
MonitoringAdapter sample()                          → UptimeRobot free tier / built-in prober
```

Consequences:
- **Aggregation:** `recommendProvider()` reads live capacity + wholesale price across all
  providers and places the client on the cheapest viable one. That is the "aggregate SME
  demand, negotiate wholesale, place optimally" thesis expressed in code.
- **Multi-provider failover** (scalability roadmap) is a new adapter, not a rewrite.
- **No vendor lock-in** in our own codebase.

## Real vs. simulated in this MVP

| Capability | In this scaffold | To make production |
|---|---|---|
| Workflow engine & guards | **Real & tested** | ready as-is |
| Audit trail persistence | **Real** (Postgres) | ready as-is |
| Tiered billing + RWF invoice + MRR ledger | **Real** | plug a live FX source |
| Provider provisioning | Mock adapter | implement AOS/ADC/PAIX API client behind `ProviderAdapter` |
| Data replication | Simulated event | integrate a replication tool (e.g. managed logical replication / DMS-style) |
| DNS cutover | Simulated event | call a DNS provider API in the `cutover` side-effect |
| Uptime/latency | **REAL** — `HttpLatencyProber` does genuine timed requests to a real client URL by default (`MONITOR_REAL_HTTP=1`); `UptimeRobotAdapter` uses the free-tier API to create + read monitors. Simulated prober only if neither is configured. | already real; optionally self-host Uptime Kuma at scale |
| Audit / sizing report (Pillar 1) | **REAL** — `lib/auditReport.ts` deterministically builds the report from live migration context and renders a genuine PDF via `pdfkit`. Cached to `Migration.auditReportJson`. | already real; add e-signature capture on client acknowledgement |
| Compliance report / certificate | Data captured; report generation pattern already proven (see above) | reuse `auditReport.ts`'s PDF renderer for a periodic NCSA/RURA compliance report and the migration completion certificate |

Nothing above requires re-architecting: each is a side effect attached to an existing
state transition.

## Data-access dependency (call this out to the panel)

As a **broker**, the platform does not own provider telemetry by default. Provisioning
APIs and utilisation metrics from AOS/ADC/PAIX must be granted via a **data-access clause
in the partner MOUs** (WBS 2.1). Without it, the provider adapters cannot be made real.
This is a contract dependency, not a code dependency — and it is the single most important
thing to secure alongside this build.

## Monitoring: now a REAL adapter (the wired-up example)

Monitoring is the first adapter taken from mock to real, proving the adapter pattern
swaps as promised. There are three implementations behind one `MonitoringAdapter`
interface, and the factory (`makeMonitor()`) picks the most real one available:

1. **`UptimeRobotAdapter`** (real, persistent) — if `UPTIMEROBOT_API_KEY` is set, it
   creates/looks-up an UptimeRobot monitor per client endpoint and reads back real
   status + response times. Free tier (50 monitors) is sufficient for the pilot.
2. **`HttpLatencyProber`** (real, no account) — default when `MONITOR_REAL_HTTP=1`.
   Performs a genuine timed HTTP request to the client's real endpoint URL and reports
   true round-trip latency and up/down. This is what runs out of the box.
3. **`LatencyProber`** (simulated) — only used if neither of the above is configured.

The console shows a **data-source badge** ("Live · real HTTP probe" / "Live · UptimeRobot
API" / "Simulated") so anyone watching can see the numbers are real, not fabricated.

Evidence: `server/src/adapters/monitoring.test.ts` includes a test that performs an
actual network request and asserts a real, non-zero measured latency — a mock could
not pass it.

The pilot still runs on **$0 of monitoring spend**. At scale, **Uptime Kuma**
(self-hosted, OSS) or **Grafana + Prometheus** implement the same interface — still no
paid tier.

## Two onboarding paths, one guarded machine

The original proposal's three pillars are a genuine methodology, not just a migration
checklist — so the machine now serves a **second path** for apps that were never
hosted anywhere (a real, common case: an SME building their first product and wanting
to launch directly on local infrastructure rather than start offshore and migrate later).

Both paths are one `createMachine` call, converging at `provisioning` (the same
demand-aggregation/placement logic serves both) and diverging for Pillar 1 and Pillar 3:

```
created --START_AUDIT (guard: MIGRATION)--> discovery --> auditReady --> provisioning
created --START_INTAKE (guard: GREENFIELD)--> intake --> sizingReady --> provisioning

provisioning --PROVISION_DONE--> (guard: GREENFIELD) smokeTest --> launch --> monitoring
provisioning --PROVISION_DONE--> (default: MIGRATION) replicating --> staging --> cutover --> monitoring
```

The two type-isolation guards (`isMigration` / `isGreenfield`) are as important as the
cutover/go-live guards: they prevent a machine instance from ever taking the wrong
branch, which is tested explicitly (`migrationMachine.test.ts`, "cannot start the
greenfield/migration path" tests). This is the same defensibility argument extended to
a second, real product surface rather than a special case bolted on top.

## Honest limitation: verify the Prisma layer on your own machine

This scaffold was built and tested in a sandboxed environment that cannot download
Prisma's query-engine binary (its egress is restricted to a small domain allowlist that
excludes `binaries.prisma.sh`). Every state-machine, monitoring, and report-generator
test above runs with zero database dependency and is proven passing. The Prisma schema
and the service-layer field names were cross-checked by hand against `schema.prisma`
and match exactly — but that manual check is not a substitute for a real `npx prisma
generate` + `tsc --noEmit` pass, which needs normal internet access (available on any
developer machine, not available in this sandbox). Run that once locally before relying
on this for a live demo.
