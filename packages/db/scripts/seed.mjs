import { resolveDbUrls, seedDevelopment } from '@processia/db';
import { loadRootEnv } from './load-env.mjs';

const env = loadRootEnv();
if (env.NODE_ENV === 'production') throw new Error('db:seed est réservé au développement.');
await seedDevelopment(resolveDbUrls(env).admin);
console.info('db:seed : données de développement insérées.');
