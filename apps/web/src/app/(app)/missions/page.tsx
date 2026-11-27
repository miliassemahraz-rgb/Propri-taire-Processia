import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { MissionsPage } from '../../../components/missions-page';

export const metadata: Metadata = { title: t('pages.missions') };

export default function Page() {
  return <MissionsPage />;
}
