import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, messages, t } from './index.js';

describe('@processia/i18n', () => {
  it('expose le squelette du paquet', () => {
    expect(PACKAGE_NAME).toBe('@processia/i18n');
  });

  it('traduit une clé existante', () => {
    expect(t('app.name')).toBe('Processia');
    expect(messages.app.name).toBe('Processia');
  });

  it('refuse une clé inconnue au runtime', () => {
    expect(() => t('app.inconnue' as never)).toThrow(/inconnue/);
  });
});
