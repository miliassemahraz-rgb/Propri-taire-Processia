import { loadEnv } from '@processia/config/env';
import { createCollabServer } from './server.js';

const env = loadEnv();
const server = createCollabServer({ port: env.COLLAB_PORT });

await server.listen();
console.info(`Serveur de coédition Processia à l'écoute sur le port ${env.COLLAB_PORT}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void server.destroy().finally(() => process.exit(0));
  });
}
