import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { t } from '@processia/i18n';
import './globals.css';

export const metadata: Metadata = {
  title: t('app.name'),
  description: t('app.tagline'),
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
