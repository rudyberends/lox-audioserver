import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  AudioAnalysisService,
  type AudioAnalysisAnalyzer,
  type AudioAnalysisListener,
} from '../src/application/audio/audioAnalysisService';

test('audio analysis is lazy and fans PCM into subscribed consumers', () => {
  const analyzers: Array<{ pushes: Array<{ pcm: Buffer; timestampUs: number }> }> = [];
  const service = new AudioAnalysisService((_options, _listener: AudioAnalysisListener) => {
    const state = { pushes: [] as Array<{ pcm: Buffer; timestampUs: number }> };
    analyzers.push(state);
    const analyzer: AudioAnalysisAnalyzer = {
      push: (pcm, timestampUs) => state.pushes.push({ pcm, timestampUs }),
    };
    return analyzer;
  });

  const pcm = Buffer.from([1, 2, 3]);
  service.push(3, pcm, 100);
  assert.equal(analyzers.length, 0);

  const unsubscribe = service.subscribe(
    3,
    { sampleRate: 44100, channels: 2, bitDepth: 16, rateMax: 20 },
    () => undefined,
  );
  service.push(3, pcm, 200);
  assert.deepEqual(analyzers[0]?.pushes, [{ pcm, timestampUs: 200 }]);

  const outputUnsubscribe = service.subscribe(
    3,
    { sampleRate: 44100, channels: 2, bitDepth: 16, rateMax: 20, feed: 'scheduled-output' },
    () => undefined,
  );
  service.push(3, pcm, 250, 'scheduled-output');
  assert.deepEqual(analyzers[1]?.pushes, [{ pcm, timestampUs: 250 }]);
  assert.deepEqual(analyzers[0]?.pushes, [{ pcm, timestampUs: 200 }]);
  outputUnsubscribe();

  unsubscribe();
  service.push(3, pcm, 300);
  assert.deepEqual(analyzers[0]?.pushes, [{ pcm, timestampUs: 200 }]);
});
