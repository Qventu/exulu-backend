// CJS on purpose: jest can parse this without ts-node (which is not a
// dependency of this project, so a jest.config.ts never loaded).
/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src"],
  // *.test/spec only — a bare **/__tests__/**/*.ts pattern would pick up
  // src/__tests__/setup.ts as an (empty) test suite.
  testMatch: ["**/*.test.ts", "**/*.spec.ts"],
  collectCoverageFrom: [
    "src/**/*.ts",
    "!src/**/*.d.ts",
    "!src/**/*.test.ts",
    "!src/**/*.spec.ts",
    "!src/index.ts",
  ],
  coverageDirectory: "coverage",
  coverageReporters: ["text", "lcov", "html"],
  // Mirror the tsconfig path aliases used throughout src/ and ee/.
  moduleNameMapper: {
    "@EXULU_TYPES/(.*)": "<rootDir>/types/$1",
    "@SRC/(.*)": "<rootDir>/src/$1",
    "@EE/(.*)": "<rootDir>/ee/$1",
    // bash-tool's exports map only has an "import" condition, which jest's
    // CJS resolver can't use; point straight at the dist entry instead.
    "^bash-tool$": "<rootDir>/node_modules/bash-tool/dist/index.js",
  },
  // jose and bash-tool are ESM-only; let ts-jest transpile them (allowJs)
  // instead of letting jest's CJS runtime choke on their export statements.
  transform: {
    "^.+\\.[tj]s$": ["ts-jest", { tsconfig: { allowJs: true } }],
  },
  transformIgnorePatterns: ["/node_modules/(?!(jose|bash-tool)/)"],
  setupFilesAfterEnv: ["<rootDir>/src/__tests__/setup.ts"],
  verbose: true,
  testTimeout: 10000,
};
