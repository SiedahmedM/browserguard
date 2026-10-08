import js from '@eslint/js';
import ts from 'typescript-eslint';
export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly', AbortController: 'readonly', AbortSignal: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly', queueMicrotask: 'readonly', fetch: 'readonly', structuredClone: 'readonly' } } },
  { files: ['src/**/*.ts'], rules: { '@typescript-eslint/consistent-type-imports': 'error', '@typescript-eslint/no-explicit-any': 'error' } },
];
