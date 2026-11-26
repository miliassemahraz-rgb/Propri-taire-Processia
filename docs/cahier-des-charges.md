# Processia — Cahier des charges

Version de travail du Nov 26, 2026 · Rédaction : @Iliasse Mahraz · Statut : en cours de validation, section par section

## 1. Contexte, vision et objectifs

Processia transforme la description d'un métier, même incomplète, en application métier opérationnelle, en trois étapes validées par le client : analyse, cartographie, génération. La première version est un outil de conseil, utilisé par des consultants en mission réelle.

### 1.1 Contexte

Digitaliser un processus métier demande aujourd'hui trois compétences rarement réunies : connaître le métier, savoir modéliser un processus, savoir développer. Les missions sont longues, les livrables de conseil restent souvent sur papier, et le passage à une application passe par une équipe de développement.

### 1.2 Vision

Un outil générique, applicable à tout métier et à tout secteur, qui :

- comprend un métier à partir de sources hétérogènes (texte, dialogue, documents, entretiens enregistrés, données de systèmes) ;
- en produit une cartographie AS-IS, un diagnostic et un TO-BE optimisé ;
- génère, à partir du TO-BE validé, une application livrée au client sous forme de paquet autonome qu'il héberge lui-même.

Chaque proposition de l'outil est justifiée par ses sources et soumise à validation humaine.

### 1.3 Chaîne de traitement

&#91;embedded content: chaîne de traitement · 3 étapes, 3 validations client\]

Le client valide le dossier d'analyse avant la cartographie, puis l'AS-IS, puis chaque élément du TO-BE avant la génération. Après la mise en production, toute évolution repasse par le modèle et produit une nouvelle version du paquet.

### 1.4 Utilisateurs cibles

| Phase | Utilisateurs | Rôle dans l'outil |
| --- | --- | --- |
| V1 (MVP) | Consultants, profils mixtes (métier, processus, technique) | Mènent la mission, pilotent l'outil, coéditent en temps réel |
| V1 (MVP) | Client de la mission (un validateur unique) | Consulte, commente et valide l'analyse, l'AS-IS et le TO-BE |
| Version ultérieure | Entreprises clientes en libre-service (SaaS B2B) | Utilisent l'outil sans consultant |

### 1.5 Objectifs

| Objectif | Ce que l'outil doit permettre | Indicateur de succès proposé (à valider) |
| --- | --- | --- |
| Accélérer les missions | Passer de l'entretien à une application en recette sans phase de développement spécifique | Durée entre le début de la mission et la recette |
| Fiabiliser l'analyse | Ne rien oublier (acteurs, règles, exceptions, données) et produire des livrables homogènes | Part des éléments du TO-BE validés sans correction par le client |
| Livrer une application réelle | Remettre au client une application opérationnelle, pas seulement un rapport | Nombre de processus en production chez le client |
| Réduire les compétences requises | Permettre à un consultant non développeur de produire l'application | Part des missions menées sans intervention d'un développeur |

Aucune valeur cible n'a été fixée pour ces indicateurs : elles seront définies après la première mission pilote.

### 1.6 Modèle économique et cadre

- **Revenus :** prestations de conseil, et licence d'utilisation du paquet applicatif livré au client (avec son code source).
- **Licence :** code propriétaire.
- **Financement :** aucun dispositif public ; pas de contrainte externe de calendrier ou de livrables.
- **Langue :** français, avec une architecture prête pour d'autres langues.

### 1.7 Hors objectifs de la V1

- Usage en libre-service par les entreprises (SaaS B2B).
- Calculs fiscaux et de paie : ils restent dans les logiciels du cabinet.
- Agrément EDI direct auprès de la DGFiP : la V1 passe par un concentrateur agréé.
- Hébergement des applications de production : il est assuré par le client.

## 2. Périmètre, utilisateurs et rôles

Le MVP couvre les trois étapes de bout en bout. Deux populations distinctes l'utilisent : les utilisateurs de Processia (consultants et clients de mission) et les utilisateurs des applications générées, dont les rôles sont définis par chaque modèle métier.

### 2.1 Périmètre fonctionnel du MVP

| Étape | Inclus dans le MVP | Section |
| --- | --- | --- |
| 1. Analyse | 4 types d'entrées (texte et dialogue, documents, audio, journaux système) ; questionnement guidé ; compléments par l'IA signalés comme hypothèses ; 4 livrables ; validation client | 3 |
| 2. Cartographie | BPMN 2.0 sur 4 niveaux avec vue simplifiée ; modification par dialogue ; diagnostic ; gains estimés ; simulation dynamique ; TO-BE validé élément par élément ; exports | 4 |
| 3. Génération | Moteur configuré avec extensions ; paquet autonome hébergé par le client ; recette ; versions et migration des dossiers ; documentation | 5 |
| Transverse | IA multi-fournisseurs ; coédition en temps réel ; réutilisation des missions passées comme modèles | 6 |

Le MVP est livré en 5 incréments (section 11). Rien de ce tableau n'est retiré du périmètre ; seul l'ordre de livraison est fixé.

### 2.2 Périmètre du cas pilote

- **Cartographie :** les 14 macroprocessus du cabinet d'expertise comptable (P01 à P14).
- **Application générée :** P03 à P11, du portefeuille clients au conseil.
- **Hors application :** P01-P02 (prospection, entrée en relation) et P12-P14 (facturation, archivage, pilotage du cabinet), cartographiés seulement.

Le détail du pilote est en section 8.

### 2.3 Rôles dans Processia

| Rôle | Qui | Responsabilités |
| --- | --- | --- |
| Administrateur Processia | Votre structure | Gère les comptes, les fournisseurs d'IA par client, les extensions disponibles ; seul à publier les modèles réutilisables |
| Responsable de mission | Votre structure | Crée les missions, y affecte les consultants, suit l'avancement de plusieurs missions et arbitre |
| Consultant | Profils mixtes | Mène les missions qui lui sont affectées : alimente l'analyse, fait évoluer le modèle par dialogue, lance la génération et la recette, livre le paquet |
| Validateur client | Une seule personne par mission, seul accès côté client | Consulte, commente et valide le dossier d'analyse puis chaque élément du TO-BE |

Pour s'adapter aux profils mixtes, l'interface consultant propose deux modes : un mode simple (dialogue, vue simplifiée) et un mode expert (BPMN complet, paramètres du moteur, règles détaillées).

### 2.4 Droits par rôle dans Processia

| Action | Administrateur | Responsable de mission | Consultant | Validateur client |
| --- | --- | --- | --- | --- |
| Gérer les comptes et les fournisseurs d'IA | Oui | Non | Non | Non |
| Créer une mission, affecter les consultants | Oui | Oui | Non | Non |
| Suivre l'avancement de plusieurs missions | Oui | Oui | Ses missions | Non |
| Modifier l'analyse et la cartographie | Non | Oui, en coédition | Oui, en coédition | Non |
| Commenter | Oui | Oui | Oui | Oui |
| Valider le dossier d'analyse et le TO-BE | Non | Non | Non | Oui |
| Générer, recetter, livrer le paquet | Non | Oui | Oui | Non |
| Publier un modèle réutilisable | Oui | Non | Non | Non |

### 2.5 Utilisateurs des applications générées

Les rôles d'une application générée viennent de la matrice des acteurs validée à l'étape 1. Pour le pilote, ce sont les 8 profils décrits : expert-comptable, chef de mission, collaborateur comptable, gestionnaire de paie, assistant administratif, responsable commercial, client du cabinet, administrateur du système.

- L'**administrateur du système** côté cabinet gère les utilisateurs, leurs rôles et leurs affectations. Il ne modifie pas le modèle : les évolutions passent par le consultant.
- Le **client du cabinet** est un utilisateur externe : il dépose ses pièces, valide et consulte, sur le web ou l'application mobile.

### 2.6 Supports et volumes

- **Processia :** navigateur sur poste de travail, coédition en temps réel.
- **Applications générées :** web responsive et application mobile native (iOS, Android).
- **Volumes à un an :** 10 à 50 consultants, 10 à 100 clients, 100 à 1 000 utilisateurs par application.

### 2.7 Décisions prises sur cette section

- Le validateur est la seule personne côté client à accéder à Processia.
- Un rôle de responsable de mission, distinct du consultant, affecte les consultants et suit plusieurs missions.
- Seul l'administrateur publie les modèles réutilisables.

## 3. Étape 1 : analyse du métier

L'étape 1 transforme des sources hétérogènes en un modèle métier structuré, restitué en 4 livrables que le validateur client doit approuver avant toute cartographie. Chaque élément du modèle indique sa source et son statut.

### 3.1 Sources d'entrée

| Type | Formats | Ce que l'outil en extrait | Incrément |
| --- | --- | --- | --- |
| Texte et dialogue guidé | Saisie libre, échanges avec l'outil | Description du métier, acteurs, activités, règles, exceptions | 1 |
| Documents existants | PDF, Word, Excel, images (procédures, fiches de poste, organigrammes, formulaires) | Acteurs, étapes, données et champs des formulaires, règles écrites | 1 |
| Entretiens enregistrés | Fichiers audio, transcriptions | Transcription, identification des intervenants, puis mêmes extractions que le texte | 4 |
| Données de systèmes | Journaux d'événements (CSV, XES), exports de logiciels | Enchaînement réel des activités, variantes, délais, volumes, acteurs réels | 4 |

Toutes les sources d'une mission alimentent le même modèle. Quand deux sources se contredisent (une procédure écrite et le processus observé dans les journaux, par exemple), l'outil signale l'écart au consultant au lieu de trancher.

### 3.2 Déroulement de l'analyse

1. Le consultant dépose les sources disponibles et décrit le métier en quelques phrases.
2. L'outil extrait un premier modèle et repère ce qui manque ou se contredit.
3. L'outil pose ses questions au consultant, une par une, en commençant par celles qui bloquent le plus la suite.
4. L'outil propose des compléments issus de ses connaissances du secteur et des missions passées comparables, chacun marqué comme hypothèse.
5. Le consultant accepte, corrige ou rejette chaque hypothèse.
6. L'outil produit les 4 livrables et les soumet au validateur client.

Les étapes 2 à 5 se répètent autant que nécessaire. Plusieurs consultants peuvent y travailler en même temps.

### 3.3 Modèle métier produit

L'analyse remplit un modèle unique, commun aux trois étapes : la cartographie le visualise, la génération l'exécute.

| Concept | Contenu |
| --- | --- |
| Métier | Secteur, environnement, spécificités, glossaire |
| Acteurs | Rôles internes et externes, responsabilités, systèmes tiers |
| Activités | Processus, sous-processus, tâches, séquences, entrées et sorties |
| Données | Objets métier, champs, documents, outils utilisés |
| Flux | Échanges d'informations et de documents entre acteurs |
| Règles | Règles de gestion, contraintes, points de décision, exceptions, dépendances |
| Indicateurs | Volumes, délais, fréquences connus ou estimés |

### 3.4 Origine et statut de chaque élément

Chaque élément du modèle porte sa source (entretien, document, journal système, connaissance de l'IA, mission antérieure) et l'un des statuts suivants :

| Statut | Signification |
| --- | --- |
| Extrait | Lu dans une source fournie ; la source est citée |
| Hypothèse | Proposé par l'IA ou repris d'une mission passée, en attente de décision du consultant |
| Confirmé | Accepté ou corrigé par le consultant |
| Validé | Approuvé par le validateur client avec le dossier d'analyse |

Aucune hypothèse ne peut figurer dans un livrable soumis au client sans avoir été confirmée par un consultant.

### 3.5 Livrables de l'étape 1

| Livrable | Contenu |
| --- | --- |
| Fiche métier et glossaire | Synthèse du métier, de son environnement et de ses spécificités ; vocabulaire |
| Acteurs et matrice RACI | Acteurs, rôles et responsabilités ; qui réalise, approuve, est consulté ou informé pour chaque activité |
| Dictionnaire de données et flux | Données, documents et outils ; flux entre acteurs |
| Registre des règles | Règles métier, contraintes, points de décision, exceptions, dépendances |

Ces livrables forment le dossier d'analyse, exportable en Word, PDF et Excel.

### 3.6 Validation du dossier d'analyse

- Le validateur client consulte le dossier, commente et valide.
- La cartographie (étape 2) ne démarre qu'après cette validation.
- Une modification apportée plus tard au modèle validé est signalée au validateur.

### 3.7 Décisions prises sur cette section

- Un modèle métier unique sert aux trois étapes (3.3).
- Un indicateur de complétude s'affiche pour chaque concept du modèle ; le consultant décide quand arrêter le questionnement.
- Les règles sont enregistrées en texte structuré à l'étape 1, puis traduites automatiquement en tables de décision exécutables à l'étape 2. Ce choix vient de ma recommandation : vous n'avez pas exprimé de préférence.
- Une modification du modèle après validation est signalée au validateur, sans nouvelle validation formelle.
- Avant tout dépôt d'un entretien enregistré, le consultant déclare les participants et confirme leur accord ; l'outil conserve cet accord avec l'enregistrement.

## 4. Étape 2 : cartographie AS-IS et TO-BE

L'étape 2 représente le modèle validé en BPMN 2.0 sur 4 niveaux, en tire un diagnostic chiffré en ordres de grandeur, puis propose un TO-BE que le validateur client accepte ou refuse élément par élément. Toute modification passe par le dialogue avec l'outil.

### 4.1 Formalisme et niveaux

Le modèle est stocké en BPMN 2.0 et affiché sous deux vues : BPMN complet (mode expert) et vue simplifiée (mode simple et validateur client).

| Niveau | Contenu | Exemple du pilote |
| --- | --- | --- |
| 0. Cartographie globale | Macroprocessus et leurs liens | Les 14 processus P01 à P14 |
| 1. Macroprocessus | Processus qui le composent, acteurs impliqués | P04 Collecte documentaire |
| 2. Processus | Enchaînement des activités en couloirs par acteur, décisions, circuits de validation | Relance des pièces manquantes |
| 3. Procédure | Tâches détaillées, règles, données et documents par étape, exceptions | Champs, délais et destinataires de chaque relance |

Chaque activité porte ses entrées, ses sorties, son acteur responsable et les règles qui s'y appliquent.

### 4.2 Modification par dialogue

Le consultant modifie la cartographie uniquement en langage naturel (« ajoute une validation par le chef de mission après la révision »). L'outil :

- applique la modification au modèle et redessine les niveaux concernés ;
- montre ce qui a changé avant de l'enregistrer ;
- signale les incohérences créées (activité sans responsable, branche sans issue, donnée jamais produite) ;
- conserve l'historique des versions, avec retour arrière possible.

### 4.3 Diagnostic de l'AS-IS

| Famille | Ce que l'outil détecte |
| --- | --- |
| Gaspillages | Ressaisies, tâches répétitives, doublons, contrôles redondants, boucles de validation inutiles |
| Flux et délais | Goulots, temps d'attente, ruptures de flux, transmissions papier ou par email |
| Organisation | Tâches sans responsable, cumul de rôles incompatibles, dépendance à une seule personne |
| Risques et conformité | Contrôles manquants, absence de traçabilité, obligations réglementaires non couvertes |

Chaque constat est localisé sur la cartographie et justifié par sa source, comme à l'étape 1.

### 4.4 Optimisations et automatisations proposées

Pour chaque constat, l'outil propose une ou plusieurs optimisations. Les automatisations possibles sont celles que le moteur sait exécuter :

| Type | Exemples |
| --- | --- |
| Règles et notifications | Affectation automatique, relances, escalades, alertes d'échéance, changements d'état |
| Documents | Génération de documents, signature électronique, lecture et extraction de pièces (OCR) |
| Intégrations | Échanges automatiques avec les logiciels tiers, la banque, le concentrateur EDI |
| Agents IA | Classement des pièces, détection d'anomalies, rédaction d'analyses, aide à la décision |

Chaque proposition indique le constat qu'elle traite, le gain estimé et les éléments du TO-BE qu'elle modifie.

### 4.5 Estimation des gains

L'outil estime les gains (temps, coût, erreurs évitées) à partir de ratios standards. Ils sont présentés comme des ordres de grandeur, avec les hypothèses de calcul visibles.

### 4.6 Simulation dynamique

Avant validation, le consultant peut simuler l'AS-IS et le TO-BE sur une même période : volumes de dossiers, délais, charge par acteur, files d'attente, pics saisonniers (échéances fiscales par exemple). La comparaison des deux simulations est jointe au dossier soumis au client. Livraison à l'incrément 4.

### 4.7 Validation du TO-BE

1. Le validateur client valide d'abord l'AS-IS : il confirme que la cartographie reflète le fonctionnement réel. Le diagnostic et le TO-BE ne sont proposés qu'ensuite.
2. Il reçoit le TO-BE sous forme de liste d'optimisations, chacune avec son constat, son gain estimé, son effort de mise en œuvre et sa représentation AS-IS / TO-BE. Une matrice gain × effort les situe et met en avant les gains rapides.
3. Il accepte ou refuse chaque optimisation, avec un commentaire facultatif. Les dépendances entre optimisations sont visibles avant la décision : refuser une optimisation refuse automatiquement celles qui en dépendent.
4. Après un refus, le consultant peut soumettre une optimisation alternative pour le même constat, avec l'aide de l'outil. Elle suit le même circuit.
5. L'outil recompose le TO-BE à partir des seules optimisations acceptées ; ce TO-BE devient la base de la génération (étape 3).

### 4.8 Exports

| Format | Contenu | Incrément |
| --- | --- | --- |
| Word, PDF | Rapport de mission : analyse, AS-IS, diagnostic, TO-BE, gains | 1 |
| Excel | RACI, dictionnaire de données, registre des règles, liste des optimisations | 1 |
| BPMN XML | Import dans d'autres outils de modélisation | 1 |
| PowerPoint | Support de restitution au client | 4 |

### 4.9 Décisions prises sur cette section

- L'AS-IS est validé par le client avant toute proposition de TO-BE.
- Refuser une optimisation refuse en cascade celles qui en dépendent.
- Après un refus, le consultant peut proposer une alternative pour le même constat.
- Les optimisations sont priorisées sur une matrice gain × effort.

## 5. Étape 3 : moteur et applications générées

Une application générée est le TO-BE validé exécuté par un moteur commun, complété par des extensions réutilisables. Elle est livrée au client sous forme de paquet autonome qu'il héberge, et chaque évolution produit une nouvelle version de ce paquet.

### 5.1 Principe : moteur, modèle, extensions

| Composant | Rôle | Propre au client ? |
| --- | --- | --- |
| Moteur | Exécute n'importe quel modèle : données, écrans, workflows, règles, droits, indicateurs | Non, commun à toutes les applications |
| Modèle | Le TO-BE validé et ses paramètres (charte, rôles, notifications) | Oui |
| Extensions | Connecteurs (logiciels comptables, banque, EDI, signature, SSO, messagerie), agents IA, composants d'écran spécifiques | Non : développées une fois, activées selon le modèle |

Ce qu'aucune configuration ne couvre devient une nouvelle extension, réutilisable pour les missions suivantes, et jamais un développement propre à un client.

### 5.2 Fonctions des applications générées

| Fonction | Comportement attendu |
| --- | --- |
| Données | Base générée depuis le dictionnaire de données validé ; import et export |
| Écrans | Formulaires de saisie, listes, recherches et fiches, générés pour chaque objet métier et chaque rôle |
| Workflows | États, transitions, tâches affectées, délais et relances, conformes au TO-BE |
| Circuits de validation | Enchaînements de validation et de correction issus du TO-BE (par exemple collaborateur, puis chef de mission, puis expert-comptable) |
| Règles | Tables de décision issues du registre des règles, appliquées automatiquement |
| Droits d'accès | Par rôle et fonction, par enregistrement (« mes dossiers »), par champ (masqué ou en lecture seule) ; délégation temporaire à un remplaçant (congés, absence), vers qui les tâches et validations sont redirigées |
| Notifications | Dans l'application (centre de notifications, liste de tâches) et par email, y compris aux utilisateurs externes |
| Documents | GED intégrée (stockage, classement, versions, recherche, OCR) ; génération de documents ; signature électronique |
| Automatisations | Règles, intégrations et agents IA acceptés dans le TO-BE |
| Tableaux de bord | Indicateurs déduits du processus (délais par étape, retards, taux de rejet, charge par acteur), ajustables par le consultant |
| Traçabilité | Historique des actions : qui a fait quoi et quand (création, validation, rejet, transmission) |
| Exceptions | Circuit dédié pour chaque exception modélisée (relance, escalade, délai, alerte) ; mécanisme générique pour signaler, affecter et suivre toute situation imprévue |
| RGPD | Durées de conservation paramétrables, export et effacement des données d'une personne, fiche de registre générée (détail en section 9) |
| Administration | L'administrateur du client gère les utilisateurs, leurs rôles et leurs affectations |

### 5.3 Ergonomie et supports

- Charte personnalisable par client : logo, couleurs, nom de l'application.
- Interface web responsive, conforme au RGAA.
- Application mobile native iOS et Android, notamment pour les utilisateurs externes (dépôt de pièces, photo de justificatifs, notifications). Hors connexion, la prise de photos et le dépôt de pièces restent possibles, avec envoi automatique au retour du réseau. Livraison à l'incrément 5.
- Français, textes externalisés pour permettre d'autres langues.

### 5.4 Recette

- Chaque application est d'abord déployée dans un environnement de recette, hébergé sur votre plateforme.
- L'outil génère des données fictives réalistes et des scénarios de test dérivés du TO-BE (un par chemin du processus, exceptions comprises).
- Le client teste ; le consultant corrige par dialogue ; l'application se met à jour en recette.
- Le paquet de production n'est produit qu'après la recette.

### 5.5 Livraison : le paquet autonome

| Contenu du paquet | Détail |
| --- | --- |
| Moteur | Images de conteneurs et code source, sous licence propriétaire |
| Modèle | Le modèle de l'application et sa version |
| Extensions | Seulement celles que l'application utilise |
| Installation | Fichiers de déploiement (conteneurs), procédure d'installation et de mise à jour |
| Documentation | Guide utilisateur par rôle, documentation technique |

Le client héberge le paquet sur une infrastructure capable d'exécuter des conteneurs, chez lui ou chez un prestataire. Les données de production restent chez lui. Livraison à l'incrément 2.

### 5.6 Évolutions et versions

1. Le cabinet exprime un besoin d'évolution.
2. Le consultant modifie le modèle par dialogue dans Processia.
3. L'évolution passe en recette, puis une nouvelle version du paquet est produite.
4. Pour chaque version, le consultant choisit le sort des dossiers en cours : ils terminent sur l'ancienne version, ou ils migrent vers la nouvelle selon des correspondances d'étapes proposées par l'outil et validées par le consultant.
5. Le client déploie la nouvelle version.

Chaque version est publiée dans un registre privé de conteneurs. Dès l'incrément 2, le client la déploie avec une commande unique fournie dans le paquet, qui sauvegarde les données, applique la migration décidée par le consultant et revient à la version précédente en cas d'échec. À l'incrément 5, un canal automatique propose les nouvelles versions, installées après accord d'un administrateur du client.

Un contrat de maintenance accompagne la licence : vous fournissez les correctifs du moteur, les nouvelles versions et l'assistance ; le client assure l'hébergement et l'exploitation.

### 5.7 Documentation et aide

- Guide utilisateur généré pour chaque rôle.
- Documentation technique : modèle de données, workflows, règles, API.
- Aide contextuelle intégrée aux écrans, et assistant IA qui répond aux questions des utilisateurs à partir du guide et du modèle de l'application, avec le fournisseur d'IA choisi par le client.

### 5.8 Décisions prises sur cette section

- Les délégations temporaires à un remplaçant sont ajoutées aux droits d'accès.
- L'aide contextuelle inclut un assistant IA.
- Mises à jour : commande unique dès l'incrément 2, canal automatique avec accord d'un administrateur à l'incrément 5.
- Application mobile : prise de photos et dépôt de pièces possibles hors connexion.
- Support et maintenance assurés par vous, sous contrat ; hébergement et exploitation par le client.

## 6. Intelligence artificielle

L'IA intervient à chaque étape de Processia et dans les applications générées, mais toujours sous contrôle humain : elle propose, cite ses sources, et n'agit seule que dans les applications, au-dessus d'un seuil de confiance réglable. Le fournisseur d'IA est un paramètre choisi pour chaque client.

### 6.1 Usages dans Processia

| Étape | Ce que fait l'IA | Qui décide |
| --- | --- | --- |
| Analyse | Extrait le modèle des textes, documents, transcriptions et journaux ; repère les manques et les contradictions ; pose les questions ; propose des compléments | Le consultant confirme chaque hypothèse ; le client valide le dossier |
| Analyse | Transcrit les entretiens enregistrés et identifie les intervenants | Le consultant relit |
| Cartographie | Applique les modifications demandées par dialogue ; détecte les dysfonctionnements ; propose les optimisations et leurs alternatives ; estime gains et efforts ; traduit les règles en tables de décision | Le consultant, puis le client élément par élément |
| Génération | Produit les données de test, les scénarios de recette, la documentation, les correspondances de migration | Le consultant |
| Transverse | Propose des modèles issus des missions passées comparables | Le consultant les accepte ou non |

### 6.2 Usages dans les applications générées

| Agent | Exemple dans le pilote |
| --- | --- |
| Classement de documents | Reconnaître une facture, un relevé bancaire, un justificatif, et le rattacher au bon dossier |
| Extraction de données | Lire montant, date, fournisseur sur une pièce |
| Détection d'anomalies | Signaler un écart inhabituel d'un mois à l'autre, une pièce manquante, un doublon |
| Rédaction | Préparer une note d'analyse financière ou un compte rendu de rendez-vous client |
| Aide à la décision | Suggérer une affectation ou une priorité de traitement |
| Assistant d'aide | Répondre aux questions des utilisateurs sur l'utilisation de l'application |

Les agents activés dans une application sont ceux acceptés par le client dans le TO-BE.

### 6.3 Autonomie des agents

- Chaque action d'un agent a un niveau de confiance calculé.
- Au-dessus du seuil réglé pour ce type d'action, l'agent agit seul ; en dessous, il propose et un humain valide.
- Toute action d'un agent est tracée et identifiée comme telle dans l'historique, avec son niveau de confiance.

### 6.4 Explicabilité

Chaque proposition de l'IA indique d'où elle vient (entretien, document, journal système, connaissance générale, mission antérieure) et pourquoi elle est faite. Une proposition sans source identifiable est présentée comme « connaissance générale de l'IA », jamais comme un fait.

### 6.5 Choix du fournisseur d'IA

- Processia et le moteur passent par une couche d'abstraction : changer de fournisseur ne modifie ni le modèle ni les applications.
- Le fournisseur est choisi pour chaque client : API cloud, API hébergée dans l'UE, ou modèle hébergé en interne.
- Les capacités requises (texte, lecture de documents, transcription audio) doivent être couvertes par le fournisseur choisi ; sinon l'outil le signale à la création de la mission.

### 6.6 Réutilisation des missions passées

L'outil propose automatiquement, au début d'une mission, des modèles issus de missions passées comparables. Seuls les modèles publiés par l'administrateur sont proposés ; ils sont anonymisés : aucune donnée, aucun nom, aucun document du client d'origine.

### 6.7 Décisions prises sur cette section

- La non-réutilisation des données pour l'entraînement n'est pas imposée : chaque client choisit son fournisseur en connaissant sa politique, que Processia affiche lors du paramétrage.
- Pour les applications hébergées chez le client, le compte d'IA est au choix du client : son propre compte, ou un accès fourni par vous et refacturé.
- Trois actions restent toujours humaines, quel que soit le seuil, et ne sont pas paramétrables : la validation par l'expert-comptable, la télétransmission, l'envoi d'un document au client final.
- Le consultant fixe les seuils de confiance initiaux dans le modèle ; l'administrateur du client peut les ajuster en production.
- L'administrateur décide de publier une mission comme modèle ; l'anonymisation est alors entièrement automatique, sans relecture. Le risque associé est traité en section 12.

### 6.8 Point ouvert

- [ ] Le classement de Processia et des agents au regard du règlement européen sur l'IA (AI Act) est à vérifier par un juriste.

## 7. Intégrations et télétransmissions

Les applications générées orchestrent le travail sans refaire ce que font les logiciels du cabinet : elles récupèrent leurs résultats, les font contrôler et valider, puis télétransmettent via un concentrateur agréé. Chaque intégration est une extension interchangeable, livrée à l'incrément 3.

### 7.1 Principe

- Les logiciels de comptabilité et de paie calculent (montants, déclarations, bulletins, DSN).
- L'application récupère ces résultats, les rattache au dossier client, applique ses contrôles de cohérence et les soumet au circuit de validation.
- Après validation par l'expert-comptable (action toujours humaine), l'application transmet via le concentrateur et archive les accusés de réception.

### 7.2 Intégrations du pilote

| Catégorie | Systèmes visés | Sens des échanges | Données échangées |
| --- | --- | --- | --- |
| Logiciels comptables | Sage / ACD d'abord, puis Cegid, Pennylane, Tiime, MyUnisoft | Lecture et écriture | Lecture : avancement, balances, montants déclaratifs, fichiers déclaratifs. Écriture : pièces collectées |
| Logiciel de paie | À déterminer | Lecture et écriture | Lecture : bulletins, fichiers DSN. Écriture : variables de paie collectées |
| Concentrateur EDI | Opérateur agréé à choisir | Envoi et retour | Envoi : TVA, liasses fiscales, DSN. Retour : accusés de réception, rejets |
| Banques | Agrégateur DSP2 à choisir | Lecture | Relevés et transactions des comptes des clients du cabinet |
| Signature électronique | Fournisseur à choisir | Envoi et retour | Lettres de mission, documents à faire signer ; statut et document signé |
| Annuaire / SSO | Microsoft 365 (Entra ID), Google Workspace | Authentification | Identité et connexion unique des collaborateurs du cabinet |
| Messagerie et agenda | Outlook, Gmail | Lecture et écriture | Rattachement d'emails au dossier ; rendez-vous clients |

### 7.3 Connecteurs interchangeables

- Chaque catégorie a une interface commune dans le moteur ; chaque fournisseur est un connecteur qui la met en œuvre.
- Changer de logiciel comptable, de concentrateur ou de banque ne modifie ni le modèle ni l'application : on active un autre connecteur.
- Un connecteur développé pour un client sert à tous les suivants.

### 7.4 Fiabilité des échanges

- Chaque échange est tracé : quoi, quand, avec quel système, avec quel résultat.
- Un échec est retenté automatiquement, puis devient une exception dans le workflow, affectée et suivie jusqu'à résolution. Aucun échec n'est silencieux.
- Un rejet de déclaration par l'administration crée une tâche de correction dans le dossier concerné.
- Les identifiants d'accès aux systèmes tiers sont stockés chiffrés, chez le client.

### 7.5 Décisions et points ouverts

- Décidé : l'application lit et écrit dans les logiciels comptables et de paie ; les pièces et variables de paie collectées leur sont transmises sans ressaisie.

* [ ] Logiciel de paie du cabinet pilote : inconnu, à confirmer avec le cabinet pressenti. Il conditionne la récupération des DSN.
* [ ] Conditions d'accès aux API de Sage / ACD (partenariat éditeur, coût, délai) à vérifier avant l'incrément 3.
* [ ] Choix du concentrateur EDI, de l'agrégateur bancaire et du fournisseur de signature : comparaison à préparer avant l'incrément 3.

## 8. Cas pilote : cabinet d'expertise comptable

Le pilote est un cabinet d'expertise comptable, client probable, non encore engagé. La description ci-dessous est votre première hypothèse de modélisation : elle servira d'entrée à Processia lors de la mission, qui la complétera et la fera valider par le cabinet.

### 8.1 Métier

- **Secteur :** services professionnels aux entreprises (expertise comptable, fiscalité, gestion sociale, conseil financier).
- **Métier :** accompagner les entreprises dans la tenue de leur comptabilité, le respect de leurs obligations fiscales et sociales, l'établissement de leurs comptes annuels et le pilotage de leur performance financière.

### 8.2 Processus et couverture du MVP

| ID | Processus | Principales activités | Couverture MVP |
| --- | --- | --- | --- |
| P01 | Prospection commerciale | Identification des prospects, qualification des besoins, propositions commerciales | Cartographie |
| P02 | Entrée en relation client | Collecte des informations, vérification de conformité, lettre de mission | Cartographie |
| P03 | Gestion du portefeuille clients | Création des dossiers, affectation des collaborateurs, planification des missions | Application |
| P04 | Collecte documentaire | Récupération des factures, relevés bancaires, justificatifs ; relances clients | Application |
| P05 | Production comptable | Saisie, imputation, rapprochement bancaire, lettrage | Application (suivi ; la saisie reste dans le logiciel comptable) |
| P06 | Révision comptable | Contrôle des écritures, anomalies, régularisation | Application |
| P07 | Gestion fiscale | Calcul des impôts et taxes, préparation et transmission des déclarations | Application (calcul dans le logiciel ; contrôle, validation, télétransmission dans l'application) |
| P08 | Gestion sociale | Variables de paie, bulletins, déclarations sociales | Application (calcul dans le logiciel de paie ; collecte, validation, télétransmission dans l'application) |
| P09 | Clôture comptable | Travaux d'inventaire, écritures de clôture, comptes annuels | Application |
| P10 | Validation et supervision | Contrôle qualité, validation par l'expert-comptable, corrections | Application |
| P11 | Conseil et accompagnement | Analyse financière, reporting, recommandations, rendez-vous clients | Application |
| P12 | Facturation et recouvrement | Facturation des honoraires, suivi des paiements, relances | Cartographie |
| P13 | Archivage et conformité | Conservation, traçabilité, confidentialité, obligations réglementaires | Cartographie |
| P14 | Pilotage du cabinet | Charge de travail, rentabilité des missions, échéances, performance | Cartographie |

### 8.3 Acteurs

| Acteur | Rôle principal |
| --- | --- |
| Expert-comptable | Supervision, validation finale, conseil |
| Chef de mission | Coordination, planification, révision |
| Collaborateur comptable | Production et traitement comptable |
| Gestionnaire de paie | Gestion sociale et production de la paie |
| Assistant administratif | Gestion documentaire et relances |
| Responsable commercial | Prospection et contractualisation |
| Client du cabinet | Transmission des documents, validation, consultation |
| Administrateur du système | Utilisateurs, droits, paramétrage |

Parties prenantes externes : administrations fiscales, organismes sociaux, banques, logiciels tiers.

### 8.4 Workflow principal

Flux simplifié, hors boucles de correction et exceptions :

1. Prospection et qualification
2. Contractualisation
3. Création du dossier client
4. Collecte documentaire
5. Production comptable
6. Révision et contrôle
7. Validation par l'expert-comptable
8. Déclarations et livrables
9. Facturation et suivi client
10. Archivage et pilotage

L'application du MVP couvre les étapes 3 à 8 et la partie suivi client de l'étape 9.

### 8.5 Objectifs de digitalisation du cabinet

Une application centralisée gérant le cycle de vie du dossier client, avec : espace client, GED, workflows paramétrables, affectation et suivi des tâches, circuits de contrôle et de validation, relances et notifications automatiques, intégrations avec les logiciels comptables et bancaires, tableaux de bord, gestion des exceptions et des anomalies, traçabilité complète.

### 8.6 Critères de réussite proposés pour le pilote (à valider)

- Les 14 processus sont cartographiés, et l'AS-IS comme le TO-BE sont validés par le cabinet.
- L'application P03 à P11 passe la recette puis est installée chez le cabinet.
- Au moins un cycle complet de dossier client (de la collecte à la télétransmission) est réalisé dans l'application en conditions réelles.

### 8.7 Décisions et points ouverts

- Décidé : le CRM se limite à la fiche client de P03 (contacts, historique des échanges) ; prospection et entrée en relation restent hors application.
- Décidé : les tableaux de bord portent sur l'opérationnel de P03 à P11 (délais, charge, retards, anomalies) ; pas de tableaux de bord financiers du cabinet.

* [ ] Taille du cabinet pilote (collaborateurs, nombre de dossiers clients) : nécessaire pour la simulation et le dimensionnement.
* [ ] Engagement du cabinet pressenti : calendrier de la mission, interlocuteur validateur.

## 9. Exigences non fonctionnelles

Processia et les environnements de recette sont hébergés sur un cloud européen en France ; les applications de production tournent chez les clients. Les exigences ci-dessous distinguent donc ce que vous garantissez (votre plateforme) de ce que le paquet doit permettre (l'hébergement du client).

### 9.1 Hébergement

| Périmètre | Où | Qui exploite |
| --- | --- | --- |
| Processia (missions, modèles) | Cloud européen hébergé en France (type OVHcloud ou Scaleway) | Vous |
| Environnements de recette | Même cloud | Vous |
| Applications de production | Infrastructure du client capable d'exécuter des conteneurs, interne ou chez un prestataire | Le client |

L'architecture est conteneurisée et portable : une instance dédiée, un déploiement sur site ou un cloud qualifié SecNumCloud restent possibles plus tard, sans refonte.

### 9.2 Sécurité

- **Authentification forte :** double authentification obligatoire ; connexion unique (SAML, OpenID Connect) pour les collaborateurs, dans Processia comme dans les applications.
- **Cloisonnement :** les missions de clients différents sont étanches dans Processia ; seuls les modèles anonymisés publiés circulent entre elles.
- **Chiffrement :** des échanges (TLS) et des données stockées, au niveau standard de l'hébergeur ; identifiants d'accès aux systèmes tiers chiffrés.
- **Droits :** ceux des sections 2.4 (Processia) et 5.2 (applications).

### 9.3 Protection des données (RGPD)

- Pendant la mission et la recette, vous êtes sous-traitant du cabinet ; un contrat de sous-traitance (DPA) est signé avec chaque client.
- En production, les données restent chez le client : vous n'y accédez que dans le cadre du support, sur autorisation.
- Les applications intègrent : durées de conservation paramétrables avec purge ou archivage automatique ; export et effacement des données d'une personne ; fiche du registre des traitements générée à partir du dictionnaire de données.
- L'accord des participants aux entretiens enregistrés est tracé (section 3).

### 9.4 Disponibilité et sauvegarde

| Exigence | Valeur |
| --- | --- |
| Disponibilité visée | 99,5 % (environ 3 h 40 d'indisponibilité par mois au plus) |
| Perte de données maximale | 15 minutes (sauvegarde continue) |
| Délai de restauration | Moins de 8 heures |
| Mises en production | Gelées pendant les échéances fiscales, selon un calendrier paramétrable par client |

Ces niveaux s'appliquent à votre plateforme et sont aussi un engagement en production chez le client. Cet engagement suppose que l'hébergement du client respecte des exigences minimales fixées contractuellement. Ces exigences sont détaillées en section 10.3. L'engagement ne vaut que si ces exigences sont remplies.

### 9.5 Volumes

10 à 50 consultants, 10 à 100 clients, 100 à 1 000 utilisateurs par application à horizon d'un an, clients finaux du cabinet compris.

### 9.6 Accessibilité et langue

- Processia et les applications générées conformes au RGAA.
- Français ; tous les textes externalisés pour permettre d'autres langues.

### 9.7 Réversibilité et propriété

- Le client peut exporter à tout moment l'intégralité de ses données et du modèle de son application.
- Le code de Processia et du moteur est propriétaire ; le client reçoit le code source du moteur sous licence avec son paquet.

### 9.8 Décisions prises sur cette section

- Les niveaux de service de 9.4 sont un engagement y compris en production chez le client, sous réserve d'exigences minimales d'hébergement.
- Pas d'objectif de performance chiffré pour le MVP.
- Chiffrement standard, sans clé par client ni test d'intrusion, pour le MVP.
- La durée de conservation des données de mission dans Processia est paramétrable par mission, fixée dans le contrat avec chaque client.
- Processia est lui aussi conforme au RGAA.

## 10. Architecture et stack

Deux déploiements partagent le même moteur : votre plateforme, qui héberge Processia et les recettes, et le paquet installé chez chaque client. La stack est en TypeScript, avec un service Python pour l'analytique, afin de limiter le nombre de langages à maintenir.

### 10.1 Vue d'ensemble

&#91;embedded content: architecture · votre plateforme et paquet client\]

Votre plateforme ne reçoit jamais de données de production : elle publie des versions dans le registre, que le client installe. Le moteur du client dialogue directement avec les systèmes tiers et le fournisseur d'IA choisi ; Processia utilise lui aussi la couche IA pour l'analyse et la cartographie.

### 10.2 Stack technique

| Brique | Technologie | Raison |
| --- | --- | --- |
| Langage principal | TypeScript (front et back) | Un seul langage pour l'essentiel ; typage fort |
| Web | React + Next.js | Standard, compatible RGAA, responsive |
| Mobile | React Native (Expo) | Réutilise TypeScript et React ; iOS et Android ; mode hors connexion partiel |
| Back-end et moteur | Node.js (NestJS) | Structure modulaire adaptée aux extensions |
| Base de données | PostgreSQL | Relationnel + JSON, adapté à un moteur piloté par modèle ; recherche plein texte pour la GED |
| Cartographie | bpmn-js | Rendu BPMN 2.0 standard |
| Coédition | Yjs | Bibliothèque de référence pour l'édition simultanée |
| Analytique | Service Python (pm4py, SimPy) | Process mining et simulation |
| IA | Couche d'abstraction multi-fournisseurs | Fournisseur choisi par client |
| Fichiers | Stockage objet compatible S3 | Portable entre hébergeurs |
| Déploiement | Docker + Kubernetes, registre privé de conteneurs | Portabilité, mises à jour par version |

### 10.3 Paquet client

- Contenu : moteur, application web, modèle, extensions utilisées, base de données, stockage de fichiers, commande de mise à jour, documentation.
- Isolation : un paquet par client ; aucune donnée de production ne transite par votre plateforme.
- Exigences minimales d'hébergement, conditions de l'engagement de service (section 9.4) : infrastructure à conteneurs sur deux nœuds au moins, sauvegarde continue de la base, sauvegardes sur un site distinct. Pas d'accès de supervision pour vous : le client vous transmet ses alertes et ses rapports de sauvegarde.

### 10.4 Développement

- Code dans un nouveau dépôt GitHub privé, développé principalement par Claude, sous votre pilotage.
- Tests automatisés et intégration continue à chaque modification ; aucune version publiée sans tests réussis.
- Spécifications techniques maintenues dans le dépôt, pour la continuité entre sessions de développement.
- De votre côté : comptes (cloud, fournisseurs d'IA, prestataires), secrets d'accès, relation avec le cabinet pilote.

### 10.5 Décisions prises sur cette section

- Application mobile : une application générique unique dans les stores pour le MVP, reliée au serveur du cabinet qui lui applique sa charte ; une application au nom du client pourra être proposée plus tard en option.
- Exigences minimales d'hébergement client validées, sans accès de supervision : le client transmet ses alertes et rapports de sauvegarde.

## 11. Phasage, critères d'acceptation et coûts

Le MVP est livré en 5 incréments, sans échéance imposée ; la mission pilote réelle peut démarrer après l'incrément 2. Les services payants ne sont activés qu'à l'incrément qui les utilise, pour rester sous 500 € par mois de coûts récurrents.

### 11.1 Feuille de route

&#91;embedded content: feuille de route · 5 incréments, sans dates\]

Les incréments se suivent sans dates fixées. Après l'incrément 2, le pilote peut entrer en production chez le cabinet ; les incréments suivants l'enrichissent.

### 11.2 Contenu et critères d'acceptation

| Incrément | Contenu | Accepté quand |
| --- | --- | --- |
| 1. Analyse et cartographie | Modèle unique ; entrées texte, dialogue et documents ; 4 livrables ; BPMN 4 niveaux et vue simplifiée ; modification par dialogue ; diagnostic ; gains estimés ; validation AS-IS puis TO-BE élément par élément ; matrice gain × effort ; coédition ; rôles Processia ; exports Word, PDF, Excel, BPMN | À partir de la description du pilote (section 8), l'outil produit les 4 livrables et la cartographie des 14 processus ; deux consultants coèditent en même temps ; un validateur de test valide l'AS-IS puis accepte et refuse des optimisations, refus en cascade compris ; le BPMN exporté s'ouvre dans un autre outil de modélisation |
| 2. Moteur d'application | Moteur, écrans, workflows, règles, droits et délégations, notifications, GED, exceptions, indicateurs, traçabilité, RGPD ; recette et données de test ; paquet autonome et commande de mise à jour ; versions et migration ; documentation | L'application P03 à P06 et P10 est générée, recettée avec les scénarios générés, installée sur une infrastructure distincte de votre plateforme, puis mise à jour avec migration de dossiers et retour arrière testés |
| 3. Intégrations | Connecteurs Sage / ACD, logiciel de paie, concentrateur EDI, banque, signature, SSO, messagerie et agenda ; P07, P08, P09, P11 | Un cycle complet de dossier, de la collecte à la télétransmission dans l'environnement de test du concentrateur, est réalisé sans ressaisie |
| 4. Entrées avancées et IA | Transcription audio ; process mining ; simulation dynamique ; agents IA avec seuils ; assistant d'aide ; réutilisation des modèles ; export PowerPoint | Un entretien enregistré et un journal d'événements enrichissent le modèle ; AS-IS et TO-BE sont simulés et comparés ; les 3 actions toujours humaines ne peuvent pas être exécutées par un agent |
| 5. Mobile et industrialisation | Application mobile générique avec hors connexion partiel ; audit RGAA ; canal de mise à jour automatique ; chartes par client ; autres connecteurs comptables | L'application est publiée dans les deux stores ; une pièce photographiée hors connexion est transmise au retour du réseau ; l'audit RGAA ne relève aucune non-conformité bloquante |

### 11.3 Coûts récurrents estimés

Montants approximatifs, établis sans devis : ils seront confirmés par les offres des fournisseurs.

| Poste | À partir de | Ordre de grandeur |
| --- | --- | --- |
| Hébergement de la plateforme (cluster, base managée, stockage) | Incrément 1 | 100 à 250 € par mois |
| API d'IA (développement et missions) | Incrément 1 | 50 à 200 € par mois, selon l'usage |
| Dépôt GitHub privé | Incrément 1 | Gratuit à quelques euros par mois |
| Concentrateur EDI | Incrément 3 | Sur devis |
| Agrégateur bancaire | Incrément 3 | Sur devis |
| Signature électronique | Incrément 3 | Sur devis |
| Comptes développeur Apple et Google | Incrément 5 | Environ 99 $ par an (Apple) et 25 $ une fois (Google) |

Les incréments 1 et 2 tiennent dans le budget. À partir de l'incrément 3, les trois services sur devis risquent de le dépasser : une partie pourra être refacturée aux clients (section 12).

### 11.4 Effort de développement

Le développement est réalisé principalement par Claude ; son rythme dépend surtout de votre disponibilité pour les validations, les comptes et les tests avec le cabinet. Plutôt qu'une durée inventée, l'effort de chaque incrément sera estimé en détail au début de celui-ci, et réestimé après l'incrément 1 à partir du rythme réellement observé.

| Incrément | Complexité relative |
| --- | --- |
| 1. Analyse et cartographie | Très élevée |
| 2. Moteur d'application | Très élevée |
| 3. Intégrations | Élevée, dépendante des accès éditeurs |
| 4. Entrées avancées et IA | Élevée |
| 5. Mobile et industrialisation | Moyenne |

## 12. Hypothèses, risques et points ouverts

Le principal risque est l'ampleur du MVP au regard d'une équipe réduite ; viennent ensuite la confidentialité des données des cabinets et l'accès aux API des éditeurs. Les mesures ci-dessous sont des propositions à valider.

### 12.1 Hypothèses non confirmées

- Le cabinet pressenti s'engage dans la mission et désigne un validateur.
- Les cabinets clients disposent, en interne ou chez un prestataire, d'une infrastructure à conteneurs conforme aux exigences de la section 10.3.
- Les API de Sage / ACD et du logiciel de paie sont accessibles à des conditions compatibles avec le budget.
- Les fournisseurs d'IA choisis couvrent les capacités requises (texte, documents, audio).
- Vous êtes disponible pour les validations, les comptes et les tests au rythme du développement.

### 12.2 Registre des risques

| Risque | Probabilité | Impact | Mesure proposée |
| --- | --- | --- | --- |
| Périmètre du MVP trop large pour une équipe réduite : délai long avant le pilote | Élevée | Élevé | Pilote dès l'incrément 2 ; réestimation après l'incrément 1 ; arbitrage de périmètre soumis à votre décision si besoin |
| Anonymisation automatique sans relecture : données d'un cabinet visibles par un autre, atteinte au secret professionnel | Moyenne | Très élevé | Tests d'anonymisation sur jeux piégés avant mise en service ; détection des noms, montants et identifiants restants ; journal de chaque publication. Ou réintroduire une relecture par l'administrateur |
| Accès aux API des éditeurs (Sage / ACD) soumis à partenariat, coûteux ou lent | Moyenne | Élevé | Vérifier dès l'incrément 1 ; solution de repli par échange de fichiers (imports, exports) |
| Engagement de service en production sans supervision : incidents connus seulement si le client les signale | Moyenne | Élevé | Exigences minimales et transmission des alertes au contrat ; engagement suspendu si elles ne sont pas respectées |
| Cabinets sans compétence pour héberger des conteneurs | Élevée | Moyen | Vérification des prérequis avant signature ; prestataires d'hébergement recommandés |
| Budget de 500 € par mois dépassé à partir de l'incrément 3 | Élevée | Moyen | Activation au dernier moment ; refacturation aux clients des services liés à leur application |
| Erreurs de l'IA (extraction erronée, élément inventé) reprises dans les livrables | Moyenne | Élevé | Statuts « hypothèse », sources citées, confirmation par le consultant, validations client |
| Sécurité de niveau standard jugée insuffisante par un cabinet | Moyenne | Moyen | Test d'intrusion et chiffrement par client proposés en option, ou ajoutés avant le SaaS |
| Fournisseur d'IA réutilisant les données pour l'entraînement, choisi par un client | Faible | Élevé | Politique du fournisseur affichée et acceptée explicitement par le client, accord conservé |
| Évolutions réglementaires (formats déclaratifs, AI Act) | Élevée | Moyen | Formats portés par le concentrateur ; avis d'un juriste sur l'AI Act |
| Cabinet pilote non engagé : pas de données ni de validation réelles | Moyenne | Élevé | Incrément 1 mené sur votre description ; engagement à obtenir avant la fin de l'incrément 2 |
| Continuité du développement entre sessions | Moyenne | Moyen | Spécifications et décisions dans le dépôt ; tests automatisés ; aucune connaissance hors du dépôt |

### 12.3 Points ouverts consolidés

| Point | Section | À traiter avant |
| --- | --- | --- |
| Valeurs cibles des indicateurs de succès | 1.5 | Fin du pilote |
| Critères de réussite du pilote | 8.6 | Incrément 2 |
| Taille et engagement du cabinet pressenti | 8.7 | Incrément 2 |
| Logiciel de paie du cabinet | 7.5 | Incrément 3 |
| Conditions d'accès aux API Sage / ACD | 7.5 | Incrément 3, vérification dès l'incrément 1 |
| Choix du concentrateur EDI, de l'agrégateur bancaire et de la signature | 7.5 | Incrément 3 |
| Refacturation des services payants aux clients | 11.3 | Incrément 3 |
| Mesures contre le risque d'anonymisation | 12.2 | Incrément 4 |
| Classement au regard de l'AI Act (juriste) | 6.8 | Incrément 4 |
| Disponibilité du nom Processia (marque, domaine) | — | Tout usage commercial |

### 12.4 Prochaines étapes

1. Validation de l'ensemble du cahier des charges.
2. Création du dépôt GitHub privé.
3. Rédaction des spécifications techniques de l'incrément 1, dans le dépôt.
4. Maquettes de l'incrément 1, soumises à votre validation.
5. Développement de l'incrément 1.
