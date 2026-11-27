'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type DisplayMode = 'simple' | 'expert';

const STORAGE_KEY = 'processia.mode';

interface ModeValue {
  mode: DisplayMode;
  setMode: (mode: DisplayMode) => void;
}

const ModeContext = createContext<ModeValue>({ mode: 'simple', setMode: () => undefined });

/** Mode d'affichage simple / expert, mémorisé par navigateur (commodité, jamais d'état métier). */
export function ModeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<DisplayMode>('simple');

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored === 'simple' || stored === 'expert') setModeState(stored);
    } catch {
      // Stockage indisponible : le mode simple reste actif.
    }
  }, []);

  const setMode = useCallback((next: DisplayMode) => {
    setModeState(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Sans stockage, le choix ne vaut que pour la page courante.
    }
  }, []);

  const value = useMemo(() => ({ mode, setMode }), [mode, setMode]);
  return <ModeContext.Provider value={value}>{children}</ModeContext.Provider>;
}

export function useMode(): ModeValue {
  return useContext(ModeContext);
}
