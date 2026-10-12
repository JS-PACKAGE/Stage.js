/** Child-process fixture: real loopback signaling, in-memory media, no mixer ticks/audio. */
import { silentLogger } from '../../src/log.ts';
import { RoomMixer } from '../../src/mixer/RoomMixer.ts';
import { MockMediaTransport } from '../../src/transport/MockMediaTransport.ts';
import { StageHub } from '../../src/ws/hub.ts';
import { createStageServer } from '../../src/ws/server.ts';
import { testConfig } from '../helpers.ts';

const config = testConfig(c => { c.server.host = '127.0.0.1'; c.server.port = 0; c.server.static = []; });
let hub: StageHub;
const transport = new MockMediaTransport({ onLocalCandidate: (room, peer, candidate) => hub.onLocalCandidate(room, peer, candidate) });
hub = new StageHub({ config, transport, log: silentLogger, serverVersion: 'sdk-test', createMixer: () => new RoomMixer({ sampleRate: 48000, frameMs: 20, maxBufferedFrames: 10, playoutFrames: 1, limiterThreshold: 0.9, speakingThreshold: 0.02, speakingHoldMs: 40 }) });
// A deterministic delayed ACK keeps caller capacity occupied while real signaling continues.
let holdNextJoin = process.argv.includes('--hold-first-join-ack');
let releaseJoinAck: (() => void) | undefined;
const handle = hub.handle.bind(hub);
hub.handle = async (session, message) => {
  if (!holdNextJoin || message.type !== 'join') return handle(session, message);
  holdNextJoin = false;
  const previousSend = session.send;
  const send = previousSend.bind(session);
  session.send = (reply, encoded) => {
    if (reply.type === 'ok' && reply.requestId === message.requestId) {
      releaseJoinAck = () => send(reply, encoded);
    } else send(reply, encoded);
  };
  try { await handle(session, message); }
  finally { session.send = previousSend; }
};
const server = createStageServer({ config, hub, log: silentLogger, baseDir: process.cwd() });
const ids = new WeakMap<object, number>();
let nextId = 0;
process.on('message', (message: { id: number; type: string }) => {
  void (async () => {
    if (message.type === 'release-join-ack') {
      if (!releaseJoinAck) throw new Error('no held join ACK');
      const release = releaseJoinAck; releaseJoinAck = undefined; release();
    }
    if (message.type === 'shutdown') { releaseJoinAck = undefined; await server.close(); await transport.close(); }
    const peers = [...transport.rooms].flatMap(([roomId, room]) => [...room.peers].map(([participantId, peer]) => {
      if (!ids.has(peer)) ids.set(peer, ++nextId);
      return { roomId, participantId, identity: ids.get(peer) };
    }));
    process.send?.({ id: message.id, peers, heldJoinAck: !!releaseJoinAck });
  })().catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
});
process.on('disconnect', () => { releaseJoinAck = undefined; void server.close().finally(() => transport.close()); });
const address = await server.listen();
process.send?.({ url: `ws://127.0.0.1:${address.port}${config.server.wsPath}` });
