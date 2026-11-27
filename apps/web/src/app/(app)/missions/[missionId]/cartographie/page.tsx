import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { CartographyPage } from '../../../../../components/cartography-page';

export const metadata: Metadata = { title: t('pages.missionMapping') };

export default function Page() {
  return <CartographyPage />;
}
