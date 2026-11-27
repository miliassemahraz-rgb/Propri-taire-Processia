import type { Metadata } from 'next';
import { t } from '@processia/i18n';
import { TeamPage } from '../../../../../components/team-page';

export const metadata: Metadata = { title: t('pages.missionTeam') };

export default function Page() {
  return <TeamPage />;
}
