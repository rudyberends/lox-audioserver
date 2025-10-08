import assert from 'node:assert/strict';

export function runZoneDynamicCommandTests() {
  const os = require('node:os') as typeof import('node:os');
  const original = os.networkInterfaces;
  os.networkInterfaces = () => ({}) as any;

  const { audioDynamicCommand } = require('../src/http/handlers/zoneCommands') as typeof import('../src/http/handlers/zoneCommands');

  const result = audioDynamicCommand('audio/7/play');
  assert.equal(result.command, 'audio/7/play');
  assert.equal(result.name, 'play');
  assert.deepEqual(result.payload, []);

  os.networkInterfaces = original;
}
