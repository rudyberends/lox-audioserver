module.exports = {
  forbidden: [
    {
      name: 'domain-no-adapters-runtime-infrastructure',
      severity: 'error',
      from: { path: '^src/domain' },
      to: { path: '^src/(adapters|runtime|infrastructure)' },
    },
    {
      name: 'ports-no-shared',
      severity: 'error',
      from: { path: '^src/ports' },
      to: { path: '^src/shared' },
    },
    {
      name: 'application-no-adapters-runtime',
      severity: 'error',
      from: { path: '^src/application' },
      to: { path: '^src/(adapters|runtime)' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    includeOnly: '^src',
    tsConfig: {
      fileName: 'tsconfig.json',
    },
  },
};
