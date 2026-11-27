import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { testDbEnv } from './test-env.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/**
 * Worker pg-boss (WP-11, WP-12) sur la base de test : sans lui, ni la lecture des documents
 * déposés ni l'extraction (« Analyser ») ne s'exécutent. Il n'écoute aucun port, il ne peut donc
 * pas être déclaré dans `webServer` : on le lance ici, après l'API (qui a préparé la base).
 */
export default function globalSetup(): (() => void) | undefined {
  // Cible externe : le worker du serveur visé est de la responsabilité de son exploitant.
  if (process.env['E2E_BASE_URL']) return undefined;
  const worker = spawn(
    'node',
    ['--env-file=.env.example', '--env-file-if-exists=.env', 'apps/api/dist/worker.js'],
    {
      cwd: root,
      env: { ...process.env, ...testDbEnv, NODE_ENV: 'development' },
      stdio: 'inherit',
    },
  );
  return () => {
    worker.kill('SIGTERM');
  };
}
