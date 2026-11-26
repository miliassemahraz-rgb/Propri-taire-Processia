# Processia : spécification technique et plan de réalisation de l'incrément 1 (« Analyse et cartographie »)

Version 1.0 du 26/11/2026. Statut : proposition, à valider par le Product Owner (PO).
Document de référence : `docs/cahier-des-charges.md` (CDC). Les sections du CDC sont citées « CDC x.y ».

Conventions de lecture :
- **[HORS-CDC]** signale un choix technique que le CDC ne fixe pas. Ces choix sont pris ici pour débloquer le développement, restent révisables et sont consignés en ADR.
- **[PO-n]** renvoie à une décision à faire valider par le PO. Elles sont listées en section 8. Tant qu'elle n'est pas validée, la valeur par défaut indiquée s'applique.

---

## 0. Objet, périmètre et principes directeurs

### 0.1 Contenu de l'incrément 1 (CDC 11.2)

L'incrément couvre : le modèle unique ; les entrées texte, dialogue et documents ; les 4 livrables ; le BPMN sur 4 niveaux avec vue simplifiée ; la modification par dialogue ; le diagnostic ; les gains estimés ; la validation de l'AS-IS puis du TO-BE élément par élément ; la matrice gain × effort ; la coédition ; les rôles Processia ; les exports Word, PDF, Excel et BPMN.

**Critère d'acceptation.** À partir de la description du pilote (CDC 8), l'outil produit les 4 livrables et la cartographie des 14 processus. Deux consultants coéditent en même temps. Un validateur de test valide l'AS-IS, puis accepte et refuse des optimisations, refus en cascade compris. Le BPMN exporté s'ouvre dans un autre outil de modélisation.

### 0.2 Hors périmètre de l'incrément 1

Ces éléments ne sont pas réalisés, mais la conception ne doit pas les bloquer :

| Élément | Incrément | Préparation dans l'incrément 1 |
| --- | --- | --- |
| Traduction des règles en tables de décision exécutables | 2 | Les règles sont stockées en texte structuré `si / alors / sinon` (CDC 3.7) avec une portée explicite. Le champ `decisionTable` est réservé dans le schéma. |
| Moteur, écrans, workflows, paquet | 2 | Le TO-BE est une instance du **même type** `BusinessModel` que l'AS-IS. Les champs dont le moteur aura besoin sont déjà présents et facultatifs : champs typés, cycle de vie des objets, mode d'exécution des activités, rôles. |
| Audio, journaux d'événements, process mining, simulation | 4 | Les valeurs `interview` et `system_log` existent dans l'énumération des origines. Le service Python n'est pas déployé. |
| Réutilisation des missions passées (origine `past_mission`) | 4 | La valeur d'énumération existe ; rien ne la produit encore. |
| Export PowerPoint | 4 | Le moteur d'exports est extensible par format. |
| SSO SAML / OIDC des collaborateurs | à fixer [PO-3] | Une table `auth_identities` est prévue pour accueillir plusieurs fournisseurs d'identité. |
| Purge automatique en fin de conservation | 2 (proposé) | Le champ `retention_until` est stocké par mission, avec une purge manuelle par l'administrateur. |

**Service Python (pm4py, SimPy) : non requis à l'incrément 1.** Rien dans l'incrément ne fait de process mining ni de simulation. Les calculs de gains sont de l'arithmétique simple, faite en TypeScript. Le service sera introduit à l'incrément 4.

### 0.3 Principes directeurs

1. **Le modèle métier est l'unique source de vérité** (CDC 3.3). Le BPMN, les livrables et les exports en sont des projections déterministes.
2. **Aucune sortie de l'IA ne modifie le modèle sans décision humaine.** Une sortie de l'IA arrive sous l'une de deux formes :
   - des éléments au statut `extracted` (avec citation vérifiée) ou `hypothesis` ;
   - une proposition de modification (ChangeSet) affichée en aperçu, que le consultant applique explicitement (CDC 4.2).
3. **Tout est versionné.** Chaque changement du modèle crée une version immuable. Le retour arrière crée une nouvelle version : l'historique n'est jamais réécrit.
4. **Le cloisonnement entre missions est imposé à deux niveaux** : dans l'application et dans la base, par la sécurité au niveau des lignes de PostgreSQL (RLS).
5. **L'IA est fournie par un fournisseur interchangeable.** Un fournisseur factice déterministe sert aux tests et au développement local. L'adaptateur Anthropic n'est appelé que si une clé est configurée.
6. **Interface en français, textes externalisés, conformité RGAA** dès le premier écran. Le dépôt reste l'unique mémoire entre les sessions de développement.

### 0.4 Glossaire FR ↔ code

Le code (identifiants, valeurs d'énumération) est en anglais. Toute l'interface est en français, via i18n **[HORS-CDC]**.

| Français (CDC) | Code |
| --- | --- |
| Modèle métier | `BusinessModel` |
| Élément | `Element` |
| Extrait / Hypothèse / Confirmé / Validé | `extracted` / `hypothesis` / `confirmed` / `validated` |
| Source | `Source` (référencée par `SourceRef`) |
| Métier : caractéristique, glossaire | `business_trait`, `glossary_term` |
| Acteur | `actor` |
| Macroprocessus, processus, tâche, étape (procédure) | `activity` avec `level` = `macro` / `process` / `task` / `step` |
| Événement, passerelle (point de décision), enchaînement | `event`, `gateway`, `sequence_flow` |
| Lien entre macroprocessus | `process_link` |
| Objet de données, document, formulaire ; outil | `data_object` ; `tool` |
| Flux d'information | `information_flow` |
| Règle | `rule` |
| Indicateur | `indicator` |
| Écart entre sources | `discrepancy` |
| Constat (diagnostic) | `finding` |
| Optimisation | `optimisation` |
| Proposition de modification | `ChangeProposal` / `ChangeSet` |
| Soumission au validateur | `ValidationSubmission` |
| Dossier d'analyse | `analysis_dossier` |

---

## 1. Architecture de l'incrément 1

### 1.1 Vue d'ensemble

```
 Navigateur (consultants, responsable de mission, administrateur, validateur)
   │  HTTPS (cookie de session)          │  WebSocket (Yjs, jeton court)
   ▼                                     ▼
┌────────────────────┐   /api/* proxy   ┌──────────────────┐
│ apps/web (Next.js) │ ───────────────► │ apps/api (NestJS) │──► PostgreSQL 17 (données, versions, RLS,
│ UI, i18n, bpmn-js  │                  │ REST + gardes RBAC │     file pg-boss, LISTEN/NOTIFY)
└────────────────────┘                  └───────┬──────────┘──► Stockage S3 (MinIO en local)
          │ WebSocket                           │ jobs (pg-boss)
          ▼                                     ▼
┌──────────────────────┐  LISTEN/NOTIFY  ┌───────────────────────────────┐
│ apps/collab          │ ◄────────────── │ apps/api, point d'entrée worker │──► Fournisseur IA
│ (Hocuspocus / Yjs)   │                 │ pipelines IA, extraction de    │    (factice ou Anthropic)
└──────────────────────┘                 │ documents, exports, rendu PDF  │──► SMTP (Mailpit en local)
                                         └───────────────────────────────┘
```

Rôle de chaque processus :

- **apps/web** : Next.js (App Router), React. Il ne contient pas de logique métier. Il appelle l'API par un proxy sur le même domaine (`/api/*`), ce qui permet un cookie `SameSite=Strict`.
- **apps/api** : NestJS, avec deux points d'entrée.
  - `main.ts` sert le HTTP.
  - `worker.ts` exécute les tâches asynchrones : pipelines IA, extraction de documents, exports.

  Les deux partagent les mêmes modules Nest. Ce choix évite une troisième base de code **[HORS-CDC]**.
- **apps/collab** : serveur Yjs fondé sur **Hocuspocus** (MIT), qui gère l'authentification, la persistance et les messages sans état **[HORS-CDC]**. Il écoute `pg_notify('mission_events')` pour propager les nouvelles versions du modèle.
- **File de tâches : pg-boss**, adossée à PostgreSQL. Il n'y a pas de Redis, ce qui sert le budget **[HORS-CDC]**.
- **Stockage S3** : fichiers sources et exports produits. Les buckets sont privés et l'accès passe par des URL présignées à durée courte (5 minutes).

### 1.2 Organisation du monorepo

Outils : pnpm (workspaces) et Turborepo, TypeScript `strict`, Node.js 24 LTS **[HORS-CDC]**. Les versions exactes des dépendances sont figées dans WP-01.

```
processia/
├─ CLAUDE.md                     # consignes pour les agents de développement (voir 1.5)
├─ docker-compose.yml            # postgres, minio, mailpit (+ profil "apps")
├─ .github/workflows/ci.yml
├─ apps/
│  ├─ web/                       # Next.js
│  ├─ api/                       # NestJS (main.ts HTTP, worker.ts tâches)
│  └─ collab/                    # Hocuspocus
├─ packages/
│  ├─ config/                    # tsconfig, eslint, prettier, env (zod)
│  ├─ model/                     # MÉTA-MODÈLE : schémas zod, types, opérations, cohérence,
│  │                             # complétude, vues filtrées, migrations de schéma. Pur, sans E/S.
│  ├─ policy/                    # matrice des droits CDC 2.4 (fonctions pures)
│  ├─ contracts/                 # schémas zod des requêtes et réponses REST + événements temps réel
│  ├─ db/                        # Drizzle : schéma, migrations, RLS, seed
│  ├─ ai/                        # interface fournisseur, fournisseur factice, adaptateur Anthropic,
│  │                             # exécuteur de pipelines, prompts, schémas de sortie
│  ├─ ingest/                    # extraction de texte : PDF, DOCX, XLSX, images ; découpage avec localisateurs
│  ├─ bpmn/                      # modèle → BPMN 2.0 sur 4 niveaux (bpmn-moddle) + mise en page (elkjs)
│  ├─ diagnostic/                # détecteurs déterministes, calcul des gains, catalogue de ratios
│  ├─ exports/                   # DOCX (docx), XLSX (exceljs), gabarits HTML pour le PDF, ZIP BPMN
│  ├─ i18n/                      # messages/fr.json (+ type des clés)
│  ├─ ui/                        # composants accessibles (React Aria Components)
│  └─ test-fixtures/             # description du pilote, scénarios du fournisseur factice, modèles de test
├─ e2e/                          # Playwright (parcours, axe-core, coédition)
└─ docs/                         # voir 1.5
```

Les dépendances entre paquets sont strictement descendantes. Elles sont vérifiées par `eslint-plugin-boundaries` ou `dependency-cruiser` dans WP-01 :

- `model` ne dépend de rien, sauf de zod et uuid.
- `bpmn`, `diagnostic`, `exports` et `ai` dépendent de `model`.
- `api` dépend de tous les paquets. `web` dépend de `contracts`, `model` (types et vues), `ui` et `i18n`. Le paquet `ai` n'est jamais importé côté navigateur.

**`packages/model` est le contrat avec l'incrément 2.** Le moteur importera ce même paquet. Toute évolution du schéma s'accompagne d'une migration de données (`migrations/vX_to_vY.ts`) qui s'applique aux instantanés stockés.

### 1.3 Modules NestJS (apps/api)

| Module | Responsabilités |
| --- | --- |
| `AuthModule` | Mots de passe, double authentification TOTP, sessions, invitations, limitation de débit |
| `UsersModule`, `ClientsModule` | Comptes, organisations clientes, configuration IA par client |
| `MissionsModule` | Missions, affectations, phase, tableau de suivi |
| `PolicyModule` | Gardes (`@Can(action)`), contexte de mission (`MissionContext`) et activation de la RLS |
| `ModelModule` | Versions, tête de version, application des ChangeSet, rebasage, historique, retour arrière, signalements après validation |
| `SourcesModule` | Dépôt, stockage S3, extraction de texte, morceaux (chunks) |
| `AnalysisModule` | Lancements d'extraction, questions, hypothèses, écarts, complétude |
| `DialogueModule` | Fil de dialogue, propositions de modification (`model.edit`) |
| `CartographyModule` | Production et cache des BPMN par version, rendus SVG |
| `TransformationModule` | Constats, optimisations, gains, matrice, recomposition du TO-BE |
| `ValidationModule` | Soumissions, décisions, cascade, portail validateur |
| `CommentsModule`, `NotificationsModule` (in-app + email), `AuditModule` | Transverses |
| `ExportsModule` | Production d'artefacts par tâche asynchrone ; artefacts stockés dans S3 |
| `AiModule` | Branchement du paquet `ai` : configuration par client, journal, budget |
| `JobsModule` | Producteur et consommateur pg-boss |
| `RealtimeModule` | Émission `pg_notify` et délivrance des jetons de coédition |

### 1.4 Flux de données principaux

1. **Analyse**
   1. Le consultant saisit la description du métier dans le texte partagé (Yjs) et dépose des documents (S3).
   2. « Analyser » fige le texte en `Source` immuable et lance le job `extraction`.
   3. Le pipeline produit des candidats avec citations. Les citations sont vérifiées, puis les candidats sont réconciliés avec le modèle existant (dédoublonnage, détection d'écarts).
   4. Un `ChangeSet` est appliqué et crée la version N+1, avec des éléments `extracted` et `hypothesis`.
   5. Un `pg_notify` déclenche la mise à jour du document Yjs `model` par le serveur collab. Tous les clients voient la nouvelle version.
2. **Questionnement**
   1. Le job `questions` calcule les manques à partir de la complétude, puis l'IA produit des questions classées par effet bloquant.
   2. L'interface présente une question à la fois.
   3. La réponse devient une `Source` de type `answer`. Le job `answer.integrate` la transforme en ChangeSet, qui est appliqué.
3. **Hypothèses.** Le job `hypotheses` produit des éléments `hypothesis` (origine `ai_knowledge`, justification obligatoire). Le consultant accepte, corrige ou rejette chacun d'eux ; chaque décision est un petit ChangeSet.
4. **Livrables et validation du dossier**
   1. La vue `deliverableView(model)` exclut les hypothèses.
   2. Les exports sont produits, puis une `ValidationSubmission(analysis_dossier, version N)` est créée.
   3. Le validateur consulte la version figée, commente et valide. Les éléments passent au statut `validated` dans une nouvelle version, et la phase passe à `mapping`.
5. **Cartographie**
   1. Le job `process.flow` construit les enchaînements des niveaux 2 et 3 (hypothèses à confirmer).
   2. `packages/bpmn` projette la version courante en BPMN sur 4 niveaux, avec une mise en page stable.
   3. Le consultant fait des demandes en langage naturel. Le pipeline `model.edit` crée une `ChangeProposal` affichée en aperçu (différences et incohérences), que le consultant applique ou abandonne.
6. **AS-IS, diagnostic, TO-BE**
   1. Le validateur valide l'AS-IS ; la phase passe à `transformation`.
   2. Les détecteurs déterministes et le pipeline `diagnostic` produisent des constats.
   3. Le pipeline `optimisation.propose` produit des optimisations : chacune porte un ChangeSet sur l'AS-IS, ses dépendances, un gain et un effort.
   4. Le consultant confirme les optimisations, puis les soumet.
   5. Le validateur accepte ou refuse chaque optimisation ; un refus déclenche la cascade.
   6. Une alternative peut être proposée pour le même constat.
   7. À la clôture, le TO-BE est recomposé : c'est l'AS-IS auquel on applique les optimisations acceptées.

### 1.5 Le dépôt comme mémoire entre sessions

```
CLAUDE.md                          # point d'entrée obligatoire pour chaque agent
docs/
├─ cahier-des-charges.md           # CDC (lecture seule, sauf demande du PO)
├─ specs/
│  └─ increment-1.md               # ce document (mis à jour lorsqu'une décision PO change)
├─ adr/
│  ├─ 0000-template.md
│  └─ 00NN-titre.md                # une décision par fichier (contexte, décision, conséquences)
├─ wp/
│  ├─ TRACKER.md                   # tableau WP | statut | branche | date | notes
│  └─ WP-XX.md                     # rapport de fin de WP : fait, écarts, dettes, suite
├─ dev/
│  ├─ CONVENTIONS.md               # code, nommage, tests, i18n, a11y, commits
│  └─ RUNBOOK.md                   # lancer, tester, réinitialiser la base, variables d'environnement
└─ po/
   └─ DECISIONS.md                 # décisions PO [PO-n] : valeur retenue, date
```

**Protocole de chaque agent** (inscrit dans `CLAUDE.md`) :

1. Lire, dans cet ordre : `CLAUDE.md`, `docs/wp/TRACKER.md`, la fiche du WP dans ce document (section 7), les rapports des WP dont il dépend, puis les ADR cités.
2. Ne pas élargir le périmètre du WP. Toute découverte qui dépasse le WP est notée dans le rapport, rubrique « Suite ».
3. Toute décision technique structurante prend la forme d'un ADR. Toute question de produit est ajoutée à `docs/po/DECISIONS.md` avec le statut « ouverte », et l'agent applique la valeur par défaut documentée.
4. Avant de terminer : `pnpm lint && pnpm typecheck && pnpm test` doivent être verts, ainsi que les tests d'acceptation du WP. L'agent met à jour `TRACKER.md` et écrit `docs/wp/WP-XX.md`.
5. Les commits et branches (`wp/WP-XX-slug`) suivent les instructions de l'orchestrateur.

---

## 2. Le méta-modèle (`packages/model`)

Les types ci-dessous sont **normatifs**. WP-02 les implémente en schémas **zod**, dont les types TypeScript sont dérivés, et exporte un JSON Schema (`pnpm --filter model schema:export` vers `packages/model/schema/business-model.v1.json`). Les noms sont à conserver.

### 2.1 Identifiants, origine, statut

```ts
export type ElementId = string;      // UUID v7, immuable, attribué par le serveur
export type SourceId = string;       // UUID v7
export type UserId = string;
export type ISODateTime = string;

export type ElementKind =
  | 'business_trait' | 'glossary_term'                       // Métier
  | 'actor'                                                  // Acteurs
  | 'activity' | 'event' | 'gateway' | 'sequence_flow' | 'process_link' // Activités
  | 'data_object' | 'tool'                                   // Données
  | 'information_flow'                                       // Flux
  | 'rule'                                                   // Règles
  | 'indicator'                                              // Indicateurs
  | 'discrepancy'                                            // Écarts entre sources (CDC 3.1)
  | 'finding' | 'optimisation';                              // Transformation (CDC 4.3-4.4)

export type Concept =
  | 'business' | 'actors' | 'activities' | 'data' | 'flows' | 'rules' | 'indicators';

export const CONCEPT_OF_KIND: Record<
  Exclude<ElementKind, 'discrepancy' | 'finding' | 'optimisation'>,
  Concept
> = {
  business_trait: 'business', glossary_term: 'business', actor: 'actors',
  activity: 'activities', event: 'activities', gateway: 'activities',
  sequence_flow: 'activities', process_link: 'activities',
  data_object: 'data', tool: 'data', information_flow: 'flows',
  rule: 'rules', indicator: 'indicators',
};

export type ElementStatus = 'extracted' | 'hypothesis' | 'confirmed' | 'validated';

export type OriginKind =
  | 'free_text'          // description du métier saisie par le consultant (CDC 3.2 §1)
  | 'answer'             // réponse au questionnement guidé
  | 'document'           // document déposé
  | 'interview'          // incrément 4
  | 'system_log'         // incrément 4
  | 'ai_knowledge'       // « connaissance générale de l'IA » (CDC 6.4)
  | 'past_mission'       // incrément 4
  | 'consultant'         // créé ou corrigé par dialogue ou décision du consultant
  | 'deterministic_rule';// constat produit par un détecteur automatique
```

Les origines `free_text`, `answer`, `consultant` et `deterministic_rule` précisent l'origine « texte et dialogue » du CDC 3.4 **[HORS-CDC]**.

```ts
export interface SourceRef {
  sourceId: SourceId;
  sourceRevision: number;          // les sources sont immuables : un nouveau dépôt crée une révision
  chunkId?: string;
  locator: {
    page?: number; sheet?: string; cell?: string; paragraph?: number;
    charStart: number; charEnd: number;   // dans le texte extrait du morceau
  };
  quote: string;                   // citation verbatim, VÉRIFIÉE côté serveur (voir 4.5)
}

export interface Provenance {
  origin: OriginKind;
  refs: SourceRef[];               // au moins une si status = 'extracted'
  rationale?: string;              // « pourquoi » ; obligatoire si origin = 'ai_knowledge' (CDC 6.4)
  confidence?: number;             // 0..1, indicatif, affiché
  aiCallId?: string;               // lien vers le journal ai_calls
  author: { type: 'ai' | 'user' | 'system'; userId?: UserId };
  at: ISODateTime;
}

export interface StatusInfo {
  value: ElementStatus;
  decidedBy?: UserId;              // consultant (confirmed) ou validateur (validated)
  decidedAt?: ISODateTime;
  correction?: { previous: unknown; note?: string };  // si la confirmation était une correction
  validatedInSubmission?: string;  // ValidationSubmission.id
  changedAfterValidation?: { version: number; at: ISODateTime } | null; // CDC 3.6 §3
}
```

**Transitions de statut.** Elles sont appliquées par `transitionStatus()` dans `packages/model`, avec un test par cellule de la matrice.

| De → vers | Qui | Condition |
| --- | --- | --- |
| (nouveau) → `extracted` | Système ou IA | au moins une `SourceRef` vérifiée |
| (nouveau) → `hypothesis` | Système ou IA | `rationale` présent |
| `extracted` / `hypothesis` → `confirmed` | Consultant ou responsable de mission | Acceptation ou correction |
| `hypothesis` → (rejeté) | Consultant ou responsable de mission | L'élément est retiré du modèle et archivé dans `rejectedHypotheses` pour ne pas être reproposé |
| `extracted` / `confirmed` → `validated` | Validateur | Uniquement par la validation d'une soumission (dossier d'analyse, AS-IS ou TO-BE) |
| `validated` → `confirmed` | Système | Toute modification ultérieure du contenu de l'élément, avec `changedAfterValidation` renseigné et un signalement au validateur (CDC 3.6, 3.7) |

### 2.2 Élément de base

```ts
export interface ElementBase<K extends ElementKind> {
  id: ElementId;
  kind: K;
  code: string;                    // lisible, unique par mission (ex. "P04", "P04.2", "ACT-03", "RG-012")
  label: string;
  description?: string;
  provenance: Provenance;          // origine de la création
  fieldProvenance?: Record<string, Provenance>; // origine d'un attribut ajouté ou modifié ensuite
  status: StatusInfo;
  tags?: string[];
  meta: { createdInVersion: number; updatedInVersion: number };
}
```

**Codes [HORS-CDC].** Ils sont attribués par le serveur quand l'IA n'en fournit pas, ou que le code fourni est déjà pris.

| Élément | Format du code |
| --- | --- |
| Macroprocessus | `P01`… (le pilote les fournit) |
| Processus | `P04.1` |
| Tâche | `P04.1.3` |
| Étape | `P04.1.3.2` |
| Autres | `ACT-nn`, `DON-nn`, `OUT-nn`, `FLX-nn`, `RG-nnn`, `IND-nn`, `TRM-nn`, `ECA-nn`, `CST-nn`, `OPT-nn` |

### 2.3 Concepts du CDC 3.3

```ts
// --- Métier ---
export interface BusinessTrait extends ElementBase<'business_trait'> {
  facet: 'sector' | 'environment' | 'specificity' | 'summary' | 'activity_statement';
  text: string;
}
export interface GlossaryTerm extends ElementBase<'glossary_term'> {
  term: string; definition: string; synonyms: string[];
}

// --- Acteurs ---
export interface Actor extends ElementBase<'actor'> {
  category: 'internal' | 'external' | 'third_party_system';
  responsibilities: string[];
  stakeholder?: boolean;           // parties prenantes externes (administrations, banques…)
  parentId?: ElementId;            // rattachement organisationnel
  appRole?: boolean;               // devient un rôle de l'application générée (incrément 2)
}

// --- Activités ---
export type ActivityLevel = 'macro' | 'process' | 'task' | 'step';
//   macro   → nœud du niveau 0 et diagramme du niveau 1
//   process → nœud du niveau 1 et diagramme du niveau 2 (un sous-processus = process dont le parent est un process)
//   task    → nœud du niveau 2 et, s'il a des étapes, diagramme du niveau 3
//   step    → nœud du niveau 3 (procédure)
export interface RaciEntry { actorId: ElementId; role: 'R' | 'A' | 'C' | 'I' }
export interface Activity extends ElementBase<'activity'> {
  level: ActivityLevel;
  parentId?: ElementId;            // obligatoire sauf pour 'macro'
  order?: number;
  macroCategory?: 'steering' | 'core' | 'support';        // niveau 0 uniquement [HORS-CDC]
  scope?: 'mapping_only' | 'application';                 // couverture du pilote (CDC 2.2, 8.2)
  responsibleActorId?: ElementId;  // acteur responsable (CDC 4.1)
  raci: RaciEntry[];
  inputs: ElementId[];             // data_object
  outputs: ElementId[];            // data_object
  toolIds: ElementId[];
  ruleIds: ElementId[];
  trigger?: string;
  execution: 'manual' | 'user' | 'automatic' | 'ai_agent';  // AS-IS : manual/user ; le TO-BE peut changer
  automation?: {                   // TO-BE uniquement (CDC 4.4)
    type: 'rules_notifications' | 'documents' | 'integration' | 'ai_agent';
    capability: string;            // identifiant du catalogue de capacités du moteur (voir 2.6)
  };
}
export interface ProcessEvent extends ElementBase<'event'> {
  containerId: ElementId;          // activité de niveau process ou task dont il fait partie
  position: 'start' | 'end' | 'intermediate' | 'boundary';
  trigger: 'none' | 'message' | 'timer' | 'error' | 'signal' | 'conditional';
  attachedToId?: ElementId;        // si position = 'boundary' (exception sur une tâche)
  actorId?: ElementId;
  timer?: string;                  // ex. « J+7 après la demande »
}
export interface Gateway extends ElementBase<'gateway'> {
  containerId: ElementId;
  type: 'exclusive' | 'parallel' | 'inclusive';
  ruleId?: ElementId;              // point de décision → règle de type 'decision'
  actorId?: ElementId;
}
export interface SequenceFlow extends ElementBase<'sequence_flow'> {
  containerId: ElementId;
  fromId: ElementId; toId: ElementId;  // activity | event | gateway du même conteneur
  condition?: string; ruleId?: ElementId; isDefault?: boolean;
}
export interface ProcessLink extends ElementBase<'process_link'> {   // liens du niveau 0 (CDC 4.1)
  fromId: ElementId; toId: ElementId;  // activités de niveau 'macro'
  nature: 'sequence' | 'feeds' | 'steers' | 'supports';
  dataObjectIds?: ElementId[];
}

// --- Données ---
export type FieldType =
  | 'text' | 'number' | 'amount' | 'date' | 'boolean' | 'enum' | 'file' | 'reference';
export interface DataField {
  id: ElementId; name: string; type: FieldType;
  required?: boolean; enumValues?: string[]; referenceObjectId?: ElementId;
  description?: string; personalData?: boolean;
  provenance: Provenance; status: StatusInfo;   // un champ porte sa propre origine et son statut
}
export interface DataObject extends ElementBase<'data_object'> {
  nature: 'business_object' | 'document' | 'form';
  fields: DataField[];
  toolIds: ElementId[];
  lifecycleStates?: string[];      // préparation de l'incrément 2 (workflows)
  personalData?: boolean;          // registre RGPD (incrément 2)
}
export interface Tool extends ElementBase<'tool'> {
  nature: 'software' | 'spreadsheet' | 'email' | 'paper' | 'phone' | 'other';
  systemActorId?: ElementId;       // si l'outil est un système tiers modélisé comme acteur
}

// --- Flux ---
export interface InformationFlow extends ElementBase<'information_flow'> {
  fromActorId: ElementId; toActorId: ElementId;
  dataObjectIds: ElementId[];
  channel: 'paper' | 'email' | 'phone' | 'software' | 'portal' | 'oral' | 'other' | 'unknown';
  activityId?: ElementId;          // activité qui émet le flux
  frequency?: string;
}

// --- Règles (texte structuré, CDC 3.7) ---
export interface Rule extends ElementBase<'rule'> {
  type: 'business' | 'constraint' | 'decision' | 'exception' | 'dependency';
  statement: { text: string; when?: string; then?: string; otherwise?: string };
  appliesTo: ElementId[];          // activités, objets, champs, passerelles
  dependsOn?: ElementId[];         // type 'dependency'
  exceptionHandling?: {            // type 'exception' (CDC 5.2 « Exceptions »)
    circuit: 'reminder' | 'escalation' | 'deadline' | 'alert' | 'other';
    description: string; activityIds?: ElementId[];
  };
  legalReference?: string;
  decisionTable?: never;           // RÉSERVÉ : incrément 2 (traduction en table de décision)
}

// --- Indicateurs ---
export interface Indicator extends ElementBase<'indicator'> {
  targetId: ElementId;             // activité, objet, acteur, flux
  measure: 'volume' | 'lead_time' | 'duration' | 'frequency' | 'workload' | 'cost' | 'error_rate';
  value: { exact?: number; min?: number; max?: number };
  unit: string;                    // « dossiers », « h », « jours », « € », « % »
  period?: 'day' | 'week' | 'month' | 'year' | 'occurrence';
  seasonality?: string;            // ex. « pic en avril-mai (liasses) »
  nature: 'known' | 'estimated';
}

// --- Écart entre sources (CDC 3.1 : l'outil signale, ne tranche pas) ---
export interface Discrepancy extends ElementBase<'discrepancy'> {
  elementIds: ElementId[];
  sides: { claim: string; refs: SourceRef[] }[];   // au moins 2
  state: 'open' | 'resolved';
  resolution?: { note: string; by: UserId; at: ISODateTime; keptSide?: number };
}
```

### 2.4 Transformation : diagnostic et optimisations (CDC 4.3 à 4.7)

```ts
export type FindingFamily = 'waste' | 'flow_and_delay' | 'organisation' | 'risk_compliance';
export type FindingType =
  // gaspillages
  | 'rekeying' | 'repetitive_task' | 'duplicate' | 'redundant_control' | 'useless_validation_loop'
  // flux et délais
  | 'bottleneck' | 'waiting_time' | 'flow_break' | 'paper_or_email_transfer'
  // organisation
  | 'task_without_owner' | 'incompatible_roles' | 'single_person_dependency'
  // risques et conformité
  | 'missing_control' | 'missing_traceability' | 'uncovered_obligation';

export interface Finding extends ElementBase<'finding'> {
  family: FindingFamily; type: FindingType;
  location: ElementId[];           // au moins 1 : localisation sur la cartographie (CDC 4.3)
  severity: 1 | 2 | 3;
  detection: { by: 'rule' | 'ai'; detectorId?: string };
  evidence?: string;               // justification lisible ; les sources sont dans provenance.refs
}

export interface Range { low: number; high: number; unit: string }
export interface CalcAssumption {
  label: string; value: number; unit: string;
  origin: 'standard_ratio' | 'model_indicator' | 'ai' | 'consultant';
  ref?: string;                    // id du ratio (catalogue) ou ElementId de l'indicateur
}
export interface GainEstimate {     // ordres de grandeur, hypothèses visibles (CDC 4.5)
  timeHoursPerYear?: Range;
  costEurPerYear?: Range;
  errorsAvoidedPerYear?: Range;
  assumptions: CalcAssumption[];
  formula: string;                 // texte lisible de la formule appliquée
  score: 1 | 2 | 3 | 4 | 5;        // position sur la matrice (voir 4.4.3)
}
export interface EffortEstimate {
  score: 1 | 2 | 3 | 4 | 5;
  justification: string;
  drivers: ('engine_configuration' | 'new_extension' | 'integration' | 'organisational_change' | 'data_migration')[];
}

export interface Optimisation extends ElementBase<'optimisation'> {
  findingIds: ElementId[];          // au moins 1 (CDC 4.4 : le constat qu'elle traite)
  alternativeOf?: ElementId;        // alternative après un refus (CDC 4.7 §4)
  automationType?: 'rules_notifications' | 'documents' | 'integration' | 'ai_agent' | 'organisational';
  changeSet: ChangeSet;             // modifications de l'AS-IS ; base = version de l'AS-IS validé
  touchedElementIds: ElementId[];   // dérivé de changeSet ; les « éléments du TO-BE qu'elle modifie »
  dependsOn: ElementId[];           // autres optimisations ; graphe acyclique (vérifié)
  gain: GainEstimate;
  effort: EffortEstimate;
  decision?: OptimisationDecisionSnapshot;   // reflet de la décision du validateur, écrit à la clôture
}
export interface OptimisationDecisionSnapshot {
  value: 'accepted' | 'rejected';
  cause: 'direct' | 'cascade';
  cascadeFrom?: ElementId;
  submissionId: string; comment?: string; at: ISODateTime; by: UserId;
}
```

### 2.5 Document du modèle, versions et changements

```ts
export type Element =
  | BusinessTrait | GlossaryTerm | Actor | Activity | ProcessEvent | Gateway | SequenceFlow
  | ProcessLink | DataObject | Tool | InformationFlow | Rule | Indicator | Discrepancy
  | Finding | Optimisation;

export interface BusinessModel {
  schemaVersion: 1;                 // numéro de schéma, migrations dans packages/model/migrations
  missionId: string;
  version: number;                  // version du modèle de la mission (1, 2, 3…)
  elements: Record<ElementId, Element>;   // une seule table indexée : simple pour les opérations et Yjs
  rejectedHypotheses: { element: Element; by: UserId; at: ISODateTime; reason?: string }[];
  layout: Record<DiagramId, Record<ElementId, { x: number; y: number; w: number; h: number }>>;
  // disposition mémorisée pour que les nouveaux rendus restent stables (voir 6.3)
}
export type DiagramId = string;   // 'L0' | `L1:${macroId}` | `L2:${processId}` | `L3:${taskId}`

// Le TO-BE n'est pas stocké séparément : c'est une fonction pure.
export function composeToBe(asIs: BusinessModel, accepted: Optimisation[]): BusinessModel;
// Le résultat est du même type BusinessModel : c'est le modèle exécuté par le moteur à l'incrément 2.
```

**Opérations de modification.** Ce sont les seules manières de changer un modèle :

```ts
export type ModelOp =
  | { op: 'add'; element: Element }                          // l'id peut être temporaire ("tmp:3"), résolu par le serveur
  | { op: 'update'; id: ElementId; set: Record<string, unknown>; unset?: string[] }
  | { op: 'remove'; id: ElementId; cascade?: ElementId[] }   // refusée si l'élément reste référencé hors cascade
  | { op: 'set_status'; id: ElementId; status: ElementStatus; correction?: unknown }
  | { op: 'reject_hypothesis'; id: ElementId; reason?: string }
  | { op: 'set_layout'; diagram: DiagramId; positions: Record<ElementId, { x: number; y: number; w: number; h: number }> };

export type ChangeCause =
  | 'extraction' | 'answer' | 'hypotheses' | 'hypothesis_decision' | 'process_flow'
  | 'dialogue_edit' | 'diagnostic' | 'optimisation' | 'validation' | 'rollback' | 'layout'
  | 'to_be_composition';

export interface ChangeSet {
  baseVersion: number;
  ops: ModelOp[];
  cause: ChangeCause;
  summary: string;                 // résumé lisible en français, affiché dans l'historique
}

// API pure du paquet (WP-03)
export function applyChangeSet(m: BusinessModel, cs: ChangeSet): ApplyResult;
export type ApplyResult =
  | { ok: true; model: BusinessModel; diff: ModelDiff; warnings: CoherenceIssue[] }
  | { ok: false; errors: IntegrityError[] };     // intégrité référentielle, schéma, transitions interdites
export function diffModels(a: BusinessModel, b: BusinessModel): ModelDiff; // ajoutés, retirés, modifiés (par champ)
export function rebase(cs: ChangeSet, intervening: ModelDiff[], head: BusinessModel):
  { ok: true; cs: ChangeSet } | { ok: false; conflicts: ElementId[] };
export function checkCoherence(m: BusinessModel): CoherenceIssue[];      // CDC 4.2
export function completeness(m: BusinessModel): Record<Concept, CompletenessReport>;
export function deliverableView(m: BusinessModel): BusinessModel;        // sans hypothèses ni écarts ouverts
export function raciMatrix(m: BusinessModel, scopeId?: ElementId): RaciMatrix;
```

**Contrôles de cohérence** (`CoherenceIssue.code`). Ce sont des avertissements : ils sont affichés et n'empêchent pas l'enregistrement.
- Exigés par le CDC 4.2 : `ACTIVITY_WITHOUT_OWNER`, `DEAD_END_BRANCH` (nœud sans chemin vers un événement de fin), `DATA_NEVER_PRODUCED` (entrée jamais produite par une activité ni apportée par un flux ou un acteur externe).
- Ajoutés **[HORS-CDC]** : `UNREACHABLE_NODE`, `GATEWAY_SINGLE_OUTGOING`, `DECISION_WITHOUT_RULE`, `PROCESS_WITHOUT_START_OR_END`, `FLOW_UNKNOWN_CHANNEL`, `ORPHAN_DATA_OBJECT`, `RULE_WITHOUT_SCOPE`.

**Indicateur de complétude** (CDC 3.7) **[PO-10]**. Pour chaque concept, une liste de contrôles déterministes. Le rapport donne `score = contrôles satisfaits / contrôles applicables`, la liste des manques (cliquables), le nombre d'hypothèses en attente et le nombre de questions ouvertes. Le consultant décide quand arrêter.

| Concept | Contrôles (valeur par défaut) |
| --- | --- |
| Métier | Secteur, environnement, au moins une spécificité, une synthèse ; chaque terme du glossaire a une définition |
| Acteurs | Au moins un acteur interne ; chaque acteur a au moins une responsabilité et apparaît dans au moins un RACI ou un flux |
| Activités | Chaque macroprocessus a au moins un processus ; chaque processus a au moins une tâche ; une fois l'enchaînement construit, un début et une fin ; chaque tâche a un responsable |
| Données | Chaque objet est utilisé par au moins une activité ; chaque document ou formulaire a au moins un champ |
| Flux | Émetteur, destinataire et au moins un objet ; canal connu |
| Règles | Chaque passerelle exclusive a une règle ; chaque règle a une portée ; chaque exception a un traitement |
| Indicateurs | Chaque processus a au moins un volume et un délai |

**Versionnement et historique**
- Chaque `applyChangeSet` validé produit la version N+1, stockée comme instantané complet en JSONB, avec le `ChangeSet` et le `diff` (voir la table `model_versions`, section 3).
- L'historique d'un élément se lit dans l'index `model_version_elements` (version, élément, type de changement).
- Retour arrière vers la version K : un ChangeSet `rollback` qui remplace le contenu par celui de K et crée la version N+1. Les éléments `validated` touchés passent à `confirmed` avec un signalement.

### 2.6 Catalogue des capacités du moteur

Les automatisations proposées doivent être « celles que le moteur sait exécuter » (CDC 4.4). Le fichier `packages/model/catalog/engine-capabilities.fr.json` liste les capacités : `assign_auto`, `reminder`, `escalation`, `deadline_alert`, `state_change`, `doc_generation`, `e_signature`, `ocr_extraction`, `connector:accounting`, `connector:bank`, `connector:edi`, `agent:classify_documents`, `agent:anomaly_detection`, `agent:drafting`, `agent:decision_support`.

Chaque capacité porte un libellé, une description et un effort indicatif. Le schéma de sortie du pipeline d'optimisation n'accepte que ces identifiants. Le catalogue sera la liste des extensions de l'incrément 2 **[HORS-CDC, à confirmer PO-9]**.

### 2.7 Validations

```ts
export type SubmissionKind = 'analysis_dossier' | 'as_is' | 'to_be';
export interface ValidationSubmission {
  id: string; missionId: string; kind: SubmissionKind; round: number;
  modelVersion: number;            // version figée soumise
  artifactIds: string[];           // exports joints (empreinte sha256)
  excludedHypothesisIds: ElementId[];  // hypothèses exclues, listées au consultant à la soumission
  status: 'submitted' | 'validated' | 'superseded' | 'withdrawn' | 'closed';
  submittedBy: UserId; submittedAt: ISODateTime;
  decidedBy?: UserId; decidedAt?: ISODateTime; comment?: string;
}
export interface OptimisationDecision {   // TO-BE élément par élément (CDC 4.7)
  id: string; submissionId: string; optimisationId: ElementId;
  value: 'accepted' | 'rejected'; cause: 'direct' | 'cascade'; cascadeFrom?: ElementId;
  comment?: string; by: UserId; at: ISODateTime; supersededAt?: ISODateTime;
}
export interface PostValidationNotice {   // CDC 3.6 §3 et 3.7 : signalé, sans nouvelle validation formelle
  id: string; missionId: string; submissionId: string; elementId: ElementId;
  version: number; summary: string; createdAt: ISODateTime; seenAt?: ISODateTime;
}
```

**Phases de la mission** : `analysis`, puis `mapping`, puis `transformation`, puis `generation` (incrément 2).
- On ne passe en `mapping` qu'après la validation du dossier d'analyse. La construction des enchaînements et le BPMN ne sont accessibles qu'à partir de cette phase **[PO-6]**.
- On ne passe en `transformation` qu'après la validation de l'AS-IS. Le diagnostic et le TO-BE ne sont pas proposés avant (CDC 4.7 §1, 4.9).
- La mission n'est prête pour l'incrément 2 qu'après la clôture de la validation du TO-BE.

**Règles de la cascade**, mises en œuvre par une fonction pure `applyDecision()` dans `packages/model`, avec des tests exhaustifs :
1. Les dépendances forment un graphe acyclique, vérifié lors de la confirmation et de la soumission. Le validateur voit les dépendances avant de décider.
2. Refuser X refuse automatiquement toutes les optimisations qui dépendent de X, directement ou non (`cause: 'cascade'`, `cascadeFrom: X`). Ce refus écrase une éventuelle acceptation antérieure, et une boîte de confirmation liste d'abord les optimisations touchées.
3. Accepter Y alors qu'une de ses dépendances n'est pas encore décidée est possible. Y est alors « accepté sous réserve », et la clôture n'est possible que si toutes les dépendances d'un élément accepté sont acceptées.
4. Si X est accepté après coup, les refus en cascade venus de X ne sont **pas** annulés automatiquement : le validateur décide de nouveau **[PO-7]**.
5. Les décisions restent modifiables jusqu'à la clôture par le validateur **[PO-7]**.
6. Après un refus direct, le consultant peut créer une alternative (`alternativeOf`) pour le même constat. Elle est soumise dans une nouvelle manche (`round + 1`) qui suit le même circuit.
7. À la clôture, `composeToBe` applique les optimisations acceptées dans l'ordre topologique, puis par code. Les conflits entre deux optimisations (mêmes éléments touchés sans dépendance déclarée) sont détectés **à la soumission** et la bloquent tant que le consultant ne les a pas résolus.

---

## 3. Base de données, authentification, droits et cloisonnement

### 3.1 Choix

- PostgreSQL 17, avec **Drizzle ORM** et drizzle-kit pour les migrations SQL versionnées **[HORS-CDC]**. Raisons : SQL explicite, transactions et `SET LOCAL` simples pour la RLS, JSONB typé.
- L'application se connecte avec un rôle **non propriétaire** (`processia_app`), soumis à la RLS. Les migrations utilisent `processia_owner`.

### 3.2 Tables

Toutes les clés primaires sont des `uuid` (v7), sauf indication contraire. Toutes les dates sont des `timestamptz`. La colonne « RLS » indique qu'une politique de cloisonnement par mission s'applique.

| Table | Colonnes principales | RLS |
| --- | --- | --- |
| `users` | `email` (citext, unique), `display_name`, `password_hash` (argon2id), `global_role` (`admin` / `mission_manager` / `consultant` / `client_validator`), `status` (`invited` / `active` / `disabled`), `totp_secret_enc`, `totp_enabled_at`, `last_login_at` | non |
| `recovery_codes` | `user_id`, `code_hash`, `used_at` | non |
| `auth_identities` | `user_id`, `provider` (`password`, puis `oidc:*` / `saml:*`), `subject` : préparation du SSO | non |
| `sessions` | `id_hash`, `user_id`, `mfa_verified_at`, `expires_at`, `last_seen_at`, `ip`, `user_agent` | non |
| `invitations` | `token_hash`, `email`, `global_role`, `mission_id?`, `mission_role?`, `expires_at`, `accepted_at` | non |
| `clients` | `name`, `default_retention_months`, `created_at` : organisations clientes | non |
| `ai_provider_configs` | `client_id`, `provider` (`fake` / `anthropic`), `models` (jsonb : modèle par pipeline), `api_key_enc`, `capabilities` (jsonb : text, documents, audio), `data_policy_text`, `policy_accepted_by`, `policy_accepted_at`, `monthly_budget_eur`, `active` | non (accès admin) |
| `missions` | `client_id`, `name`, `description`, `phase`, `head_version`, `retention_until`, `created_by`, `archived_at` | non (filtré par l'application) |
| `mission_members` | `mission_id`, `user_id`, `mission_role` (`manager` / `consultant` / `validator`) ; index unique partiel : un seul `validator` par mission (CDC 2.3) | non |
| `model_versions` | PK (`mission_id`, `version`), `parent_version`, `snapshot` (jsonb), `change_set` (jsonb), `diff` (jsonb), `cause`, `summary`, `author_id`, `ai_call_id?`, `created_at` | oui |
| `model_version_elements` | `mission_id`, `version`, `element_id`, `change` (`added` / `updated` / `removed` / `status`) : index de l'historique par élément | oui |
| `change_proposals` | `mission_id`, `base_version`, `instruction`, `change_set`, `explanation`, `diff`, `warnings`, `status` (`pending` / `applied` / `discarded` / `stale`), `created_by`, `ai_call_id`, `applied_version` | oui |
| `dialogue_messages` | `mission_id`, `thread` (`analysis` / `mapping` / `transformation`), `author_id?`, `role` (`user` / `assistant` / `system`), `content`, `proposal_id?`, `created_at` | oui |
| `sources` | `mission_id`, `kind` (`free_text` / `answer` / `document`), `title`, `revision`, `storage_key?`, `mime`, `sha256`, `size_bytes`, `text_status`, `created_by` | oui |
| `source_chunks` | `mission_id`, `source_id`, `ordinal`, `text`, `locator` (jsonb), `tsv` (tsvector, français) | oui |
| `analysis_runs` | `mission_id`, `kind` (`extraction` / `questions` / `hypotheses` / `process_flow` / `diagnostic` / `optimisations` / …), `status`, `progress`, `job_id`, `error`, `result_version`, `started_by` | oui |
| `questions` | `mission_id`, `concept`, `text`, `rationale`, `blocking_score`, `target_element_ids`, `status` (`open` / `answered` / `skipped`), `answer_source_id`, `answered_by`, `rank` | oui |
| `validation_submissions` | voir 2.7 | oui |
| `optimisation_decisions` | voir 2.7 | oui |
| `post_validation_notices` | voir 2.7 | oui |
| `comments` | `mission_id`, `target_kind` (`element` / `submission` / `optimisation` / `deliverable`), `target_id`, `model_version`, `parent_id`, `author_id`, `body`, `resolved_at` | oui |
| `artifacts` | `mission_id`, `kind` (`docx` / `pdf` / `xlsx` / `bpmn` / `zip` / `svg`), `purpose`, `model_version`, `storage_key`, `sha256`, `created_by` | oui |
| `ai_calls` | `mission_id?`, `client_id`, `pipeline`, `pipeline_version`, `provider`, `model`, `input_hash`, `request` (jsonb), `response` (jsonb), `status`, `error`, `input_tokens`, `output_tokens`, `cost_estimate_eur`, `duration_ms`, `created_by` | oui (si `mission_id` est renseigné) |
| `yjs_documents` | `name` (PK, ex. `mission:<id>:workspace`), `mission_id`, `state` (bytea), `updated_at` | oui |
| `notifications` | `user_id`, `mission_id?`, `kind`, `payload`, `read_at` | non (filtré par `user_id`) |
| `audit_log` | `actor_id`, `mission_id?`, `action`, `target`, `payload`, `ip`, `at` (ajout seulement) | non |
| schéma `pgboss` | géré par pg-boss | — |

**Volumétrie.** Un instantané par version pèse probablement 0,5 à 3 Mo avant compression TOAST pour 14 processus. C'est acceptable pour l'incrément 1. Si besoin, on passera à un instantané toutes les N versions, avec des différences entre deux (risque R-6).

### 3.3 Cloisonnement des missions (CDC 9.2)

1. **Au niveau de l'application.** Toute route qui touche une mission (`/missions/:missionId/...`) passe par `MissionGuard`, qui vérifie l'appartenance ou le rôle global via `@processia/policy`, puis ouvre une transaction avec `withMission(missionId, fn)`. Les dépôts (repositories) des tables cloisonnées n'acceptent qu'un contexte de mission.
2. **Au niveau de la base.**
   - `withMission` exécute `SET LOCAL app.mission_id = '<uuid>'`.
   - Chaque table cloisonnée porte la politique `USING (mission_id = current_setting('app.mission_id', true)::uuid)`, avec `FORCE ROW LEVEL SECURITY`.
   - Sans contexte, une requête ne renvoie aucune ligne. Un test automatique le prouve dans WP-04.
3. **Stockage S3.** Les clés sont préfixées `missions/<missionId>/…`. Seule l'API produit les URL présignées, après la garde.
4. **IA.** Un appel n'envoie au fournisseur que des données de la mission courante. Les prompts ne contiennent jamais d'autres missions (la réutilisation des modèles anonymisés arrive à l'incrément 4).
5. **Qui voit quelles missions [PO-22].**

| Rôle | Missions visibles | Contenu |
| --- | --- | --- |
| Administrateur | Toutes | Lecture et commentaire seulement |
| Responsable de mission | Toutes ; il est membre `manager` de celles qu'il a créées ou auxquelles il est affecté | Selon la matrice 3.5 dans les missions où il est membre ; lecture et commentaire seulement dans les autres [PO-30] |
| Consultant | Celles où il est affecté | Selon la matrice 3.5 |
| Validateur | Uniquement la sienne | Uniquement les soumissions |

### 3.4 Authentification et double authentification (CDC 9.2)

Choix **[HORS-CDC]** :

- **Comptes.** Un compte se crée sur invitation par lien unique (72 h). Le mot de passe compte au moins 12 caractères et est vérifié contre une liste locale de mots de passe compromis. Il est haché en argon2id.
- **Double authentification obligatoire pour tous les rôles** : TOTP (RFC 6238, `otplib`) et 10 codes de secours à usage unique.
  - L'enrôlement est imposé à la première connexion. Aucune route métier n'est accessible tant que `mfa_verified_at` de la session est vide.
  - La méthode TOTP seule est retenue pour l'incrément 1 ; WebAuthn viendra plus tard **[PO-4]**.
- **Sessions côté serveur**, stockées en base, avec un cookie `__Host-sid` (HttpOnly, Secure, SameSite=Strict).
  - Inactivité : 30 minutes. Durée maximale : 12 heures.
  - Rotation de l'identifiant après la connexion.
  - Protection CSRF par jeton synchronisé dans l'en-tête `x-csrf-token`.
- **Limitation de débit** (`@nestjs/throttler`) : 5 tentatives par minute et par compte et par IP ; blocage progressif.
- **Journal** des événements d'authentification dans `audit_log`.
- **Jeton de coédition.**
  - Délivré par `POST /missions/:id/collab-token` : JWT HS256 valable 10 minutes, avec les claims `sub`, `missionId`, `docs[]` et `readOnly`.
  - Le serveur collab le vérifie et revérifie l'appartenance en base à la connexion.
- **SSO (SAML / OIDC)** : demandé par le CDC 9.2, il est **reporté** par défaut à un incrément ultérieur ; la table `auth_identities` est prévue **[PO-3]**.
- **Emails** : SMTP via nodemailer, Mailpit en local. Le fournisseur de production reste à choisir **[PO-14]**.

### 3.5 Droits (CDC 2.4)

`@processia/policy` expose `can(subject, action, resource?) → boolean`. La matrice est un tableau de constantes testé cellule par cellule :

| Action (`Action`) | Admin | Responsable (membre) | Consultant (membre) | Validateur (membre) |
| --- | --- | --- | --- | --- |
| `users.manage`, `ai_providers.manage`, `clients.manage` | ✔ | ✘ | ✘ | ✘ |
| `users.invite` (consultants et validateurs pour ses missions, pour le responsable [PO-27]) | ✔ (tout rôle) | ✔ | ✘ | ✘ |
| `mission.create`, `mission.assign` | ✔ | ✔ | ✘ | ✘ |
| `mission.view_progress` | ✔ (toutes) | ✔ (toutes) [PO-22] | ✔ (les siennes) | ✘ |
| `mission.read_workspace` (analyse, cartographie en cours) | ✔ | ✔ | ✔ | ✘ |
| `model.edit` (lancer des analyses, dialoguer, appliquer des propositions, décider des hypothèses, coéditer) | ✘ | ✔ | ✔ | ✘ |
| `comment.create` | ✔ | ✔ | ✔ | ✔ (sur ses soumissions) |
| `submission.create` (soumettre au validateur) | ✘ | ✔ | ✔ | ✘ |
| `submission.read` | ✔ | ✔ | ✔ | ✔ (les siennes) |
| `submission.decide` (valider, accepter, refuser, clore) | ✘ | ✘ | ✘ | ✔ |
| `export.create` | ✔ | ✔ | ✔ | ✔ (exports de ses soumissions) |
| `history.rollback` | ✘ | ✔ | ✔ | ✘ |
| `model.publish_template` | ✔ (incrément 4) | ✘ | ✘ | ✘ |

Un responsable de mission voit toutes les missions [PO-22] ; dans une mission dont il n'est pas membre, il se comporte comme l'administrateur pour les actions de mission (`mission.view_progress`, `mission.read_workspace`, `comment.create`, `submission.read`, `export.create`) et n'a aucun autre droit de mission [PO-30]. `@processia/policy` modélise ce cas par une cinquième colonne, `observer`. Les cellules « (sur ses soumissions) » et « (les siennes) » du validateur exigent `resource.own === true` ; `MissionGuard` le fournit pour un validateur membre de la mission.

`MissionGuard` et `@Can(action)` sont réalisés par une seule garde globale (`PolicyGuard`), évaluée après `SessionGuard` : mission non visible (inexistante, hors affectation) = 404 ; droit refusé sur une mission visible = 403. Le nom du paramètre de route est `:missionId`.

`submission.create` découle de « Modifier l'analyse » (CDC 3.2 §6) **[HORS-CDC]**. `export.create` pour le validateur est également **[HORS-CDC]**.

Le validateur ne voit **que** des versions figées et filtrées par `deliverableView`. Il n'accède jamais au modèle de travail ni aux hypothèses.

---

## 4. Couche IA (`packages/ai`)

### 4.1 Interface fournisseur

```ts
export interface AiCapabilities { text: boolean; documents: boolean; images: boolean; audio: boolean }

export interface AiAttachment {
  kind: 'pdf' | 'image';
  mediaType: string;
  data: Uint8Array;
  name: string;
}

export interface StructuredRequest<T> {
  pipeline: string; pipelineVersion: string;
  system: string;                        // prompt système (fr), stable : favorise le cache de prompt
  messages: { role: 'user' | 'assistant'; content: string }[];
  attachments?: AiAttachment[];          // documents sans texte exploitable (scans, images)
  schema: z.ZodType<T>;                  // schéma de sortie
  schemaName: string;
  maxOutputTokens?: number;              // 16 000 par défaut ; flux (streaming) au-delà
  effort?: 'low' | 'medium' | 'high';    // traduit selon le fournisseur
}

export interface StructuredResult<T> {
  data: T;
  model: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number };
  stopReason: 'end' | 'max_tokens' | 'refusal' | 'other';
  raw: unknown;
}

export interface AiProvider {
  readonly id: 'fake' | 'anthropic' | string;
  readonly capabilities: AiCapabilities;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}
```

**Résolution du fournisseur.** `AiProviderRegistry.forClient(clientId)` lit `ai_provider_configs`.

- `AI_PROVIDER_OVERRIDE=fake` (variable d'environnement) force le fournisseur factice, en test et en développement local.
- Sans clé configurée, le fournisseur factice est toujours utilisé et l'interface affiche un bandeau « IA simulée ».
- À la création de la mission, les capacités exigées par l'incrément 1 (`text`, `documents`) sont comparées à celles du fournisseur. Si l'une manque, un avertissement s'affiche (CDC 6.5).
- La politique de données du fournisseur est affichée lors du paramétrage, et son acceptation est enregistrée (`policy_accepted_by`, `policy_accepted_at`), conformément au CDC 6.7.

### 4.2 Fournisseur factice déterministe (`FakeProvider`)

Il cherche une réponse dans cet ordre :

1. **Enregistrement exact** : `packages/test-fixtures/ai/<pipeline>/<inputHash>.json`. L'empreinte `inputHash` est un sha256 de la requête normalisée (prompt, messages, nom du schéma).
2. **Scénario scripté** : une fonction déterministe `(request) → output` enregistrée par pipeline. Exemples :
   - pour le pilote, l'extraction renvoie un jeu complet de candidats établi à partir du CDC 8 (14 macroprocessus, activités principales, 8 acteurs et les parties prenantes externes, citations exactes) ;
   - `model.edit` reconnaît des consignes types (« ajoute une validation par le chef de mission après la révision ») par expression régulière.
3. **Repli générique** : une sortie minimale valide, par exemple une liste vide, accompagnée d'un avertissement dans le journal.

Chaque sortie, enregistrée ou scriptée, est **validée par le même schéma zod en CI** : le fournisseur factice ne peut pas renvoyer ce que le vrai fournisseur ne pourrait pas renvoyer.

**Mode enregistrement.** Avec `AI_RECORD=1` et une vraie clé, les réponses réelles sont écrites comme enregistrements. Elles servent à rejouer un parcours réel en CI sans coût.

Le fournisseur factice simule aussi les erreurs (`refusal`, `max_tokens`, JSON invalide) à l'aide d'un drapeau dans le scénario, pour tester les chemins d'erreur.

### 4.3 Adaptateur Anthropic (`AnthropicProvider`)

- SDK officiel `@anthropic-ai/sdk`.
- **Modèle configurable** par client et par pipeline (`ai_provider_configs.models`). La valeur par défaut est `claude-opus-5-5`. Un modèle moins cher, par exemple `claude-sonnet-5-5`, peut être configuré pour les pipelines volumineux (extraction) si le budget l'exige **[PO-12]**.
- **Sortie structurée** : `client.messages.parse({ model, max_tokens, system, messages, output_config: { format: zodOutputFormat(schema), effort } })`.
  - Le SDK convertit le schéma zod et revalide la réponse côté client.
  - Pour les sorties longues, on passe par `messages.stream(...)` puis `finalMessage()`, et on valide avec zod.
  - Contraintes des modèles actuels, à respecter dans l'adaptateur :
    - pas de préremplissage de la réponse (prefill) ;
    - pas de `tool_choice` forcé ;
    - réflexion adaptative (`thinking: { type: 'adaptive' }`) ;
    - effort par défaut `medium` sur Opus 5.5, à fixer explicitement par pipeline.
- **Arrêts.**
  - `stop_reason === 'refusal'` : erreur typée `AiRefusalError`, journalisée, et message à l'utilisateur.
  - `max_tokens` : une reprise avec un plafond doublé, puis une erreur.
  - Option de repli côté serveur (`fallbacks: "default"`, bêta `server-side-fallback-2026-07-01`), activable par configuration et active par défaut. Le modèle réellement servi est journalisé.
- **Erreurs réseau** : le SDK fait déjà les reprises sur 429 et 5xx (`maxRetries` à 2). L'adaptateur distingue 400 et 404 (non réessayables), 429 (limite de débit) et 5xx.
- **Cache de prompt** : `cache_control` sur le prompt système et sur le résumé du modèle, qui reste stable d'un appel à l'autre au sein d'une session de travail.
- **Pièces jointes** : PDF en bloc `document` base64, images en bloc `image`.
- **Les citations natives de l'API ne sont pas utilisées** : elles sont incompatibles avec la sortie structurée. La provenance est assurée par des citations verbatim demandées au modèle et vérifiées côté serveur (4.5).
- **Tests sans clé** : réponses HTTP simulées (msw ou nock) qui couvrent le succès, le refus, `max_tokens`, une erreur 429 et un JSON hors schéma.

### 4.4 Exécuteur de pipelines et pipelines de l'incrément 1

Chaque pipeline est défini comme suit :

```ts
export interface PipelineDef<I, O> {
  name: string; version: string;           // la version change à chaque modification du prompt ou du schéma
  buildRequest(input: I, ctx: PipelineContext): Omit<StructuredRequest<O>, 'schema' | 'pipeline' | 'pipelineVersion'>;
  outputSchema: z.ZodType<O>;
  semanticCheck?(output: O, input: I, ctx: PipelineContext): SemanticIssue[]; // ids existants, citations, catalogue…
}
```

Algorithme de l'exécuteur (`runPipeline`) :

1. Vérifier le budget mensuel du client. Au-delà, l'erreur `AiBudgetExceeded` bloque l'appel ; l'administrateur est alerté à 80 %.
2. Appeler le fournisseur et valider la réponse avec zod.
3. Exécuter le contrôle sémantique (`semanticCheck`). En cas d'échec, faire **une seule** reprise de réparation : on renvoie au modèle la liste des erreurs. Si la reprise échoue aussi, l'erreur est visible.
4. Journaliser dans `ai_calls` : requête, réponse, jetons consommés, coût estimé à partir d'une table de prix configurable, durée.
5. Renvoyer `O`. La conversion en `ChangeSet` est faite par du code TypeScript déterministe, jamais par le modèle.

Les prompts sont stockés dans `packages/ai/prompts/<pipeline>.fr.md`, avec des variables `{{…}}`, et versionnés. Les sorties de l'IA référencent les éléments par `ElementId` ou par `code`. Un nouvel élément porte un identifiant temporaire `tmp:n`, résolu par le serveur.

| Pipeline | Entrée | Sortie (schéma) | Effet |
| --- | --- | --- | --- |
| `extraction.chunk` | Un morceau de source (environ 6 000 jetons, avec `chunkId`), le résumé du modèle (codes et libellés), le contexte métier | `ExtractionCandidates` : éléments candidats par type, chacun avec `quote` et `chunkId`, ou `rationale` s'il est inféré | Candidats |
| `extraction.document_visual` | PDF scanné ou image (capacité `documents`) | Texte transcrit par page, puis passage dans `extraction.chunk` | Source textuelle dérivée |
| `reconcile` | Candidats et résumé du modèle | `ReconcileResult` : correspondances (`same_as`), fusions, **écarts** entre affirmations contradictoires | ChangeSet `extraction` (éléments `extracted` ou `hypothesis`, `discrepancy`) |
| `questions` | Rapport de complétude, écarts ouverts, résumé du modèle | `Questions[]` : texte, concept, éléments visés, `blockingScore` 0..100 et justification | Lignes `questions`, classées (CDC 3.2 §3) |
| `answer.integrate` | Question, réponse (source `answer`), éléments visés | `ExtractionCandidates` | ChangeSet `answer` |
| `hypotheses` | Résumé du modèle, manques, secteur | Éléments proposés avec `rationale` (origine `ai_knowledge`) | ChangeSet `hypotheses` (statut `hypothesis`) |
| `deliverable.summary` | Caractéristiques confirmées | Texte de synthèse de la fiche métier (`BusinessTrait` de facette `summary`, hypothèse à confirmer) | ChangeSet |
| `process.flow` | Un processus, ses tâches, acteurs, règles, objets | Nœuds manquants (événements, passerelles, étapes de niveau 3) et enchaînements | ChangeSet `process_flow` (hypothèses) |
| `model.edit` | Consigne en langage naturel, partie pertinente du modèle (processus visé et ses voisins), extrait du dialogue | `EditPlan` : `ops[]`, explication, éléments touchés, questions de clarification éventuelles | `ChangeProposal` en aperçu (CDC 4.2) |
| `diagnostic` | AS-IS validé (sous-ensemble par macroprocessus), constats déterministes déjà trouvés | `Finding[]` (famille, type, localisation, justification, références) | ChangeSet `diagnostic` (hypothèses) |
| `optimisation.propose` | Constat(s), partie de l'AS-IS concernée, catalogue des capacités | `Optimisation[]` (ChangeSet, `dependsOn`, effort et justification, paramètres de gain) | ChangeSet `optimisation` |
| `optimisation.alternative` | Optimisation refusée, commentaire du validateur, constat | Une optimisation avec `alternativeOf` | Idem |
| `gain.parameters` | Optimisation, indicateurs disponibles, catalogue de ratios | Paramètres (volumes, durées avant et après, taux) avec leur origine | Le calcul est fait par `packages/diagnostic/gains.ts` (déterministe) |

**Hors incrément 1** : la traduction des règles en tables de décision (incrément 2) ; la transcription audio et l'identification des intervenants ; le process mining ; la proposition de modèles issus de missions passées (incrément 4). Ces pipelines ne sont pas créés.

**Décisions sans appel à l'IA.** Les décisions sur les hypothèses (accepter, rejeter, corriger) et le calcul de la complétude n'appellent pas l'IA. Les détecteurs déterministes du diagnostic non plus. En voici la liste, implémentée dans `packages/diagnostic` :

| Constat | Détecteur |
| --- | --- |
| `task_without_owner` | Tâche sans responsable |
| `paper_or_email_transfer` | Flux de canal `paper` ou `email` |
| `rekeying` | Même champ saisi en entrée par au moins deux activités d'acteurs différents, sans outil commun |
| `single_person_dependency` | Acteur seul R sur une chaîne critique sans suppléant (règle simple) |
| `useless_validation_loop` | Cycle passerelle–révision–retour de plus de deux niveaux |
| `missing_traceability` | Décision sans sortie documentée |

### 4.5 Provenance et vérification des citations

1. **Les sources sont immuables.** Un texte libre est figé à chaque « Analyser » (`revision + 1`). Un document est stocké avec son empreinte sha256. Son texte extrait est découpé en morceaux avec des localisateurs (page, feuille et cellule, paragraphe, positions de caractères).
2. **L'IA doit citer.** Tout candidat de statut `extracted` porte une citation `quote` et un `chunkId`.
3. **Le serveur vérifie la citation.** Après normalisation (espaces, apostrophes et guillemets typographiques, casse, Unicode NFC), la citation doit être une sous-chaîne du morceau. Le serveur calcule alors `charStart` et `charEnd`.
   - Si la vérification échoue, le candidat est **rétrogradé** en `hypothesis`, avec la justification « citation non retrouvée dans la source » et un compteur de qualité dans `ai_calls`.
4. **Pas de source, pas de fait.** Une proposition sans source identifiable reçoit l'origine `ai_knowledge` et s'affiche « connaissance générale de l'IA », jamais comme un fait (CDC 6.4).
5. **L'interface rend la source visible.** Chaque élément affiche ses citations ; un clic ouvre la visionneuse de source au bon endroit, avec le passage surligné.
6. **Les documents sont des données, pas des instructions.** Leur contenu est encadré par des balises délimitant les documents, et le prompt système interdit de suivre des instructions qui s'y trouvent. Les sorties sont contraintes par un schéma, et aucune action n'est exécutée par l'IA. Le risque d'injection de prompt est donc limité à des propositions erronées, qui restent soumises à décision humaine.

### 4.6 Extraction de texte des documents (`packages/ingest`) [HORS-CDC]

| Format | Bibliothèque | Localisateur |
| --- | --- | --- |
| PDF avec texte | `unpdf` (pdf.js) | page et positions |
| PDF scanné ou image (PNG, JPG) | Fournisseur IA (`extraction.document_visual`) si la capacité `documents` est présente ; sinon statut « non lisible », signalé | page |
| DOCX | `mammoth` (texte brut et titres) | paragraphe |
| XLSX | `exceljs` | feuille et cellule ; une ligne de tableau forme un bloc |
| TXT, MD | lecture directe | ligne |

Limites : 50 Mo par fichier ; type vérifié par signature (`file-type`) et non par l'extension. L'analyse antivirus (ClamAV) est optionnelle **[PO-24]**.

---

## 5. Coédition avec Yjs

### 5.1 Ce qui est partagé

La modification de la cartographie passe uniquement par le dialogue (CDC 4.2). L'interface n'offre pas d'éditeur graphique. La coédition porte donc sur trois choses :

| Document Yjs | Contenu | Écriture |
| --- | --- | --- |
| `mission:<id>:model` | Reflet de la **tête de version** du modèle : `Y.Map` `elements` (clé : `ElementId`, valeur : JSON de l'élément), `Y.Map` `meta` (`version`, auteur, date) | **Serveur uniquement.** Les clients se connectent en lecture seule (`connection.readOnly = true` dans Hocuspocus) |
| `mission:<id>:workspace` | `Y.XmlFragment` `description` : texte du métier, éditeur TipTap avec l'extension Collaboration **[HORS-CDC]** ; `Y.Map<Y.Text>` `notes` : notes de travail par élément ; `Y.Map` `drafts` : brouillons de consignes de dialogue par utilisateur | Responsable de mission et consultants membres |
| Présence (awareness, non persistée) | Utilisateurs connectés, vue et élément sélectionnés, « en train de préparer une modification sur P04.2 », « en train de répondre à la question Q-12 » | Tous les membres (sauf le validateur) |

Le fil de dialogue, les questions, les commentaires et les décisions **ne sont pas** dans Yjs. Ils sont stockés en base, qui en est l'autorité, et poussés en temps réel par des messages sans état (`broadcastStateless`) du document `model` : `model.version`, `proposal.updated`, `question.updated`, `comment.created`, `run.progress`, `notice.created`.

### 5.2 Persistance

- L'extension Database de Hocuspocus écrit l'état binaire Yjs dans `yjs_documents` (avec un délai de regroupement de 2 s, et au plus toutes les 10 s).
- Le document `model` est reconstructible à tout moment depuis `model_versions`. Son état persistant n'est qu'un cache.
- Le texte `description` devient une `Source` immuable chaque fois que l'utilisateur clique « Analyser ». La provenance ne pointe jamais vers du texte vivant.

### 5.3 Propagation des versions

1. L'API valide un `ChangeSet` dans une transaction : insertion dans `model_versions` et `model_version_elements`, mise à jour de `missions.head_version`, puis `pg_notify('mission_events', {missionId, version})`.
2. Le serveur collab, abonné par `LISTEN`, charge l'instantané et applique au `Y.Map` une **différence minimale** : uniquement les éléments ajoutés, modifiés ou retirés. Il diffuse ensuite `model.version`.
3. Objectif : la vue d'un autre consultant est à jour en moins de 2 s. Ce délai est testé en E2E.

### 5.4 Conflits entre modifications concurrentes, dont celles de l'IA

- **Toute écriture du modèle est une commande avec version de base**, qu'elle vienne d'une proposition `model.edit`, d'une décision sur une hypothèse ou du résultat d'un pipeline.
- **Concurrence optimiste.** Si la tête de version vaut toujours `baseVersion`, le changement est appliqué. Sinon, l'API tente un `rebase()` :
  - les éléments touchés (ou référencés) par le ChangeSet sont comparés aux éléments modifiés par les versions intermédiaires ;
  - si les ensembles sont disjoints, les opérations sont réappliquées sur la tête, la cohérence est revérifiée, et l'aperçu signale « adapté à la version N » ;
  - sinon, la proposition passe en `stale` et l'interface propose « Régénérer sur la version actuelle », qui relance le pipeline.
- **Décisions sur les hypothèses.** Si deux consultants décident du même élément, le second reçoit « déjà décidé par X ».
- **Pipelines longs** (extraction, diagnostic). Leur résultat est appliqué de la même façon que les autres changements. Les candidats qui portent sur des éléments modifiés entre-temps sont réconciliés à nouveau contre la tête, jamais écrasés.
- **Prévention.** La présence affiche qui prépare une modification sur quel processus. Il n'y a pas de verrou bloquant **[HORS-CDC]**.
- **Le validateur** n'utilise pas Yjs. Il lit des versions figées par REST et reçoit ses notifications.

---

## 6. Cartographie BPMN et exports

### 6.1 Le modèle canonique et la projection BPMN [PO-1]

Le CDC 4.1 dit « le modèle est stocké en BPMN 2.0 ». Ce document propose une autre organisation :

- le **modèle métier JSON est canonique** : un seul modèle pour les 3 étapes (CDC 3.3), qui porte la provenance, les statuts et les données que le BPMN ne sait pas représenter ;
- le **BPMN 2.0 XML est produit de façon déterministe à chaque version**. Il est stocké comme artefact (`artifacts`, `kind = bpmn`) et exportable.

Les identifiants BPMN sont dérivés des `ElementId` : `Activity_<uuid sans tirets>`. Chaque élément porte aussi l'attribut d'extension `processia:elementId` (espace de noms `urn:processia:bpmn:1`), que les autres outils ignorent. La correspondance dans les deux sens est donc exacte.

Cette solution respecte l'intention du CDC (stocker et exporter du BPMN 2.0 standard) sans dédoubler la source de vérité. **Elle doit être validée par le PO.**

### 6.2 Correspondance entre niveaux et BPMN (`packages/bpmn`)

| Niveau | Diagramme | Contenu BPMN |
| --- | --- | --- |
| 0 | `L0` | Processus « Cartographie globale ». Une `callActivity` par macroprocessus, regroupée par `macroCategory` (`group`). Une `sequenceFlow` par `process_link` de nature `sequence` ; les autres liens sont des `association` avec une `textAnnotation` |
| 1 | `L1:<macro>` | Processus avec un couloir (`lane`) par acteur impliqué, et une `callActivity` par processus (`calledElement` = processus L2). Les enchaînements entre processus suivent l'ordre (`order`) ou les flux |
| 2 | `L2:<process>` | `collaboration` : un participant « Organisation » avec un couloir par acteur interne, et un participant fermé (black box) par acteur externe ou système tiers. Tâches typées : `userTask`, `manualTask`, `serviceTask` (automatique), `sendTask` (flux sortant) ; agent IA = `serviceTask` avec une extension. Passerelles, événements de début, de fin, temporisés et de bord pour les exceptions. `messageFlow` pour les `information_flow`. `dataObjectReference` avec les associations d'entrée et de sortie. `documentation` avec les règles applicables |
| 3 | `L3:<task>` | `subProcess` développé (ou processus dédié) : étapes, objets de données avec leurs champs dans la documentation, règles en annotations, exceptions en événements de bord |

**Mise en page** : `elkjs` (algorithme en couches, partitions par couloir), puis production de BPMN DI **[HORS-CDC, risque R-4]**.
- Les positions sont mémorisées dans `BusinessModel.layout` à l'aide d'opérations `set_layout` de cause `layout`, sans effet sur les statuts.
- Un nouveau rendu réutilise les positions des éléments inchangés et ne place que les nouveaux, ce qui garde des diagrammes stables d'une version à l'autre.
- `bpmn-auto-layout` (bpmn-io) ne gère pas les couloirs et sert seulement de solution de repli pour les niveaux 0 et 1.

**Construction et validation**
- Le XML est construit avec `bpmn-moddle` (MIT), complété d'un descripteur moddle pour l'extension `processia`.
- En test, chaque XML produit est validé contre le **XSD BPMN 2.0 de l'OMG** (`xmllint --schema`, libxml2 en CI) et importé par `bpmn-js` dans Playwright, sans avertissement d'import.

**Export BPMN XML.** Un ZIP contient :
- un fichier `.bpmn` **par diagramme**, chacun avec ses propres `definitions` et son DI. Beaucoup d'outils n'affichent que le premier diagramme d'un fichier ;
- un fichier combiné `cartographie-complete.bpmn`.

L'outil cible pour la vérification d'interopérabilité est Camunda Modeler, ainsi que demo.bpmn.io **[PO-20]**.

### 6.3 Vues dans l'interface (CDC 2.3, 4.1)

- **Vue BPMN complète (mode expert)** : `bpmn-js` `NavigatedViewer`, en lecture seule ; le module de modélisation n'est pas chargé.
  - Clic sur une `callActivity` : on descend au niveau inférieur. Un fil d'Ariane L0 › L1 › L2 › L3 permet de remonter.
  - Un panneau latéral affiche les entrées, les sorties, l'acteur responsable, les règles, les indicateurs, le statut et les sources.
  - Des marqueurs signalent les hypothèses (contour pointillé), les éléments modifiés dans un aperçu (ajout en vert, suppression en rouge, modification en orange) et les constats.
- **Vue simplifiée (mode simple et validateur)** : composant React (HTML et SVG) produit à partir du modèle **[HORS-CDC]**.
  - Étapes en cartes, regroupées par acteur, avec des flèches. Les décisions sont présentées comme des questions avec leurs branches. Pas de notation BPMN.
  - Le PO valide ce rendu sur maquette [PO-17].
- **Alternative textuelle accessible (RGAA)** pour chaque diagramme : un tableau ou une liste structurée (étapes ordonnées, acteur, entrées et sorties, décisions et branches), navigable au clavier et liée à la sélection. Un canevas BPMN n'est pas accessible aux lecteurs d'écran ; cette alternative est donc obligatoire.

### 6.4 Exports (CDC 3.5, 4.8) [HORS-CDC pour les bibliothèques]

| Format | Bibliothèque | Contenu (incrément 1) |
| --- | --- | --- |
| **Word** | `docx` (MIT) | **Dossier d'analyse** : fiche métier et glossaire, acteurs et RACI, dictionnaire de données et flux, registre des règles. Chaque élément porte son statut et ses sources, les références sont en annexe. **Rapport de mission** : analyse, AS-IS (diagrammes L0, L1 et L2 en images), diagnostic, TO-BE (optimisations, décisions, matrice), gains avec leurs hypothèses de calcul |
| **PDF** | Gabarits HTML (rendus côté serveur avec React) imprimés par **Playwright / Chromium** (`page.pdf` avec titres et signets ; PDF balisé) | Mêmes contenus que le Word |
| **Excel** | `exceljs` (MIT) | Feuilles : RACI, dictionnaire de données (objets et champs), flux, registre des règles, glossaire, liste des optimisations (constat, gain, effort, dépendances, décision) |
| **BPMN XML** | `bpmn-moddle` | ZIP (voir 6.2) |
| Images des diagrammes | `bpmn-js` dans Chromium headless (`saveSVG`), puis `@resvg/resvg-js` pour le PNG | Intégrées au Word et au PDF |

- Les exports sont produits par une tâche asynchrone du worker, stockés dans S3 (`artifacts`) et liés à une `modelVersion`.
- Un export joint à une soumission est figé, avec son empreinte sha256.
- Les exports d'un livrable passent toujours par `deliverableView` : **aucune hypothèse n'y figure** (CDC 3.4).
- Les textes des exports proviennent du catalogue i18n.
- L'image Docker du worker embarque Chromium. Elle est déjà nécessaire pour les tests E2E.

---

## 7. Lots de travail (WP)

Chaque WP doit tenir dans une session d'agent (environ 300 à 2 000 lignes). Les tests d'acceptation sont automatisés, sauf mention « manuel ».

**Règles communes à tous les WP**
- Lint, typecheck et tests sont verts.
- Aucun texte d'interface n'est écrit en dur : la règle `i18next/no-literal-string` est active dans `apps/web` et `packages/ui`.
- Toute page nouvelle est couverte par un test axe-core (aucune violation `serious` ou `critical`).
- `docs/wp/TRACKER.md` et `docs/wp/WP-XX.md` sont mis à jour.

**Jalon PO avant WP-07 et avant les WP d'écrans** : maquettes basse fidélité des écrans de l'incrément 1, à valider (CDC 12.4 §4) [PO-17]. Les WP-01 à 06 et 08 à 12 n'en dépendent pas.

---

### WP-01 Socle du monorepo, outillage, CI, docker compose, documentation

- **Dépend de** : rien.
- **Objectif** : un dépôt prêt pour les agents, où toute la chaîne qualité tourne.
- **Périmètre**
  - pnpm workspaces et Turborepo ; `packages/config` (tsconfig strict, ESLint avec frontières entre paquets, Prettier, schéma zod des variables d'environnement).
  - Squelettes : `apps/web` (page d'accueil i18n « Processia »), `apps/api` (`GET /health` qui vérifie la base et S3 ; entrée `worker.ts` vide), `apps/collab` (serveur Hocuspocus minimal), paquets vides avec `index.ts` et un test.
  - Vitest à la racine ; Playwright (`e2e/`) avec un test de fumée.
  - `docker-compose.yml` : postgres:17 (base `processia` et `processia_test`), minio (et création des buckets), mailpit. Profil `apps` avec des Dockerfiles de développement.
  - `.env.example` ; `.github/workflows/ci.yml` : installation, lint, typecheck, tests unitaires, tests d'intégration avec les services postgres et minio, build, E2E de fumée.
  - `CLAUDE.md`, `docs/wp/TRACKER.md` (avec tous les WP de ce document), `docs/dev/CONVENTIONS.md`, `docs/dev/RUNBOOK.md`, `docs/po/DECISIONS.md` (PO-1 à PO-n de la section 8).
  - ADR 0001 à 0010 reprenant les choix [HORS-CDC] de ce document : monorepo, modèle canonique JSON, Drizzle et RLS, Hocuspocus, pg-boss, fournisseur factice, bibliothèques d'export, sessions et TOTP, elkjs, React Aria.
- **Interfaces exposées** : scripts `pnpm dev | lint | typecheck | test | test:int | e2e | db:migrate | db:reset`.
- **Acceptation**
  1. `pnpm i && pnpm lint && pnpm typecheck && pnpm test && pnpm build` sont verts.
  2. `docker compose up -d` : tous les services sont sains ; `curl :3001/health` renvoie `{db:"ok",s3:"ok"}`.
  3. L'E2E de fumée affiche « Processia » et passe axe-core.
  4. Le workflow CI est valide (`actionlint`).
- **Note** : il n'existe pas encore de dépôt distant ; la CI ne s'exécutera qu'après sa création [PO-16].

### WP-02 Méta-modèle : schémas et types

- **Dépend de** : WP-01.
- **Objectif** : implémenter la section 2 en zod, dans `packages/model`.
- **Périmètre** :
  - `src/schema/*.ts` (un fichier par concept), `src/ids.ts`, `src/catalog/engine-capabilities.fr.json` ;
  - fabriques de test (`buildActor()`, …) et `fixtures/minimal-model.json` ;
  - script d'export du JSON Schema ;
  - `migrations/index.ts` (cadre seulement, version 1) ;
  - `README.md` du paquet.
- **Interfaces exposées** : types et schémas `BusinessModel`, `Element` (union discriminée), `ChangeSet`, `ModelOp`, `ValidationSubmission`, etc. ; `parseModel(json)`.
- **Acceptation**
  1. Un modèle d'exemple qui couvre tous les types d'éléments est valide.
  2. Des modèles invalides sont rejetés avec un chemin d'erreur : `extracted` sans référence, `ai_knowledge` sans justification, activité sans parent (hors `macro`), optimisation sans constat.
  3. Le JSON Schema exporté valide les mêmes jeux (avec ajv).
  4. Couverture de tests d'au moins 90 % sur `schema/`.

### WP-03 Opérations sur le modèle : ChangeSet, cohérence, complétude, vues

- **Dépend de** : WP-02.
- **Objectif** : toute la logique pure de transformation du modèle.
- **Périmètre** : `applyChangeSet`, résolution des identifiants temporaires, attribution des codes, intégrité référentielle, `transitionStatus`, `diffModels`, `rebase`, `checkCoherence`, `completeness`, `deliverableView`, `raciMatrix`, `applyDecision` (cascade), `composeToBe`, détection des conflits entre optimisations.
- **Acceptation** : tests unitaires table par table.
  - Chaque transition de statut, autorisée ou interdite.
  - Une suppression référencée est refusée.
  - Un `rebase` réussit sur des ensembles disjoints et échoue en cas de conflit.
  - Chaque code de cohérence est déclenché par un cas minimal.
  - La complétude d'un modèle vide vaut 0, celle du modèle complet de test vaut 1.
  - Cascade : chaîne A←B←C, refuser A refuse B et C ; diamant ; acceptation sous réserve ; détection de cycle.
  - `composeToBe` respecte l'ordre topologique.
  - `deliverableView` ne contient jamais d'hypothèse (test de propriété avec fast-check).

### WP-04 Base de données, migrations et cloisonnement par RLS

- **Dépend de** : WP-01.
- **Périmètre** :
  - `packages/db` : schéma Drizzle de toutes les tables de 3.2, migrations, rôles `processia_owner` et `processia_app`, politiques RLS ;
  - `withMission()` et `withoutMission()` (pour les tables non cloisonnées) ;
  - seed de développement : un administrateur, un responsable de mission, deux consultants, un validateur, un client et une mission « Cabinet pilote » ;
  - aides de test : réinitialisation de la base de test et transactions.
- **Acceptation**
  1. `pnpm db:migrate` est idempotent.
  2. Sans `app.mission_id`, un SELECT sur chaque table cloisonnée renvoie 0 ligne (test paramétré sur toutes ces tables).
  3. Avec la mission A, aucune ligne de la mission B n'est visible ni modifiable.
  4. L'unicité du validateur par mission est imposée.
  5. Insertion et lecture d'un instantané JSONB de 2 Mo en moins de 500 ms en local (indicatif).

### WP-05 Authentification et double authentification

- **Dépend de** : WP-04.
- **Périmètre** :
  - `AuthModule` : invitations (email Mailpit), création du mot de passe, connexion, enrôlement TOTP (QR code et saisie manuelle), codes de secours, sessions en base, CSRF, limitation de débit, déconnexion, journal ;
  - garde globale « session avec double authentification exigée » ;
  - contrats dans `packages/contracts/auth`.
- **Interfaces exposées** : `POST /auth/login`, `POST /auth/mfa/verify`, `POST /auth/mfa/enroll`, `POST /auth/mfa/confirm`, `POST /auth/recovery`, `POST /auth/logout`, `POST /invitations/:token/accept`, `GET /me`.
- **Acceptation** (tests d'intégration)
  1. Sans double authentification, toute route métier renvoie 401 avec le code `MFA_REQUIRED`.
  2. Un TOTP valide ouvre la session ; un TOTP rejoué ou expiré est refusé.
  3. Un code de secours n'est utilisable qu'une fois.
  4. Six échecs de connexion bloquent le compte temporairement.
  5. Un POST sans jeton CSRF renvoie 403.
  6. Un lien d'invitation est utilisable une seule fois et expire.
  7. Les cookies portent HttpOnly, Secure et SameSite=Strict.

### WP-06 Droits, clients, missions, affectations, configuration IA par client

- **Dépend de** : WP-05.
- **Périmètre** :
  - `packages/policy` (matrice 3.5) ;
  - `PolicyModule` (`@Can()`, `MissionGuard`, `MissionContext`) ;
  - `ClientsModule`, `MissionsModule` (création, affectation, phase, liste de suivi avec avancement : phase, complétude, soumissions en attente), `UsersModule` (administration) ;
  - `ai_provider_configs` (création et modification par l'administrateur, chiffrement AES-256-GCM de la clé avec `MASTER_KEY`, affichage et acceptation de la politique de données, contrôle des capacités).
- **Acceptation**
  1. Test table par table de `can()` sur toutes les cellules de la matrice 3.5.
  2. Tests d'intégration : un consultant non affecté reçoit 404 (et non 403, pour ne rien révéler) sur une mission ; le validateur ne voit que sa mission ; l'administrateur ne peut pas appeler `model.edit`.
  3. La clé API n'est jamais renvoyée par l'API (masquée) et elle est chiffrée en base.
  4. Avertissement de capacité si le fournisseur n'a pas `documents`.

### WP-07 Coquille web : mise en page, i18n, composants accessibles, écrans de base

- **Dépend de** : WP-06 et le jalon des maquettes [PO-17].
- **Périmètre** :
  - `packages/ui` : React Aria Components avec un thème (contrastes AA), boutons, champs, dialogues, onglets, tableaux, badges de statut, toasts, lien d'évitement ;
  - `packages/i18n` : `next-intl`, `fr.json`, clés typées ;
  - mise en page de l'application (navigation, en-tête mission, sélecteur mode simple / mode expert, centre de notifications vide) ;
  - pages : connexion, double authentification, enrôlement, acceptation d'invitation, liste et création des missions, affectations, administration (utilisateurs, clients, fournisseur IA) ;
  - client API typé (`packages/contracts`) ; bandeau « IA simulée ».
- **Acceptation**
  1. E2E Playwright : invitation, puis enrôlement TOTP (secret lu en mode test), connexion, création de mission, affectation de deux consultants et d'un validateur.
  2. axe-core sans violation `serious` ou `critical` sur chaque page ; navigation au clavier complète (test du parcours avec Tab).
  3. Aucun texte en dur (lint).
  4. `lang="fr"`, titres de page uniques.

### WP-08 Persistance versionnée du modèle, historique, retour arrière

- **Dépend de** : WP-03, WP-06.
- **Périmètre** : `ModelModule`.
  - `commitChangeSet(missionId, cs, author)` : transaction, contrôle optimiste et rebasage, instantané, index par élément, `pg_notify`, création des `post_validation_notices` quand un élément `validated` est modifié.
  - Lecture : tête de version, version donnée, différence entre deux versions, historique d'un élément ; retour arrière.
  - `change_proposals` : création, aperçu, application, abandon, passage en `stale`.
- **Interfaces exposées** : `GET /missions/:id/model?version=`, `GET /missions/:id/model/versions`, `GET /missions/:id/model/diff?from&to`, `GET /missions/:id/elements/:eid/history`, `POST /missions/:id/model/rollback {toVersion}`, `POST /missions/:id/proposals/:pid/apply`, `POST /missions/:id/proposals/:pid/discard`. Service interne `ModelService.commit()` utilisé par les autres modules.
- **Acceptation**
  1. Deux commits concurrents sur des éléments disjoints : les deux réussissent (rebasage).
  2. Deux commits sur le même élément : le second renvoie `409 STALE`.
  3. Le retour arrière crée la version N+1 avec le contenu de K.
  4. Modifier un élément `validated` fait passer l'élément à `confirmed`, crée un signalement et une notification au validateur.
  5. L'historique d'un élément liste exactement les versions qui l'ont touché.

### WP-09 Couche IA : interface, fournisseur factice, Anthropic, exécuteur, journal, budget

- **Dépend de** : WP-02, WP-06.
- **Périmètre** :
  - `packages/ai` : `AiProvider`, `FakeProvider` (enregistrements, scénarios, repli, simulation d'erreurs, mode enregistrement), `AnthropicProvider` (4.3), `runPipeline` (validation, contrôle sémantique, une reprise de réparation, journal, budget, estimation du coût), chargeur de prompts `.fr.md` ;
  - `AiModule` côté API : registre par client, écriture dans `ai_calls`, garde de budget.
- **Acceptation**
  1. Avec un pipeline de démonstration et le fournisseur factice : la sortie est validée et journalisée.
  2. JSON hors schéma : une reprise, puis l'erreur typée.
  3. Budget dépassé : l'appel est bloqué.
  4. Adaptateur Anthropic contre un serveur HTTP simulé : forme de la requête (`output_config.format`, modèle configuré, pas de prefill ni de `tool_choice` forcé) ; refus mappé à `AiRefusalError` ; `max_tokens` déclenche une reprise ; 429 donne lieu à une reprise du SDK.
  5. Aucun test ne fait d'appel réseau réel (garde-fou : échec si `ANTHROPIC_API_KEY` est lue en CI sans `AI_LIVE=1`).
  6. Script `pnpm ai:smoke` : un appel réel minimal, seulement si une clé est présente (manuel).

### WP-10 Coédition : serveur Hocuspocus et intégration web

- **Dépend de** : WP-07, WP-08.
- **Périmètre** :
  - `apps/collab` : authentification par JWT court, revérification de l'appartenance, documents `model` (lecture seule) et `workspace`, persistance dans `yjs_documents`, `LISTEN mission_events` avec différence minimale sur le `Y.Map`, messages sans état ;
  - API : `POST /missions/:id/collab-token` ;
  - web : fournisseur `HocuspocusProvider`, hook `useMissionModel()` (lecture du `Y.Map` sous forme de `BusinessModel`), barre de présence (avatars, alternative textuelle), éditeur TipTap partagé pour la description, hook `useMissionEvents()`.
- **Acceptation**
  1. Test d'intégration avec deux clients Yjs Node : des éditions concurrentes de la description convergent.
  2. Une écriture client sur le document `model` est rejetée.
  3. Un commit par l'API déclenche, en moins de 2 s, la mise à jour du `Y.Map` et le message `model.version` chez les deux clients.
  4. Un jeton expiré ou un utilisateur non membre est refusé.
  5. Le validateur ne peut pas se connecter au document `workspace`.
  6. E2E avec deux navigateurs : présence visible et texte partagé.

### WP-11 Sources : dépôt, stockage S3, extraction de texte, découpage, file de tâches

- **Dépend de** : WP-08, WP-09.
- **Périmètre** :
  - `packages/ingest` (4.6) ;
  - `SourcesModule` : dépôt multipart, vérification du type, sha256, S3, `sources` et `source_chunks` ;
  - figer la description Yjs en source `free_text` ;
  - `JobsModule` avec pg-boss : tâche `ingest.document` dans le worker ;
  - progression diffusée par `run.progress` ;
  - visionneuse de source (API : morceau avec surlignage par `charStart` et `charEnd`).
- **Acceptation**
  1. Les jeux de test PDF, DOCX, XLSX et image donnent des morceaux avec des localisateurs corrects (page, feuille et cellule, paragraphe).
  2. Un PDF image sans fournisseur doté de `documents` reçoit le statut « non lisible », signalé.
  3. Un fichier de plus de 50 Mo ou un type falsifié est refusé.
  4. Une seconde soumission de la même description crée une révision 2, et la révision 1 reste lisible.
  5. Une URL présignée expire en 5 minutes et n'est délivrée qu'après la garde.

### WP-12 Extraction, réconciliation, écarts ; scénario factice du pilote

- **Dépend de** : WP-11.
- **Périmètre** :
  - pipelines `extraction.chunk`, `extraction.document_visual` et `reconcile` (prompts, schémas, contrôles sémantiques) ;
  - vérification et rétrogradation des citations (4.5) ;
  - conversion déterministe des candidats en ChangeSet ;
  - job `analysis.extraction` et table `analysis_runs` ;
  - **scénario factice du pilote** dans `packages/test-fixtures` : texte du CDC 8 (8.1 à 8.5) sous la forme d'une description consultant, et sorties scriptées des pipelines produisant le modèle d'analyse du pilote.
- **Acceptation**
  1. Avec le fournisseur factice, sur la description du pilote, le modèle produit contient :
     - les 14 macroprocessus P01 à P14 (statut `extracted`, citations vérifiées), avec leur `scope` conforme au CDC 8.2 ;
     - les 8 acteurs du CDC 8.3 et 4 parties prenantes externes ;
     - les activités principales du CDC 8.2 rattachées comme processus ;
     - au moins un écart quand on injecte un second document contradictoire du jeu de test.
  2. Une citation altérée est rétrogradée en hypothèse.
  3. Relancer l'extraction sur la même source ne crée pas de doublons (réconciliation).
  4. Chaque élément créé a une provenance valide (validation du schéma sur la version produite).

### WP-13 Espace « Analyse » (interface)

- **Dépend de** : WP-10, WP-12.
- **Périmètre** :
  - page `/missions/[id]/analyse` : zone de description partagée, dépôt de documents (liste, statut d'extraction), bouton « Analyser » avec progression ;
  - onglets par concept (Métier, Acteurs, Activités, Données, Flux, Règles, Indicateurs, Écarts) : listes et fiches d'élément avec badge de statut (texte et icône, jamais la couleur seule), origine, citations cliquables vers la visionneuse ;
  - **indicateur de complétude par concept**, avec la liste des manques ;
  - historique des versions (liste, différences, retour arrière).
- **Acceptation**
  1. E2E sur le pilote : saisie de la description, « Analyser », puis affichage des 14 macroprocessus et des 8 acteurs, avec des citations qui ouvrent la source surlignée.
  2. Complétude affichée pour les 7 concepts.
  3. Un second consultant voit apparaître la nouvelle version sans recharger la page.
  4. axe-core passe.

### WP-14 Questionnement guidé et hypothèses

- **Dépend de** : WP-13.
- **Périmètre** :
  - pipelines `questions`, `answer.integrate`, `hypotheses` et `deliverable.summary` (avec leurs scénarios factices pour le pilote) ;
  - questions classées ;
  - interface « Une question à la fois » (question, raison, éléments concernés, répondre, passer, « arrêter le questionnement ») ;
  - revue des hypothèses : file avec accepter, corriger, rejeter et la justification affichée ; correction par petit formulaire sur les attributs textuels, ou par dialogue [PO-5] ;
  - archive des hypothèses rejetées, qui ne sont pas reproposées.
- **Acceptation**
  1. Sur le pilote, la première question proposée a le `blockingScore` le plus élevé.
  2. Une réponse crée une source `answer` et des éléments `extracted` qui la citent.
  3. Accepter une hypothèse la fait passer à `confirmed` (`decidedBy`) ; rejeter la retire du modèle et l'archive ; relancer `hypotheses` ne repropose pas une hypothèse rejetée (contrôle sémantique).
  4. Décisions concurrentes sur la même hypothèse par deux consultants : le second reçoit « déjà décidé ».
  5. La complétude augmente après les réponses.

### WP-15 Livrables de l'étape 1 et moteur d'exports (Word, PDF, Excel)

- **Dépend de** : WP-14.
- **Périmètre** :
  - `packages/exports` : cadre de rendu (données issues de `deliverableView` et i18n, avec un adaptateur par format), dossier d'analyse en DOCX (`docx`), en XLSX (`exceljs`) et en PDF (gabarit HTML et Playwright dans le worker) ;
  - `ExportsModule` : tâche asynchrone et artefacts ;
  - page « Livrables » : aperçu HTML des 4 livrables, dont la matrice RACI accessible (`<table>` avec en-têtes de lignes et de colonnes) ;
  - Dockerfile du worker avec Chromium.
- **Acceptation**
  1. Sur le modèle du pilote (après confirmation des hypothèses dans le scénario), le DOCX contient les 4 sections, le RACI et les sources en annexe (vérifié en relisant le DOCX avec `mammoth`).
  2. Le XLSX contient les feuilles attendues avec les en-têtes i18n (relu avec `exceljs`).
  3. Le PDF a des signets et du texte extractible (`unpdf`).
  4. Une hypothèse non confirmée n'apparaît dans aucun des 3 formats (test explicite).
  5. L'artefact est lié à la version et porte son empreinte sha256.

### WP-16 Circuit de validation, portail du validateur, commentaires, validation du dossier, signalements

- **Dépend de** : WP-15.
- **Périmètre** :
  - `ValidationModule` (générique pour `analysis_dossier`, `as_is` et `to_be`) : soumettre (version figée, exports joints, liste des hypothèses exclues affichée au consultant), retirer, remplacer, valider ;
  - à la validation : ChangeSet `validation` qui fait passer en `validated` les éléments inclus, et transition de phase ;
  - `CommentsModule` : fils de discussion par élément ou par soumission, temps réel ;
  - portail du validateur `/missions/[id]/validation` : vue simplifiée en lecture seule de la version soumise, commentaires, bouton « Valider le dossier » avec confirmation, téléchargement des exports ;
  - notifications in-app et email : soumission, signalements après validation ;
  - garde de phase sur les routes de cartographie.
- **Acceptation**
  1. E2E : un consultant soumet ; le validateur (seul compte client) consulte, commente et valide ; les éléments passent à `validated` et la phase à `mapping`.
  2. Avant la validation, les routes de cartographie renvoient `409 PHASE_LOCKED`.
  3. Modifier ensuite un élément validé crée un signalement visible du validateur et un email dans Mailpit.
  4. Le validateur ne voit aucune hypothèse et ne peut appeler aucune route `model.edit` (403).
  5. Une nouvelle soumission passe la précédente à l'état `superseded`.

### WP-17 Construction des enchaînements des processus (niveaux 2 et 3)

- **Dépend de** : WP-16.
- **Périmètre** :
  - pipeline `process.flow` par processus, pour tous ou à la demande : événements, passerelles et règles de décision, enchaînements, étapes de niveau 3 pour les tâches détaillées ;
  - job par lot avec progression ;
  - scénario factice du pilote : enchaînement plausible pour les processus de P01 à P14 et niveau 3 pour l'exemple CDC 4.1 « Relance des pièces manquantes » (P04) ;
  - revue des hypothèses réutilisée (WP-14).
- **Acceptation**
  1. Sur le pilote validé, chaque processus a un début, une fin et aucun `DEAD_END_BRANCH`.
  2. Les nouveaux éléments ont le statut `hypothesis` et une justification.
  3. P04 « Relance des pièces manquantes » possède un niveau 3 avec ses champs, délais et destinataires (indicateurs et règles).

### WP-18 Génération BPMN 2.0 sur 4 niveaux et mise en page

- **Dépend de** : WP-17 (pour les jeux de test réalistes ; peut démarrer après WP-03 sur le modèle minimal).
- **Périmètre** :
  - `packages/bpmn` : correspondance de 6.2, extension moddle `processia`, mise en page elkjs avec couloirs, réutilisation des positions mémorisées, production de la DI, ZIP d'export ;
  - `CartographyModule` : production et mise en cache des BPMN par version et par diagramme ;
  - **spike d'une journée** au début du WP pour la mise en page des couloirs : si le résultat est insuffisant, solution de repli documentée en ADR.
- **Interfaces exposées** :
  ```ts
  toBpmn(model: BusinessModel, diagram: DiagramId): { xml: string; layoutOps: ModelOp[] }
  listDiagrams(model: BusinessModel): DiagramId[]
  ```
  Côté API : `GET /missions/:id/bpmn/:diagramId?version=` et `GET /missions/:id/exports/bpmn.zip`.
- **Acceptation**
  1. Tous les diagrammes du pilote sont valides contre le XSD BPMN 2.0 de l'OMG (`xmllint`, en CI).
  2. Ils s'importent dans `bpmn-js` (test Playwright) sans avertissement.
  3. Ajouter une tâche puis refaire le rendu ne déplace pas plus de 10 % des formes existantes (stabilité).
  4. Correspondance exacte : chaque élément du modèle d'un diagramme a exactement une forme portant `processia:elementId`.
  5. Le ZIP contient un fichier par diagramme et le fichier combiné.

### WP-19 Interface de cartographie : visionneuse, navigation, vue simplifiée, alternative textuelle

- **Dépend de** : WP-18, WP-10.
- **Périmètre** :
  - page `/missions/[id]/cartographie` : `NavigatedViewer`, fil d'Ariane L0 à L3, descente par clic et par clavier, panneau de l'élément sélectionné (entrées, sorties, responsable, règles, statut, sources, commentaires) ;
  - marqueurs (hypothèses, constats) ;
  - **vue simplifiée** en mode simple et pour le validateur ;
  - **alternative textuelle** synchronisée ;
  - mise à jour en direct à chaque `model.version`.
- **Acceptation**
  1. E2E : navigation L0, puis P04, puis le processus de relance, puis le niveau 3.
  2. La vue simplifiée et l'alternative textuelle listent les mêmes étapes que le BPMN (test de cohérence).
  3. axe-core passe sur les vues simplifiée et textuelle ; toutes les fonctions sont utilisables au clavier.
  4. La modification faite par un consultant apparaît chez l'autre en moins de 2 s.

### WP-20 Modification par dialogue

- **Dépend de** : WP-19.
- **Périmètre** :
  - pipeline `model.edit` : contexte réduit au processus visé, gestion des questions de clarification, scénarios factices pour au moins 6 consignes types (ajouter une validation après X, déplacer une tâche vers un autre acteur, ajouter une exception de relance, supprimer une étape, renommer, changer un indicateur) ;
  - `DialogueModule` (fil de dialogue en base) ;
  - interface de dialogue : saisie, historique, **aperçu avant enregistrement** (différences en texte et diagrammes avant/après avec marqueurs), incohérences créées (CDC 4.2), boutons « Appliquer » et « Abandonner » ;
  - gestion de `stale` avec « Régénérer » ;
  - historique et retour arrière depuis la cartographie.
- **Acceptation**
  1. E2E : « ajoute une validation par le chef de mission après la révision ». L'aperçu montre une tâche ajoutée dans le couloir « Chef de mission » et des enchaînements modifiés. « Appliquer » crée la version N+1 et redessine le niveau 2 concerné.
  2. Une consigne qui crée une tâche sans responsable affiche `ACTIVITY_WITHOUT_OWNER` dans l'aperçu.
  3. Deux consultants appliquent des propositions sur le même élément : le second reçoit l'état `stale`.
  4. Le retour arrière restaure le diagramme précédent.
  5. Aucune modification n'est enregistrée sans clic sur « Appliquer ».

### WP-21 Validation de l'AS-IS et diagnostic

- **Dépend de** : WP-20.
- **Périmètre** :
  - soumission `as_is` (réutilise WP-16, avec vues de cartographie dans le portail) ;
  - transition vers la phase `transformation` ;
  - `packages/diagnostic` : détecteurs déterministes (4.4) ;
  - pipeline `diagnostic` (scénario factice du pilote : au moins un constat par famille) ;
  - page « Diagnostic » : constats par famille, localisation sur la cartographie (marqueur et lien), justification et sources, revue consultant (confirmer, rejeter, comme les hypothèses).
- **Acceptation**
  1. E2E : le validateur valide l'AS-IS ; le diagnostic n'est pas accessible avant (409).
  2. Chaque détecteur est couvert par un test unitaire positif et un négatif.
  3. Sur le pilote, au moins un constat par famille, chacun localisé sur au moins un élément visible sur la carte.
  4. Les constats IA ont le statut `hypothesis` ; les constats déterministes ont l'origine `deterministic_rule`.

### WP-22 Optimisations, gains, effort, dépendances, matrice gain × effort

- **Dépend de** : WP-21.
- **Périmètre** :
  - pipelines `optimisation.propose` et `gain.parameters` ;
  - `packages/diagnostic/gains.ts` et `ratios.fr.json` (catalogue de ratios standards avec leur source, à valider [PO-8]) ;
  - notes de gain et d'effort (4.4.3) ;
  - validation du graphe des dépendances et des conflits ;
  - page « TO-BE (préparation) » : liste des optimisations (constat, gain avec hypothèses de calcul dépliables, effort justifié, dépendances, éléments modifiés), avant/après de chaque optimisation (diagrammes L2 avec marqueurs), **matrice gain × effort** (SVG accessible et tableau équivalent, gains rapides mis en avant), confirmation par le consultant, puis soumission `to_be` ;
  - ajustements par dialogue (`model.edit` étendu aux attributs des optimisations).
- **Acceptation**
  1. Scénario du pilote : au moins 6 optimisations, dont une chaîne de dépendances A←B←C et une optimisation indépendante.
  2. Le calcul des gains est déterministe, avec des fourchettes et des hypothèses visibles (tests unitaires).
  3. Un cycle de dépendances bloque la soumission.
  4. Un conflit non déclaré bloque la soumission.
  5. La matrice et le tableau affichent les mêmes positions.
  6. axe-core passe.

### WP-23 Validation du TO-BE élément par élément, cascade, alternatives, recomposition

- **Dépend de** : WP-22.
- **Périmètre** :
  - portail du validateur, partie TO-BE : liste avec dépendances visibles, accepter ou refuser avec commentaire facultatif, **aperçu de la cascade avant confirmation**, état « accepté sous réserve », clôture ;
  - `optimisation_decisions` ;
  - après un refus direct : action consultant « Proposer une alternative » (pipeline `optimisation.alternative`, nouvelle manche) ;
  - à la clôture : `composeToBe`, version `to_be_composition`, BPMN du TO-BE.
- **Acceptation**
  1. E2E : le validateur accepte C puis refuse A ; la boîte de confirmation annonce le refus de B et C ; après confirmation, B et C sont `rejected` avec la cause `cascade` depuis A.
  2. Le consultant propose une alternative à A pour le même constat ; elle est soumise et acceptée en manche 2.
  3. La clôture recompose le TO-BE à partir des seules optimisations acceptées ; le BPMN du TO-BE est valide contre le XSD.
  4. Refuser une optimisation sans dépendante ne touche à rien d'autre.
  5. Les décisions sont tracées dans `audit_log`.

### WP-24 Rapport de mission, Excel complet, export BPMN, interopérabilité

- **Dépend de** : WP-23.
- **Périmètre** :
  - rapport de mission en DOCX et PDF (analyse, AS-IS avec images L0, L1 et L2, diagnostic, TO-BE, décisions, matrice, gains) ;
  - feuille Excel « Optimisations » ;
  - images des diagrammes (rendu par `bpmn-js` dans Chromium, puis `resvg`) ;
  - export BPMN AS-IS et TO-BE (ZIP) ;
  - page « Exports » ;
  - procédure manuelle d'ouverture dans Camunda Modeler et demo.bpmn.io, documentée dans `RUNBOOK.md`.
- **Acceptation**
  1. Le rapport DOCX contient les 5 parties et au moins un diagramme par niveau 0 à 2 (relecture du DOCX : présence des images et des titres).
  2. Le PDF a des signets.
  3. Le ZIP BPMN passe le XSD et l'import `bpmn-js`.
  4. **Manuel** : les fichiers s'ouvrent dans Camunda Modeler sans erreur (capture jointe au rapport de WP).

### WP-25 Durcissement : sécurité, accessibilité, conservation, images Docker

- **Dépend de** : WP-24.
- **Périmètre** :
  - en-têtes de sécurité (helmet, CSP de Next.js), revue des gardes sur toutes les routes (test automatique : chaque route déclare `@Can` ou `@Public`) ;
  - journalisation pino avec masquage (aucun contenu de mission ni de clé dans les logs) ;
  - `retention_until` par mission et purge manuelle par l'administrateur (suppression des lignes de la mission, des objets S3 et des documents Yjs ; seule une trace minimale reste dans `audit_log`) ;
  - passe d'accessibilité : focus visible, ordre de tabulation, annonces ARIA pour les progressions et le temps réel ;
  - Dockerfiles de production multi-étapes ; `docker-compose.prod.yml` pour la démonstration.
- **Acceptation**
  1. Un test énumère toutes les routes Nest et échoue si l'une n'a pas de politique déclarée.
  2. La purge d'une mission ne laisse aucune ligne cloisonnée ni aucun objet S3 sous son préfixe.
  3. axe-core passe sur toutes les pages de la suite E2E.
  4. `docker compose -f docker-compose.prod.yml up` démarre l'ensemble avec le fournisseur factice.

### WP-26 Test de bout en bout de l'acceptation de l'incrément 1

- **Dépend de** : WP-25.
- **Périmètre** :
  - scénario Playwright `e2e/acceptance/increment-1.spec.ts`, avec le fournisseur factice et les scénarios du pilote. Il reproduit le critère du CDC 11.2.
  - script `pnpm acceptance:live`, identique mais avec le fournisseur réel si une clé est configurée (manuel, coût estimé inférieur à 10 € par exécution).
  - rapport d'acceptation dans `docs/wp/WP-26.md`.
- **Scénario**
  1. L'administrateur crée le client, le fournisseur IA (factice) et les comptes. Le responsable de mission crée la mission et affecte les consultants A et B et le validateur V. Tous passent la double authentification.
  2. **A et B sont connectés en même temps** (deux contextes de navigateur). A saisit la description du pilote (CDC 8) pendant que B la complète : le texte converge. A dépose un document et lance l'analyse ; B voit la version apparaître.
  3. Questionnement : A répond à 3 questions ; B traite les hypothèses (accepter, corriger, rejeter).
  4. Livrables : les 4 livrables sont produits ; exports Word, PDF et Excel sans hypothèse ; soumission ; V commente puis valide le dossier.
  5. Enchaînements, puis **cartographie des 14 processus** (niveau 0 avec P01 à P14, niveau 1 de chaque macroprocessus, niveau 2 des processus, niveau 3 de l'exemple P04 [PO-2]). A modifie par dialogue ; B voit le redessin.
  6. Soumission de l'AS-IS ; V valide.
  7. Diagnostic, puis optimisations ; soumission du TO-BE. V accepte certaines optimisations, en **refuse une qui en entraîne d'autres** et vérifie la cascade. Le consultant propose une alternative ; V l'accepte ; V clôt.
  8. Export du BPMN (AS-IS et TO-BE) : validité XSD et import `bpmn-js` vérifiés automatiquement ; ouverture dans Camunda Modeler vérifiée manuellement.
- **Acceptation** : le scénario est vert en CI, en moins de 15 minutes ; axe-core passe sur chaque écran du parcours ; `pnpm acceptance:live` est exécuté au moins une fois avec une vraie clé, avec un compte rendu par le PO [PO-13].

### Récapitulatif des dépendances

```
01 ─► 02 ─► 03 ─┐
01 ─► 04 ─► 05 ─► 06 ─┬─► 07 (après les maquettes)
                      ├─► 08 (avec 03) ─► 10 (avec 07)
02 ─────────────────► 09 (avec 06)
08 + 09 ─► 11 ─► 12 ─► 13 (avec 10) ─► 14 ─► 15 ─► 16 ─► 17 ─► 18 ─► 19 ─► 20 ─► 21 ─► 22 ─► 23 ─► 24 ─► 25 ─► 26
```

Les lots WP-02/03, WP-04/05 et WP-09 peuvent être menés en parallèle s'il y a plusieurs agents.

---

## 8. Risques et décisions à faire valider par le PO

### 8.1 Décisions à valider

| Réf. | Sujet | Proposition par défaut | Impact si refusée |
| --- | --- | --- | --- |
| **PO-1** | « Le modèle est stocké en BPMN 2.0 » (CDC 4.1) | Le modèle métier JSON est canonique ; le BPMN 2.0 est produit et stocké à chaque version, avec une correspondance exacte des identifiants | Structurant : stocker en BPMN obligerait à des extensions lourdes pour la provenance, les statuts et les données, et dédoublerait la source de vérité |
| **PO-2** | Sens de « cartographie des 14 processus » dans le critère d'acceptation | Niveau 0 complet ; niveau 1 pour les 14 macroprocessus ; niveau 2 pour chaque processus identifié ; niveau 3 au moins pour l'exemple P04 « Relance des pièces manquantes » | Un niveau 3 complet partout multiplie le travail IA et la revue |
| **PO-3** | SSO SAML / OIDC des collaborateurs (CDC 9.2) | Reporté après l'incrément 1 (structure prévue). Incrément 1 : mot de passe et TOTP | Si exigé à l'incrément 1 : un WP en plus (OIDC Entra ID et Google), environ 1 session |
| **PO-4** | Méthode de double authentification | TOTP et codes de secours ; WebAuthn plus tard | — |
| **PO-5** | Correction d'une hypothèse : par formulaire ou par dialogue | Petit formulaire autorisé pour les attributs textuels d'un élément d'**analyse** ; la **cartographie** reste modifiable par dialogue seulement | Sans formulaire, toute correction passe par l'IA : plus lent et plus coûteux |
| **PO-6** | Verrouillage strict de la cartographie avant la validation du dossier (CDC 3.6) | Strict : pas d'enchaînements ni de BPMN avant la validation | Un aperçu BPMN pendant l'analyse aiderait les consultants mais contredit la lettre du CDC |
| **PO-7** | Règles fines de la décision du validateur | Décisions modifiables jusqu'à la clôture ; « accepté sous réserve » si une dépendance n'est pas décidée ; pas de rétablissement automatique après une cascade ; le validateur ne « refuse » pas le dossier mais commente, et le consultant soumet de nouveau | À trancher avant WP-16 et WP-23 |
| **PO-8** | Catalogue de « ratios standards » des gains (CDC 4.5) et coût horaire | Catalogue initial rédigé en WP-22 (durées types de saisie, de relance, de contrôle ; taux d'erreur de ressaisie ; coût horaire chargé par mission, 45 €/h par défaut), chaque ratio portant sa source ou la mention « estimation » | Le CDC ne cite aucune source : le PO doit valider les valeurs ou en fournir |
| **PO-9** | Échelle d'effort, seuils de la matrice, définition des « gains rapides », catalogue des capacités du moteur | Effort de 1 à 5 selon les facteurs (configuration < intégration < nouvelle extension) ; note de gain de 1 à 5 par seuils sur le coût annuel médian ; gain rapide si gain ≥ 4 et effort ≤ 2 ; catalogue de 2.6 | Le catalogue engage le périmètre de l'incrément 2 |
| **PO-10** | Formule de l'indicateur de complétude | Contrôles déterministes de 2.5, pondération égale | — |
| **PO-11** | Éléments « Extrait » non confirmés dans les livrables | Autorisés (le CDC n'interdit que les hypothèses), avec la source affichée | Si refusé, tout doit être confirmé avant la soumission |
| **PO-12** | Fournisseur et modèle IA du pilote, budget | Anthropic, modèle `claude-opus-5-5` par défaut, configurable par pipeline (`claude-sonnet-5-5` possible pour l'extraction) ; budget IA plafonné à 150 €/mois par défaut | Le PO fournit la clé, accepte la politique de données (CDC 6.7) et vérifie la compatibilité avec le secret professionnel et le RGPD (traitement hors UE) |
| **PO-13** | Acceptation avec le fournisseur simulé ou réel | La CI rejoue le parcours avec le fournisseur factice ; l'acceptation formelle exige une exécution réelle (`acceptance:live`) | Sans clé, l'acceptation ne prouve que le logiciel, pas la qualité d'analyse de l'IA |
| **PO-14** | Envoi d'emails (invitations, notifications) | SMTP transactionnel européen, à choisir par le PO (quelques euros par mois) | — |
| **PO-15** | Environnement de démonstration de l'incrément 1 | Une VM avec docker compose sur un cloud français, PostgreSQL managé, stockage objet (environ 40 à 80 €/mois). Kubernetes à partir de l'incrément 2 | Le CDC prévoit Kubernetes ; il est reporté pour le budget et la simplicité |
| **PO-16** | Dépôt GitHub privé et CI | À créer par le PO (CDC 10.4) ; la CI est prête dès WP-01 | Sans dépôt distant, pas de CI réelle |
| **PO-17** | Maquettes (CDC 12.4 §4) et vue simplifiée | Jalon de maquettes avant WP-07 ; principe de la vue simplifiée en 6.3 | Les WP d'écrans attendent ce jalon |
| **PO-18** | Contenu exact du « rapport de mission » et des livrables | Plan décrit en 6.4 | — |
| **PO-19** | Notifications au validateur après validation | In-app et email immédiats, regroupés par version | Un résumé quotidien est possible |
| **PO-20** | Outils de modélisation cibles pour l'interopérabilité | Camunda Modeler et demo.bpmn.io | Si le cabinet utilise un autre outil (Bizagi, ARIS…), il faudra le tester |
| **PO-21** | Durée de conservation par défaut (CDC 9.8) et purge | Champ par mission, purge manuelle à l'incrément 1, automatique à l'incrément 2 | — |
| **PO-22** | Visibilité des missions | Administrateur et responsables de mission : toutes (l'administrateur en lecture et commentaire) ; consultant : ses affectations ; validateur : sa mission [décidée] | Le CDC dit seulement « plusieurs missions » |
| **PO-23** | Contenu des prompts et des réponses IA conservé dans `ai_calls` | Conservé pendant la durée de vie de la mission, purgé avec elle | Utile pour l'audit et l'explicabilité, mais contient des données client |
| **PO-24** | Antivirus sur les documents déposés | Non à l'incrément 1 (contrôle du type et de la taille seulement) | ClamAV ajouterait un conteneur |

### 8.2 Risques techniques

| Réf. | Risque | Probabilité | Impact | Mesure |
| --- | --- | --- | --- | --- |
| R-1 | Qualité de l'extraction et du questionnement de l'IA réelle très différente des scénarios factices | Élevée | Élevé | Mode enregistrement ; `acceptance:live` ; jeu d'évaluation construit sur le pilote dès qu'une clé existe ; versionnement des prompts |
| R-2 | Taille du contexte pour 14 macroprocessus (prompts trop gros, coût) | Moyenne | Moyen | Résumé compact du modèle (codes et libellés) ; contexte réduit au processus visé pour `model.edit`, `process.flow` et `diagnostic` ; cache de prompt ; budget plafonné |
| R-3 | Sorties structurées volumineuses tronquées (`max_tokens`) | Moyenne | Moyen | Découpage par morceau et par processus ; flux (streaming) ; une reprise avec un plafond plus haut |
| R-4 | Mise en page BPMN avec couloirs illisible (elkjs) | Moyenne | Élevé | Spike au début de WP-18 ; positions mémorisées ; repli `bpmn-auto-layout` pour L0 et L1 ; une mise en page manuelle est exclue (pas d'éditeur graphique) |
| R-5 | Interopérabilité BPMN (extensions, plusieurs diagrammes par fichier) | Moyenne | Moyen | Un fichier par diagramme ; validation XSD ; test manuel dans l'outil cible |
| R-6 | Croissance des instantanés JSONB | Faible | Moyen | Compression TOAST ; mesure en WP-26 ; passage possible à des instantanés espacés avec différences |
| R-7 | Conflits fréquents entre consultants (passages en `stale`) | Moyenne | Faible | Présence affichant les intentions ; rebasage automatique quand les ensembles sont disjoints ; régénération en un clic |
| R-8 | Accessibilité des diagrammes et des PDF (RGAA, PDF/UA) | Élevée | Moyen | Alternative textuelle obligatoire ; PDF balisé par Chromium mais non certifié PDF/UA : audit RGAA complet prévu à l'incrément 5 (CDC 11.2) |
| R-9 | Injection de prompt par un document déposé | Faible | Moyen | Délimitation des documents ; schéma strict ; aucune action automatique ; décision humaine systématique |
| R-10 | Envoi de données client à un fournisseur hors UE | Moyenne | Élevé | Choix par client et acceptation tracée (CDC 6.7) ; la couche d'abstraction permet un fournisseur européen ; à arbitrer en PO-12 |
| R-11 | Continuité entre sessions d'agents (dérive de la spécification) | Moyenne | Moyen | `CLAUDE.md`, suivi des WP, ADR, rapports de WP, CI obligatoire, paquet `model` contractuel avec migrations |
| R-12 | Périmètre de l'incrément 1 « très élevé » (CDC 11.4) : 26 WP | Élevée | Élevé | Réestimation après WP-12, à partir du rythme observé ; WP-17 et WP-22 sont les premiers candidats à un découpage |

### 8.3 Coûts récurrents de l'incrément 1 (estimation)

| Poste | Estimation |
| --- | --- |
| Démonstration (VM 4 vCPU / 8 Go, PostgreSQL managé, stockage objet, email) | 40 à 80 €/mois |
| IA, en développement (fournisseur factice par défaut) et sur les exécutions réelles | Plafonnée à 150 €/mois |
| GitHub privé | 0 à 4 €/mois |
| **Total** | **Inférieur à 250 €/mois**, soit sous le plafond de 500 € |

---

### Fichiers critiques pour la réalisation

- `/home/user/processia/docs/cahier-des-charges.md` (exigences, en lecture seule)
- `/home/user/processia/docs/specs/increment-1.md` (ce document)
- `/home/user/processia/packages/model/src/schema/` (méta-modèle, contrat avec l'incrément 2 : WP-02 et WP-03)
- `/home/user/processia/packages/ai/src/` (interface fournisseur, fournisseur factice, adaptateur Anthropic, exécuteur : WP-09)
- `/home/user/processia/packages/bpmn/src/` (projection BPMN sur 4 niveaux : WP-18)
- `/home/user/processia/packages/db/src/schema.ts` (tables et RLS : WP-04)
- `/home/user/processia/CLAUDE.md` et `/home/user/processia/docs/wp/TRACKER.md` (protocole des agents : WP-01)