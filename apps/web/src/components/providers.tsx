'use client';

import type { ReactNode } from 'react';
import { ToastHost } from '@processia/ui';
import { ModeProvider } from '../lib/mode';
import { SessionProvider } from '../lib/session';

export function Providers({ children }: { children: ReactNode }) {
  return (
    <SessionProvider>
      <ModeProvider>
        {children}
        <ToastHost />
      </ModeProvider>
    </SessionProvider>
  );
}
