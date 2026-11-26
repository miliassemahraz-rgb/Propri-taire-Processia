/// <reference lib="dom" />
/**
 * Import dans bpmn-js (NavigatedViewer) sous Chromium, via Playwright : aucun avertissement d'import.
 * Lancé par `pnpm test:int` (Chromium requis ; en CI, installé avant les tests d'intégration).
 * Chemin du navigateur : variable `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` si elle est définie.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BusinessModel } from '@processia/model';
import { listDiagrams, toBpmn, toBpmnCombined } from './index.js';
import { buildCompleteModel, buildMinimalModel, buildRichModel } from './test-support.js';

const require = createRequire(import.meta.url);
const VIEWER = join(
  dirname(require.resolve('bpmn-js/package.json')),
  'dist/bpmn-navigated-viewer.development.js',
);

let browser: Browser;
let page: Page;
const pageErrors: string[] = [];

beforeAll(async () => {
  const executablePath = process.env['PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH'];
  browser = await chromium.launch(executablePath ? { executablePath } : {});
  page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') pageErrors.push(m.text());
  });
  await page.setContent('<div id="canvas" style="width:1800px;height:1000px"></div>');
  await page.addScriptTag({ path: VIEWER });
});

afterAll(async () => {
  await browser?.close();
});

interface ImportResult {
  warnings: string[];
  shapes: number;
  withElementId: number;
  error?: string;
}

async function importInViewer(xml: string, diagramId?: string): Promise<ImportResult> {
  return page.evaluate(
    async ({ xml: source, diagramId: target }) => {
      const w = window as unknown as { BpmnJS: new (o: unknown) => any; viewer?: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
      w.viewer?.destroy();
      document.getElementById('canvas')!.innerHTML = '';
      const viewer = new w.BpmnJS({ container: '#canvas' });
      w.viewer = viewer;
      try {
        let result = await viewer.importXML(source);
        if (target !== undefined) result = await viewer.open(target);
        const all = viewer.get('elementRegistry').getAll();
        return {
          warnings: (result.warnings as { message: string }[]).map((x) => x.message),
          shapes: all.length,
          withElementId: all.filter(
            (e: { di?: { $attrs?: Record<string, string> } }) =>
              e.di?.$attrs?.['processia:elementId'] !== undefined,
          ).length,
        };
      } catch (e) {
        return { warnings: [], shapes: 0, withElementId: 0, error: String(e) };
      }
    },
    { xml, diagramId },
  );
}

const models: [string, () => BusinessModel][] = [
  ['modèle minimal', buildMinimalModel],
  ['modèle complet', buildCompleteModel],
  ['modèle riche', buildRichModel],
];

describe('bpmn-js : import sans avertissement', () => {
  for (const [name, build] of models) {
    it(`${name} : chaque diagramme s'importe et s'affiche sans avertissement`, async () => {
      const model = build();
      for (const d of listDiagrams(model)) {
        const { xml } = await toBpmn(model, d);
        const r = await importInViewer(xml);
        expect(r.error, d).toBeUndefined();
        expect(r.warnings, d).toEqual([]);
        expect(r.shapes, d).toBeGreaterThan(1);
        expect(r.withElementId, d).toBeGreaterThan(0);
      }
    });

    it(`${name} : le fichier combiné s'ouvre diagramme par diagramme sans avertissement`, async () => {
      const model = build();
      const { xml } = await toBpmnCombined(model);
      for (const d of listDiagrams(model)) {
        const key = d === 'L0' ? 'L0' : d.slice(d.indexOf(':') + 1).replace(/-/g, '');
        const r = await importInViewer(xml, `Diagram_${key}`);
        expect(r.error, d).toBeUndefined();
        expect(r.warnings, d).toEqual([]);
        expect(r.shapes, d).toBeGreaterThan(1);
      }
    });
  }

  it('aucune erreur ni avertissement dans la console du navigateur', () => {
    expect(pageErrors).toEqual([]);
  });

  it('contrôle de sensibilité : un XML dont une référence est cassée produit un avertissement', async () => {
    const model = buildCompleteModel();
    const d = listDiagrams(model).find((x) => x.startsWith('L2')) as string;
    const { xml } = await toBpmn(model, d);
    const broken = xml.replace(/targetRef="Event_[0-9a-f]+"/, 'targetRef="Inconnu_1"');
    expect(broken).not.toBe(xml);
    const r = await importInViewer(broken);
    expect(r.error !== undefined || r.warnings.length > 0).toBe(true);
    pageErrors.length = 0;
  });

  it('capture d’écran du niveau 2 du modèle riche (inspection visuelle)', async () => {
    const model = buildRichModel();
    const d = listDiagrams(model).find((x) => x.startsWith('L2')) as string;
    const { xml } = await toBpmn(model, d);
    await importInViewer(xml);
    const out = process.env['BPMN_SCREENSHOT_DIR'];
    if (out) {
      await page.evaluate(() => {
        const w = window as unknown as { viewer: { get(n: string): { zoom(a: string): void } } };
        w.viewer.get('canvas').zoom('fit-viewport');
      });
      await page.screenshot({ path: join(out, 'rich-l2.png') });
    }
  });
});
