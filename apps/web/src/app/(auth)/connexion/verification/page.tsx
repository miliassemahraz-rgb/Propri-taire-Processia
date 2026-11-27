import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { VerifyForm } from '../../../../components/auth-forms';

export const metadata: Metadata = { title: t('auth.verify.title') };

export default function Page() {
  return <VerifyForm />;
}
