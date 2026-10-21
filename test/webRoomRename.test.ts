import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { decodeName } from '../packages/client/src/index.ts';
import type { ClientMessage, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { parseClientMessage, sanitizeName } from '../src/ws/validate.ts';
import { actualApp, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';
import { harness, testConfig } from './helpers.ts';

type App = ReturnType<typeof sampleApp>;
type View = Pick<App, 'app' | 'find'>;
const clone = <T>(value: T): T => structuredClone(value);
const rename = (h: View): SampleNode => h.find(node => node.dataset.roomAction === 'room-rename');
const renameNodes = (h: View): SampleNode[] => h.app.descendants().filter(node => node.dataset.roomAction === 'room-rename');
const errorBox = (h: View): SampleNode => h.find(node => node.attributes.role === 'alert');
const title = (h: View): SampleNode => h.find(node => node.tagName === 'h1');
const invite = (h: View): SampleNode => h.find(node => node.classList.contains('invite-link'));
function controllerState(onStage = true): RoomStatePayload {
  const state = roomState({ participantId: 'controller', role: 'controller', onStage });
  state.audience = onStage ? [] : [state.me]; return state;
}
async function setup(t: TestContext, initial = controllerState(), answer: string | null = '新房間名稱') {
  const prompts: { message: string; defaultValue: string }[] = [];
  const requests: { name: string; work: Deferred<void> }[] = [];
  let duringPrompt: (() => void) | undefined;
  const h = sampleApp({ decodeName, prompt(message, defaultValue) {
    prompts.push({ message, defaultValue }); duringPrompt?.(); return answer;
  } });
  Object.assign(h.sdk, { setRoomName(name: string) {
    const work = new Deferred<void>(); requests.push({ name, work }); return work.promise;
  } });
  t.after(async () => {
    // Deliberate late results outlive SDK disconnect to exercise stale UI settlements.
    for (const request of requests) if (request.work.status === 'pending') request.work.resolve(undefined);
    await h.cleanup();
  });
  await flushSample(); h.sdk.snapshot(clone(initial));
  return { ...h, prompts, requests, setAnswer(value: string | null) { answer = value; },
    duringPrompt(callback: () => void) { duringPrompt = callback; } };
}

for (const onStage of [true, false]) {
  it(`whole sample controller onStage=${onStage} has one room-title action in its room summary`, async t => {
    const state = controllerState(onStage), h = await setup(t, state), node = rename(h);
    assert.equal(node.tagName, 'button'); assert.equal(node.type, 'button'); assert.equal(node.textContent, '修改房間名稱');
    assert.ok(node.parentNode?.classList.contains('room-summary')); assert.equal(node.disabled, false);
    node.click(); assert.deepEqual(h.prompts, [{ message: '輸入新的房間名稱', defaultValue: state.name }]);
    assert.deepEqual(h.requests.map(request => request.name), ['新房間名稱']);
    assert.equal(node.disabled, true); assert.equal(node.attributes['aria-busy'], 'true');
    assert.equal(title(h).textContent, state.name, 'no optimistic title change');
    h.requests[0]!.work.resolve(undefined); await flushSample();
    assert.equal(node.disabled, false); assert.equal(node.attributes['aria-busy'], 'false');
    assert.equal(title(h).textContent, state.name, 'ACK alone does not replace authoritative state');
  });
}
for (const [role, onStage, handRaised] of [['audience', false, false], ['audience', false, true], ['speaker', true, false]] as const) {
  it(`whole sample hides room-title editing for ${role}, handRaised=${handRaised}`, async t => {
    const h = await setup(t, roomState({ role, onStage, handRaised }));
    assert.equal(renameNodes(h).length, 0); assert.equal(h.prompts.length, 0); assert.equal(h.requests.length, 0);
    assert.equal(h.app.descendants().filter(node => node.dataset.roomAction === 'rename').length, 1, 'personal rename remains independent');
  });
}

for (const raw of ['<img src=x> & "\'喵', 'Alice &amp; Bob', '🌙 Café 茶室']) {
  it(`whole sample room-title default decodes once and keeps ${JSON.stringify(raw)} inert`, async t => {
    const state = controllerState(); state.name = sanitizeName(raw, 32)!;
    const h = await setup(t, state, null); rename(h).click(); await flushSample();
    assert.equal(h.prompts[0]!.defaultValue, raw); assert.equal(title(h).textContent, raw);
    assert.equal(title(h).children.length, 0); assert.equal(h.requests.length, 0);
    assert.equal(h.app.descendants().some(node => ['img', 'script', 'iframe'].includes(node.tagName)), false);
  });
}
it('whole sample canceled room-title prompt and default fixture prompt send nothing and release the lock', async t => {
  const h = await setup(t, controllerState(), null); rename(h).click(); await flushSample();
  assert.equal(h.requests.length, 0); assert.equal(rename(h).disabled, false); assert.equal(rename(h).attributes['aria-busy'], 'false');
  const plain = sampleApp(); t.after(() => plain.cleanup()); await flushSample(); plain.sdk.snapshot(controllerState());
  const calls = t.mock.method(plain.sdk, 'setRoomName'); rename(plain).click(); await flushSample();
  assert.equal(calls.mock.calls.length, 0); assert.equal(rename(plain).disabled, false); assert.equal(errorBox(plain).hidden, true);
});
for (const value of ['', '   ', ' Cafe\u0301\u0000 & <茶> ', '🌙'.repeat(32), 'x'.repeat(100)]) {
  it(`whole sample room-title action forwards raw ${JSON.stringify(value)} to server validation`, async t => {
    const h = await setup(t, controllerState(), value); rename(h).click();
    assert.deepEqual(h.requests.map(request => request.name), [value]);
    h.requests[0]!.work.reject(new Error('伺服器拒絕此房間名稱。')); await flushSample();
    assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '伺服器拒絕此房間名稱。');
    assert.equal(rename(h).disabled, false); assert.equal(title(h).textContent, '測試舞台');
  });
}

it('whole sample room-title pending survives state-before-ACK redraw and blocks duplicate old and new controls', async t => {
  const state = controllerState(), h = await setup(t, state, '茶室 & <新名>'), old = rename(h);
  old.click(); old.onclick!(); assert.equal(h.requests.length, 1); assert.equal(h.prompts.length, 1);
  const next = clone(state); next.name = sanitizeName('茶室 & <新名>', 32)!; h.sdk.snapshot(next);
  const current = rename(h); assert.notEqual(current, old); assert.equal(old.isConnected, false);
  assert.equal(current.disabled, true); assert.equal(current.attributes['aria-busy'], 'true'); assert.equal(title(h).textContent, '茶室 & <新名>');
  current.disabled = old.disabled = false; current.onclick!(); old.onclick!();
  assert.equal(h.requests.length, 1); assert.equal(h.prompts.length, 1); h.sdk.snapshot(clone(next)); assert.equal(current.disabled, true);
  h.requests[0]!.work.resolve(undefined); await flushSample();
  assert.equal(rename(h), current); assert.equal(current.disabled, false); assert.equal(current.attributes['aria-busy'], 'false');
  current.click(); assert.equal(h.prompts[1]!.defaultValue, '茶室 & <新名>'); assert.equal(h.requests.length, 2);
});
for (const transition of ['same-seat redraw', 'stage leave', 'transient reconnect recovery'] as const) {
  it(`whole sample room-title prompt accepts ${transition} with current controller authority`, async t => {
    const state = controllerState(), h = await setup(t, state), old = rename(h);
    h.duringPrompt(() => {
      if (transition === 'transient reconnect recovery') { h.sdk.setStatus('reconnecting'); h.sdk.setStatus('live'); }
      else { const next = clone(state); next.name = 'Changed while prompting';
        if (transition === 'stage leave') { next.me.onStage = false; next.speakers = []; next.audience = [next.me]; }
        h.sdk.snapshot(next);
      }
    });
    old.click(); assert.equal(h.requests.length, 1); assert.equal(h.prompts.length, 1);
    assert.equal(rename(h).disabled, true); h.requests[0]!.work.resolve(undefined); await flushSample(); assert.equal(rename(h).disabled, false);
  });
}
for (const transition of ['room', 'participant', 'role loss', 'disconnect', 'same-identity rejoin', 'reconnecting'] as const) {
  it(`whole sample room-title prompt discards its answer after ${transition}`, async t => {
    const state = controllerState(), h = await setup(t, state);
    h.duringPrompt(() => {
      if (transition === 'reconnecting') h.sdk.setStatus('reconnecting');
      else if (transition === 'disconnect' || transition === 'same-identity rejoin') {
        void h.sdk.disconnect(); if (transition === 'same-identity rejoin') h.sdk.snapshot(clone(state));
      } else { const next = clone(state); if (transition === 'room') next.roomId = 'replacement';
        else if (transition === 'participant') next.me.participantId = 'replacement'; else next.me.role = 'speaker'; h.sdk.snapshot(next); }
    });
    rename(h).click(); await flushSample(); assert.equal(h.prompts.length, 1); assert.equal(h.requests.length, 0);
    if (h.sdk.me?.role === 'controller') { assert.equal(rename(h).disabled, transition === 'reconnecting'); assert.equal(rename(h).attributes['aria-busy'], 'false'); }
    assert.equal(errorBox(h).hidden, true);
  });
}
for (const invalid of ['detached redraw', 'room', 'participant', 'role loss', 'disconnected', 'reconnecting', 'explicitly disabled'] as const) {
  it(`whole sample room-title ${invalid} handler bypass cannot prompt, clear errors or send`, async t => {
    const state = controllerState(), h = await setup(t, state), old = rename(h);
    if (invalid === 'disconnected') await h.sdk.disconnect();
    else if (invalid === 'reconnecting') h.sdk.setStatus('reconnecting');
    else if (invalid !== 'explicitly disabled') {
      const next = clone(state); if (invalid === 'room') next.roomId = 'replacement';
      else if (invalid === 'participant') next.me.participantId = 'replacement';
      else if (invalid === 'role loss') next.me.role = 'speaker'; else next.name = 'Changed room'; h.sdk.snapshot(next);
    }
    h.sdk.emit('error', { message: 'Keep current error' }); old.disabled = invalid === 'explicitly disabled'; old.onclick!(); await flushSample();
    assert.equal(h.prompts.length, 0); assert.equal(h.requests.length, 0);
    assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, 'Keep current error');
    if (h.sdk.me?.role === 'controller') assert.equal(rename(h).attributes['aria-busy'], 'false');
  });
}
for (const mutation of ['room', 'participant', 'role', 'status', 'state cleared'] as const) {
  it(`whole sample room-title consults live ${mutation} before opening a dialog even without a redraw`, async t => {
    const h = await setup(t), old = rename(h); assert.ok(h.sdk.state);
    if (mutation === 'room') h.sdk.state.roomId = 'different-room';
    else if (mutation === 'participant') h.sdk.state.me.participantId = 'different-participant';
    else if (mutation === 'role') h.sdk.state.me.role = 'speaker';
    else if (mutation === 'status') h.sdk.status = 'reconnecting'; else h.sdk.state = null;
    h.sdk.emit('error', { message: 'Untouched error' }); old.disabled = false; old.onclick!(); await flushSample();
    assert.equal(h.prompts.length, 0); assert.equal(h.requests.length, 0); assert.equal(errorBox(h).textContent, 'Untouched error');
  });
}
for (const outcome of ['resolve', 'reject'] as const) {
  for (const replacement of ['room', 'participant', 'same-identity rejoin'] as const) {
    it(`whole sample ignores old room-title ${outcome} after ${replacement} without unlocking a new request`, async t => {
      const state = controllerState(), h = await setup(t, state), old = rename(h); old.click(); const next = clone(state);
      if (replacement === 'same-identity rejoin') await h.sdk.disconnect();
      else if (replacement === 'room') next.roomId = 'replacement'; else next.me.participantId = 'replacement';
      h.sdk.snapshot(next); const current = rename(h); current.click(); assert.equal(h.requests.length, 2);
      h.sdk.emit('error', { message: 'Current error' });
      if (outcome === 'resolve') h.requests[0]!.work.resolve(undefined); else h.requests[0]!.work.reject(new Error('Retired failure'));
      await flushSample(); assert.equal(current.disabled, true); assert.equal(current.attributes['aria-busy'], 'true');
      assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, 'Current error');
      old.disabled = false; old.onclick!(); assert.equal(h.requests.length, 2); assert.equal(h.prompts.length, 2);
      h.requests[1]!.work.resolve(undefined); await flushSample(); assert.equal(current.disabled, false);
    });
  }
  it(`whole sample room-title ${outcome} after role loss never recreates controller controls`, async t => {
    const state = controllerState(), h = await setup(t, state); rename(h).click();
    const next = clone(state); next.me.role = 'speaker'; h.sdk.snapshot(next); assert.equal(renameNodes(h).length, 0);
    if (outcome === 'resolve') h.requests[0]!.work.resolve(undefined); else h.requests[0]!.work.reject(new Error('Current failure'));
    await flushSample(); assert.equal(renameNodes(h).length, 0); assert.equal(errorBox(h).hidden, outcome === 'resolve');
    h.sdk.snapshot(clone(state)); assert.equal(rename(h).disabled, false); assert.equal(rename(h).attributes['aria-busy'], 'false');
  });
  for (const terminal of ['disconnect', 'closed', 'kicked'] as const) {
    it(`whole sample terminal ${terminal} suppresses obsolete room-title ${outcome}`, async t => {
      const h = await setup(t), old = rename(h); old.click();
      if (terminal === 'disconnect') await h.sdk.disconnect(); else await h.sdk.terminal(terminal);
      const currentError = errorBox(h).textContent, hidden = errorBox(h).hidden;
      if (outcome === 'resolve') h.requests[0]!.work.resolve(undefined); else h.requests[0]!.work.reject(new Error('Obsolete title failure'));
      await flushSample(); assert.equal(renameNodes(h).length, 0); assert.equal(old.isConnected, false);
      assert.equal(errorBox(h).textContent, currentError); assert.equal(errorBox(h).hidden, hidden);
    });
  }
}
it('whole sample room-title rejection after redraw allows retry and settlement retains reconnect disabling', async t => {
  const state = controllerState(), h = await setup(t, state); rename(h).click();
  h.sdk.snapshot({ ...clone(state), name: 'Authoritative title' }); h.requests[0]!.work.reject(new Error('Current title failure')); await flushSample();
  assert.equal(errorBox(h).textContent, 'Current title failure'); assert.equal(errorBox(h).hidden, false); assert.equal(rename(h).disabled, false);
  rename(h).click(); assert.equal(errorBox(h).hidden, true); h.sdk.setStatus('reconnecting');
  h.requests[1]!.work.resolve(undefined); await flushSample(); assert.equal(rename(h).disabled, true); assert.equal(rename(h).attributes['aria-busy'], 'false');
  h.sdk.setStatus('live'); assert.equal(rename(h).disabled, false); assert.equal(title(h).textContent, 'Authoritative title');
});
it('whole sample catches a synchronous room-title SDK error and releases the lock', async t => {
  const h = await setup(t); Object.assign(h.sdk, { setRoomName() { throw new Error('Synchronous title failure'); } });
  rename(h).click(); await flushSample(); assert.equal(errorBox(h).textContent, 'Synchronous title failure');
  assert.equal(rename(h).disabled, false); assert.equal(rename(h).attributes['aria-busy'], 'false');
});

it('real Hub room-title snapshots update every role without changing room codes, invitations, membership or private visibility', async t => {
  const hub = harness(testConfig(config => { config.rooms.presenceBroadcastMs = 0; }));
  const host = await hub.create('主持人'), speaker = await hub.join(host.roomId, host.code, '發言者');
  const raised = await hub.join(host.roomId, host.code, '舉手觀眾'), hidden = await hub.join(host.roomId, host.code, '私人觀眾');
  t.after(async () => { if (hub.hub.isJoined(host.s)) await hub.req(host.s, { type: 'room:close' }); });
  assert.equal(await hub.req(speaker.s, { type: 'hand:raise' }), 'ok');
  assert.equal(await hub.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
  assert.equal(await hub.req(raised.s, { type: 'hand:raise' }), 'ok');
  for (const timer of hub.timers.filter(timer => timer.ms === 0 && !timer.cleared)) { timer.cleared = true; timer.fn(); }
  const controller = await setup(t, host.s.last('room:state')!), onstage = await setup(t, speaker.s.last('room:state')!);
  const offstage = await setup(t, raised.s.last('room:state')!), privateSelf = await setup(t, hidden.s.last('room:state')!);
  const viewers = [[controller, host], [onstage, speaker], [offstage, raised], [privateSelf, hidden]] as const;
  const before = viewers.map(([, seat]) => clone(seat.s.last('room:state')!)), link = invite(controller).value;
  const summary = controller.find(node => node.classList.contains('room-summary')).textContent;
  Object.assign(controller.sdk, { async setRoomName(name: string) {
    assert.equal(await hub.req(host.s, parseClientMessage(JSON.stringify({ type: 'room:rename', name, requestId: 'ui-title' }), testConfig().limits)), 'ok');
    for (const [app, seat] of viewers) app.sdk.snapshot(clone(seat.s.last('room:state')!));
  } });
  controller.setAnswer('🌙 Café & <茶室>'); rename(controller).click(); await flushSample();
  for (const [index, [app, seat]] of viewers.entries()) {
    assert.equal(title(app).textContent, '🌙 Café & <茶室>'); assert.equal(title(app).children.length, 0);
    const after = clone(seat.s.last('room:state')!); after.name = before[index]!.name; assert.deepEqual(after, before[index]);
    if (app !== controller) { assert.equal(renameNodes(app).length, 0); assert.equal(app.sdk.state?.audience, undefined); }
  }
  assert.equal(invite(controller).value, link); assert.equal(controller.find(node => node.classList.contains('room-summary')).textContent, summary);
  assert.doesNotMatch(onstage.app.textContent, /私人觀眾/); assert.doesNotMatch(offstage.app.textContent, /私人觀眾/);
  assert.equal(await hub.req(host.s, { type: 'room:close' }), 'ok');
});

it('whole sample public SDK room-title command routes through validator and real Hub, holds ACK, handles unknown_type and preserves media', async t => {
  let cleanup = async (): Promise<void> => {}; t.after(() => cleanup());
  const boundary = await actualApp(t), config = testConfig(config => { config.rooms.presenceBroadcastMs = 0; });
  const hub = harness(config), host = await hub.create('主持人');
  t.after(async () => { if (hub.hub.isJoined(host.s)) await hub.req(host.s, { type: 'room:close' }); });
  boundary.form.submit(); await flushSample(); const sdk = boundary.clients[0]!;
  let answer = ' Cafe\u0301\u0000 & <茶> ', oldServer = false, held: ServerMessage | undefined;
  const h = sampleApp({ sdk, decodeName, prompt: () => answer }); cleanup = () => h.cleanup();
  const socket = StageSocket.instances[0]!;
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await boundary.until(() => socket.sent.some(message => message.type === 'join'), 'public SDK join request');
  const joining = socket.sent.find(message => message.type === 'join')!;
  socket.deliver(host.s.last('room:state')!); socket.deliver({ type: 'ok', requestId: joining.requestId });
  const peer = StagePeer.instances[0]!;
  await boundary.until(() => peer.transceiver.sender.track !== null && peer.localDescription !== null && peer.signalingState === 'stable', 'healthy initial publisher');
  const track = peer.transceiver.sender.track!, before = { captures: boundary.captures.length, offers: [...peer.offers], replacements: [...peer.replacements], peers: [...StagePeer.instances] };
  const wire = socket.send.bind(socket), send = host.s.send.bind(host.s), pending: Promise<void>[] = [];
  t.mock.method(host.s, 'send', (message: ServerMessage, encoded?: string) => {
    send(message, encoded); if (message.type === 'ok') held = message; else socket.deliver(message);
  });
  t.mock.method(socket, 'send', (data: string) => {
    wire(data); const message = JSON.parse(data) as ClientMessage;
    if (message.type !== 'room:rename') return;
    if (oldServer) socket.deliver({ type: 'error', requestId: message.requestId, code: 'unknown_type', message: '不支援的操作。' });
    else pending.push(hub.hub.handle(host.s, parseClientMessage(data, config.limits)));
  });
  const commands = socket.sent.length, old = rename(h); old.click(); old.onclick!();
  await boundary.until(() => socket.sent.some(message => message.type === 'room:rename'), 'public SDK room-title command');
  await Promise.all(pending); await flushSample();
  const request = socket.sent.find(message => message.type === 'room:rename')!;
  assert.deepEqual(request, { type: 'room:rename', name: answer, requestId: request.requestId });
  assert.equal(socket.sent.length, commands + 1); assert.equal(title(h).textContent, 'Café & <茶>'); assert.equal(old.isConnected, false);
  assert.equal(rename(h).disabled, true); assert.equal(rename(h).attributes['aria-busy'], 'true'); assert.ok(held);
  rename(h).disabled = false; rename(h).onclick!(); assert.equal(socket.sent.length, commands + 1);
  socket.deliver(held); held = undefined; await flushSample(); assert.equal(rename(h).disabled, false);
  oldServer = true; answer = 'Old server unsupported'; rename(h).click();
  await boundary.until(() => socket.sent.length === commands + 2, 'old-server room-title request');
  assert.equal(socket.sent.length, commands + 2); assert.equal(errorBox(h).hidden, false); assert.match(errorBox(h).textContent, /不支援的操作/);
  assert.equal(rename(h).disabled, false); assert.equal(title(h).textContent, 'Café & <茶>');
  oldServer = false; answer = 'Retry title'; rename(h).click();
  await boundary.until(() => socket.sent.length === commands + 3, 'retried room-title request'); await Promise.all(pending); await flushSample();
  assert.ok(held); assert.equal(rename(h).disabled, true); socket.deliver(held); await flushSample();
  assert.equal(title(h).textContent, 'Retry title'); assert.equal(rename(h).disabled, false); assert.equal(errorBox(h).hidden, true);
  assert.equal(socket.sent.length, commands + 3); assert.equal(boundary.captures.length, before.captures); assert.deepEqual(peer.offers, before.offers);
  assert.deepEqual(peer.replacements.slice(0, before.replacements.length), before.replacements);
  assert.ok(peer.replacements.slice(before.replacements.length).every(replacement => replacement === track), 'snapshot reconciliation may reapply only the existing healthy track');
  assert.deepEqual(StagePeer.instances, before.peers); assert.equal(peer.transceiver.sender.track, track);
  assert.equal(track.stopped, false); assert.equal(track.stops, 0); assert.equal(track.enabled, true);
  assert.equal(peer.transceiver.direction, 'sendrecv'); assert.equal(peer.connectionState, 'connected');
});
