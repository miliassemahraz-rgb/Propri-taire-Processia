import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Variables d'environnement : `.env` à la racine du dépôt, sinon `.env.example`, puis `process.env`. */
export function loadRootEnv() {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  let text;
  try {
    text = readFileSync(`${root}.env`, 'utf8');
  } catch {
    text = readFileSync(`${root}.env.example`, 'utf8');
  }
  const env = {};
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
  }
  return { ...env, ...process.env };
}
