import assert from 'node:assert/strict';
import { it, type TestContext } from 'node:test';
import type { ClientMessage, SessionDescriptionPayload } from '../shared/protocol.ts';
import { createLogger } from '../src/log.ts';
import { RoomMixer } from '../src/mixer/RoomMixer.ts';
import { ERROR_MESSAGES } from '../src/model/errors.ts';
import { MockMediaTransport } from '../src/transport/MockMediaTransport.ts';
import { StageHub } from '../src/ws/hub.ts';
import { FakeSession, RECVONLY_OFFER, SENDRECV_OFFER, sine, testConfig } from './helpers.ts';

const PRIVATE_DETAIL = 'synthetic private signaling failure';
const SECRET = 'synthetic-signaling-secret';
type Request = ClientMessage extends infer M ? M extends ClientMessage ? Omit<M, 'requestId'> : never : never;

interface Failure {
  value: unknown;
  verify(logged: unknown): void;
}

const failures: { name: string; make(): Failure }[] = [
  {
    name: 'an Error',
    make() {
      const value = new Error(PRIVATE_DETAIL, { cause: { token: SECRET, retryable: true } });
      return { value, verify(logged) {
        const diagnostic = logged as Record<string, unknown>;
        assert.equal(diagnostic.name, 'Error');
        assert.equal(diagnostic.message, PRIVATE_DETAIL);
        assert.deepEqual(diagnostic.cause, { token: '[redacted]', retryable: true });
      } };
    },
  },
  {
    name: 'a string',
    make: () => ({ value: PRIVATE_DETAIL, verify: logged => assert.equal(logged, PRIVATE_DETAIL) }),
  },
  {
    name: 'a null-prototype object',
    make() {
      const value: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      value.detail = PRIVATE_DETAIL;
      value.secret = SECRET;
      return { value, verify: logged => assert.deepEqual(logged, { detail: PRIVATE_DETAIL, secret: '[redacted]' }) };
    },
  },
  {
    name: 'throwing coercion and accessor hooks',
    make() {
      let calls = 0;
      const unexpected = () => { calls++; throw new Error('diagnostic hook must not run'); };
      const value = { [Symbol.toPrimitive]: unexpected, toString: unexpected, toJSON: unexpected, secret: SECRET };
      Object.defineProperty(value, 'detail', { enumerable: true, get: unexpected });
      return { value, verify(logged) {
        assert.equal(calls, 0);
        assert.deepEqual(logged, { toString: '[Function]', toJSON: '[Function]', secret: '[redacted]', detail: '[Accessor]' });
      } };
    },
  },
  {
    name: 'a throwing proxy',
    make() {
      let calls = 0;
      const unexpected = () => { calls++; throw new Error('proxy trap must not run'); };
      const value = new Proxy({}, { get: unexpected, ownKeys: unexpected, getOwnPropertyDescriptor: unexpected, getPrototypeOf: unexpected });
      return { value, verify(logged) { assert.equal(calls, 0); assert.equal(logged, '[Proxy]'); } };
    },
  },
  {
    name: 'a revoked proxy',
    make() {
      const { proxy: value, revoke } = Proxy.revocable({}, {});
      revoke();
      return { value, verify: logged => assert.equal(logged, '[Proxy]') };
    },
  },
];

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('signaling test did not settle')), 3000); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function setup(t: TestContext) {
  const config = testConfig();
  const lines: string[] = [];
  const mixers = new Map<string, RoomMixer>();
  const transport = new MockMediaTransport({ onLocalCandidate: (roomId, id, candidate) => hub.onLocalCandidate(roomId, id, candidate) });
  const hub = new StageHub({
    config, transport, log: createLogger('debug', line => lines.push(line)), serverVersion: 'test',
    now: () => 1_000_000,
    setTimer: () => ({}), clearTimer: () => {},
    createMixer(roomId) {
      const mixer = new RoomMixer({ sampleRate: config.audio.sampleRate, frameMs: config.audio.frameMs, maxBufferedFrames: 10, playoutFrames: 1, limiterThreshold: 0.9, speakingThreshold: 0.02, speakingHoldMs: 40 });
      mixers.set(roomId, mixer);
      return mixer;
    },
  });
  const pending: Promise<unknown>[] = [];
  const releases: (() => void)[] = [];
  t.after(async () => {
    for (const release of releases) release();
    await bounded(Promise.allSettled(pending));
    await bounded(hub.shutdown());
  });
  let seq = 0;
  const request = async (session: FakeSession, message: Request) => {
    const requestId = `signaling-${seq++}`;
    await hub.handle(session, { ...message, requestId } as ClientMessage);
    const reply = session.inbox.find(m => (m.type === 'ok' || m.type === 'error') && m.requestId === requestId);
    return reply?.type === 'error' ? reply.code : reply?.type === 'ok' ? 'ok' : 'no-reply';
  };
  const host = new FakeSession();
  hub.attach(host);
  assert.equal(await request(host, { type: 'room:create', name: 'Host', roomName: 'Room' }), 'ok');
  const state = host.last('room:state')!;
  const roomId = host.last('room:created')!.roomId, hostId = state.me.participantId, code = state.code!, resumeToken = state.resumeToken!;
  const join = async (name: string, token?: string) => {
    const session = new FakeSession();
    hub.attach(session);
    assert.equal(await request(session, { type: 'join', roomId, code, name, ...(token === undefined ? {} : { resumeToken: token }) }), 'ok');
    return { session, id: session.last('room:state')!.me.participantId };
  };
  const speaker = await join('Speaker'), listener = await join('Listener');
  const offer = (session: FakeSession, payload: SessionDescriptionPayload = SENDRECV_OFFER) => request(session, { type: 'rtc:offer', payload });
  assert.equal(await request(speaker.session, { type: 'hand:raise' }), 'ok');
  assert.equal(await request(host, { type: 'stage:approve', targetId: speaker.id }), 'ok');
  assert.equal(await offer(speaker.session), 'ok');
  assert.equal(await offer(listener.session, RECVONLY_OFFER), 'ok');
  const room = transport.rooms.get(roomId)!;
  const mixer = mixers.get(roomId)!;
  const speakerPeer = room.peers.get(speaker.id)!;
  const speakerPublisher = room.publishers.get(speaker.id)!;
  const listenerPeer = room.peers.get(listener.id)!;
  const peerCloses: string[] = [], roomCloses: string[] = [];
  const closePeer = transport.closePeer.bind(transport), closeRoom = transport.closeRoom.bind(transport);
  transport.closePeer = (id, participantId) => { peerCloses.push(participantId); closePeer(id, participantId); };
  transport.closeRoom = id => { roomCloses.push(id); closeRoom(id); };
  const media = () => ({ peer: room.peers.get(hostId), publisher: room.publishers.get(hostId) });
  const assertUnrelated = (publishers: number) => {
    assert.equal(hub.roomCount, 1);
    assert.equal(transport.rooms.get(roomId), room);
    assert.equal(room.peers.get(speaker.id), speakerPeer);
    assert.equal(room.publishers.get(speaker.id), speakerPublisher);
    assert.equal(room.subscribers.has(speaker.id), true);
    assert.equal(room.peers.get(listener.id), listenerPeer);
    assert.equal(room.subscribers.has(listener.id), true);
    assert.equal(mixer.sourceCount, publishers);
    assert.equal(hub.metrics().find(sample => sample.name === 'stage_publishers')!.value, publishers);
    assert.deepEqual(roomCloses, []);
    for (const session of [speaker.session, listener.session]) {
      assert.equal(hub.isJoined(session), true);
      assert.equal(session.closed, undefined);
      assert.deepEqual(session.all('room:closed'), []);
    }
  };
  const assertClean = () => {
    assert.equal(room.peers.has(hostId), false);
    assert.equal(room.publishers.has(hostId), false);
    assert.equal(room.subscribers.has(hostId), false);
    assert.equal(transport.emitUplink(roomId, hostId, sine(960, 0.2)), false);
    assertUnrelated(1);
  };
  const assertLive = (expected: ReturnType<typeof media>) => {
    assert.ok(expected.peer);
    assert.ok(expected.publisher);
    assert.equal(room.peers.get(hostId), expected.peer);
    assert.equal(room.publishers.get(hostId), expected.publisher);
    assert.equal(room.subscribers.has(hostId), true);
    assertUnrelated(2);
  };
  const assertAudio = (participantId = speaker.id) => {
    assert.equal(transport.emitUplink(roomId, participantId, sine(960, 0.2)), true);
    mixer.tick();
    assert.ok(listenerPeer.received.at(-1)!.some(sample => Math.abs(sample) > 0.01));
  };
  const assertFailure = (session: FakeSession, failure: Failure, operation: 'offer' | 'ice') => {
    const error = session.last('error')!;
    assert.equal(error.code, 'bad_request');
    assert.equal(error.message, ERROR_MESSAGES.bad_request);
    assert.deepEqual(Object.keys(error).sort(), ['code', 'message', 'requestId', 'type']);
    const msg = operation === 'offer' ? 'negotiation failed' : 'remote candidate rejected';
    const logs = lines.map(line => JSON.parse(line) as Record<string, unknown>).filter(entry => entry.msg === msg);
    assert.equal(logs.length, 1);
    assert.equal(logs[0]!.level, operation === 'offer' ? 'warn' : 'debug');
    failure.verify(logs[0]!.error);
    assert.ok(lines.every(line => !line.includes(SECRET)));
    for (const client of [host, speaker.session, listener.session, session]) {
      const received = JSON.stringify(client.inbox);
      assert.equal(received.includes(PRIVATE_DETAIL), false);
      assert.equal(received.includes(SECRET), false);
      assert.equal(client.closed, undefined);
      assert.deepEqual(client.all('room:closed'), []);
    }
  };
  const resume = async () => {
    const replacement = await join('Host', resumeToken);
    assert.equal(replacement.id, hostId);
    return replacement.session;
  };
  return { hub, transport, request, offer, host, hostId, roomId, room, speaker, listener, media, peerCloses, pending, releases, assertUnrelated, assertClean, assertLive, assertAudio, assertFailure, resume };
}

for (const mode of ['sync throw', 'async rejection'] as const) {
  for (const example of failures) {
    it(`isolates an offer ${mode} with ${example.name} and cleans only its partial peer`, async t => {
      const f = await setup(t), failure = example.make();
      const original = f.transport.negotiate.bind(f.transport);
      f.transport.negotiate = (...args) => {
        const applied = original(...args);
        if (mode === 'async rejection') return applied.then(() => { throw failure.value; });
        throw failure.value;
      };
      const speakerInbox = [...f.speaker.session.inbox], listenerInbox = [...f.listener.session.inbox];
      assert.equal(await bounded(f.offer(f.host)), 'bad_request');
      f.assertFailure(f.host, failure, 'offer');
      f.assertClean();
      assert.deepEqual(f.peerCloses, [f.hostId]);
      assert.deepEqual(f.speaker.session.inbox, speakerInbox);
      assert.deepEqual(f.listener.session.inbox, listenerInbox);
      assert.equal(f.hub.isJoined(f.host), true);
      assert.deepEqual(f.host.all('rtc:answer'), []);
      f.assertAudio();
      f.transport.negotiate = original;
      assert.equal(await bounded(f.offer(f.host)), 'ok');
      f.assertLive(f.media());
      f.assertAudio(f.hostId);
    });

    it(`isolates an ICE ${mode} with ${example.name} without removing established media`, async t => {
      const f = await setup(t), failure = example.make();
      assert.equal(await f.offer(f.host), 'ok');
      const expected = f.media();
      const original = f.transport.addRemoteCandidate.bind(f.transport);
      f.transport.addRemoteCandidate = (...args) => {
        const applied = original(...args);
        if (mode === 'async rejection') return applied.then(() => { throw failure.value; });
        throw failure.value;
      };
      const speakerInbox = [...f.speaker.session.inbox], listenerInbox = [...f.listener.session.inbox];
      const candidate = { candidate: 'candidate:synthetic 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 };
      assert.equal(await bounded(f.request(f.host, { type: 'rtc:ice', payload: candidate })), 'bad_request');
      f.assertFailure(f.host, failure, 'ice');
      f.assertLive(expected);
      assert.deepEqual(f.peerCloses, []);
      assert.deepEqual(f.speaker.session.inbox, speakerInbox);
      assert.deepEqual(f.listener.session.inbox, listenerInbox);
      assert.equal(f.hub.isJoined(f.host), true);
      f.assertAudio(f.hostId);
      f.transport.addRemoteCandidate = original;
      assert.equal(await bounded(f.request(f.host, { type: 'rtc:ice', payload: null })), 'ok');
      assert.deepEqual(expected.peer!.candidates, [candidate, null]);
      assert.equal(await f.request(f.host, { type: 'mic:mute' }), 'ok');
      assert.equal(await f.request(f.host, { type: 'mic:unmute' }), 'ok');
      f.assertLive(expected);
    });
  }
}

for (const newerOffer of [false, true]) {
  for (const example of failures) {
    it(`${newerOffer ? 'preserves a newer offer' : 'cleans the latest accepted offer'} after resume when an old offer rejects with ${example.name}`, async t => {
      const f = await setup(t), failure = example.make();
      assert.equal(await f.offer(f.host), 'ok');
      const original = f.transport.negotiate.bind(f.transport);
      const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
      f.releases.push(release.resolve);
      let hold = true;
      f.transport.negotiate = async (...args) => {
        const answer = await original(...args);
        if (hold) {
          hold = false;
          entered.resolve();
          await release.promise;
          throw failure.value;
        }
        return answer;
      };
      const pending = f.offer(f.host);
      f.pending.push(pending);
      await bounded(entered.promise);
      await f.hub.detach(f.host);
      const current = await f.resume();
      if (newerOffer) assert.equal(await f.offer(current), 'ok');
      const expected = f.media();
      const currentInbox = [...current.inbox], speakerInbox = [...f.speaker.session.inbox], listenerInbox = [...f.listener.session.inbox];
      release.resolve();
      assert.equal(await bounded(pending), 'bad_request');
      f.assertFailure(f.host, failure, 'offer');
      if (newerOffer) {
        f.assertLive(expected);
        assert.deepEqual(f.peerCloses, []);
      } else {
        f.assertClean();
        assert.deepEqual(f.peerCloses, [f.hostId]);
      }
      // Cleanup may change media, but it must not reply or broadcast through the resumed binding.
      assert.deepEqual(current.inbox, currentInbox);
      assert.deepEqual(f.speaker.session.inbox, speakerInbox);
      assert.deepEqual(f.listener.session.inbox, listenerInbox);
      assert.equal(f.hub.isJoined(current), true);
      assert.equal(current.closed, undefined);
      assert.equal(await f.offer(current), 'ok');
      f.assertLive(f.media());
      assert.equal(await f.request(current, { type: 'mic:mute' }), 'ok');
      assert.equal(await f.request(current, { type: 'mic:unmute' }), 'ok');
      f.assertAudio(f.hostId);
    });
  }
}
