# 0004. Hocuspocus pour la coédition Yjs

- Statut : acceptée (provisoire, révisable)
- Date : 2026-11-26
- Références : spec 1.1, 5 ; [HORS-CDC]

## Contexte

Deux consultants doivent coéditer en même temps (critère d'acceptation). Il faut un serveur Yjs avec authentification, persistance et messages sans état.

## Décision

`apps/collab` est un serveur **Hocuspocus** (licence MIT) sur le protocole Yjs. Il authentifie par un jeton court (JWT HS256, 10 minutes), persiste l'état binaire dans `yjs_documents` et écoute `pg_notify('mission_events')` pour propager les nouvelles versions du modèle. L'éditeur du texte partagé est TipTap avec l'extension Collaboration. WP-01 fournit un serveur minimal sans authentification.

## Alternatives écartées

- `y-websocket` seul : pas d'authentification ni de persistance prêtes à l'emploi.
- Service tiers hébergé : dépendance externe et données client hors du périmètre maîtrisé.
- Édition collaborative maison (OT) : coût disproportionné.

## Conséquences

- Le document `model` n'est qu'un cache reconstructible depuis `model_versions`.
- Pas de verrou bloquant : la présence indique qui prépare une modification.
- Un processus supplémentaire à déployer et à surveiller.
