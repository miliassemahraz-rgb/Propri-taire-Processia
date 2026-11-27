import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { LoginForm } from '../../../components/auth-forms';

export const metadata: Metadata = { title: t('auth.login.title') };

export default function Page() {
  return <LoginForm />;
}
