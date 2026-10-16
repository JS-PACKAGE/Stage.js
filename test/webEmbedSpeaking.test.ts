/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { StageClient } from '../packages/client/src/index.ts';
import type { ClientMessage, ServerMessage, RoomStatePayload, ParticipantView } from '../shared/protocol.ts';
import type { Session } from '../src/ws/hub.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { embedApp, EmbedNode, EmbedSdk, flush, Deferred } from './fixtures/embedApp.ts';
import { actualApp, actualState, StageSocket, StagePeer, StageContext } from './fixtures/embedSdkApp.ts';
import { harness, sine, testConfig, SENDRECV_OFFER } from './helpers.ts';

const WAITING = '發言偵測：等待伺服器回報。';
const SILENT = '最近收到的發言回報：未偵測到發言。';
const UNMATCHED = '最近收到的發言回報：沒有可對應的台上成員。';
function summary(...names: string[]): string { return `最近收到的發言回報：${names.join('、')}（${names.length} 人）。`; }
function person(id: string, name = id === 'controller' ? '甲' : '乙', role: ParticipantView['role'] = 'speaker', onStage = role !== 'audience'): ParticipantView {
  return { participantId: id, name, role, onStage, handRaised: false, muted: false,
    forceMuted: false, connected: true, gainDb: 0, joinedAt: 1 };
}
function state(me: Partial<ParticipantView> = {}, speakers?: ParticipantView[]): RoomStatePayload {
  const own = { ...person('controller', '甲', 'controller'), ...me };
  return { roomId: 'same-room', name: 'Synthetic room', controllerId: 'controller', me: own,
    speakers: speakers ?? [...(own.onStage ? [own] : []), person('target')], hands: [], audienceCount: 0,
    limits: { maxSpeakers: 8, maxAudience: 300 }, status: 'live', codeRequired: true,
    code: 'PRIVATE-CODE', resumeToken: 'PRIVATE-TOKEN' };
}
function audience(speakers = [person('controller', '甲', 'controller'), person('target')]): RoomStatePayload {
  return state({ participantId: 'reader', name: 'Private reader', role: 'audience', onStage: false }, speakers);
}
function publish(sdk: EmbedSdk, snapshot = state()): void { sdk.state = snapshot; sdk.me = snapshot.me; sdk.emit('state', snapshot); }
function report(...participantIds: string[]) { return { participantIds }; }
function shown(node: EmbedNode, text = summary('甲', '乙')): void { assert.equal(node.hidden, false); assert.equal(node.textContent, text); }
function empty(node: EmbedNode): void { assert.equal(node.hidden, true); assert.equal(node.textContent, ''); }
function instrument(node: EmbedNode, hook: (property: 'textContent' | 'hidden') => void = () => {}) {
  const writes = { textContent: 0, hidden: 0 };
  for (const property of ['textContent', 'hidden'] as const) {
    let value = node[property];
    Object.defineProperty(node, property, { configurable: true, get: () => value, set(next: typeof value) {
      assert.notEqual(next, value, `equal ${property} must not be written`);
      value = next; writes[property]++; hook(property);
    } });
  }
  return writes;
}
async function setup(t: TestContext, options: Parameters<typeof embedApp>[0] = {}, snapshot = state()) {
  const app = embedApp(options); t.after(() => app.cleanup()); const sdk = await app.join();
  publish(sdk, snapshot); return { app, sdk, node: app.node('speaking-summary') };
}
function transfer(app: ReturnType<typeof embedApp>): EmbedNode {
  const button = app.node('stage-management-list').children[0]?.children[1]?.children[2]; assert.ok(button); return button;
}

it('embed speaking authors one initially empty hidden ordinary paragraph beside occupancy and quality', async t => {
  const html = readFileSync(new URL('../web/embed.html', import.meta.url), 'utf8');
  assert.equal(html.match(/id="speaking-summary"/g)?.length, 1);
  assert.match(html, /<p id="room-occupancy" hidden><\/p><p id="own-connection-quality" hidden><\/p><p id="speaking-summary" hidden><\/p>/);
  const subscriptions: string[] = [], original = EmbedSdk.prototype.on;
  t.mock.method(EmbedSdk.prototype, 'on', function(this: EmbedSdk, type: string, callback: Parameters<EmbedSdk['on']>[1]) {
    subscriptions.push(type); original.call(this, type, callback);
  });
  const app = embedApp(); t.after(() => app.cleanup()); const node = app.node('speaking-summary');
  empty(node); app.form.submit(); await flush(); empty(node); assert.ok(subscriptions.includes('speaking'));
  assert.deepEqual(node.attributes, {}); assert.equal(node.children.length, 0);
  publish(app.clients[0]!); shown(node, WAITING);
});
for (const role of ['controller', 'speaker', 'audience'] as const)
  for (const onStage of [true, false]) for (const status of ['waiting', 'live'] as const)
    it(`embed speaking admits ${role}/${onStage}/${status} readership independently of capture and own presence`, async t => {
      const { sdk, node } = await setup(t); sdk.setStatus(status);
      publish(sdk, state({ role, onStage, connected: false, muted: true, forceMuted: true })); shown(node, WAITING);
      sdk.emit('speaking', report('target')); shown(node, summary('乙'));
      sdk.emit('speaking', report()); shown(node, SILENT);
    });

it('embed speaking maps exact IDs in public roster order, deduplicates IDs, and retains identical names', async t => {
  const roster = [person('z', '同名'), person('a', '同名', 'controller'), person('z', 'Ignored duplicate'),
    person(' spaced ', '保留空白 ID'), person('off', 'Offstage', 'speaker', false), person('aud', 'Private audience', 'audience', true)];
  const { sdk, node } = await setup(t, {}, audience(roster));
  sdk.emit('speaking', report('a', 'z', 'z', 'spaced', ' spaced ', 'off', 'aud', 'private-unknown'));
  shown(node, summary('同名', '同名', '保留空白 ID')); assert.doesNotMatch(node.textContent, /Ignored|Offstage|Private|unknown|spaced/);
});
it('embed speaking ignores malformed roster entries and takes the first eligible valid duplicate ID', async t => {
  const roster = [null, false, 1, 'bad', [], {}, person('', 'blank'), person('  ', 'blank'),
    { ...person('bad-name'), name: 1 }, { ...person('bad-stage'), onStage: 1 }, { ...person('bad-role'), role: 'visitor' },
    person('same', 'ineligible', 'audience'), person('same', '第一'), person('same', '第二'), person('empty', '')];
  const { sdk, node } = await setup(t, {}, audience(roster as ParticipantView[]));
  sdk.emit('speaking', report('same', 'empty', '', '  ', 'bad-name', 'bad-stage', 'bad-role'));
  shown(node, summary('第一', ''));
});
for (const [label, detail] of [
  ['null', null], ['primitive', 'bad'], ['array envelope', []], ['missing IDs', {}], ['null IDs', { participantIds: null }],
  ['object IDs', { participantIds: {} }], ['string IDs', { participantIds: 'target' }],
  ['undefined entry', { participantIds: ['target', undefined] }], ['number entry', { participantIds: ['target', 1] }],
  ['object entry', { participantIds: ['target', new String('controller')] }], ['null entry', { participantIds: [null] }],
] as const) it(`embed speaking malformed ${label} clears history to waiting without implying silence`, async t => {
  const { app, sdk, node } = await setup(t); sdk.emit('speaking', report('controller', 'target'));
  app.node('last-error').textContent = 'Existing failure'; app.node('error-notice').hidden = false;
  const identity = sdk.state, status = app.status.textContent; sdk.emit('speaking', detail); shown(node, WAITING);
  assert.equal(sdk.state, identity); assert.equal(app.status.textContent, status);
  assert.equal(app.node('last-error').textContent, 'Existing failure'); assert.equal(app.node('error-notice').hidden, false);
});
for (const ids of [[], [''], [' '], ['unmapped'], ['target', 'unmapped']])
  it(`embed speaking distinguishes raw ${JSON.stringify(ids)} from malformed and pruned reports`, async t => {
    const { sdk, node } = await setup(t, {}, audience()); shown(node, WAITING); sdk.emit('speaking', { participantIds: ids });
    shown(node, ids.length === 0 ? SILENT : ids.includes('target') ? summary('乙') : UNMATCHED);
    publish(sdk, audience([])); shown(node, ids.length === 0 ? SILENT : UNMATCHED);
  });
it('embed speaking never reads private or unrelated raw fields while accepting a report', async t => {
  const { sdk, node } = await setup(t, {}, audience()); const snapshot = sdk.state!;
  for (const key of ['audience', 'hands', 'code', 'resumeToken', 'quality'])
    Object.defineProperty(snapshot, key, { configurable: true, get() { throw new Error(`private ${key}`); } });
  for (const p of snapshot.speakers) for (const key of ['connected', 'muted', 'forceMuted', 'gainDb', 'joinedAt'])
    Object.defineProperty(p, key, { configurable: true, get() { throw new Error(`unrelated ${key}`); } });
  Object.defineProperty(sdk, 'speaking', { get() { throw new Error('retained SDK getter must not seed presentation'); } });
  const detail = Object.freeze({ participantIds: Object.freeze(['target', 'controller']),
    get audience() { throw new Error('private report'); }, get code() { throw new Error('private report'); } });
  sdk.emit('speaking', detail); shown(node); assert.doesNotMatch(node.textContent, /PRIVATE|reader|target|controller/);
});
it('embed speaking copies accepted roster and report primitives until distinct accepted receipts', async t => {
  const snapshot = audience(), { sdk, node } = await setup(t, {}, snapshot), detail = report('controller', 'target');
  sdk.emit('speaking', detail); shown(node);
  detail.participantIds.splice(0, 2, 'private-other'); snapshot.speakers[0]!.name = 'Mutated name';
  snapshot.speakers.reverse(); sdk.emit('speaking', detail); sdk.emit('state', snapshot); sdk.setStatus('live'); shown(node);
  sdk.emit('speaking', report('target')); shown(node, summary('乙'));
  publish(sdk, audience([person('target', '新名'), person('controller', '新主控', 'controller')])); shown(node, summary('新名'));
});
it('embed speaking unknown, offstage, removed and readded IDs never resurrect retained history', async t => {
  const { sdk, node } = await setup(t, {}, audience([person('target'), person('off', '丙', 'speaker', false)]));
  sdk.emit('speaking', report('target', 'off', 'future')); shown(node, summary('乙'));
  publish(sdk, audience([person('target', '乙改名'), person('off', '丙'), person('future', '丁')])); shown(node, summary('乙改名'));
  publish(sdk, audience([])); shown(node, UNMATCHED);
  publish(sdk, audience([person('target'), person('off', '丙'), person('future', '丁')])); shown(node, UNMATCHED);
  sdk.emit('speaking', report('future', 'target', 'off')); shown(node, summary('乙', '丙', '丁'));
  sdk.emit('speaking', report()); publish(sdk, audience([])); publish(sdk, audience()); shown(node, SILENT);
});
it('embed speaking equal fresh text replaces retained membership, suppresses redundant writes and repairs host corruption', async t => {
  const { sdk, node } = await setup(t, {}, audience([person('a', '同名'), person('b', '同名')]));
  sdk.emit('speaking', report('a')); const writes = instrument(node);
  sdk.emit('speaking', report('b')); assert.deepEqual(writes, { textContent: 0, hidden: 0 });
  publish(sdk, audience([person('a', '改名'), person('b', '同名')])); shown(node, summary('同名'));
  for (let i = 0; i < 20; i++) { sdk.emit('speaking', report('b')); sdk.setStatus('waiting'); }
  assert.deepEqual(writes, { textContent: 0, hidden: 0 });
  node.textContent = 'host corruption'; node.hidden = true; sdk.emit('speaking', report('b')); shown(node, summary('同名'));
  assert.deepEqual(writes, { textContent: 2, hidden: 2 });
  publish(sdk, audience([person('a', '改名')])); shown(node, UNMATCHED);
});

it('embed speaking records rejected state and report identities before exact-current state admission', async t => {
  const app = embedApp(); t.after(() => app.cleanup()); app.form.submit(); await flush(); const sdk = app.clients[0]!;
  const node = app.node('speaking-summary'), before = report('target'), foreign = state();
  sdk.emit('speaking', before); sdk.emit('state', foreign); publish(sdk, foreign); sdk.emit('speaking', report('controller')); empty(node);
  publish(sdk); shown(node, WAITING); sdk.emit('speaking', before); shown(node, WAITING);
  const accepted = report('controller', 'target'); sdk.emit('speaking', accepted); shown(node);
  sdk.emit('speaking', report()); sdk.emit('speaking', accepted); shown(node, SILENT);
  const malformed: { participantIds: unknown } = { participantIds: [1] }; sdk.emit('speaking', malformed); shown(node, WAITING);
  sdk.emit('speaking', report('target')); malformed.participantIds = ['controller']; sdk.emit('speaking', malformed); shown(node, summary('乙'));
});
it('embed speaking reconnect needs distinct current state then unseen report, never status, getter or replay', async t => {
  const { sdk, node } = await setup(t), previous = sdk.state!, accepted = report('controller', 'target'), rejected = report('target');
  sdk.emit('speaking', accepted); sdk.setStatus('reconnecting'); empty(node); const rejectedState = state();
  sdk.emit('speaking', rejected); sdk.emit('state', rejectedState); sdk.setStatus('live');
  sdk.emit('stagejoined', { participantId: 'controller' }); sdk.emit('transferred', { fromId: 'target', toId: 'controller' });
  sdk.emit('state', previous); sdk.emit('speaking', report('controller')); empty(node);
  publish(sdk, rejectedState); sdk.emit('speaking', report('controller')); empty(node);
  publish(sdk); shown(node, WAITING); sdk.emit('speaking', accepted); sdk.emit('speaking', rejected); shown(node, WAITING);
  sdk.emit('speaking', report('target')); shown(node, summary('乙'));
});
for (const target of ['controller', 'target'] as const) for (const event of ['stageleft', 'role'] as const)
  it(`embed speaking ${event} for ${target} prunes only that ID and fences brand-new reports until distinct valid current state`, async t => {
    const { sdk, node } = await setup(t), previous = sdk.state!, other = target === 'controller' ? 'target' : 'controller';
    const otherName = target === 'controller' ? '乙' : '甲'; sdk.emit('speaking', report('controller', 'target'));
    sdk.emit(event, { participantId: target, role: 'audience' }); shown(node, summary(otherName));
    sdk.emit('speaking', report(target, other)); shown(node, summary(otherName));
    sdk.emit('state', previous); sdk.emit('speaking', report(target)); shown(node, UNMATCHED);
    sdk.emit('stagejoined', { participantId: target }); sdk.emit('role', { participantId: target, role: 'speaker' });
    sdk.emit('speaking', report(target)); shown(node, UNMATCHED);
    const rejected = state(); sdk.emit('state', rejected); publish(sdk, rejected); sdk.emit('speaking', report(target)); shown(node, UNMATCHED);
    publish(sdk); shown(node, UNMATCHED); sdk.emit('speaking', report(target)); shown(node, summary(target === 'controller' ? '甲' : '乙'));
  });
for (const malformed of ['missing', 'object', 'getter'] as const)
  it(`embed speaking ${malformed} roster clears to waiting without releasing pending delta suppression`, async t => {
    const { sdk, node } = await setup(t, {}, audience()), previous = sdk.state!;
    sdk.emit('speaking', report('target')); sdk.emit('stageleft', { participantId: 'target' }); shown(node, UNMATCHED);
    const invalid = audience();
    if (malformed === 'getter') { let reads = 0; Object.defineProperty(invalid, 'speakers', { get() {
      if (++reads === 1) throw new Error('synthetic roster failure'); return [person('target')];
    } }); }
    else Reflect.set(invalid, 'speakers', malformed === 'missing' ? undefined : {});
    publish(sdk, invalid); shown(node, WAITING); sdk.emit('speaking', report('target')); shown(node, UNMATCHED);
    sdk.state = previous; sdk.me = previous.me; sdk.emit('state', previous); sdk.emit('speaking', report('target')); shown(node, UNMATCHED);
    publish(sdk, audience()); shown(node, UNMATCHED); sdk.emit('speaking', report('target')); shown(node, summary('乙'));
  });
it('embed speaking own role changes preserve other IDs and onstage transfers preserve all history', async t => {
  const { sdk, node } = await setup(t); sdk.emit('speaking', report('controller', 'target'));
  sdk.emit('transferred', { fromId: 'controller', toId: 'target' }); sdk.emit('role', { participantId: 'controller', role: 'speaker' });
  publish(sdk, state({ role: 'speaker' })); shown(node);
  sdk.emit('role', { participantId: 'controller', role: 'audience' }); shown(node, summary('乙'));
  publish(sdk, state({ role: 'audience', onStage: false })); shown(node, summary('乙'));
  publish(sdk, state({ role: 'controller', onStage: false })); shown(node, summary('乙'));
  sdk.emit('speaking', report()); publish(sdk); shown(node, SILENT);
});
it('embed speaking microphone failure, readiness, mute and explicit retry never create or erase room activity', async t => {
  const { app, sdk, node } = await setup(t); sdk.emit('speaking', report('controller', 'target')); const writes = instrument(node);
  sdk.setStatus('live'); sdk.emit('micerror', { name: 'NotReadableError', message: '失去麥克風' }); shown(node);
  app.micRetry.click(); assert.equal(sdk.retryCalls, 1); sdk.emit('micready', undefined); app.mic.click();
  publish(sdk, state({ muted: true, forceMuted: true, connected: false })); shown(node);
  assert.deepEqual(writes, { textContent: 0, hidden: 0 });
  assert.doesNotMatch(node.textContent, /可聽|健康|恢復|即時|音訊|延遲|麥克風/);
});
for (const change of ['room', 'participant', 'missing-state'] as const)
  it(`embed speaking silent ${change} loss retires history and restoring getters cannot revive it`, async t => {
    const { sdk, node } = await setup(t); sdk.emit('speaking', report('target')); const previous = sdk.state!;
    if (change === 'room') sdk.state = { ...previous, roomId: 'other' };
    else if (change === 'participant') sdk.state = { ...previous, me: { ...previous.me, participantId: 'other' } };
    else sdk.state = null;
    sdk.emit('speaking', report('controller')); empty(node); sdk.state = previous; sdk.setStatus('live'); sdk.emit('speaking', report('target')); empty(node);
    publish(sdk); shown(node, WAITING); sdk.emit('speaking', report('target')); shown(node, summary('乙'));
  });
it('embed speaking cancellation before library load and failed imports remain hidden and empty', async t => {
  const gate = new Deferred(), app = embedApp({ libraryLoad: gate.promise }); t.after(() => app.cleanup());
  app.form.submit(); await flush(); app.node('cancel-join').invoke(); empty(app.node('speaking-summary'));
  gate.resolve(); await flush(); assert.equal(app.clients.length, 0); empty(app.node('speaking-summary'));
  const failed = embedApp({ libraryLoad: async () => { throw new Error('synthetic import failure'); } }); t.after(() => failed.cleanup());
  failed.form.submit(); await flush(); empty(failed.node('speaking-summary')); assert.equal(failed.clients.length, 0);
});
it('embed speaking ordinary receipts add no commands, timers, draft edits, or unrelated surface writes', async t => {
  const { app, sdk, node } = await setup(t); sdk.emit('speaking', report('target'));
  app.node('name').value = 'unsent'; app.node('room-name-draft').value = 'unsent room';
  const unchanged = ['status', 'last-error', 'error-notice', 'room-occupancy', 'own-connection-quality', 'room-name-draft', 'name', 'close-room', 'stage-management-list'];
  const ui = () => unchanged.map(id => { const n = app.node(id); return [n.textContent, n.hidden, n.disabled, n.value, { ...n.attributes }, { ...n.writes }]; });
  const calls = () => [sdk.actions.length, sdk.moderations.length, sdk.stageModerations.length, sdk.transfers.length, sdk.closes.length,
    sdk.deviceLists.length, sdk.inputSelections.length, sdk.retryCalls, app.clients.length];
  const before = ui(), commands = calls(), timers = app.clock.metrics;
  for (let i = 0; i < 20; i++) { sdk.emit('speaking', report()); sdk.emit('speaking', report('controller', 'target')); }
  shown(node); assert.deepEqual(ui(), before); assert.deepEqual(calls(), commands); assert.deepEqual(app.clock.metrics, timers);
});

for (const property of ['textContent', 'hidden'] as const)
  for (const action of ['new-report', 'empty-report', 'malformed-report', 'new-state', 'own-audience', 'silent-room', 'silent-participant', 'reconnect', 'leave', 'closed', 'kicked'] as const)
    it(`embed speaking ${property} setter yields to ${action} without overwriting its winner`, async t => {
      const { app, sdk, node } = await setup(t); sdk.emit('speaking', report('target'));
      if (property === 'hidden') node.hidden = true;
      let entered = false; instrument(node, key => {
        if (entered || key !== property) return; entered = true;
        if (action === 'new-report') sdk.emit('speaking', report('controller'));
        else if (action === 'empty-report') sdk.emit('speaking', report());
        else if (action === 'malformed-report') sdk.emit('speaking', {});
        else if (action === 'new-state') publish(sdk, state({}, [person('target', '新名')]));
        else if (action === 'own-audience') sdk.emit('role', { participantId: 'controller', role: 'audience' });
        else if (action === 'silent-room') sdk.state!.roomId = 'other';
        else if (action === 'silent-participant') sdk.state!.me.participantId = 'other';
        else if (action === 'reconnect') sdk.setStatus('reconnecting');
        else if (action === 'leave') app.leave.invoke();
        else sdk.emit(action, {});
      });
      sdk.emit('speaking', report('controller', 'target')); assert.equal(entered, true);
      if (action === 'new-report') shown(node, summary('甲'));
      else if (action === 'empty-report') shown(node, SILENT);
      else if (action === 'malformed-report') shown(node, WAITING);
      else if (action === 'new-state') shown(node, summary('新名'));
      else if (action === 'own-audience') shown(node, summary('乙'));
      else empty(node);
    });
for (const property of ['textContent', 'hidden'] as const)
  for (const change of ['reconnecting', 'disconnected', 'room', 'participant', 'missing-state'] as const)
    it(`embed speaking ${property} nested report then silent ${change} reconciles the winning owner before return`, async t => {
      const { sdk, node } = await setup(t); sdk.emit('speaking', report('target')); if (property === 'hidden') node.hidden = true;
      const previous = sdk.state!; let entered = false; instrument(node, key => {
        if (entered || key !== property) return; entered = true; sdk.emit('speaking', report('controller'));
        if (change === 'room') sdk.state!.roomId = 'other-room';
        else if (change === 'participant') sdk.state!.me.participantId = 'other-seat';
        else if (change === 'missing-state') sdk.state = null;
        else sdk.status = change;
      });
      sdk.emit('speaking', report('controller', 'target')); assert.equal(entered, true); empty(node);
      sdk.status = 'live'; sdk.state = previous; previous.roomId = 'same-room'; previous.me.participantId = 'controller';
      sdk.emit('status', 'live'); sdk.emit('speaking', report('target')); empty(node);
      publish(sdk); sdk.emit('speaking', report('target'));
      if (change === 'disconnected') empty(node); else shown(node, summary('乙'));
    });
for (const property of ['textContent', 'hidden'] as const)
  for (const cause of ['reconnecting', 'disconnected', 'leave', 'closed', 'kicked', 'submit'] as const)
    it(`embed speaking ${cause} ${property} clearing cannot erase a replacement entry or revive old consent`, async t => {
      const { app, sdk, node } = await setup(t, { confirm: () => true }); sdk.emit('speaking', report('controller', 'target'));
      const close = app.node('close-room'), target = transfer(app); let entered = false;
      instrument(node, key => {
        if (entered || key !== property) return; entered = true;
        if (cause !== 'reconnecting') { close.invoke(); target.invoke(); }
        app.form.submit();
      });
      if (cause === 'reconnecting' || cause === 'disconnected') sdk.setStatus(cause);
      else if (cause === 'leave') app.leave.invoke(); else if (cause === 'submit') app.form.submit(); else sdk.emit(cause, {});
      await flush(); assert.equal(entered, true); assert.equal(app.confirmations.length, 0);
      const next = app.clients.at(-1)!; assert.notEqual(next, sdk); publish(next); next.emit('speaking', report('target')); shown(node, summary('乙'));
      sdk.emit('speaking', report('controller')); sdk.emit('state', state()); sdk.emit('closed', {}); sdk.emit('kicked', {}); sdk.setStatus('disconnected');
      shown(node, summary('乙')); assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
    });
for (const throwing of [false, true]) for (const tail of ['none', 'reconnecting', 'room', 'participant'] as const)
  it(`embed speaking report getter throwing=${throwing}/tail=${tail} cannot overwrite nested accepted primitives`, async t => {
    const { sdk, node } = await setup(t); const detail = { get participantIds() {
      sdk.emit('speaking', report('target'));
      if (tail === 'reconnecting') sdk.status = 'reconnecting';
      else if (tail === 'room') sdk.state!.roomId = 'other';
      else if (tail === 'participant') sdk.state!.me.participantId = 'other';
      if (throwing) throw new Error('synthetic projection failure'); return ['controller'];
    } };
    sdk.emit('speaking', detail); if (tail === 'none') shown(node, summary('乙')); else empty(node);
  });
for (const throwing of [false, true]) for (const nested of ['state', 'report'] as const)
  for (const tail of ['none', 'reconnecting', 'room', 'participant'] as const)
    it(`embed speaking roster getter nested=${nested}/throwing=${throwing}/tail=${tail} guards the complete projection`, async t => {
      const { sdk, node } = await setup(t, {}, audience()); sdk.emit('speaking', report('target'));
      const outer = person('target', 'Outer'); let entered = false;
      Object.defineProperty(outer, 'name', { get() {
        if (entered) return 'Outer'; entered = true;
        if (nested === 'state') publish(sdk, audience([person('target', 'Nested')]));
        else sdk.emit('speaking', report('controller'));
        if (tail === 'reconnecting') sdk.status = 'reconnecting';
        else if (tail === 'room') sdk.state!.roomId = 'other';
        else if (tail === 'participant') sdk.state!.me.participantId = 'other';
        if (throwing) throw new Error('synthetic roster getter failure'); return 'Outer';
      } });
      publish(sdk, audience([outer])); assert.equal(entered, true);
      if (tail === 'none') shown(node, summary(nested === 'state' ? 'Nested' : '甲')); else empty(node);
    });
it('embed speaking report array element getters cannot overwrite a nested newer empty report', async t => {
  const { sdk, node } = await setup(t); const participantIds = ['controller', 'target'];
  Object.defineProperty(participantIds, 1, { get() { sdk.emit('speaking', report()); return 'target'; } });
  sdk.emit('speaking', { participantIds }); shown(node, SILENT);
});
it('embed speaking partial roster projection never releases an outstanding delta fence', async t => {
  const { sdk, node } = await setup(t, {}, audience()); sdk.emit('speaking', report('controller', 'target'));
  sdk.emit('stageleft', { participantId: 'target' }); shown(node, summary('甲'));
  const later = person('broken', 'Broken'); Object.defineProperty(later, 'name', { get() {
    sdk.emit('speaking', report('target')); shown(node, UNMATCHED); throw new Error('unfinished roster');
  } });
  publish(sdk, audience([person('target', 'New'), later])); shown(node, UNMATCHED);
  sdk.emit('speaking', report('target')); shown(node, UNMATCHED);
  publish(sdk, audience()); shown(node, UNMATCHED); sdk.emit('speaking', report('target')); shown(node, summary('乙'));
});

for (const command of ['close', 'transfer'] as const)
  for (const change of ['role', 'identity', 'connected', 'status', 'capability', 'target'] as const)
    for (const equal of [false, true])
      it(`embed speaking ${command} consent cannot revive after observed ${change} loss on ${equal ? 'equal' : 'changed'} text`, async t => {
        let inside = () => {}; const { app, sdk, node } = await setup(t, { confirm: () => { inside(); return true; } });
        sdk.emit('speaking', report('target')); const originalClose = sdk.closeRoom, originalTransfer = sdk.transferControl;
        const restore = () => {
          sdk.status = 'live'; sdk.closeRoom = originalClose; sdk.transferControl = originalTransfer;
          publish(sdk, state());
        };
        let entered = false; instrument(node, () => { if (!entered) { entered = true; restore(); } });
        inside = () => {
          if (change === 'role') sdk.state!.me.role = 'speaker';
          else if (change === 'identity') sdk.state!.me.participantId = 'replacement';
          else if (change === 'connected') sdk.state!.me.connected = false;
          else if (change === 'status') sdk.status = 'reconnecting';
          else if (change === 'capability') Reflect.set(sdk, command === 'close' ? 'closeRoom' : 'transferControl', undefined);
          else sdk.state!.speakers.find(p => p.participantId === 'target')!.connected = false;
          sdk.emit('speaking', report(...(equal ? ['target'] : ['controller', 'target']))); restore();
        };
        (command === 'close' ? app.node('close-room') : transfer(app)).click(); await flush();
        if (command === 'close' && change === 'target') assert.equal(sdk.closes.length, 1, 'unrelated target loss preserves Close');
        else { assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0); }
        assert.equal(app.confirmations.length, 1);
      });
for (const property of ['textContent', 'hidden'] as const) for (const command of ['close', 'transfer'] as const)
  it(`embed speaking ${command} consent cannot survive ${property} nested report with restored silent reconnect tail`, async t => {
    let inside = () => {}; const { app, sdk, node } = await setup(t, { confirm: () => { inside(); return true; } });
    sdk.emit('speaking', report('target')); if (property === 'hidden') node.hidden = true;
    let entered = false; instrument(node, key => {
      if (entered || key !== property) return; entered = true; sdk.emit('speaking', report('controller')); sdk.status = 'reconnecting';
    });
    inside = () => { sdk.emit('speaking', report('controller', 'target')); sdk.status = 'live'; };
    (command === 'close' ? app.node('close-room') : transfer(app)).click(); await flush();
    assert.equal(entered, true); empty(node); assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0);
    assert.equal(app.confirmations.length, 1);
  });
for (const command of ['close', 'transfer'] as const)
  it(`embed speaking ordinary report preserves valid ${command} consent and cannot open a second dialog`, async t => {
    let inside = () => {}; const { app, sdk, node } = await setup(t, { confirm: () => { inside(); return true; } });
    sdk.emit('speaking', report('target')); let entered = false;
    instrument(node, () => { if (entered) return; entered = true; app.node('close-room').invoke(); transfer(app).invoke(); });
    inside = () => sdk.emit('speaking', report('controller', 'target'));
    (command === 'close' ? app.node('close-room') : transfer(app)).click(); await flush();
    assert.equal(entered, true); assert.equal(app.confirmations.length, 1);
    assert.equal(sdk.closes.length, Number(command === 'close')); assert.equal(sdk.transfers.length, Number(command === 'transfer'));
  });

function media(h: Awaited<ReturnType<typeof actualApp>>) {
  return { captures: h.captures.length, plays: h.audio.plays, pauses: h.audio.pauses,
    peers: StagePeer.instances.length, contexts: StageContext.instances.length,
    enumerations: h.enumerations.length, sinks: h.sinks.length,
    stops: h.tracks.map(track => track.stops), replacements: StagePeer.instances.map(peer => peer.replacements.length),
    offers: StagePeer.instances.map(peer => peer.offers.length) };
}
function ui(h: Awaited<ReturnType<typeof actualApp>>) {
  return ['status', 'room-occupancy', 'own-connection-quality', 'last-error', 'error-notice',
    'room-name-current', 'stage-management-list', 'close-room', 'audio-retry-status', 'mic-retry']
    .map(id => { const n = h.node(id); return [id, n.textContent, n.hidden, n.disabled, { ...n.attributes }, { ...n.writes }]; });
}
async function bridge(t: TestContext) {
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; c.rooms.presenceBroadcastMs = 250;
    c.rooms.controllerGraceMs = 60000; c.rooms.participantGraceMs = 15000; c.limits.controlPerSecond = 2000; });
  const server = harness(config), host = await server.create('Public controller');
  const speaker = await server.join(host.roomId, host.code, 'Public speaker');
  assert.equal(await server.req(speaker.s, { type: 'hand:raise' }), 'ok');
  assert.equal(await server.req(host.s, { type: 'stage:approve', targetId: speaker.id }), 'ok');
  assert.equal(await server.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  assert.equal(await server.req(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
  const audience = await server.join(host.roomId, host.code, 'Private audience name');
  const h = await actualApp(t);
  let work = Promise.resolve(), sequence = 0;
  const sessions = new Map<StageSocket, Session>(), incoming = new Map<StageSocket, ServerMessage[]>();
  const outgoing: ClientMessage[] = [], order: string[] = [], reports: string[][] = [];
  const originalClose = StageSocket.prototype.close;
  t.mock.method(StageSocket.prototype, 'close', function(this: StageSocket, code?: number) {
    originalClose.call(this);
    const session = sessions.get(this); if (session) work = work.then(() => server.hub.detach(session, code === 1000));
  });
  t.mock.method(StageSocket.prototype, 'send', function(this: StageSocket, data: string) {
    const message = parseClientMessage(data, config.limits), session = sessions.get(this);
    assert.ok(session); this.sent.push(message); outgoing.push(message);
    work = work.then(() => server.hub.handle(session, message));
  });
  const bind = (socket: StageSocket) => {
    const messages: ServerMessage[] = []; incoming.set(socket, messages);
    const session: Session = { id: `embed-speaking-${++sequence}`,
      send(message) {
        messages.push(message);
        if (socket.readyState === StageSocket.OPEN) { order.push(`wire:${message.type}`); socket.deliver(message); }
      }, close() { socket.close(); } };
    sessions.set(socket, session); server.hub.attach(session); return session;
  };
  const active = (ids: string[]) => {
    for (const id of ids) assert.equal(server.transport.emitUplink(host.roomId, id, sine(960, 0.5)), true);
    server.mixers.get(host.roomId)!.tick();
  };
  const drain = async () => { await h.tick(200); await work; await flush(); };
  t.after(async () => { await flush(); await work; await server.hub.shutdown(); await server.transport.close(); });
  active([host.id, speaker.id]);
  h.node('room').value = host.roomId; h.node('code').value = host.code; h.form.submit(); await flush();
  const socket = StageSocket.instances[0]!, client = h.clients[0] as StageClient;
  client.on('status', ({ detail }) => order.push(`sdk:status:${detail}`));
  client.on('state', ({ detail }) => { assert.equal(detail, client.state); order.push('sdk:state'); });
  client.on('speaking', ({ detail }) => { reports.push([...detail.participantIds]); order.push('sdk:speaking'); });
  bind(socket); await h.until(() => client.me !== null, 'actual SDK joins actual Hub'); await drain();
  return { config, server, host, speaker, audience, h, client, socket, incoming, outgoing, order, reports, bind, active, drain };
}


it('embed speaking actual SDK → validator → Hub joins with public names before ACK for every room recipient and adds no activity work', async t => {
  const f = await bridge(t), { server, host, speaker, audience, h, client, socket } = f, node = h.node('speaking-summary');
  const arrivals = f.incoming.get(socket)!.filter(m => ['room:state', 'speaking', 'ok'].includes(m.type));
  assert.deepEqual(arrivals.slice(0, 3).map(m => m.type), ['room:state', 'speaking', 'ok']);
  assert.deepEqual(f.reports[0], [host.id, speaker.id]); shown(node, summary('Public controller', 'Public speaker'));
  assert.ok(f.order.indexOf('sdk:status:live') < f.order.indexOf('sdk:state'));
  assert.ok(f.order.indexOf('sdk:state') < f.order.indexOf('sdk:speaking'));
  assert.ok(f.order.indexOf('sdk:speaking') < f.order.indexOf('wire:ok'));
  assert.equal(client.me!.role, 'audience'); assert.equal(client.me!.onStage, false);
  assert.deepEqual(client.state!.speakers.map(p => p.name), ['Public controller', 'Public speaker']);
  for (const key of ['audience', 'code']) assert.equal(Object.hasOwn(client.state!, key), false);
  assert.doesNotMatch(node.textContent, /Private audience name|resume|TOKEN|CODE/);
  host.s.clear(); speaker.s.clear(); audience.s.clear();
  const frames = [...socket.sent], beforeMedia = media(h), beforeUi = ui(h), timers = [...server.timers];
  const stats = t.mock.method(client, 'getStats', () => { assert.fail('speaking must not poll browser stats'); });
  const timeout = t.mock.method(globalThis, 'setTimeout'), interval = t.mock.method(globalThis, 'setInterval');
  server.mixers.get(host.roomId)!.tick(); server.mixers.get(host.roomId)!.tick(); shown(node, SILENT);
  assert.deepEqual(f.reports.at(-1), []);
  for (const who of [host, speaker, audience]) assert.deepEqual(who.s.last('speaking')!.participantIds, []);
  f.active([speaker.id]); shown(node, summary('Public speaker'));
  for (const who of [host, speaker, audience]) assert.deepEqual(who.s.last('speaking')!.participantIds, [speaker.id]);
  assert.deepEqual(f.reports.at(-1), [speaker.id]); assert.deepEqual([...client.speaking], [speaker.id]);
  assert.deepEqual(ui(h), beforeUi); assert.deepEqual(media(h), beforeMedia); assert.deepEqual(socket.sent, frames);
  assert.deepEqual(server.timers, timers); assert.equal(stats.mock.callCount(), 0);
  assert.equal(timeout.mock.callCount(), 0); assert.equal(interval.mock.callCount(), 0);
  const counts = [host.s, speaker.s, audience.s].map(s => s.all('speaking').length), writes = instrument(node);
  for (let n = 0; n < 25; n++) f.active([speaker.id]);
  assert.deepEqual([host.s, speaker.s, audience.s].map(s => s.all('speaking').length), counts);
  assert.deepEqual(writes, { textContent: 0, hidden: 0 });
  assert.ok(f.outgoing.some(m => m.type === 'join')); assert.ok(f.outgoing.some(m => m.type === 'rtc:offer'));
});
it('embed speaking actual SDK reconnect hides retained getter and replacement gets current empty baseline before resume ACK', async t => {
  const f = await bridge(t), { h, client, socket, server, host, speaker } = f, node = h.node('speaking-summary');
  const oldMessage = socket.onmessage, oldState = client.state, token = client.state!.resumeToken;
  shown(node, summary('Public controller', 'Public speaker')); socket.close(); await flush(); empty(node);
  assert.equal(client.status, 'reconnecting'); assert.equal(client.state, oldState);
  assert.deepEqual([...client.speaking], [host.id, speaker.id], 'getter remains retained during reconnect');
  const received = f.reports.length;
  server.mixers.get(host.roomId)!.tick(); server.mixers.get(host.roomId)!.tick();
  assert.equal(f.reports.length, received, 'disconnected reader misses changed empty report');
  oldMessage?.({ data: JSON.stringify({ type: 'speaking', participantIds: [host.id] }) });
  client.dispatchEvent(new CustomEvent('state', { detail: oldState })); empty(node);
  assert.equal(f.reports.length, received, 'old socket callback is fenced by SDK');
  await h.tick(500); const next = StageSocket.instances.at(-1)!; assert.notEqual(next, socket);
  f.order.length = 0; f.bind(next); await h.until(() => client.status === 'live', 'real resume'); await f.drain();
  const join = next.sent.find(m => m.type === 'join'); assert.ok(join && join.type === 'join');
  assert.equal(join.resumeToken, token); assert.equal(client.me!.participantId, oldState!.me.participantId);
  const arrivals = f.incoming.get(next)!.filter(m => ['room:state', 'speaking', 'ok'].includes(m.type));
  assert.deepEqual(arrivals.slice(0, 3).map(m => m.type), ['room:state', 'speaking', 'ok']);
  assert.deepEqual(f.reports.at(-1), []); assert.deepEqual([...client.speaking], []); shown(node, SILENT);
  assert.ok(f.order.indexOf('sdk:state') < f.order.indexOf('sdk:speaking'));
  assert.ok(f.order.indexOf('sdk:speaking') < f.order.indexOf('wire:ok'));
  oldMessage?.({ data: JSON.stringify({ type: 'speaking', participantIds: [host.id] }) }); shown(node, SILENT);
});
it('embed speaking actual held disconnected publisher stays mapped and audience/controller/offstage readership survives role changes', async t => {
  const f = await bridge(t), { h, client, server, host, speaker, audience, socket } = f, node = h.node('speaking-summary');
  await server.hub.detach(speaker.s); server.mixers.get(host.roomId)!.tick(); server.mixers.get(host.roomId)!.tick(); f.active([speaker.id]);
  assert.equal(client.state!.speakers.find(p => p.participantId === speaker.id)!.connected, false);
  assert.ok(client.speaking.has(speaker.id)); shown(node, summary('Public speaker'));
  assert.equal(await server.req(host.s, { type: 'control:transfer', targetId: client.me!.participantId }), 'ok');
  await f.drain(); assert.equal(client.me!.role, 'controller'); assert.equal(client.me!.onStage, false);
  shown(node, summary('Public speaker'));
  const beforeMedia = media(h), beforeUi = ui(h), frames = [...socket.sent];
  server.mixers.get(host.roomId)!.tick(); server.mixers.get(host.roomId)!.tick(); f.active([speaker.id]);
  shown(node, summary('Public speaker')); assert.deepEqual(audience.s.last('speaking')!.participantIds, [speaker.id]);
  assert.deepEqual(media(h), beforeMedia); assert.deepEqual(ui(h), beforeUi); assert.deepEqual(socket.sent, frames);
  const returnWork = client.returnToStage(); await f.drain(); await f.drain(); await returnWork;
  assert.equal(client.me!.onStage, true); f.active([client.me!.participantId, speaker.id]);
  shown(node, summary('Public speaker', '測試主控'));
  const leaveWork = client.leaveStage(); await f.drain(); await leaveWork;
  assert.equal(client.me!.onStage, false); assert.equal(client.me!.role, 'controller');
  assert.deepEqual([...client.speaking], [speaker.id]); shown(node, summary('Public speaker'));
});
it('embed speaking actual role→stageleft→state gap suppresses a new report while the SDK still retains departing public roster', async t => {
  const f = await bridge(t), { h, client, socket, server, host, speaker } = f, node = h.node('speaking-summary');
  let entered = false, previous: unknown; const observed: string[] = [];
  client.on('role', ({ detail }) => {
    if (detail.participantId !== speaker.id || detail.role !== 'audience') return;
    entered = true; observed.push('audience-role'); previous = client.state;
    assert.equal(client.state!.speakers.find(p => p.participantId === speaker.id)!.onStage, true);
    assert.equal(client.state!.speakers.find(p => p.participantId === speaker.id)!.role, 'speaker');
    shown(node, summary('Public controller'));
    socket.deliver({ type: 'speaking', participantIds: [speaker.id] }); shown(node, UNMATCHED);
    assert.deepEqual([...client.speaking], [speaker.id]); observed.push('new-speaking-before-state');
    client.dispatchEvent(new CustomEvent('state', { detail: previous }));
    socket.deliver({ type: 'speaking', participantIds: [speaker.id] }); shown(node, UNMATCHED);
  });
  client.on('stageleft', ({ detail }) => {
    if (detail.participantId !== speaker.id) return;
    observed.push('stageleft'); assert.equal(client.state, previous);
    socket.deliver({ type: 'speaking', participantIds: [speaker.id] }); shown(node, UNMATCHED);
  });
  client.on('state', () => { if (entered && client.state !== previous) observed.push('new-state'); });
  assert.equal(await server.req(host.s, { type: 'stage:remove', targetId: speaker.id }), 'ok');
  assert.equal(entered, true); assert.deepEqual(observed, ['audience-role', 'new-speaking-before-state', 'stageleft', 'new-state']);
  assert.equal(client.state!.speakers.some(p => p.participantId === speaker.id), false); shown(node, UNMATCHED);
  assert.equal(client.me!.role, 'audience');
});

async function enter(t: TestContext, snapshot: RoomStatePayload) {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances.at(-1)!;
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => socket.sent.some(m => m.type === 'join'), 'join request'); const request = socket.sent.find(m => m.type === 'join')!;
  socket.deliver({ type: 'room:state', ...snapshot }); socket.deliver({ type: 'ok', requestId: request.requestId });
  await h.until(() => StagePeer.instances.at(-1)?.signalingState === 'stable' && StagePeer.instances.at(-1)?.localDescription !== null, 'negotiation');
  await h.tick(20); return { h, socket, client: h.clients[0] as StageClient };
}
it('embed speaking actual SDK decodes each public display name once and only assigns text', async t => {
  const snapshot = actualState({ role: 'audience' });
  snapshot.speakers = [person('a', '&lt;img src=x onerror=alert(1)&gt;'), person('b', '&amp;lt;b&amp;gt;'), person('c', '&quot;&#39;&amp;')];
  const { h, socket } = await enter(t, snapshot), node = h.node('speaking-summary');
  shown(node, WAITING); socket.deliver({ type: 'speaking', participantIds: ['c', 'b', 'a'] });
  shown(node, summary('<img src=x onerror=alert(1)>', '&lt;b&gt;', '"\'&'));
  assert.equal(node.children.length, 0); assert.deepEqual(node.attributes, {});
});
for (const role of ['controller', 'speaker', 'audience'] as const)
  it(`embed speaking actual SDK ${role} reader shows Hub public activity without own capture eligibility`, async t => {
    const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; c.rooms.presenceBroadcastMs = 0; });
    const s = harness(config), host = await s.create('Public host'), speaker = await s.join(host.roomId, host.code, 'Public speaker');
    const audience = await s.join(host.roomId, host.code, 'Private audience');
    await s.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER });
    await s.req(speaker.s, { type: 'hand:raise' }); await s.req(host.s, { type: 'stage:approve', targetId: speaker.id });
    await s.req(speaker.s, { type: 'rtc:offer', payload: SENDRECV_OFFER });
    t.after(async () => { await s.hub.shutdown(); await s.transport.close(); });
    const who = role === 'controller' ? host : role === 'speaker' ? speaker : audience;
    const { h, socket } = await enter(t, who.s.last('room:state')!), node = h.node('speaking-summary'); shown(node, WAITING);
    s.transport.emitUplink(host.roomId, host.id, sine(960, 0.5)); s.transport.emitUplink(host.roomId, speaker.id, sine(960, 0.5)); s.mixers.get(host.roomId)!.tick();
    const before = media(h), frames = [...socket.sent]; socket.deliver(who.s.last('speaking')!); shown(node, summary('Public host', 'Public speaker'));
    assert.deepEqual(media(h), before); assert.deepEqual(socket.sent, frames);
  });
it('embed speaking actual SDK state-before-join-ACK disconnect permanently retires that entry', async t => {
  const h = await actualApp(t); h.form.submit(); await flush(); const socket = StageSocket.instances[0]!;
  socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
  await h.until(() => socket.sent.some(m => m.type === 'join'), 'join'); const snapshot = actualState(); snapshot.speakers = [person('target')];
  socket.deliver({ type: 'room:state', ...snapshot }); const client = h.clients[0] as StageClient, node = h.node('speaking-summary');
  socket.deliver({ type: 'speaking', participantIds: ['target'] }); shown(node, summary('乙'));
  socket.close(); await flush(); assert.equal(client.status, 'disconnected'); assert.ok(client.state); empty(node); assert.equal(h.leave.disabled, true);
  client.dispatchEvent(new CustomEvent('state', { detail: client.state })); client.dispatchEvent(new CustomEvent('status', { detail: 'live' }));
  client.dispatchEvent(new CustomEvent('speaking', { detail: report('target') })); empty(node); assert.equal(h.leave.disabled, true);
});
for (const terminal of ['closed', 'shutdown', 'kicked'] as const)
  it(`embed speaking actual ${terminal} continuation cannot erase a new entry started at disconnect`, async t => {
    const snapshot = actualState(); snapshot.speakers = [person('target')];
    const { h, socket, client } = await enter(t, snapshot), node = h.node('speaking-summary');
    socket.deliver({ type: 'speaking', participantIds: ['target'] }); shown(node, summary('乙')); let entered = false;
    client.on('status', ({ detail }) => { if (detail === 'disconnected' && !entered) { entered = true; empty(node); h.form.submit(); } });
    socket.deliver(terminal === 'kicked' ? { type: 'kicked', roomId: 'same-room' }
      : { type: 'room:closed', roomId: 'same-room', ...(terminal === 'shutdown' ? { reason: 'shutdown' as const } : {}) });
    await flush(); assert.equal(entered, true); assert.equal(h.clients.length, 2); empty(node); assert.equal(h.status.textContent, '連線中…');
    const next = StageSocket.instances.at(-1)!;
    next.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
    await h.until(() => next.sent.some(m => m.type === 'join'), 'replacement join'); const request = next.sent.find(m => m.type === 'join')!;
    next.deliver({ type: 'room:state', ...snapshot }); next.deliver({ type: 'ok', requestId: request.requestId }); await h.tick(20);
    next.deliver({ type: 'speaking', participantIds: [] }); shown(node, SILENT);
    const status = h.status.textContent; client.dispatchEvent(new CustomEvent('closed', { detail: { roomId: 'same-room' } }));
    client.dispatchEvent(new CustomEvent('speaking', { detail: report('target') })); client.dispatchEvent(new CustomEvent('kicked', { detail: { roomId: 'same-room' } }));
    shown(node, SILENT); assert.equal(h.status.textContent, status); assert.equal(h.leave.disabled, false);
  });

for (const projection of ['envelope', 'element'] as const)
  it(`embed speaking throwing ${projection} getter clears to waiting and records its rejected identity`, async t => {
    const { sdk, node } = await setup(t); sdk.emit('speaking', report('target'));
    const detail = report('controller'); let broken = true;
    if (projection === 'envelope') Object.defineProperty(detail, 'participantIds', { get() {
      if (broken) throw new Error('synthetic envelope getter'); return ['controller'];
    } });
    else Object.defineProperty(detail.participantIds, 0, { get() {
      if (broken) throw new Error('synthetic array getter'); return 'controller';
    } });
    sdk.emit('speaking', detail); shown(node, WAITING); broken = false;
    sdk.emit('speaking', report('target')); sdk.emit('speaking', detail); shown(node, summary('乙'));
  });
for (const command of ['close', 'transfer'] as const) for (const throwing of [false, true])
  it(`embed speaking ${command} consent cannot survive report getter nested winner and silent reconnect throwing=${throwing}`, async t => {
    let inside = () => {}; const { app, sdk, node } = await setup(t, { confirm: () => { inside(); return true; } });
    sdk.emit('speaking', report('target'));
    inside = () => {
      sdk.emit('speaking', { get participantIds() {
        sdk.emit('speaking', report('controller')); sdk.status = 'reconnecting';
        if (throwing) throw new Error('synthetic consent getter'); return ['controller', 'target'];
      } });
      sdk.status = 'live';
    };
    (command === 'close' ? app.node('close-room') : transfer(app)).click(); await flush();
    empty(node); assert.equal(sdk.closes.length, 0); assert.equal(sdk.transfers.length, 0); assert.equal(app.confirmations.length, 1);
  });
for (const projection of ['report', 'roster'] as const) for (const action of ['leave', 'replace'] as const) for (const throwing of [false, true])
  it(`embed speaking ${projection} projection ${action} throwing=${throwing} cannot overwrite a later valid entry`, async t => {
    const { app, sdk, node } = await setup(t, {}, audience()); sdk.emit('speaking', report('target'));
    let entered = false; const disrupt = () => {
      if (entered) return; entered = true;
      if (action === 'leave') app.leave.invoke(); else app.form.submit();
    };
    if (projection === 'report') sdk.emit('speaking', { get participantIds() {
      disrupt(); if (throwing) throw new Error('synthetic retired report getter'); return ['controller'];
    } });
    else {
      const outer = person('target'); Object.defineProperty(outer, 'name', { get() {
        disrupt(); if (throwing) throw new Error('synthetic retired roster getter'); return 'Outer';
      } });
      publish(sdk, audience([outer]));
    }
    assert.equal(entered, true); empty(node);
    if (action === 'leave') app.form.submit(); await flush();
    const next = app.clients.at(-1)!; assert.notEqual(next, sdk); const snapshot = state(); publish(next, snapshot);
    shown(node, WAITING); next.emit('speaking', report('controller')); shown(node, summary('甲'));
    const controls = () => {
      assert.equal(next.state, snapshot); assert.equal(app.leave.disabled, false);
      assert.equal(app.node('close-room').hidden, false); assert.equal(app.node('close-room').disabled, false);
      assert.equal(transfer(app).disabled, false); assert.match(app.status.textContent, /Synthetic room/);
    };
    controls(); sdk.emit('speaking', report('target')); sdk.emit('state', audience()); shown(node, summary('甲')); controls();
  });
