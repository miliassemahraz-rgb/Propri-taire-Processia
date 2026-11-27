/**
 * Les parcours E2E tournent contre la base de test (`processia_test`), jamais contre la base de
 * développement : l'API, le serveur de coédition, le worker et l'aide `dev:totp` la visent.
 */
export const testDbEnv = {
  DATABASE_URL: 'postgres://processia:processia@localhost:5432/processia_test',
  DATABASE_OWNER_URL: 'postgres://processia_owner:processia_owner@localhost:5432/processia_test',
  DATABASE_APP_URL: 'postgres://processia_app:processia_app@localhost:5432/processia_test',
};
