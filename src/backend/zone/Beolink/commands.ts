export interface BeolinkCommandContext {
  adjustVolume(change: number): Promise<void>;
  doAction(action: string): Promise<void>;
}

const actionMap: Record<string, string> = {
  resume: 'Stream/Play',
  play: 'Stream/Play',
  pause: 'Stream/Pause',
  queueminus: 'Stream/Backward',
  queueplus: 'Stream/Forward',
  volume: 'adjustVolume',
  groupJoin: 'Device/OneWayJoin',
  groupLeave: 'Device/OneWayLeave',
  repeat: 'List/Repeat',
  shuffle: 'List/Shuffle',
};

export async function handleBeolinkCommand(
  ctx: BeolinkCommandContext,
  command: string,
  param: any,
): Promise<boolean> {
  const action = actionMap[command];
  if (!action) return false;

  if (action === 'adjustVolume') {
    await ctx.adjustVolume(Number(param ?? 0));
    return true;
  }

  await ctx.doAction(action);
  return true;
}
