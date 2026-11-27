import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { InvitationForm } from '../../../../components/auth-forms';

export const metadata: Metadata = { title: t('auth.invitation.title') };

export default function Page() {
  return <InvitationForm />;
}
