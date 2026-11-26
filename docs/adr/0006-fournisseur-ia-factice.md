# 0006. Fournisseur IA factice déterministe

- Statut : acceptée (provisoire, révisable)
- Date : 2026-11-26
- Références : spec 0.3 (principe 5), 4.2 ; [HORS-CDC] ; [PO-12], [PO-13]

## Contexte

Les tests, le développement local et la CI ne doivent ni coûter de l'argent ni dépendre d'un service externe ou d'une clé. Les résultats de test doivent être reproductibles.

## Décision

La couche IA (`packages/ai`) définit une interface fournisseur avec deux implémentations : `FakeProvider` (par défaut, `AI_PROVIDER=fake`) et `AnthropicProvider` (appelé seulement si une clé est configurée). Le fournisseur factice répond par enregistrement exact (empreinte sha256 de la requête), puis par scénario scripté, puis par un repli générique. Toute sortie est validée par le même schéma zod que celle du vrai fournisseur. Un mode d'enregistrement rejoue des réponses réelles sans coût. Aucun identifiant de modèle n'est écrit dans le code : il vient de la configuration.

## Alternatives écartées

- Appels réels en CI : coût, instabilité et dépendance à une clé.
- Mocks ad hoc dans chaque test : sorties non réalistes et non validées.

## Conséquences

- La CI prouve le logiciel, pas la qualité d'analyse de l'IA ; l'acceptation formelle exige une exécution réelle (`acceptance:live`) [PO-13].
- Les scénarios du pilote vivent dans `packages/test-fixtures`.
- `.env.example` fixe `AI_PROVIDER=fake`.
