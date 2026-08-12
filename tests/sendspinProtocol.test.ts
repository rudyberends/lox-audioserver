import assert from 'node:assert/strict';
import { test } from './testHarness';
import {
  AudioCodec,
  Roles,
  SendspinSession,
  serverNowUs,
} from '@sonn-audio/node-sendspin';

/**
 * Wire-level checks on SendspinSession, against the reference implementation
 * (`data/refcode/sendspin/aiosendspin`). The module has no runner of its own, so
 * the protocol surface is pinned from here.
 */

type SentMessage = { type: string; payload?: Record<string, any> };

/** Minimal `ws`-shaped stub that records what the session put on the wire. */
class FakeSocket {
  public readonly sent: SentMessage[] = [];
  public readonly binary: Buffer[] = [];
  public readonly closes: Array<{ code: number; reason: string }> = [];
  public readyState = 1; // WebSocket.OPEN
  public bufferedAmount = 0;

  send(data: string | Buffer): void {
    if (typeof data === 'string') {
      this.sent.push(JSON.parse(data) as SentMessage);
      return;
    }
    this.binary.push(data);
  }

  close(code = 1000, reason = ''): void {
    this.closes.push({ code, reason });
    this.readyState = 3; // CLOSED
  }

  ping(): void {}
  terminate(): void {}
  on(): void {}

  ofType(type: string): SentMessage[] {
    return this.sent.filter((msg) => msg.type === type);
  }
}

function playerHello(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    client_id: 'test-client',
    name: 'Test Client',
    version: 1,
    supported_roles: [Roles.PLAYER],
    'player@v1_support': {
      supported_formats: [{ codec: 'pcm', channels: 2, sample_rate: 48000, bit_depth: 16 }],
      buffer_capacity: 1_000_000,
      supported_commands: [],
    },
    ...overrides,
  };
}

function connect(hello: Record<string, any>): { socket: FakeSocket; session: SendspinSession } {
  const socket = new FakeSocket();
  const session = new SendspinSession(socket as any, null);
  session.handleText(JSON.stringify({ type: 'client/hello', payload: hello }));
  return { socket, session };
}

test('sendspin: stream triggers carry server_transmitted', () => {
  const { socket, session } = connect(playerHello());
  const before = serverNowUs();

  session.sendStreamStart({ codec: AudioCodec.PCM, sampleRate: 48000, channels: 2, bitDepth: 16 });
  session.sendStreamClear();
  session.sendStreamEnd();

  const after = serverNowUs();
  for (const type of ['stream/start', 'stream/clear', 'stream/end']) {
    const messages = socket.ofType(type);
    assert.equal(messages.length, 1, `expected exactly one ${type}`);
    const stamp = messages[0].payload?.server_transmitted;
    assert.equal(typeof stamp, 'number', `${type} must stamp server_transmitted`);
    // It is the start of the window required_lead_time_ms is measured over, so it
    // has to be the actual send time, not a placeholder.
    assert.ok(
      stamp >= before && stamp <= after,
      `${type} server_transmitted ${stamp} outside [${before}, ${after}]`,
    );
  }
});

test('sendspin: an artwork-only request-format does not re-announce the player stream', () => {
  const { socket, session } = connect(
    playerHello({
      supported_roles: [Roles.PLAYER, Roles.ARTWORK],
      'artwork@v1_support': {
        channels: [{ source: 'album', format: 'jpeg', media_width: 400, media_height: 400 }],
      },
    }),
  );
  session.sendStreamStart({ codec: AudioCodec.PCM, sampleRate: 48000, channels: 2, bitDepth: 16 });
  const playerStreamStarts = () =>
    socket.ofType('stream/start').filter((msg) => msg.payload?.player).length;
  assert.equal(playerStreamStarts(), 1);

  session.handleText(
    JSON.stringify({
      type: 'stream/request-format',
      payload: { artwork: { channel: 0, media_width: 200, media_height: 200 } },
    }),
  );

  // The regression: every request-format re-sent the player stream/start, so an
  // artwork request produced a restart trigger the client never asked for.
  assert.equal(playerStreamStarts(), 1, 'artwork request must not restart the player stream');
  const artworkStarts = socket.ofType('stream/start').filter((msg) => msg.payload?.artwork);
  assert.equal(artworkStarts.length, 1, 'artwork request should be answered for artwork');
  assert.equal(artworkStarts[0].payload?.artwork.channels[0].width, 200);
});

test('sendspin: a player request-format still re-announces the player stream', () => {
  const { socket, session } = connect(
    playerHello({
      'player@v1_support': {
        supported_formats: [
          { codec: 'pcm', channels: 2, sample_rate: 48000, bit_depth: 16 },
          { codec: 'pcm', channels: 2, sample_rate: 44100, bit_depth: 16 },
        ],
        buffer_capacity: 1_000_000,
        supported_commands: [],
      },
    }),
  );
  session.sendStreamStart({ codec: AudioCodec.PCM, sampleRate: 48000, channels: 2, bitDepth: 16 });

  session.handleText(
    JSON.stringify({
      type: 'stream/request-format',
      payload: { player: { sample_rate: 44100 } },
    }),
  );

  const starts = socket.ofType('stream/start').filter((msg) => msg.payload?.player);
  assert.equal(starts.length, 2);
  assert.equal(starts[1].payload?.player.sample_rate, 44100);
});

test('sendspin: a format request outside the declared list is refused', () => {
  const flagged: string[] = [];
  const socket = new FakeSocket();
  const session = new SendspinSession(socket as any, null, undefined, {}, {
    onNoncompliance: (_s, reason) => flagged.push(reason),
  });
  session.handleText(
    JSON.stringify({
      type: 'client/hello',
      payload: playerHello({
        'player@v1_support': {
          supported_formats: [
            { codec: 'pcm', channels: 2, sample_rate: 48000, bit_depth: 16 },
            { codec: 'pcm', channels: 2, sample_rate: 44100, bit_depth: 16 },
          ],
          buffer_capacity: 1_000_000,
          supported_commands: [],
        },
      }),
    }),
  );
  session.sendStreamStart({ codec: AudioCodec.PCM, sampleRate: 48000, channels: 2, bitDepth: 16 });

  // 192 kHz was never declared. Honouring it would have the client fail to decode
  // every packet, so the format in force is kept and re-announced.
  session.handleText(
    JSON.stringify({ type: 'stream/request-format', payload: { player: { sample_rate: 192000 } } }),
  );

  assert.equal(session.getStreamFormat().sampleRate, 48000, 'undeclared rate must not be adopted');
  const starts = socket.ofType('stream/start').filter((msg) => msg.payload?.player);
  assert.equal(starts.length, 2, 'the client should still be told what it is getting');
  assert.equal(starts[1].payload?.player.sample_rate, 48000);
  assert.equal(flagged.length, 1);
  assert.match(flagged[0], /supported_formats/);

  // A declared format still goes through.
  session.handleText(
    JSON.stringify({ type: 'stream/request-format', payload: { player: { sample_rate: 44100 } } }),
  );
  assert.equal(session.getStreamFormat().sampleRate, 44100);
});

test('sendspin: a controller command from a client without the role is refused', () => {
  const commands: unknown[] = [];
  const flagged: string[] = [];
  const socket = new FakeSocket();
  const session = new SendspinSession(socket as any, null, undefined, {}, {
    onGroupCommand: (_s, cmd) => commands.push(cmd),
    onNoncompliance: (_s, reason) => flagged.push(reason),
  });
  // Player only — no controller role negotiated.
  session.handleText(JSON.stringify({ type: 'client/hello', payload: playerHello() }));

  session.handleText(
    JSON.stringify({ type: 'client/command', payload: { controller: { command: 'pause' } } }),
  );
  session.handleText(
    JSON.stringify({ type: 'client/command', payload: { controller: { command: 'volume', volume: 5 } } }),
  );

  assert.deepEqual(commands, [], 'a player-only client must not drive the group');
  assert.equal(flagged.length, 1, 'the deviation is reported once per reason');
  assert.match(flagged[0], /without the controller role/);
});

test('sendspin: visualizer support is read from the key matching the negotiated role', () => {
  // A client that speaks both wires. Activation must land on v1, and the support
  // object must be read from `visualizer@v1_support` — reading the draft object
  // instead yielded `types: []`, so nothing was ever negotiated.
  const { session } = connect(
    playerHello({
      supported_roles: [Roles.VISUALIZER_DRAFT_R1, Roles.VISUALIZER, Roles.PLAYER],
      'visualizer@_draft_r1_support': { buffer_capacity: 4096, batch_max: 8 },
      'visualizer@v1_support': {
        buffer_capacity: 8192,
        rate_max: 30,
        types: ['loudness', 'spectrum'],
        spectrum: { n_disp_bins: 24, scale: 'log', f_min: 40, f_max: 16000 },
      },
    }),
  );

  assert.ok(session.getRoles().includes(Roles.VISUALIZER), 'v1 should win over the draft wire');
  assert.ok(
    !session.getRoles().includes(Roles.VISUALIZER_DRAFT_R1),
    'the draft wire must not also be active',
  );
  const support = session.getVisualizerSupport();
  assert.deepEqual(support?.types, ['loudness', 'spectrum']);
  assert.equal(support?.rate_max, 30);
  assert.equal(support?.buffer_capacity, 8192);
});

test('sendspin: client/state availability resolves across both spellings', () => {
  const seen: Array<boolean | undefined> = [];
  const socket = new FakeSocket();
  const session = new SendspinSession(socket as any, null, undefined, {}, {
    onPlayerState: (_s, update) => seen.push(update.available),
  });
  session.handleText(JSON.stringify({ type: 'client/hello', payload: playerHello() }));

  // Boolean wins when both arrive.
  session.handleText(
    JSON.stringify({ type: 'client/state', payload: { available: false, state: 'synchronized' } }),
  );
  // A client on the legacy enum alone still has to be understood.
  session.handleText(JSON.stringify({ type: 'client/state', payload: { state: 'external_source' } }));
  session.handleText(JSON.stringify({ type: 'client/state', payload: { state: 'synchronized' } }));

  assert.deepEqual(seen, [false, false, true]);
  assert.equal(session.isAvailable(), true);
});

test('sendspin: a source announces its format with client_stream/start', () => {
  const formats: Array<Record<string, unknown>> = [];
  let ended = 0;
  const socket = new FakeSocket();
  const session = new SendspinSession(socket as any, null, undefined, {}, {
    onSourceStreamStart: (_s, format) => formats.push({ ...format }),
    onSourceStreamEnd: () => { ended += 1; },
  });
  // A spec-conformant source sends `features` only — no supported_formats — and
  // must not be rejected for it.
  session.handleText(
    JSON.stringify({
      type: 'client/hello',
      payload: {
        client_id: 'source-client',
        name: 'Line In',
        version: 1,
        supported_roles: [Roles.SOURCE],
        'source@v1_support': { features: { line_sense: true } },
      },
    }),
  );
  assert.deepEqual(socket.closes, [], 'a formats-less source hello must be accepted');

  session.handleText(
    JSON.stringify({
      type: 'client_stream/start',
      payload: {
        source: { codec: 'pcm', channels: 2, sample_rate: 44100, bit_depth: 24 },
      },
    }),
  );
  assert.deepEqual(formats, [
    { codec: AudioCodec.PCM, sampleRate: 44100, channels: 2, bitDepth: 24 },
  ]);
  assert.deepEqual(session.getSourceStreamFormat(), {
    codec: AudioCodec.PCM,
    sampleRate: 44100,
    channels: 2,
    bitDepth: 24,
  });

  session.handleText(JSON.stringify({ type: 'client_stream/end' }));
  assert.equal(ended, 1);
  assert.equal(session.getSourceStreamFormat(), null);
});

test('sendspin: stream/clear and stream/end drop roles they do not apply to', () => {
  const { socket, session } = connect(
    playerHello({
      supported_roles: [Roles.PLAYER, Roles.ARTWORK, Roles.METADATA],
      'artwork@v1_support': {
        channels: [{ source: 'album', format: 'jpeg', media_width: 400, media_height: 400 }],
      },
    }),
  );

  session.sendStreamClear([Roles.PLAYER, Roles.ARTWORK, Roles.METADATA]);
  session.sendStreamEnd([Roles.PLAYER, Roles.ARTWORK, Roles.METADATA]);

  // clear reaches roles that hold a buffer; end reaches roles that receive a stream.
  assert.deepEqual(socket.ofType('stream/clear')[0].payload?.roles, [Roles.PLAYER]);
  assert.deepEqual(socket.ofType('stream/end')[0].payload?.roles, [Roles.PLAYER, Roles.ARTWORK]);
});

test('sendspin: controller seek commands carry their position through', () => {
  const commands: Array<Record<string, unknown>> = [];
  const socket = new FakeSocket();
  const session = new SendspinSession(socket as any, null, undefined, {}, {
    onGroupCommand: (_s, cmd) => commands.push({ ...cmd }),
  });
  session.handleText(
    JSON.stringify({
      type: 'client/hello',
      payload: playerHello({ supported_roles: [Roles.PLAYER, Roles.CONTROLLER] }),
    }),
  );

  session.handleText(
    JSON.stringify({
      type: 'client/command',
      payload: { controller: { command: 'seek', position_ms: 90_000 } },
    }),
  );
  session.handleText(
    JSON.stringify({
      type: 'client/command',
      payload: { controller: { command: 'seek_relative', offset_ms: -15_000 } },
    }),
  );

  assert.equal(commands.length, 2);
  assert.equal(commands[0].command, 'seek');
  assert.equal(commands[0].positionMs, 90_000);
  assert.equal(commands[1].command, 'seek_relative');
  assert.equal(commands[1].offsetMs, -15_000);
});
