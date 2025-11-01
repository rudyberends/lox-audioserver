// prettier.config.cjs
/**
 * Prettier configuration aligned with ESLint and TypeScript settings.
 * Ensures consistent formatting across all editors and CI pipelines.
 */
module.exports = {
  // --- Formatting style ---
  singleQuote: true,          // match ESLint 'quotes' rule
  semi: true,                 // controlled by @stylistic/semi
  tabWidth: 2,                // match ESLint indent rule
  useTabs: false,
  trailingComma: 'all',       // consistent with ESLint comma-dangle
  printWidth: 140,            // match ESLint max-len
  bracketSpacing: true,
  arrowParens: 'always',
  endOfLine: 'lf',
  proseWrap: 'preserve',      // don't wrap markdown text automatically

  // --- File handling ---
  overrides: [
    {
      files: '*.md',
      options: { tabWidth: 2, proseWrap: 'always' },
    },
    {
      files: ['*.json', '*.yml', '*.yaml'],
      options: { singleQuote: false },
    },
  ],
};