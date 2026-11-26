import { BpmnModdle } from 'bpmn-moddle';
import { PROCESSIA_NS, PROCESSIA_PREFIX } from './ids.js';

/**
 * Descripteur moddle de l'extension `processia` (espace de noms `urn:processia:bpmn:1`).
 * - `processia:elementId` : identifiant exact de l'élément du modèle (éléments sémantiques et formes) ;
 * - `processia:derived` : lien ou forme déduit de l'ordre, sans élément du modèle ;
 * - `processia:AiAgent` : tâche exécutée par un agent IA (`serviceTask` étendue).
 */
export const PROCESSIA_DESCRIPTOR = {
  name: 'Processia',
  uri: PROCESSIA_NS,
  prefix: PROCESSIA_PREFIX,
  types: [
    {
      name: 'ElementRef',
      extends: ['bpmn:BaseElement', 'bpmndi:BPMNShape', 'bpmndi:BPMNEdge'],
      properties: [
        { name: 'elementId', isAttr: true, type: 'String' },
        { name: 'derived', isAttr: true, type: 'Boolean' },
      ],
    },
    {
      name: 'AiAgent',
      superClass: ['Element'],
      properties: [
        { name: 'capability', isAttr: true, type: 'String' },
        { name: 'automationType', isAttr: true, type: 'String' },
      ],
    },
  ],
};

export function createModdle(): BpmnModdle {
  return new BpmnModdle({ processia: PROCESSIA_DESCRIPTOR });
}
