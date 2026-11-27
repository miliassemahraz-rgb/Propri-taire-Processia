import type { Metadata } from 'next';
import Link from 'next/link';
import { t } from '@processia/i18n';

export const metadata: Metadata = { title: t('pages.notFound') };

export default function NotFound() {
  return (
    <main id="contenu" tabIndex={-1} className="centered">
      <div className="card narrow stack">
        <h1>{t('notFound.heading')}</h1>
        <p>{t('notFound.body')}</p>
        <Link href="/missions">{t('notFound.back')}</Link>
      </div>
    </main>
  );
}
