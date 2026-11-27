import { Server, type Extension } from '@hocuspocus/server';
import {
  MISSION_EVENTS_CHANNEL,
  MISSION_MESSAGES_CHANNEL,
  modelDocName,
  parseDocName,
  type ModelVersionMessage,
  type RunProgressMessage,
  type WorkspaceFlushedMessage,
} from '@processia/contracts';
import type { Database } from '@processia/db';
import * as Y from 'yjs';
import { authorize, CollabDenied } from './access.js';
import { NotificationListener } from './listener.js';
import { reconcileModelDoc } from './model-sync.js';
import { loadHead, loadState, saveState } from './store.js';

export interface CollabOptions {
  port: number;
  address?: string;
  quiet?: boolean;
  /** Connexion applicative (rôle `processia_app`, soumis à la RLS). */
  db: Database;
  /** Secret HS256 des jetons de coédition (`COLLAB_JWT_SECRET`). */
  jwtSecret: string;
  /** URL pour `LISTEN mission_events` / `mission_messages` ; absente : aucune écoute. */
  listenUrl?: string;
  /** Regroupement des écritures dans `yjs_documents` (spécification 5.2 : 2 s, au plus 10 s). */
  debounceMs?: number;
  maxDebounceMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Serveur de coédition Hocuspocus (ADR 0004, spécification 5) :
 *  - authentification par jeton court, appartenance revérifiée en base à chaque connexion ;
 *  - document `model` : reflet de la tête de version, **écrit par le serveur seul** (les clients
 *    sont en lecture seule) ; document `workspace` : texte de la description, notes, brouillons ;
 *  - persistance dans `yjs_documents` ; `LISTEN mission_events` → différence minimale sur le `Y.Map`
 *    puis message sans état `model.version` ; `mission_messages` (`run.progress`) relayé tel quel.
 */
export function createCollabServer(options: CollabOptions) {
  const { db, jwtSecret } = options;
  const queues = new Map<string, Promise<void>>();
  let listener: NotificationListener | null = null;
  const log = (message: string): void => {
    if (options.quiet !== true) console.warn(message);
  };

  const extension: Extension = {
    extensionName: 'processia',
    async onAuthenticate({ token, documentName, connectionConfig }) {
      try {
        const access = await authorize(db, jwtSecret, token, documentName);
        connectionConfig.readOnly = access.readOnly;
        return { userId: access.userId, userName: access.displayName };
      } catch (error) {
        if (!(error instanceof CollabDenied)) log(`Authentification en échec : ${String(error)}`);
        // Raison volontairement générique : rien sur l'existence de la mission ou du compte.
        throw new Error('permission-denied');
      }
    },
    async onLoadDocument({ document, documentName }) {
      const parsed = parseDocName(documentName);
      if (parsed === null) throw new Error('permission-denied');
      const state = await loadState(db, parsed.missionId, documentName);
      if (state !== null) Y.applyUpdate(document, state);
      if (parsed.kind === 'model') {
        // Le document n'est qu'un cache : il est toujours aligné sur la tête de version.
        const head = await loadHead(db, parsed.missionId);
        reconcileModelDoc(document, head.model, head.meta);
      }
    },
    /** `workspace.flush` : écrit le texte partagé en base tout de suite, puis accuse réception. */
    async onStateless({ connection, documentName, payload }) {
      const parsed = parseDocName(documentName);
      if (parsed?.kind !== 'workspace') return;
      let request: unknown;
      try {
        request = JSON.parse(payload);
      } catch {
        return;
      }
      const { type, id } = (request ?? {}) as { type?: unknown; id?: unknown };
      if (type !== 'workspace.flush' || typeof id !== 'string') return;
      // Une connexion directe qui se ferme déclenche l'écriture immédiate (hors regroupement).
      const direct = await server.hocuspocus.openDirectConnection(documentName, { system: true });
      try {
        await direct.transact(() => undefined);
      } finally {
        await direct.disconnect();
      }
      const reply: WorkspaceFlushedMessage = { type: 'workspace.flushed', id };
      connection.sendStateless(JSON.stringify(reply));
    },
    async onStoreDocument({ document, documentName }) {
      const parsed = parseDocName(documentName);
      if (parsed === null) return;
      await saveState(db, parsed.missionId, documentName, Y.encodeStateAsUpdate(document));
    },
  };

  const server = new Server({
    name: 'processia-collab',
    port: options.port,
    address: options.address ?? '0.0.0.0',
    quiet: options.quiet ?? false,
    stopOnSignals: false,
    debounce: options.debounceMs ?? 2000,
    maxDebounce: options.maxDebounceMs ?? 10_000,
    extensions: [extension],
  });
  const hocuspocus = server.hocuspocus;

  const isLoaded = (name: string): boolean =>
    hocuspocus.documents.has(name) || hocuspocus.loadingDocuments.has(name);

  /** Sérialise les traitements d'une même mission (les notifications arrivent dans l'ordre). */
  function enqueue(missionId: string, task: () => Promise<void>): void {
    const previous = queues.get(missionId) ?? Promise.resolve();
    const next = previous
      .then(task)
      .catch((error: unknown) => log(`Synchronisation du modèle en échec : ${String(error)}`))
      .finally(() => {
        if (queues.get(missionId) === next) queues.delete(missionId);
      });
    queues.set(missionId, next);
  }

  /** Aligne le `Y.Map` sur la tête de version (si le document est ouvert) et diffuse `model.version`. */
  async function syncModel(missionId: string): Promise<void> {
    const name = modelDocName(missionId);
    // Document non ouvert : personne à prévenir, il sera reconstruit à la prochaine ouverture.
    if (!isLoaded(name)) return;
    const head = await loadHead(db, missionId);
    const connection = await hocuspocus.openDirectConnection(name, { system: true });
    try {
      let changed = false;
      await connection.transact((document) => {
        changed = reconcileModelDoc(document, head.model, head.meta, head.diff).changed;
      });
      if (changed && head.model !== null) {
        const message: ModelVersionMessage = {
          type: 'model.version',
          missionId,
          version: head.model.version,
        };
        connection.document?.broadcastStateless(JSON.stringify(message));
      }
    } finally {
      await connection.disconnect();
    }
  }

  function relayProgress(message: RunProgressMessage): void {
    hocuspocus.documents
      .get(modelDocName(message.missionId))
      ?.broadcastStateless(JSON.stringify(message));
  }

  function handleNotification(channel: string, payload: string): void {
    let data: unknown;
    try {
      data = JSON.parse(payload);
    } catch {
      return;
    }
    if (typeof data !== 'object' || data === null) return;
    const record = data as Record<string, unknown>;
    const missionId = record['missionId'];
    if (typeof missionId !== 'string' || !UUID.test(missionId)) return;
    if (channel === MISSION_EVENTS_CHANNEL) {
      enqueue(missionId.toLowerCase(), () => syncModel(missionId.toLowerCase()));
    } else if (channel === MISSION_MESSAGES_CHANNEL && record['type'] === 'run.progress') {
      relayProgress(data as RunProgressMessage);
    }
  }

  /** Après une coupure de `LISTEN`, des versions ont pu être manquées : resynchroniser les documents ouverts. */
  function resyncAll(): void {
    for (const name of hocuspocus.documents.keys()) {
      const parsed = parseDocName(name);
      if (parsed?.kind === 'model') enqueue(parsed.missionId, () => syncModel(parsed.missionId));
    }
  }

  return {
    hocuspocus,
    get httpURL(): string {
      return server.httpURL;
    },
    async listen(): Promise<void> {
      await server.listen();
      if (options.listenUrl !== undefined) {
        listener = new NotificationListener(
          options.listenUrl,
          [MISSION_EVENTS_CHANNEL, MISSION_MESSAGES_CHANNEL],
          handleNotification,
          resyncAll,
          log,
        );
        await listener.start();
      }
    },
    async destroy(): Promise<void> {
      await listener?.stop();
      await Promise.allSettled([...queues.values()]);
      await server.destroy();
    },
  };
}

export type CollabServer = ReturnType<typeof createCollabServer>;
