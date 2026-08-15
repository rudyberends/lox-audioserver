import assert from 'node:assert/strict';
import { test } from './testHarness';
import { readBuildChannel } from '../src/shared/serverVersion';

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved = { BUILD_CHANNEL: process.env.BUILD_CHANNEL, BUILD_TIMESTAMP: process.env.BUILD_TIMESTAMP };
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test('build channel is whatever the build declared', () => {
  for (const declared of ['dev', 'testing', 'beta', 'stable']) {
    withEnv({ BUILD_CHANNEL: declared, BUILD_TIMESTAMP: undefined }, () => {
      assert.equal(readBuildChannel(), declared);
    });
  }
});

test('an undeclared build is a dev build, never a release', () => {
  // The whole point: a release has to say so. Silence must not read as "stable",
  // or the one build people should not be running is the one with no warning.
  withEnv({ BUILD_CHANNEL: undefined, BUILD_TIMESTAMP: undefined }, () => {
    assert.equal(readBuildChannel(), 'dev');
  });
  withEnv({ BUILD_CHANNEL: '', BUILD_TIMESTAMP: undefined }, () => {
    assert.equal(readBuildChannel(), 'dev');
  });
  // A value we do not recognise is not a promise of anything either.
  withEnv({ BUILD_CHANNEL: 'production', BUILD_TIMESTAMP: undefined }, () => {
    assert.equal(readBuildChannel(), 'dev');
  });
});

test('images built before BUILD_CHANNEL fall back to their build stamp', () => {
  withEnv({ BUILD_CHANNEL: undefined, BUILD_TIMESTAMP: 'testing-20260815120000' }, () => {
    assert.equal(readBuildChannel(), 'testing');
  });
  withEnv({ BUILD_CHANNEL: undefined, BUILD_TIMESTAMP: 'dev-20260815120000' }, () => {
    assert.equal(readBuildChannel(), 'dev');
  });
});

test('a declared channel outranks the build stamp', () => {
  withEnv({ BUILD_CHANNEL: 'stable', BUILD_TIMESTAMP: 'dev-20260815120000' }, () => {
    assert.equal(readBuildChannel(), 'stable');
  });
});
