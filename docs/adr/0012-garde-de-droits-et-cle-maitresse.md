# 0012. Garde de droits unique et chiffrement des clés API par clé maîtresse

- Statut : acceptée
- Date : 2026-11-26
- Références : spécification 3.3, 3.5 et 4.1, [PO-22], [PO-30], [PO-33], WP-06

## Contexte

WP-06 doit appliquer la matrice des droits (3.5) et le cloisonnement des missions (3.3) à chaque route, et stocker la clé API du fournisseur IA de chaque client sans qu'elle soit lisible en base ni renvoyée par l'API.

## Décision

- **Une garde globale `PolicyGuard`** (`APP_GUARD` de `PolicyModule`, qui importe `AuthModule` pour passer après `SessionGuard`) remplace la paire « `@Can` + `MissionGuard` » : elle lit `@Can(action)` et le paramètre `:missionId`.
  - Sans `:missionId` : `can(rôle global, action)`, sinon 403.
  - Avec `:missionId` : lecture de la mission et de l'affectation du demandeur (tables non cloisonnées, sans contexte de mission), 404 si la mission est inexistante ou invisible, 403 si la mission est visible mais le droit refusé, puis pose d'un `MissionContext` (`@CurrentMission()`).
  - `MissionContext.run(fn)` est le seul chemin vers `withMission` pour les contrôleurs : les tables cloisonnées ne s'ouvrent qu'à travers lui.
  - Une route sans `@Can` et sans `:missionId` n'est soumise qu'à `SessionGuard` (liste de ses propres missions, `/me`).
- **`packages/policy`** est pur : `can(sujet, action, ressource?)` lit la constante `MATRIX` (actions x colonnes `admin`, `manager`, `consultant`, `validator`). La colonne est choisie par le rôle global pour les actions globales et par le rôle dans la mission pour les actions de mission ; un responsable de mission global a la colonne `manager` sur toutes les missions (amendement PO-30, la colonne `observer` initiale est supprimée).
- **Clés API** : AES-256-GCM, clé dérivée par HKDF de `MASTER_KEY` avec un contexte (`purpose`) propre aux clés API (le même module sert déjà au secret TOTP, dérivé de `SESSION_SECRET`). Format `v1.<iv>.<tag>.<données>`. L'API ne renvoie que `{ configured, masked }`, où `masked` garde les quatre derniers caractères.

## Alternatives écartées

- Deux gardes séparées (`CanGuard`, `MissionGuard`) : l'ordre d'exécution des `APP_GUARD` entre modules est implicite et un oubli de l'une ouvre une route ; une seule garde garde la décision en un endroit.
- Chiffrement de la clé API avec `SESSION_SECRET` : mélange deux secrets de rotation différente.
- Clé API dans une table séparée ou un coffre externe : disproportionné pour l'incrément 1.

## Conséquences

- Toute route de mission doit s'appeler `/missions/:missionId/...` et porter `@Can(...)` : sans `@Can`, seule la visibilité est vérifiée.
- La rotation de `MASTER_KEY` rend les clés enregistrées illisibles : elles sont à ressaisir (pas de rechiffrement automatique).
- `MASTER_KEY` devient une variable obligatoire (`.env.example`, CI, docker compose).
