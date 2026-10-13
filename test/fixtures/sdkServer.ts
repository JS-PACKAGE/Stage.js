/** Child-process fixture: real loopback signaling, in-memory media, no mixer ticks/audio. */
import { silentLogger } from '../../src/log.ts';
import { RoomMixer } from '../../src/mixer/RoomMixer.ts';
import { MockMediaTransport } from '../../src/transport/MockMediaTransport.ts';
import { StageHub } from '../../src/ws/hub.ts';
import { createStageServer } from '../../src/ws/server.ts';
import { testConfig } from '../helpers.ts';
import type { ClientMessageType } from '../../shared/protocol.ts';

const micControls = process.argv.includes('--mic-controls');
const config = testConfig(c => {
  c.server.host = '127.0.0.1'; c.server.port = 0; c.server.static = [];
  if (micControls) { c.rooms.presenceBroadcastMs = 0; c.rooms.qualityIntervalMs = 0; }
});
let hub: StageHub;
const transport = new MockMediaTransport({ onLocalCandidate: (room, peer, candidate) => hub.onLocalCandidate(room, peer, candidate) });
const mixers = new Map<string, RoomMixer>();
const gains: { participantId: string; gainDb: number; negativeZero: boolean }[] = [];
hub = new StageHub({ config, transport, log: silentLogger, serverVersion: 'sdk-test', createMixer: roomId => {
  const mixer = new RoomMixer({ sampleRate: 48000, frameMs: 20, maxBufferedFrames: 10, playoutFrames: 1, limiterThreshold: 0.9, speakingThreshold: 0.02, speakingHoldMs: 40 });
  if (micControls) {
    const setGain = mixer.setGain.bind(mixer);
    mixer.setGain = (participantId, gainDb) => { gains.push({ participantId, gainDb, negativeZero: Object.is(gainDb, -0) }); setGain(participantId, gainDb); };
    mixers.set(roomId, mixer);
  }
  return mixer;
} });
// A deterministic delayed ACK keeps caller capacity occupied while real signaling continues.
let holdNextJoin = process.argv.includes('--hold-first-join-ack');
let releaseJoinAck: (() => void) | undefined;
let holdNextControl: ClientMessageType | undefined;
const heldControls = new Map<string, () => void>();
const handle = hub.handle.bind(hub);
hub.handle = async (session, message) => {
  const join = holdNextJoin && message.type === 'join';
  const control = holdNextControl !== undefined && message.type === holdNextControl;
  if (!join && !control) return handle(session, message);
  if (join) holdNextJoin = false;
  if (control) holdNextControl = undefined;
  const previousSend = session.send;
  const send = previousSend.bind(session);
  session.send = (reply, encoded) => {
    if (reply.type === 'ok' && message.type !== 'ping' && reply.requestId === message.requestId) {
      if (join) releaseJoinAck = () => send(reply, encoded);
      else heldControls.set(reply.requestId, () => send(reply, encoded));
    } else send(reply, encoded);
  };
  try { await handle(session, message); }
  finally { session.send = previousSend; }
};
const server = createStageServer({ config, hub, log: silentLogger, baseDir: process.cwd() });
const ids = new WeakMap<object, number>();
let nextId = 0;
function identity(value: object): number {
  if (!ids.has(value)) ids.set(value, ++nextId);
  return ids.get(value)!;
}
process.on('message', (message: { id: number; type: string; controlType?: ClientMessageType; requestId?: string }) => {
  void (async () => {
    if (micControls && message.type === 'hold-next-control-ack') {
      if (holdNextControl || !message.controlType?.startsWith('mic:')) throw new Error('invalid control ACK hold');
      holdNextControl = message.controlType;
    }
    if (micControls && message.type === 'release-control-ack') {
      const release = heldControls.get(message.requestId!);
      if (!release) throw new Error('no matching held control ACK');
      heldControls.delete(message.requestId!); release();
    }
    if (message.type === 'release-join-ack') {
      if (!releaseJoinAck) throw new Error('no held join ACK');
      const release = releaseJoinAck; releaseJoinAck = undefined; release();
    }
    if (message.type === 'shutdown') { releaseJoinAck = undefined; heldControls.clear(); await server.close(); await transport.close(); }
    const peers = [...transport.rooms].flatMap(([roomId, room]) => [...room.peers].map(([participantId, peer]) => ({ roomId, participantId, identity: identity(peer) })));
    // Read-only test instrumentation; no PCM, ticks, or application commands enter through IPC.
    const media = micControls ? [...mixers].map(([roomId, mixer]) => ({ roomId, identity: identity(mixer), sources: [...mixer['sources']].map(([participantId, source]) => ({
      participantId, identity: identity(source), muted: source.muted, gain: source.gain, targetGain: source.targetGain, buffered: source.frames.length,
    })) })) : undefined;
    process.send?.({ id: message.id, peers, heldJoinAck: !!releaseJoinAck,
      ...(micControls ? { media, gains, roomCount: hub.roomCount, heldControls: [...heldControls.keys()] } : {}),
    });
  })().catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
});
process.on('disconnect', () => { releaseJoinAck = undefined; heldControls.clear(); void server.close().finally(() => transport.close()); });
const address = await server.listen();
process.send?.({ url: `ws://127.0.0.1:${address.port}${config.server.wsPath}` });
