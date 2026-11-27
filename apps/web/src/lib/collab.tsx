'use client';

import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  MODEL_ELEMENTS_MAP,
  MODEL_META_MAP,
  modelDocName,
  workspaceDocName,
  type CollabStatelessMessage,
  type CollabTokenResponse,
} from '@processia/contracts';
import { BusinessModelSchema, type BusinessModel } from '@processia/model';
import { endpoints } from './endpoints';

/** `unavailable` : le profil n'a pas accès à la coédition (validateur) ou l'accès a été retiré. */
export type CollabStatus = 'connecting' | 'connected' | 'disconnected' | 'unavailable';

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
  /** Vue consultée (clé de navigation), pour « en train de… » (spécification 5.1). */
  view?: string;
}

interface CollabValue {
  status: CollabStatus;
  /** Le compte peut écrire dans le texte partagé (droit côté serveur et membre de la mission). */
  canEdit: boolean;
  model: HocuspocusProvider | null;
  workspace: HocuspocusProvider | null;
  self: PresenceUser;
}

const CollabContext = createContext<CollabValue | null>(null);

/** Couleurs d'avatar : texte blanc, contraste AA sur chacune. */
const AVATAR_COLORS = ['#1f4fbf', '#0b6b3a', '#8a2b0d', '#6b2fa0', '#7a5200'] as const;

export function colorFor(id: string): string {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0];
}

export function useCollab(): CollabValue {
  const value = useContext(CollabContext);
  if (value === null) throw new Error('useCollab doit être appelé sous CollabProvider.');
  return value;
}

interface Props {
  missionId: string;
  /** `null` : lecture seule dans l'interface (non-membre, voir PO-30). */
  myRole: 'manager' | 'consultant' | 'validator' | null;
  user: { id: string; displayName: string };
  children: ReactNode;
}

/**
 * Connexion de la mission au serveur de coédition : un WebSocket partagé, deux documents
 * (`model` en lecture seule, `workspace`). Le jeton (10 min) est redemandé à l'API à chaque
 * reconnexion. Le validateur n'utilise pas Yjs : aucune connexion n'est tentée.
 */
export function CollabProvider({ missionId, myRole, user, children }: Props) {
  const [status, setStatus] = useState<CollabStatus>(
    myRole === 'validator' ? 'unavailable' : 'connecting',
  );
  const [canEdit, setCanEdit] = useState(false);
  const [providers, setProviders] = useState<{
    model: HocuspocusProvider;
    workspace: HocuspocusProvider;
  } | null>(null);
  const self = useMemo<PresenceUser>(
    () => ({ id: user.id, name: user.displayName, color: colorFor(user.id) }),
    [user.id, user.displayName],
  );

  useEffect(() => {
    if (myRole === 'validator') {
      setStatus('unavailable');
      return;
    }
    let cancelled = false;
    let socket: HocuspocusProviderWebsocket | null = null;
    let model: HocuspocusProvider | null = null;
    let workspace: HocuspocusProvider | null = null;
    setStatus('connecting');

    void (async () => {
      let cached: CollabTokenResponse;
      try {
        cached = await endpoints.collabToken(missionId);
      } catch {
        if (!cancelled) setStatus('unavailable');
        return;
      }
      if (cancelled) return;
      const token = async (): Promise<string> => {
        if (Date.parse(cached.expiresAt) - Date.now() < 30_000) {
          cached = await endpoints.collabToken(missionId);
        }
        return cached.token;
      };
      setCanEdit(cached.canEdit && myRole !== null);

      socket = new HocuspocusProviderWebsocket({ url: cached.url });
      const denied = (): void => setStatus('unavailable');
      model = new HocuspocusProvider({
        websocketProvider: socket,
        name: modelDocName(missionId),
        token,
        onAuthenticationFailed: denied,
      });
      workspace = new HocuspocusProvider({
        websocketProvider: socket,
        name: workspaceDocName(missionId),
        token,
        onAuthenticationFailed: denied,
      });
      socket.on('status', ({ status: s }: { status: string }) => {
        setStatus((previous) => {
          if (previous === 'unavailable') return previous;
          return s === 'connected'
            ? 'connected'
            : s === 'connecting'
              ? 'connecting'
              : 'disconnected';
        });
      });
      model.attach();
      workspace.attach();
      setProviders({ model, workspace });
    })();

    return () => {
      cancelled = true;
      model?.destroy();
      workspace?.destroy();
      socket?.destroy();
      setProviders(null);
    };
  }, [missionId, myRole]);

  // Présence : identité publiée sur le document `workspace` (awareness, non persistée).
  useEffect(() => {
    providers?.workspace.setAwarenessField('user', self);
  }, [providers, self]);

  const value = useMemo<CollabValue>(
    () => ({
      status,
      canEdit,
      model: providers?.model ?? null,
      workspace: providers?.workspace ?? null,
      self,
    }),
    [status, canEdit, providers, self],
  );
  return <CollabContext.Provider value={value}>{children}</CollabContext.Provider>;
}

/** Lit la `Y.Map` du document `model` sous forme de `BusinessModel` ; `null` tant qu'il n'y a aucune version. */
export function useMissionModel(): BusinessModel | null {
  const { model } = useCollab();
  const [value, setValue] = useState<BusinessModel | null>(null);
  useEffect(() => {
    if (model === null) {
      setValue(null);
      return;
    }
    const doc = model.document;
    const elements = doc.getMap<unknown>(MODEL_ELEMENTS_MAP);
    const meta = doc.getMap<unknown>(MODEL_META_MAP);
    const read = (): void => {
      const version = meta.get('version');
      if (typeof version !== 'number' || version < 1) {
        setValue(null);
        return;
      }
      const parsed = BusinessModelSchema.safeParse({
        schemaVersion: meta.get('schemaVersion'),
        missionId: meta.get('missionId'),
        version,
        elements: Object.fromEntries(elements.entries()),
        rejectedHypotheses: meta.get('rejectedHypotheses') ?? [],
        layout: meta.get('layout') ?? {},
      });
      setValue(parsed.success ? parsed.data : null);
    };
    read();
    doc.on('update', read);
    return () => doc.off('update', read);
  }, [model]);
  return value;
}

/** Messages sans état du document `model` : `model.version`, `run.progress`, etc. */
export function useMissionEvents(handler: (message: CollabStatelessMessage) => void): void {
  const { model } = useCollab();
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    if (model === null) return;
    const listener = ({ payload }: { payload: string }): void => {
      try {
        latest.current(JSON.parse(payload) as CollabStatelessMessage);
      } catch {
        // Message illisible : ignoré.
      }
    };
    model.on('stateless', listener);
    return () => {
      model.off('stateless', listener);
    };
  }, [model]);
}

/** Utilisateurs connectés au document `workspace`, un par compte (plusieurs onglets = une entrée). */
export function usePresence(): PresenceUser[] {
  const { workspace } = useCollab();
  const [users, setUsers] = useState<PresenceUser[]>([]);
  useEffect(() => {
    const awareness = workspace?.awareness;
    if (awareness === null || awareness === undefined) {
      setUsers([]);
      return;
    }
    const read = (): void => {
      const byId = new Map<string, PresenceUser>();
      for (const state of awareness.getStates().values()) {
        const u = (state as { user?: Partial<PresenceUser> }).user;
        if (typeof u?.id === 'string' && typeof u.name === 'string' && !byId.has(u.id)) {
          byId.set(u.id, {
            id: u.id,
            name: u.name,
            color: typeof u.color === 'string' ? u.color : colorFor(u.id),
            ...(typeof u.view === 'string' ? { view: u.view } : {}),
          });
        }
      }
      setUsers([...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'fr')));
    };
    read();
    awareness.on('change', read);
    return () => awareness.off('change', read);
  }, [workspace]);
  return users;
}
