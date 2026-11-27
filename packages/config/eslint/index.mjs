import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier';
import i18next from 'eslint-plugin-i18next';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { boundaryConfigs } from './boundaries.mjs';

export { allowedDependencies, workspacePackages } from './boundaries.mjs';

/** Configuration ESLint (flat config) de tout le monorepo. */
export function createConfig() {
  return tseslint.config(
    {
      name: 'processia/ignores',
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/.next/**',
        '**/.turbo/**',
        '**/coverage/**',
        '**/playwright-report/**',
        '**/test-results/**',
        '**/next-env.d.ts',
        '.claude/**',
      ],
    },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
      name: 'processia/base',
      languageOptions: { globals: { ...globals.node } },
      rules: {
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
        ],
        eqeqeq: ['error', 'always'],
        'no-console': ['error', { allow: ['warn', 'error', 'info'] }],
      },
    },
    {
      // NestJS : l'injection de dépendances s'appuie sur les métadonnées des types de constructeur,
      // qui doivent donc rester des imports de valeur.
      name: 'processia/nest',
      files: ['apps/api/**/*.ts'],
      rules: { '@typescript-eslint/consistent-type-imports': 'off' },
    },
    {
      // Scripts et configuration : la console est l'interface.
      name: 'processia/scripts',
      files: ['**/*.config.{js,mjs,cjs,ts}', 'apps/*/src/main.ts', 'apps/*/src/worker.ts'],
      rules: { 'no-console': 'off' },
    },
    {
      name: 'processia/react',
      files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
      languageOptions: { globals: { ...globals.browser } },
      ...jsxA11y.flatConfigs.recommended,
    },
    {
      name: 'processia/next',
      files: ['apps/web/**/*.{ts,tsx}'],
      plugins: { '@next/next': nextPlugin },
      rules: {
        ...nextPlugin.configs.recommended.rules,
        ...nextPlugin.configs['core-web-vitals'].rules,
        // App Router uniquement : il n'existe pas de dossier `pages`.
        '@next/next/no-html-link-for-pages': 'off',
      },
    },
    {
      // Aucun texte d'interface en dur (spécification 7, règles communes).
      name: 'processia/i18n',
      files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
      ignores: ['**/*.test.{ts,tsx}', '**/*.config.{ts,mjs,js}'],
      ...i18next.configs['flat/recommended'],
      rules: {
        'i18next/no-literal-string': [
          'error',
          {
            mode: 'jsx-only',
            // Attributs techniques (jamais lus par l'utilisateur). Les attributs de texte
            // (aria-label, placeholder, alt, title, label, description) restent contrôlés.
            'jsx-attributes': {
              exclude: [
                'className',
                'id',
                'tone',
                'role',
                'variant',
                'slot',
                'placement',
                'orientation',
                'href',
                'name',
                'type',
                'autoComplete',
                'inputMode',
                'data-testid',
                'aria-current',
                'aria-live',
                'aria-hidden',
                'aria-controls',
                'aria-expanded',
                'htmlFor',
                'rel',
                'target',
                'scope',
                'size',
                'dir',
                'lang',
              ],
            },
          },
        ],
      },
    },
    ...boundaryConfigs(),
    prettier,
  );
}
