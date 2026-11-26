import { describe, expect, it } from 'vitest';
import { refLocator } from './extraction.service.js';

describe('refLocator : localisateur de morceau -> localisateur de référence', () => {
  it('reporte page, feuille et cellules, paragraphe et ligne', () => {
    expect(refLocator({ kind: 'page', pageStart: 2, pageEnd: 3 })).toEqual({ page: 2 });
    expect(
      refLocator({ kind: 'cell', sheet: 'Acteurs', range: 'A1:B3', rowStart: 1, rowEnd: 3 }),
    ).toEqual({ sheet: 'Acteurs', cell: 'A1:B3' });
    expect(refLocator({ kind: 'paragraph', paragraphStart: 4, paragraphEnd: 6 })).toEqual({
      paragraph: 4,
    });
    expect(refLocator({ kind: 'line', lineStart: 7, lineEnd: 9 })).toEqual({ paragraph: 7 });
    expect(refLocator(null)).toEqual({});
  });
});
