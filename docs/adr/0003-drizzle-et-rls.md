# 0003. Drizzle ORM et sécurité au niveau des lignes (RLS) PostgreSQL

- Statut : acceptée (provisoire, révisable)
- Date : 2026-11-26
- Références : spec 3.1, 3.3 ; [HORS-CDC]

## Contexte

Le cloisonnement entre missions (CDC 9.2) doit être imposé dans l'application et dans la base. Le modèle est stocké en JSONB versionné.

## Décision

**PostgreSQL 17** avec **Drizzle ORM** et drizzle-kit (migrations SQL versionnées). L'application se connecte avec un rôle non propriétaire (`processia_app`) ; les migrations utilisent `processia_owner`. Chaque table cloisonnée porte une politique RLS fondée sur `current_setting('app.mission_id')`, avec `FORCE ROW LEVEL SECURITY` ; `withMission` fait un `SET LOCAL app.mission_id` dans une transaction. WP-01 ne fournit que les services (base `processia`, base de test `processia_test`) ; le schéma arrive avec WP-04.

## Alternatives écartées

- Prisma : SQL moins explicite, `SET LOCAL` et RLS moins naturels.
- TypeORM : typage JSONB et migrations moins fiables.
- Cloisonnement par l'application seule : une faille de requête exposerait des données d'autres missions.

## Conséquences

- Sans contexte de mission, une requête ne renvoie aucune ligne ; un test automatique le prouve (WP-04).
- Les dépôts des tables cloisonnées n'acceptent qu'un contexte de mission.
- Les tests d'intégration utilisent la base `processia_test`.
