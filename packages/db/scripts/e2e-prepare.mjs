import { resetTestDatabase, resolveDbUrls, seedDevelopment } from '@processia/db';
import { loadRootEnv } from './load-env.mjs';

// Prépare la base de test pour les tests E2E : migrations, remise à zéro, données de développement.
const urls = resolveDbUrls(loadRootEnv(), { test: true });
await resetTestDatabase(urls);
await seedDevelopment(urls.admin);
console.info('e2e:prepare : base de test prête.');
