import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env['E2E_BASE_URL'] ?? 'http://localhost:3000';
// En CI, Chromium est installé par `playwright install`. Sur un poste où il est déjà présent,
// PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH permet de le réutiliser.
const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
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
    : {
        command: 'pnpm --filter @processia/web start',
        url: baseURL,
        reuseExistingServer: !process.env['CI'],
        timeout: 60_000,
      },
});
