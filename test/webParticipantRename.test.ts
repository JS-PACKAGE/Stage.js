import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import { decodeName } from '../packages/client/src/index.ts';
import { sanitizeName } from '../src/ws/validate.ts';
import { actualApp, actualState, StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';
import { harness, testConfig } from './helpers.ts';

type App = ReturnType<typeof sampleApp>;
type View = Pick<App, 'app' | 'find' | 'id'>;
const clone = <T>(value: T): T => structuredClone(value);
const rename = (h: View): SampleNode => h.find(node => node.dataset.roomAction === 'rename');
const errorBox = (h: View): SampleNode => h.find(node => node.attributes.role === 'alert');
const greeting = (h: View): string => h.find(node => node.tagName === 'h2' && node.textContent.startsWith('你好，')).textContent;
const people = (h: View, id: string): SampleNode[] => h.app.descendants().filter(node => node.classList.contains('person') && node.dataset.participantId === id);
const names = (h: View, id: string): string[] => people(h, id).map(row => row.descendants().find(node => node.tagName === 'strong')!.textContent);
function audienceRows(h: View): SampleNode[] {
  const heading = h.find(node => node.tagName === 'h2' && node.textContent.startsWith('觀眾 ·'));
  return heading.parentNode!.descendants().filter(node => node.classList.contains('person'));
}
function filter(h: View, query: string): SampleNode {
  const input = h.find(node => node.tagName === 'input' && node.type === 'search' && node.id === 'audience-search');
  input.value = query; assert.ok(input.oninput); input.oninput(); return input;
}

async function setup(t: TestContext, initial = roomState(), answer: string | null = 'New name') {
  const prompts: { message: string; defaultValue: string }[] = [];
  const requests: { name: string; work: Deferred<void> }[] = [];
  let duringPrompt: (() => void) | undefined;
  const h = sampleApp({ decodeName, prompt(message, defaultValue) {
    prompts.push({ message, defaultValue }); duringPrompt?.(); return answer;
  } });
  Object.assign(h.sdk, { setName(name: string) {
    const work = new Deferred<void>(); requests.push({ name, work }); return work.promise;
  } });
  t.after(async () => {
    // Test-owned delays deliberately allow late results beyond SDK disconnect ordering.
    for (const request of requests) if (request.work.status === 'pending') request.work.resolve(undefined);
    await h.cleanup();
  });
  await flushSample(); h.sdk.snapshot(clone(initial));
  return { ...h, prompts, requests, setAnswer(value: string | null) { answer = value; },
    duringPrompt(callback: () => void) { duringPrompt = callback; } };
}

for (const [role, onStage, handRaised] of [
  ['audience', false, false], ['audience', false, true], ['speaker', true, false],
  ['controller', true, false], ['controller', false, false],
] as const) {
  it(`whole sample exposes one self rename for ${role}, onStage=${onStage}, handRaised=${handRaised}`, async t => {
    const state = roomState({ role, onStage, handRaised }), h = await setup(t, state);
    const node = rename(h); assert.equal(node.tagName, 'button'); assert.equal(node.type, 'button');
    assert.equal(node.textContent, '修改我的名稱'); assert.equal(node.disabled, false);
    node.click(); assert.deepEqual(h.prompts, [{ message: '輸入新的顯示名稱', defaultValue: state.me.name }]);
    assert.deepEqual(h.requests.map(request => request.name), ['New name']);
    assert.equal(node.disabled, true); assert.equal(node.attributes['aria-busy'], 'true');
    assert.equal(greeting(h), `你好，${state.me.name}`, 'requests do not optimistically rename');
    h.requests[0]!.work.resolve(undefined); await flushSample();
    assert.equal(node.disabled, false); assert.equal(node.attributes['aria-busy'], 'false');
    assert.equal(greeting(h), `你好，${state.me.name}`, 'ACK alone cannot rewrite the snapshot');
  });
}

for (const raw of ['<img src=x> & "\'喵', 'Alice &amp; Bob']) {
  it(`whole sample decodes prompt default exactly once and keeps ${JSON.stringify(raw)} inert`, async t => {
    const escaped = sanitizeName(raw, 32); assert.ok(escaped);
    const state = roomState({ name: escaped, role: 'controller', onStage: true });
    const h = await setup(t, state, null); rename(h).click(); await flushSample();
    assert.equal(h.prompts[0]!.defaultValue, raw); assert.equal(greeting(h), `你好，${raw}`);
    assert.deepEqual(names(h, state.me.participantId), [raw]);
    assert.ok(h.app.descendants().filter(node => node.tagName === 'strong').every(node => node.children.length === 0));
    assert.equal(h.app.descendants().some(node => ['img', 'script', 'iframe'].includes(node.tagName)), false);
    assert.equal(h.requests.length, 0);
  });
}

it('whole sample canceled prompt and the default fixture prompt release the lock without requests', async t => {
  const h = await setup(t, roomState(), null); rename(h).click(); await flushSample();
  assert.equal(h.requests.length, 0); assert.equal(rename(h).disabled, false); assert.equal(rename(h).attributes['aria-busy'], 'false');
  const plain = sampleApp(); t.after(() => plain.cleanup()); await flushSample(); plain.sdk.snapshot(roomState());
  const calls = t.mock.method(plain.sdk, 'setName'); rename(plain).click(); await flushSample();
  assert.equal(calls.mock.calls.length, 0); assert.equal(rename(plain).disabled, false); assert.equal(errorBox(plain).hidden, true);
});

for (const value of ['', '   ', ' Cafe\u0301\u0000 & <茶> ', 'x'.repeat(100)]) {
  it(`whole sample forwards raw prompt ${JSON.stringify(value)} for authoritative server validation`, async t => {
    const h = await setup(t, roomState(), value); rename(h).click();
    assert.deepEqual(h.requests.map(request => request.name), [value]);
    h.requests[0]!.work.reject(new Error('伺服器拒絕此名稱。')); await flushSample();
    assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '伺服器拒絕此名稱。');
    assert.equal(rename(h).disabled, false); assert.equal(greeting(h), '你好，測試聽眾');
  });
}

it('whole sample keeps a rename pending across state-before-ACK redraw and blocks duplicate old and new controls', async t => {
  const state = roomState({ role: 'controller', onStage: true }), h = await setup(t, state, 'Accepted & <name>');
  const old = rename(h); old.click(); old.onclick!(); assert.equal(h.requests.length, 1); assert.equal(h.prompts.length, 1);
  const next = clone(state); next.me.name = sanitizeName('Accepted & <name>', 32)!; next.speakers = [next.me];
  h.sdk.snapshot(next); const current = rename(h);
  assert.notEqual(current, old); assert.equal(old.isConnected, false); assert.equal(current.disabled, true);
  assert.equal(current.attributes['aria-busy'], 'true'); assert.equal(greeting(h), '你好，Accepted & <name>');
  assert.deepEqual(names(h, state.me.participantId), ['Accepted & <name>']);
  current.disabled = false; current.onclick!(); old.disabled = false; old.onclick!();
  assert.equal(h.requests.length, 1); assert.equal(h.prompts.length, 1);
  h.sdk.snapshot(clone(next)); assert.equal(current.disabled, true);
  h.requests[0]!.work.resolve(undefined); await flushSample();
  assert.equal(rename(h), current); assert.equal(current.disabled, false); assert.equal(current.attributes['aria-busy'], 'false');
  current.click(); assert.equal(h.prompts[1]!.defaultValue, 'Accepted & <name>');
  assert.equal(h.requests.length, 2);
});

for (const transition of ['same-seat redraw', 'role change', 'transient reconnect recovery'] as const) {
  it(`whole sample permits a prompt return after ${transition} when the current seat is still usable`, async t => {
    const state = roomState(), h = await setup(t, state); const old = rename(h);
    h.duringPrompt(() => {
      if (transition === 'transient reconnect recovery') { h.sdk.setStatus('reconnecting'); h.sdk.setStatus('waiting'); }
      else { const next = clone(state); next.name = 'Updated room'; if (transition === 'role change') next.me.role = 'controller'; h.sdk.snapshot(next); }
    });
    old.click(); assert.equal(h.requests.length, 1); assert.equal(h.prompts.length, 1);
    assert.equal(rename(h).disabled, true); h.requests[0]!.work.resolve(undefined); await flushSample();
    assert.equal(rename(h).disabled, false);
  });
}

for (const transition of ['room', 'participant', 'disconnect', 'same-identity rejoin', 'reconnecting'] as const) {
  it(`whole sample rejects a prompt result after ${transition} invalidates its current seat`, async t => {
    const state = roomState(), h = await setup(t, state);
    h.duringPrompt(() => {
      if (transition === 'reconnecting') h.sdk.setStatus('reconnecting');
      else if (transition === 'disconnect' || transition === 'same-identity rejoin') {
        void h.sdk.disconnect(); if (transition === 'same-identity rejoin') h.sdk.snapshot(clone(state));
      } else { const next = clone(state); if (transition === 'room') next.roomId = 'replacement'; else next.me.participantId = 'replacement'; h.sdk.snapshot(next); }
    });
    rename(h).click(); await flushSample(); assert.equal(h.prompts.length, 1); assert.equal(h.requests.length, 0);
    if (h.sdk.state) { assert.equal(rename(h).disabled, transition === 'reconnecting'); assert.equal(rename(h).attributes['aria-busy'], 'false'); }
    assert.equal(errorBox(h).hidden, true);
  });
}

for (const invalid of ['detached redraw', 'room', 'participant', 'disconnected', 'reconnecting', 'explicitly disabled'] as const) {
  it(`whole sample ${invalid} handler bypass cannot open a dialog, clear an error or start a request`, async t => {
    const state = roomState(), h = await setup(t, state), old = rename(h);
    if (invalid === 'disconnected') await h.sdk.disconnect();
    else if (invalid === 'reconnecting') h.sdk.setStatus('reconnecting');
    else if (invalid !== 'explicitly disabled') {
      const next = clone(state); if (invalid === 'room') next.roomId = 'replacement';
      else if (invalid === 'participant') next.me.participantId = 'replacement'; else next.name = 'Changed room';
      h.sdk.snapshot(next);
    }
    h.sdk.emit('error', { message: 'Keep current error' });
    old.disabled = invalid === 'explicitly disabled'; old.onclick!(); await flushSample();
    assert.equal(h.prompts.length, 0); assert.equal(h.requests.length, 0);
    assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, 'Keep current error');
    if (h.sdk.state) assert.equal(rename(h).attributes['aria-busy'], 'false');
  });
}

for (const outcome of ['resolve', 'reject'] as const) {
  for (const replacement of ['room', 'participant', 'same-identity rejoin'] as const) {
    it(`whole sample ignores old rename ${outcome} after ${replacement} without unlocking a new pending rename`, async t => {
      const state = roomState(), h = await setup(t, state), old = rename(h); old.click();
      const next = clone(state);
      if (replacement === 'same-identity rejoin') await h.sdk.disconnect();
      else if (replacement === 'room') next.roomId = 'replacement'; else next.me.participantId = 'replacement';
      h.sdk.snapshot(next); const current = rename(h); current.click();
      assert.equal(h.requests.length, 2); h.sdk.emit('error', { message: 'Current error' });
      if (outcome === 'resolve') h.requests[0]!.work.resolve(undefined); else h.requests[0]!.work.reject(new Error('Retired failure'));
      await flushSample();
      assert.equal(current.disabled, true); assert.equal(current.attributes['aria-busy'], 'true');
      assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, 'Current error');
      old.disabled = false; old.onclick!(); assert.equal(h.requests.length, 2); assert.equal(h.prompts.length, 2);
      h.requests[1]!.work.resolve(undefined); await flushSample(); assert.equal(current.disabled, false);
    });
  }
}

it('whole sample reports current rename failure after redraw, allows retry, and preserves reconnect disabling on settlement', async t => {
  const state = roomState(), h = await setup(t, state); rename(h).click();
  h.sdk.snapshot({ ...clone(state), name: 'New room title' });
  h.requests[0]!.work.reject(new Error('Current rename failed')); await flushSample();
  assert.equal(errorBox(h).textContent, 'Current rename failed'); assert.equal(errorBox(h).hidden, false);
  rename(h).click(); assert.equal(errorBox(h).hidden, true); h.sdk.setStatus('reconnecting');
  h.requests[1]!.work.resolve(undefined); await flushSample();
  assert.equal(rename(h).disabled, true); assert.equal(rename(h).attributes['aria-busy'], 'false');
  h.sdk.setStatus('waiting'); assert.equal(rename(h).disabled, false);
});

it('whole sample catches a synchronous public setName failure and releases the rename lock', async t => {
  const h = await setup(t); Object.assign(h.sdk, { setName() { throw new Error('Synchronous failure'); } });
  rename(h).click(); await flushSample(); assert.equal(errorBox(h).textContent, 'Synchronous failure');
  assert.equal(rename(h).disabled, false); assert.equal(rename(h).attributes['aria-busy'], 'false');
});

it('real Hub rename snapshots update self greeting, stage and hand rows, quality labels and current controller filter without exposing private names', async t => {
  const hub = harness(testConfig(config => { config.rooms.presenceBroadcastMs = 0; }));
  const host = await hub.create('主持人'), speaker = await hub.join(host.roomId, host.code, '台上舊名');
  const raised = await hub.join(host.roomId, host.code, '候場舊名'), hidden = await hub.join(host.roomId, host.code, '私人舊名');
  t.after(async () => { if (hub.hub.isJoined(host.s)) await hub.req(host.s, { type: 'room:close' }); });
  assert.equal(await hub.req(speaker.s, { type: 'hand:raise' }), 'ok');
  assert.equal(await hub.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
  assert.equal(await hub.req(raised.s, { type: 'hand:raise' }), 'ok');
  const controller = await setup(t, host.s.last('room:state')!), onstage = await setup(t, speaker.s.last('room:state')!);
  const offstage = await setup(t, raised.s.last('room:state')!), privateSelf = await setup(t, hidden.s.last('room:state')!);
  const viewers = [[controller, host], [onstage, speaker], [offstage, raised], [privateSelf, hidden]] as const;
  const snapshots = () => { for (const [app, seat] of viewers) app.sdk.snapshot(clone(seat.s.last('room:state')!)); };
  for (const [app, seat] of viewers) Object.assign(app.sdk, { async setName(name: string) {
    assert.equal(await hub.req(seat.s, { type: 'participant:rename', name }), 'ok'); snapshots();
  } });
  const query = filter(controller, '候場新名'); assert.equal(audienceRows(controller).filter(row => !row.hidden).length, 0);
  controller.sdk.emit('quality', { participants: [{ participantId: speaker.id, rttMs: 28 }] });
  onstage.sdk.emit('quality', { participants: [{ participantId: speaker.id, rttMs: 28 }] });
  onstage.setAnswer('台上新名 & <茶>'); rename(onstage).click(); await flushSample();
  for (const [app] of viewers) assert.deepEqual(names(app, speaker.id), ['台上新名 & <茶>']);
  assert.equal(greeting(onstage), '你好，台上新名 & <茶>');
  assert.match(controller.id('stage-quality').textContent, /台上新名 & <茶>：.*RTT 28 ms/);
  assert.match(onstage.id('stage-quality').textContent, /台上新名 & <茶>：.*RTT 28 ms/);
  offstage.setAnswer('候場新名'); rename(offstage).click(); await flushSample();
  assert.deepEqual(names(controller, raised.id), ['候場新名', '候場新名']);
  assert.deepEqual(names(onstage, raised.id), ['候場新名']); assert.equal(greeting(offstage), '你好，候場新名');
  assert.equal(query.value, '候場新名'); assert.equal(query.isConnected, true);
  assert.deepEqual(audienceRows(controller).filter(row => !row.hidden).map(row => row.dataset.participantId), [raised.id]);
  privateSelf.setAnswer('私人新名 & <秘密>'); rename(privateSelf).click(); await flushSample();
  assert.equal(greeting(privateSelf), '你好，私人新名 & <秘密>'); assert.deepEqual(names(controller, hidden.id), ['私人新名 & <秘密>']);
  for (const app of [onstage, offstage]) {
    assert.doesNotMatch(app.app.textContent, /私人舊名|私人新名|秘密/); assert.equal(people(app, hidden.id).length, 0);
    assert.equal(app.sdk.state?.audience, undefined);
  }
  assert.equal(onstage.id('stage-quality').textContent.includes('私人新名'), false);
  assert.equal(offstage.id('stage-quality').hidden, true); assert.equal(privateSelf.id('stage-quality').hidden, true);
  assert.ok(viewers.every(([app]) => !app.app.descendants().some(node => node.tagName === 'img' || node.tagName === 'script')));
  controller.setAnswer('主持新名'); rename(controller).click(); await flushSample();
  assert.equal(greeting(controller), '你好，主持新名'); assert.deepEqual(names(onstage, host.id), ['主持新名']);
  assert.equal(await hub.req(host.s, { type: 'room:close' }), 'ok');
});

it('whole sample and public SDK send one rename command, honor ACK/error and preserve a healthy microphone and peer', async t => {
  let cleanup = async (): Promise<void> => {}; t.after(() => cleanup());
  const boundary = await actualApp(t); boundary.form.submit(); await flushSample(); const sdk = boundary.clients[0]!;
  let answer = 'Fresh & <name>';
  const h = sampleApp({ sdk, decodeName, prompt: () => answer }); cleanup = () => h.cleanup();
  const socket = StageSocket.instances[0]!;
  socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
  await boundary.until(() => socket.sent.some(message => message.type === 'join'), 'public SDK join request');
  const joining = socket.sent.find(message => message.type === 'join')!;
  const state = actualState({ onStage: true }); state.speakers = [state.me];
  socket.deliver({ type: 'room:state', ...state }); socket.deliver({ type: 'ok', requestId: joining.requestId });
  const peer = StagePeer.instances[0]!;
  await boundary.until(() => peer.transceiver.sender.track !== null && peer.localDescription !== null && peer.signalingState === 'stable', 'healthy initial publisher');
  const track = peer.transceiver.sender.track!, before = { captures: boundary.captures.length, offers: [...peer.offers], replacements: [...peer.replacements], peers: [...StagePeer.instances] };
  assert.equal(track.stopped, false); assert.equal(track.enabled, true); assert.equal(peer.transceiver.direction, 'sendrecv');
  const commands = socket.sent.length, old = rename(h); old.click(); old.onclick!();
  await boundary.until(() => socket.sent.some(message => message.type === 'participant:rename'), 'public SDK rename command');
  const request = socket.sent.find(message => message.type === 'participant:rename')!;
  assert.deepEqual(request, { type: 'participant:rename', name: answer, requestId: request.requestId });
  assert.equal(greeting(h), `你好，${state.me.name}`); assert.equal(socket.sent.length, commands + 1);
  const next = clone(state); next.me.name = sanitizeName(answer, 32)!; next.speakers = [next.me];
  socket.deliver({ type: 'room:state', ...next }); assert.equal(greeting(h), '你好，Fresh & <name>');
  assert.equal(rename(h).disabled, true); assert.equal(old.isConnected, false);
  socket.deliver({ type: 'ok', requestId: request.requestId }); await flushSample(); assert.equal(rename(h).disabled, false);
  answer = ''; rename(h).click();
  await boundary.until(() => socket.sent.filter(message => message.type === 'participant:rename').length === 2, 'empty rename sent to server');
  const rejected = socket.sent.filter(message => message.type === 'participant:rename').at(-1)!;
  socket.deliver({ type: 'error', requestId: rejected.requestId, code: 'bad_request', message: '名稱不能為空白。' }); await flushSample();
  assert.equal(errorBox(h).hidden, false); assert.match(errorBox(h).textContent, /名稱不能為空白/);
  assert.equal(greeting(h), '你好，Fresh & <name>'); assert.equal(rename(h).disabled, false);
  assert.equal(socket.sent.length, commands + 2); assert.equal(boundary.captures.length, before.captures);
  assert.deepEqual(peer.offers, before.offers);
  // The existing snapshot path reapplies the same track; it does not replace the capture or renegotiate.
  assert.deepEqual(peer.replacements.slice(0, before.replacements.length), before.replacements);
  assert.deepEqual(peer.replacements.slice(before.replacements.length), [track]);
  assert.deepEqual(StagePeer.instances, before.peers); assert.equal(peer.transceiver.sender.track, track);
  assert.equal(track.stopped, false); assert.equal(track.stops, 0); assert.equal(track.enabled, true);
  assert.equal(peer.transceiver.direction, 'sendrecv'); assert.equal(peer.connectionState, 'connected');
});
