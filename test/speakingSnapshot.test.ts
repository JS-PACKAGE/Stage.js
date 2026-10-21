/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import { StageClient, type StageError } from '../packages/client/src/index.ts';
import type { AppConfig } from '../src/config.ts';
import { RoomMixer, type SpeakingListener } from '../src/mixer/RoomMixer.ts';
import { FakeSession, harness, RECVONLY_OFFER, SENDRECV_OFFER, sine, testConfig, type Harness } from './helpers.ts';

const liveTimers = (h: Harness) => h.timers.filter(timer => !timer.cleared);
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function setup(t: TestContext, beforeClose: () => Promise<void> = async () => {}, configure?: (config: AppConfig) => void): Harness {
  const h = harness(testConfig(config => {
    config.rooms.presenceBroadcastMs = 250;
    config.rooms.qualityIntervalMs = 0;
    configure?.(config);
  }));
  t.after(async () => {
    try { await beforeClose(); }
    finally {
      try { await h.hub.shutdown(); }
      finally {
        await h.transport.close();
        assert.equal(h.hub.roomCount, 0);
        assert.equal(h.transport.rooms.size, 0);
        assert.equal(liveTimers(h).length, 0, 'shutdown clears all controlled hub timers');
      }
    }
  });
  return h;
}

function arrival(session: FakeSession, ids: string[]): void {
  const relevant = session.inbox.filter(message => ['room:state', 'speaking', 'ok'].includes(message.type));
  assert.deepEqual(relevant.map(message => message.type), ['room:state', 'speaking', 'ok']);
  assert.deepEqual(session.last('speaking'), { type: 'speaking', participantIds: ids });
  assert.equal(session.all('speaking').length, 1, 'exactly one targeted full set, including empty');
}

function active(h: Harness, roomId: string, ids: string[]): void {
  for (const id of ids) assert.equal(h.transport.emitUplink(roomId, id, sine(960, 0.5)), true);
  h.mixers.get(roomId)!.tick();
}

async function publish(h: Harness, session: FakeSession): Promise<void> {
  assert.equal(await h.req(session, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
}

async function stageSpeaker(h: Harness, host: Awaited<ReturnType<Harness['create']>>, name = 'Speaker') {
  const speaker = await h.join(host.roomId, host.code, name);
  assert.equal(await h.req(speaker.s, { type: 'hand:raise' }), 'ok');
  assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
  await publish(h, speaker.s);
  return speaker;
}

async function resume(h: Harness, roomId: string, code: string, token: string) {
  const session = new FakeSession(); h.hub.attach(session);
  assert.equal(await h.req(session, { type: 'join', roomId, code, name: 'Resumed', resumeToken: token }), 'ok');
  return session;
}

function captureSpeaking(t: TestContext): Map<RoomMixer, SpeakingListener> {
  const callbacks = new Map<RoomMixer, SpeakingListener>();
  const original = RoomMixer.prototype.onSpeaking;
  t.mock.method(RoomMixer.prototype, 'onSpeaking', function (this: RoomMixer, listener: SpeakingListener) {
    callbacks.set(this, listener);
    return original.call(this, listener);
  });
  return callbacks;
}

for (const codeRequired of [true, false]) {
  test(`create sends empty speaking after personalized state and before ACK (${codeRequired ? 'coded' : 'open'} room)`, async t => {
    const h = setup(t), host = await h.create('Host', { codeRequired });
    arrival(host.s, []);
    assert.equal(host.s.last('room:state')!.me.participantId, host.id);
    assert.equal(typeof host.s.last('room:state')!.resumeToken, 'string');
    assert.deepEqual(host.s.inbox.map(message => message.type), ['hello', 'room:created', 'rtc:config', 'room:state', 'speaking', 'ok']);
    assert.equal(h.mixers.get(host.roomId)!.sourceCount, 0);
    assert.equal(liveTimers(h).length, 0, 'speaking snapshot creates no timer');
  });
}

test('actual mixer stable speech reaches a late join once, without new peer speaking fanout or timers', async t => {
  const h = setup(t), host = await h.create();
  await publish(h, host.s);
  const prior = await h.join(host.roomId, host.code, 'Prior');
  const mixer = h.mixers.get(host.roomId)!;
  const changes: string[][] = []; mixer.onSpeaking(ids => changes.push([...ids]));
  active(h, host.roomId, [host.id]);
  assert.deepEqual(changes, [[host.id]]);
  const timer = liveTimers(h)[0]!;
  const hostToken = host.s.last('room:state')!.resumeToken!, priorToken = prior.s.last('room:state')!.resumeToken!;
  host.s.clear(); prior.s.clear();
  const late = await h.join(host.roomId, host.code, 'Late');
  arrival(late.s, [host.id]);
  assert.deepEqual(host.s.inbox, []); assert.deepEqual(prior.s.inbox, []);
  assert.deepEqual(liveTimers(h), [timer], 'arrival reuses existing presence timer without scheduling speaking work');
  const state = late.s.last('room:state')!;
  assert.equal('code' in state, false); assert.equal('audience' in state, false);
  assert.notEqual(state.resumeToken, priorToken);
  for (const token of [hostToken, priorToken]) assert.equal(JSON.stringify(late.s.inbox).includes(token), false);
  for (const person of [state.me, ...state.speakers, ...state.hands]) assert.equal('resumeToken' in person, false);
  for (let i = 0; i < 25; i++) active(h, host.roomId, [host.id]);
  assert.deepEqual(changes, [[host.id]], 'stable PCM has no additional mixer transition');
  assert.equal(late.s.all('speaking').length, 1);
  assert.equal(host.s.all('speaking').length, 0); assert.equal(prior.s.all('speaking').length, 0);
});

test('zero presence delay preserves immediate state fanout and sends speaking only to the new reader before ACK', async t => {
  const h = setup(t, undefined, config => { config.rooms.presenceBroadcastMs = 0; });
  const host = await h.create(); await publish(h, host.s); active(h, host.roomId, [host.id]);
  host.s.clear();
  const late = await h.join(host.roomId, host.code, 'Immediate');
  assert.deepEqual(late.s.inbox.map(message => message.type), ['hello', 'rtc:config', 'room:state', 'room:state', 'speaking', 'ok']);
  assert.deepEqual(late.s.all('speaking').map(message => message.participantIds), [[host.id]]);
  assert.deepEqual(host.s.inbox.map(message => message.type), ['room:state']);
  assert.equal(liveTimers(h).length, 0);
});

test('resume receives current full set and only its current session receives subsequent changes', async t => {
  const h = setup(t), host = await h.create();
  await publish(h, host.s);
  const listener = await h.join(host.roomId, host.code, 'Listener');
  const token = listener.s.last('room:state')!.resumeToken!;
  active(h, host.roomId, [host.id]);
  await h.hub.detach(listener.s);
  const speaker = await stageSpeaker(h, host);
  active(h, host.roomId, [host.id, speaker.id]);
  assert.equal(await h.req(host.s, { type: 'mic:mute' }), 'ok');
  const staleCount = listener.s.inbox.length;
  const peerSpeakingCounts = [host.s, speaker.s].map(session => session.all('speaking').length);
  const back = await resume(h, host.roomId, host.code, token);
  arrival(back, [speaker.id]);
  assert.deepEqual([host.s, speaker.s].map(session => session.all('speaking').length), peerSpeakingCounts, 'resume sends no speaking frame to existing peers');
  assert.equal(back.last('room:state')!.me.participantId, listener.id);
  assert.equal(back.last('room:state')!.resumeToken, token);
  assert.equal(back.last('room:state')!.me.connected, true);
  assert.equal(back.last('room:state')!.speakers.find(person => person.participantId === host.id)!.muted, true);
  assert.equal(listener.s.inbox.length, staleCount);
  await h.hub.detach(listener.s);
  listener.s.clear(); back.clear();
  assert.equal(await h.req(listener.s, { type: 'mic:mute' }), 'not_joined');
  assert.deepEqual(listener.s.inbox.map(message => message.type), ['error']);
  assert.equal(h.hub.isJoined(back), true, 'retired detach cannot steal current binding');
  assert.equal(await h.req(speaker.s, { type: 'mic:mute' }), 'ok');
  assert.deepEqual(back.last('speaking')?.participantIds, []);
  assert.equal(listener.s.all('speaking').length, 0);
});

test('controller resume preserves its private state and the audible publisher held during its control-socket outage', async t => {
  const h = setup(t), host = await h.create(), audience = await h.join(host.roomId, host.code, 'Audience');
  const token = host.s.last('room:state')!.resumeToken!;
  await publish(h, host.s); active(h, host.roomId, [host.id]);
  await h.hub.detach(host.s); active(h, host.roomId, [host.id]);
  const count = audience.s.all('speaking').length;
  const back = await resume(h, host.roomId, host.code, token);
  arrival(back, [host.id]);
  assert.equal(back.last('room:state')!.me.participantId, host.id);
  assert.equal(back.last('room:state')!.me.role, 'controller');
  assert.equal(back.last('room:state')!.code, host.code);
  assert.equal(back.last('room:state')!.resumeToken, token);
  assert.deepEqual(back.last('room:state')!.audience?.map(person => person.participantId), [audience.id]);
  assert.equal(audience.s.all('speaking').length, count);
  assert.equal(JSON.stringify(audience.s.inbox).includes(token), false);
  assert.equal(liveTimers(h).some(timer => timer.ms === 60000), false, 'resuming clears the controller grace timer');
});

test('disconnected retained publishers stay audible in snapshots until grace expiry removes their source', async t => {
  const h = setup(t), host = await h.create(), speaker = await stageSpeaker(h, host);
  active(h, host.roomId, [speaker.id]);
  await h.hub.detach(speaker.s);
  active(h, host.roomId, [speaker.id]);
  const late = await h.join(host.roomId, host.code, 'During grace');
  arrival(late.s, [speaker.id]);
  assert.equal(late.s.last('room:state')!.speakers.find(person => person.participantId === speaker.id)!.connected, false);
  const timer = liveTimers(h).find(timer => timer.ms === 15000)!; assert.ok(timer);
  timer.cleared = true; timer.fn(); await flush();
  assert.deepEqual(late.s.last('speaking')?.participantIds, []);
  const after = await h.join(host.roomId, host.code, 'After grace');
  arrival(after.s, []);
  assert.equal(h.transport.emitUplink(host.roomId, speaker.id, sine(960, 0.5)), false);
});

for (const operation of ['mute', 'force-mute', 'stage:remove', 'stage:leave', 'participant:kick', 'peer-close', 'recvonly'] as const) {
  test(`${operation} updates the actual mixer cache before the next join`, async t => {
    const h = setup(t), host = await h.create(), speaker = await stageSpeaker(h, host);
    await publish(h, host.s);
    active(h, host.roomId, [host.id, speaker.id]);
    host.s.clear(); speaker.s.clear();
    if (operation === 'mute') assert.equal(await h.req(speaker.s, { type: 'mic:mute' }), 'ok');
    else if (operation === 'force-mute') assert.equal(await h.req(host.s, { type: 'mic:force-mute', targetId: speaker.id }), 'ok');
    else if (operation === 'stage:leave') assert.equal(await h.req(speaker.s, { type: 'stage:leave' }), 'ok');
    else if (operation === 'peer-close') { h.hub.onPeerClosed(host.roomId, speaker.id); await flush(); }
    else if (operation === 'recvonly') assert.equal(await h.req(speaker.s, { type: 'rtc:offer', payload: RECVONLY_OFFER }), 'ok');
    else assert.equal(await h.req(host.s, { type: operation, targetId: speaker.id }), 'ok');
    assert.deepEqual(host.s.last('speaking')?.participantIds, [host.id], 'existing transition broadcast retains remaining active speakers');
    const late = await h.join(host.roomId, host.code, 'Late');
    arrival(late.s, [host.id]);
    if (operation === 'participant:kick') assert.equal(speaker.s.closed?.code, 4001);
  });
}

for (const boundary of ['mute', 'force-mute', 'unpublish'] as const) {
  test(`${boundary} recovery does not resurrect stale speaking before new PCM`, async t => {
    const h = setup(t), host = await h.create();
    await publish(h, host.s); active(h, host.roomId, [host.id]);
    if (boundary === 'unpublish') {
      assert.equal(await h.req(host.s, { type: 'rtc:offer', payload: RECVONLY_OFFER }), 'ok');
      await publish(h, host.s);
    } else {
      const type = boundary === 'mute' ? 'mic:mute' : 'mic:force-mute';
      const inverse = boundary === 'mute' ? 'mic:unmute' : 'mic:force-unmute';
      assert.equal(await h.req(host.s, type === 'mic:mute' ? { type } : { type, targetId: host.id }), 'ok');
      assert.equal(await h.req(host.s, inverse === 'mic:unmute' ? { type: inverse } : { type: inverse, targetId: host.id }), 'ok');
    }
    const silent = await h.join(host.roomId, host.code, 'Before PCM'); arrival(silent.s, []);
    active(h, host.roomId, [host.id]);
    const activeJoin = await h.join(host.roomId, host.code, 'After PCM'); arrival(activeJoin.s, [host.id]);
  });
}

test('snapshot filters stale callback IDs through current room membership, stage, mute and publisher policy', async t => {
  const callbacks = captureSpeaking(t), h = setup(t), host = await h.create();
  await publish(h, host.s);
  const audience = await h.join(host.roomId, host.code, 'Audience');
  const approved = await h.join(host.roomId, host.code, 'Approved but not publishing');
  assert.equal(await h.req(approved.s, { type: 'hand:raise' }), 'ok');
  assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: approved.id }), 'ok');
  const muted = await stageSpeaker(h, host, 'Muted');
  assert.equal(await h.req(muted.s, { type: 'mic:mute' }), 'ok');
  const forced = await stageSpeaker(h, host, 'Forced');
  assert.equal(await h.req(host.s, { type: 'mic:force-mute', targetId: forced.id }), 'ok');
  const removed = await stageSpeaker(h, host, 'Removed');
  assert.equal(await h.req(host.s, { type: 'stage:remove', targetId: removed.id }), 'ok');
  const kicked = await stageSpeaker(h, host, 'Kicked');
  assert.equal(await h.req(host.s, { type: 'participant:kick', targetId: kicked.id }), 'ok');
  const elsewhere = await h.create('Elsewhere'); await publish(h, elsewhere.s);
  callbacks.get(h.mixers.get(host.roomId)!)!([host.id, audience.id, approved.id, muted.id, forced.id, removed.id, kicked.id, elsewhere.id, 'missing']);
  const late = await h.join(host.roomId, host.code, 'Filtered'); arrival(late.s, [host.id]);
});

test('copied callback input and targeted output arrays cannot corrupt later snapshots', async t => {
  const callbacks = captureSpeaking(t), h = setup(t), host = await h.create();
  await publish(h, host.s);
  const ids = [host.id];
  callbacks.get(h.mixers.get(host.roomId)!)!(ids);
  ids.splice(0, 1, 'mutated-input');
  const first = await h.join(host.roomId, host.code, 'First'); arrival(first.s, [host.id]);
  first.s.last('speaking')!.participantIds.splice(0, 1, 'mutated-output');
  const second = await h.join(host.roomId, host.code, 'Second'); arrival(second.s, [host.id]);
  assert.notEqual(second.s.last('speaking')!.participantIds, first.s.last('speaking')!.participantIds);
});

test('rooms keep independent current sets and callbacks from a closed mixer cannot revive or leak its state', async t => {
  const callbacks = captureSpeaking(t), h = setup(t), first = await h.create('First'), second = await h.create('Second');
  await publish(h, first.s); await publish(h, second.s);
  active(h, first.roomId, [first.id]);
  const secondJoin = await h.join(second.roomId, second.code, 'Silent room'); arrival(secondJoin.s, []);
  active(h, second.roomId, [second.id]);
  const firstJoin = await h.join(first.roomId, first.code, 'Active room'); arrival(firstJoin.s, [first.id]);
  const oldMixer = h.mixers.get(first.roomId)!;
  assert.equal(await h.req(first.s, { type: 'room:close' }), 'ok');
  const closedLength = first.s.inbox.length, survivingLength = second.s.inbox.length;
  callbacks.get(oldMixer)!([first.id]);
  assert.equal(first.s.inbox.length, closedLength); assert.equal(second.s.inbox.length, survivingLength);
  const third = await h.create('New room'); arrival(third.s, []);
  const surviving = await h.join(second.roomId, second.code, 'Still active'); arrival(surviving.s, [second.id]);
  const rejected = new FakeSession(); h.hub.attach(rejected); rejected.clear();
  assert.equal(await h.req(rejected, { type: 'join', roomId: first.roomId, code: first.code, name: 'Closed' }), 'unauthorized');
  assert.deepEqual(rejected.inbox.map(message => message.type), ['error']);
});

test('rejected joins expose no state, speaking IDs or resume credentials', async t => {
  const h = setup(t), host = await h.create(); await publish(h, host.s); active(h, host.roomId, [host.id]);
  const outsider = new FakeSession(); h.hub.attach(outsider); outsider.clear();
  host.s.clear();
  assert.equal(await h.req(outsider, { type: 'join', roomId: host.roomId, code: 'wrong', name: 'Outsider' }), 'unauthorized');
  assert.deepEqual(outsider.inbox.map(message => message.type), ['error']);
  assert.equal(JSON.stringify(outsider.inbox).includes(host.id), false);
  assert.equal(host.s.inbox.length, 0);
  assert.equal(await h.req(host.s, { type: 'join', roomId: host.roomId, code: host.code, name: 'Duplicate' }), 'already_joined');
  assert.deepEqual(host.s.inbox.map(message => message.type), ['error']);
});

test('full and unknown rooms reject joins without a speaking baseline', async t => {
  const h = setup(t, undefined, config => { config.limits.maxAudiencePerRoom = 1; });
  const host = await h.create(); await publish(h, host.s); active(h, host.roomId, [host.id]);
  const admitted = await h.join(host.roomId, host.code, 'Last seat');
  host.s.clear(); admitted.s.clear();
  for (const roomId of [host.roomId, 'unknown-room']) {
    const outsider = new FakeSession(); h.hub.attach(outsider); outsider.clear();
    assert.equal(await h.req(outsider, { type: 'join', roomId, code: host.code, name: 'Outsider' }), roomId === host.roomId ? 'room_full' : 'unauthorized');
    assert.deepEqual(outsider.inbox.map(message => message.type), ['error']);
    assert.equal(h.hub.isJoined(outsider), false);
  }
  assert.equal(host.s.inbox.length, 0); assert.equal(admitted.s.inbox.length, 0);
});

// Real Hub + RoomMixer + public SDK through a serialized in-memory socket bridge.
// PCM is real; browser PeerConnection/audio and MediaTransport are fake, with no network or listening claim.
class Peer {
  connectionState = 'connected'; signalingState = 'stable';
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  readonly transceiver = { direction: 'recvonly', sender: { track: null as MediaStreamTrack | null,
    replaceTrack: async (track: MediaStreamTrack | null) => { this.transceiver.sender.track = track; } } };
  addTransceiver() { return this.transceiver; }
  async createOffer() { return { type: 'offer' as const, sdp: `v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${this.transceiver.direction}\r\n` }; }
  async setLocalDescription(value: RTCSessionDescriptionInit) { this.localDescription = value; }
  async setRemoteDescription(value: RTCSessionDescriptionInit) { this.remoteDescription = value; }
  async addIceCandidate() {}
  close() { this.connectionState = 'closed'; }
}

function sdkBridge(t: TestContext) {
  const clients: StageClient[] = [], sockets: Socket[] = [], errors: StageError[] = [];
  const originals = new Map(['window', 'WebSocket', 'RTCPeerConnection'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const h = setup(t, async () => {
    try {
      for (const client of clients) await client.disconnect();
      await Promise.all(sockets.map(socket => socket.chain));
      await flush();
      for (const client of clients) {
        assert.equal(client.status, 'disconnected');
        assert.deepEqual([...client.speaking], []);
      }
      for (const socket of sockets) {
        assert.equal(socket.readyState, 3);
        assert.equal(h.hub.isJoined(socket.session), false);
      }
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
    assert.deepEqual(errors, [], 'bridge must not hide SDK signaling, request or reconnect errors');
  });
  class Socket {
    static OPEN = 1;
    readyState = 1;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    chain: Promise<void> = Promise.resolve();
    readonly session = new FakeSession();
    readonly sent: ClientMessage[] = [];
    readonly trace: string[] = [];
    constructor() {
      sockets.push(this);
      const record = this.session.send.bind(this.session);
      this.session.send = (message: ServerMessage, encoded?: string) => {
        record(message, encoded);
        if (this.readyState !== Socket.OPEN) return;
        this.trace.push(`wire:${message.type}`);
        this.onmessage?.({ data: encoded ?? JSON.stringify(message) });
      };
      queueMicrotask(() => h.hub.attach(this.session));
    }
    send(data: string) {
      const message = JSON.parse(data) as ClientMessage; this.sent.push(message);
      this.chain = this.chain.then(() => h.hub.handle(this.session, message));
    }
    close(code = 1006) {
      if (this.readyState !== Socket.OPEN) return;
      this.readyState = 3;
      this.chain = this.chain.then(() => h.hub.detach(this.session, code === 1000)).then(() => this.onclose?.());
    }
  }
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, value: Peer });
  let now = 1000;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  async function tick(ms: number) { await flush(); now += ms; t.mock.timers.tick(ms); await flush(); }
  async function until(condition: () => boolean) {
    for (let i = 0; i < 100 && !condition(); i++) await tick(20);
    assert.ok(condition(), 'bridge condition did not settle within bounded fake time');
  }
  function make() {
    const client = new StageClient({ url: 'ws://in-memory.invalid/', requestTimeoutMs: 5000,
      reconnect: { initialDelayMs: 50, maxDelayMs: 50 }, audioElement: { pause() {} } as unknown as HTMLAudioElement });
    clients.push(client); client.on('error', event => errors.push(event.detail));
    const trace: string[] = [];
    client.on('state', () => trace.push('state'));
    client.on('speaking', () => trace.push('speaking'));
    return { client, trace };
  }
  async function join(viewer: ReturnType<typeof make>, room: Awaited<ReturnType<Harness['create']>>, name: string) {
    let done = false;
    const pending = viewer.client.join({ roomId: room.roomId, code: room.code, name });
    void pending.then(() => { viewer.trace.push('promise'); done = true; }, () => { done = true; });
    const socket = sockets.at(-1)!;
    await until(() => done); await pending;
    await until(() => socket.sent.some(message => message.type === 'rtc:offer') && socket.session.all('rtc:answer').length === 1);
    await tick(0);
    return socket;
  }
  return { h, sockets, make, join, until, tick };
}

test('public SDK late join observes stable speaking before its promise resolves and does not need another PCM transition', async t => {
  const f = sdkBridge(t), host = await f.h.create('Publisher'); await publish(f.h, host.s);
  const prior = f.make(); await f.join(prior, host, 'Prior');
  active(f.h, host.roomId, [host.id]); assert.deepEqual([...prior.client.speaking], [host.id]);
  const mixer = f.h.mixers.get(host.roomId)!, changes: string[][] = [];
  mixer.onSpeaking(ids => changes.push([...ids]));
  const late = f.make(), socket = await f.join(late, host, 'Late');
  assert.deepEqual(late.trace, ['state', 'speaking', 'promise']);
  assert.deepEqual([...late.client.speaking], [host.id]);
  assert.deepEqual(socket.session.all('speaking').map(message => message.participantIds), [[host.id]]);
  assert.deepEqual(socket.session.inbox.slice(0, 5).map(message => message.type), ['hello', 'rtc:config', 'room:state', 'speaking', 'ok']);
  const state = late.client.state!;
  assert.equal('code' in state, false); assert.equal('audience' in state, false);
  assert.notEqual(state.resumeToken, prior.client.state!.resumeToken);
  assert.equal(JSON.stringify(state).includes(host.s.last('room:state')!.resumeToken!), false);
  for (let i = 0; i < 25; i++) active(f.h, host.roomId, [host.id]);
  assert.deepEqual(changes, []); assert.equal(socket.session.all('speaking').length, 1);
  const frame = f.h.transport.rooms.get(host.roomId)!.peers.get(late.client.me!.participantId)!.received.at(-1)!;
  assert.ok(frame.reduce((sum, value) => sum + value * value, 0) / frame.length > 0.05, 'mock subscriber received actual nonzero mixed PCM');
});

for (const silent of [false, true]) {
  test(`public SDK automatic same-seat resume replaces its speaking set with ${silent ? 'empty after missed silence' : 'current active speakers'}`, async t => {
    const f = sdkBridge(t), host = await f.h.create('Publisher'); await publish(f.h, host.s);
    const viewer = f.make(), old = await f.join(viewer, host, 'Listener');
    active(f.h, host.roomId, [host.id]);
    const id = viewer.client.me!.participantId, token = viewer.client.state!.resumeToken;
    assert.deepEqual([...viewer.client.speaking], [host.id]);
    old.close(); await old.chain; await flush();
    assert.equal(viewer.client.status, 'reconnecting');
    if (silent) { f.h.mixers.get(host.roomId)!.tick(); f.h.mixers.get(host.roomId)!.tick(); }
    const oldFrames = old.session.inbox.length;
    viewer.trace.length = 0;
    await f.until(() => f.sockets.length === 2 && viewer.client.status === 'live');
    const back = f.sockets.at(-1)!; await back.chain; await flush();
    assert.notEqual(back, old);
    assert.equal(viewer.client.me!.participantId, id); assert.equal(viewer.client.state!.resumeToken, token);
    assert.deepEqual([...viewer.client.speaking], silent ? [] : [host.id]);
    assert.deepEqual(viewer.trace, ['state', 'speaking']);
    arrival(back.session, silent ? [] : [host.id]);
    const join = back.sent.find(message => message.type === 'join'); assert.ok(join?.type === 'join');
    assert.equal(join.resumeToken, token);
    for (let i = 0; i < 25; i++) {
      if (silent) f.h.mixers.get(host.roomId)!.tick(); else active(f.h, host.roomId, [host.id]);
    }
    assert.equal(back.session.all('speaking').length, 1, 'stable state needs no periodic speaking resend');
    assert.equal(old.session.inbox.length, oldFrames, 'retired session stays retired');
  });
}
