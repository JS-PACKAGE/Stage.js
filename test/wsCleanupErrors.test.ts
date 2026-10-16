import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { WebSocket } from 'ws';
import type { ClientMessage, ServerMessage } from '../shared/protocol.ts';
import { createLogger } from '../src/log.ts';
import type { Session } from '../src/ws/hub.ts';
import { createStageServer } from '../src/ws/server.ts';
import type { WsSession } from '../src/ws/session.ts';
import { harness, RECVONLY_OFFER, SENDRECV_OFFER, testConfig } from './helpers.ts';

type Request = Exclude<ClientMessage, { type: 'ping' }>;
const SECRET = 'synthetic-cleanup-secret-must-not-appear';
const kinds = ['Error', 'null-prototype', 'hooks', 'proxy'] as const;

function diagnostic(kind: typeof kinds[number]) {
  let calls = 0;
  const hook = () => { calls++; throw new Error('diagnostic hook must not run'); };
  let value: unknown;
  let expected: unknown;
  if (kind === 'Error') {
    value = new TypeError('synthetic cleanup failure', { cause: { token: SECRET, retryable: true } });
  } else if (kind === 'null-prototype') {
    value = Object.assign(Object.create(null) as Record<string, unknown>, { reason: 'synthetic cleanup failure', nested: { resumeToken: SECRET } });
    expected = { reason: 'synthetic cleanup failure', nested: { resumeToken: '[redacted]' } };
  } else if (kind === 'hooks') {
    value = { toString: hook, valueOf: hook, toJSON: hook, [Symbol.toPrimitive]: hook, get unsafe() { return hook(); }, get secret() { return hook(); } };
    expected = { toString: '[Function]', valueOf: '[Function]', toJSON: '[Function]', unsafe: '[Accessor]', secret: '[redacted]' };
  } else {
    value = new Proxy({}, { get: hook, ownKeys: hook, getOwnPropertyDescriptor: hook });
    expected = '[Proxy]';
  }
  return {
    value,
    check(error: unknown) {
      assert.equal(calls, 0, 'coercion, serialization, getters and proxy traps must not run');
      if (kind === 'Error') {
        assert.ok(error !== null && typeof error === 'object');
        const fields = error as Record<string, unknown>;
        assert.equal(fields.name, 'TypeError');
        assert.equal(fields.message, 'synthetic cleanup failure');
        assert.deepEqual(fields.cause, { token: '[redacted]', retryable: true });
      } else assert.deepEqual(error, expected);
    },
  };
}

async function bounded<T>(promise: Promise<T>, phase: string, ms = 2000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`timed out: ${phase}`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function setup(t: TestContext) {
  const config = testConfig(c => {
    c.server.port = 0;
    c.rooms.presenceBroadcastMs = 0;
    c.rooms.qualityIntervalMs = 0;
    c.limits.controlPerSecond = 100;
  });
  const h = harness(config);
  const events = new EventEmitter();
  const clients: WebSocket[] = [], sessions: WsSession[] = [];
  const closes = new Map<Session, Promise<number>>();
  const attempts = new Map<Session, number>();
  const detachFailures = new Map<Session, Map<number, unknown>>();
  const active: Promise<void>[] = [], releases: (() => void)[] = [];
  const finished = new Set<string>(), handled: { session: Session; requestId: string }[] = [];
  const lines: string[] = [], logs: Record<string, unknown>[] = [];
  const changed = () => events.emit('change');
  const attach = h.hub.attach.bind(h.hub), detach = h.hub.detach.bind(h.hub), handle = h.hub.handle.bind(h.hub);
  h.hub.attach = session => {
    const wsSession = session as WsSession;
    sessions.push(wsSession);
    closes.set(session, new Promise(resolve => wsSession.ws.once('close', code => { resolve(code); changed(); })));
    attach(session);
  };
  h.hub.detach = async (session, intentional) => {
    const attempt = (attempts.get(session) ?? 0) + 1;
    attempts.set(session, attempt);
    try {
      const failures = detachFailures.get(session);
      if (failures?.has(attempt)) throw failures.get(attempt);
      await detach(session, intentional);
    } finally { changed(); }
  };
  const server = createStageServer({
    config, hub: h.hub, baseDir: tmpdir(),
    log: createLogger('error', line => { lines.push(line); logs.push(JSON.parse(line) as Record<string, unknown>); changed(); }),
  });
  t.after(async () => {
    for (const release of releases) release();
    try { await bounded(Promise.all(active), 'active handlers during cleanup', 5000); }
    finally {
      for (const client of clients) client.terminate();
      for (const session of sessions) session.terminate();
      await bounded(server.close(), 'server cleanup', 5000);
    }
  });
  const { port } = await bounded(server.listen(), 'server listen');
  const until = async (predicate: () => boolean, phase: string) => {
    let check = () => {};
    try {
      await bounded(new Promise<void>(resolve => {
        check = () => { if (predicate()) resolve(); };
        events.on('change', check);
        check();
      }), phase);
    } finally { events.off('change', check); }
  };
  const connect = async () => {
    const index = sessions.length, inbox: ServerMessage[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}${config.server.wsPath}`);
    clients.push(ws);
    const opened = new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    const closed = new Promise<number>(resolve => ws.once('close', code => { resolve(code); changed(); }));
    ws.on('message', data => { inbox.push(JSON.parse(data.toString()) as ServerMessage); changed(); });
    await bounded(opened, 'client open');
    await until(() => inbox.some(message => message.type === 'hello'), 'server hello');
    const session = sessions[index];
    assert.ok(session);
    return {
      ws, session, inbox, closed,
      send: (message: ClientMessage) => ws.send(JSON.stringify(message)),
      async ok(message: Request) {
        ws.send(JSON.stringify(message));
        const reply = () => inbox.find(m => (m.type === 'ok' || m.type === 'error') && m.requestId === message.requestId);
        await until(() => reply() !== undefined, message.requestId);
        assert.equal(reply()!.type, 'ok', JSON.stringify(reply()));
      },
      state() {
        const state = inbox.findLast(message => message.type === 'room:state');
        assert.ok(state?.type === 'room:state');
        return state;
      },
    };
  };
  const hold = (subject: Session, failure?: { value: unknown }) => {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    releases.push(release.resolve);
    h.hub.handle = (session, message) => {
      if (message.type !== 'ping') handled.push({ session, requestId: message.requestId });
      const pending = (async () => {
        if (session === subject && message.type !== 'ping' && message.requestId === 'held') {
          entered.resolve();
          await release.promise;
          if (failure) throw failure.value;
        }
        await handle(session, message);
      })();
      const settled = () => { if (message.type !== 'ping') finished.add(message.requestId); changed(); };
      active.push(pending.then(settled, settled));
      return pending;
    };
    return { entered, release };
  };
  const checkLog = (sample: ReturnType<typeof diagnostic>, message: string, session: Session) => {
    assert.deepEqual(logs.map(log => log.msg), [message]);
    assert.equal(logs[0]!.level, 'error');
    assert.equal(logs[0]!.session, session.id);
    sample.check(logs[0]!.error);
    assert.doesNotMatch(lines.join('\n'), new RegExp(SECRET));
  };
  return { h, connect, until, hold, attempts, detachFailures, closes, finished, handled, checkLog };
}

for (const kind of kinds) {
  it(`terminates and discards queued work when a handler rejects with ${kind}`, { timeout: 15000 }, async t => {
    const f = await setup(t), sample = diagnostic(kind);
    const subject = await f.connect();
    await subject.ok({ type: 'room:create', requestId: 'create', name: 'Host' });
    const before = subject.state();
    const healthy = await f.connect();
    await healthy.ok({ type: 'join', requestId: 'healthy', roomId: before.roomId, code: before.code, name: 'Healthy' });
    const { entered, release } = f.hold(subject.session, sample);
    subject.send({ type: 'mic:mute', requestId: 'held' });
    await bounded(entered.promise, 'handler entered');
    const arrived = Promise.withResolvers<void>();
    let received = 0;
    const onMessage = () => { if (++received === 3) arrived.resolve(); };
    subject.session.ws.on('message', onMessage);
    try {
      for (let i = 0; i < 3; i++) subject.send({ type: 'mic:mute', requestId: `queued-${i}` });
      await bounded(arrived.promise, 'queued frames arrived');
    } finally { subject.session.ws.off('message', onMessage); }
    release.resolve();
    assert.deepEqual(await bounded(Promise.all([subject.closed, f.closes.get(subject.session)!]), 'handler failure terminates both sockets'), [1006, 1006]);
    await f.until(() => f.attempts.get(subject.session) === 2 && !f.h.hub.isJoined(subject.session), 'both detach passes');
    assert.deepEqual(f.handled.filter(item => item.session === subject.session).map(item => item.requestId), ['held']);
    const current = await f.connect();
    await current.ok({ type: 'join', requestId: 'resume', roomId: before.roomId, code: before.code, name: 'Host', resumeToken: before.resumeToken });
    assert.equal(current.state().me.participantId, before.me.participantId);
    await current.ok({ type: 'mic:mute', requestId: 'replacement-works' });
    healthy.send({ type: 'ping' });
    await f.until(() => healthy.inbox.some(message => message.type === 'pong'), 'healthy peer pong');
    await bounded(nextTurn(), 'rejection observation turn');
    assert.equal(f.h.hub.roomCount, 1);
    f.checkLog(sample, 'ws message handler failed', subject.session);
  });

  it(`retries after a first detach rejects with ${kind}`, { timeout: 15000 }, async t => {
    const f = await setup(t), sample = diagnostic(kind);
    const host = await f.connect();
    await host.ok({ type: 'room:create', requestId: 'create', name: 'Host' });
    const initial = host.state();
    const guest = await f.connect();
    await guest.ok({ type: 'join', requestId: 'guest', roomId: initial.roomId, code: initial.code, name: 'Guest' });
    await guest.ok({ type: 'rtc:offer', requestId: 'established', payload: RECVONLY_OFFER });
    const before = guest.state(), room = f.h.transport.rooms.get(initial.roomId)!;
    assert.ok(room.peers.has(before.me.participantId));
    const { entered, release } = f.hold(guest.session);
    f.detachFailures.set(guest.session, new Map([[1, sample.value]]));
    guest.send({ type: 'mic:mute', requestId: 'held' });
    await bounded(entered.promise, 'handler entered before first detach');
    guest.ws.close(1000);
    assert.deepEqual(await bounded(Promise.all([guest.closed, f.closes.get(guest.session)!]), 'normal close events'), [1000, 1000]);
    await f.until(() => f.attempts.get(guest.session) === 1, 'first detach attempt before drain');
    assert.equal(f.finished.has('held'), false);
    assert.equal(f.h.hub.isJoined(guest.session), true, 'injected failure occurs before the first cleanup');
    release.resolve();
    await f.until(() => f.attempts.get(guest.session) === 2 && !f.h.hub.isJoined(guest.session) && !room.peers.has(before.me.participantId), 'post-drain detach removes guest and media');
    const current = await f.connect();
    await current.ok({ type: 'join', requestId: 'rejoin', roomId: initial.roomId, code: initial.code, name: 'Guest', resumeToken: before.resumeToken });
    assert.notEqual(current.state().me.participantId, before.me.participantId, 'normal departure does not preserve the old seat');
    await host.ok({ type: 'mic:mute', requestId: 'host-works' });
    await bounded(nextTurn(), 'rejection observation turn');
    f.checkLog(sample, 'ws detach failed', guest.session);
  });

  it(`preserves a replacement seat when post-drain detach rejects with ${kind}`, { timeout: 15000 }, async t => {
    const f = await setup(t), sample = diagnostic(kind);
    const old = await f.connect();
    await old.ok({ type: 'room:create', requestId: 'create', name: 'Host' });
    await old.ok({ type: 'rtc:offer', requestId: 'established', payload: SENDRECV_OFFER });
    const before = old.state(), room = f.h.transport.rooms.get(before.roomId)!;
    const { entered, release } = f.hold(old.session);
    f.detachFailures.set(old.session, new Map([[2, sample.value]]));
    old.send({ type: 'rtc:ice', requestId: 'held', payload: null });
    await bounded(entered.promise, 'handler entered before disconnect');
    old.ws.terminate();
    assert.deepEqual(await bounded(Promise.all([old.closed, f.closes.get(old.session)!]), 'abnormal close events'), [1006, 1006]);
    await f.until(() => f.attempts.get(old.session) === 1 && !f.h.hub.isJoined(old.session), 'first detach before drain');
    const current = await f.connect();
    await current.ok({ type: 'join', requestId: 'resume', roomId: before.roomId, code: before.code, name: 'Host', resumeToken: before.resumeToken });
    assert.equal(current.state().me.participantId, before.me.participantId);
    await current.ok({ type: 'rtc:offer', requestId: 'replacement-offer', payload: SENDRECV_OFFER });
    const peer = room.peers.get(before.me.participantId), publisher = room.publishers.get(before.me.participantId);
    assert.ok(peer);
    assert.ok(publisher);
    assert.equal(f.finished.has('held'), false, 'resume happens before old work settles');
    const messageCount = current.inbox.length;
    release.resolve();
    await f.until(() => f.finished.has('held') && f.attempts.get(old.session) === 2, 'post-drain detach attempted');
    await current.ok({ type: 'mic:mute', requestId: 'replacement-works' });
    await bounded(nextTurn(), 'rejection observation turn');
    assert.equal(f.h.hub.isJoined(current.session), true);
    assert.equal(room.peers.get(before.me.participantId), peer);
    assert.equal(room.publishers.get(before.me.participantId), publisher);
    assert.equal(room.subscribers.has(before.me.participantId), true);
    assert.equal(current.inbox.slice(messageCount).some(message => (message.type === 'ok' || message.type === 'error') && message.requestId === 'held'), false);
    f.checkLog(sample, 'ws detach failed', old.session);
  });
}
