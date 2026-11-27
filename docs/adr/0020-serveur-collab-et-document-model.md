# 0020. Serveur de coédition : jeton, autorisation et document `model`

- Statut : acceptée
- Date : 2026-11-27
- Références : spec 5.1 à 5.4, ADR 0004, [PO-100] à [PO-102], WP-10

## Contexte

ADR 0004 retient Hocuspocus. WP-10 fixe les détails : authentification, droits, forme du document `model`, propagation des versions, intégration web.

## Décision

- **Jeton** : JWT HS256 signé avec `COLLAB_JWT_SECRET` (bibliothèque `jose`), 10 minutes, émetteur `processia-api`, destinataire `processia-collab`, `sub` = compte, `mid` = mission. Délivré par `POST /missions/:id/collab-token` (droit `mission.read_workspace`, donc refusé au validateur). Le jeton n'accorde rien : à **chaque connexion** à un document, le serveur de coédition relit en base le compte (actif), la mission et l'affectation, et recalcule les droits avec `@processia/policy` (`mission.read_workspace` pour entrer ; `model.edit` pour écrire dans `workspace`). Le document `model` est toujours en lecture seule (`connectionConfig.readOnly`). Toute erreur renvoie le même refus générique.
- **Accès à la base** : le serveur de coédition utilise le rôle `processia_app`, sous RLS (`withMission` pour `model_versions` et `yjs_documents`).
- **Document `model`** : `Y.Map` `elements` (id → JSON de l'élément) et `Y.Map` `meta` (`version`, `schemaVersion`, `missionId`, `authorId`, `at`, `rejectedHypotheses`, `layout`) : de quoi reconstituer un `BusinessModel` complet côté client. Version 0 = aucune version. C'est un cache : à chaque ouverture, l'état persisté est appliqué puis aligné sur la tête de `model_versions`.
- **Propagation** : `LISTEN mission_events` ; si le document est ouvert, le serveur charge l'instantané de tête et applique la **différence minimale** via une connexion directe : chemin rapide avec `model_versions.diff` si le document reflète la version précédente, comparaison complète sinon (version manquée, reconnexion de `LISTEN`). Traitement sérialisé par mission. Puis `broadcastStateless({type:'model.version', missionId, version})`. `LISTEN mission_messages` : `run.progress` est relayé tel quel. Les documents fermés ne sont pas touchés.
- **Persistance** : extension maison (et non `extension-database`) : `yjs_documents`, regroupement 2 s, au plus 10 s.
- **Web** : un seul WebSocket partagé pour les deux documents ; `CollabProvider` dans `MissionFrame` ; jeton redemandé par `apiRequest` avant expiration et à chaque reconnexion ; URL du serveur fournie par l'API (`COLLAB_PUBLIC_URL`). Hooks `useMissionModel`, `useMissionEvents`, `usePresence`. Éditeur TipTap 3 avec `Collaboration` sur le fragment `description`, historique local désactivé.
- **Contrats partagés** (`@processia/contracts`) : noms de documents, canaux, types de messages sans état.

## Alternatives écartées

- `@hocuspocus/extension-database` : n'ouvre pas la transaction RLS.
- Écrire dans le `Y.Map` à chaque notification même document fermé : coût inutile, le cache se reconstruit.
- Recopier le diff sans comparer : une notification manquée laisserait le cache faux.

## Conséquences

- Le retrait d'un membre ne coupe pas ses connexions ouvertes avant leur fin ([PO-102]) ; l'identité de présence est publiée par le client (non vérifiée par le serveur).
- Les nouveaux messages sans état (`proposal.updated`, `question.updated`, etc.) s'ajoutent à `CollabStatelessMessage` et au relais de `server.ts`.
- Le serveur de coédition doit joindre PostgreSQL ; `pnpm e2e` le démarre.
