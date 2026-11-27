const LOCALE = 'fr-FR';

/** Date courte (jour, mois, année) au format français. */
export function formatDate(value: string): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'medium' }).format(new Date(value));
}

/** Date longue, pour les phrases (« 27 novembre 2026 »). */
export function formatLongDate(value: string): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'long' }).format(new Date(value));
}

/** Date et heure courtes. */
export function formatDateTime(value: string): string {
  return new Intl.DateTimeFormat(LOCALE, { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(value),
  );
}
