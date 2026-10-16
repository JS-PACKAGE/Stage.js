import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { sanitizeName } from '../src/ws/validate.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

type App = ReturnType<typeof sampleApp>;
interface Counts { created: number; replacements: number }
interface Call { method: string; args: unknown[] }
const source = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
const { decodeName } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href) as { decodeName(value: string): string };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function controllerState(audienceCount = 5, speakerCount = 1, handCount = 1): RoomStatePayload {
  const me = roomState({ participantId: 'controller', name: '主控', role: 'controller', onStage: true }).me;
  const speakers: ParticipantView[] = [me, ...Array.from({ length: speakerCount }, (_, index) => ({
    ...me, participantId: `speaker-${index}`, name: `台上 ${index}`, role: 'speaker' as const,
  }))];
  const names = ['Alice &amp; Bob', '張小明', 'CAROL', 'Alice &amp;amp; Bob', '&lt;img src=x onerror=alert(1)&gt;'];
  const audience: ParticipantView[] = Array.from({ length: audienceCount }, (_, index) => ({
    ...me, participantId: `audience-${index}`, name: names[index] ?? `觀眾 ${index}`,
    role: 'audience', onStage: false, handRaised: index < handCount,
  }));
  return { ...roomState(me), speakers, hands: audience.slice(0, handCount), audience, audienceCount, status: 'live' };
}

function namedAudience(rawNames: string[]): RoomStatePayload {
  const state = controllerState(rawNames.length, 0, 0);
  for (const [index, raw] of rawNames.entries()) {
    const name = sanitizeName(raw, 32); assert.ok(name);
    state.audience![index]!.name = name;
  }
  return state;
}

/** Whole-module fixture: node identity and operation counts, not browser focus, paint, CSS or hardware. */
async function setup(t: TestContext, confirm?: (message: string) => boolean) {
  const anchor = "const app = document.querySelector<HTMLDivElement>('#app')!;";
  assert.equal(source.split(anchor).length, 2, 'one whole-module instrumentation anchor');
  const instrumented = source.replace(anchor, `${anchor}
const filterCounts = { created: 0, replacements: 0 };
(app as any).__filterCounts = filterCounts;
const originalCreateElement = document.createElement.bind(document);
document.createElement = ((tag: string) => {
  filterCounts.created++;
  return originalCreateElement(tag);
}) as typeof document.createElement;`);
  const storage: { method: string; key: string; value?: string }[] = [];
  const calls: Call[] = [];
  const h = sampleApp({ source: instrumented, decodeName, confirm, deferAudioDevices: true,
    localStorage: {
      getItem(key) { storage.push({ method: 'get', key }); return null; },
      setItem(key, value) { storage.push({ method: 'set', key, value }); },
    },
  });
  t.after(() => h.cleanup());
  assert.equal(h.sdk.deviceLists.length, 1, 'only the pre-existing startup enumeration');
  h.sdk.deviceLists[0]!.resolve({ inputs: [], outputs: [] }); await flushSample();
  for (const method of ['approve', 'reject', 'forceMute', 'forceUnmute', 'removeFromStage', 'transferControl',
    'kick', 'setGain', 'mute', 'unmute', 'returnToStage', 'leaveStage', 'rotateCode', 'closeRoom', 'withdrawHand']) {
    Object.assign(h.sdk, { async [method](...args: unknown[]) { calls.push({ method, args }); } });
  }
  const main = h.find(node => node.tagName === 'main');
  const counts = (h.app as SampleNode & { __filterCounts: Counts }).__filterCounts;
  const replace = main.replaceChildren.bind(main);
  main.replaceChildren = (...nodes) => { counts.replacements++; replace(...nodes); };
  const effects = () => ({ calls: clone(calls), storage: clone(storage), joins: h.sdk.joins.length,
    previews: h.sdk.previews.length, polls: h.sdk.polls.length, raises: h.sdk.raises.length,
    deviceLists: h.sdk.deviceLists.length, inputDevices: [...h.sdk.inputDevices], outputDevices: [...h.sdk.outputDevices],
    timers: [...h.clock.jobs.keys()], playbackVolume: h.sdk.playbackVolume, playbackMuted: h.sdk.playbackMuted });
  const reset = () => { counts.created = counts.replacements = 0; };
  reset(); return { ...h, main, counts, storage, calls, effects, reset };
}
function search(h: App): SampleNode { return h.find(node => node.tagName === 'input' && node.type === 'search'); }
function toolbar(h: App): SampleNode {
  let node = search(h);
  while (node.parentNode && node.parentNode !== h.app) node = node.parentNode;
  assert.equal(node.parentNode, h.app, 'search toolbar must remain outside replaceable main content');
  return node;
}
function panel(h: App, prefix: string): SampleNode {
  const heading = h.find(node => node.tagName === 'h2' && node.textContent.startsWith(prefix));
  assert.ok(heading.parentNode); return heading.parentNode;
}
function rowsIn(node: SampleNode): SampleNode[] { return node.descendants().filter(child => child.classList.contains('person')); }
function audienceRows(h: App): SampleNode[] { return rowsIn(panel(h, '觀眾 ·')); }
function visibleIds(h: App): string[] { return audienceRows(h).filter(row => !row.hidden).map(row => row.dataset.participantId!); }
function type(h: App, value: string): void {
  const input = search(h); assert.ok(input.oninput, 'native search input needs an input handler');
  input.value = value; input.oninput();
}
function clear(h: App): SampleNode {
  const matches = toolbar(h).descendants().filter(node => node.tagName === 'button');
  assert.equal(matches.length, 1, 'one native clear button'); return matches[0]!;
}
function action(row: SampleNode, key: string): SampleNode {
  const matches = row.descendants().filter(node => node.dataset.roomAction === key);
  assert.equal(matches.length, 1); return matches[0]!;
}
function sameNodes(actual: SampleNode[], expected: SampleNode[]): void {
  assert.equal(actual.length, expected.length);
  for (const [index, node] of actual.entries()) assert.equal(node, expected[index], `retained node ${index}`);
}
function assertCount(h: App, matched: number, total: number): void {
  assert.match(toolbar(h).textContent, new RegExp(`${matched}\\s*[/／]\\s*${total}`));
}

it('whole sample offers a labeled native controller-only search before main and clears its local query', async t => {
  const h = await setup(t), input = search(h), bar = toolbar(h), clearButton = clear(h);
  assert.equal(bar.hidden, true); assert.equal(input.value, '');
  assert.ok(h.app.children.indexOf(bar) < h.app.children.indexOf(h.main));
  assert.equal(clearButton.type, 'button');
  assert.equal((input as SampleNode & { autocomplete: string }).autocomplete, 'off');
  assert.equal(bar.descendants().filter(node => node.attributes.role === 'status').length, 1);
  assert.ok(input.attributes['aria-label'] || input.parentNode?.tagName === 'label'
    || bar.descendants().some(node => node.tagName === 'label' && node.attributes.for === input.id), 'accessible name');
  h.sdk.snapshot(controllerState());
  assert.equal(toolbar(h), bar); assert.equal(search(h), input); assert.equal(bar.hidden, false);
  assertCount(h, 5, 5); assert.equal(clearButton.disabled, true);
  type(h, 'alice'); assertCount(h, 2, 5); assert.equal(clearButton.disabled, false);
  clearButton.click(); assert.equal(input.value, ''); assertCount(h, 5, 5);
  assert.equal(visibleIds(h).length, 5); assert.equal(clearButton.disabled, true);
});

it('whole sample filters 301 seats locally with zero room rebuilds and retains native input and all list nodes', async t => {
  const h = await setup(t), state = controllerState(292, 8, 2); h.sdk.snapshot(clone(state));
  const input = search(h), content = h.main.descendants(), people = rowsIn(h.main);
  assert.equal(new Set(people.map(row => row.dataset.participantId)).size, 301);
  assert.equal(people.length, 303, 'hand duplicates do not add seats');
  assert.ok(h.counts.created > 2000 && h.counts.created < 3200, 'bounded fake-node fixture');
  const before = h.effects(); h.reset();
  for (let round = 0; round < 10; round++) {
    for (const query of ['a', 'alice', ' ALICE & BOB ', '小明', 'absent person', '', '   ']) {
      type(h, query); assert.equal(search(h), input); sameNodes(h.main.descendants(), content);
      const fresh = clone(state); assert.notEqual(fresh, h.sdk.state); h.sdk.snapshot(fresh);
      assert.equal(input.value, query); sameNodes(rowsIn(h.main), people); sameNodes(h.main.descendants(), content);
    }
  }
  assert.deepEqual({ ...h.counts }, { created: 0, replacements: 0 });
  assert.deepEqual(h.effects(), before, 'typing and identical snapshots issue no SDK/device/storage work or new timers');
  t.diagnostic('301 seats / 303 rows / 70 input events and fresh snapshots: zero created nodes and zero main replacements');
});

it('whole sample trims case-insensitive substrings, supports Chinese, and searches only decoded display names', async t => {
  const h = await setup(t); h.sdk.snapshot(controllerState());
  for (const [query, expected] of [
    ['', [0, 1, 2, 3, 4]], [' \t\n ', [0, 1, 2, 3, 4]], [' ALiCe ', [0, 3]],
    [' & bOB ', [0]], ['小明', [1]], ['car', [2]], ['audience-0', []], ['主控', []], ['audience', []],
    ['Alice &amp; Bob', [3]], ['<img src=x onerror=alert(1)>', [4]], ['&lt;img', []],
  ] as const) {
    type(h, query);
    assert.deepEqual(visibleIds(h), expected.map(index => `audience-${index}`), JSON.stringify(query));
    assertCount(h, expected.length, 5);
  }
});

it('whole sample aligns canonical queries with real sanitized and decoded Latin, Hangul and reordered marks', async t => {
  // Stripping controls after server NFC can leave decomposed output, exercising the cached name key too.
  const state = namedAudience(['Cafe\u0301 & <茶>', 'Café & <茶>', 'Cafe\u0000\u0301 & <茶>',
    '한글', '\u1112\u1161\u11ab\u1100\u1173\u11af', '\u1112\u0000\u1161\u11ab글', 'a\u0315\u0300', '張小明']);
  const displays = ['Café & <茶>', 'Café & <茶>', 'Cafe\u0301 & <茶>', '한글', '한글',
    '\u1112\u1161\u11ab글', 'à\u0315', '張小明'];
  assert.equal(state.audience![0]!.name, 'Café &amp; &lt;茶&gt;');
  assert.deepEqual(state.audience!.map(person => decodeName(person.name)), displays);
  const h = await setup(t); h.sdk.snapshot(state);
  assert.deepEqual(audienceRows(h).map(row => row.descendants().find(node => node.tagName === 'strong')!.textContent), displays);
  const input = search(h), nodes = h.main.descendants(), before = h.effects(); h.reset();
  for (const [query, expected] of [
    [' CAFÉ & <茶> ', [0, 1, 2]], [' CAFE\u0301 & <茶> ', [0, 1, 2]], ['é', [0, 1, 2]],
    ['한글', [3, 4, 5]], ['\u1112\u1161\u11ab\u1100\u1173\u11af', [3, 4, 5]],
    ['a\u0300\u0315', [6]], ['a\u0315\u0300', [6]], ['À\u0315', [6]], [' 小明 ', [7]],
    ['cafe', []], ['&amp;', []], [' \t ', [0, 1, 2, 3, 4, 5, 6, 7]],
  ] as const) {
    type(h, query); assert.equal(search(h), input); assert.equal(input.value, query);
    assert.deepEqual(visibleIds(h), expected.map(index => `audience-${index}`), JSON.stringify(query));
    assertCount(h, expected.length, displays.length); sameNodes(h.main.descendants(), nodes);
  }
  assert.deepEqual({ ...h.counts }, { created: 0, replacements: 0 });
  assert.deepEqual(h.effects(), before);
});

it('whole sample preserves accents and compatibility distinctions instead of folding with NFKC', async t => {
  const h = await setup(t); h.sdk.snapshot(namedAudience(['Café', 'Cafe', 'office', 'ｏｆｆｉｃｅ', 'oﬃce', '①', '1']));
  for (const [query, expected] of [
    ['cafe', [1]], ['cafe\u0301', [0]], ['OFFICE', [2]], ['ＯＦＦＩＣＥ', [3]], ['oﬃce', [4]], ['①', [5]], ['1', [6]],
  ] as const) {
    type(h, query);
    assert.deepEqual(visibleIds(h), expected.map(index => `audience-${index}`), JSON.stringify(query));
    assertCount(h, expected.length, 7);
  }
});

it('whole sample retains the raw canonical query across authoritative rename and rebuild, then resets on rejoin', async t => {
  const h = await setup(t), state = namedAudience(['Cafe\u0301 & 茶', 'Other']); h.sdk.snapshot(clone(state));
  const input = search(h), query = ' CAFE\u0301 & 茶 '; type(h, query);
  assert.deepEqual(visibleIds(h), ['audience-0']);
  const renamed = namedAudience(['Other', 'Cafe\u0000\u0301 & 茶']);
  for (const next of [renamed, { ...clone(renamed), name: 'Changed room title' }]) {
    const old = audienceRows(h); h.reset(); h.sdk.snapshot(clone(next));
    assert.equal(h.counts.replacements, 1); assert.equal(old.every(row => !row.isConnected), true);
    assert.equal(search(h), input); assert.equal(input.value, query);
    assert.deepEqual(visibleIds(h), ['audience-1']); assertCount(h, 1, 2);
    const nodes = h.main.descendants(); h.sdk.snapshot(clone(next));
    assert.equal(input.value, query); assert.equal(h.counts.replacements, 1); sameNodes(h.main.descendants(), nodes);
  }
  await h.sdk.disconnect(); await flushSample(); assert.equal(input.value, ''); assert.equal(toolbar(h).hidden, true);
  h.sdk.snapshot(clone(renamed)); assert.equal(search(h), input); assert.equal(input.value, '');
  assert.deepEqual(visibleIds(h), ['audience-0', 'audience-1']); assertCount(h, 2, 2);
});

it('whole sample decodes display names exactly once and keeps HTML-looking names inert text', async t => {
  const h = await setup(t); h.sdk.snapshot(controllerState());
  const expected = ['Alice & Bob', '張小明', 'CAROL', 'Alice &amp; Bob', '<img src=x onerror=alert(1)>'];
  for (const [index, row] of audienceRows(h).entries()) {
    const name = row.descendants().find(node => node.tagName === 'strong'); assert.ok(name);
    assert.equal(name.textContent, expected[index]); assert.equal(name.children.length, 0);
  }
  type(h, 'Alice & Bob'); assert.deepEqual(visibleIds(h), ['audience-0']);
  type(h, 'Alice &amp; Bob'); assert.deepEqual(visibleIds(h), ['audience-3']);
  assert.equal(h.app.descendants().some(node => ['img', 'script', 'iframe'].includes(node.tagName)), false);
});

it('whole sample keeps the optional real-decoder seam opt-in for existing fixtures', async t => {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample(); h.sdk.snapshot(controllerState());
  assert.equal(audienceRows(h)[0]!.descendants().find(node => node.tagName === 'strong')!.textContent, 'Alice &amp; Bob');
});

it('whole sample distinguishes empty audience from no matches without changing server totals or other lists', async t => {
  const h = await setup(t), state = controllerState(); state.audienceCount = 9; h.sdk.snapshot(state);
  const stage = rowsIn(panel(h, '舞台 ·')), hands = rowsIn(panel(h, '舉手佇列 ·'));
  type(h, 'no result'); assertCount(h, 0, 5); assert.deepEqual(visibleIds(h), []);
  assert.match(panel(h, '觀眾 ·').textContent, /觀眾 · 9\/300/);
  assert.ok(h.app.descendants().some(node => !node.hidden && /沒有符合|找不到符合/.test(node.textContent)
    && node.children.length === 0), 'visible no-match message');
  assert.equal([...stage, ...hands].every(row => !row.hidden), true);
  sameNodes(rowsIn(panel(h, '舞台 ·')), stage); sameNodes(rowsIn(panel(h, '舉手佇列 ·')), hands);
  const empty = controllerState(0, 0, 0); h.sdk.snapshot(empty);
  assertCount(h, 0, 0); assert.match(panel(h, '觀眾 ·').textContent, /目前沒有觀眾/);
});

it('whole sample reapplies a retained query to added, renamed, removed and reordered audience snapshots', async t => {
  const h = await setup(t); let state = controllerState(); h.sdk.snapshot(clone(state));
  const input = search(h); type(h, 'alice');
  const steps: { change(next: RoomStatePayload): void; expected: string[] }[] = [
    { change: next => { next.audience![1]!.name = 'ALICE 新名字'; }, expected: ['audience-0', 'audience-1', 'audience-3'] },
    { change: next => { next.audience!.push({ ...next.audience![0]!, participantId: 'new-person', name: 'alice 新觀眾' }); next.audienceCount++; }, expected: ['audience-0', 'audience-1', 'audience-3', 'new-person'] },
    { change: next => { next.audience = next.audience!.filter(person => person.participantId !== 'audience-0'); next.audienceCount--; }, expected: ['audience-1', 'audience-3', 'new-person'] },
    { change: next => { next.audience!.reverse(); }, expected: ['new-person', 'audience-3', 'audience-1'] },
    { change: next => { next.audience!.find(person => person.participantId === 'audience-3')!.name = '退休名稱'; }, expected: ['new-person', 'audience-1'] },
  ];
  for (const step of steps) {
    const previous = audienceRows(h); state = clone(state); step.change(state); h.reset(); h.sdk.snapshot(clone(state));
    assert.equal(h.counts.replacements, 1); assert.equal(previous.every(row => !row.isConnected), true);
    assert.equal(search(h), input); assert.equal(input.value, 'alice'); assert.deepEqual(visibleIds(h), step.expected);
    assertCount(h, step.expected.length, state.audience!.length);
    const current = h.main.descendants(); h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1);
    sameNodes(h.main.descendants(), current);
  }
});

it('whole sample matches retained displayed names after an obsolete identical snapshot object is mutated', async t => {
  const h = await setup(t), obsolete = controllerState(); h.sdk.snapshot(obsolete);
  const rows = audienceRows(h); h.sdk.snapshot(clone(obsolete));
  obsolete.audience![0]!.name = 'Obsolete injected name'; obsolete.audience![0]!.participantId = 'obsolete-id';
  type(h, 'Alice & Bob'); assert.deepEqual(visibleIds(h), ['audience-0']); sameNodes(audienceRows(h), rows);
  type(h, 'Obsolete'); assert.deepEqual(visibleIds(h), []);
});

for (const transition of ['room', 'participant', 'speaker', 'audience', 'privacy'] as const) {
  it(`whole sample resets the query for ${transition} identity or authorization loss`, async t => {
    const h = await setup(t), original = controllerState(); h.sdk.snapshot(clone(original));
    const input = search(h), bar = toolbar(h); type(h, 'alice'); const next = clone(original);
    if (transition === 'room') next.roomId = 'new-room';
    else if (transition === 'participant') next.me.participantId = 'new-controller';
    else if (transition === 'privacy') delete next.audience;
    else next.me.role = transition;
    h.sdk.snapshot(next); assert.equal(search(h), input); assert.equal(toolbar(h), bar); assert.equal(input.value, '');
    const privateList = transition === 'privacy' || transition === 'speaker' || transition === 'audience';
    assert.equal(bar.hidden, privateList);
    if (privateList) {
      assert.equal(audienceRows(h).length, 0); assert.match(panel(h, '觀眾 ·').textContent, /觀眾名單僅提供給主控/);
    } else assert.equal(visibleIds(h).length, 5);
    h.sdk.snapshot(clone(original)); assert.equal(bar.hidden, false); assert.equal(input.value, ''); assertCount(h, 5, 5);
  });
}

for (const transition of ['leave', 'disconnect', 'closed', 'kicked'] as const) {
  it(`whole sample ${transition} clears filter data before same-room same-participant rejoin`, async t => {
    const h = await setup(t), state = controllerState(); h.sdk.snapshot(clone(state));
    const input = search(h), bar = toolbar(h), oldRows = audienceRows(h); type(h, 'alice');
    if (transition === 'leave') { h.button('離開房間').click(); await flushSample(); }
    else if (transition === 'disconnect') await h.sdk.disconnect();
    else await h.sdk.terminal(transition, transition === 'closed' ? 'shutdown' : undefined);
    await flushSample(); assert.equal(bar.hidden, true); assert.equal(input.value, '');
    assert.equal(oldRows.every(row => !row.isConnected), true); assert.equal(rowsIn(h.main).length, 0);
    h.sdk.snapshot(clone(state)); assert.equal(search(h), input); assert.equal(toolbar(h), bar);
    assert.equal(input.value, ''); assertCount(h, 5, 5); assert.equal(visibleIds(h).length, 5);
    assert.equal(audienceRows(h).every(row => !oldRows.includes(row)), true);
  });
}

it('whole sample keeps hidden audience and visible hand duplicates synchronized with quality and speaking', async t => {
  const h = await setup(t); h.sdk.snapshot(controllerState());
  const audience = audienceRows(h)[0]!, hand = rowsIn(panel(h, '舉手佇列 ·'))[0]!, input = search(h);
  type(h, 'carol'); assert.equal(audience.hidden, true); assert.equal(hand.hidden, false);
  h.sdk.speaking.add('audience-0'); h.sdk.emit('speaking', { participantIds: ['audience-0'] });
  h.sdk.emit('quality', { participants: [{ participantId: 'audience-0', uplinkLossPercent: 8, rttMs: 20 }] });
  for (const row of [audience, hand]) {
    assert.equal(row.classList.contains('speaking'), true);
    assert.equal(row.querySelector('.badge.quality')?.textContent, '連線不穩 8%');
  }
  assert.equal(audience.hidden, true); assert.equal(hand.hidden, false); assert.equal(search(h), input);
  type(h, 'alice'); assert.equal(audienceRows(h)[0], audience); assert.equal(audience.hidden, false);
  h.sdk.speaking.clear(); h.sdk.emit('speaking', { participantIds: [] }); h.sdk.emit('quality', { participants: [] });
  for (const row of [audience, hand]) {
    assert.equal(row.classList.contains('speaking'), false); assert.equal(row.querySelector('.badge.quality'), null);
  }
});

it('whole sample rejects hidden audience actions but leaves matching hand actions available', async t => {
  const dialogs: string[] = [], h = await setup(t, message => { dialogs.push(message); return true; });
  h.sdk.snapshot(controllerState()); const hidden = audienceRows(h)[0]!, hand = rowsIn(panel(h, '舉手佇列 ·'))[0]!;
  type(h, 'carol');
  for (const key of ['transfer', 'kick:audience-0']) {
    const button = action(hidden, key); assert.ok(button.onclick); button.disabled = false; button.onclick();
  }
  await flushSample(); assert.deepEqual(h.calls, []); assert.deepEqual(dialogs, []);
  const approve = hand.descendants().find(node => node.textContent === '核准上台'); assert.ok(approve); approve.click();
  await flushSample(); assert.deepEqual(h.calls, [{ method: 'approve', args: ['audience-0'] }]);
});

it('whole sample retains pending actions across hiding, clearing, identical snapshots and changed data', async t => {
  const h = await setup(t, () => true), state = controllerState(), pending = new Deferred<void>(); let kicks = 0;
  t.after(() => { if (pending.status === 'pending') pending.resolve(undefined); });
  Object.assign(h.sdk, { kick() { kicks++; return pending.promise; } });
  h.sdk.snapshot(clone(state)); const original = action(audienceRows(h)[0]!, 'kick:audience-0'); original.click();
  assert.equal(kicks, 1); assert.equal(original.attributes['aria-busy'], 'true');
  type(h, 'carol'); type(h, 'alice'); h.sdk.snapshot(clone(state));
  assert.equal(action(audienceRows(h)[0]!, 'kick:audience-0'), original); assert.equal(original.disabled, true);
  original.disabled = false; original.onclick!(); assert.equal(kicks, 1, 'pending key wins even for directly invoked callback');
  state.name = 'Changed room title'; h.sdk.snapshot(clone(state));
  const replacement = action(audienceRows(h)[0]!, 'kick:audience-0'); assert.notEqual(replacement, original);
  assert.equal(replacement.disabled, true); assert.equal(replacement.attributes['aria-busy'], 'true');
  original.disabled = false; original.onclick!(); replacement.disabled = false; replacement.onclick!(); assert.equal(kicks, 1);
  pending.resolve(undefined); await flushSample(); assert.equal(replacement.disabled, false);
  assert.equal(replacement.attributes['aria-busy'], 'false');
});

for (const change of ['rebuild', 'role', 'privacy', 'room', 'participant', 'reconnect'] as const) {
  it(`whole sample refuses a stale audience callback after ${change}`, async t => {
    const dialogs: string[] = [], h = await setup(t, message => { dialogs.push(message); return true; });
    const state = controllerState(); h.sdk.snapshot(clone(state)); const old = audienceRows(h)[0]!;
    if (change === 'rebuild') state.name = 'Changed room';
    else if (change === 'role') state.me.role = 'speaker';
    else if (change === 'privacy') delete state.audience;
    else if (change === 'room') state.roomId = 'new-room';
    else if (change === 'participant') state.me.participantId = 'new-controller';
    if (change === 'reconnect') h.sdk.setStatus('reconnecting'); else h.sdk.snapshot(clone(state));
    for (const key of ['transfer', 'kick:audience-0']) {
      const button = action(old, key); button.disabled = false; assert.ok(button.onclick); button.onclick();
    }
    await flushSample(); assert.deepEqual(h.calls, []); assert.deepEqual(dialogs, []);
  });
}

for (const method of ['transferControl', 'kick'] as const) {
  for (const change of ['filter', 'role', 'privacy', 'target', 'room', 'reconnect', 'same-id-rejoin'] as const) {
    it(`whole sample rechecks ${method} admission when confirm reenters ${change}`, async t => {
      let onConfirm: (() => void) | undefined, confirmations = 0, reentered = false;
      const h = await setup(t, () => { confirmations++; onConfirm?.(); return true; }), state = controllerState();
      h.sdk.snapshot(clone(state));
      onConfirm = () => {
        const next = clone(state);
        if (change === 'filter') type(h, 'carol');
        else if (change === 'reconnect') h.sdk.setStatus('reconnecting');
        else if (change === 'target') h.sdk.state!.audience = state.audience!.slice(1);
        else if (change === 'same-id-rejoin') { void h.sdk.disconnect(); h.sdk.snapshot(next); }
        else {
          if (change === 'role') next.me.role = 'speaker';
          else if (change === 'privacy') delete next.audience;
          else next.roomId = 'new-room';
          h.sdk.snapshot(next);
        }
        reentered = true;
      };
      action(audienceRows(h)[0]!, method === 'kick' ? 'kick:audience-0' : 'transfer').click(); await flushSample();
      assert.equal(confirmations, 1); assert.equal(reentered, true, 'the confirm transition must complete without a fixture error');
      assert.deepEqual(h.calls, [], 'no stale confirmed action reaches the SDK');
    });
  }
}

it('whole sample keeps authoritative gain reset and cached unchanged snapshots while filtering', async t => {
  const h = await setup(t), state = controllerState(); h.sdk.snapshot(clone(state)); type(h, 'alice');
  const input = search(h), gain = h.find(node => node.dataset.roomAction === 'gain:speaker-0');
  gain.value = '7'; h.reset(); h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 1); assert.equal(search(h), input); assert.equal(input.value, 'alice');
  assert.equal(h.find(node => node.dataset.roomAction === 'gain:speaker-0').value, '0'); assertCount(h, 2, 5);
  const nodes = h.main.descendants(); h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1);
  sameNodes(h.main.descendants(), nodes);
});
