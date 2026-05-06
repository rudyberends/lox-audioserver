import assert from 'node:assert/strict';
import { test } from './testHarness';
import { AlertsManager } from '../src/application/alerts/alertsManager';

test('wecker alert uses alarm-clock volume slot', async () => {
  const starts: Array<{ zoneId: number; type: string; volume: number }> = [];
  const manager = new AlertsManager();
  manager.initOnce({
    zoneManager: {
      getZoneVolumes: () => ({
        default: 20,
        alarm: 30,
        fire: 40,
        bell: 50,
        buzzer: 67,
        tts: 60,
        volstep: 1,
        fading: 0,
        maxVolume: 100,
      }),
      startAlert: async (zoneId: number, type: string, _media: unknown, volume: number) => {
        starts.push({ zoneId, type, volume });
      },
      stopAlert: async () => {},
    } as any,
  });

  const result = await manager.handleGroupedAlert(12, 'wecker', 'on', [12]);

  assert.equal(result.success, true);
  assert.deepEqual(starts, [{ zoneId: 12, type: 'wecker', volume: 67 }]);
});
