# 0011. Rôles PostgreSQL, politiques RLS et exécution des migrations

- Statut : acceptée
- Date : 2026-11-26
- Références : spécification 3.1 à 3.3, ADR 0003, [PO-22], WP-04

## Contexte

L'ADR 0003 pose le principe (rôle non propriétaire, RLS forcée, `SET LOCAL app.mission_id`). WP-04 doit fixer les détails : qui crée les rôles, comment s'appliquent les migrations, comment la RLS tient compte de [PO-22] (administrateur et responsables voient toutes les missions) et des `ai_calls` sans mission.

## Décision

- **Trois connexions.** `DATABASE_URL` reste le compte d'administration du cluster (superutilisateur en développement). `DATABASE_OWNER_URL` désigne `processia_owner` (migrations), `DATABASE_APP_URL` désigne `processia_app` (application). Hors production, à défaut, les deux URL se déduisent de `DATABASE_URL` (identifiants `processia_owner` / `processia_app`) ; en production elles sont obligatoires.
- **Amorçage** (`bootstrapRoles`, avec le compte d'administration, sous verrou consultatif) : crée ou met à jour les deux rôles (`LOGIN NOSUPERUSER NOBYPASSRLS`), leur mot de passe vient de leur URL, `processia_owner` reçoit `CREATE` sur la base et la propriété du schéma `public`. Puis les migrations Drizzle (`migrations/`, SQL versionné) s'appliquent avec `processia_owner`, donc propriétaire des tables.
- **Migrations** : 0000 (extension `citext`, fonction `uuid_v7()`, PostgreSQL 17 n'a pas `uuidv7()`), 0001 (tables, générée par drizzle-kit), 0002 (contraintes CHECK des énumérations, RLS, droits, écrite à la main). Un changement de schéma = nouvelle migration générée par `pnpm --filter @processia/db db:generate`.
- **Politique RLS** unique par table cloisonnée : `USING` et `WITH CHECK` sur `mission_id = app_mission_id()`, où `app_mission_id()` lit `app.mission_id` (vide ou absent donne `NULL`, donc aucune ligne). `FORCE ROW LEVEL SECURITY` : le propriétaire y est soumis aussi.
- **[PO-22]** : la politique ne dépend pas du rôle de l'utilisateur. Elle isole des **missions**, pas des personnes. Qui peut ouvrir quelle mission (administrateur et responsables : toutes ; consultant : ses affectations ; validateur : la sienne) est décidé par `MissionGuard` et `@processia/policy` avant l'appel de `withMission()`. Les tables `missions` et `mission_members` ne sont pas cloisonnées : l'application les filtre.
- **`ai_calls`** : la colonne `mission_id` est facultative. Les lignes sans mission ne sont visibles et insérables que si `app.ai_unscoped = 'on'` (`withoutMission(db, fn, { aiUnscoped: true })`), jamais par défaut.
- **`audit_log`** : `processia_app` n'a que `SELECT` et `INSERT`.
- **Contrôle de non-oubli** : un test compare la liste `MISSION_SCOPED_TABLES` avec les tables qui ont `FORCE ROW LEVEL SECURITY` et celles qui portent une colonne `mission_id` : une nouvelle table cloisonnée sans politique fait échouer le test.

## Alternatives écartées

- Politique différente par rôle global dans la base : demanderait de transmettre l'identité de l'utilisateur à chaque transaction et dupliquerait `@processia/policy`.
- Migrations avec le compte d'administration : les tables appartiendraient à un superutilisateur qui contourne la RLS, ce qui masquerait les erreurs de politique.
- `ai_calls` sans mission lisible sans contexte : contredit « sans contexte, aucune ligne ».

## Conséquences

- Toute nouvelle table cloisonnée : colonne `mission_id`, politique dans une migration, ajout à `MISSION_SCOPED_TABLES`.
- Les clés étrangères entre tables ne vérifient pas que `mission_id` coïncide entre parent et enfant (les contrôles de référence contournent la RLS) ; `model_version_elements` a une clé composite. Les dépôts doivent toujours écrire dans le contexte de la mission courante.
- `apps/api` devra passer à `DATABASE_APP_URL` pour ses requêtes métier (WP-05).
