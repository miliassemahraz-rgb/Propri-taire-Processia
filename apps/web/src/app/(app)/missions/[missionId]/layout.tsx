import type { ReactNode } from 'react';
import { MissionFrame } from '../../../../components/mission-frame';

export default function MissionLayout({ children }: { children: ReactNode }) {
  return <MissionFrame>{children}</MissionFrame>;
}
