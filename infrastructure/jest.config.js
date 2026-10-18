module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  // Resolve .ts BEFORE .js. tsc compiles in-place, so stale .js files sit beside
  // every .ts source; with Jest's default order ("js" first) the suite silently
  // tests the last build's output instead of the current source. Verified: an
  // edit to constants.ts went undetected by all 38 tests until this was set.
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json', 'node'],

  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
  },
  setupFilesAfterEnv: ['aws-cdk-lib/testhelpers/jest-autoclean'],
};
