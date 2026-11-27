import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { AdminClientsPage } from '../../../../components/admin-clients';

export const metadata: Metadata = { title: t('pages.adminClients') };

export default function Page() {
  return <AdminClientsPage />;
}
