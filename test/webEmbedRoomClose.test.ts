import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { StageClient } from '../packages/client/src/index.ts';
import type { ClientMessage, ParticipantView, ServerMessage } from '../shared/protocol.ts';
import type { Session } from '../src/ws/hub.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { Deferred, EmbedNode, embedApp, flush, type EmbedSdk } from './fixtures/embedApp.ts';
import { actualApp, StageSocket, StagePeer } from './fixtures/embedSdkApp.ts';
import { harness, testConfig, FakeSession } from './helpers.ts';

// Whole production module with controlled DOM/dialog/media. Native browser focus,
// accessibility, physical audio and a real WebSocket server are not simulated claims.
const consent = '確定關閉此房間並讓所有人離場？關閉後無法再加入此房間。';
type View = { node(id: string): EmbedNode };
const close = (h: View): EmbedNode => h.node('close-room');
function force(node: EmbedNode): void { node.disabled = false; node.invoke(); }
function notice(h: View, message: string): void {
  assert.equal(h.node('error-notice').hidden, false); assert.equal(h.node('last-error').textContent, `最近錯誤：${message}`);
}
function snapshot(sdk: EmbedSdk, patch: { roomId?: string; name?: string; me?: Partial<ParticipantView>; speakers?: ParticipantView[] } = {}): void {
  assert.ok(sdk.state); assert.ok(sdk.me);
  sdk.state = { ...sdk.state, ...patch, me: { ...sdk.me, ...patch.me } }; sdk.me = sdk.state.me; sdk.emit('state', sdk.state);
}
const speaker = (): ParticipantView => ({ participantId: 'other', name: 'Other', role: 'speaker', onStage: true,
  handRaised: false, muted: false, forceMuted: false, connected: true, gainDb: 0, joinedAt: 0 });
function transfer(h: View): EmbedNode {
  const button = h.node('stage-management-list').children[0]?.children[1]?.children[2]; assert.ok(button); return button;
}
async function app(t: TestContext, options: Parameters<typeof embedApp>[0] = {}) {
  const h = embedApp({ confirm: () => true, ...options }); t.after(() => h.cleanup());
  const sdk = await h.join({ role: 'controller', onStage: false }); return { h, sdk };
}
function observeDisabled(node: EmbedNode, effect: (value: boolean) => void): () => void {
  const property = Object.getOwnPropertyDescriptor(EmbedNode.prototype, 'disabled')!;
  Object.defineProperty(node, 'disabled', { configurable: true,
    get: () => property.get!.call(node) as boolean,
    set: (value: boolean) => { property.set!.call(node, value); effect(value); },
  });
  return () => { Reflect.deleteProperty(node, 'disabled'); };
}

it('HTML provides a distinct initially hidden disabled destructive button and explicit closure versus Leave semantics', () => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  assert.match(html, /<button id="close-room" type="button" class="danger" aria-busy="false" aria-describedby="room-close-notice" hidden disabled>關閉房間<\/button>/);
  assert.match(html, /關閉房間會讓所有人離場，且無法再加入此房間/);
  assert.match(html, /離開房間只會讓你離場，房間可能保留並由其他人接任主控/);
  assert.match(html, /id="leave" type="button" disabled>離開房間/);
});
for (const onStage of [false, true]) for (const status of ['waiting', 'live'] as const) for (const muted of [false, true])
  it(`connected controller closes onStage=${onStage}, ${status}, muted=${muted} without local ACK-derived teardown`, async t => {
    const { h, sdk } = await app(t); snapshot(sdk, { me: { onStage, muted, forceMuted: muted } }); sdk.setStatus(status);
    assert.equal(close(h).hidden, false); assert.equal(close(h).disabled, false);
    const before = h.status.textContent; close(h).click();
    assert.deepEqual(h.confirmations, [consent]); assert.equal(sdk.closes.length, 1);
    assert.equal(close(h).disabled, true); assert.equal(close(h).getAttribute('aria-busy'), 'true');
    sdk.closes[0]!.work.resolve(); await flush();
    assert.equal(sdk.status, status); assert.equal(sdk.me!.role, 'controller'); assert.equal(h.status.textContent, before);
    assert.equal(close(h).disabled, false); assert.equal(close(h).getAttribute('aria-busy'), 'false');
    assert.equal(h.clock.timers.length, 0); assert.equal(sdk.deviceLists.length, 0); assert.equal(sdk.actions.length, 0);
  });
it('initial, module loading and no-state controls cannot close, even through forced callbacks', async t => {
  const gate = new Deferred(), h = embedApp({ libraryLoad: gate.promise, confirm: () => true });
  t.after(async () => { if (!gate.settled) gate.resolve(); await flush(); await h.cleanup(); });
  for (const start of [false, true]) {
    if (start) { h.form.submit(); await flush(); }
    assert.equal(close(h).hidden, true); force(close(h)); assert.equal(h.confirmations.length, 0);
  }
  gate.resolve(); await flush(); force(close(h)); assert.equal(h.confirmations.length, 0);
  assert.equal(h.clients[0]!.closes.length, 0);
});
for (const role of ['audience', 'speaker'] as const) it(`${role} never gains a close affordance or forced dispatch`, async t => {
  const h = embedApp({ confirm: () => true }); t.after(() => h.cleanup()); const sdk = await h.join({ role, onStage: role === 'speaker' });
  assert.equal(close(h).hidden, true); force(close(h)); assert.equal(close(h).disabled, true);
  assert.equal(h.confirmations.length, 0); assert.equal(sdk.closes.length, 0);
});
for (const unavailable of ['method', 'confirm', 'local disconnected'] as const)
  it(`${unavailable} blocks closure without fallback`, async t => {
    const { h, sdk } = await app(t, unavailable === 'confirm' ? { confirm: null } : {});
    if (unavailable === 'method') Reflect.set(sdk, 'closeRoom', undefined);
    snapshot(sdk, { me: { connected: unavailable !== 'local disconnected' } });
    assert.equal(close(h).disabled, true); assert.equal(close(h).hidden, unavailable !== 'confirm');
    force(close(h)); assert.equal(h.confirmations.length, 0); assert.equal(sdk.closes.length, 0); assert.ok(sdk.me);
  });
it('cancel preserves errors and seat, makes no request, and releases only its reservation', async t => {
  let inspect = () => {};
  const { h, sdk } = await app(t, { confirm: () => { inspect(); return false; } });
  inspect = () => { assert.equal(close(h).disabled, true); force(close(h)); assert.equal(sdk.closes.length, 0); };
  sdk.emit('error', new Error('keep cancelled error')); close(h).click(); await flush();
  assert.deepEqual(h.confirmations, [consent]); assert.equal(sdk.closes.length, 0); assert.ok(sdk.me);
  notice(h, 'keep cancelled error'); assert.equal(close(h).disabled, false); assert.equal(close(h).getAttribute('aria-busy'), 'false');
});
for (const failure of ['confirm throw', 'SDK throw', 'SDK reject'] as const)
  it(`${failure} reports only current failure, never retries, and allows a fresh consent`, async t => {
    let fail = true;
    const { h, sdk } = await app(t, { confirm: () => { if (fail && failure === 'confirm throw') throw new Error('current failure'); return true; } });
    const original = sdk.closeRoom.bind(sdk);
    if (failure === 'SDK throw') sdk.closeRoom = () => { throw new Error('current failure'); };
    close(h).click(); if (failure === 'SDK reject') sdk.closes[0]!.work.reject('current failure'); await flush();
    notice(h, 'current failure'); assert.equal(close(h).disabled, false); const attempts = h.confirmations.length;
    h.tick(10000); assert.equal(h.confirmations.length, attempts);
    fail = false; sdk.closeRoom = original; close(h).click(); assert.equal(h.confirmations.length, attempts + 1);
  });
it('confirmation and synchronous SDK reentry reserve before callbacks, duplicates and disabled tampering', async t => {
  let reenter = () => {};
  const { h, sdk } = await app(t, { confirm: () => { reenter(); return true; } });
  reenter = () => { force(close(h)); force(close(h)); };
  const original = sdk.closeRoom.bind(sdk); sdk.closeRoom = () => { reenter(); return original(); };
  close(h).click(); reenter(); snapshot(sdk);
  assert.deepEqual(h.confirmations, [consent]); assert.equal(sdk.closes.length, 1);
  assert.equal(close(h).disabled, true); assert.equal(close(h).getAttribute('aria-busy'), 'true');
});
it('reservation precedes instrumented render writes and captures feedback before render reentry', async t => {
  const { h, sdk } = await app(t); let once = true;
  const restore = observeDisabled(close(h), value => { if (once && value) { once = false; sdk.emit('error', new Error('new render error')); force(close(h)); } });
  t.after(restore); close(h).click(); assert.equal(sdk.closes.length, 1); assert.equal(h.confirmations.length, 1);
  sdk.closes[0]!.work.reject('obsolete close failure'); await flush(); notice(h, 'new render error');
});
for (const direction of ['close to transfer', 'transfer to close'] as const)
  it(`reciprocal ${direction} confirmation blocks nested destructive dialogs, then accepts a fresh click`, async t => {
    let reenter = () => {}, first = true;
    const { h, sdk } = await app(t, { confirm: () => { if (first) { first = false; reenter(); return false; } return true; } });
    snapshot(sdk, { speakers: [speaker()] });
    reenter = () => direction === 'close to transfer' ? force(transfer(h)) : force(close(h));
    if (direction === 'close to transfer') close(h).click(); else transfer(h).click(); await flush();
    assert.equal(h.confirmations.length, 1); assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
    if (direction === 'close to transfer') transfer(h).click(); else close(h).click();
    assert.equal(h.confirmations.length, 2); assert.equal(sdk.closes.length + sdk.transfers.length, 1);
  });
for (const direction of ['close to transfer', 'transfer to close'] as const)
  it(`${direction} reservation-render callback cannot nest another confirmation`, async t => {
    const { h, sdk } = await app(t); snapshot(sdk, { speakers: [speaker()] }); let once = true;
    const target = direction === 'close to transfer' ? close(h) : transfer(h);
    const restore = observeDisabled(target, value => { if (once && value) { once = false; force(direction === 'close to transfer' ? transfer(h) : close(h)); } });
    t.after(restore); target.click(); assert.equal(h.confirmations.length, 1); assert.equal(sdk.closes.length + sdk.transfers.length, 1);
  });
it('close remains independent from ordinary stage, microphone, hand, room-name and gain operations', async t => {
  const { h, sdk } = await app(t); snapshot(sdk, { me: { onStage: true }, speakers: [speaker()] });
  transfer(h).parentElement!.children[0]!.click(); h.mic.click(); h.stage.click();
  h.node('room-name-draft').value = 'Independent title'; h.node('room-name-update').click();
  close(h).click(); assert.equal(sdk.closes.length, 1); assert.equal(sdk.stageModerations.length, 1);
  assert.equal(sdk.roomRenames.length, 1); assert.deepEqual(sdk.actions.map(action => action.type), ['mute', 'leaveStage']);
});
it('room naming, local stage/mute and unrelated participant changes preserve room-level consent', async t => {
  let change = () => {};
  const { h, sdk } = await app(t, { confirm: () => { change(); return true; } });
  change = () => {
    snapshot(sdk, { name: 'Renamed room', me: { onStage: true, muted: true, forceMuted: true }, speakers: [speaker()] });
    sdk.emit('role', { participantId: 'other', role: 'audience' }); sdk.emit('stageleft', { participantId: 'other' });
    sdk.emit('transferred', { fromId: 'another', toId: 'other' });
  };
  close(h).click(); assert.equal(sdk.closes.length, 1); assert.deepEqual(h.confirmations, [consent]);
});
for (const change of ['role', 'room', 'participant', 'local disconnected', 'method', 'reconnecting', 'missing state'] as const)
  it(`observed transient ${change} and restoration never revive consent; a later fresh click may close`, async t => {
    let mutate = () => {}, once = true;
    const { h, sdk } = await app(t, { confirm: () => { if (once) { once = false; mutate(); } return true; } });
    const original = sdk.closeRoom.bind(sdk), state = sdk.state!, me = sdk.me!;
    mutate = () => {
      if (change === 'method') { Reflect.set(sdk, 'closeRoom', undefined); sdk.emit('status', sdk.status); }
      else if (change === 'reconnecting') sdk.setStatus('reconnecting');
      else if (change === 'missing state') { sdk.state = null; sdk.emit('status', sdk.status); }
      else snapshot(sdk, change === 'room' ? { roomId: 'other-room' } : { me: change === 'role' ? { role: 'audience' }
        : change === 'participant' ? { participantId: 'another-controller' } : { connected: false } });
      sdk.closeRoom = original; sdk.state = state; sdk.me = me; sdk.setStatus('live'); sdk.emit('state', state);
      force(close(h)); assert.equal(h.confirmations.length, 1, 'original dialog holds cross-tenure reservation');
    };
    sdk.emit('error', new Error('keep transient error')); close(h).click(); await flush();
    assert.equal(sdk.closes.length, 0); notice(h, 'keep transient error'); assert.equal(close(h).disabled, false);
    close(h).click(); assert.equal(sdk.closes.length, 1); assert.equal(h.confirmations.length, 2);
  });
for (const event of ['role', 'transferred'] as const) {
  const detail = event === 'role' ? { participantId: 'listener', role: 'audience' } : { fromId: 'listener', toId: 'other' };
  it(`own ${event} delta fences stale snapshot until authoritative state`, async t => {
    const { h, sdk } = await app(t); sdk.emit(event, detail); sdk.emit('status', sdk.status);
    assert.equal(close(h).disabled, true); force(close(h)); assert.equal(h.confirmations.length, 0);
    snapshot(sdk); close(h).click(); assert.equal(sdk.closes.length, 1);
  });
  it(`own ${event} notification followed by restored state cannot revive open consent`, async t => {
    let mutate = () => {}, once = true;
    const { h, sdk } = await app(t, { confirm: () => { if (once) { once = false; mutate(); } return true; } });
    mutate = () => { sdk.emit(event, detail); snapshot(sdk); force(close(h)); };
    close(h).click(); await flush(); assert.equal(sdk.closes.length, 0); assert.equal(h.confirmations.length, 1);
    close(h).click(); assert.equal(sdk.closes.length, 1);
  });
  it(`own ${event} fence survives missing capability owner then capability/status restoration`, async t => {
    const { h, sdk } = await app(t), original = sdk.closeRoom.bind(sdk);
    Reflect.set(sdk, 'closeRoom', undefined); sdk.emit('status', sdk.status); sdk.emit(event, detail);
    sdk.closeRoom = original; sdk.emit('status', sdk.status); force(close(h));
    assert.equal(h.confirmations.length, 0); assert.equal(sdk.closes.length, 0); snapshot(sdk);
    close(h).click(); assert.equal(sdk.closes.length, 1);
  });
}
it('reconnect retains existing controller disabled but cannot create owner from stale snapshot', async t => {
  const { h, sdk } = await app(t); sdk.setStatus('reconnecting'); assert.equal(close(h).hidden, false); assert.equal(close(h).disabled, true);
  force(close(h)); assert.equal(h.confirmations.length, 0); sdk.setStatus('live'); close(h).click(); assert.equal(sdk.closes.length, 1);
  const next = await h.join({ role: 'audience' }); next.setStatus('reconnecting'); snapshot(next, { me: { role: 'controller' } });
  assert.equal(close(h).hidden, true); force(close(h)); assert.equal(h.confirmations.length, 1);
});
for (const outcome of ['resolve', 'reject'] as const)
  it(`sent close keeps duplicate guard through reconnect and snapshots until ${outcome}, without replay or stale feedback`, async t => {
    const { h, sdk } = await app(t); close(h).click(); const work = sdk.closes[0]!.work;
    sdk.setStatus('reconnecting'); force(close(h)); sdk.setStatus('live'); snapshot(sdk); force(close(h));
    assert.equal(close(h).disabled, true); assert.equal(close(h).getAttribute('aria-busy'), 'true');
    assert.equal(sdk.closes.length, 1); sdk.emit('error', new Error('new independent error'));
    if (outcome === 'resolve') work.resolve(); else work.reject('obsolete error'); await flush();
    notice(h, 'new independent error'); assert.equal(close(h).disabled, false); close(h).click(); assert.equal(sdk.closes.length, 2);
  });
for (const boundary of ['role', 'room', 'participant', 'method', 'local disconnected', 'missing state', 'disconnected', 'closed', 'shutdown', 'kicked', 'leave', 'new entry'] as const)
  for (const outcome of ['resolve', 'reject'] as const)
    it(`${boundary} retires exact owner; late ${outcome} cannot release or report over replacement close`, async t => {
      const { h, sdk } = await app(t); close(h).click(); const work = sdk.closes[0]!.work, original = sdk.closeRoom.bind(sdk);
      if (boundary === 'role') snapshot(sdk, { me: { role: 'audience' } });
      else if (boundary === 'room') snapshot(sdk, { roomId: 'other-room' });
      else if (boundary === 'participant') snapshot(sdk, { me: { participantId: 'other-controller' } });
      else if (boundary === 'method') { Reflect.set(sdk, 'closeRoom', undefined); sdk.emit('status', sdk.status); }
      else if (boundary === 'local disconnected') snapshot(sdk, { me: { connected: false } });
      else if (boundary === 'missing state') { sdk.state = null; sdk.emit('status', sdk.status); }
      else if (boundary === 'disconnected') sdk.setStatus('disconnected');
      else if (boundary === 'closed' || boundary === 'shutdown') sdk.emit('closed', { reason: boundary });
      else if (boundary === 'kicked') sdk.emit('kicked', {});
      else if (boundary === 'leave') h.leave.click(); else h.form.submit();
      let next = sdk;
      if (['disconnected', 'closed', 'shutdown', 'kicked', 'leave', 'new entry'].includes(boundary)) {
        if (boundary === 'new entry') { await flush(); next = h.clients.at(-1)!; next.snapshot({ role: 'controller' }); }
        else next = await h.join({ role: 'controller' });
      } else { sdk.closeRoom = original; sdk.snapshot({ role: 'controller', connected: true }); }
      close(h).click(); assert.equal(close(h).getAttribute('aria-busy'), 'true'); next.emit('error', new Error('new tenure error'));
      if (next !== sdk) { sdk.emit('role', { participantId: 'listener', role: 'audience' }); sdk.emit('transferred', { fromId: 'listener', toId: 'other' }); }
      if (outcome === 'resolve') work.resolve(); else work.reject('obsolete close error'); await flush();
      notice(h, 'new tenure error'); assert.equal(close(h).disabled, true); assert.equal(close(h).getAttribute('aria-busy'), 'true');
      force(close(h)); assert.equal(h.confirmations.length, 2);
    });
for (const boundary of ['leave', 'new entry', 'closed', 'shutdown', 'kicked', 'disconnected'] as const)
  it(`${boundary} during confirmation invalidates dispatch and cannot overwrite its result`, async t => {
    let change = () => {};
    const { h, sdk } = await app(t, { confirm: () => { change(); return true; } });
    change = () => {
      if (boundary === 'leave') h.leave.click(); else if (boundary === 'new entry') h.form.submit();
      else if (boundary === 'disconnected') sdk.setStatus('disconnected');
      else if (boundary === 'kicked') sdk.emit('kicked', {}); else sdk.emit('closed', { reason: boundary });
    };
    close(h).click(); await flush(); assert.equal(sdk.closes.length, 0); assert.equal(h.node('error-notice').hidden, true);
    assert.equal(close(h).hidden, true); assert.equal(close(h).getAttribute('aria-busy'), 'false');
  });
it('reservation render which starts new entry cannot restore stale close state or open its dialog', async t => {
  const { h, sdk } = await app(t); let once = true;
  const restore = observeDisabled(close(h), value => { if (once && value) { once = false; h.form.submit(); } });
  t.after(restore); close(h).click(); await flush();
  assert.equal(sdk.closes.length, 0); assert.equal(h.confirmations.length, 0);
  assert.equal(close(h).hidden, true); assert.equal(close(h).disabled, true); assert.equal(close(h).getAttribute('aria-busy'), 'false');
  h.clients.at(-1)!.snapshot({ role: 'controller' }); close(h).click(); assert.equal(h.confirmations.length, 1);
});
it('current rejection never erases newer feedback; fulfillment leaves existing error intact', async t => {
  const { h, sdk } = await app(t); sdk.emit('error', new Error('earlier')); close(h).click();
  sdk.emit('error', new Error('newer')); sdk.closes[0]!.work.reject('old close'); await flush(); notice(h, 'newer');
  close(h).click(); sdk.closes[1]!.work.resolve(); await flush(); notice(h, 'newer');
});

async function setup(t: TestContext) {
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; c.rooms.controllerGraceMs = 60_000; });
  const server = harness(config), host = await server.create('Synthetic original controller');
  const h = await actualApp(t, { confirm: () => true });
  let serverWork = Promise.resolve(), sequence = 0, holdCloseAck = false;
  let beforeClose: (() => Promise<void>) | undefined;
  const validated: ClientMessage[] = [], incoming: ServerMessage[] = [], held: ServerMessage[] = [];
  const sessions = new Map<StageSocket, Session>();
  const closes: { socket: StageSocket; code: number | undefined }[] = [];
  const originalClose = StageSocket.prototype.close;
  t.mock.method(StageSocket.prototype, 'close', function (this: StageSocket, code?: number) {
    closes.push({ socket: this, code }); originalClose.call(this);
    const session = sessions.get(this);
    if (session) serverWork = serverWork.then(() => server.hub.detach(session, code === 1000));
  });
  t.mock.method(StageSocket.prototype, 'send', function (this: StageSocket, data: string) {
    const message = parseClientMessage(data, config.limits), session = sessions.get(this);
    assert.ok(session); this.sent.push(message); validated.push(message);
    serverWork = serverWork.then(async () => {
      if (message.type === 'room:close') await beforeClose?.();
      await server.hub.handle(session, message);
    });
  });
  const bind = (socket: StageSocket) => {
    const session: Session = { id: `embed-close-${++sequence}`,
      send(message) {
        incoming.push(message);
        if (holdCloseAck && message.type === 'ok' && validated.some(request => request.type === 'room:close' && request.requestId === message.requestId)) {
          held.push(message); return;
        }
        if (socket.readyState === StageSocket.OPEN) socket.deliver(message);
      },
      close() { socket.close(); },
    };
    sessions.set(socket, session); server.hub.attach(session); return session;
  };
  t.after(async () => { await flush(); await serverWork; await server.hub.shutdown(); await server.transport.close(); });
  h.node('room').value = host.roomId; h.node('code').value = host.code; h.node('name').value = 'Synthetic embed participant';
  h.form.submit(); await flush(); const socket = StageSocket.instances[0]!, session = bind(socket);
  await h.until(() => h.clients[0]?.me != null, 'whole embed entered through actual SDK');
  await h.tick(200); await serverWork; await flush();
  const client = h.clients[0] as StageClient, pid = client.me!.participantId;
  const req = async (actor: FakeSession, message: Omit<ClientMessage, 'requestId'> & Record<string, unknown>) => {
    const requestId = `setup-${++sequence}`;
    await server.hub.handle(actor, parseClientMessage(JSON.stringify({ ...message, requestId }), config.limits));
    const reply = actor.inbox.find(m => (m.type === 'ok' || m.type === 'error') && m.requestId === requestId);
    assert.ok(reply); return reply.type === 'error' ? reply.code : 'ok';
  };
  const drain = async () => { await h.tick(200); await serverWork; await flush(); };
  const flushStates = async () => {
    for (const timer of server.timers) if (!timer.cleared && (timer.ms === 0 || timer.ms === config.rooms.presenceBroadcastMs)) {
      timer.cleared = true; timer.fn();
    }
    await nextTurn(); await flush();
  };
  const controller = async (onStage = false) => {
    assert.equal(await req(host.s, { type: 'control:transfer', targetId: pid }), 'ok'); await flush();
    assert.equal(client.me!.role, 'controller'); assert.equal(client.me!.onStage, false);
    if (onStage) { const work = client.returnToStage(); await drain(); await work; assert.equal(client.me!.onStage, true); }
  };
  const sdkGuest = async () => {
    const audio = { autoplay: true, srcObject: null, volume: 1, muted: false, pause() {}, async play() {} };
    const guest = new StageClient({ url: 'wss://stage.example.test/ws', audioElement: audio as unknown as HTMLAudioElement });
    h.clients.push(guest); const work = guest.join({ roomId: host.roomId, code: host.code, name: 'Synthetic SDK guest' });
    const socket = StageSocket.instances.at(-1)!, session = bind(socket);
    await h.until(() => guest.me !== null, 'actual guest SDK joined'); await drain(); await work;
    return { client: guest, socket, session, peer: StagePeer.instances.at(-1)! };
  };
  return { config, server, host, h, client, socket, session, pid, validated, incoming, held, closes,
    controller, sdkGuest, req, drain, flushStates, bind,
    holdAck: () => { holdCloseAck = true; }, beforeClose: (work: () => Promise<void>) => { beforeClose = work; } };
}

for (const onStage of [false, true]) it(`whole embed Leave from controller onStage=${onStage} retains room/grace and permits successor`, async t => {
  const f = await setup(t); await f.controller(onStage); const guest = await f.sdkGuest();
  const guestId = guest.client.me!.participantId, before = f.validated.filter(m => m.type === 'room:close').length;
  f.h.leave.click(); await f.drain(); await f.flushStates();
  assert.equal(f.closes.find(c => c.socket === f.socket)?.code, 1000);
  assert.equal(f.client.status, 'disconnected'); assert.equal(f.h.status.textContent, '已離開。');
  assert.equal(f.validated.filter(m => m.type === 'room:close').length, before);
  assert.equal(f.server.hub.roomCount, 1); assert.equal(f.server.transport.rooms.has(f.host.roomId), true);
  assert.equal(guest.client.state!.controllerId, f.pid); assert.notEqual(guest.client.status, 'disconnected');
  assert.equal(f.incoming.some(m => m.type === 'room:closed'), false);
  const grace = f.server.timers.find(timer => !timer.cleared && timer.ms === f.config.rooms.controllerGraceMs); assert.ok(grace);
  const late = new FakeSession(); f.server.hub.attach(late);
  assert.equal(await f.req(late, { type: 'join', roomId: f.host.roomId, code: f.host.code, name: 'Still joinable' }), 'ok');
  grace.cleared = true; grace.fn(); await nextTurn(); await f.flushStates();
  assert.equal(f.server.hub.roomCount, 1); assert.notEqual(guest.client.state!.controllerId, f.pid);
  assert.equal(f.incoming.some(m => m.type === 'room:closed'), false);
  assert.ok(guestId); assert.equal(f.h.confirmations.length, 0);
});
for (const onStage of [false, true]) it(`confirmed button→actual SDK→validator→Hub controller close onStage=${onStage} removes all room seats/media and terminates full embed`, async t => {
  const f = await setup(t); await f.controller(onStage); const guest = await f.sdkGuest();
  close(f.h).click(); await f.drain();
  assert.deepEqual(f.h.confirmations, [consent]);
  assert.deepEqual(f.validated.filter(m => m.type === 'room:close').map(m => Object.keys(m).sort()), [['requestId', 'type']]);
  assert.equal(f.server.hub.roomCount, 0); assert.equal(f.server.transport.rooms.has(f.host.roomId), false);
  assert.equal(f.server.hub.isJoined(f.session), false); assert.equal(f.server.hub.isJoined(guest.session), false);
  assert.equal(f.client.status, 'disconnected'); assert.equal(guest.client.status, 'disconnected');
  assert.equal(f.client.me, null); assert.equal(guest.client.me, null); assert.equal(f.h.status.textContent, '房間已關閉。');
  assert.equal(f.h.leave.disabled, true); assert.equal(f.h.node('room-name-panel').hidden, true);
  assert.equal(f.host.s.last('room:closed')?.roomId, f.host.roomId);
  assert.ok(f.server.timers.every(timer => timer.cleared));
  assert.ok(StagePeer.instances.every(peer => peer.connectionState === 'closed'));
  assert.ok(f.h.tracks.every(track => track.stopped));
  const late = new FakeSession(); f.server.hub.attach(late);
  assert.equal(await f.req(late, { type: 'join', roomId: f.host.roomId, code: f.host.code, name: 'Closed room' }), 'unauthorized');
  const sockets = StageSocket.instances.length; await f.h.tick(30000); assert.equal(StageSocket.instances.length, sockets);
});
for (const role of ['audience', 'speaker'] as const) it(`actual ${role} SDK close is rejected by Hub without teardown`, async t => {
  const f = await setup(t);
  if (role === 'speaker') { const raising = f.client.raiseHand(); await f.drain(); await raising; assert.equal(await f.req(f.host.s, { type: 'stage:approve', targetId: f.pid }), 'ok'); await f.drain(); }
  assert.equal(f.client.me!.role, role);
  force(close(f.h)); assert.equal(f.h.confirmations.length, 0);
  assert.equal(f.validated.some(message => message.type === 'room:close'), false);
  const work = f.client.closeRoom().then(() => 'ok', error => error.code); await f.drain();
  assert.equal(await work, 'forbidden'); assert.equal(f.server.hub.roomCount, 1);
  assert.equal(f.server.hub.isJoined(f.session), true); assert.equal(f.incoming.some(m => m.type === 'room:closed'), false);
});
it('validator strips untrusted target and role fields; request ID remains mandatory', () => {
  const limits = testConfig().limits;
  assert.deepEqual(parseClientMessage(JSON.stringify({ type: 'room:close', requestId: 'close-test', roomId: 'other-room', targetId: 'other-person', role: 'controller' }), limits), { type: 'room:close', requestId: 'close-test' });
  assert.throws(() => parseClientMessage(JSON.stringify({ type: 'room:close' }), limits), /bad_request|請求|Invalid/i);
});
it('close checked at execution rejects a caller that lost control before Hub handles the SDK frame', async t => {
  const f = await setup(t); await f.controller();
  f.beforeClose(async () => {
    // A concurrent server role transition is serialized ahead of this command.
    const request = parseClientMessage(JSON.stringify({ type: 'control:transfer', requestId: 'race-transfer', targetId: f.host.id }), f.config.limits);
    await f.server.hub.handle(f.session, request);
  });
  close(f.h).click(); await f.drain();
  assert.deepEqual(f.h.confirmations, [consent]);
  assert.ok(f.incoming.some(message => message.type === 'error' && message.code === 'forbidden')); assert.equal(f.client.me!.role, 'audience'); assert.equal(f.server.hub.roomCount, 1);
  assert.equal(f.incoming.some(m => m.type === 'room:closed'), false);
});
it('terminal close with delayed ACK retires old close rejection and never reconnects', async t => {
  const f = await setup(t); await f.controller(); f.holdAck();
  let outcome = ''; const original = f.client.closeRoom.bind(f.client);
  t.mock.method(f.client, 'closeRoom', () => original().catch(error => { outcome = error.code; throw error; }));
  close(f.h).click(); await f.drain();
  assert.equal(outcome, 'disconnected'); assert.equal(f.held.length, 1);
  assert.deepEqual(f.h.confirmations, [consent]);
  assert.equal(f.h.status.textContent, '房間已關閉。'); assert.equal(f.h.node('error-notice').hidden, true);
  for (const ack of f.held) f.socket.deliver(ack); await f.h.tick(30000);
  assert.equal(f.h.status.textContent, '房間已關閉。'); assert.equal(StageSocket.instances.length, 1);
});
it('full embed current terminal cannot overwrite reentrant new entry started by host disconnected listener', async t => {
  const f = await setup(t); await f.controller(); let entered = false;
  f.client.on('status', ({ detail }) => { if (detail === 'disconnected' && !entered) { entered = true; f.h.form.submit(); } });
  close(f.h).click(); await f.drain();
  assert.deepEqual(f.h.confirmations, [consent]);
  assert.equal(entered, true); assert.equal(f.h.status.textContent, '連線中…');
  assert.equal(f.h.form.submitButton!.disabled, true); assert.equal(f.h.node('cancel-join').hidden, false);
  assert.equal(StageSocket.instances.length, 2); assert.equal(f.server.hub.roomCount, 0);
  f.socket.deliver({ type: 'room:closed', roomId: f.host.roomId }); await flush();
  assert.equal(f.h.status.textContent, '連線中…'); assert.equal(f.h.clients.length, 2);
});

for (const event of ['state', 'status'] as const) it(`${event} close-control render reentry cannot overwrite a new pending entry or re-enable Leave`, async t => {
  const gate = new Deferred();
  const { h, sdk } = await app(t, { libraryLoad: async (_url, count) => { if (count === 2) await gate.promise; } });
  t.after(() => { if (!gate.settled) gate.resolve(); });
  let once = true;
  const restore = observeDisabled(close(h), value => { if (once && value) { once = false; h.form.submit(); } });
  t.after(restore);
  if (event === 'state') snapshot(sdk, { me: { connected: false } }); else sdk.setStatus('reconnecting');
  assert.equal(h.leave.disabled, true, 'old state continuation cannot re-enable Leave');
  assert.equal(h.node('cancel-join').hidden, false); assert.equal(h.submit.disabled, true);
  await flush(); assert.equal(h.status.textContent, '載入舞台元件中…');
  gate.resolve(); await flush(); assert.equal(close(h).hidden, true); assert.equal(close(h).disabled, true);
});

for (const event of ['role', 'transferred'] as const) for (const direction of ['transfer render to close', 'close render to transfer'] as const)
  it(`own ${event} fences both confirmations before ${direction} callback`, async t => {
    const { h, sdk } = await app(t); snapshot(sdk, { speakers: [speaker()] }); let once = true;
    const rendering = direction === 'transfer render to close' ? transfer(h) : close(h);
    const reenter = direction === 'transfer render to close' ? close(h) : transfer(h);
    const restore = observeDisabled(rendering, value => { if (once && value) { once = false; force(reenter); } });
    t.after(restore);
    sdk.emit(event, event === 'role' ? { participantId: 'listener', role: 'audience' } : { fromId: 'listener', toId: 'other' });
    assert.equal(h.confirmations.length, 0); assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
    snapshot(sdk); reenter.click(); assert.equal(h.confirmations.length, 1);
  });
for (const boundary of ['hidden panel', 'missing capability', 'local disconnected', 'reconnect', 'room identity', 'target role'] as const)
  it(`reciprocal admission guard preserves existing transfer reconciliation for ${boundary}`, async t => {
    const { h, sdk } = await app(t); snapshot(sdk, { speakers: [speaker()] });
    const panel = h.node('stage-management'), button = transfer(h), row = button.parentElement!.parentElement!;
    if (boundary === 'hidden panel') panel.hidden = true;
    else if (boundary === 'missing capability') Reflect.set(sdk, 'transferControl', undefined);
    else if (boundary === 'local disconnected') sdk.state!.me.connected = false;
    else if (boundary === 'reconnect') sdk.status = 'reconnecting';
    else if (boundary === 'room identity') sdk.state!.roomId = 'new-room';
    else sdk.state!.speakers[0]!.role = 'audience';
    button.click(); assert.equal(sdk.transfers.length, boundary === 'hidden panel' ? 1 : 0);
    if (boundary === 'hidden panel') assert.equal(panel.hidden, false);
    else if (boundary === 'missing capability') assert.equal(button.hidden, true);
    else if (boundary === 'target role') assert.equal(row.parentElement, null);
    else assert.equal(button.disabled, true);
    assert.equal(sdk.closes.length, 0);
  });
