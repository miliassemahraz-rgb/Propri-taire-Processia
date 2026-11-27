import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { AdminUsersPage } from '../../../../components/admin-users';

export const metadata: Metadata = { title: t('pages.adminUsers') };

export default function Page() {
  return <AdminUsersPage />;
}
