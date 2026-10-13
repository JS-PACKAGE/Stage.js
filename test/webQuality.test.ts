import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ConnectionQuality as Quality, ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

type App = ReturnType<typeof sampleApp>;
type Badge = { text: string; title?: string };
const PERSON_SELECTOR = '.person[data-participant-id]';
const BADGE_SELECTOR = '.badge.quality';

function managementState(handCount = 1, audienceCount = 2, speakerCount = 2): RoomStatePayload {
  const me = roomState({ participantId: 'controller', role: 'controller', onStage: true }).me;
  const speakers: ParticipantView[] = [me, ...Array.from({ length: speakerCount }, (_, index) => ({
    ...me, participantId: `speaker-${index}`, role: 'speaker' as const,
  }))];
  const audience: ParticipantView[] = Array.from({ length: audienceCount }, (_, index) => ({
    ...me, participantId: `audience-${index}`, role: 'audience', onStage: false, handRaised: index < handCount,
  }));
  return { ...roomState(me), speakers, hands: audience.slice(0, handCount), audience, audienceCount, status: 'live' };
}
function rows(h: App): SampleNode[] {
  return h.app.descendants().filter(node => node.classList.contains('person') && node.dataset.participantId !== undefined);
}
function badges(row: SampleNode): SampleNode[] {
  return row.descendants().filter(node => node.classList.contains('quality'));
}
function sliders(people: SampleNode[]): SampleNode[] {
  return people.flatMap(row => row.descendants().filter(node => node.tagName === 'input' && node.type === 'range'));
}
function sameNodes(actual: SampleNode[], expected: SampleNode[]): void {
  assert.equal(actual.length, expected.length);
  for (const [index, node] of actual.entries()) assert.equal(node, expected[index], `node ${index} must be retained`);
}
function assertBadges(h: App, expected: Record<string, Badge>): void {
  for (const row of rows(h)) {
    const wanted = expected[row.dataset.participantId!], found = badges(row);
    assert.equal(found.length, wanted ? 1 : 0, row.dataset.participantId);
    if (wanted) {
      assert.equal(found[0]!.textContent, wanted.text);
      if (wanted.title !== undefined) assert.equal(found[0]!.title, wanted.title);
    }
  }
}
function emit(h: App, participants: Quality[]): void { h.sdk.emit('quality', { participants }); }

/** Fake-node operation counts only: no browser layout, paint, CPU or audio measurements. */
function observeNodes(h: App) {
  const watched = new WeakSet<SampleNode>();
  const queries: { node: SampleNode; selector: string }[] = [];
  const toggles: SampleNode[] = [];
  const watch = () => {
    for (const node of [h.app, ...h.app.descendants()]) {
      if (watched.has(node)) continue;
      watched.add(node);
      const query = node.querySelectorAll.bind(node), toggle = node.classList.toggle;
      node.querySelectorAll = selector => { queries.push({ node, selector }); return query(selector); };
      node.classList.toggle = (name, force) => { toggles.push(node); return toggle(name, force); };
    }
  };
  watch();
  return { queries, toggles, watch, reset() { queries.length = 0; toggles.length = 0; },
    badgeRows: () => queries.filter(call => call.selector === BADGE_SELECTOR).map(call => call.node),
    fullQueries: () => queries.filter(call => call.selector === PERSON_SELECTOR).length };
}
async function setup(t: TestContext, state = managementState()) {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample(); h.sdk.snapshot(state);
  return { h, operations: observeNodes(h) };
}

it('whole sample applies 100 one-publisher quality reports with 100 badge lookups and no full-row queries at 593 rows', async t => {
  const state = managementState(292, 292, 8);
  const { h, operations } = await setup(t, state);
  const people = rows(h), controls = sliders(people);
  assert.equal(new Set(people.map(row => row.dataset.participantId)).size, 301);
  assert.equal(people.length, 593); assert.equal(controls.length, 8);
  const report = [{ participantId: 'speaker-0', uplinkLossPercent: 6 }];
  for (let index = 0; index < 100; index++) emit(h, report);
  const counts = { badgeLookups: operations.badgeRows().length, fullRowQueries: operations.fullQueries() };
  t.diagnostic(`100 reports / 301 participants / 593 rendered rows: ${JSON.stringify(counts)}`);
  assert.deepEqual(counts, { badgeLookups: 100, fullRowQueries: 0 });
  assert.equal(operations.badgeRows().every(row => row.dataset.participantId === 'speaker-0'), true);
  assert.equal(operations.toggles.length, 0);
  assertBadges(h, { 'speaker-0': { text: '連線不穩 6%' } });
  sameNodes(rows(h), people); sameNodes(sliders(rows(h)), controls);
});

it('whole sample clears omitted and empty quality reports, including both hand/audience rows and duplicate IDs', async t => {
  const { h, operations } = await setup(t);
  const people = rows(h);
  assert.equal(people.filter(row => row.dataset.participantId === 'audience-0').length, 2);
  const steps: { participants: Quality[]; expected: Record<string, Badge>; lookups: number }[] = [
    { participants: [], expected: {}, lookups: 0 },
    { participants: [{ participantId: 'missing', uplinkLossPercent: 99 }], expected: {}, lookups: 0 },
    { participants: [{ participantId: 'audience-0', uplinkLossPercent: 9 }, { participantId: 'audience-0', downlinkLossPercent: 11 }],
      expected: { 'audience-0': { text: '連線不穩 11%', title: '上行掉包 —%、下行掉包 11%' } }, lookups: 2 },
    { participants: [{ participantId: 'speaker-0', uplinkLossPercent: 5 }],
      expected: { 'speaker-0': { text: '連線不穩 5%' } }, lookups: 3 },
    { participants: [], expected: {}, lookups: 1 },
    { participants: [], expected: {}, lookups: 0 },
  ];
  for (const step of steps) {
    operations.reset(); emit(h, step.participants); assertBadges(h, step.expected);
    assert.equal(operations.fullQueries(), 0);
    assert.equal(operations.badgeRows().length, step.lookups);
    assert.equal(operations.toggles.length, 0); sameNodes(rows(h), people);
  }
});

it('whole sample seeds newly rendered and newly arrived rows from the latest quality report', async t => {
  const { h, operations } = await setup(t, managementState(0, 1, 1));
  emit(h, [
    { participantId: 'speaker-0', uplinkLossPercent: 7 },
    { participantId: 'speaker-1', downlinkLossPercent: 9 },
    { participantId: 'audience-0', uplinkLossPercent: 6 },
  ]);
  const retired = rows(h), oldBadges = retired.flatMap(badges);
  h.sdk.snapshot(managementState());
  assert.equal(retired.every(row => !row.isConnected), true);
  assert.equal(rows(h).every(row => !retired.includes(row)), true);
  assertBadges(h, { 'speaker-0': { text: '連線不穩 7%' }, 'speaker-1': { text: '連線不穩 9%' },
    'audience-0': { text: '連線不穩 6%' } });
  operations.watch(); operations.reset(); emit(h, []);
  assertBadges(h, {}); assert.equal(operations.fullQueries(), 0); assert.equal(operations.badgeRows().length, 4);
  assert.equal(operations.badgeRows().every(row => row.isConnected), true);
  sameNodes(retired.flatMap(badges), oldBadges);
});

it('whole sample leaves departed and retired quality nodes untouched through landing and same-identity rejoin', async t => {
  const state = managementState();
  const { h, operations } = await setup(t, state);
  emit(h, [{ participantId: 'speaker-0', uplinkLossPercent: 7 }, { participantId: 'audience-0', downlinkLossPercent: 8 }]);
  const retired = rows(h);
  const before = retired.map(row => ({ children: row.descendants(), text: row.textContent, titles: badges(row).map(badge => badge.title) }));
  const assertRetired = () => retired.forEach((row, index) => {
    assert.equal(row.isConnected, false); sameNodes(row.descendants(), before[index]!.children);
    assert.equal(row.textContent, before[index]!.text); assert.deepEqual(badges(row).map(badge => badge.title), before[index]!.titles);
  });
  h.sdk.snapshot({ ...state, speakers: state.speakers.filter(person => person.participantId !== 'speaker-0'),
    hands: [], audience: state.audience!.slice(1), audienceCount: 1 });
  operations.watch(); operations.reset();
  emit(h, [{ participantId: 'speaker-0', uplinkLossPercent: 99 }, { participantId: 'audience-0', downlinkLossPercent: 99 }]);
  assert.equal(operations.badgeRows().length, 0); assert.equal(operations.fullQueries(), 0); assertRetired();

  const beforeLanding = rows(h), landingChildren = beforeLanding.map(row => row.descendants());
  await h.sdk.disconnect(); await flushSample(); assert.equal(rows(h).length, 0);
  operations.watch(); operations.reset();
  emit(h, []); emit(h, [{ participantId: 'speaker-1', uplinkLossPercent: 6 }]);
  assert.equal(operations.queries.length, 0); assertRetired();
  beforeLanding.forEach((row, index) => { assert.equal(row.isConnected, false); sameNodes(row.descendants(), landingChildren[index]!); });

  h.sdk.snapshot(state); const rejoined = rows(h);
  assert.equal(rejoined.every(row => !retired.includes(row) && !beforeLanding.includes(row)), true);
  assertBadges(h, { 'speaker-1': { text: '連線不穩 6%' } });
  operations.watch(); operations.reset(); emit(h, [{ participantId: 'speaker-0', downlinkLossPercent: 9 }]);
  assertBadges(h, { 'speaker-0': { text: '連線不穩 9%' } });
  assert.equal(operations.fullQueries(), 0); assert.equal(operations.badgeRows().length, 2);
  assert.equal(operations.badgeRows().every(row => rejoined.includes(row)), true); assertRetired();
  beforeLanding.forEach((row, index) => sameNodes(row.descendants(), landingChildren[index]!));
});

it('whole sample preserves quality loss thresholds, rounding, missing metrics and exact badge titles', async t => {
  const { h } = await setup(t);
  const steps: { metrics: Omit<Quality, 'participantId'>; text?: string; title?: string }[] = [
    { metrics: {} },
    { metrics: { uplinkLossPercent: 4.9, downlinkLossPercent: 4.99, rttMs: 999 } },
    { metrics: { uplinkLossPercent: 5 }, text: '連線不穩 5%', title: '上行掉包 5%、下行掉包 —%' },
    { metrics: { uplinkLossPercent: 6.4, downlinkLossPercent: 8, rttMs: 30 }, text: '連線不穩 8%', title: '上行掉包 6.4%、下行掉包 8%、RTT 30 ms' },
    { metrics: { downlinkLossPercent: 5.5, rttMs: 0 }, text: '連線不穩 6%', title: '上行掉包 —%、下行掉包 5.5%、RTT 0 ms' },
    { metrics: { uplinkLossPercent: 5, downlinkLossPercent: 5 }, text: '連線不穩 5%', title: '上行掉包 5%、下行掉包 5%' },
    { metrics: { downlinkLossPercent: 4.9 } },
  ];
  const target = rows(h).find(row => row.dataset.participantId === 'speaker-0')!;
  let previous: SampleNode | undefined;
  for (const step of steps) {
    emit(h, [{ participantId: 'speaker-0', ...step.metrics }]);
    assertBadges(h, step.text ? { 'speaker-0': { text: step.text, title: step.title } } : {});
    const current = badges(target)[0]; if (previous && current) assert.equal(current, previous);
    previous = current;
  }
});

it('whole sample refreshes a reused mutable quality object without changing speaking, gain or playback controls', async t => {
  const { h, operations } = await setup(t);
  h.sdk.speaking = new Set(['speaker-0', 'audience-0']);
  h.sdk.emit('speaking', { participantIds: [...h.sdk.speaking] });
  const people = rows(h), classes = people.map(row => row.className), controls = sliders(people);
  const playback = h.id('playback-volume'); playback.value = '37'; controls[0]!.value = '7';
  const shared: Quality = { participantId: 'speaker-0', uplinkLossPercent: 6, rttMs: 10 };
  const report = { participants: [shared] };
  h.sdk.emit('quality', report);
  const target = people.find(row => row.dataset.participantId === 'speaker-0')!, badge = badges(target)[0];
  assert.ok(badge); operations.reset();
  shared.uplinkLossPercent = 9; shared.rttMs = 40; h.sdk.emit('quality', report);
  assertBadges(h, { 'speaker-0': { text: '連線不穩 9%', title: '上行掉包 9%、下行掉包 —%、RTT 40 ms' } });
  assert.equal(badges(target)[0], badge);
  h.sdk.emit('quality', report);
  assert.equal(operations.badgeRows().length, 2, 'unchanged reports still refresh, without metric or object-identity deduplication');
  shared.uplinkLossPercent = 4.9; delete shared.rttMs; h.sdk.emit('quality', report);
  assertBadges(h, {}); assert.equal(badge.isConnected, false);
  assert.equal(operations.fullQueries(), 0); assert.equal(operations.badgeRows().length, 3); assert.equal(operations.toggles.length, 0);
  sameNodes(rows(h), people); sameNodes(sliders(rows(h)), controls);
  assert.deepEqual(people.map(row => row.className), classes);
  assert.equal(controls[0]!.value, '7'); assert.equal(h.id('playback-volume'), playback); assert.equal(playback.value, '37');
});
