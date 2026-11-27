/**
 * Vérification des citations (spécification 4.5, point 3) : après normalisation (espaces,
 * apostrophes et guillemets typographiques, casse, Unicode NFC), la citation doit être une
 * sous-chaîne du morceau. Les positions renvoyées portent sur le texte d'origine du morceau.
 */

const APOSTROPHES = /[‘’‛ʼ′`´]/;
const QUOTES = /[“”„‟«»″]/;
const DASHES = /[‐-―−]/;
const COMBINING = /\p{M}/u;
const SPACE = /^\s$/;

interface Normalized {
  /** Caractères (points de code) du texte normalisé. */
  chars: string[];
  /** Pour chaque caractère normalisé : début et fin (exclue) dans le texte d'origine. */
  starts: number[];
  ends: number[];
}

function normalizeCluster(cluster: string): string {
  const c = cluster.normalize('NFC').toLowerCase();
  if (APOSTROPHES.test(c)) return "'";
  if (QUOTES.test(c)) return '"';
  if (DASHES.test(c)) return '-';
  if (c === '…') return '...';
  return c;
}

/** Normalise en conservant la correspondance caractère à caractère avec l'original. */
function normalizeWithMap(input: string): Normalized {
  const source = Array.from(input);
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let offset = 0;
  let i = 0;
  while (i < source.length) {
    const start = offset;
    let cluster = source[i] as string;
    i += 1;
    offset += cluster.length;
    if (SPACE.test(cluster)) {
      // Suite d'espaces : un seul espace, rattaché à toute la suite.
      while (i < source.length && SPACE.test(source[i] as string)) {
        offset += (source[i] as string).length;
        i += 1;
      }
      if (chars[chars.length - 1] === ' ') {
        ends[ends.length - 1] = offset;
      } else {
        chars.push(' ');
        starts.push(start);
        ends.push(offset);
      }
      continue;
    }
    // Un caractère de base suivi de ses marques combinantes forme une seule unité (NFC).
    while (i < source.length && COMBINING.test(source[i] as string)) {
      cluster += source[i] as string;
      offset += (source[i] as string).length;
      i += 1;
    }
    for (const n of Array.from(normalizeCluster(cluster))) {
      chars.push(n);
      starts.push(start);
      ends.push(offset);
    }
  }
  return { chars, starts, ends };
}

/** Texte comparable : mêmes règles que la vérification des citations (sans espaces de bord). */
export function normalizeForMatch(input: string): string {
  return normalizeWithMap(input).chars.join('').trim();
}

export interface CitationPosition {
  charStart: number;
  charEnd: number;
}

/**
 * Cherche `quote` dans `chunkText`. Renvoie les positions (unités UTF-16, dans `chunkText`) ou
 * `null` si la citation n'est pas retrouvée.
 */
export function verifyCitation(chunkText: string, quote: string): CitationPosition | null {
  const needle = normalizeForMatch(quote);
  if (needle.length === 0) return null;
  const hay = normalizeWithMap(chunkText);
  const hayText = hay.chars.join('');
  const at = hayText.indexOf(needle);
  if (at < 0) return null;
  // `indexOf` compte en unités UTF-16, les tableaux en points de code.
  const first = Array.from(hayText.slice(0, at)).length;
  const last = first + Array.from(needle).length - 1;
  const start = hay.starts[first];
  const end = hay.ends[last];
  if (start === undefined || end === undefined) return null;
  return { charStart: start, charEnd: end };
}
