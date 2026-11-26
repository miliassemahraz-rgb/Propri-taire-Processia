# @processia/model

Méta-modèle de Processia : schémas zod, types dérivés, catalogue des capacités du moteur, migrations de schéma, JSON Schema exporté. Le modèle métier JSON est la **source de vérité** ; BPMN et livrables en sont des projections (ADR 0002). Le paquet est pur : pas d'entrée/sortie, pas d'horloge ni d'aléa implicites. Seule dépendance : `zod`.

Spécification : `docs/specs/increment-1.md`, section 2.

## Contenu

| Chemin                          | Rôle                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/schema/*.ts`               | Un fichier par concept (acteur, activité, règle…), plus `element.ts` (union), `business-model.ts`, `change-set.ts` (`ModelOp`, `ChangeSet`), `validation.ts` (`ValidationSubmission`…)                             |
| `src/ids.ts`                    | UUID v7 (`uuidv7(nowMs, random)`), identifiants temporaires `tmp:n`, générateur séquentiel de test                                                                                                                 |
| `src/catalog/`                  | `engine-capabilities.fr.json` (15 capacités, spécification 2.6) et son accès typé                                                                                                                                  |
| `src/migrations/`               | Cadre des migrations (`migrateToCurrent`), version 1 : aucune migration                                                                                                                                            |
| `src/ops/*.ts`                  | Opérations pures du WP-03 : `applyChangeSet`, `transitionStatus`, `diffModels`, `rebase`, `checkCoherence`, `completeness`, `deliverableView`, `raciMatrix`, `applyDecision`, `composeToBe`, graphe de dépendances |
| `src/parse.ts`                  | `parseModel(json)` : migre puis valide, renvoie `{ ok, model }` ou `{ ok: false, errors: [{ path, message }] }`                                                                                                    |
| `src/json-schema.ts`            | Génération du JSON Schema (draft-07)                                                                                                                                                                               |
| `src/testing/`                  | Fabriques (`buildActor()`, `buildActivity()`…), `buildMinimalModel()`, jeux de test partagés                                                                                                                       |
| `schema/business-model.v1.json` | JSON Schema exporté (généré, commité)                                                                                                                                                                              |
| `fixtures/minimal-model.json`   | Modèle valide qui couvre les 16 types d'éléments (généré, commité)                                                                                                                                                 |

## Utiliser

```ts
import { parseModel, ElementSchema, type BusinessModel, type Element } from '@processia/model';

const result = parseModel(JSON.parse(text));
if (!result.ok) {
  for (const { path, message } of result.errors) console.error(path, message);
}
```

`Element` est une union discriminée par `kind` ; chaque type d'élément exporte son schéma (`ActivitySchema`…) et son type (`Activity`).

## Règles portées par le schéma

- `extracted` exige au moins une `SourceRef` ; `hypothesis` exige `provenance.rationale`.
- Une provenance d'origine `ai_knowledge` exige `rationale`.
- Une activité hors `macro` exige `parentId`.
- Une optimisation cite au moins un constat (`findingIds`) ; un constat a au moins une localisation ; un écart a au moins deux côtés.
- Un événement de bordure exige `attachedToId` ; un écart résolu exige `resolution`.
- `automation.capability` est limité aux identifiants du catalogue.
- Tous les objets sont stricts : toute propriété inconnue est refusée. `Rule.decisionTable` est réservé (incrément 2) et refusé.
- Les clés de `elements` sont des UUID v7 et égales à l'`id` de l'élément. Seuls les ChangeSets admettent des ids temporaires `tmp:n`.

## Opérations sur le modèle (WP-03)

Toutes les fonctions sont pures (ni horloge ni aléa implicites : `ApplyOptions` porte `newId`, `at`, `userId`, `actor`, `submissionId`).

```ts
const r = applyChangeSet(model, changeSet, { newId, at, userId: 'u1' });
if (r.ok) save(r.model, r.diff, r.warnings);
else for (const e of r.errors) console.error(e.code, e.message); // REFERENCED_ELEMENT, FORBIDDEN_TRANSITION…
```

- `applyChangeSet` : version de base, `tmp:n` résolus, codes attribués, schéma, intégrité référentielle, statuts. Atomique.
- `transitionStatus(statusActuel | null, cible, contexte)` : matrice de la spécification 2.1.
- `rebase(cs, diffsIntercalés, tête)` : rejoue un ChangeSet ou liste les conflits.
- `checkCoherence`, `completeness`, `deliverableView`, `raciMatrix`.
- Cascade : `applyDecision`, `previewCascade`, `optimisationStates`, `closureBlockers` ; graphe : `topologicalOrder`, `findDependencyCycle`, `detectOptimisationConflicts` ; `composeToBe` / `tryComposeToBe`.
- Tests : `buildCompleteModel()` (complétude 1, aucune alerte), en plus de `buildMinimalModel()`.

Voir `docs/wp/WP-03.md` pour les choix et les écarts.

## Commandes

```bash
pnpm exec vitest run packages/model             # tests du paquet (depuis la racine)
pnpm coverage:model                              # couverture de src/schema (seuil 90 %)
pnpm --filter @processia/model schema:export     # régénère schema/ et fixtures/
```

Relancer `schema:export` après toute modification d'un schéma : des tests comparent les fichiers commités à la sortie du code.

## JSON Schema et zod

zod exprime les règles croisées (`extracted` sans référence, activité sans parent…) par des `refine`, que l'export JSON Schema ne sait pas représenter. `src/json-schema.ts` les ajoute sous forme de `if`/`then`. **Toute règle ajoutée à un schéma zod doit être ajoutée aussi dans `json-schema.ts` et au jeu partagé `src/testing/corpus.ts`** : le test vérifie que zod et ajv donnent le même verdict sur chaque cas. Seul contrôle propre à zod : clé de `elements` = `id` de l'élément.

## Faire évoluer le schéma

Ajouter `src/migrations/vX_to_vY.ts`, l'enregistrer dans `MIGRATIONS`, incrémenter `CURRENT_SCHEMA_VERSION`, mettre à jour `schemaVersion` dans le schéma, régénérer le JSON Schema (`business-model.v(Y).json`).
