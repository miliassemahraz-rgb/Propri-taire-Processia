import { describe, expect, it } from 'vitest';
import {
  PILOT_ANSWER_ENVIRONMENT,
  PILOT_ANSWER_IMPUTATION,
  PILOT_ANSWER_SAISIE,
  PILOT_GUIDED_SCENARIOS,
  PILOT_HYPOTHESES,
  pilotAnswerIntegrateScenario,
  pilotHypothesesScenario,
  pilotQuestionsScenario,
} from './pilot-guided.js';

const user = (content: string) => ({ messages: [{ role: 'user', content }] });
const donnees = (value: unknown) => user(`<donnees>\n${JSON.stringify(value)}\n</donnees>`);
const morceau = (text: string) =>
  user(`<question>?</question>\n<morceau id="c1" source="s">\n${text}\n</morceau>`);

describe('scénarios factices du questionnement (WP-14)', () => {
  it('un scénario par pipeline du questionnement', () => {
    expect(Object.keys(PILOT_GUIDED_SCENARIOS).sort()).toEqual([
      'answer.integrate',
      'deliverable.summary',
      'hypotheses',
      'questions',
    ]);
  });

  it('les questions sont classées, la plus bloquante d’abord, sans reposer une question posée', () => {
    const gaps = [
      {
        check: 'activities.process_has_task',
        message: 'x',
        elementCode: 'P05.1',
        elementLabel: 'Saisie',
      },
      {
        check: 'activities.process_has_task',
        message: 'x',
        elementCode: 'P01.1',
        elementLabel: 'Prospects',
      },
      { check: 'business.environment', message: 'x' },
    ];
    const out = pilotQuestionsScenario(
      donnees({ report: [{ concept: 'x', gaps }], asked: [] }),
    ) as {
      questions: { blockingScore: number; text: string }[];
    };
    const scores = out.questions.map((q) => q.blockingScore);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(out.questions[0]?.text).toContain('environnement');
    const again = pilotQuestionsScenario(
      donnees({ report: [{ concept: 'x', gaps }], asked: [out.questions[0]?.text] }),
    ) as { questions: { text: string }[] };
    expect(again.questions.map((q) => q.text)).not.toContain(out.questions[0]?.text);
  });

  it('les citations des réponses sont des sous-chaînes exactes de la réponse', () => {
    for (const answer of [PILOT_ANSWER_ENVIRONMENT, PILOT_ANSWER_SAISIE, PILOT_ANSWER_IMPUTATION]) {
      const out = pilotAnswerIntegrateScenario(morceau(answer)) as {
        candidates: { quote: string }[];
      };
      expect(out.candidates.length).toBeGreaterThan(0);
      for (const c of out.candidates) expect(answer).toContain(c.quote);
    }
    expect(pilotAnswerIntegrateScenario(morceau('Rien à signaler.'))).toEqual({ candidates: [] });
  });

  it('les hypothèses déjà rejetées ne sont pas reproposées', () => {
    const all = pilotHypothesesScenario(donnees({ rejected: [] })) as { proposals: unknown[] };
    expect(all.proposals).toHaveLength(PILOT_HYPOTHESES.length);
    const some = pilotHypothesesScenario(
      donnees({ rejected: [{ kind: 'tool', label: 'logiciel de ged' }] }),
    ) as { proposals: { label: string }[] };
    expect(some.proposals).toHaveLength(PILOT_HYPOTHESES.length - 1);
    expect(some.proposals.map((p) => p.label)).not.toContain('Logiciel de GED');
  });
});
