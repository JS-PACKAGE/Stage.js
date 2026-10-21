import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../../../shared/protocol.ts';
import { StageClient, StageError } from '../src/index.ts';

/** Browser media is fake; SDK scheduling and native WebSocket/server/Hub processing are real. */
class Peer {
  connectionState = 'connected';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly transceiver = { direction: 'recvonly', sender: { track: null as unknown, replaceTrack: async (track: unknown) => { this.transceiver.sender.track = track; } } };
  addTransceiver() { return this.transceiver; }
  async createOffer() { return { type: 'offer' as const, sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${this.transceiver.direction}\r\n` }; }
  async setLocalDescription(description: RTCSessionDescriptionInit) { this.localDescription = description; }
  async setRemoteDescription(description: RTCSessionDescriptionInit) { this.remoteDescription = description; }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) { if (Date.now() >= deadline) throw new Error(`timed out: ${label}`); await sleep(2); }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
interface Inspection { id: number; now: number; peers: { participantId: string; identity: number }[]; warnings: { message: string; fields: unknown }[] }
type Order = 'control-before-ping' | 'ping-before-control' | 'paced-controls' | 'unpaced-ping';
const scenarios: { rate: number; order: Order }[] = [
  { rate: 1, order: 'control-before-ping' }, { rate: 1, order: 'ping-before-control' },
  { rate: 20, order: 'control-before-ping' }, { rate: 20, order: 'ping-before-control' },
  { rate: 20, order: 'paced-controls' }, { rate: 1, order: 'unpaced-ping' },
];
for (const { rate, order } of scenarios) it(`paces SDK keepalive with ${order} at legal rate ${rate} over native WebSockets`, async t => {
  const child = fork(new URL('../../../test/fixtures/keepaliveServer.ts', import.meta.url), [String(rate)], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exit = once(child, 'exit');
  let stderr = ''; child.stderr?.on('data', data => { stderr += String(data); });
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  let now = 0, nextId = 0;
  const replies = new Map<number, (message: Inspection) => void>();
  child.on('message', message => { const reply = message as Inspection; const resolve = replies.get(reply.id); replies.delete(reply.id); resolve?.(reply); });
  async function inspect(time?: number): Promise<Inspection> {
    const id = ++nextId;
    const response = new Promise<Inspection>(resolve => replies.set(id, resolve));
    child.send({ id, type: time === undefined ? 'inspect' : 'clock', ...(time === undefined ? {} : { now: time }) });
    let result: Inspection | undefined;
    void response.then(value => { result = value; });
    await until(() => result !== undefined, `fixture response: ${stderr}`);
    return result!;
  }
  const sent: { at: number; message: ClientMessage }[] = [], received: ServerMessage[] = [];
  const sockets: Socket[] = [], closes: number[] = [], socketErrors: Error[] = [], errors: StageError[] = [];
  class Socket extends WebSocket {
    constructor(url: string) {
      super(url); sockets.push(this);
      this.on('close', code => closes.push(code)); this.on('error', error => socketErrors.push(error));
      this.on('message', data => received.push(JSON.parse(String(data)) as ServerMessage));
    }
    override send(data: Parameters<WebSocket['send']>[0], options?: Parameters<WebSocket['send']>[1] | Parameters<WebSocket['send']>[2], callback?: Parameters<WebSocket['send']>[2]): void {
      sent.push({ at: now, message: JSON.parse(String(data)) as ClientMessage });
      if (typeof options === 'function') super.send(data, options);
      else super.send(data, options ?? {}, callback);
    }
  }
  let client: StageClient | undefined;
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    const ready = message as { url: string; roomId: string; rate: number }; assert.equal(ready.rate, rate);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
    t.mock.method(performance, 'now', () => now);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    async function advance(time: number): Promise<void> {
      await inspect(time); const elapsed = time - now; now = time; t.mock.timers.tick(elapsed); await flush();
    }
    const sdk = client = new StageClient({ url: ready.url, audioElement: { pause() {} } as unknown as HTMLAudioElement,
      requestTimeoutMs: 5000, reconnect: { initialDelayMs: 30000, maxDelayMs: 30000 } });
    sdk.on('error', event => errors.push(event.detail));
    const joined = sdk.join({ roomId: ready.roomId, name: 'Guest' }); void joined.catch(() => {});
    await until(() => sdk['pending'].size > 0, 'SDK hello and queued join');
    await advance(0); await joined;
    await until(() => sdk['pending'].size > 0, 'queued initial offer');
    await advance(2000);
    await until(() => sdk['pc']?.remoteDescription != null && !sdk['negotiating'] && sdk['pending'].size === 0, 'initial offer and answer');
    const participant = sdk.me!.participantId, peer = sdk['pc'], socket = sockets[0]!;
    const serverPeer = (await inspect()).peers.find(value => value.participantId === participant); assert.ok(serverPeer);
    assert.equal(sdk.status, 'live'); assert.equal(sdk.rateLimits.controlPerSecond, rate);
    const baseline = sent.length;
    if (order === 'control-before-ping') {
      await advance(14500); const renamed = sdk.setName('Renamed'); await advance(14500); await renamed;
      assert.equal(sdk.me!.name, 'Renamed');
      await advance(15000);
      if (rate === 1) assert.equal(sent.length, baseline + 1, 'the conflicting rate-one keepalive must be omitted');
      else await until(() => received.some(message => message.type === 'pong'), 'default-rate keepalive pong');
      await advance(30000);
      await until(() => received.filter(message => message.type === 'pong').length === (rate === 1 ? 1 : 2), 'later idle pong');
    } else if (order === 'ping-before-control') {
      await advance(15000); await until(() => received.some(message => message.type === 'pong'), 'first keepalive pong');
      await advance(15500); const renamed = sdk.setName('Renamed'); void renamed.catch(() => {}); await advance(15500);
      if (rate === 1) {
        assert.equal(sent.length, baseline + 1, 'the caller waits for the ping slot');
        await advance(16999); assert.equal(sent.length, baseline + 1);
        await advance(17000);
      }
      await renamed;
      assert.equal(sdk.me!.name, 'Renamed');
      assert.equal(sent.at(-1)!.at, rate === 1 ? 17000 : 15500);
    } else if (order === 'paced-controls') {
      const renames: Promise<void>[] = [];
      for (let i = 0; i < 40; i++) {
        await advance(14000 + i * 100);
        const renamed = sdk.setName(`Guest ${i}`); void renamed.catch(() => {}); renames.push(renamed);
        await advance(now);
        const expectedSent = sent.filter(({ message }) => message.type === 'participant:rename').length;
        await until(() => received.filter(message => message.type === 'ok').length >= 2 + expectedSent, 'paced rename acknowledgements');
      }
      await advance(18000); await Promise.all(renames);
      assert.equal(sdk.me!.name, 'Guest 39');
      const renamesSent = sent.filter(({ message }) => message.type === 'participant:rename');
      assert.equal(renamesSent.length, 40);
      for (let i = 1; i < renamesSent.length; i++) assert.ok(renamesSent[i]!.at - renamesSent[i - 1]!.at >= 100);
      assert.equal(received.filter(message => message.type === 'pong').length, 1);
    } else {
      await advance(15000); await until(() => received.some(message => message.type === 'pong'), 'paced ping succeeds');
      // Direct out-of-SDK traffic remains subject to S4; the server must not exempt JSON ping.
      socket.send(JSON.stringify({ type: 'ping' }));
      await until(() => closes.length > 0, 'unpaced ping is closed');
      assert.deepEqual(closes, [1008]); assert.equal(sdk.status, 'reconnecting');
      assert.equal((await inspect()).warnings.length, 1);
      return;
    }
    assert.deepEqual(closes, []); assert.deepEqual(errors, []); assert.deepEqual(socketErrors, []);
    assert.equal(sdk.status, 'live'); assert.equal(sdk.me!.participantId, participant); assert.equal(sdk['pc'], peer);
    assert.equal(sdk['socket'], socket); assert.equal(socket.readyState, WebSocket.OPEN); assert.equal(sockets.length, 1);
    const final = await inspect(); assert.deepEqual(final.warnings, []);
    assert.equal(final.peers.find(value => value.participantId === participant)!.identity, serverPeer.identity);
    assert.equal(sdk['pending'].size, 0); assert.equal(sdk['pendingControlRequests'], 0);
    for (const { message } of sent.filter(({ message }) => message.type === 'ping')) assert.deepEqual(message, { type: 'ping' });
  } finally {
    await client?.disconnect();
    for (const socket of sockets) socket.terminate();
    t.mock.timers.reset(); t.mock.restoreAll();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    if (child.connected) child.disconnect();
    const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
    try { await exit; } finally { clearTimeout(kill); }
    assert.equal(client?.['keepaliveTimer'], undefined); assert.equal(client?.['reconnectTimer'], undefined);
    assert.equal(client?.['pending'].size, 0);
  }
});
