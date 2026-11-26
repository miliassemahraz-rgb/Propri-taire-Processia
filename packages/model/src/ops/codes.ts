import type { Element } from '../schema/element.js';
import type { ElementKind } from '../schema/kinds.js';

/** Préfixe et largeur des codes des éléments hors hiérarchie d'activités (spécification 2.2). */
const CODE_FORMAT: Record<Exclude<ElementKind, 'activity'>, { prefix: string; width: number }> = {
  business_trait: { prefix: 'TRT', width: 2 },
  glossary_term: { prefix: 'TRM', width: 2 },
  actor: { prefix: 'ACT', width: 2 },
  event: { prefix: 'EVT', width: 2 },
  gateway: { prefix: 'GW', width: 2 },
  sequence_flow: { prefix: 'SEQ', width: 2 },
  process_link: { prefix: 'LNK', width: 2 },
  data_object: { prefix: 'DON', width: 2 },
  tool: { prefix: 'OUT', width: 2 },
  information_flow: { prefix: 'FLX', width: 2 },
  rule: { prefix: 'RG', width: 3 },
  indicator: { prefix: 'IND', width: 2 },
  discrepancy: { prefix: 'ECA', width: 2 },
  finding: { prefix: 'CST', width: 2 },
  optimisation: { prefix: 'OPT', width: 2 },
};

/**
 * Prochain code libre pour `element`, compte tenu des codes `taken` (unicité par mission).
 * `parent` : activité parente (pour `P04.1`, `P04.1.3`…).
 */
export function nextCode(
  element: Element,
  taken: ReadonlySet<string>,
  parentCode: string | undefined,
): string {
  if (element.kind === 'activity') {
    if (element.level === 'macro') {
      let n = 0;
      for (const c of taken) {
        const m = /^P(\d+)$/.exec(c);
        if (m) n = Math.max(n, Number(m[1]));
      }
      let code: string;
      do {
        n += 1;
        code = `P${String(n).padStart(2, '0')}`;
      } while (taken.has(code));
      return code;
    }
    const prefix = `${parentCode ?? 'P00'}.`;
    let n = 0;
    for (const c of taken) {
      if (c.startsWith(prefix)) {
        const rest = c.slice(prefix.length);
        if (/^\d+$/.test(rest)) n = Math.max(n, Number(rest));
      }
    }
    let code: string;
    do {
      n += 1;
      code = `${prefix}${n}`;
    } while (taken.has(code));
    return code;
  }
  const { prefix, width } = CODE_FORMAT[element.kind];
  let n = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const c of taken) {
    const m = re.exec(c);
    if (m) n = Math.max(n, Number(m[1]));
  }
  let code: string;
  do {
    n += 1;
    code = `${prefix}-${String(n).padStart(width, '0')}`;
  } while (taken.has(code));
  return code;
}
