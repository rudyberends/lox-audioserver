import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  buildSpeechRequest,
  clampSpeechInput,
  resolveSpeechEndpoint,
  OpenAiTtsProvider,
} from '../src/application/alerts/openAiTtsProvider';
import { LoxBerryTtsProvider } from '../src/application/alerts/loxberryTtsProvider';
import { createTtsProvider, isExternalTtsProvider } from '../src/application/alerts/ttsProviderFactory';
import { ttsClipFilename } from '../src/application/alerts/ttsClipStore';
import { normalizeContent } from '../src/application/config/configRepository';
import type { AudioServerConfig, OpenAiTtsProviderConfig } from '../src/domain/config/types';

// Support for the OpenAI `/v1/audio/speech` schema (#342). The endpoint is the
// one thing operators type by hand and every backend documents it differently,
// so the three forms that appear in the wild all have to land on the same URL.

function openAiConfig(overrides: Partial<OpenAiTtsProviderConfig> = {}): OpenAiTtsProviderConfig {
  return { type: 'openai-tts', ...overrides };
}

test('speech endpoint: a bare origin gains the API version, a versioned base does not', () => {
  assert.equal(resolveSpeechEndpoint('http://localhost:8880'), 'http://localhost:8880/v1/audio/speech');
  assert.equal(resolveSpeechEndpoint('http://localhost:8880/v1'), 'http://localhost:8880/v1/audio/speech');
  assert.equal(resolveSpeechEndpoint('http://localhost:8880/v1/'), 'http://localhost:8880/v1/audio/speech');
  assert.equal(
    resolveSpeechEndpoint('http://localhost:8880/v1/audio/speech'),
    'http://localhost:8880/v1/audio/speech',
    'a complete speech URL is left alone',
  );
  assert.equal(resolveSpeechEndpoint(undefined), 'https://api.openai.com/v1/audio/speech');
});

test('speech request: local servers get no Authorization header, cloud ones do', () => {
  const anonymous = buildSpeechRequest(openAiConfig({ baseUrl: 'http://localhost:8880/v1' }), 'hello');
  assert.equal(anonymous.headers.Authorization, undefined, 'no key configured means no header');

  const authenticated = buildSpeechRequest(openAiConfig({ apiKey: '  sk-test  ' }), 'hello');
  assert.equal(authenticated.headers.Authorization, 'Bearer sk-test');
});

test('speech request: body carries the documented fields, with defaults for what is unset', () => {
  const request = buildSpeechRequest(openAiConfig(), 'Dinner is ready');

  assert.deepEqual(request.body, {
    model: 'tts-1',
    input: 'Dinner is ready',
    voice: 'alloy',
    response_format: 'mp3',
  });
});

test('speech request: speed and instructions are sent only when configured', () => {
  const plain = buildSpeechRequest(openAiConfig(), 'hello');
  assert.equal('speed' in plain.body, false);
  assert.equal('instructions' in plain.body, false);

  const styled = buildSpeechRequest(openAiConfig({ speed: 1.25, instructions: 'Speak calmly' }), 'hello');
  assert.equal(styled.body.speed, 1.25);
  assert.equal(styled.body.instructions, 'Speak calmly');
});

test('speech request: the requested language reaches the backend through the voice map', () => {
  const config = openAiConfig({ voice: 'alloy', voiceByLanguage: { nl: 'nl_female', de: 'de_male' } });

  assert.equal(buildSpeechRequest(config, 'hallo', 'nl').body.voice, 'nl_female');
  assert.equal(buildSpeechRequest(config, 'hallo', 'nl-BE').body.voice, 'nl_female', 'a region falls back to its language');
  assert.equal(buildSpeechRequest(config, 'bonjour', 'fr').body.voice, 'alloy', 'an unmapped language keeps the default voice');
  assert.equal(buildSpeechRequest(config, 'hello').body.voice, 'alloy');
});

test('speech request: text over the 4096-character ceiling is cut on a word boundary', () => {
  const word = 'omroepbericht ';
  const long = word.repeat(400).trim(); // ~5600 characters
  assert.ok(long.length > 4096, 'the fixture must actually exceed the limit');

  const spoken = clampSpeechInput(long);

  assert.ok(spoken.length <= 4096, 'stays within what the schema accepts');
  assert.ok(long.startsWith(spoken), 'keeps the beginning of the announcement');
  assert.equal(spoken.endsWith('omroepbericht'), true, 'ends on a whole word');
  assert.equal(spoken.trimEnd(), spoken, 'no trailing space is sent');
});

test('speech request: text within the ceiling is passed through untouched', () => {
  const text = 'Het eten staat klaar';
  assert.equal(clampSpeechInput(text), text);
  assert.equal(clampSpeechInput('x'.repeat(4096)).length, 4096, 'exactly at the limit is not cut');
});

test('clip cache: a changed voice yields a different file, identical settings do not', () => {
  const spoken = ['http://host/v1/audio/speech', 'tts-1', 'alloy', 'mp3', '', '', 'en', 'Dinner is ready'];
  const sameAgain = [...spoken];
  const otherVoice = [...spoken.slice(0, 2), 'echo', ...spoken.slice(3)];

  assert.equal(ttsClipFilename('tts-openai', 'mp3', spoken), ttsClipFilename('tts-openai', 'mp3', sameAgain));
  assert.notEqual(ttsClipFilename('tts-openai', 'mp3', spoken), ttsClipFilename('tts-openai', 'mp3', otherVoice));
});

test('provider factory: builds the configured provider and honours the off switch', () => {
  assert.ok(createTtsProvider({ type: 'openai-tts' }) instanceof OpenAiTtsProvider);
  assert.ok(createTtsProvider({ type: 'loxberry-tts', host: 'loxberry.local' }) instanceof LoxBerryTtsProvider);
  assert.equal(createTtsProvider({ type: 'openai-tts', enabled: false }), null);
  assert.equal(createTtsProvider({ type: 'internal' }), null, 'the internal provider is not an external one');
  assert.equal(createTtsProvider(undefined), null);

  assert.equal(isExternalTtsProvider({ type: 'openai-tts' }), true);
  assert.equal(isExternalTtsProvider({ type: 'internal' }), false);
  assert.equal(isExternalTtsProvider(undefined), false);
});

function configWithTts(provider: unknown): AudioServerConfig {
  return {
    content: {
      radio: { tuneInUsername: '' },
      spotify: { accounts: [] },
      tts: { provider, fallbackToInternal: true },
    },
  } as unknown as AudioServerConfig;
}

test('config: an openai-tts provider survives normalization instead of collapsing to internal', () => {
  const cfg = configWithTts({
    type: 'openai-tts',
    baseUrl: '  http://localhost:8880/v1  ',
    apiKey: '',
    voice: 'nova',
    format: 'flac',
  });

  normalizeContent(cfg);

  assert.deepEqual(cfg.content.tts?.provider, {
    type: 'openai-tts',
    enabled: true,
    baseUrl: 'http://localhost:8880/v1',
    apiKey: undefined,
    model: undefined,
    voice: 'nova',
    instructions: undefined,
    voiceByLanguage: undefined,
    format: 'flac',
    speed: undefined,
    timeoutMs: undefined,
  });
});

test('config: unusable openai settings are dropped rather than passed to the backend', () => {
  const cfg = configWithTts({
    type: 'openai-tts',
    speed: 99,
    format: 'pcm',
    voiceByLanguage: { ' NL ': ' nl_female ', de: '', '': 'x' },
  });

  normalizeContent(cfg);
  const provider = cfg.content.tts?.provider as OpenAiTtsProviderConfig;

  assert.equal(provider.speed, 4, 'speed is clamped to what the schema allows');
  assert.equal(provider.format, undefined, 'a headerless format is refused, so the default mp3 applies');
  assert.deepEqual(provider.voiceByLanguage, { nl: 'nl_female' }, 'blank entries are dropped and codes normalized');
});

test('config: an unknown provider name still falls back to the internal one', () => {
  const cfg = configWithTts({ type: 'some-future-service' });
  normalizeContent(cfg);
  assert.deepEqual(cfg.content.tts?.provider, { type: 'internal' });
});
