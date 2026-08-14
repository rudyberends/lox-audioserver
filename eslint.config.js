const eslint = require('@eslint/js');
const tseslint = require('typescript-eslint');
const prettier = require('eslint-config-prettier');
const stylistic = require('@stylistic/eslint-plugin');

module.exports = tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    ignores: ['dist'], // replaces .eslintignore

    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
        project: ['./tsconfig.json'],
        tsconfigRootDir: __dirname,
      },
    },

    plugins: {
      '@stylistic': stylistic,
    },

    rules: {
      // ---------------------------------------------------------------------
      // JavaScript Core Rules
      // ---------------------------------------------------------------------
      // Pure formatting (quotes, indent, comma-dangle, brace-style, max-len) is
      // Prettier's job — see prettier.config.cjs. eslint-config-prettier above
      // switches those off deliberately; re-adding them here only re-creates the
      // conflict it exists to prevent.
      semi: 'off',
      // `== null` / `!= null` is the intended nullish check throughout this
      // codebase: one test for both null and undefined.
      eqeqeq: ['warn', 'always', { null: 'ignore' }],
      // Single-line guards (`if (!x) return;`) are the house style; braces are
      // still required the moment the body wraps onto its own line.
      curly: ['warn', 'multi-line'],
      'prefer-arrow-callback': ['warn'],
      'no-console': ['warn'], // prefer logger
      'no-non-null-assertion': 'off',
      'comma-spacing': ['error'],
      'no-multi-spaces': ['warn', { ignoreEOLComments: true }],
      'no-trailing-spaces': ['warn'],
      'lines-between-class-members': [
        'warn',
        'always',
        { exceptAfterSingleLine: true },
      ],

      // ---------------------------------------------------------------------
      // TypeScript Specific Rules
      // ---------------------------------------------------------------------
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      // Honor the `_`-prefix convention for intentionally-unused args/vars/caught errors.
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // ---------------------------------------------------------------------
      // Stylistic Overrides (instead of deprecated TS rules)
      // ---------------------------------------------------------------------
      '@stylistic/semi': ['warn', 'always'],
      '@stylistic/member-delimiter-style': ['warn'],

      // ---------------------------------------------------------------------
      // Naming Conventions (camelCase vs PascalCase)
      // ---------------------------------------------------------------------
      '@typescript-eslint/naming-convention': [
        'warn',

        // allow string literal object keys like 'Content-Type'
        {
          selector: 'objectLiteralProperty',
          format: null,
        },
      ],
    },
  },
);
