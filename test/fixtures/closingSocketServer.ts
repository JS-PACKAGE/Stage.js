/** Native loopback control plane; IPC only observes state and pauses/resumes real socket reads. */
import { silentLogger } from '../../src/log.ts';
import { createStageServer } from '../../src/ws/server.ts';
import type { WsSession } from '../../src/ws/session.ts';
import type { ClientMessage } from '../../shared/protocol.ts';
import { harness, testConfig } from '../helpers.ts';

const config = testConfig(c => {
  c.server.host = '127.0.0.1'; c.server.port = 0; c.server.static = [];
  c.rooms.presenceBroadcastMs = 0; c.rooms.qualityIntervalMs = 0;
  c.limits.maxAudiencePerRoom = Number(process.argv[2]);
});
// Room grace timers and mixer ticks are controlled by the existing harness; SDK/network time is native.
const h = harness(config);
const host = await h.create('Host', { codeRequired: false });
const sessions: WsSession[] = [];
const requests = new Map<WsSession, ClientMessage[]>();
const socketErrors: string[] = [];
const attach = h.hub.attach.bind(h.hub);
h.hub.attach = session => {
  const native = session as WsSession;
  sessions.push(native); requests.set(native, []);
  native.ws.on('message', data => requests.get(native)!.push(JSON.parse(String(data)) as ClientMessage));
  native.ws.on('error', error => socketErrors.push(error.message));
  attach(session);
};
const server = createStageServer({ config, hub: h.hub, log: silentLogger, baseDir: process.cwd() });
const identities = new WeakMap<object, number>();
let nextIdentity = 0;
function identity(peer: object): number {
  if (!identities.has(peer)) identities.set(peer, ++nextIdentity);
  return identities.get(peer)!;
}
process.on('message', (message: { id: number; type: 'inspect' | 'pause' | 'resume'; index?: number }) => {
  if (message.type !== 'inspect') {
    const session = sessions[message.index!];
    if (!session) throw new Error('unknown native test session');
    if (message.type === 'pause') session.ws.pause(); else session.ws.resume();
  }
  process.send?.({
    id: message.id, socketErrors,
    sessions: sessions.map(session => ({
      readyState: session.ws.readyState, paused: session.ws.isPaused,
      participantId: h.hub['bindings'].get(session)?.participantId ?? null,
      joins: requests.get(session)!.filter(request => request.type === 'join'),
    })),
    peers: [...h.transport.rooms].flatMap(([roomId, room]) => [...room.peers].map(([participantId, peer]) => ({
      roomId, participantId, identity: identity(peer),
    }))),
  });
});
process.on('disconnect', () => {
  for (const session of sessions) { session.ws.resume(); session.terminate(); }
  void server.close().finally(() => h.transport.close()).catch(error => {
    console.error(error); process.exitCode = 1;
  });
});
const { port } = await server.listen();
process.send?.({ url: `ws://127.0.0.1:${port}${config.server.wsPath}`, roomId: host.roomId });
