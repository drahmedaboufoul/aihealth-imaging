// ESLint (flat config). Scope: the IOS workbench and its tests. The older
// viewer code predates linting in this repo and is not covered yet.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  {
    files: ['src/workbench/**/*.{ts,tsx}', 'tests/workbench/**/*.ts', 'tests/helpers/syntheticMesh.ts', 'tests/e2e/ios-workbench*.ts'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.worker },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-restricted-globals': ['error', { name: 'localStorage', message: 'Workbench state must not persist scans or measurements in browser storage.' }],
      'no-restricted-syntax': ['error',
        { selector: "CallExpression[callee.name='fetch']", message: 'The workbench must not make network requests; files arrive from the page.' },
        { selector: "NewExpression[callee.name=/^(WebSocket|XMLHttpRequest|EventSource)$/]", message: 'No network channels in the workbench.' },
        { selector: "CallExpression[callee.property.name='sendBeacon']", message: 'No network channels in the workbench.' },
      ],
    },
  },
  {
    files: ['src/pages/IOSWorkbenchPage.jsx'],
    extends: [js.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser },
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'no-unused-vars': ['error', { varsIgnorePattern: '^([A-Z]|_)' }], // JSX components count as used
    },
  },
);
