import { describe, expect, it } from 'vitest';
import { t } from '@processia/i18n';

// Le rendu de la page est vérifié par le test de fumée E2E (e2e/smoke.spec.ts).
describe('page d’accueil', () => {
  it('affiche le nom du produit depuis les messages i18n', () => {
    expect(t('home.title')).toBe('Processia');
  });
});
