# 0013. Couche IA : exécuteur, journal et budget

- Statut : acceptée
- Date : 2026-11-26
- Références : spec 4.1 à 4.4, WP-09 ; [PO-12], [PO-23], [PO-60] à [PO-62] ; ADR 0006

## Contexte

`packages/ai` ne connaît ni la base ni Nest. L'exécuteur doit journaliser et vérifier le budget, et `ai_calls` est protégée par la RLS (lignes d'une mission visibles sous son contexte, lignes sans mission sous `aiUnscoped`).

## Décision

- `runPipeline` reçoit des ports : `AiJournal` (écriture) et `BudgetPort` (dépense du mois). `apps/api` les implémente (`AiCallsService`) ; le paquet reste testable sans service externe.
- Un appel de pipeline produit **une ligne** `ai_calls` (reprise de réparation incluse : jetons additionnés, nombre de tentatives dans `response`), succès comme échec. Un appel bloqué par le budget n'est pas journalisé (aucun appel n'a eu lieu).
- Le modèle est résolu par l'exécuteur : `models[pipeline]`, sinon `models.default`, sinon erreur de configuration (sauf fournisseur factice). Il est transmis au fournisseur dans `StructuredRequest.model`.
- Adaptateur Anthropic : `messages.create` (ou flux au-delà de 16 000 jetons) avec `output_config.format` produit par `zodOutputFormat`, puis `JSON.parse` et validation zod faites par l'adaptateur, pour distinguer erreur de forme (`AiInvalidOutputError`, réparable) et erreur de transport. `max_tokens` : reprise à plafond doublé, puis `AiMaxTokensError`. Le repli serveur bêta n'est pas activé (voir WP-09, écarts).
- Dépense mensuelle d'un client : somme du mois civil UTC des `cost_estimate_eur`, calculée mission par mission (chaque mission dans son contexte RLS), plus les appels hors mission. Sans migration ni fonction `SECURITY DEFINER`.
- Garde-fou : l'adaptateur refuse de se construire sans `baseURL` si `CI` est définie sans `AI_LIVE=1`.

## Alternatives écartées

- Une ligne `ai_calls` par tentative : lien `ai_call_id` des versions plus ambigu ; non nécessaire.
- Fonction SQL `SECURITY DEFINER` pour la somme : contourne la RLS et impose une migration partagée avec les WP parallèles.

## Conséquences

- Le calcul de la dépense coûte une requête par mission du client à chaque appel : à remplacer par un cumul mensuel si le nombre de missions croît.
- `AI_PRICE_TABLE` doit être renseignée pour que le plafond soit fidèle [PO-61].
