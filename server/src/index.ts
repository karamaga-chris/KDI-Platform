import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerApi } from './routes/api.js';

const app = Fastify({ logger: true });

await app.register(cors, { origin: true });
await registerApi(app);

const port = Number(process.env.PORT ?? 4000);
app
  .listen({ port, host: '0.0.0.0' })
  .then(() => app.log.info(`KDI platform API on :${port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
