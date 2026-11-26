/**
 * Identifiants de DÉVELOPPEMENT LOCAL uniquement (jamais de vrai secret). Le seed les pose sur les
 * comptes de démonstration ; `seedDevelopment` refuse de tourner en production.
 * Le hachage argon2id correspond à `DEV_PASSWORD` (un test de `apps/api` le vérifie).
 * Le TOTP n'est pas pré-enrôlé : il s'enrôle à la première connexion (voir docs/dev/RUNBOOK.md).
 */
export const DEV_PASSWORD = 'Processia-dev-2026!';
export const DEV_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$TYDlMv5h+hSDlJQLwjVZQA$v1kif1fIXmE9SFGaii0RTYLLLxBrlv9ucWXfP1GrG20';
