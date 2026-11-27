import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { DeliverablesPage } from '../../../../../components/deliverables-page';

export const metadata: Metadata = { title: t('pages.missionDeliverables') };

export default function Page() {
  return <DeliverablesPage />;
}
