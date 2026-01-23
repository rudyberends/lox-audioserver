import type { ClockPort } from '@/ports/ClockPort';

export const systemClock: ClockPort = {
  now: () => Date.now(),
};
