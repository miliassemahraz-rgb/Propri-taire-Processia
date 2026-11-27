import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { ValidationPage } from '../../../../../components/validation-page';

export const metadata: Metadata = { title: t('pages.missionValidation') };

export default function Page() {
  return <ValidationPage />;
}
