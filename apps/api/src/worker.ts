/**
 * Point d'entrée du worker (pipelines IA, extraction de documents, exports).
 * Volontairement vide à WP-01 : la file pg-boss est branchée par WP-11.
 */
import { loadEnv } from '@processia/config/env';

loadEnv();
console.info('Worker Processia démarré (aucune tâche enregistrée).');

const keepAlive = setInterval(() => undefined, 60_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(keepAlive);
    console.info(`Worker Processia arrêté (${signal}).`);
  });
}
