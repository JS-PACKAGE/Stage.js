import assert from 'node:assert/strict';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

type App = ReturnType<typeof sampleApp>;
const PERSON_SELECTOR = '.person[data-participant-id]';

function managementState(handCount: number, audienceCount = 292, speakerCount = 8): RoomStatePayload {
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
function gainSliders(people: SampleNode[]): SampleNode[] {
  return people.flatMap(row => row.descendants().filter(node => node.tagName === 'input' && node.type === 'range'));
}
function assertSpeaking(h: App, ids: string[]): void {
  const expected = new Set(ids);
  for (const row of rows(h)) {
    assert.equal(row.classList.contains('speaking'), expected.has(row.dataset.participantId!), row.dataset.participantId);
  }
}
function assertSameNodes(actual: SampleNode[], expected: SampleNode[], description: string): void {
  assert.equal(actual.length, expected.length, description);
  for (const [index, node] of actual.entries()) assert.equal(node, expected[index], `${description}: node ${index}`);
}
function emitSpeaking(h: App, ids: string[]): void {
  // The real SDK updates its public speaking snapshot before notifying the sample.
  h.sdk.speaking = new Set(ids);
  h.sdk.emit('speaking', { participantIds: ids });
}

/** Count fake-node operations only; this is not a native browser layout, paint, or timing benchmark. */
function observeNodes(h: App) {
  const watched = new WeakSet<SampleNode>();
  const queries: { node: SampleNode; selector: string }[] = [];
  const toggles: { node: SampleNode; name: string; force: boolean | undefined }[] = [];
  const watch = () => {
    for (const node of [h.app, ...h.app.descendants()]) {
      if (watched.has(node)) continue;
      watched.add(node);
      const query = node.querySelectorAll.bind(node), toggle = node.classList.toggle;
      node.querySelectorAll = selector => { queries.push({ node, selector }); return query(selector); };
      node.classList.toggle = (name, force) => { toggles.push({ node, name, force }); return toggle(name, force); };
    }
  };
  watch();
  return { queries, toggles, watch, reset() { queries.length = 0; toggles.length = 0; } };
}
async function setup(t: TestContext, state: RoomStatePayload, speaking: string[] = []) {
  const h = sampleApp(); t.after(() => h.cleanup()); await flushSample();
  h.sdk.speaking = new Set(speaking); h.sdk.snapshot(state);
  return { h, operations: observeNodes(h) };
}

for (const handCount of [20, 292]) {
  it(`whole sample applies 100 speaking changes with zero queries and 199 toggles at ${301 + handCount} rows`, async t => {
    const { h, operations } = await setup(t, managementState(handCount));
    const people = rows(h), sliders = gainSliders(people), nodes = h.app.descendants();
    assert.equal(people.length, 301 + handCount);
    assert.equal(sliders.length, 8);
    sliders[0]!.value = '7';
    for (let index = 0; index < 100; index++) {
      const ids = [`speaker-${index % 2}`]; emitSpeaking(h, ids);
      assertSpeaking(h, ids);
      assertSameNodes(rows(h), people, 'speaking must retain every person row');
      assertSameNodes(gainSliders(rows(h)), sliders, 'speaking must retain every gain slider');
      assert.equal(sliders[0]!.value, '7', 'speaking must not overwrite an in-progress gain selection');
      assert.equal(operations.queries.length, 0);
      assert.equal(operations.toggles.length, 2 * index + 1);
    }
    assertSameNodes(h.app.descendants(), nodes, 'speaking must not rebuild the sample DOM');
    assert.equal(operations.toggles.every(call => call.name === 'speaking'), true);
    assert.equal(operations.toggles.every(call => ['speaker-0', 'speaker-1'].includes(call.node.dataset.participantId!)), true);
  });

  it(`whole sample performs no node operations for 100 unchanged speaking sets at ${301 + handCount} rows`, async t => {
    const { h, operations } = await setup(t, managementState(handCount), ['speaker-0', 'audience-0']);
    const nodes = h.app.descendants();
    for (let index = 0; index < 100; index++) {
      emitSpeaking(h, index % 2 ? ['audience-0', 'speaker-0', 'speaker-0'] : ['speaker-0', 'audience-0']);
      assertSpeaking(h, ['speaker-0', 'audience-0']);
      assert.equal(operations.queries.length, 0); assert.equal(operations.toggles.length, 0);
    }
    assertSameNodes(h.app.descendants(), nodes, 'unchanged speaking must preserve the sample DOM');
  });
}

it('whole sample diffs empty, multiple, unknown, reordered and duplicate IDs while updating both hand/audience rows', async t => {
  const { h, operations } = await setup(t, managementState(1, 2, 2));
  const duplicated = rows(h).filter(row => row.dataset.participantId === 'audience-0');
  assert.equal(duplicated.length, 2);
  const steps: { ids: string[]; toggles: number }[] = [
    { ids: [], toggles: 0 },
    { ids: ['missing'], toggles: 0 },
    { ids: ['missing', 'missing'], toggles: 0 },
    { ids: [], toggles: 0 },
    { ids: ['audience-0', 'audience-0'], toggles: 2 },
    { ids: ['audience-0'], toggles: 0 },
    { ids: ['audience-0', 'speaker-0', 'missing', 'speaker-0'], toggles: 1 },
    { ids: ['missing', 'speaker-0', 'audience-0'], toggles: 0 },
    { ids: ['audience-1', 'missing'], toggles: 4 },
    { ids: [], toggles: 1 },
    { ids: [], toggles: 0 },
  ];
  for (const step of steps) {
    operations.reset(); emitSpeaking(h, step.ids); assertSpeaking(h, step.ids);
    assert.equal(operations.queries.length, 0);
    assert.equal(operations.toggles.length, step.toggles, JSON.stringify(step.ids));
    assert.equal(operations.toggles.every(call => call.name === 'speaking'), true);
  }
});

it('whole sample seeds each render from SDK speaking state without aliasing its mutable set', async t => {
  const state = managementState(1, 2, 2);
  const { h, operations } = await setup(t, state, ['speaker-0', 'audience-0', 'missing']);
  assertSpeaking(h, ['speaker-0', 'audience-0']);
  h.sdk.speaking.clear(); h.sdk.emit('speaking', { participantIds: [] });
  assertSpeaking(h, []); assert.equal(operations.toggles.length, 3); assert.equal(operations.queries.length, 0);

  h.sdk.speaking = new Set(['speaker-1', 'audience-0']); h.sdk.snapshot(state);
  assertSpeaking(h, ['speaker-1', 'audience-0']); operations.watch(); operations.reset();
  emitSpeaking(h, ['speaker-1', 'audience-0']);
  assert.equal(operations.toggles.length, 0); assert.equal(operations.queries.length, 0);
  emitSpeaking(h, []); assertSpeaking(h, []);
  assert.equal(operations.toggles.length, 3); assert.equal(operations.queries.length, 0);
});

it('whole sample drops departed and retired rows across snapshot, landing and same-identity rejoin', async t => {
  const state = managementState(1, 2, 2);
  const { h, operations } = await setup(t, state, ['speaker-0', 'audience-0']);
  const original = rows(h), originalClasses = original.map(row => row.className);
  h.sdk.snapshot({ ...state, speakers: state.speakers.filter(person => person.participantId !== 'speaker-0'),
    hands: [], audience: state.audience!.filter(person => person.participantId !== 'audience-0'), audienceCount: 1 });
  assert.equal(original.every(row => !row.isConnected), true);
  assert.equal(rows(h).length, 3); operations.watch(); operations.reset();
  emitSpeaking(h, []); assertSpeaking(h, []);
  assert.equal(operations.queries.length, 0); assert.equal(operations.toggles.length, 0);
  emitSpeaking(h, ['speaker-0', 'audience-0']); assertSpeaking(h, []);
  assert.equal(operations.toggles.length, 0, 'departed IDs must not retain indexed rows');
  emitSpeaking(h, ['speaker-1']); assertSpeaking(h, ['speaker-1']);
  assert.equal(operations.toggles.length, 1);
  assert.deepEqual(original.map(row => row.className), originalClasses);

  const beforeLanding = rows(h), beforeLandingClasses = beforeLanding.map(row => row.className);
  await h.sdk.disconnect(); await flushSample();
  assert.equal(rows(h).length, 0); assert.equal(beforeLanding.every(row => !row.isConnected), true);
  operations.watch(); operations.reset();
  emitSpeaking(h, []); emitSpeaking(h, ['speaker-0', 'speaker-1', 'audience-0']);
  assert.equal(operations.queries.length, 0); assert.equal(operations.toggles.length, 0);
  assert.deepEqual(beforeLanding.map(row => row.className), beforeLandingClasses);

  h.sdk.speaking = new Set(['audience-0']); h.sdk.snapshot(state);
  const rejoined = rows(h); assertSpeaking(h, ['audience-0']);
  assert.equal(rejoined.every(row => !original.includes(row) && !beforeLanding.includes(row)), true);
  operations.watch(); operations.reset(); emitSpeaking(h, ['speaker-0']); assertSpeaking(h, ['speaker-0']);
  assert.equal(operations.queries.length, 0); assert.equal(operations.toggles.length, 3);
  assert.equal(operations.toggles.every(call => rejoined.includes(call.node)), true);
  assert.deepEqual(original.map(row => row.className), originalClasses);
  assert.deepEqual(beforeLanding.map(row => row.className), beforeLandingClasses);
});

it('whole sample preserves quality badges and gain controls while speaking changes stay indexed', async t => {
  const { h, operations } = await setup(t, managementState(1, 2, 2), ['speaker-0']);
  const people = rows(h), sliders = gainSliders(people);
  const targetRows = people.filter(row => ['speaker-0', 'audience-0'].includes(row.dataset.participantId!));
  const badges = (row: SampleNode) => row.descendants().filter(node => node.classList.contains('quality'));
  h.sdk.emit('quality', { participants: [
    { participantId: 'speaker-0', uplinkLossPercent: 6.4, downlinkLossPercent: 8, rttMs: 30 },
    { participantId: 'audience-0', downlinkLossPercent: 11 },
    { participantId: 'missing', uplinkLossPercent: 99 },
  ] });
  assert.equal(operations.queries.filter(call => call.selector === PERSON_SELECTOR).length, 0);
  assert.equal(operations.toggles.length, 0); assertSpeaking(h, ['speaker-0']);
  const firstBadges = targetRows.map(row => {
    const found = badges(row); assert.equal(found.length, 1);
    assert.equal(found[0]!.textContent, row.dataset.participantId === 'speaker-0' ? '連線不穩 8%' : '連線不穩 11%');
    if (row.dataset.participantId === 'speaker-0') assert.match(found[0]!.title, /上行掉包 6.4%、下行掉包 8%、RTT 30 ms/);
    return found[0]!;
  });
  operations.watch(); operations.reset();
  emitSpeaking(h, ['audience-0']); assertSpeaking(h, ['audience-0']);
  assert.equal(operations.queries.length, 0); assert.equal(operations.toggles.length, 3);
  assertSameNodes(targetRows.flatMap(badges), firstBadges, 'speaking must preserve quality badges');
  assertSameNodes(rows(h), people, 'speaking must preserve quality-bearing rows');
  assertSameNodes(gainSliders(rows(h)), sliders, 'speaking must preserve gain controls');

  operations.reset();
  h.sdk.emit('quality', { participants: [{ participantId: 'speaker-0', uplinkLossPercent: 5, rttMs: 40 }] });
  assert.equal(operations.queries.filter(call => call.selector === PERSON_SELECTOR).length, 0);
  assert.equal(operations.toggles.length, 0); assertSpeaking(h, ['audience-0']);
  for (const [index, row] of targetRows.entries()) {
    const found = badges(row);
    if (row.dataset.participantId === 'speaker-0') {
      assert.equal(found[0], firstBadges[index]); assert.equal(found[0]!.textContent, '連線不穩 5%');
      assert.match(found[0]!.title, /RTT 40 ms/);
    } else assert.equal(found.length, 0, 'omitted quality entries remove both duplicate warnings');
  }
  h.sdk.emit('quality', { participants: [{ participantId: 'speaker-0', uplinkLossPercent: 4.9 }] });
  assert.equal(people.flatMap(badges).length, 0);
  assertSpeaking(h, ['audience-0']); assertSameNodes(rows(h), people, 'quality must retain rows');
  assertSameNodes(gainSliders(rows(h)), sliders, 'quality must retain gain controls');
});
