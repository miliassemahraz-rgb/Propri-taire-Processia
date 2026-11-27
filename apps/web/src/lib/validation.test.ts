import type { CommentDto, NotificationDto, SubmissionDto } from '@processia/contracts';
import { describe, expect, it } from 'vitest';
import {
  commentCount,
  defaultSubmission,
  latestOf,
  notificationHref,
  payloadCount,
  payloadText,
  threadsFor,
  unreadCount,
  validationSteps,
} from './validation';

function submission(overrides: Partial<SubmissionDto>): SubmissionDto {
  return {
    id: `s-${overrides.round ?? 1}`,
    missionId: 'm',
    kind: 'analysis_dossier',
    round: 1,
    modelVersion: 3,
    status: 'submitted',
    submittedBy: { id: 'u', name: 'Camille' },
    submittedAt: '2026-11-27T09:00:00.000Z',
    decidedBy: null,
    decidedAt: null,
    comment: null,
    exports: [],
    excludedCount: 0,
    ...overrides,
  };
}

function comment(overrides: Partial<CommentDto>): CommentDto {
  return {
    id: 'c1',
    targetKind: 'element',
    targetId: 'e1',
    modelVersion: 3,
    parentId: null,
    submissionId: 's-1',
    author: { id: 'u', name: 'Validateur', role: 'validator' },
    body: 'Bonjour',
    createdAt: '2026-11-27T09:00:00.000Z',
    resolvedAt: null,
    ...overrides,
  };
}

describe('étapes de validation', () => {
  it('sans soumission : le dossier est à soumettre, la suite est à venir', () => {
    expect(validationSteps([]).map((s) => s.state)).toEqual(['toSubmit', 'soon', 'soon']);
  });

  it('une soumission en attente : étape en cours de validation', () => {
    expect(validationSteps([submission({})]).map((s) => s.state)).toEqual([
      'pending',
      'soon',
      'soon',
    ]);
  });

  it('dossier validé : l’AS-IS devient à soumettre', () => {
    const steps = validationSteps([submission({ status: 'validated' })]);
    expect(steps.map((s) => s.state)).toEqual(['validated', 'toSubmit', 'soon']);
  });

  it('une soumission retirée ou remplacée ne compte pas comme validée', () => {
    const steps = validationSteps([
      submission({ round: 1, status: 'withdrawn' }),
      submission({ round: 2, status: 'superseded' }),
    ]);
    expect(steps[0]?.state).toBe('toSubmit');
    expect(
      latestOf([submission({ round: 1, status: 'withdrawn' })], 'analysis_dossier'),
    ).toBeNull();
  });
});

describe('soumission affichée', () => {
  it('privilégie celle qui attend une décision, puis la plus récente', () => {
    const list = [
      submission({ round: 1, status: 'superseded' }),
      submission({ round: 2, status: 'submitted' }),
    ];
    expect(defaultSubmission(list)?.round).toBe(2);
    const done = [
      submission({ round: 1, status: 'superseded', submittedAt: '2026-11-26T09:00:00.000Z' }),
      submission({ round: 2, status: 'validated', submittedAt: '2026-11-27T09:00:00.000Z' }),
    ];
    expect(defaultSubmission(done)?.round).toBe(2);
    expect(defaultSubmission([])).toBeNull();
    expect(defaultSubmission([submission({ status: 'withdrawn' })])).toBeNull();
  });
});

describe('fils de commentaires', () => {
  const all = [
    comment({ id: 'c2', createdAt: '2026-11-27T10:00:00.000Z' }),
    comment({ id: 'c1' }),
    comment({ id: 'r1', parentId: 'c1', createdAt: '2026-11-27T09:30:00.000Z' }),
    comment({ id: 'x', targetId: 'e2' }),
    comment({ id: 'y', submissionId: 's-2' }),
  ];

  it('regroupe réponses sous leur racine, par ordre chronologique', () => {
    const threads = threadsFor(all, 's-1', 'element', 'e1');
    expect(threads.map((t) => t.root.id)).toEqual(['c1', 'c2']);
    expect(threads[0]?.replies.map((r) => r.id)).toEqual(['r1']);
  });

  it('compte les commentaires d’une cible dans une soumission', () => {
    expect(commentCount(all, 's-1', 'element', 'e1')).toBe(3);
    expect(commentCount(all, 's-1', 'element', 'e2')).toBe(1);
    expect(commentCount(all, 's-1', 'submission', 's-1')).toBe(0);
  });
});

describe('notifications', () => {
  const items: NotificationDto[] = [
    {
      id: '1',
      kind: 'x',
      missionId: 'm1',
      payload: { a: 'b', n: 3, list: [1, 2] },
      createdAt: '',
      readAt: null,
    },
    { id: '2', kind: 'x', missionId: null, payload: null, createdAt: '', readAt: '2026-11-27' },
  ];

  it('compte les non lues et construit le lien', () => {
    expect(unreadCount(items)).toBe(1);
    expect(notificationHref(items[0] as NotificationDto)).toBe('/missions/m1/validation');
    expect(notificationHref(items[1] as NotificationDto)).toBeNull();
  });

  it('lit la charge utile sans supposer sa forme', () => {
    expect(payloadText(items[0]?.payload, 'a')).toBe('b');
    expect(payloadText(items[0]?.payload, 'n')).toBe('3');
    expect(payloadText(items[1]?.payload, 'a')).toBe('');
    expect(payloadCount(items[0]?.payload, 'list')).toBe(2);
    expect(payloadCount(null, 'list')).toBe(0);
  });
});
