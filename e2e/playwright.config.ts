import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { testDbEnv } from './test-env.js';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';
// En CI, Chromium est installé par `playwright install`. Sur un poste où il est déjà présent,
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH permet de le réutiliser.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
const root = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  testDir: './tests',
  globalSetup: './global-setup.ts',
  // Les parcours partagent la base de test et ses comptes : un seul travailleur.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    locale: 'fr-FR',
    trace: 'off',
    ...devices['Desktop Chrome'],
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: process.env['E2E_BASE_URL']
    ? undefined
    : [
        {
          // Base de test remise à l'état du seed, puis API sur cette base.
          command:
            'pnpm --filter @processia/db e2e:prepare && node --env-file=.env.example --env-file-if-exists=.env apps/api/dist/main.js',
          cwd: root,
          env: { ...testDbEnv, NODE_ENV: 'development' },
          url: 'http://localhost:3001/health',
          reuseExistingServer: false,
          timeout: 60_000,
        },
        {
          // Serveur de coédition (WP-10) sur la même base de test.
          command:
            'node --env-file=.env.example --env-file-if-exists=.env apps/collab/dist/main.js',
          cwd: root,
          env: { ...testDbEnv, NODE_ENV: 'development' },
          url: 'http://localhost:3002',
          reuseExistingServer: false,
          timeout: 60_000,
        },
        {
          command: 'pnpm --filter @processia/web start',
          cwd: root,
          url: baseURL,
          reuseExistingServer: !process.env['CI'],
          timeout: 60_000,
        },
      ],
});
