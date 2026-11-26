-- Extensions et fonctions utilisées par le schéma. Exécuté par processia_owner.
CREATE EXTENSION IF NOT EXISTS citext;
--> statement-breakpoint
-- uuid v7 (horodaté, triable) ; PostgreSQL 17 ne fournit pas encore uuidv7().
CREATE OR REPLACE FUNCTION uuid_v7() RETURNS uuid AS $$
  SELECT encode(
    set_bit(
      set_bit(
        overlay(uuid_send(gen_random_uuid())
                placing substring(int8send((extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
                FROM 1 FOR 6),
        52, 1),
      53, 1),
    'hex')::uuid;
$$ LANGUAGE sql VOLATILE;
