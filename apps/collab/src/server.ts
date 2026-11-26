import { Server } from '@hocuspocus/server';

export interface CollabOptions {
  port: number;
  address?: string;
  quiet?: boolean;
}

/**
 * Serveur de coédition minimal : aucune authentification ni persistance à WP-01.
 * L'authentification par jeton court (JWT) et la persistance dans `yjs_documents`
 * sont ajoutées par WP-10 via les extensions Hocuspocus.
 */
export function createCollabServer({ port, address = '0.0.0.0', quiet = false }: CollabOptions) {
  return new Server({
    name: 'processia-collab',
    port,
    address,
    quiet,
    stopOnSignals: false,
  });
}
