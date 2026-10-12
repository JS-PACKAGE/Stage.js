import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { it } from 'node:test';
import { WebSocket } from 'ws';
import { StageClient, StageError, type StageEventMap } from '../src/index.ts';

/** Deliberately fake browser media; the SDK and server signaling paths are real. */
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
class Context {
  createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
  createAnalyser() { return { fftSize: 2048, disconnect() {}, getFloatTimeDomainData() {} }; }
  async resume() {}
  async close() {}
}
class Socket extends WebSocket {
  static instances: Socket[] = [];
  constructor(url: string) { super(url); Socket.instances.push(this); }
}
function event<K extends keyof StageEventMap>(client: StageClient, type: K): Promise<StageEventMap[K]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { off(); reject(new Error(`timed out: SDK ${type}`)); }, 5000);
    const off = client.on(type, ({ detail }) => { clearTimeout(timer); off(); resolve(detail); });
  });
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error(`timed out: ${label}`); await sleep(5); }
}

it('runs SDK room actions, same-peer resume, kick and shutdown over real WebSockets', async () => {
  const child = fork(new URL('../../../test/fixtures/sdkServer.ts', import.meta.url), [], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exit = once(child, 'exit');
  let stderr = ''; child.stderr?.on('data', data => { stderr += String(data); });
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection', 'AudioContext', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const clients: StageClient[] = [];
  const errors: StageError[] = [];
  const replies = new Map<number, (message: Reply) => void>();
  interface Reply { id: number; peers: { roomId: string; participantId: string; identity: number }[] }
  let nextRequest = 0;
  child.on('message', message => { const reply = message as Reply; const resolve = replies.get(reply.id); replies.delete(reply.id); resolve?.(reply); });
  async function request(type: string): Promise<Reply> {
    const id = ++nextRequest;
    let timer: ReturnType<typeof setTimeout>;
    try {
      return await new Promise<Reply>((resolve, reject) => {
        timer = setTimeout(() => { replies.delete(id); reject(new Error(`fixture ${type} timed out: ${stderr}`)); }, 5000);
        replies.set(id, resolve); child.send({ id, type });
      });
    } finally { clearTimeout(timer!); replies.delete(id); }
  }
  try {
    const ready = await once(child, 'message', { signal: AbortSignal.timeout(5000) });
    const url = (ready[0] as { url: string }).url; assert.ok(url);
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
    Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => {
      const track = { enabled: true, stop() {} }; return { getTracks: () => [track], getAudioTracks: () => [track] };
    } } } });
    function make() {
      const audio = { volume: 1, muted: false, pause() {}, srcObject: null } as unknown as HTMLAudioElement;
      const client = new StageClient({ url, audioElement: audio, requestTimeoutMs: 5000, reconnect: { initialDelayMs: 1, maxDelayMs: 1 } });
      client.on('error', event => errors.push(event.detail)); clients.push(client); return client;
    }
    const host = make(), guest = make();
    const room = await host.createRoom({ name: 'Host', roomName: 'SDK integration', codeRequired: true });
    await guest.join({ ...room, name: 'Guest' });
    const id = guest.me!.participantId;
    assert.equal(guest.me!.role, 'audience'); assert.equal(guest.state!.code, undefined);
    assert.equal(host.state!.code, room.code);
    await guest.raiseHand();
    const raisedAt = guest['lastHandAt'];
    await until(() => host.state!.hands.some(person => person.participantId === id), 'controller sees raised hand');
    await host.approve(id);
    await until(() => guest.me!.onStage && guest['mic'] !== null, 'approved guest capture');
    guest.setPlaybackVolume(0.25); guest.setPlaybackMuted(true);
    assert.equal(guest['mic']!.getAudioTracks()[0]!.enabled, true);
    await guest.mute(); await until(() => guest.me!.muted, 'self mute');
    assert.equal(guest['mic']!.getAudioTracks()[0]!.enabled, false);
    await guest.unmute(); await host.forceMute(id);
    await until(() => guest.me!.forceMuted, 'controller force mute');
    await assert.rejects(guest.unmute(), (error: unknown) => error instanceof StageError && error.code === 'forbidden');
    await host.forceUnmute(id); await guest.leaveStage();
    await until(() => !guest.me!.onStage && guest['mic'] === null, 'stage leave');
    await until(() => guest['pc']?.remoteDescription != null && !guest['negotiating'], 'initial negotiation completes');
    const before = await request('inspect');
    const peer = before.peers.find(peer => peer.participantId === id); assert.ok(peer);
    const pc = guest['pc']; const oldSocket = Socket.instances.at(-1)!;
    const statuses: string[] = []; guest.on('status', event => statuses.push(event.detail));
    oldSocket.terminate();
    await until(() => statuses.includes('reconnecting') && Socket.instances.at(-1) !== oldSocket && guest.status === 'live', 'automatic same-seat resume');
    assert.equal(guest.me!.participantId, id); assert.equal(guest['pc'], pc);
    assert.equal((await request('inspect')).peers.find(peer => peer.participantId === id)!.identity, peer.identity);
    assert.equal(guest.playbackVolume, 0.25); assert.equal(guest.playbackMuted, true);
    assert.equal(guest['lastHandAt'], raisedAt, 'same-seat automatic resume retains local cooldown origin');
    const departingSocketClosed = once(Socket.instances.at(-1)!, 'close', { signal: AbortSignal.timeout(5000) });
    await guest.disconnect(); await departingSocketClosed;
    await guest.join({ ...room, name: 'Guest reused' });
    const freshId = guest.me!.participantId; assert.notEqual(freshId, id);
    assert.equal(guest.handCooldownMs, 0);
    await guest.raiseHand(); assert.equal(guest.me!.handRaised, true);
    const socketCount = Socket.instances.length;
    const kickedSocketClosed = once(Socket.instances.at(-1)!, 'close', { signal: AbortSignal.timeout(5000) });
    const kicked = event(guest, 'kicked');
    await Promise.all([host.kick(freshId), kicked, kickedSocketClosed]);
    assert.equal(guest.status, 'disconnected'); assert.equal(guest.state, null); assert.equal(guest['session'], null); assert.equal(guest['reconnectTimer'], undefined);
    assert.equal(guest['pc'], null); assert.equal(guest['mic'], null);
    const hostSocketClosed = once(Socket.instances[0]!, 'close', { signal: AbortSignal.timeout(5000) });
    const closed = event(host, 'closed');
    const [, detail] = await Promise.all([request('shutdown'), closed, hostSocketClosed]);
    assert.equal(detail.reason, 'shutdown');
    assert.equal(host.status, 'disconnected'); assert.equal(host['reconnectTimer'], undefined);
    assert.equal(host.state, null); assert.equal(host['session'], null); assert.equal(host['pc'], null); assert.equal(host['mic'], null);
    // Observe actual socket close before checking beyond the configured 1 ms reconnect delay.
    await sleep(25);
    assert.equal(Socket.instances.length, socketCount);
    assert.deepEqual(errors.map(error => error.code), ['forbidden']);
  } finally {
    for (const client of clients) await client.disconnect();
    for (const socket of Socket.instances.splice(0)) socket.terminate();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    // A failing assertion must not leave a listener, child or test runner hanging.
    if (child.connected) child.disconnect();
    const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
    try { await exit; } finally { clearTimeout(kill); }
  }
});
