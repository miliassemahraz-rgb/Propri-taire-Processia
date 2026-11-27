import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { AnalysisPage } from '../../../../../components/analysis-page';

export const metadata: Metadata = { title: t('pages.missionAnalysis') };

export default function Page() {
  return <AnalysisPage />;
}
