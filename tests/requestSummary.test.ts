import assert from 'node:assert/strict';

import { summariseLoxoneCommand } from '../src/http/utils/requestSummary';

export function runRequestSummaryTests() {
  assert.equal(summariseLoxoneCommand(undefined), '');

  assert.equal(
    summariseLoxoneCommand('secure/init/abcdef'),
    'secure/init/[token redacted, 6 chars]',
  );

  assert.equal(
    summariseLoxoneCommand('secure/hello/sessionToken/certificateData'),
    'secure/hello/sessionToken/[certificate trimmed, 15 chars]',
  );

  assert.equal(
    summariseLoxoneCommand('secure/authenticate/user/tokenValue'),
    'secure/authenticate/user/[token redacted, 10 chars]',
  );

  assert.equal(
    summariseLoxoneCommand('audio/cfg/setconfig/{}'),
    'audio/cfg/setconfig/[payload trimmed, 2 chars]',
  );

  assert.equal(
    summariseLoxoneCommand('audio/cfg/volumes/12345'),
    'audio/cfg/volumes/[volume payload trimmed, 5 chars]',
  );

  const longCommand = 'x'.repeat(330);
  assert.equal(
    summariseLoxoneCommand(longCommand),
    `${'x'.repeat(320)}… (truncated 10 chars)`,
  );
}
