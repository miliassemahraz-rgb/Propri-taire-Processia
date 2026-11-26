# 0008. Sessions côté serveur, double authentification TOTP

- Statut : acceptée (provisoire, révisable)
- Date : 2026-11-26
- Références : spec 3.4 ; [HORS-CDC] ; [PO-3], [PO-4]

## Contexte

Le CDC 9.2 demande une authentification forte. Le SSO des collaborateurs est reporté [PO-3]. Les données de mission sont confidentielles.

## Décision

- Comptes créés sur invitation (lien unique, 72 h) ; mot de passe d'au moins 12 caractères, vérifié contre une liste locale de mots de passe compromis, haché en **argon2id**.
- **TOTP** (RFC 6238) obligatoire pour tous les rôles, avec 10 codes de secours à usage unique ; WebAuthn plus tard [PO-4].
- **Sessions côté serveur** en base, cookie `__Host-sid` (HttpOnly, Secure, SameSite=Strict), inactivité de 30 minutes, durée maximale de 12 heures, rotation de l'identifiant, jeton CSRF synchronisé.
- Limitation de débit (`@nestjs/throttler`) et journal d'audit.
- Jeton de coédition : JWT HS256 de 10 minutes, revérifié en base par le serveur collab.
- Table `auth_identities` prévue pour le SSO OIDC/SAML ultérieur. Implémenté en WP-05 ; WP-01 ne fait que réserver les variables de secret.

## Alternatives écartées

- JWT sans état pour les sessions : révocation et expiration d'inactivité plus difficiles.
- SSO dès l'incrément 1 : un WP supplémentaire, reporté [PO-3].

## Conséquences

- Le proxy `/api/*` du même domaine rend possible `SameSite=Strict`.
- Aucune route métier n'est accessible tant que `mfa_verified_at` de la session est vide.
