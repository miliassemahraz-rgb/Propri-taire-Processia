import { migrateDatabase, resolveDbUrls } from '@processia/db';
import { loadRootEnv } from './load-env.mjs';

await migrateDatabase(resolveDbUrls(loadRootEnv()));
console.info('db:migrate : migrations appliquées.');
