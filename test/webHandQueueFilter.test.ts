import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it, type TestContext } from 'node:test';
import { StageClient, decodeName } from '../packages/client/src/index.ts';
import { Room } from '../src/model/room.ts';
import { sanitizeName } from '../src/ws/validate.ts';
import type { RoomStatePayload } from '../shared/protocol.ts';
import { Deferred, flushSample, sampleApp, type SampleNode } from './fixtures/sampleApp.ts';
import { StagePeer, StageSocket } from './fixtures/embedSdkApp.ts';

// Whole production main module, controlled DOM; actual SDK/Room cases below replace only
// socket/media boundaries. No native focus, IME, accessibility-tree, layout or audio claim.
type View = { app: SampleNode; id(id: string): SampleNode; find(predicate: (node: SampleNode) => boolean): SampleNode };
const source = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const input = (h: View) => h.id('hand-queue-search');
const clear = (h: View) => h.id('hand-queue-clear');
const results = (h: View) => h.id('hand-queue-results');
const toolbar = (h: View) => input(h).parentNode!;
const panel = (h: View, prefix = '舉手佇列 ·') => h.find(node => node.tagName === 'h2' && node.textContent.startsWith(prefix)).parentNode!;
const rows = (h: View, prefix?: string) => panel(h, prefix).descendants().filter(node => node.classList.contains('person'));
const visibleIds = (h: View) => rows(h).filter(row => !row.hidden).map(row => row.dataset.participantId);
const labels = ['核准上台', '婉拒', '移交控制權', '踢出房間'] as const;
type Label = typeof labels[number];
const action = (row: SampleNode, label: Label = '核准上台') => {
  const found = row.descendants().filter(node => node.tagName === 'button' && node.textContent === label);
  assert.equal(found.length, 1); return found[0]!;
};
function query(h: View, value: string): void { input(h).value = value; input(h).oninput!(); }
function force(node: SampleNode): void { node.disabled = false; node.onclick!(); }
function sameNodes(actual: SampleNode[], expected: SampleNode[]): void {
  assert.equal(actual.length, expected.length); actual.forEach((node, index) => assert.equal(node, expected[index]));
}
function onceProperty<T extends object>(object: T, key: keyof T, edge: 'get' | 'set', callback: () => void): void {
  let value = object[key], fired = false;
  Object.defineProperty(object, key, { configurable: true,
    get() { if (edge === 'get' && !fired) { fired = true; callback(); } return value; },
    set(next: T[keyof T]) { if (edge === 'set' && !fired) { fired = true; callback(); } value = next; },
  });
}
function room(names = ['Alice & <Q&A>', 'Bob', 'Alice & <Q&A>']): Room {
  const r = new Room({ roomId: 'fictional-room', name: 'Fictional title', code: 'FICTIONAL_CODE', codeRequired: true,
    now: 0, limits: { maxSpeakers: 8, maxAudience: 300 },
    controller: { participantId: 'host', name: 'Host', resumeToken: 'fictional-host-resume' } });
  r.leaveStage('host');
  names.forEach((raw, index) => {
    r.join({ participantId: `requester-${index}`, name: sanitizeName(raw, 32)!, resumeToken: `fictional-${index}` }, index + 1);
    r.raiseHand(`requester-${index}`);
  });
  r.join({ participantId: 'unraised-match', name: sanitizeName(names[0] ?? 'Alice', 32)!, resumeToken: 'fictional-unraised' }, names.length + 1);
  r.assertInvariants(); return r;
}
async function setup(t: TestContext, confirm: (message: string) => boolean = () => true) {
  const anchor = "const app = document.querySelector<HTMLDivElement>('#app')!;";
  assert.equal(source.split(anchor).length, 2);
  const instrumented = source.replace(anchor, `${anchor}
const counts = { created: 0 }; (app as any).__counts = counts;
const createNode = document.createElement.bind(document);
document.createElement = ((tag: string) => { counts.created++; return createNode(tag); }) as typeof document.createElement;`);
  const storage: string[] = [], dialogs: string[] = [], calls: { method: string; id: string }[] = [];
  const h = sampleApp({ source: instrumented, decodeName, deferAudioDevices: true,
    confirm: message => { dialogs.push(message); return confirm(message); },
    localStorage: { getItem(key) { storage.push(`get:${key}`); return null; }, setItem(key, value) { storage.push(`set:${key}:${value}`); } } });
  t.after(() => h.cleanup());
  h.sdk.deviceLists[0]!.resolve({ inputs: [], outputs: [] }); await flushSample();
  for (const method of ['approve', 'reject', 'transferControl', 'kick']) Object.assign(h.sdk, { async [method](id: string) { calls.push({ method, id }); } });
  const main = h.find(node => node.tagName === 'main'), count = (h.app as SampleNode & { __counts: { created: number } }).__counts;
  let replacements = 0;
  const replace = main.replaceChildren.bind(main); main.replaceChildren = (...nodes) => { replacements++; replace(...nodes); };
  const effects = () => JSON.stringify({ calls, dialogs, storage, joins: h.sdk.joins.length, devices: h.sdk.deviceLists.length,
    previews: h.sdk.previews.length, polls: h.sdk.polls.length, timers: [...h.clock.jobs], inputs: h.sdk.inputDevices, outputs: h.sdk.outputDevices,
    volume: h.sdk.playbackVolume, muted: h.sdk.playbackMuted });
  return { ...h, main, calls, dialogs, count, replacements: () => replacements, effects };
}

it('controller hand search is native, explicitly labelled, persistent outside main, and independent of audience search', async t => {
  const h = await setup(t), bar = toolbar(h), search = input(h);
  assert.equal(bar.hidden, true); assert.equal(search.disabled, true); assert.equal(clear(h).disabled, true);
  assert.equal(search.type, 'search'); assert.equal(clear(h).type, 'button');
  assert.equal((search as SampleNode & { autocomplete: string }).autocomplete, 'off');
  assert.ok(bar.children.some(node => node.tagName === 'label' && node.attributes.for === search.id));
  assert.equal(search.attributes['aria-describedby'], results(h).id); assert.equal(results(h).attributes.role, 'status');
  assert.equal(bar.parentNode, h.app); assert.ok(h.app.children.indexOf(bar) < h.app.children.indexOf(h.main));
  const r = room(); h.sdk.snapshot(r.snapshot('host'));
  assert.equal(toolbar(h), bar); assert.equal(input(h), search); assert.equal(bar.hidden, false);
  assert.equal(results(h).textContent, '符合 3 / 3 筆舉手申請。');
  const audience = h.id('audience-search'); audience.value = 'Bob'; audience.oninput!();
  assert.equal(visibleIds(h).length, 3); query(h, ' ALICE & <Q&A> ');
  assert.deepEqual(visibleIds(h), ['requester-0', 'requester-2']);
  assert.deepEqual(rows(h, '觀眾 ·').filter(row => !row.hidden).map(row => row.dataset.participantId), ['requester-1']);
  assert.equal(audience.value, 'Bob'); clear(h).click(); assert.equal(search.value, ''); assert.equal(visibleIds(h).length, 3);
  assert.equal(audience.value, 'Bob'); assert.equal(clear(h).disabled, true);
});

it('actual Room 120-request workload filters three names without rebuilding, changing queue order, dirty gain or any external work', async t => {
  const names = Array.from({ length: 120 }, (_, i) => [19, 69, 119].includes(i) ? 'Alice & <Q&A>' : `Listener ${i}`);
  const r = room(names); r.join({ participantId: 'speaker', name: 'Speaker', resumeToken: 'fictional-speaker' }, 123);
  r.raiseHand('speaker'); r.approve('host', 'speaker', 124); r.assertInvariants();
  const h = await setup(t); h.sdk.snapshot(r.snapshot('host'));
  const all = h.main.descendants(), original = rows(h), search = input(h), state = JSON.stringify(h.sdk.state);
  const gain = h.find(node => node.dataset.roomAction === 'gain:speaker'); gain.value = '7';
  const counts = [h.count.created, h.replacements()], effects = h.effects();
  for (let round = 0; round < 10; round++) for (const value of [' ALICE & <Q&A> ', 'missing', ' ', 'Listener 1', '']) {
    query(h, value); sameNodes(h.main.descendants(), all); assert.equal(input(h), search); assert.equal(gain.value, '7');
  }
  query(h, ' ALICE & <Q&A> ');
  assert.deepEqual(visibleIds(h), ['requester-19', 'requester-69', 'requester-119']);
  assert.equal(results(h).textContent, '符合 3 / 120 筆舉手申請。');
  assert.equal(rows(h).length, 120); sameNodes(rows(h), original);
  assert.deepEqual([h.count.created, h.replacements()], counts); assert.equal(h.effects(), effects); assert.equal(JSON.stringify(h.sdk.state), state);
  assert.equal(rows(h, '觀眾 ·').every(row => !row.hidden), true);
  h.sdk.snapshot(r.snapshot('host')); assert.equal(input(h), search); assert.equal(search.value, ' ALICE & <Q&A> ');
  assert.equal(h.find(node => node.dataset.roomAction === 'gain:speaker').value, '0', 'usual authoritative snapshot still resets dirty gain');
  t.diagnostic('120 hands: 51 query edits preserve every main node, zero created nodes/replacements and zero external effects');
});

it('decoded NFC names match canonical queries while IDs, codes, tokens, annotations, room title and unraised names never match', async t => {
  const h = await setup(t), r = room(['Cafe\u0301 & <茶>', 'Cafe\u0000\u0301 & <茶>', '한글', '\u1112\u0000\u1161\u11ab글',
    'Alice &amp; Bob', '<img src=x onerror=alert(1)>', 'office', 'ｏｆｆｉｃｅ', 'oﬃce']);
  h.sdk.snapshot(r.snapshot('host'));
  for (const [value, ids] of [
    [' CAFE\u0301 & <茶> ', [0, 1]], [' CAFÉ ', [0, 1]], ['한글', [2, 3]],
    ['Alice &amp; Bob', [4]], ['Alice & Bob', []], ['<img src=x onerror=alert(1)>', [5]],
    ['OFFICE', [6]], ['ＯＦＦＩＣＥ', [7]], ['oﬃce', [8]], ['cafe', []],
    ['requester-0', []], ['fictional', []], ['FICTIONAL_CODE', []], ['fictional-host-resume', []], ['連線中斷', []],
  ] as const) { query(h, value); assert.deepEqual(visibleIds(h), ids.map(i => `requester-${i}`), value); }
  assert.equal(h.app.descendants().some(node => ['img', 'script', 'iframe'].includes(node.tagName)), false);
  query(h, 'missing'); assert.equal(results(h).textContent, '符合 0 / 9 筆舉手申請。沒有符合搜尋的舉手者。');
  assert.equal(rows(h).length, 9); for (let i = 0; i < 9; i++) r.reject('host', `requester-${i}`);
  h.sdk.snapshot(r.snapshot('host')); assert.equal(results(h).textContent, '符合 0 / 0 筆舉手申請。');
  assert.match(panel(h).textContent, /目前沒有舉手/);
});

it('same-owner snapshots preserve raw query and authoritative add/rename/reorder/removal, with distinct same-name IDs', async t => {
  const h = await setup(t), s = room().snapshot('host'); h.sdk.snapshot(clone(s)); query(h, ' ALICE ');
  const search = input(h); const old = rows(h); h.sdk.snapshot(clone(s)); sameNodes(rows(h), old);
  s.hands[1]!.name = 'Alice new'; s.hands.reverse(); h.sdk.snapshot(clone(s));
  assert.equal(search.value, ' ALICE '); assert.equal(input(h), search);
  assert.deepEqual(visibleIds(h), ['requester-2', 'requester-1', 'requester-0']);
  assert.ok(old.every(row => !row.isConnected));
  s.hands = s.hands.slice(1); h.sdk.snapshot(clone(s)); assert.deepEqual(visibleIds(h), ['requester-1', 'requester-0']);
  s.hands.push({ ...s.hands[0]!, participantId: 'new-request', name: 'Alice new' }); h.sdk.snapshot(clone(s));
  assert.deepEqual(visibleIds(h), ['requester-1', 'requester-0', 'new-request']);
  assert.equal(rows(h, '觀眾 ·').length, 4, 'duplicated hand/audience IDs remain separate lists');
});

for (const label of labels) it(`${label}: hidden, forged, detached, replaced and pre-input query callbacks do no pending/error/dialog/SDK work`, async t => {
  const h = await setup(t), s = room().snapshot('host'); h.sdk.snapshot(clone(s));
  const old = rows(h)[0]!, button = action(old, label), error = h.find(node => node.attributes.role === 'alert');
  h.sdk.emit('error', { message: 'independent error' }); query(h, 'Bob');
  const noAction = async () => { force(button); await flushSample(); assert.deepEqual(h.calls, []); assert.deepEqual(h.dialogs, []);
    assert.equal(error.hidden, false); assert.equal(error.textContent, 'independent error'); assert.equal(button.attributes['aria-busy'], 'false'); };
  await noAction(); old.hidden = false; old.children[0]!.textContent = 'Bob'; await noAction();
  clear(h).click(); input(h).value = 'Bob'; await noAction(); query(h, '');
  button.remove(); await noAction(); old.children.at(-1)!.append(button);
  h.sdk.snapshot({ ...clone(s), name: 'Changed' }); await noAction();
});

for (const outcome of ['resolve', 'reject'] as const) it(`hidden pending ${outcome} settles independently through disappearance/replacement and retains shared stage key`, async t => {
  const h = await setup(t), s = room().snapshot('host'), work = new Deferred<void>(); let requests = 0;
  Object.assign(h.sdk, { approve() { requests++; return work.promise; } });
  t.after(() => { if (work.status === 'pending') work.resolve(undefined); });
  h.sdk.snapshot(clone(s)); const old = rows(h)[0]!; action(old).click(); assert.equal(requests, 1);
  query(h, 'Bob'); h.sdk.snapshot({ ...clone(s), hands: s.hands.slice(1) }); h.sdk.snapshot(clone(s));
  const replacement = rows(h)[0]!; assert.notEqual(old, replacement); assert.equal(replacement.hidden, true);
  for (const node of [action(replacement), action(replacement, '婉拒')]) {
    assert.equal(node.disabled, true); assert.equal(node.attributes['aria-busy'], 'true'); force(node);
  }
  force(action(old)); assert.equal(requests, 1); assert.deepEqual(h.calls, []);
  if (outcome === 'resolve') work.resolve(undefined); else work.reject(new Error('pending failure'));
  await flushSample(); assert.equal(action(replacement).attributes['aria-busy'], 'false');
  clear(h).click(); action(replacement, '婉拒').click(); await flushSample(); assert.deepEqual(h.calls, [{ method: 'reject', id: 'requester-0' }]);
});

for (const transition of ['role', 'room', 'participant', 'leave', 'disconnect', 'closed', 'kicked'] as const) it(`${transition} retires query and every old hand callback; same owner reentry starts clear`, async t => {
  const h = await setup(t), original = room().snapshot('host'); h.sdk.snapshot(clone(original)); query(h, 'Alice');
  const old = rows(h)[0]!, oldInput = input(h).oninput!, oldClear = clear(h).onclick!;
  if (transition === 'leave') h.button('離開房間').click();
  else if (transition === 'disconnect') await h.sdk.disconnect();
  else if (transition === 'closed' || transition === 'kicked') await h.sdk.terminal(transition);
  else { const next = clone(original); if (transition === 'role') next.me.role = 'speaker';
    else if (transition === 'room') next.roomId = 'fictional-other'; else next.me.participantId = 'new-host'; h.sdk.snapshot(next); }
  await flushSample(); assert.equal(input(h).value, '');
  for (const label of labels) force(action(old, label)); oldInput(); oldClear(); await flushSample();
  assert.deepEqual(h.calls, []); assert.deepEqual(h.dialogs, []); assert.equal(input(h).value, '');
  h.sdk.snapshot(clone(original)); assert.equal(input(h).value, ''); assert.equal(visibleIds(h).length, 3);
});

it('same-owner reconnect preserves editable history and query while actions block; status live follows unchanged baseline policy', async t => {
  const h = await setup(t); h.sdk.snapshot(room().snapshot('host')); query(h, 'Alice'); const old = rows(h);
  h.sdk.setStatus('reconnecting'); sameNodes(rows(h), old); query(h, 'Bob'); assert.deepEqual(visibleIds(h), ['requester-1']);
  for (const label of labels) force(action(old[1]!, label)); await flushSample(); assert.deepEqual(h.calls, []); assert.deepEqual(h.dialogs, []);
  h.sdk.setStatus('waiting'); assert.equal(input(h).value, 'Bob'); action(old[1]!, '婉拒').click(); await flushSample();
  assert.deepEqual(h.calls, [{ method: 'reject', id: 'requester-1' }]);
});

for (const label of ['移交控制權', '踢出房間'] as const) for (const change of ['query', 'raw-query', 'role', 'removed', 'rebuild', 'reconnect', 'rejoin'] as const)
it(`${label} confirm reentry ${change} cannot dispatch a retired action`, async t => {
  let reenter = () => {}, reentered = false;
  const h = await setup(t, () => { reenter(); reentered = true; return true; }), s = room().snapshot('host'); h.sdk.snapshot(clone(s));
  reenter = () => {
    if (change === 'query') query(h, 'Bob');
    else if (change === 'raw-query') input(h).value = 'Bob';
    else if (change === 'reconnect') h.sdk.setStatus('reconnecting');
    else if (change === 'rejoin') { void h.sdk.disconnect(); h.sdk.snapshot(clone(s)); }
    else if (change === 'removed') { h.sdk.state!.hands = s.hands.slice(1); }
    else { const next = clone(s); if (change === 'role') next.me.role = 'speaker'; else next.name = 'Changed'; h.sdk.snapshot(next); }
  };
  action(rows(h)[0]!, label).click(); await flushSample(); assert.equal(h.dialogs.length, 1); assert.equal(reentered, true); assert.deepEqual(h.calls, []);
});

it('event-only role/transfer deltas keep snapshot policy and do not clear query until authoritative role loss', async t => {
  const h = await setup(t), s = room().snapshot('host'); h.sdk.snapshot(clone(s)); query(h, 'Alice');
  h.sdk.emit('role', { participantId: 'host', role: 'audience' }); h.sdk.emit('transferred', { fromId: 'host', toId: 'requester-0' });
  assert.equal(input(h).value, 'Alice'); assert.equal(toolbar(h).hidden, false);
  s.me.role = 'audience'; h.sdk.snapshot(s); assert.equal(input(h).value, ''); assert.equal(toolbar(h).hidden, true);
});

for (const target of ['query', 'hidden', 'count'] as const) for (const edge of ['get', 'set'] as const)
it(`finite ${target} ${edge} reentry preserves newest query, count and row visibility`, async t => {
  const h = await setup(t); h.sdk.snapshot(room().snapshot('host'));
  if (target === 'query') {
    if (edge === 'get') { input(h).value = 'Alice'; onceProperty(input(h), 'value', edge, () => query(h, 'Bob')); input(h).oninput!(); }
    else { query(h, 'Alice'); onceProperty(input(h), 'value', edge, () => query(h, 'Bob')); clear(h).click(); }
  } else {
    if (target === 'hidden') onceProperty(rows(h)[0]!, 'hidden', edge, () => query(h, 'Bob'));
    else onceProperty(results(h), 'textContent', edge, () => query(h, 'Bob'));
    query(h, 'missing');
  }
  assert.equal(input(h).value, 'Bob'); assert.deepEqual(visibleIds(h), ['requester-1']);
  assert.equal(results(h).textContent, '符合 1 / 3 筆舉手申請。');
});

for (const boundary of ['pending paint', 'command getter'] as const) it(`${boundary} query reentry is checked before hand method dispatch`, async t => {
  const h = await setup(t); h.sdk.snapshot(room().snapshot('host'));
  if (boundary === 'pending paint') onceProperty(h.find(node => node.attributes.role === 'alert'), 'hidden', 'set', () => query(h, 'Bob'));
  else { let dispatches = 0; const approve = () => { dispatches++; return Promise.resolve(); }; let reads = 0;
    Object.defineProperty(h.sdk, 'approve', { configurable: true, get() { reads++; query(h, 'Bob'); return approve; } });
    t.after(() => { assert.equal(reads, 1); assert.equal(dispatches, 0); }); }
  action(rows(h)[0]!).click(); await flushSample(); assert.deepEqual(h.calls, []); assert.equal(input(h).value, 'Bob');
});

async function actualSetup(t: TestContext) {
  StageSocket.instances = []; StagePeer.instances = [];
  let captures = 0, enumerations = 0;
  const globals = { window: new EventTarget(), WebSocket: StageSocket, RTCPeerConnection: StagePeer,
    navigator: { mediaDevices: { async enumerateDevices() { enumerations++; return []; }, async getUserMedia() { captures++; throw new Error('Unexpected capture'); } } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] }); let now = 1000; t.mock.method(performance, 'now', () => now);
  const audio = { autoplay: false, hidden: false, isConnected: true, volume: 1, muted: false, srcObject: null, pause() {}, async play() {}, remove() {} };
  const sdk = new StageClient({ url: 'wss://sample.test/ws', audioElement: audio as unknown as HTMLAudioElement });
  let beforeState: (() => void) | undefined, stateError: unknown;
  sdk.on('state', () => { try { beforeState?.(); } catch (error) { stateError = error; } });
  const h = sampleApp({ sdk, decodeName, confirm: () => true });
  const until = async (test: () => boolean) => { for (let i = 0; i < 80 && !test(); i++) { now += 10; t.mock.timers.tick(10); await flushSample(); } assert.ok(test()); };
  const join = async (s: RoomStatePayload) => {
    const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === '加入房間'));
    for (const [name, value] of Object.entries({ roomId: s.roomId, name: s.me.name, code: s.code! })) form.descendants().find(node => node.name === name)!.value = value;
    form.submit(); await flushSample(); const socket = StageSocket.instances.at(-1)!;
    socket.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 2000, icePerSecond: 2000, handRaiseIntervalMs: 10000 } });
    await until(() => socket.sent.some(message => message.type === 'join'));
    const request = socket.sent.find(message => message.type === 'join')!;
    socket.deliver({ type: 'room:state', ...s }); socket.deliver({ type: 'ok', requestId: request.requestId });
    await until(() => StagePeer.instances.at(-1)?.signalingState === 'stable'); return socket;
  };
  t.after(async () => {
    try { await sdk.disconnect(); await flushSample(); await h.cleanup(); assert.equal(captures, 0);
      assert.ok(StageSocket.instances.every(socket => socket.readyState === 3)); assert.ok(StagePeer.instances.every(peer => peer.connectionState === 'closed'));
      if (stateError) throw stateError;
    } finally { for (const [key, descriptor] of originals) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  return { ...h, join, until, effects: () => [captures, enumerations, StagePeer.instances.length, StagePeer.instances.reduce((sum, peer) => sum + peer.offers.length, 0)],
    beforeState(listener: (() => void) | undefined) { beforeState = listener; } };
}

for (const success of [true, false]) it(`actual SDK and Room hidden pending ${success ? 'ACK' : 'error'} settle across main replacement without duplicate control`, async t => {
  const h = await actualSetup(t), r = room(), socket = await h.join(r.snapshot('host'));
  const before = socket.sent.length, effects = h.effects(); query(h, 'Alice'); query(h, 'Bob'); clear(h).click();
  assert.equal(socket.sent.length, before); assert.deepEqual(h.effects(), effects);
  const old = rows(h)[0]!; action(old).click(); await h.until(() => socket.sent.some(message => message.type === 'stage:approve'));
  const request = socket.sent.find(message => message.type === 'stage:approve')!; assert.equal(request.targetId, 'requester-0');
  query(h, 'Bob'); const s = r.snapshot('host'); s.name = 'Changed'; socket.deliver({ type: 'room:state', ...s });
  const replacement = rows(h)[0]!; assert.notEqual(old, replacement); assert.equal(action(replacement).disabled, true);
  force(action(old)); force(action(replacement, '婉拒')); await flushSample();
  assert.equal(socket.sent.filter(message => ['stage:approve', 'stage:reject'].includes(message.type)).length, 1);
  socket.deliver(success ? { type: 'ok', requestId: request.requestId }
    : { type: 'error', requestId: request.requestId, code: 'conflict', message: '目前無法執行此操作。' });
  await flushSample(); assert.equal(action(replacement).attributes['aria-busy'], 'false');
  clear(h).click(); action(replacement, '婉拒').click(); await h.until(() => socket.sent.some(message => message.type === 'stage:reject'));
  const reject = socket.sent.find(message => message.type === 'stage:reject')!; assert.equal(reject.targetId, 'requester-0');
  r.reject('host', reject.targetId); socket.deliver({ type: 'room:state', ...r.snapshot('host') }); socket.deliver({ type: 'ok', requestId: reject.requestId });
  await flushSample(); assert.deepEqual(visibleIds(h), ['requester-1', 'requester-2']);
});

for (const change of ['rename', 'withdraw'] as const) it(`actual SDK prepaint ${change} rejects retained hand callbacks before app replaces rows`, async t => {
  const h = await actualSetup(t), r = room(), socket = await h.join(r.snapshot('host')); query(h, 'Alice');
  const old = rows(h)[0]!, before = socket.sent.length;
  socket.deliver({ type: 'error', code: 'bad_request', message: 'preserve current error' });
  h.beforeState(() => { for (const label of labels) force(action(old, label)); });
  if (change === 'rename') r.rename('requester-0', 'Changed'); else r.reject('host', 'requester-0');
  socket.deliver({ type: 'room:state', ...r.snapshot('host') }); await flushSample();
  assert.equal(socket.sent.length, before); assert.equal(h.find(node => node.attributes.role === 'alert').hidden, false);
  h.beforeState(undefined);
});

it('actual SDK and Room approve the filtered 120th requester once; authoritative pre-ACK removal keeps the query and unraised namesake separate', async t => {
  const r = room(Array.from({ length: 120 }, (_, i) => [19, 69, 119].includes(i) ? 'Alice & <Q&A>' : `Listener ${i}`));
  const h = await actualSetup(t), socket = await h.join(r.snapshot('host')); query(h, ' ALICE & <Q&A> ');
  const selected = rows(h)[119]!; assert.equal(selected.hidden, false); action(selected).click();
  await h.until(() => socket.sent.some(message => message.type === 'stage:approve'));
  const request = socket.sent.find(message => message.type === 'stage:approve')!; assert.equal(request.targetId, 'requester-119');
  r.approve('host', request.targetId, 130); socket.deliver({ type: 'room:state', ...r.snapshot('host') });
  assert.equal(selected.isConnected, false); assert.equal(input(h).value, ' ALICE & <Q&A> ');
  assert.deepEqual(visibleIds(h), ['requester-19', 'requester-69']); assert.equal(results(h).textContent, '符合 2 / 119 筆舉手申請。');
  force(action(selected)); socket.deliver({ type: 'ok', requestId: request.requestId }); await flushSample();
  assert.equal(socket.sent.filter(message => message.type === 'stage:approve').length, 1);
  assert.equal(rows(h, '觀眾 ·').some(row => row.dataset.participantId === 'unraised-match'), true); r.assertInvariants();
});

it('actual SDK reconnect allows local filtering only, then terminal same-ID reentry clears draft and old callbacks', async t => {
  const h = await actualSetup(t), r = room(), socket = await h.join(r.snapshot('host')); query(h, 'Alice');
  const old = rows(h)[0]!; socket.close(); await flushSample(); assert.equal(h.sdk.status, 'reconnecting');
  const sent = socket.sent.length, effects = h.effects(); query(h, 'Bob');
  for (const label of labels) force(action(old, label)); await flushSample();
  assert.equal(socket.sent.length, sent); assert.deepEqual(h.effects(), effects); assert.equal(input(h).value, 'Bob');
  await h.sdk.disconnect(); await flushSample(); assert.equal(input(h).value, ''); assert.equal(toolbar(h).hidden, true);
  const second = await h.join(r.snapshot('host')); assert.equal(input(h).value, ''); const before = second.sent.length;
  for (const label of labels) force(action(old, label)); await flushSample(); assert.equal(second.sent.length, before);
  assert.equal(visibleIds(h).length, 3);
});
