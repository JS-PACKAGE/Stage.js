import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { ClientMessage } from '../../../shared/protocol.ts';
import { StageClient, StageError } from '../src/index.ts';

/** Only browser media is fake; transport closure, validation, Hub binding and SDK timers are real. */
class Peer {
  connectionState = 'connected';
  signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly transceiver = { direction: 'recvonly', sender: { track: null, replaceTrack: async () => {} } };
  addTransceiver() { return this.transceiver; }
  async createOffer() { return { type: 'offer' as const, sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${this.transceiver.direction}\r\n` }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription(value: RTCSessionDescriptionInit) { this.remoteDescription = value; }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
}

async function until(predicate: () => boolean | Promise<boolean>, label: string, ms = 4000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!await predicate()) {
    if (performance.now() >= deadline) throw new Error(`timed out: ${label}`);
    await sleep(2);
  }
}
async function within<T>(promise: Promise<T>, label: string, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

interface Inspection {
  id: number;
  socketErrors: string[];
  sessions: { readyState: number; paused: boolean; participantId: string | null; joins: Extract<ClientMessage, { type: 'join' }>[] }[];
  peers: { roomId: string; participantId: string; identity: number }[];
}
async function fixture(maxAudience = 300) {
  // Server-only ES2024 code stays outside the browser SDK test's ES2022/DOM compilation.
  const child = fork(new URL('../../../test/fixtures/closingSocketServer.ts', import.meta.url), [String(maxAudience)],
    { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exit = once(child, 'exit');
  let stderr = ''; child.stderr?.on('data', data => { stderr += String(data); });
  let nextId = 0;
  const replies = new Map<number, (message: Inspection) => void>();
  child.on('message', message => {
    const reply = message as Inspection;
    const resolve = replies.get(reply.id); replies.delete(reply.id); resolve?.(reply);
  });
  async function command(type: 'inspect' | 'pause' | 'resume', index?: number): Promise<Inspection> {
    const id = ++nextId;
    const response = new Promise<Inspection>(resolve => replies.set(id, resolve));
    child.send({ id, type, ...(index === undefined ? {} : { index }) });
    try { return await within(response, `server ${type}: ${stderr}`); }
    finally { replies.delete(id); }
  }
  const inspect = () => command('inspect');
  const pause = (index: number) => command('pause', index);
  const resume = (index: number) => command('resume', index);
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const target = new EventTarget();
  const sockets: WebSocket[] = [], socketErrors: Error[] = [], errors: StageError[] = [];
  class Socket extends WebSocket {
    constructor(url: string) {
      super(url); sockets.push(this);
      this.on('error', error => socketErrors.push(error));
    }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  let client: StageClient | undefined;
  const close = async () => {
    try { await client?.disconnect(); }
    finally {
      for (const socket of sockets) socket.terminate();
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      if (child.connected) child.disconnect();
      const kill = setTimeout(() => child.kill('SIGKILL'), 4000);
      try {
        const [code, signal] = await exit;
        assert.equal(code, 0, `native fixture exited cleanly: ${stderr}`);
        assert.equal(signal, null);
      } finally { clearTimeout(kill); }
      await until(() => sockets.every(socket => socket.readyState === WebSocket.CLOSED), 'all client WebSockets close');
      if (client) {
        assert.equal(client['pending'].size, 0);
        assert.equal(client['pendingControlRequests'], 0);
        assert.equal(client['connecting'], null);
        assert.equal(client['reconnectTimer'], undefined);
        assert.equal(client['keepaliveTimer'], undefined);
      }
    }
  };
  try {
    const [message] = await once(child, 'message', { signal: AbortSignal.timeout(4000) });
    const ready = message as { url: string; roomId: string };
    const sdk = client = new StageClient({
      url: ready.url, audioElement: { pause() {} } as unknown as HTMLAudioElement,
      requestTimeoutMs: 3000, maxPendingControlRequests: 1,
      reconnect: { initialDelayMs: 750, maxDelayMs: 750 },
    });
    sdk.on('error', event => errors.push(event.detail));
    const statuses: string[] = [];
    sdk.on('status', event => statuses.push(event.detail));
    await within(sdk.join({ roomId: ready.roomId, name: 'Guest' }), 'initial audience join');
    await until(() => sdk['pending'].size === 0 && !sdk['negotiating'] && sdk['pc']?.remoteDescription != null, 'initial browser and server media');
    assert.equal(sdk.status, 'live');
    const participant = sdk.me!.participantId, peer = sdk['pc'];
    const initial = await inspect();
    const serverPeer = initial.peers.find(value => value.participantId === participant)!;
    assert.ok(peer); assert.ok(serverPeer);
    assert.equal(initial.sessions[0]!.participantId, participant);
    return { sdk, target, sockets, errors, socketErrors, statuses, participant, peer, serverPeer,
      roomId: ready.roomId, inspect, pause, resume, close };
  } catch (error) { await close(); throw error; }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function beginClosing(f: Fixture) {
  const { sdk, sockets, target } = f;
  const oldSocket = sockets[0]!;
  const paused = await f.pause(0);
  assert.equal(paused.sessions[0]!.paused, true);
  let outcome: string = 'pending';
  const request = sdk.setName('Held before pagehide').then(() => { outcome = 'resolved'; }, (error: StageError) => { outcome = error.code; });
  assert.equal(sdk['pending'].size, 1);
  const pending = [...sdk['pending'].values()][0]!;
  // Observing the existing send timer proves native send ran without overriding WebSocket.send.
  await until(() => pending.sendTimer === undefined, 'old public rename sent while server reads are paused');
  assert.equal(outcome, 'pending');
  assert.equal(sdk['pendingControlRequests'], 1);
  target.dispatchEvent(new Event('pagehide'));
  assert.equal(oldSocket.readyState, WebSocket.CLOSING);
  const closing = await f.inspect();
  assert.equal(closing.sessions[0]!.readyState, WebSocket.OPEN);
  assert.equal(closing.sessions[0]!.paused, true);
  return { oldSocket, pending, request, outcome: () => outcome };
}

it('retires a native CLOSING owner before hello and resumes exactly once on the same server seat and peer', { timeout: 10000 }, async () => {
  const f = await fixture();
  const { sdk, sockets, statuses, roomId, participant, peer, serverPeer, inspect } = f;
  try {
    const old = await beginClosing(f);
    const oldSnapshot = sdk.state, session = sdk['session'];
    const hello = sdk.connect();
    void hello.catch(() => {});
    await Promise.resolve();
    assert.equal(old.outcome(), 'disconnected', 'replacement must retire the sent request before its original deadline or old close');
    assert.equal(sdk['pending'].size, 0);
    assert.equal(sdk['pendingControlRequests'], 0);
    assert.equal((old.pending.timer as unknown as { _destroyed: boolean })._destroyed, true, 'the native old request deadline is cleared');
    assert.equal(old.pending.sendTimer, undefined);
    assert.equal(sdk['nextControlAt'], 0);
    assert.equal(sdk['nextIceAt'], 0);
    assert.equal(sdk['lastSendAt'], 0);
    assert.equal(sdk.status, 'reconnecting');
    assert.deepEqual(statuses, ['live', 'reconnecting']);
    assert.equal(sdk['session'], session);
    assert.equal(sdk['pc'], peer);
    assert.ok(sdk['reconnectTimer']);
    await within(hello, 'transport-only replacement hello');
    const replacement = sockets[1]!;
    const beforeResume = await inspect();
    assert.equal(sockets.length, 2);
    assert.equal(replacement.readyState, WebSocket.OPEN);
    assert.equal(old.oldSocket.readyState, WebSocket.CLOSING);
    assert.equal(beforeResume.sessions[1]!.participantId, null, 'hello is not room entry');
    assert.equal(beforeResume.sessions[1]!.joins.length, 0);
    assert.equal(sdk.state, oldSnapshot, 'hello cannot synthesize a new authoritative room state');
    assert.equal(sdk.status, 'reconnecting');
    assert.equal(sdk['pc'], peer);

    await f.resume(0);
    await until(async () => old.oldSocket.readyState === WebSocket.CLOSED && (await inspect()).sessions[0]!.participantId === null,
      'old native close and Hub detach before backoff');
    assert.equal((await inspect()).sessions[1]!.joins.length, 0, 'same-seat case must detach the old owner before its auto join');
    await until(async () => sdk.status === 'live' && sdk['pending'].size === 0 && (await inspect()).sessions[1]!.participantId === participant,
      'automatic same-seat join and ACK');
    const recovered = await inspect();
    assert.equal(recovered.sessions[1]!.joins.length, 1);
    const automatic = recovered.sessions[1]!.joins[0]!;
    assert.equal(automatic.roomId, roomId);
    assert.equal(automatic.resumeToken, oldSnapshot!.resumeToken);
    assert.equal(sdk.me!.participantId, participant);
    assert.equal(sdk['pc'], peer);
    assert.equal(recovered.peers.find(value => value.participantId === participant)!.identity, serverPeer.identity);
    await within(sdk.setName('Recovered audience'), 'fresh public control after resume');
    assert.equal(sdk.me!.name, 'Recovered audience');
    const final = await inspect();
    assert.equal(final.sessions[1]!.participantId, participant);
    assert.equal(sdk['socket'], replacement);
    assert.equal(sdk['reconnectTimer'], undefined);
    assert.equal(final.sessions[1]!.joins.length, 1);
    assert.equal(sockets.length, 2);
    assert.deepEqual(statuses, ['live', 'reconnecting', 'live']);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.socketErrors, []);
    assert.deepEqual(final.socketErrors, []);
    await old.request;
  } finally { await f.close(); }
});

it('keeps existing new-seat policy when native old close stalls past backoff and ignores that late close', { timeout: 10000 }, async () => {
  const f = await fixture();
  const { sdk, sockets, participant, peer, inspect } = f;
  try {
    const old = await beginClosing(f);
    await within(sdk.connect(), 'replacement hello during long close stall');
    assert.equal(old.outcome(), 'disconnected');
    const replacement = sockets[1]!;
    await until(() => sdk.status === 'live' && sdk.me?.participantId !== participant && sdk['pending'].size === 0 && !sdk['negotiating'],
      'existing-policy join while previous seat is still connected');
    const freshParticipant = sdk.me!.participantId, freshPeer = sdk['pc'];
    const recovered = await inspect();
    assert.equal(old.oldSocket.readyState, WebSocket.CLOSING);
    assert.equal(recovered.sessions[0]!.paused, true);
    assert.equal(recovered.sessions[0]!.participantId, participant);
    assert.notEqual(freshParticipant, participant, 'the server does not take over a still-connected seat');
    assert.equal(recovered.sessions[1]!.participantId, freshParticipant);
    assert.notEqual(freshPeer, peer, 'authoritative new identity creates a new browser peer');
    assert.equal(peer!.connectionState, 'closed');
    const freshServerPeer = recovered.peers.find(value => value.participantId === freshParticipant)!;
    assert.ok(freshServerPeer);
    assert.notEqual(freshServerPeer.identity, f.serverPeer.identity);
    assert.equal(recovered.sessions[1]!.joins.length, 1);

    await f.pause(1);
    const renamed = sdk.setName('Current owner survives');
    void renamed.catch(() => {});
    const currentPending = [...sdk['pending'].values()][0]!;
    await until(() => currentPending.sendTimer === undefined, 'fresh owner request sent before late old close');
    const keepalive = sdk['keepaliveTimer'];
    await f.resume(0);
    await until(async () => old.oldSocket.readyState === WebSocket.CLOSED && (await inspect()).sessions[0]!.participantId === null,
      'late old close and detach');
    assert.equal(sdk['pending'].size, 1, 'late old close must not reject the replacement request');
    assert.equal([...sdk['pending'].values()][0], currentPending);
    assert.equal(sdk['pendingControlRequests'], 1);
    assert.equal(sdk['socket'], replacement);
    assert.equal(sdk['pc'], freshPeer);
    assert.equal(sdk['keepaliveTimer'], keepalive);
    assert.equal(sdk.status, 'live');
    assert.equal(sdk['reconnectTimer'], undefined);
    assert.equal((await inspect()).sessions[1]!.participantId, freshParticipant);
    await f.resume(1);
    await within(renamed, 'current request ACK after late old close');
    assert.equal(sdk.me!.name, 'Current owner survives');
    assert.equal(sdk['pc'], freshPeer);
    const final = await inspect();
    assert.equal(final.peers.find(value => value.participantId === freshParticipant)!.identity, freshServerPeer.identity);
    assert.equal(final.sessions[1]!.joins.length, 1);
    assert.equal(sockets.length, 2);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.socketErrors, []);
    assert.deepEqual(final.socketErrors, []);
    await old.request;
  } finally { await f.close(); }
});

it('preserves terminal room_full policy when a native old seat stays connected beyond recovery backoff', { timeout: 10000 }, async () => {
  const f = await fixture(1);
  const { sdk, sockets, participant, inspect } = f;
  try {
    const old = await beginClosing(f);
    await within(sdk.connect(), 'replacement hello at room capacity');
    assert.equal(old.outcome(), 'disconnected');
    await until(() => sdk.status === 'disconnected' && sdk['session'] === null, 'terminal real Hub room_full refusal');
    const refused = await inspect();
    assert.equal(old.oldSocket.readyState, WebSocket.CLOSING);
    assert.equal(refused.sessions[0]!.participantId, participant);
    assert.equal(refused.sessions[1]!.participantId, null);
    assert.equal(refused.sessions[1]!.joins.length, 1);
    assert.ok(f.errors.length >= 1);
    assert.ok(f.errors.every(error => error.code === 'room_full'));
    assert.equal(sdk['pc'], null);
    assert.equal(sdk['pending'].size, 0);
    assert.equal(sdk['pendingControlRequests'], 0);
    assert.equal(sdk['reconnectTimer'], undefined);
    await f.resume(0);
    await until(async () => old.oldSocket.readyState === WebSocket.CLOSED && (await inspect()).sessions[0]!.participantId === null,
      'late old close after terminal refusal');
    assert.equal(sdk.status, 'disconnected');
    assert.equal(sdk['session'], null);
    assert.equal(sdk['reconnectTimer'], undefined);
    assert.equal(sockets.length, 2);
    const final = await inspect();
    assert.equal(final.sessions[1]!.joins.length, 1);
    assert.deepEqual(f.socketErrors, []);
    assert.deepEqual(final.socketErrors, []);
    await old.request;
  } finally { await f.close(); }
});

it('normally resumes after native pagehide close without an explicit overlapping connect', { timeout: 10000 }, async () => {
  const f = await fixture();
  const { sdk, sockets, participant, peer, inspect } = f;
  try {
    const old = await beginClosing(f);
    assert.equal(old.outcome(), 'pending');
    assert.equal(sdk.status, 'live');
    assert.equal(sdk['reconnectTimer'], undefined);
    await f.resume(0);
    await until(() => old.outcome() === 'disconnected', 'ordinary close retires the old request');
    assert.equal(sdk.status, 'reconnecting');
    assert.equal(sdk['pending'].size, 0);
    assert.equal(sdk['pendingControlRequests'], 0);
    assert.ok(sdk['reconnectTimer']);
    await until(() => sockets.length === 2 && sdk.status === 'live' && sdk['pending'].size === 0, 'ordinary automatic resume');
    const recovered = await inspect();
    assert.equal(recovered.sessions[1]!.participantId, participant);
    assert.equal(sdk['pc'], peer);
    assert.equal(recovered.sessions[0]!.participantId, null);
    assert.equal(recovered.sessions[1]!.joins.length, 1);
    await within(sdk.setName('Normal close recovered'), 'normal recovery public control');
    assert.equal(sdk.me!.name, 'Normal close recovered');
    assert.equal(sdk.me!.participantId, participant);
    assert.equal(sockets.length, 2);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.socketErrors, []);
    assert.deepEqual((await inspect()).socketErrors, []);
    await old.request;
  } finally { await f.close(); }
});
