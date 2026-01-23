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
      quotes: ['warn', 'single'],
      indent: ['warn', 2, { SwitchCase: 1 }],
      semi: 'off',
      'comma-dangle': ['warn', 'always-multiline'],
      eqeqeq: ['warn', 'always'],
      curly: ['warn', 'all'],
      'brace-style': ['warn'],
      'prefer-arrow-callback': ['warn'],
      'max-len': ['warn', 140],
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
