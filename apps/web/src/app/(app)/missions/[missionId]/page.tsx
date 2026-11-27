import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { MissionDashboard } from '../../../../components/mission-dashboard';

export const metadata: Metadata = { title: t('pages.missionDashboard') };

export default function Page() {
  return <MissionDashboard />;
}
