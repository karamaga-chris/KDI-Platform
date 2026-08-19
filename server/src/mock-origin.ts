/**
 * mock-origin.ts
 * ---------------------------------------------------------------------------
 * A separate, minimal server that stands in for "the client's app now running
 * on local Tier III infrastructure" in the demo.
 *
 * WHY THIS EXISTS: the <100ms latency target is a Kigali-user -> Kigali-local-
 * server measurement. Probing a public global site (e.g. Wikipedia) can never
 * validate that number — you'd be measuring internet transit distance, not the
 * thing the product actually improves. This tiny origin responds in single-digit
 * milliseconds, which is what "hosted locally, not offshore" looks like.
 *
 * Usage: after PROVISION_DONE, the migration's targetEndpoint is set to this
 * server's /ping route. Post-cutover/launch monitoring probes THAT endpoint —
 * not the original offshore URL used for the pre-migration baseline. That
 * separation (source endpoint vs. target endpoint) is the actual fix.
 *
 * Run: npm run dev:origin   (separate process from the main API)
 * ---------------------------------------------------------------------------
 */
import Fastify from 'fastify';

const app = Fastify({ logger: false });

app.get('/ping', async (req, reply) => {
  // Small deliberate jitter (1-8ms) so the sparkline isn't a flat line —
  // representative of genuine same-region network variance, nothing more.
  const jitter = Math.floor(Math.random() * 7) + 1;
  await new Promise((r) => setTimeout(r, jitter));
  reply.header('X-KDI-Origin', 'local-mock-tier-iii');
  return { ok: true, region: 'kigali-local', at: new Date().toISOString() };
});

app.get('/health', async () => ({ ok: true }));

const port = Number(process.env.MOCK_ORIGIN_PORT ?? 5050);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => console.log(`[mock-origin] local Tier III stand-in on http://localhost:${port}/ping`))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
