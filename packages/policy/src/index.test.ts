import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  MATRIX,
  PERSONAS,
  can,
  canSeeMission,
  personaFor,
  type Action,
  type Persona,
  type Subject,
} from './index.js';

const SUBJECTS: Record<Persona, Subject> = {
  admin: { globalRole: 'admin' },
  manager: { globalRole: 'mission_manager', missionRole: 'manager' },
  consultant: { globalRole: 'consultant', missionRole: 'consultant' },
  validator: { globalRole: 'client_validator', missionRole: 'validator' },
  observer: { globalRole: 'mission_manager', missionRole: null },
};

type Row = [boolean, boolean, boolean, boolean | 'own', boolean];

/** Spécification 3.5 (amendée PO-22), écrite indépendamment de `MATRIX` : A, M, C, V, O. */
const EXPECTED: Record<Action, Row> = {
  'users.manage': [true, false, false, false, false],
  'users.invite': [true, true, false, false, false],
  'ai_providers.manage': [true, false, false, false, false],
  'clients.manage': [true, false, false, false, false],
  'mission.create': [true, true, false, false, false],
  'mission.assign': [true, true, false, false, false],
  'mission.view_progress': [true, true, true, false, true],
  'mission.read_workspace': [true, true, true, false, true],
  'model.edit': [false, true, true, false, false],
  'comment.create': [true, true, true, 'own', true],
  'submission.create': [false, true, true, false, false],
  'submission.read': [true, true, true, 'own', true],
  'submission.decide': [false, false, false, true, false],
  'export.create': [true, true, true, 'own', true],
  'history.rollback': [false, true, true, false, false],
  'model.publish_template': [true, false, false, false, false],
};

// Les actions globales dépendent du rôle global : un responsable non membre garde ses droits.
const GLOBAL = new Set<Action>([
  'users.manage',
  'users.invite',
  'ai_providers.manage',
  'clients.manage',
  'mission.create',
  'model.publish_template',
]);

describe('matrice des droits 3.5', () => {
  it('couvre toutes les actions', () => {
    expect(Object.keys(MATRIX).sort()).toEqual([...ACTIONS].sort());
    expect(Object.keys(EXPECTED).sort()).toEqual([...ACTIONS].sort());
  });

  const rows = ACTIONS.flatMap((action) =>
    PERSONAS.map((persona, index) => ({ action, persona, index })),
  );

  it.each(rows)('$action x $persona', ({ action, persona, index }) => {
    const expected = EXPECTED[action][index];
    const subject = SUBJECTS[persona];
    expect(MATRIX[action][persona]).toBe(expected);
    if (GLOBAL.has(action) && persona === 'observer') {
      expect(can(subject, action)).toBe(EXPECTED[action][1]);
      return;
    }
    if (expected === 'own') {
      expect(can(subject, action)).toBe(false);
      expect(can(subject, action, { own: false })).toBe(false);
      expect(can(subject, action, { own: true })).toBe(true);
    } else {
      expect(can(subject, action)).toBe(expected);
      expect(can(subject, action, { own: true })).toBe(expected);
    }
  });

  it('un consultant ou un validateur non membre n’a aucun droit de mission', () => {
    for (const globalRole of ['consultant', 'client_validator'] as const) {
      for (const action of ACTIONS.filter((a) => !GLOBAL.has(a))) {
        expect(can({ globalRole }, action, { own: true })).toBe(false);
        expect(personaFor({ globalRole }, action)).toBeNull();
      }
    }
  });

  it('l’administrateur ne peut ni éditer le modèle ni décider d’une soumission', () => {
    expect(can({ globalRole: 'admin' }, 'model.edit')).toBe(false);
    expect(can({ globalRole: 'admin' }, 'submission.decide')).toBe(false);
  });

  it('visibilité des missions (PO-22)', () => {
    expect(canSeeMission({ globalRole: 'admin' })).toBe(true);
    expect(canSeeMission({ globalRole: 'mission_manager' })).toBe(true);
    expect(canSeeMission({ globalRole: 'consultant' })).toBe(false);
    expect(canSeeMission({ globalRole: 'consultant', missionRole: 'consultant' })).toBe(true);
    expect(canSeeMission({ globalRole: 'client_validator', missionRole: 'validator' })).toBe(true);
  });
});
