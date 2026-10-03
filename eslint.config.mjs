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
);
