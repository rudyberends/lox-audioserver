import assert from 'node:assert/strict';

import { computeAuthorizationHeader } from '../src/config/auth';

export function runComputeAuthorizationHeaderTests() {
  const header = computeAuthorizationHeader(' user ', ' pass ');
  const expected = `Basic ${Buffer.from('user:pass').toString('base64')}`;
  assert.equal(header, expected);

  const emptyHeader = computeAuthorizationHeader(undefined, undefined);
  const emptyExpected = `Basic ${Buffer.from(':').toString('base64')}`;
  assert.equal(emptyHeader, emptyExpected);
}
