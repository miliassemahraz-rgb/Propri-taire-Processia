/** Identifiants (spécification 2.1). Fonctions pures : l'horloge et l'aléa sont des paramètres. */

/** UUID v7 : 48 bits d'horodatage, version 7, variante RFC 9562. */
export const UUID_V7_SOURCE = '[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
/** Identifiant temporaire d'un élément ajouté par un ChangeSet (« tmp:3 »), résolu par le serveur. */
export const TEMP_ID_SOURCE = 'tmp:[0-9]+';

/** Motif d'un identifiant persistant. */
export const PERSISTENT_ID_PATTERN = `^${UUID_V7_SOURCE}$`;
/** Motif d'un identifiant d'élément dans un ChangeSet : persistant ou temporaire. */
export const ELEMENT_ID_PATTERN = `^(?:${UUID_V7_SOURCE}|${TEMP_ID_SOURCE})$`;

const persistentRe = new RegExp(PERSISTENT_ID_PATTERN);
const tempRe = new RegExp(`^${TEMP_ID_SOURCE}$`);

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && persistentRe.test(value);
}

export function isTempId(value: unknown): value is string {
  return typeof value === 'string' && tempRe.test(value);
}

export function tempId(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('tempId : entier positif attendu');
  return `tmp:${n}`;
}

/**
 * Fabrique un UUID v7 à partir d'un instant (ms depuis l'époque Unix) et de 10 octets aléatoires.
 * Pur : l'appelant fournit l'horloge et l'aléa.
 */
export function uuidv7(nowMs: number, random: Uint8Array): string {
  if (!Number.isInteger(nowMs) || nowMs < 0 || nowMs > 0xffff_ffff_ffff) {
    throw new RangeError('uuidv7 : horodatage hors limites (48 bits)');
  }
  if (random.length < 10) throw new RangeError('uuidv7 : 10 octets aléatoires requis');
  const bytes = new Uint8Array(16);
  let t = nowMs;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = t % 256;
    t = Math.floor(t / 256);
  }
  for (let i = 0; i < 10; i++) bytes[6 + i] = random[i] ?? 0;
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Générateur déterministe pour les tests : le n-ième identifiant est toujours le même. */
export function sequentialIdGenerator(prefix = 0): () => string {
  let n = 0;
  return () => {
    n += 1;
    const tail = n.toString(16).padStart(12, '0');
    const head = prefix.toString(16).padStart(4, '0');
    return `01900000-${head}-7000-8000-${tail}`;
  };
}
