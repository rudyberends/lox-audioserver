import type { EnginePort } from '../../src/ports/EnginePort';
import { PlaybackService } from '../../src/application/playback/PlaybackService';

const noopEnginePort: EnginePort = {
  start: () => {
    /* noop */
  },
  startWithHandoff: () => {
    /* noop */
  },
  stop: () => {
    /* noop */
  },
  createStream: () => null,
  createLocalSession: () => ({
    start: () => {
      /* noop */
    },
    stop: () => {
      /* noop */
    },
    createSubscriber: () => null,
  }),
  waitForFirstChunk: async () => false,
  hasSession: () => false,
  getSessionStats: () => [],
  setSessionTerminationHandler: () => {
    /* noop */
  },
};

export function makePlaybackServiceFake(): PlaybackService {
  return new PlaybackService(noopEnginePort);
}
