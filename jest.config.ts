import type { Config } from 'jest';

const config: Config = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src/server'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  collectCoverageFrom: [
    'src/server/**/*.ts',
    '!src/server/index.ts',
    '!src/server/types.ts',
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      diagnostics: {
        // @wix/contacts ships an empty .d.ts — skip type checking for test deps
        warnOnly: true,
        ignoreDiagnostics: [2306, 7006],
      },
    }],
  },
  // Don't try to resolve Wix SDK in unit tests — it's mocked
  moduleNameMapper: {
    '^@wix/(.*)$': '<rootDir>/src/server/__tests__/__mocks__/@wix/$1',
  },
  // Force exit after tests complete — index.ts calls start() at import time
  // which creates a TCP listener that can't be cleanly closed from tests.
  forceExit: true,
};

export default config;
