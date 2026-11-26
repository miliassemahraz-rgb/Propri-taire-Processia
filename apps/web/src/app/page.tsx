import { t } from '@processia/i18n';

export default function HomePage() {
  return (
    <main className="home">
      <h1>{t('home.title')}</h1>
      <p>{t('home.intro')}</p>
      <p className="muted">{t('home.status')}</p>
    </main>
  );
}
