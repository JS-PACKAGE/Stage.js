import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { it, type TestContext } from 'node:test';
import { WebSocket } from 'ws';
import type { ClientMessage, ClientMessageType, RoomStatePayload, ServerMessage } from '../../../shared/protocol.ts';
import { StageClient, StageError } from '../src/index.ts';

// Browser media and server MockMediaTransport are fake; SDK, hub and native loopback WebSockets are real.
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
  readonly frames: ServerMessage[] = [];
  readonly sent: ClientMessage[] = [];
  readonly trace: string[] = [];
  constructor(url: string) {
    super(url); Socket.instances.push(this);
    this.on('message', data => {
      const message = JSON.parse(String(data)) as ServerMessage;
      this.frames.push(message); this.trace.push(`wire:${message.type}`);
    });
    // Capture SDK-generated request IDs without injecting any application frames.
    const send = this.send;
    this.send = ((...args: Parameters<WebSocket['send']>) => {
      if (typeof args[0] === 'string') this.sent.push(JSON.parse(args[0]) as ClientMessage);
      Reflect.apply(send, this, args);
    }) as WebSocket['send'];
  }
}
interface Inspection {
  id: number;
  roomCount: number;
  heldControls: string[];
  peers: { roomId: string; participantId: string; identity: number }[];
  media: { roomId: string; identity: number; sources: { participantId: string; identity: number; muted: boolean; gain: number; targetGain: number; buffered: number }[] }[];
  gains: { participantId: string; gainDb: number; negativeZero: boolean }[];
}
interface Viewer { client: StageClient; states: RoomStatePayload[]; errors: StageError[] }
// These reads and native control-frame barriers are test instrumentation, never SDK command substitutes.
const socketOf = (viewer: Viewer): Socket => viewer.client['socket'] as unknown as Socket;
async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!predicate()) { if (performance.now() >= deadline) throw new Error(`timed out: ${label}`); await sleep(5); }
}
function barrier(socket: Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(randomUUID());
    const finish = (error?: Error) => {
      clearTimeout(timer); socket.off('pong', pong); socket.off('error', failed); socket.off('close', closed);
      if (error) reject(error); else resolve();
    };
    const pong = (received: Buffer) => { if (received.equals(payload)) finish(); };
    const failed = (error: Error) => finish(error);
    const closed = () => finish(new Error('socket closed before native pong barrier'));
    const timer = setTimeout(() => finish(new Error('native pong barrier timed out')), 5000);
    socket.on('pong', pong); socket.on('error', failed); socket.on('close', closed);
    try { socket.ping(payload, undefined, error => { if (error) finish(error); }); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
async function stage(t: TestContext, requestTimeoutMs = 5000) {
  const child = fork(new URL('../../../test/fixtures/sdkServer.ts', import.meta.url), ['--mic-controls'], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const exit = once(child, 'exit'); void exit.catch(() => {});
  const ready = once(child, 'message', { signal: AbortSignal.timeout(5000) });
  let stderr = ''; child.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-16384); });
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection', 'AudioContext', 'navigator'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const viewers: Viewer[] = [];
  const replies = new Map<number, (reply: Inspection) => void>();
  let nextId = 0;
  child.on('message', message => { const reply = message as Inspection; replies.get(reply.id)?.(reply); });
  async function request(type: string, fields: { controlType?: ClientMessageType; requestId?: string } = {}): Promise<Inspection> {
    const id = ++nextId;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<Inspection>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`fixture ${type} timed out: ${stderr}`)), 5000);
        replies.set(id, resolve); child.send({ id, type, ...fields });
      });
    } finally { clearTimeout(timer); replies.delete(id); }
  }
  t.after(async () => {
    for (const viewer of viewers) await viewer.client.disconnect();
    for (const socket of Socket.instances.splice(0)) socket.terminate();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    if (child.connected) child.disconnect();
    const kill = setTimeout(() => child.kill('SIGKILL'), 1500);
    try { await exit; } finally { clearTimeout(kill); }
  });
  const [message] = await ready;
  const { url } = message as { url: string }; assert.ok(url);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  Object.defineProperty(globalThis, 'AudioContext', { configurable: true, value: Context });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia: async () => {
    const track = { enabled: true, stop() {} }; return { getTracks: () => [track], getAudioTracks: () => [track] };
  } } } });
  function make(): Viewer {
    const audio = { volume: 1, muted: false, pause() {}, srcObject: null } as unknown as HTMLAudioElement;
    const client = new StageClient({ url, audioElement: audio, requestTimeoutMs, maxPendingControlRequests: 1 });
    const viewer: Viewer = { client, states: [], errors: [] }; viewers.push(viewer);
    client.on('state', ({ detail }) => { viewer.states.push(detail); socketOf(viewer).trace.push('state'); });
    client.on('error', ({ detail }) => viewer.errors.push(detail));
    return viewer;
  }
  const host = make(), speaker = make(), audience = make();
  const room = await host.client.createRoom({ name: 'Host', roomName: 'Native mic controls', codeRequired: true });
  await speaker.client.join({ ...room, name: 'Speaker' });
  await audience.client.join({ ...room, name: 'Audience' });
  await speaker.client.raiseHand();
  const speakerId = speaker.client.me!.participantId;
  await host.client.approve(speakerId);
  const drain = () => Promise.all(viewers.map(viewer => barrier(socketOf(viewer))));
  await drain();
  await until(() => speaker.client.me?.onStage === true && viewers.every(({ client }) =>
    client['transceiver']?.direction === (client.me?.onStage ? 'sendrecv' : 'recvonly') &&
    client['pc']?.remoteDescription != null && !client['negotiating'] && client['pending'].size === 0), 'initial SDK signaling settles');
  await drain();
  const tokens = viewers.map(viewer => viewer.client.state!.resumeToken);
  assert.ok(tokens.every(token => typeof token === 'string' && token.length > 0));
  assert.equal(new Set(tokens).size, 3);
  function privacy(): void {
    for (const [index, viewer] of viewers.entries()) {
      const state = viewer.client.state!;
      assert.equal(state.roomId, room.roomId);
      assert.equal(state.resumeToken, tokens[index]);
      assert.equal(state.me.participantId, viewer.states[0]!.me.participantId);
      assert.equal(state.audienceCount, 1);
      if (viewer === host) {
        assert.equal(state.code, room.code);
        assert.deepEqual(state.audience?.map(person => person.participantId), [audience.client.me!.participantId]);
      } else { assert.equal('code' in state, false); assert.equal('audience' in state, false); }
      for (const person of [state.me, ...state.speakers, ...state.hands, ...(state.audience ?? [])]) assert.equal('resumeToken' in person, false);
      for (const token of tokens.filter(token => token !== state.resumeToken)) assert.equal(JSON.stringify(state).includes(token!), false);
    }
  }
  privacy();
  return { host, speaker, audience, viewers, room, speakerId, request, drain, privacy };
}

it('keeps all five public mic no-ops requester-only over native WebSockets while changed and hidden controls still broadcast', async t => {
  const s = await stage(t);
  const { host, speaker, audience, viewers, speakerId } = s;
  const identity = await s.request('inspect');
  const requestIds = new Set<string>();
  async function operation(requester: Viewer, action: () => Promise<void>, duplicate: boolean, mic?: 'mic:muted' | 'mic:unmuted'): Promise<void> {
    const before = viewers.map(viewer => ({ count: viewer.states.length, state: viewer.client.state, frame: socketOf(viewer).frames.length }));
    const socket = socketOf(requester), trace = socket.trace.length, sent = socket.sent.length;
    const media = await s.request('inspect');
    await action().then(() => { socket.trace.push('promise'); });
    // The ACK follows server fanout. Pongs on each downstream TCP stream therefore follow all its earlier frames.
    await s.drain();
    const command = socket.sent.slice(sent);
    assert.equal(command.length, 1, 'exactly one public control was sent');
    assert.ok(command[0]!.type !== 'ping');
    const requestId = command[0]!.requestId;
    assert.equal(requestIds.has(requestId), false); requestIds.add(requestId);
    assert.deepEqual(socket.trace.slice(trace), [...(mic ? [`wire:${mic}`] : []), 'wire:room:state', 'state', 'wire:ok', 'promise'], 'SDK state is delivered before the matching ACK resolves the public promise');
    for (const [index, viewer] of viewers.entries()) {
      const expected = duplicate && viewer !== requester ? 0 : 1;
      assert.equal(viewer.states.length - before[index]!.count, expected, `${command[0]!.type}: ${viewer.client.me!.role} state count`);
      const frames = socketOf(viewer).frames.slice(before[index]!.frame);
      assert.deepEqual(frames.map(frame => frame.type), [...(mic ? [mic] : []), ...(expected ? ['room:state'] : []), ...(viewer === requester ? ['ok'] : [])]);
      if (viewer === requester) assert.deepEqual(frames.at(-1), { type: 'ok', requestId });
      if (duplicate) assert.deepEqual(viewer.client.state, before[index]!.state);
    }
    assert.notEqual(requester.client.state, before[viewers.indexOf(requester)]!.state, 'requester receives a fresh state object');
    const after = await s.request('inspect');
    assert.equal(after.roomCount, 1);
    assert.deepEqual(after.peers, identity.peers, 'controls preserve every server media peer');
    if (duplicate) assert.deepEqual(after.media, media.media, 'no-op preserves mixer, sources, gain targets and buffers');
    assert.equal(after.gains.length - media.gains.length, command[0]!.type === 'mic:gain' ? 1 : 0, 'each public gain, including a no-op, invokes the established mixer setter once');
    s.privacy();
  }
  const view = (viewer: Viewer) => viewer.client.state!.speakers.find(person => person.participantId === speakerId)!;
  await operation(speaker, () => speaker.client.mute(), false, 'mic:muted');
  await operation(speaker, () => speaker.client.mute(), true);
  await operation(speaker, () => speaker.client.unmute(), false, 'mic:unmuted');
  await operation(speaker, () => speaker.client.unmute(), true);
  await operation(host, () => host.client.forceMute(speakerId), false, 'mic:muted');
  await operation(host, () => host.client.forceMute(speakerId), true);
  await operation(host, () => host.client.forceUnmute(speakerId), false, 'mic:unmuted');
  await operation(host, () => host.client.forceUnmute(speakerId), true);
  await operation(host, () => host.client.setGain(speakerId, 6.04), false);
  await operation(host, () => host.client.setGain(speakerId, 6.01), true);
  for (const viewer of viewers) assert.equal(view(viewer).gainDb, 6);
  assert.equal((await s.request('inspect')).media[0]!.sources.find(source => source.participantId === speakerId)!.targetGain, 10 ** (6 / 20));
  await operation(host, () => host.client.setGain(speakerId, 0), false);
  for (const gain of [-0, -0.04, 0.04]) {
    await operation(host, () => host.client.setGain(speakerId, gain), true);
    const setter = (await s.request('inspect')).gains.at(-1)!;
    assert.equal(setter.participantId, speakerId); assert.equal(setter.gainDb, 0);
    assert.equal(setter.negativeZero, gain === -0.04, 'JSON canonicalizes -0; server normalization of -0.04 still reaches the mixer as -0');
  }
  await operation(host, () => host.client.forceMute(speakerId), false, 'mic:muted');
  const forced = structuredClone(viewers.map(viewer => viewer.client.state));
  await operation(speaker, () => speaker.client.mute(), false);
  assert.deepEqual(viewers.map(viewer => viewer.client.state), forced, 'hidden self-mute broadcasts even while its public projection is identical');
  await operation(host, () => host.client.forceUnmute(speakerId), false);
  for (const viewer of viewers) { assert.equal(view(viewer).muted, true); assert.equal(view(viewer).forceMuted, false); }
  await operation(host, () => host.client.forceMute(speakerId), false);
  for (const viewer of viewers) assert.equal(view(viewer).forceMuted, true);
  const beforeError = viewers.map(viewer => ({ count: viewer.states.length, frame: socketOf(viewer).frames.length }));
  await assert.rejects(speaker.client.unmute(), error => error instanceof StageError && error.code === 'forbidden');
  await s.drain();
  for (const [index, viewer] of viewers.entries()) {
    assert.equal(viewer.states.length, beforeError[index]!.count);
    assert.deepEqual(socketOf(viewer).frames.slice(beforeError[index]!.frame).map(frame => frame.type), viewer === speaker ? ['error'] : []);
  }
  assert.deepEqual(speaker.errors.map(error => error.code), ['forbidden']);
  assert.deepEqual(host.errors, []); assert.deepEqual(audience.errors, []);
  await operation(host, () => host.client.forceUnmute(speakerId), false);
  await operation(speaker, () => speaker.client.unmute(), false, 'mic:unmuted');
  for (const viewer of viewers) assert.equal(view(viewer).muted, false);
  assert.deepEqual((await s.request('inspect')).media.map(mixer => [mixer.identity, mixer.sources.map(source => source.identity)]), identity.media.map(mixer => [mixer.identity, mixer.sources.map(source => source.identity)]));
});

it('times out a held no-op ACK, releases public control capacity, and ignores its late ACK while another request is pending', async t => {
  const s = await stage(t, 1000);
  const { speaker, viewers } = s;
  await speaker.client.mute(); await s.drain();
  const identity = await s.request('inspect');
  async function hold(): Promise<void> { await s.request('hold-next-control-ack', { controlType: 'mic:mute' }); }
  async function held(count: number): Promise<Inspection> {
    let state = await s.request('inspect');
    const deadline = performance.now() + 5000;
    while (state.heldControls.length !== count) {
      if (performance.now() >= deadline) throw new Error('timed out waiting for held control ACK');
      await sleep(5); state = await s.request('inspect');
    }
    return state;
  }
  const counts = viewers.map(viewer => viewer.states.length);
  await hold();
  const timedOut = assert.rejects(speaker.client.mute(), error => error instanceof StageError && error.code === 'timeout');
  const first = (await held(1)).heldControls[0]!;
  await s.drain();
  for (const [index, viewer] of viewers.entries()) assert.equal(viewer.states.length - counts[index]!, viewer === speaker ? 1 : 0);
  await assert.rejects(speaker.client.unmute(), error => error instanceof StageError && error.code === 'queue_full');
  await timedOut;
  await hold();
  let settled = false;
  const recovery = speaker.client.mute();
  void recovery.then(() => { settled = true; }, () => { settled = true; });
  const second = (await held(2)).heldControls.find(id => id !== first)!;
  assert.ok(second); assert.notEqual(first, second);
  await s.drain();
  const beforeLateAck = viewers.map(viewer => viewer.states.length);
  await s.request('release-control-ack', { requestId: first }); await s.drain();
  assert.equal(settled, false, 'the old ACK cannot resolve the newer public request');
  assert.deepEqual(viewers.map(viewer => viewer.states.length), beforeLateAck, 'late ACK does not manufacture state');
  await assert.rejects(speaker.client.unmute(), error => error instanceof StageError && error.code === 'queue_full');
  await s.request('release-control-ack', { requestId: second }); await recovery; await s.drain();
  assert.equal(settled, true);
  await speaker.client.unmute(); await s.drain();
  for (const viewer of viewers) {
    assert.equal(viewer.client.state!.speakers.find(person => person.participantId === s.speakerId)!.muted, false);
    assert.deepEqual(viewer.errors, []);
  }
  const after = await s.request('inspect');
  assert.equal(after.roomCount, 1); assert.deepEqual(after.peers, identity.peers); assert.deepEqual(after.heldControls, []);
  s.privacy();
});
