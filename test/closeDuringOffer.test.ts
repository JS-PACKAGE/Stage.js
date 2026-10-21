import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import type { AppConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { createStageServer } from '../src/ws/server.ts';
import type { SerialQueue } from '../src/ws/serialQueue.ts';
import type { WsSession } from '../src/ws/session.ts';
import { harness, RECVONLY_OFFER, SENDRECV_OFFER, sine, testConfig } from './helpers.ts';

type Request = Exclude<ClientMessage, { type: 'ping' }>;
type State = Extract<ServerMessage, { type: 'room:state' }>;

async function bounded<T>(promise: Promise<T>, phase: string, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${phase}`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

class Client {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;
  readonly events = new EventEmitter();

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.closed = new Promise(resolve => this.ws.once('close', code => { resolve(code); this.events.emit('change'); }));
    this.ws.on('message', data => { this.inbox.push(JSON.parse(data.toString()) as ServerMessage); this.events.emit('change'); });
  }

  send(message: ClientMessage): void { this.ws.send(JSON.stringify(message)); }

  async waitFor(predicate: (message: ServerMessage) => boolean, phase: string): Promise<ServerMessage> {
    const found = this.inbox.find(predicate);
    if (found) return found;
    let check = () => {};
    try {
      return await bounded(new Promise<ServerMessage>((resolve, reject) => {
        check = () => {
          const message = this.inbox.find(predicate);
          if (message) resolve(message);
          else if (this.ws.readyState === WebSocket.CLOSED) reject(new Error(`socket closed: ${phase}`));
        };
        this.events.on('change', check);
        check();
      }), phase);
    } finally { this.events.off('change', check); }
  }

  async ok(message: Request): Promise<void> {
    this.send(message);
    const reply = await this.waitFor(m => (m.type === 'ok' || m.type === 'error') && m.requestId === message.requestId, message.requestId);
    assert.equal(reply.type, 'ok', JSON.stringify(reply));
  }

  state(): State {
    const state = this.inbox.findLast(message => message.type === 'room:state');
    assert.ok(state?.type === 'room:state');
    return state;
  }
}

async function setup(t: TestContext, patch?: (config: AppConfig) => void) {
  const config = testConfig(c => {
    c.server.port = 0;
    c.rooms.presenceBroadcastMs = 0;
    c.limits.controlPerSecond = 100;
    patch?.(c);
  });
  const h = harness(config);
  const sessions: WsSession[] = [], clients: Client[] = [];
  const serverCloses = new Map<WsSession, Promise<number>>();
  const detachCounts = new Map<WsSession, number>();
  const finished = new Set<string>();
  const events = new EventEmitter();
  const releases: (() => void)[] = [];
  const active: Promise<void>[] = [];
  const errors: { message: string; fields?: Record<string, unknown> }[] = [];
  const attach = h.hub.attach.bind(h.hub), detach = h.hub.detach.bind(h.hub), handle = h.hub.handle.bind(h.hub);
  h.hub.attach = session => {
    const wsSession = session as WsSession;
    sessions.push(wsSession);
    serverCloses.set(wsSession, new Promise(resolve => wsSession.ws.once('close', resolve)));
    attach(session);
  };
  h.hub.detach = async (session, intentional) => {
    await detach(session, intentional);
    const wsSession = session as WsSession;
    detachCounts.set(wsSession, (detachCounts.get(wsSession) ?? 0) + 1);
    events.emit('change');
  };
  h.hub.handle = (session, message) => {
    const pending = handle(session, message).finally(() => {
      if (message.type !== 'ping') finished.add(message.requestId);
      events.emit('change');
    });
    active.push(pending);
    return pending;
  };
  const server = createStageServer({ config, hub: h.hub, log: { ...silentLogger, error: (message, fields) => { errors.push({ message, fields }); } }, baseDir: tmpdir() });
  t.after(async () => {
    for (const release of releases) release();
    try { await bounded(Promise.allSettled(active), 'active handlers during cleanup', 5000); }
    finally {
      for (const client of clients) client.ws.terminate();
      await bounded(server.close(), 'server cleanup', 5000);
    }
  });
  const { port } = await bounded(server.listen(), 'server listen');
  const connect = async () => {
    const index = sessions.length;
    const client = new Client(`ws://127.0.0.1:${port}${config.server.wsPath}`);
    clients.push(client);
    await bounded(client.opened, 'client open');
    await client.waitFor(message => message.type === 'hello', 'server hello');
    const session = sessions[index];
    assert.ok(session);
    return { client, session };
  };
  const until = async (predicate: () => boolean, phase: string) => {
    if (predicate()) return;
    let check = () => {};
    try {
      await bounded(new Promise<void>(resolve => {
        check = () => { if (predicate()) resolve(); };
        events.on('change', check);
        check();
      }), phase);
    } finally { events.off('change', check); }
  };
  const gate = () => {
    const held = Promise.withResolvers<void>();
    releases.push(held.resolve);
    return held;
  };
  const close = async (connection: Awaited<ReturnType<typeof connect>>, normal = false) => {
    if (normal) connection.client.ws.close(1000); else connection.client.ws.terminate();
    const codes = await bounded(Promise.all([connection.client.closed, serverCloses.get(connection.session)!]), 'both close events');
    assert.deepEqual(codes, [normal ? 1000 : 1006, normal ? 1000 : 1006]);
  };
  return { h, connect, close, gate, until, finished, detachCounts, errors, active };
}

for (const role of ['controller', 'speaker'] as const) {
  for (const outcome of ['success', 'failure'] as const) {
    it(`resumes a disconnected ${role} before its old offer finishes with ${outcome}`, { timeout: 15000 }, async t => {
      const f = await setup(t);
      const host = await f.connect();
      await host.client.ok({ type: 'room:create', requestId: 'create', name: 'Host' });
      const initial = host.client.state();
      const observer = await f.connect();
      await observer.client.ok({ type: 'join', requestId: 'observer', roomId: initial.roomId, code: initial.code, name: 'Observer' });
      await observer.client.ok({ type: 'rtc:offer', requestId: 'observer-offer', payload: RECVONLY_OFFER });
      const subject = role === 'controller' ? host : await f.connect();
      if (role === 'speaker') {
        await subject.client.ok({ type: 'join', requestId: 'speaker', roomId: initial.roomId, code: initial.code, name: 'Speaker' });
        await subject.client.ok({ type: 'hand:raise', requestId: 'hand' });
        await host.client.ok({ type: 'stage:approve', requestId: 'approve', targetId: subject.client.state().me.participantId });
      }
      await subject.client.ok({ type: 'rtc:offer', requestId: 'established', payload: SENDRECV_OFFER });
      const before = subject.client.state(), id = before.me.participantId;
      const room = f.h.transport.rooms.get(initial.roomId)!;
      const peer = room.peers.get(id), listenerPeer = room.peers.get(observer.client.state().me.participantId)!;
      assert.ok(peer);
      const entered = Promise.withResolvers<void>(), release = f.gate();
      const negotiate = f.h.transport.negotiate.bind(f.h.transport);
      let hold = true;
      f.h.transport.negotiate = async (...args) => {
        const answer = await negotiate(...args);
        if (args[1] === id && hold) {
          hold = false;
          entered.resolve();
          await release.promise;
          if (outcome === 'failure') throw new Error('held mock offer failed');
        }
        return answer;
      };
      // A stale recvonly success must not remove the replacement's publisher.
      subject.client.send({ type: 'rtc:offer', requestId: 'held', payload: RECVONLY_OFFER });
      await bounded(entered.promise, 'old offer entered transport');
      await f.close(subject);
      await observer.client.waitFor(message => message.type === 'room:state' && message.speakers.some(p => p.participantId === id && !p.connected), 'observer sees disconnection before old offer release');
      assert.equal(f.h.hub.isJoined(subject.session), false);
      assert.equal(f.finished.has('held'), false, 'the offer is still held at resume time');
      assert.equal(room.peers.get(id), peer, 'abnormal close retains the established peer');
      const current = await f.connect();
      await current.client.ok({ type: 'join', requestId: 'resume', roomId: initial.roomId, code: initial.code, name: 'Resumed', resumeToken: before.resumeToken });
      const resumed = current.client.state();
      assert.equal(resumed.me.participantId, id);
      assert.equal(resumed.me.role, role);
      assert.equal(resumed.me.onStage, true);
      assert.equal(resumed.me.connected, true);
      assert.equal(resumed.resumeToken, before.resumeToken);
      assert.equal(room.peers.get(id), peer);
      await current.client.ok({ type: 'rtc:offer', requestId: 'new-offer', payload: SENDRECV_OFFER });
      const publisher = room.publishers.get(id);
      assert.ok(publisher);
      const currentStart = current.client.inbox.length;
      release.resolve();
      await f.until(() => f.finished.has('held') && (f.detachCounts.get(subject.session) ?? 0) >= 2, 'old offer and post-drain detach');
      await current.client.ok({ type: 'mic:mute', requestId: 'still-joined' });
      await current.client.ok({ type: 'mic:unmute', requestId: 'unmute' });
      assert.equal(f.h.hub.isJoined(current.session), true);
      assert.equal(room.peers.get(id), peer, 'late completion preserves the current peer');
      assert.equal(room.publishers.get(id), publisher, 'late completion preserves the current publisher');
      assert.equal(room.subscribers.has(id), true);
      assert.equal(current.client.inbox.slice(currentStart).some(message => message.type === 'rtc:answer' || message.type === 'error' || (message.type === 'ok' && message.requestId === 'held')), false, 'the old offer does not reply to the replacement');
      assert.equal(f.h.transport.emitUplink(initial.roomId, id, sine(960, 0.2)), true);
      f.h.mixers.get(initial.roomId)!.tick();
      assert.ok(listenerPeer.received.at(-1)!.some(sample => Math.abs(sample) > 0.01), 'the observer still hears the resumed publisher');
      assert.equal(f.h.hub.roomCount, 1);
    });
  }
}

it('removes a guest immediately on normal 1000 closure while its offer is held', { timeout: 15000 }, async t => {
  const f = await setup(t);
  const host = await f.connect();
  await host.client.ok({ type: 'room:create', requestId: 'create', name: 'Host' });
  const initial = host.client.state();
  const guest = await f.connect();
  await guest.client.ok({ type: 'join', requestId: 'join', roomId: initial.roomId, code: initial.code, name: 'Guest' });
  const before = guest.client.state(), id = before.me.participantId;
  await guest.client.ok({ type: 'rtc:offer', requestId: 'established', payload: RECVONLY_OFFER });
  const room = f.h.transport.rooms.get(initial.roomId)!;
  assert.ok(room.peers.get(id));
  const entered = Promise.withResolvers<void>(), release = f.gate();
  const negotiate = f.h.transport.negotiate.bind(f.h.transport);
  f.h.transport.negotiate = async (...args) => {
    const answer = await negotiate(...args);
    entered.resolve();
    await release.promise;
    return answer;
  };
  guest.client.send({ type: 'rtc:offer', requestId: 'held', payload: RECVONLY_OFFER });
  await bounded(entered.promise, 'guest offer entered transport');
  await f.close(guest, true);
  await f.until(() => (f.detachCounts.get(guest.session) ?? 0) >= 1, 'normal close detaches before offer release');
  assert.equal(f.finished.has('held'), false);
  assert.equal(f.h.hub.isJoined(guest.session), false);
  assert.equal(room.peers.has(id), false, 'normal close removes guest media without grace');
  const current = await f.connect();
  await current.client.ok({ type: 'join', requestId: 'rejoin', roomId: initial.roomId, code: initial.code, name: 'Guest', resumeToken: before.resumeToken });
  assert.notEqual(current.client.state().me.participantId, id, 'a normally departed guest cannot reclaim its old seat');
  assert.notEqual(current.client.state().resumeToken, before.resumeToken);
  release.resolve();
  await f.until(() => f.finished.has('held') && (f.detachCounts.get(guest.session) ?? 0) >= 2, 'normal close post-drain detach');
  assert.equal(room.peers.has(id), false, 'late success cannot restore removed media');
  assert.equal(f.h.hub.isJoined(current.session), true);
});

for (const normal of [false, true]) {
  it(`cleans a late join binding after ${normal ? '1000' : '1006'} closure while the real room queue is held`, { timeout: 15000 }, async t => {
    const f = await setup(t);
    const host = await f.connect();
    await host.client.ok({ type: 'room:create', requestId: 'create', name: 'Host' });
    const initial = host.client.state();
    const guest = await f.connect();
    const release = f.gate(), queueEntered = Promise.withResolvers<void>(), joinEntered = Promise.withResolvers<void>();
    // Hold the actual queue so join has been dispatched but cannot install its binding yet.
    const runtime = (f.h.hub as unknown as { rooms: Map<string, { queue: SerialQueue }> }).rooms.get(initial.roomId)!;
    const held = runtime.queue.run(async () => { queueEntered.resolve(); await release.promise; });
    await bounded(queueEntered.promise, 'room queue gate entered');
    const handle = f.h.hub.handle.bind(f.h.hub);
    f.h.hub.handle = (session, message) => {
      const pending = handle(session, message);
      if (session === guest.session && message.type === 'join') joinEntered.resolve();
      return pending;
    };
    guest.client.send({ type: 'join', requestId: 'late-join', roomId: initial.roomId, code: initial.code, name: 'Late guest' });
    await bounded(joinEntered.promise, 'join submitted to room queue');
    await f.close(guest, normal);
    assert.equal(f.h.hub.isJoined(guest.session), false);
    release.resolve();
    await bounded(held, 'room queue gate released');
    await f.until(() => f.finished.has('late-join') && (f.detachCounts.get(guest.session) ?? 0) >= 1 && !f.h.hub.isJoined(guest.session), 'late join binding detached after drain');
    await host.client.ok({ type: 'mic:mute', requestId: 'room-barrier' });
    const state = host.client.state();
    assert.equal(f.h.hub.metrics().filter(sample => sample.type !== 'histogram').find(sample => sample.name === 'stage_sessions')!.value, 1);
    if (normal) assert.deepEqual(state.audience, []);
    else {
      assert.equal(state.audience?.length, 1);
      assert.equal(state.audience[0]!.connected, false);
    }
  });
}

it('cleans a late room-create binding after a synthetic pre-dispatch delay', { timeout: 15000 }, async t => {
  const f = await setup(t);
  const creator = await f.connect();
  const entered = Promise.withResolvers<void>(), release = f.gate();
  const handle = f.h.hub.handle.bind(f.h.hub);
  // Room creation is synchronous today; this synthetic delay checks the defensive drain pass.
  f.h.hub.handle = (session, message) => {
    const pending = (async () => {
      if (message.type === 'room:create') { entered.resolve(); await release.promise; }
      await handle(session, message);
    })();
    f.active.push(pending);
    return pending;
  };
  creator.client.send({ type: 'room:create', requestId: 'late-create', name: 'Late host' });
  await bounded(entered.promise, 'synthetic room-create delay entered');
  await f.close(creator, true);
  assert.equal(f.h.hub.roomCount, 0);
  release.resolve();
  await f.until(() => f.finished.has('late-create') && (f.detachCounts.get(creator.session) ?? 0) >= 1 && !f.h.hub.isJoined(creator.session), 'late create binding detached after drain');
  assert.equal(f.h.hub.roomCount, 1, 'controller disconnect still uses controller grace');
  assert.equal(f.h.hub.metrics().filter(sample => sample.type !== 'histogram').find(sample => sample.name === 'stage_sessions')!.value, 0);
  assert.equal(f.h.timers.filter(timer => !timer.cleared).length, 1, 'the disconnected controller has one grace timer');
});

it('still performs post-drain cleanup when the first detach rejects', { timeout: 15000 }, async t => {
  const f = await setup(t);
  const host = await f.connect();
  await host.client.ok({ type: 'room:create', requestId: 'create', name: 'Host' });
  const initial = host.client.state();
  const guest = await f.connect();
  await guest.client.ok({ type: 'join', requestId: 'join', roomId: initial.roomId, code: initial.code, name: 'Guest' });
  await guest.client.ok({ type: 'rtc:offer', requestId: 'established', payload: RECVONLY_OFFER });
  const id = guest.client.state().me.participantId;
  const entered = Promise.withResolvers<void>(), release = f.gate(), firstDetach = Promise.withResolvers<void>();
  const negotiate = f.h.transport.negotiate.bind(f.h.transport);
  f.h.transport.negotiate = async (...args) => {
    const answer = await negotiate(...args);
    entered.resolve();
    await release.promise;
    return answer;
  };
  const detach = f.h.hub.detach.bind(f.h.hub);
  let attempts = 0;
  f.h.hub.detach = (session, intentional) => {
    if (session === guest.session && ++attempts === 1) {
      firstDetach.resolve();
      return Promise.reject(new Error('synthetic first detach failure'));
    }
    return detach(session, intentional);
  };
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  guest.client.send({ type: 'rtc:offer', requestId: 'held', payload: RECVONLY_OFFER });
  await bounded(entered.promise, 'offer entered before rejected detach');
  await f.close(guest, true);
  await bounded(firstDetach.promise, 'first detach attempted before drain');
  assert.equal(f.finished.has('held'), false);
  release.resolve();
  await f.until(() => f.finished.has('held') && (f.detachCounts.get(guest.session) ?? 0) >= 1, 'successful retry after drain');
  await bounded(nextTurn(), 'unhandled rejection observation turn');
  assert.equal(attempts, 2);
  assert.equal(f.h.hub.isJoined(guest.session), false);
  assert.equal(f.h.transport.rooms.get(initial.roomId)!.peers.has(id), false);
  assert.equal(f.h.hub.isJoined(host.session), true);
  assert.deepEqual(f.errors.map(error => error.message), ['ws detach failed']);
  assert.equal(f.errors[0]!.fields?.session, guest.session.id);
  assert.deepEqual(unhandled, []);
});

for (const outcome of ['success', 'failure'] as const) {
  it(`expires controller grace and transfers control before the held offer finishes with ${outcome}`, { timeout: 15000 }, async t => {
    const graceMs = 7;
    const f = await setup(t, config => { config.rooms.controllerGraceMs = graceMs; config.rooms.qualityIntervalMs = 0; });
    const host = await f.connect();
    await host.client.ok({ type: 'room:create', requestId: 'create', name: 'Host' });
    await host.client.ok({ type: 'rtc:offer', requestId: 'established', payload: SENDRECV_OFFER });
    const initial = host.client.state();
    const successor = await f.connect();
    await successor.client.ok({ type: 'join', requestId: 'successor', roomId: initial.roomId, code: initial.code, name: 'Successor' });
    await successor.client.ok({ type: 'rtc:offer', requestId: 'listener-offer', payload: RECVONLY_OFFER });
    const successorId = successor.client.state().me.participantId;
    const room = f.h.transport.rooms.get(initial.roomId)!, peer = room.peers.get(successorId);
    assert.ok(peer);
    const entered = Promise.withResolvers<void>(), release = f.gate();
    const negotiate = f.h.transport.negotiate.bind(f.h.transport);
    f.h.transport.negotiate = async (...args) => {
      const answer = await negotiate(...args);
      if (args[1] === initial.me.participantId) {
        entered.resolve();
        await release.promise;
        if (outcome === 'failure') throw new Error('expired controller offer failed');
      }
      return answer;
    };
    host.client.send({ type: 'rtc:offer', requestId: 'held', payload: SENDRECV_OFFER });
    await bounded(entered.promise, 'controller offer entered before grace expiry');
    await f.close(host);
    await successor.client.waitFor(message => message.type === 'room:state' && message.speakers.some(p => p.participantId === initial.me.participantId && !p.connected), 'controller disconnect starts grace');
    const grace = f.h.timers.find(timer => !timer.cleared && timer.ms === graceMs);
    assert.ok(grace, 'grace timer starts while the offer is still blocked');
    f.h.clock.now += graceMs;
    grace.cleared = true;
    grace.fn();
    await successor.client.waitFor(message => message.type === 'room:state' && message.controllerId === successorId, 'controller transfer at deterministic grace deadline');
    assert.equal(f.finished.has('held'), false);
    assert.equal(successor.client.state().me.role, 'controller');
    assert.equal(successor.client.state().speakers.some(p => p.participantId === initial.me.participantId), false);
    assert.equal(room.peers.has(initial.me.participantId), false);
    release.resolve();
    await f.until(() => f.finished.has('held') && (f.detachCounts.get(host.session) ?? 0) >= 2, 'expired controller offer and drain cleanup');
    await successor.client.ok({ type: 'room:rotate-code', requestId: 'controller-still-works' });
    assert.equal(successor.client.state().me.role, 'controller');
    assert.equal(f.h.hub.isJoined(successor.session), true);
    assert.equal(room.peers.get(successorId), peer);
    assert.equal(room.peers.has(initial.me.participantId), false);
    assert.equal(f.h.hub.roomCount, 1);
    assert.equal(successor.client.inbox.filter(message => message.type === 'control:transferred').length, 1);
    assert.equal(f.h.timers.some(timer => !timer.cleared && timer.ms === graceMs), false, 'late detach cannot restart old controller grace');
  });
}
