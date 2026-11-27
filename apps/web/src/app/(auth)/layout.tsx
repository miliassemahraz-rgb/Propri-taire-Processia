import type { ReactNode } from 'react';
import { t } from '@processia/i18n';

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <main id="contenu" tabIndex={-1} className="centered">
      <div className="card narrow stack">
        <p className="auth-brand">{t('shell.brand')}</p>
        {children}
      </div>
    </main>
  );
}
