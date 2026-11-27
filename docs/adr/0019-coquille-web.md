# 0019. Coquille web : rendu côté client, session par cookie, thème dans `packages/ui`

- Statut : acceptée
- Date : 2026-11-27
- Références : spécification 1.1, 3.4, 7 (WP-07) ; ADR 0008, 0010, 0018 ; maquettes [PO-17]

## Contexte

WP-07 pose le squelette de toutes les pages de l'incrément 1. Il faut fixer où se fait le rendu, comment la session et le jeton CSRF sont tenus, où vivent le thème et les composants, et comment les pages sont testées.

## Décision

1. **Mêmes origine et rendu client pour les pages authentifiées.** Le navigateur appelle `/api/*`, relayé par Next vers l'API (`rewrites` de `next.config.ts`) : le cookie `__Host-sid` (`Secure`, `HttpOnly`, `SameSite=Strict`) reste de même origine. Les pages sont des composants serveur minces (métadonnées : titre unique de la forme « Titre · Processia ») qui montent un composant client ; les données sont lues par le client API après la connexion. Aucun cookie de session n'est relu côté serveur Next.
2. **Session.** `SessionProvider` lit `GET /me` au chargement ; le jeton CSRF vit en mémoire (module `lib/api.ts`), est mis à jour par la connexion, la validation du second facteur et `/me`, et rejoué dans `x-csrf-token` sur toute requête non GET. Une garde (`useRequireSession`) renvoie vers `/connexion?next=…`, `/connexion/verification` ou `/connexion/enrolement` selon l'étape à franchir.
3. **Client API typé.** `apps/web/src/lib/api.ts` (`apiRequest(chemin, { schema })`) valide chaque réponse avec les schémas zod de `@processia/contracts` et transforme toute erreur en `ApiRequestError` portant le code stable ; `endpoints.ts` liste un appel par route.
4. **Thème et composants.** `packages/ui` (React Aria Components, ADR 0010) exporte les composants et une feuille `styles.css` (jetons de la charte des maquettes : Inter pour le texte, Space Grotesk pour les titres, cibles d'au moins 44 px, contrastes AA, focus visible). La mise en page propre à l'application est dans `apps/web/src/app/globals.css`. Les polices ne sont pas chargées depuis un service tiers : la pile CSS les nomme et retombe sur la police système.
5. **Mode simple / expert, mode d'affichage** : préférence d'affichage mémorisée dans `localStorage` (commodité par navigateur, jamais d'état métier).
6. **Tests.** Les parcours sont des tests Playwright contre l'API réelle et la base `processia_test` (remise à l'état du seed au démarrage). axe-core vérifie chaque page. Les comptes sont enrôlés par l'interface (clé de saisie manuelle lue sur la page), puis l'aide `dev:totp` fournit les codes des connexions suivantes.
7. **Deux routes d'appui côté API**, nécessaires à l'interface et hors de la liste de WP-06 : `GET /missions/:id/ai-status` (`{ simulated }`, tout membre) pour le bandeau « IA simulée », et `GET /missions/:id/assignable-users` (`mission.assign`) pour que le responsable choisisse qui affecter sans disposer de `users.manage`.

## Alternatives écartées

- Rendu serveur avec relais du cookie : doublerait la logique de session pour des pages qui n'ont aucun contenu public.
- Jeton CSRF en `sessionStorage` : inutile, `/me` le renvoie à chaque chargement.
- Bibliothèque de composants clés en main : voir ADR 0010.

## Conséquences

- Le contenu des pages authentifiées n'est pas rendu côté serveur (pas de gain de SEO à chercher ici).
- Les polices de la charte ne sont pas embarquées : à auto-héberger lors du durcissement (WP-25) si le PO l'exige.
- Les WP d'écrans suivants ajoutent leurs entrées de navigation dans `components/mission-frame.tsx` (sous-navigation de mission) et réutilisent `useMission()`, `endpoints` et `errorMessage`.
