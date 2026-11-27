import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { AdminAiPage } from '../../../../components/admin-ai';

export const metadata: Metadata = { title: t('pages.adminAi') };

export default function Page() {
  return <AdminAiPage />;
}
