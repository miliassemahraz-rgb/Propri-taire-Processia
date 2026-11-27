import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { t } from '@processia/i18n';
import { SkipLink } from '@processia/ui';
import '@processia/ui/styles.css';
import './globals.css';
import { Providers } from '../components/providers';

export const metadata: Metadata = {
  title: { default: t('app.name'), template: `%s · ${t('app.name')}` },
  description: t('app.tagline'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>
        <SkipLink href="#contenu">{t('a11y.skipToContent')}</SkipLink>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
