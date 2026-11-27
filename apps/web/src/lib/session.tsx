'use client';

import { usePathname, useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { MeResponse } from '@processia/contracts';
import { setCsrfToken } from './api';
import { endpoints } from './endpoints';

export type SessionState =
  { status: 'loading' } | { status: 'anonymous' } | { status: 'ready'; me: MeResponse };

interface SessionValue {
  state: SessionState;
  /** Relit `/me` (après une étape de connexion, par exemple). */
  refresh: () => Promise<SessionState>;
  /** Ferme la session côté serveur puis revient à la connexion. */
  logout: () => Promise<void>;
}

const SessionContext = createContext<SessionValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const router = useRouter();

  const refresh = useCallback(async (): Promise<SessionState> => {
    let next: SessionState;
    try {
      const me = await endpoints.me();
      setCsrfToken(me.csrfToken);
      next = { status: 'ready', me };
    } catch {
      setCsrfToken(null);
      // Toute erreur autre qu'une session absente est traitée comme « pas de session » : la page
      // de connexion affichera ses propres messages.
      next = { status: 'anonymous' };
    }
    setState(next);
    return next;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await endpoints.logout();
    } finally {
      setCsrfToken(null);
      setState({ status: 'anonymous' });
      router.push('/connexion');
    }
  }, [router]);

  const value = useMemo(() => ({ state, refresh, logout }), [state, refresh, logout]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const value = useContext(SessionContext);
  if (value === null) throw new Error('useSession doit être appelé sous SessionProvider.');
  return value;
}

/** Chemin de l'étape de connexion à franchir pour une session donnée, ou `null` si elle est complète. */
export function pendingAuthStep(me: MeResponse): string | null {
  if (me.mfaVerified) return null;
  return me.mfaEnrolled ? '/connexion/verification' : '/connexion/enrolement';
}

/**
 * Garde des pages authentifiées : sans session, retour à la connexion ; session sans second
 * facteur, étape correspondante. Renvoie l'état tant que la page doit attendre.
 */
export function useRequireSession(): MeResponse | null {
  const { state } = useSession();
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    if (state.status === 'anonymous') {
      router.replace(`/connexion?next=${encodeURIComponent(pathname)}`);
    } else if (state.status === 'ready') {
      const step = pendingAuthStep(state.me);
      if (step !== null) router.replace(step);
    }
  }, [state, router, pathname]);
  return state.status === 'ready' && state.me.mfaVerified ? state.me : null;
}
