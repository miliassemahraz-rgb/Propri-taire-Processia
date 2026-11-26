/**
 * @processia/policy : matrice des droits (CDC 2.4, spécification 3.5 amendée par PO-22).
 * Fonctions pures, sans dépendance à la base ni à Nest.
 */
export const PACKAGE_NAME = '@processia/policy' as const;

export const GLOBAL_ROLES = ['admin', 'mission_manager', 'consultant', 'client_validator'] as const;
export type GlobalRole = (typeof GLOBAL_ROLES)[number];

export const MISSION_ROLES = ['manager', 'consultant', 'validator'] as const;
export type MissionRole = (typeof MISSION_ROLES)[number];

export const ACTIONS = [
  'users.manage',
  'users.invite',
  'ai_providers.manage',
  'clients.manage',
  'mission.create',
  'mission.assign',
  'mission.view_progress',
  'mission.read_workspace',
  'model.edit',
  'comment.create',
  'submission.create',
  'submission.read',
  'submission.decide',
  'export.create',
  'history.rollback',
  'model.publish_template',
] as const;
export type Action = (typeof ACTIONS)[number];

/**
 * Colonne de la matrice appliquée à un sujet.
 *  les quatre colonnes de la spécification 3.5. Un responsable de mission global a la colonne
 *  `manager` sur toutes les missions, membre ou non (PO-22, PO-30 « droits complets »).
 */
export const PERSONAS = ['admin', 'manager', 'consultant', 'validator'] as const;
export type Persona = (typeof PERSONAS)[number];

/** `true` : autorisé ; `false` : refusé ; `'own'` : autorisé sur les soumissions du validateur. */
export type Cell = boolean | 'own';

/** Portée de l'action : `global` (rôle global du compte) ou `mission` (rôle dans la mission). */
export const ACTION_SCOPE: Record<Action, 'global' | 'mission'> = {
  'users.manage': 'global',
  'users.invite': 'global',
  'ai_providers.manage': 'global',
  'clients.manage': 'global',
  'mission.create': 'global',
  'mission.assign': 'mission',
  'mission.view_progress': 'mission',
  'mission.read_workspace': 'mission',
  'model.edit': 'mission',
  'comment.create': 'mission',
  'submission.create': 'mission',
  'submission.read': 'mission',
  'submission.decide': 'mission',
  'export.create': 'mission',
  'history.rollback': 'mission',
  'model.publish_template': 'global',
};

function cells(
  admin: Cell,
  manager: Cell,
  consultant: Cell,
  validator: Cell,
): Record<Persona, Cell> {
  return { admin, manager, consultant, validator };
}

/** La matrice 3.5, une ligne par action. L'ordre des colonnes suit `PERSONAS`. */
export const MATRIX: Record<Action, Record<Persona, Cell>> = {
  'users.manage': cells(true, false, false, false),
  // Le responsable invite des consultants et des validateurs pour ses missions (PO-27).
  'users.invite': cells(true, true, false, false),
  'ai_providers.manage': cells(true, false, false, false),
  'clients.manage': cells(true, false, false, false),
  'mission.create': cells(true, true, false, false),
  'mission.assign': cells(true, true, false, false),
  'mission.view_progress': cells(true, true, true, false),
  'mission.read_workspace': cells(true, true, true, false),
  'model.edit': cells(false, true, true, false),
  'comment.create': cells(true, true, true, 'own'),
  'submission.create': cells(false, true, true, false),
  'submission.read': cells(true, true, true, 'own'),
  'submission.decide': cells(false, false, false, true),
  'export.create': cells(true, true, true, 'own'),
  'history.rollback': cells(false, true, true, false),
  'model.publish_template': cells(true, false, false, false),
};

export interface Subject {
  globalRole: GlobalRole;
  /** Rôle dans la mission concernée ; `null` ou absent si le compte n'en est pas membre. */
  missionRole?: MissionRole | null;
}

export interface Resource {
  /** La soumission (ou l'export) visée est celle du validateur : requis pour les cellules « ses ». */
  own?: boolean;
}

const GLOBAL_PERSONA: Record<GlobalRole, Persona> = {
  admin: 'admin',
  mission_manager: 'manager',
  consultant: 'consultant',
  client_validator: 'validator',
};

/** Colonne applicable au sujet pour l'action, ou `null` si aucune (non membre sans droit global). */
export function personaFor(subject: Subject, action: Action): Persona | null {
  if (ACTION_SCOPE[action] === 'global') return GLOBAL_PERSONA[subject.globalRole];
  if (subject.globalRole === 'admin') return 'admin';
  // PO-30 : le responsable de mission global a les droits du responsable sur toutes les missions.
  if (subject.globalRole === 'mission_manager') return 'manager';
  switch (subject.missionRole ?? null) {
    case 'manager':
      return 'manager';
    case 'consultant':
      return 'consultant';
    case 'validator':
      return 'validator';
    default:
      return null;
  }
}

/** Le sujet peut-il voir la mission ? Administrateur et responsables : toutes (PO-22). */
export function canSeeMission(subject: Subject): boolean {
  return (
    subject.globalRole === 'admin' ||
    subject.globalRole === 'mission_manager' ||
    (subject.missionRole ?? null) !== null
  );
}

/** Décision d'un droit. Une cellule « ses soumissions » exige `resource.own === true`. */
export function can(subject: Subject, action: Action, resource: Resource = {}): boolean {
  const persona = personaFor(subject, action);
  if (persona === null) return false;
  const cell = MATRIX[action][persona];
  return cell === 'own' ? resource.own === true : cell;
}

export function isAction(value: string): value is Action {
  return (ACTIONS as readonly string[]).includes(value);
}
