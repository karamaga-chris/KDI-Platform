import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { registerApi } from './routes/api.js';
import { prisma } from './db/prisma.js';

const isProduction = process.env.NODE_ENV === 'production';

// Explicit allowlist — comma-separated origins, e.g. "https://console.kdi.rw,https://app.kdi.rw".
const allowedOrigins = (process.env.ALLOWED_ORIGIN ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

if (isProduction && allowedOrigins.length === 0) {
  throw new Error('ALLOWED_ORIGIN must be set in production (comma-separated allowlist of origins).');
}
if (allowedOrigins.length === 0) {
  console.warn('[cors] ALLOWED_ORIGIN not set — defaulting to the Vite dev server origin only.');
}

// Shared bearer token for the operator console API. Simplest viable auth for
// a pilot with one operator team — not per-user auth, just "can you reach the API at all."
const API_TOKEN = process.env.API_TOKEN;
if (isProduction && !API_TOKEN) {
  throw new Error('API_TOKEN must be set in production (shared bearer token for the operator console).');
}
if (!API_TOKEN) {
  console.warn('[auth] API_TOKEN not set — API is UNAUTHENTICATED (dev mode only, do not deploy like this).');
}

const app = Fastify({ logger: true });

await app.register(cors, {
  origin: allowedOrigins.length ? allowedOrigins : ['http://localhost:5173'],
});

// Baseline abuse protection on every route; specific heavy routes (PDF
// generation, monitoring samples) tighten this further via per-route config
// in routes/api.ts.
await app.register(rateLimit, {
  max: 120,
  timeWindow: '1 minute',
});

// Bearer-token gate on everything except the health check (so uptime
// monitors / load balancers can probe it without a credential).
app.addHook('onRequest', async (req, reply) => {
  if (!API_TOKEN) return; // dev mode — no token configured, auth skipped
  if (req.url === '/api/health') return;
  if (req.headers.authorization !== `Bearer ${API_TOKEN}`) {
    reply.code(401).send({ error: 'Unauthorized' });
  }
});

// Never leak stack traces or internals (e.g. DATABASE_URL inside a Prisma
// error message) to the client outside development.
app.setErrorHandler((err: FastifyError, req, reply) => {
  req.log.error(err);
  const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 500;
  reply.code(status).send({
    error: isProduction ? 'Internal server error' : err.message,
  });
});

await registerApi(app);

const port = Number(process.env.PORT ?? 4000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`KDI platform API on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

// Graceful shutdown: stop accepting new work, let in-flight requests finish,
// then close the Prisma connection before exiting.
let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info(`${signal} received, shutting down gracefully`);
  try {
    await app.close();
    await prisma.$disconnect();
    app.log.info('shutdown complete');
    process.exit(0);
  } catch (err) {
    app.log.error(err, 'error during shutdown');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  app.log.fatal(err, 'uncaught exception — shutting down');
  void shutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  app.log.error({ reason }, 'unhandled promise rejection');
});
