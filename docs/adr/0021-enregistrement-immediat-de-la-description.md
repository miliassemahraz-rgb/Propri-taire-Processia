# 0021. Enregistrement immédiat du texte partagé avant « Analyser »

- Statut : acceptée
- Date : 2026-11-27
- Références : spécification 5.2, ADR 0020, WP-10, WP-11, WP-13, [PO-114]

## Contexte

« Analyser » fige la description depuis `yjs_documents` (`SourcesService.freezeDescription`). Le serveur de coédition regroupe les écritures dans cette table (2 s, au plus 10 s). Un consultant qui saisit puis clique aussitôt sur « Analyser » obtiendrait donc un texte périmé, ou une « description vide » sur un premier texte. Constaté en E2E.

## Décision

Message sans état du document `workspace` : le client envoie `{ type: 'workspace.flush', id }` ; le serveur ouvre une connexion directe sur le document et y exécute une transaction vide, ce qui déclenche l'écriture immédiate (`storeDocumentHooks(…, immediately)`), puis répond `{ type: 'workspace.flushed', id }` sur la même connexion. Les mises à jour Yjs envoyées avant le message sont appliquées avant lui (WebSocket ordonné). Côté web, `useCollab().flushWorkspace()` attend l'accusé 4 s au plus (puis poursuit) ; la page Analyse l'appelle avant `POST /analysis/extractions` sans `sourceId`. Les deux types sont décrits dans `@processia/contracts/collab`. Le message est sans effet sur un autre document que `workspace` et n'exige aucun droit particulier (il n'écrit rien de nouveau).

## Alternatives écartées

- Envoyer le texte dans la requête « Analyser » : le texte de l'éditeur est un fragment Yjs, la source de vérité doit rester le document partagé.
- Réduire le regroupement à quelques centaines de millisecondes : charge d'écriture inutile pour tous les cas autres que « Analyser ».
- Imposer une attente de 10 s : mauvaise expérience.

## Conséquences

Un test d'intégration (`collab.int.test.ts`, test 6) vérifie, avec un regroupement de 60 s, que le texte est en base à l'accusé. Les futurs écrans qui lisent `yjs_documents` depuis l'API (brouillons, notes) peuvent réutiliser ce message.
