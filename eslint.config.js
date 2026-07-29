// @ts-check
import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/*.tsbuildinfo', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      'no-console': ['error', { allow: ['error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-empty': ['error', { allowEmptyCatch: false }],
    },
  },
  {
    // The CLI is a terminal program: writing to stdout is its purpose.
    files: ['apps/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/test/**/*.ts', '**/*.test.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Build scripts are plain Node ESM rather than TypeScript, so `no-undef` has
    // to be told which Node globals exist.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        Buffer: 'readonly',
        URL: 'readonly',
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
)
