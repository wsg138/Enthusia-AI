// Flat ESLint config for the Enthusia AI monorepo.
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      // No console.* in library code except explicit placeholders.
      'no-console': 'warn',
    },
  },
  {
    // Bloom generic Node egg executes these .js scripts as CommonJS.
    // Do not weaken import rules for the ESM application workspaces.
    files: ['deploy/bloom/*.js'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
);
