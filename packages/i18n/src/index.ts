import fr from './messages/fr.json' with { type: 'json' };

/** Messages de l'interface. Le français est la seule langue de l'incrément 1. */
export const messages = fr;
export type Messages = typeof fr;

type Flatten<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string ? `${Prefix}${K}` : Flatten<T[K], `${Prefix}${K}.`>;
}[keyof T & string];

/** Union des clés de traduction valides, par exemple `app.name`. */
export type MessageKey = Flatten<Messages>;

export type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

function lookup(path: string): string | undefined {
  let current: unknown = messages;
  for (const part of path.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' ? current : undefined;
}

/**
 * Traduit une clé. Les paramètres sont écrits `{nom}` dans le message.
 * Une clé inconnue lève une erreur : le typage `MessageKey` l'empêche déjà à la compilation.
 */
export const t: Translate = (key, values = {}) => {
  const template = lookup(key);
  if (template === undefined) throw new Error(`Clé de traduction inconnue : ${key}`);
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in values ? String(values[name]) : match,
  );
};

export const PACKAGE_NAME = '@processia/i18n' as const;
