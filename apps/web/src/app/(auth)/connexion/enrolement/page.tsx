import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { EnrollForm } from '../../../../components/auth-forms';

export const metadata: Metadata = { title: t('auth.enroll.title') };

export default function Page() {
  return <EnrollForm />;
}
