import { describe, expect, it } from 'vitest';
import { ENGINE_CAPABILITIES, ENGINE_CAPABILITY_IDS, getCapability } from './index.js';

describe('catalogue des capacités du moteur', () => {
  it('contient les 15 capacités de la spécification 2.6', () => {
    expect([...ENGINE_CAPABILITY_IDS].sort()).toEqual(
      [
        'assign_auto',
        'reminder',
        'escalation',
        'deadline_alert',
        'state_change',
        'doc_generation',
        'e_signature',
        'ocr_extraction',
        'connector:accounting',
        'connector:bank',
        'connector:edi',
        'agent:classify_documents',
        'agent:anomaly_detection',
        'agent:drafting',
        'agent:decision_support',
      ].sort(),
    );
    expect(ENGINE_CAPABILITIES).toHaveLength(15);
  });

  it('recherche par identifiant', () => {
    expect(getCapability('reminder')?.label).toBe('Relance automatique');
    expect(getCapability('inconnu')).toBeUndefined();
  });
});
