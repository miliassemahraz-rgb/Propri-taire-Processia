import { AiConfigError } from './errors.js';

type Env = Record<string, string | undefined>;

/** Vrai en intégration continue sans autorisation explicite d'appels réels (`AI_LIVE=1`). */
export function liveCallsForbidden(env: Env = process.env): boolean {
  const ci = env['CI'] !== undefined && env['CI'] !== '' && env['CI'] !== 'false';
  return ci && env['AI_LIVE'] !== '1';
}

/**
 * Garde-fou : en CI sans `AI_LIVE=1`, ni lecture de `ANTHROPIC_API_KEY` ni appel réseau réel.
 * Lève une erreur plutôt que de laisser un test dépenser de l'argent.
 */
export function assertNoRealKeyInCi(env: Env = process.env): void {
  if (liveCallsForbidden(env) && env['ANTHROPIC_API_KEY'] !== undefined) {
    throw new AiConfigError(
      'CONFIG',
      'ANTHROPIC_API_KEY est définie en CI sans AI_LIVE=1 : appels réels interdits.',
    );
  }
}
