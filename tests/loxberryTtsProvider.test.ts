import assert from 'node:assert/strict';
import { test } from './testHarness';
import { parseLoxBerryTtsResponse, resolveLoxBerryDownloadUrl } from '../src/application/alerts/loxberryTtsProvider';

test('LoxBerry TTS response parser accepts wrapped subscriber payloads', () => {
  const parsed = parseLoxBerryTtsResponse(
    JSON.stringify({
      response: {
        status: 'done',
        file: 'voice.mp3',
        interfaces: {
          httpinterface: 'http:///plugins/text2speech/interfacedownload',
        },
        original: {
          corr: 'abc',
        },
      },
    }),
  );

  assert.equal(parsed?.file, 'voice.mp3');
  assert.equal(parsed?.original?.corr, 'abc');
});

test('LoxBerry TTS download URL fills hostless plugin URLs from provider config', () => {
  const url = resolveLoxBerryDownloadUrl(
    {
      status: 'done',
      file: 'voice file.mp3',
      httpinterface: 'http:///plugins/text2speech/interfacedownload',
    },
    {
      host: 'loxberry.local',
      httpBaseUrl: 'http://loxberry.local',
    },
  );

  assert.equal(url, 'http://loxberry.local/plugins/text2speech/interfacedownload/voice%20file.mp3');
});

test('LoxBerry TTS download URL rejects error responses', () => {
  const url = resolveLoxBerryDownloadUrl(
    {
      status: 'error',
      message: 'Invalid keys in JSON',
      file: 'voice.mp3',
      httpinterface: 'http:///plugins/text2speech/interfacedownload',
    },
    { host: 'loxberry.local' },
  );

  assert.equal(url, null);
});
