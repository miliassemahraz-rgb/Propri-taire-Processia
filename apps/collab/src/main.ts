import { loadEnv } from '@processia/config/env';
import { closeDb, createDb, resolveDbUrls } from '@processia/db';
import { createCollabServer } from './server.js';

const env = loadEnv();
const urls = resolveDbUrls({
  NODE_ENV: env.NODE_ENV,
  DATABASE_URL: env.DATABASE_URL,
  DATABASE_OWNER_URL: env.DATABASE_OWNER_URL,
  DATABASE_APP_URL: env.DATABASE_APP_URL,
});
const db = createDb(urls.app);
const server = createCollabServer({
  port: env.COLLAB_PORT,
  db,
  jwtSecret: env.COLLAB_JWT_SECRET,
  listenUrl: urls.app,
});

await server.listen();
console.info(`Serveur de coédition Processia à l'écoute sur le port ${env.COLLAB_PORT}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server
      .destroy()
      .then(() => closeDb(db))
      .finally(() => process.exit(0));
  });
}
