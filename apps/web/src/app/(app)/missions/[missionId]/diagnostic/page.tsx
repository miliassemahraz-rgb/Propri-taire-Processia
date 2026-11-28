import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { DiagnosticPage } from '../../../../../components/diagnostic-page';

export const metadata: Metadata = { title: t('pages.missionDiagnostic') };

export default function Page() {
  return <DiagnosticPage />;
}
