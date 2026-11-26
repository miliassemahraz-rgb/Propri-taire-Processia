import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Dossier des prompts versionnés `<pipeline>.fr.md` (voisin de `src/` et de `dist/`). */
export const PROMPTS_DIR = fileURLToPath(new URL('../prompts/', import.meta.url));

/** Remplace les variables `{{nom}}` ; une variable manquante est une erreur (pas de prompt tronqué). */
export function renderPrompt(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`Variable de prompt manquante : ${name}`);
    return String(value);
  });
}

export function loadPrompt(
  pipeline: string,
  vars?: Record<string, string | number>,
  dir: string = PROMPTS_DIR,
): string {
  if (!/^[a-z0-9_.-]+$/.test(pipeline)) throw new Error(`Nom de pipeline invalide : ${pipeline}`);
  return renderPrompt(readFileSync(`${dir}${pipeline}.fr.md`, 'utf8'), vars).trim();
}
