-- Exécuté une seule fois, à la première initialisation du volume. La base `processia`
-- est créée par l'image (POSTGRES_DB) ; la base de test sert aux tests d'intégration.
CREATE DATABASE processia_test OWNER processia;
