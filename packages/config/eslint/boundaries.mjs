/**
 * Frontières entre unités du monorepo (spécification 1.2).
 *
 * Chaque clé est un dossier de l'espace de travail ; la valeur liste les paquets
 * `@processia/*` qu'il a le droit d'importer. Tout le reste est interdit par ESLint
 * (`no-restricted-imports`). Les dépendances sont strictement descendantes.
 *
 * `test-fixtures` ne dépend que de `model` : il peut donc être importé (en pratique par les
 * tests) par tous les paquets situés au-dessus de `model`.
 */
export const allowedDependencies = {
  'packages/config': [],
  'packages/model': [],
  'packages/i18n': [],
  'packages/policy': ['model', 'test-fixtures'],
  'packages/contracts': ['model', 'test-fixtures'],
  'packages/db': ['config', 'model', 'test-fixtures'],
  'packages/ai': ['model', 'test-fixtures'],
  'packages/ingest': ['model', 'test-fixtures'],
  'packages/bpmn': ['model', 'test-fixtures'],
  'packages/diagnostic': ['model', 'test-fixtures'],
  'packages/exports': ['model', 'bpmn', 'diagnostic', 'i18n', 'test-fixtures'],
  'packages/ui': ['i18n'],
  'packages/test-fixtures': ['model'],
  'apps/web': ['config', 'contracts', 'model', 'ui', 'i18n'],
  'apps/api': [
    'ai',
    'bpmn',
    'config',
    'contracts',
    'db',
    'diagnostic',
    'exports',
    'i18n',
    'ingest',
    'model',
    'policy',
    'test-fixtures',
  ],
  'apps/collab': ['config', 'contracts', 'db', 'model', 'policy', 'test-fixtures'],
  e2e: ['test-fixtures'],
};

export const workspacePackages = [
  'ai',
  'bpmn',
  'config',
  'contracts',
  'db',
  'diagnostic',
  'exports',
  'i18n',
  'ingest',
  'model',
  'policy',
  'test-fixtures',
  'ui',
];

/** Génère les blocs de configuration ESLint (flat config) qui imposent la matrice. */
export function boundaryConfigs() {
  return Object.entries(allowedDependencies).map(([dir, allowed]) => {
    const own = dir.startsWith('packages/') ? dir.slice('packages/'.length) : null;
    const forbidden = workspacePackages.filter((name) => name !== own && !allowed.includes(name));
    return {
      name: `processia/boundaries/${dir}`,
      files: [`${dir}/**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`],
      rules: {
        'no-restricted-imports': [
          'error',
          {
            patterns: [
              {
                group: forbidden.flatMap((name) => [`@processia/${name}`, `@processia/${name}/*`]),
                message: `Frontière de paquets : ${dir} ne peut pas importer cet @processia/* (voir packages/config/eslint/boundaries.mjs).`,
              },
              {
                group: ['../../*/src/**', '../../../*/*/src/**', '**/dist/**'],
                message:
                  'Import relatif vers un autre paquet interdit : passer par son nom @processia/*.',
              },
            ],
          },
        ],
      },
    };
  });
}
