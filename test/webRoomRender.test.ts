import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ConnectionQuality, ParticipantView, RoomStatePayload } from '../shared/protocol.ts';
import { Deferred, flushSample, roomState, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

type App = ReturnType<typeof sampleApp>;
interface RenderCounts { created: number; replacements: number; rows: number }
interface RoomReferences { heading?: SampleNode; people: SampleNode[]; gains: SampleNode[]; audience: SampleNode[]; pending: number }
const source = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function replaceExactly(text: string, before: string, after: string): string {
  assert.equal(text.split(before).length, 2, `expected one instrumentation anchor: ${before}`);
  return text.replace(before, after);
}

/** Counts bounded fake-node operations only, not browser layout, paint, CPU, or RSS. */
async function setup(t: TestContext, confirm?: (message: string) => boolean) {
  const instrumented = replaceExactly(source, "const app = document.querySelector<HTMLDivElement>('#app')!;", `
const app = document.querySelector<HTMLDivElement>('#app')!;
const renderCounts = { created: 0, replacements: 0, rows: 0 };
(app as any).__renderCounts = renderCounts;
(app as any).__roomReferences = () => ({ heading: renderedAudienceHeading,
  people: [...personRows.values()].flat(), gains: renderedGainInputs.map(({ input }) => input),
  audience: audienceFilterRows.map(({ row }) => row), pending: pendingRoomActions.size });
const originalCreateElement = document.createElement.bind(document);
document.createElement = ((tag: string) => {
  renderCounts.created++;
  return originalCreateElement(tag);
}) as typeof document.createElement;`);
  const observed = replaceExactly(instrumented, "  const row = element('li', 'person');",
    "  renderCounts.rows++;\n  const row = element('li', 'person');");
  const h = sampleApp({ source: observed, confirm }); t.after(() => h.cleanup()); await flushSample();
  const counts = (h.app as SampleNode & { __renderCounts: RenderCounts }).__renderCounts;
  const references = (h.app as SampleNode & { __roomReferences(): RoomReferences }).__roomReferences;
  const main = h.find(node => node.tagName === 'main'), replace = main.replaceChildren.bind(main);
  main.replaceChildren = (...nodes) => { counts.replacements++; replace(...nodes); };
  const reset = () => { counts.created = counts.replacements = counts.rows = 0; };
  reset();
  return { ...h, main, counts, reset, references };
}
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
const rows = (h: App) => h.app.descendants().filter(node => node.classList.contains('person'));
const gain = (h: App) => h.find(node => node.dataset.roomAction === 'gain:speaker-0');
const action = (h: App, key: string) => h.find(node => node.dataset.roomAction === key);
const notices = (h: App) => h.find(node => node.classList.contains('notices'));
const errorBox = (h: App) => h.find(node => node.attributes.role === 'alert');
const status = (h: App) => h.find(node => node.parentNode?.tagName === 'header' && node.classList.contains('badge'));
const audienceHeading = (h: App) => h.find(node => node.tagName === 'h2' && node.textContent.startsWith('觀眾 ·'));
function sameNodes(actual: SampleNode[], expected: SampleNode[]): void {
  assert.equal(actual.length, expected.length);
  for (const [index, node] of actual.entries()) assert.equal(node, expected[index], `retained node ${index}`);
}
function emitSpeaking(h: App, ids: string[]): void {
  // The SDK publishes its current set before emitting speaking; detail can contain duplicates.
  h.sdk.speaking = new Set(ids); h.sdk.emit('speaking', { participantIds: ids });
}
function assertSpeaking(h: App, ids: string[]): void {
  const expected = new Set(ids);
  for (const row of rows(h)) {
    assert.equal(row.classList.contains('speaking'), expected.has(row.dataset.participantId!), row.dataset.participantId);
  }
}

it('whole sample renders ten fresh identical 301-seat snapshots once and retains all room controls', async t => {
  const h = await setup(t), state = managementState(0, 292, 8);
  h.sdk.snapshot(clone(state));
  const people = rows(h), content = h.main.descendants(), first = { ...h.counts };
  assert.equal(people.length, 301); assert.equal(first.rows, 301); assert.equal(first.replacements, 1);
  assert.ok(first.created > 2000 && first.created < 3000, 'bounded management render node count');
  for (let index = 1; index < 10; index++) {
    const fresh = clone(state); assert.notEqual(fresh, h.sdk.state);
    h.sdk.snapshot(fresh);
    sameNodes(rows(h), people); sameNodes(h.main.descendants(), content);
  }
  assert.deepEqual({ ...h.counts }, first);
  const signatureCharacters = JSON.stringify([state, undefined, [], [], h.sdk.status]).length;
  assert.ok(signatureCharacters > 50000 && signatureCharacters < 60000);
  t.diagnostic(`10 snapshots / 301 seats: ${JSON.stringify(h.counts)}; serialized key ${signatureCharacters} UTF-16 code units`);
});

it('whole sample redraws exactly once for an unreleased dirty gain and restores authoritative 7 to 0 without an input handler', async t => {
  const h = await setup(t), state = managementState(0, 292, 8);
  h.sdk.snapshot(clone(state)); const original = gain(h), first = { ...h.counts };
  assert.equal(original.value, '0'); assert.equal(original.oninput, null);
  original.value = '7'; h.sdk.snapshot(clone(state));
  const current = gain(h); assert.notEqual(current, original); assert.equal(original.isConnected, false);
  assert.equal(current.value, '0'); assert.equal(current.oninput, null);
  assert.deepEqual({ ...h.counts }, { created: first.created * 2, replacements: 2, rows: 602 });
  for (let index = 2; index < 10; index++) h.sdk.snapshot(clone(state));
  assert.equal(gain(h), current);
  assert.deepEqual({ ...h.counts }, { created: first.created * 2, replacements: 2, rows: 602 });
});

it('whole sample commits the cached snapshot only after successful room content replacement', async t => {
  const h = await setup(t), state = managementState(), landing = h.main.descendants();
  const replace = h.main.replaceChildren.bind(h.main); let fail = true;
  h.main.replaceChildren = (...nodes) => {
    if (fail) { fail = false; throw new Error('controlled DOM replacement failure'); }
    replace(...nodes);
  };
  assert.throws(() => h.sdk.snapshot(clone(state)), /controlled DOM replacement failure/);
  sameNodes(h.main.descendants(), landing); assert.equal(h.counts.replacements, 0);
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1);
  const rendered = h.main.descendants(); assert.equal(rows(h).length, 6);
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1); sameNodes(h.main.descendants(), rendered);
});

const changes: { name: string; change(state: RoomStatePayload): void; check(h: App): void }[] = [
  { name: 'room name', change: state => { state.name = 'Changed room'; }, check: h => assert.match(h.app.textContent, /Changed room/) },
  { name: 'room identity', change: state => { state.roomId = 'different-room'; }, check: h => assert.match(h.app.textContent, /房間 ID：different-room/) },
  { name: 'participant identity', change: state => { state.me.participantId = 'different-person'; }, check: h => assert.equal(rows(h).some(row => row.textContent.includes('我')), false) },
  { name: 'own display name', change: state => { state.me.name = 'Changed self'; }, check: h => assert.match(h.app.textContent, /你好，Changed self/) },
  { name: 'controller role and audience privacy', change: state => { state.me.role = 'speaker'; }, check: h => {
    assert.match(h.app.textContent, /觀眾名單僅提供給主控/); assert.equal(h.app.descendants().some(node => node.classList.contains('invite-link')), false);
  } },
  { name: 'own stage seat', change: state => { state.me.onStage = false; }, check: h => assert.equal(action(h, 'stage').textContent, '返回舞台') },
  { name: 'own mute state', change: state => { state.me.muted = true; }, check: h => assert.equal(action(h, 'mute').textContent, '取消靜音') },
  { name: 'own forced mute', change: state => { state.me.forceMuted = true; }, check: h => assert.equal(action(h, 'mute').disabled, true) },
  { name: 'speaker name', change: state => { state.speakers[1]!.name = 'Renamed speaker'; }, check: h => assert.match(h.app.textContent, /Renamed speaker/) },
  { name: 'speaker connection', change: state => { state.speakers[1]!.connected = false; }, check: h => assert.match(h.app.textContent, /連線中斷/) },
  { name: 'speaker gain', change: state => { state.speakers[1]!.gainDb = 5; }, check: h => assert.equal(gain(h).value, '5') },
  { name: 'speaker removal', change: state => { state.speakers.pop(); }, check: h => assert.equal(rows(h).some(row => row.dataset.participantId === 'speaker-1'), false) },
  { name: 'speaker ordering', change: state => { state.speakers.reverse(); }, check: h => assert.equal(rows(h)[0]!.dataset.participantId, 'speaker-1') },
  { name: 'hand queue', change: state => { state.hands = []; }, check: h => assert.match(h.app.textContent, /舉手佇列 · 0/) },
  { name: 'audience count', change: state => { state.audienceCount = 9; }, check: h => assert.match(h.app.textContent, /觀眾 · 9\/300/) },
  { name: 'audience list visibility', change: state => { delete state.audience; }, check: h => assert.match(h.app.textContent, /觀眾名單僅提供給主控/) },
  { name: 'speaker limit', change: state => { state.limits.maxSpeakers = 4; }, check: h => assert.match(h.app.textContent, /發言者 2\/4/) },
  { name: 'audience limit', change: state => { state.limits.maxAudience = 99; }, check: h => assert.match(h.app.textContent, /觀眾 · 2\/99/) },
  { name: 'room code policy', change: state => { state.codeRequired = true; }, check: h => assert.match(h.app.textContent, /房間代碼：未提供/) },
  { name: 'room code', change: state => { state.codeRequired = true; state.code = 'NEW123'; }, check: h => assert.match(h.find(node => node.classList.contains('invite-link')).value as string, /code=NEW123/) },
];
for (const change of changes) {
  it(`whole sample ${change.name === 'audience count' ? 'retains room controls' : 'invalidates unchanged-room cache'} for changed ${change.name}`, async t => {
    const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state));
    const old = rows(h); h.reset(); const next = clone(state); change.change(next); h.sdk.snapshot(next);
    const replacements = change.name === 'audience count' ? 0 : 1;
    assert.equal(h.counts.replacements, replacements);
    if (replacements === 0) sameNodes(rows(h), old);
    else assert.equal(old.every(row => !row.isConnected), true);
    change.check(h);
    const current = h.main.descendants(); h.sdk.snapshot(clone(next));
    assert.equal(h.counts.replacements, replacements); sameNodes(h.main.descendants(), current);
  });
}

it('whole sample includes effective matching created-room fallback code and honors snapshot code precedence', async t => {
  const h = await setup(t), state = managementState(); state.codeRequired = true;
  h.sdk.emit('created', { roomId: state.roomId, code: 'FIRST1' }); h.sdk.snapshot(clone(state));
  const link = () => h.find(node => node.classList.contains('invite-link'));
  assert.match(link().value as string, /code=FIRST1/); h.reset();
  h.sdk.emit('created', { roomId: state.roomId, code: 'SECOND' }); h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 1); assert.match(link().value as string, /code=SECOND/);
  h.sdk.emit('created', { roomId: 'another-room', code: 'IGNORE' }); h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 2); assert.doesNotMatch(link().value as string, /code=/);
  state.code = 'SERVER'; h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 3); assert.match(link().value as string, /code=SERVER/);
  const current = link(); h.sdk.emit('created', { roomId: state.roomId, code: 'THIRD3' }); h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 3); assert.equal(link(), current); assert.match(current.value as string, /code=SERVER/);
});

it('whole sample includes current SDK status even when the room snapshot status is unchanged', async t => {
  const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state)); h.reset();
  // Retained SDK snapshots can arrive while socket reconnect is still authoritative.
  h.sdk.status = 'reconnecting'; h.sdk.emit('state', clone(state));
  assert.equal(h.counts.replacements, 1); assert.equal(status(h).textContent, '重新連線中'); assert.equal(gain(h).disabled, true);
  const current = gain(h); h.sdk.emit('state', clone(state));
  assert.equal(h.counts.replacements, 1); assert.equal(gain(h), current);
  h.sdk.status = 'live'; h.sdk.emit('state', clone(state));
  assert.equal(h.counts.replacements, 2); assert.equal(status(h).textContent, '直播中'); assert.equal(gain(h).disabled, false);
});

it('whole sample reads a mutated SDK speaking set without an event and keeps retained duplicate rows indexed', async t => {
  const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state)); h.reset();
  h.sdk.speaking.add('audience-0'); h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 1);
  const duplicate = rows(h).filter(row => row.dataset.participantId === 'audience-0');
  assert.equal(duplicate.length, 2); assert.equal(duplicate.every(row => row.classList.contains('speaking')), true);
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1);
  h.sdk.speaking.clear(); h.sdk.emit('speaking', { participantIds: [] });
  assert.equal(duplicate.every(row => !row.classList.contains('speaking')), true);
  h.sdk.speaking.add('audience-0'); h.sdk.emit('speaking', { participantIds: ['audience-0', 'audience-0'] });
  assert.equal(duplicate.every(row => row.classList.contains('speaking')), true);
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1);
  sameNodes(rows(h).filter(row => row.dataset.participantId === 'audience-0'), duplicate);
});

it('whole sample detects mutation of current quality entries and keeps duplicate retained rows live for quality events', async t => {
  const h = await setup(t), state = managementState();
  const shared: ConnectionQuality = { participantId: 'audience-0', uplinkLossPercent: 6, rttMs: 10 };
  h.sdk.emit('quality', { participants: [{ participantId: 'audience-0', uplinkLossPercent: 99 }, shared] });
  h.sdk.snapshot(clone(state)); h.reset();
  shared.uplinkLossPercent = 11; shared.rttMs = 40; h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 1);
  const duplicate = rows(h).filter(row => row.dataset.participantId === 'audience-0'); assert.equal(duplicate.length, 2);
  for (const row of duplicate) {
    const badge = row.querySelector('.badge.quality'); assert.ok(badge);
    assert.equal(badge.textContent, '連線不穩 11%'); assert.match(badge.title, /RTT 40 ms/);
  }
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1);
  h.sdk.emit('quality', { participants: [] });
  assert.equal(duplicate.every(row => row.querySelector('.badge.quality') === null), true);
  h.sdk.emit('quality', { participants: [shared] });
  assert.equal(duplicate.every(row => row.querySelector('.badge.quality')?.textContent === '連線不穩 11%'), true);
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1);
  sameNodes(rows(h).filter(row => row.dataset.participantId === 'audience-0'), duplicate);
});

it('whole sample preserves pending hand actions, countdown ownership, notices and errors on unchanged snapshots', async t => {
  const h = await setup(t), state = roomState(); h.sdk.snapshot(clone(state)); h.reset();
  const hand = action(h, 'hand'); hand.click(); const work = h.sdk.raises[0]!;
  assert.equal(hand.attributes['aria-busy'], 'true'); assert.equal(hand.disabled, true);
  const timer = h.clock.timeouts()[0]; assert.ok(timer);
  h.sdk.emit('invite', { participantId: state.me.participantId }); h.sdk.emit('audioblocked', undefined);
  h.sdk.emit('error', { message: '保留操作錯誤。' });
  const noticeText = notices(h).textContent;
  h.sdk.snapshot(clone(state)); assert.equal(action(h, 'hand'), hand); assert.equal(h.counts.replacements, 0);
  assert.deepEqual(h.clock.timeouts(), [timer]); assert.equal(notices(h).textContent, noticeText);
  assert.equal(errorBox(h).hidden, false); assert.equal(errorBox(h).textContent, '保留操作錯誤。');
  h.clock.advance(1500); assert.equal(hand.textContent, '舉手發言'); assert.equal(hand.disabled, true);
  assert.equal(h.clock.timeouts().length, 0); h.sdk.snapshot(clone(state)); assert.equal(action(h, 'hand'), hand);
  work.reject(new Error('current rejection')); await flushSample();
  assert.equal(hand.disabled, false); assert.equal(hand.attributes['aria-busy'], 'false');
  assert.equal(errorBox(h).textContent, 'current rejection');
  hand.click(); assert.equal(h.sdk.raises.length, 2); h.sdk.raises[1]!.resolve(undefined); await flushSample();
  assert.equal(hand.disabled, true, 'successful retry retains its fresh cooldown');
});

it('whole sample refreshes retained cooldown and status controls without retaining edited DOM labels', async t => {
  const h = await setup(t), state = roomState(); h.sdk.snapshot(clone(state)); h.reset();
  const hand = action(h, 'hand'); hand.textContent = 'stale'; hand.disabled = true; status(h).textContent = 'stale';
  h.sdk.handCooldownMs = 2300; h.sdk.snapshot(clone(state));
  assert.equal(action(h, 'hand'), hand); assert.equal(h.counts.replacements, 0);
  assert.equal(hand.textContent, '舉手發言（3 秒）'); assert.equal(hand.disabled, true); assert.equal(status(h).textContent, '等待發言');
  h.clock.advance(300); assert.equal(hand.textContent, '舉手發言（2 秒）');
  h.sdk.handCooldownMs = 0; h.sdk.snapshot(clone(state));
  assert.equal(hand.textContent, '舉手發言'); assert.equal(hand.disabled, false); assert.equal(h.clock.timeouts().length, 0);
});

it('whole sample keeps microphone retry pending and independent meter and stats timers across unchanged snapshots', async t => {
  const h = await setup(t), state = roomState({ role: 'speaker', onStage: true }); let retries = 0;
  Object.assign(h.sdk, { retryMicrophone() { retries++; return true; } });
  h.sdk.snapshot(clone(state)); h.sdk.emit('micerror', { name: 'NotAllowedError', message: '麥克風權限遭拒。' });
  h.id('mic-retry').click(); assert.equal(retries, 1); h.reset(); const main = h.main.descendants();
  const intervals = [...h.clock.jobs.values()].filter(job => job.kind === 'interval').map(job => job.id);
  assert.equal(h.clock.intervals(50).length, 1); assert.equal(h.clock.intervals(2000).length, 1);
  for (let index = 0; index < 3; index++) h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 0); sameNodes(h.main.descendants(), main);
  assert.equal(h.id('mic-retry').disabled, true); assert.equal(h.id('mic-retry').attributes['aria-busy'], 'true');
  assert.deepEqual([...h.clock.jobs.values()].filter(job => job.kind === 'interval').map(job => job.id), intervals);
  h.sdk.micLevelValue = 0.4; h.clock.advance(2000);
  assert.equal(h.id('mic-level').value, 0.4); assert.equal(h.sdk.polls.length, 1); assert.ok(h.sdk.micLevelReads >= 40);
  h.sdk.polls[0]!.resolve({ inbound: { lossPercent: 2, rtt: 0.02 }, outbound: null }); await flushSample();
  assert.match(h.app.textContent, /收聽掉包 2.0% · 延遲 20 ms/); assert.equal(retries, 1);
  h.sdk.emit('micready', undefined); assert.equal(h.app.descendants().some(node => node.id === 'mic-retry'), false);
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 0); assert.equal(retries, 1);
  const offstage = roomState(); offstage.status = 'live'; h.sdk.snapshot(offstage);
  h.sdk.snapshot(clone(state)); assert.equal(h.app.descendants().some(node => node.id === 'mic-retry'), false);
});

for (const transition of ['leave', 'disconnect', 'closed', 'kicked'] as const) {
  it(`whole sample ${transition} clears cached room content before same-room same-identity rejoin`, async t => {
    const h = await setup(t), state = managementState(0); h.sdk.snapshot(clone(state));
    const old = rows(h), oldGain = gain(h);
    if (transition === 'leave') { h.button('離開房間').click(); await flushSample(); }
    else if (transition === 'disconnect') await h.sdk.disconnect();
    else await h.sdk.terminal(transition, transition === 'closed' ? 'shutdown' : undefined);
    await flushSample(); assert.equal(rows(h).length, 0); assert.equal(old.every(row => !row.isConnected), true);
    assert.equal(h.clock.intervals(2000).length, 0);
    h.reset(); h.sdk.snapshot(clone(state));
    assert.equal(h.counts.replacements, 1); assert.equal(rows(h).every(row => !old.includes(row)), true);
    const current = gain(h); assert.notEqual(current, oldGain); assert.equal(current.value, '0');
    h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1); assert.equal(gain(h), current);
    oldGain.value = '9'; h.sdk.snapshot(clone(state));
    assert.equal(h.counts.replacements, 1, 'retired dirty inputs cannot invalidate the new room');
  });
}

it('whole sample retires pending room ownership on direct identity replacement and rejects stale settlements', async t => {
  const h = await setup(t), state = roomState(); h.sdk.snapshot(clone(state));
  const old = action(h, 'hand'); old.click(); const pending = h.sdk.raises[0]!;
  const replacement = clone(state); replacement.roomId = 'new-room'; h.sdk.snapshot(replacement);
  const current = action(h, 'hand'); assert.notEqual(current, old); assert.equal(current.attributes['aria-busy'], 'false');
  h.sdk.emit('error', { message: '新房間錯誤。' }); pending.reject(new Error('old room rejection')); await flushSample();
  assert.equal(errorBox(h).textContent, '新房間錯誤。');
  h.sdk.handCooldownMs = 0; h.sdk.snapshot(clone(replacement)); current.click(); assert.equal(h.sdk.raises.length, 2);
  const work: Deferred<void> = h.sdk.raises[1]!; work.resolve(undefined); await flushSample();
});

it('whole sample retained handlers use displayed scalar values after an obsolete identical snapshot is mutated', async t => {
  const dialogs: string[] = [], calls: { action: string; id?: string; value?: number }[] = [];
  const h = await setup(t, message => { dialogs.push(message); return true; });
  Object.assign(h.sdk, {
    async mute() { calls.push({ action: 'mute' }); },
    async unmute() { calls.push({ action: 'unmute' }); },
    async forceMute(id: string) { calls.push({ action: 'forceMute', id }); },
    async forceUnmute(id: string) { calls.push({ action: 'forceUnmute', id }); },
    async transferControl(id: string) { calls.push({ action: 'transferControl', id }); },
    async kick(id: string) { calls.push({ action: 'kick', id }); },
    async setGain(id: string, value: number) { calls.push({ action: 'setGain', id, value }); },
  });
  const obsolete = managementState(0, 1, 1); obsolete.speakers[1]!.name = 'Speaker 0'; h.sdk.snapshot(obsolete);
  const controls = h.main.descendants(), current = clone(obsolete); h.sdk.snapshot(current);
  sameNodes(h.main.descendants(), controls); assert.equal(h.sdk.state, current);
  obsolete.me.muted = true;
  const retiredSpeaker = obsolete.speakers[1]!;
  retiredSpeaker.forceMuted = true; retiredSpeaker.name = 'Obsolete name'; retiredSpeaker.participantId = 'obsolete-id';
  action(h, 'mute').click(); action(h, 'force-mute:speaker-0').click(); await flushSample();
  const speakerRow = rows(h).find(row => row.dataset.participantId === 'speaker-0')!;
  speakerRow.descendants().find(node => node.dataset.roomAction === 'transfer')!.click();
  action(h, 'kick:speaker-0').click();
  const slider = gain(h); slider.value = '4'; assert.ok(slider.onchange); slider.onchange(); await flushSample();
  assert.deepEqual(calls, [
    { action: 'mute' }, { action: 'forceMute', id: 'speaker-0' }, { action: 'transferControl', id: 'speaker-0' },
    { action: 'kick', id: 'speaker-0' }, { action: 'setGain', id: 'speaker-0', value: 4 },
  ]);
  assert.deepEqual(dialogs, ['確定將控制權移交給 Speaker 0？', '確定將 Speaker 0 踢出房間？若要防止對方再進來，請接著更換房間代碼。']);
  assert.equal(action(h, 'mute').textContent, '靜音'); assert.equal(action(h, 'force-mute:speaker-0').textContent, '強制靜音');
});

for (const overlay of ['speaking', 'quality'] as const) {
  it(`whole sample retains all room rows after an applied ${overlay} event and identical fresh snapshot`, async t => {
    const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state));
    const people = rows(h), slider = gain(h); h.reset();
    if (overlay === 'speaking') emitSpeaking(h, ['audience-0', 'audience-0', 'speaker-0']);
    else h.sdk.emit('quality', { participants: [{ participantId: 'audience-0', uplinkLossPercent: 12, rttMs: 40 }] });
    const afterEvent = h.main.descendants(), counts = { ...h.counts };
    h.sdk.snapshot(clone(state));
    assert.equal(h.counts.replacements, 0); assert.equal(h.counts.rows, 0);
    assert.deepEqual({ ...h.counts }, counts); sameNodes(rows(h), people); sameNodes(h.main.descendants(), afterEvent);
    assert.equal(gain(h), slider);
    if (overlay === 'speaking') assertSpeaking(h, ['audience-0', 'speaker-0']);
    else for (const row of people.filter(row => row.dataset.participantId === 'audience-0')) {
      assert.equal(row.querySelector('.badge.quality')?.textContent, '連線不穩 12%');
      assert.match(row.querySelector('.badge.quality')!.title, /RTT 40 ms/);
    }
  });
}

it('whole sample retains 100 seats through 100 alternating overlay and snapshot iterations with one badge allocation', async t => {
  const h = await setup(t), state = managementState(0, 91, 8); h.sdk.snapshot(clone(state));
  const people = rows(h), slider = gain(h); assert.equal(people.length, 100); h.reset();
  for (let index = 0; index < 100; index++) {
    const ids = [`speaker-${index % 2}`];
    const quality = () => h.sdk.emit('quality', { participants: [{ participantId: 'speaker-0', uplinkLossPercent: 10 + index % 2 }] });
    if (index % 2) { quality(); emitSpeaking(h, ids); }
    else { emitSpeaking(h, ids); quality(); }
    h.sdk.snapshot(clone(state)); sameNodes(rows(h), people); assert.equal(gain(h), slider); assertSpeaking(h, ids);
    assert.equal(people.find(row => row.dataset.participantId === 'speaker-0')!.querySelector('.badge.quality')?.textContent,
      `連線不穩 ${10 + index % 2}%`);
  }
  assert.deepEqual({ ...h.counts }, { created: 1, replacements: 0, rows: 0 });
  t.diagnostic(`100 seats / 100 alternating speaking+quality+snapshot iterations: ${JSON.stringify(h.counts)}; fake-node operations only, not browser CPU/layout/paint`);
});

it('whole sample retains hidden duplicate rows through same-count ID changes and partial quality reports, then retires removed rows', async t => {
  const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state));
  const input = h.id('audience-search'); input.value = 'absent name'; assert.ok(input.oninput); input.oninput();
  const people = rows(h), duplicated = people.filter(row => row.dataset.participantId === 'audience-0');
  assert.equal(duplicated.length, 2); assert.equal(duplicated.filter(row => row.hidden).length, 1); h.reset();
  emitSpeaking(h, ['audience-0', 'audience-0', 'missing']);
  h.sdk.emit('quality', { participants: [
    { participantId: 'audience-0', uplinkLossPercent: 99 }, { participantId: 'audience-0', uplinkLossPercent: 12 },
    { participantId: 'speaker-0', downlinkLossPercent: 8 }, { participantId: 'missing', uplinkLossPercent: 50 },
  ] });
  h.sdk.snapshot(clone(state)); sameNodes(rows(h), people); assertSpeaking(h, ['audience-0']);
  assert.equal(duplicated.every(row => row.querySelector('.badge.quality')?.textContent === '連線不穩 12%'), true);
  emitSpeaking(h, ['audience-1', 'missing']);
  h.sdk.emit('quality', { participants: [{ participantId: 'speaker-1', uplinkLossPercent: 14 }] });
  h.sdk.snapshot(clone(state)); sameNodes(rows(h), people); assertSpeaking(h, ['audience-1']);
  assert.equal(people.filter(row => row.querySelector('.badge.quality')).length, 1, 'omitted IDs lose warnings');
  assert.equal(h.counts.replacements, 0); assert.equal(input.value, 'absent name');
  assert.equal(duplicated.filter(row => row.hidden).length, 1);
  const next = clone(state); next.hands = []; next.audience = next.audience!.slice(1); next.audienceCount = 1;
  h.sdk.snapshot(next); assert.equal(h.counts.replacements, 1); assert.equal(people.every(row => !row.isConnected), true);
  const retired = people.map(row => ({ classes: row.className, text: row.textContent })), current = rows(h); h.reset();
  emitSpeaking(h, ['audience-0']); h.sdk.emit('quality', { participants: [{ participantId: 'audience-0', uplinkLossPercent: 99 }] });
  h.sdk.snapshot(clone(next)); sameNodes(rows(h), current); assertSpeaking(h, []);
  assert.equal(current.some(row => row.querySelector('.badge.quality')), false);
  assert.deepEqual(people.map(row => ({ classes: row.className, text: row.textContent })), retired);
  assert.deepEqual({ ...h.counts }, { created: 0, replacements: 0, rows: 0 });
});

it('whole sample misses when speaking detail disagrees with the SDK getter, even when the getter still matches the original render', async t => {
  const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state)); h.reset();
  h.sdk.emit('speaking', { participantIds: ['speaker-0', 'speaker-0'] }); assertSpeaking(h, ['speaker-0']);
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1); assertSpeaking(h, []);
  h.sdk.speaking = new Set(['speaker-0']); h.sdk.emit('speaking', { participantIds: ['speaker-1'] });
  assertSpeaking(h, ['speaker-1']); h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 2); assertSpeaking(h, ['speaker-0']);
  const current = rows(h); h.sdk.snapshot(clone(state)); sameNodes(rows(h), current);
  assert.equal(h.counts.replacements, 2);
});

it('whole sample accepts speaking detail applied before its SDK getter catches up by the next snapshot', async t => {
  const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state)); const people = rows(h); h.reset();
  h.sdk.emit('speaking', { participantIds: ['speaker-0', 'speaker-0'] });
  h.sdk.speaking = new Set(['speaker-0']); h.sdk.snapshot(clone(state));
  sameNodes(rows(h), people); assertSpeaking(h, ['speaker-0']);
  assert.deepEqual({ ...h.counts }, { created: 0, replacements: 0, rows: 0 });
});

it('whole sample speaking events cannot hide a silent mutation of an already applied shared quality entry', async t => {
  const h = await setup(t), state = managementState();
  const shared: ConnectionQuality = { participantId: 'speaker-0', uplinkLossPercent: 8, rttMs: 10 };
  h.sdk.emit('quality', { participants: [shared] }); h.sdk.snapshot(clone(state)); h.reset();
  shared.uplinkLossPercent = 15; shared.rttMs = 80; emitSpeaking(h, ['speaker-1']);
  const before = rows(h); assert.equal(before.find(row => row.dataset.participantId === 'speaker-0')!.querySelector('.badge.quality')?.textContent, '連線不穩 8%');
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1); assert.equal(before.every(row => !row.isConnected), true);
  const badge = rows(h).find(row => row.dataset.participantId === 'speaker-0')!.querySelector('.badge.quality')!;
  assert.equal(badge.textContent, '連線不穩 15%'); assert.match(badge.title, /RTT 80 ms/); assertSpeaking(h, ['speaker-1']);
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1);
});

it('whole sample quality events cannot hide a silent mutation of the SDK speaking set', async t => {
  const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state)); h.reset();
  h.sdk.speaking.add('audience-0');
  h.sdk.emit('quality', { participants: [{ participantId: 'speaker-0', uplinkLossPercent: 8 }] });
  assertSpeaking(h, []); const before = rows(h); h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 1); assert.equal(before.every(row => !row.isConnected), true); assertSpeaking(h, ['audience-0']);
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1);
});

it('whole sample catches shared quality mutation by a later SDK listener after an event handler finishes', async t => {
  const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state)); h.reset();
  const shared: ConnectionQuality = { participantId: 'speaker-0', uplinkLossPercent: 8 };
  h.sdk.on('quality', () => { shared.uplinkLossPercent = 19; });
  h.sdk.emit('quality', { participants: [shared] });
  assert.equal(rows(h).find(row => row.dataset.participantId === 'speaker-0')!.querySelector('.badge.quality')?.textContent, '連線不穩 8%');
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1);
  assert.equal(rows(h).find(row => row.dataset.participantId === 'speaker-0')!.querySelector('.badge.quality')?.textContent, '連線不穩 19%');
});

for (const first of ['speaking', 'quality'] as const) {
  it(`whole sample retains rows when a later ${first} listener synchronously emits the other overlay and a snapshot`, async t => {
    const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state)); const people = rows(h); h.reset();
    const report = () => h.sdk.emit('quality', { participants: [{ participantId: 'audience-0', uplinkLossPercent: 8 }] });
    // A normal SDK listener runs after the sample's handler; no reentry is injected into native DOM methods.
    h.sdk.on(first, () => {
      if (first === 'speaking') report(); else emitSpeaking(h, ['audience-0', 'audience-0']);
      h.sdk.snapshot(clone(state));
    });
    if (first === 'speaking') emitSpeaking(h, ['audience-0', 'audience-0']); else report();
    sameNodes(rows(h), people); assertSpeaking(h, ['audience-0']);
    assert.equal(people.filter(row => row.querySelector('.badge.quality')?.textContent === '連線不穩 8%').length, 2);
    assert.deepEqual({ ...h.counts }, { created: 2, replacements: 0, rows: 0 });
  });
}

it('whole sample still resets dirty gain after applied overlays and then retains the corrected controls', async t => {
  const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state)); const slider = gain(h); h.reset();
  slider.value = '7'; emitSpeaking(h, ['speaker-0']);
  h.sdk.emit('quality', { participants: [{ participantId: 'speaker-0', uplinkLossPercent: 12 }] });
  assert.equal(gain(h), slider); assert.equal(slider.value, '7');
  h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1); assert.notEqual(gain(h), slider); assert.equal(gain(h).value, '0');
  assertSpeaking(h, ['speaker-0']); const current = gain(h);
  emitSpeaking(h, ['speaker-1']); h.sdk.snapshot(clone(state)); assert.equal(gain(h), current); assert.equal(h.counts.replacements, 1);
});

it('whole sample retains pending controls, countdown, notices and errors across applied overlays and snapshots', async t => {
  const h = await setup(t), state = roomState();
  state.speakers = [{ ...state.me, participantId: 'speaker-0', role: 'speaker', onStage: true }];
  state.status = 'live'; h.sdk.snapshot(clone(state));
  const hand = action(h, 'hand'); hand.click(); const work = h.sdk.raises[0]!;
  const timer = h.clock.timeouts()[0]; assert.ok(timer);
  h.sdk.emit('audioblocked', undefined); h.sdk.emit('error', { message: '保留操作錯誤。' });
  const noticeText = notices(h).textContent, people = rows(h); h.reset();
  emitSpeaking(h, ['speaker-0']);
  h.sdk.emit('quality', { participants: [{ participantId: 'speaker-0', uplinkLossPercent: 12 }] });
  h.sdk.snapshot(clone(state)); sameNodes(rows(h), people); assert.equal(action(h, 'hand'), hand);
  assert.equal(h.counts.replacements, 0); assert.equal(hand.attributes['aria-busy'], 'true'); assert.equal(hand.disabled, true);
  assert.deepEqual(h.clock.timeouts(), [timer]); assert.equal(notices(h).textContent, noticeText); assert.equal(errorBox(h).textContent, '保留操作錯誤。');
  h.clock.advance(1500); h.sdk.snapshot(clone(state)); assert.equal(hand.disabled, true); assert.equal(h.clock.timeouts().length, 0);
  work.reject(new Error('current overlay rejection')); await flushSample();
  assert.equal(hand.disabled, false); assert.equal(errorBox(h).textContent, 'current overlay rejection');
});

function countOnlyState(handRaised = false): RoomStatePayload {
  const state = roomState({ handRaised }); state.status = 'live'; state.audienceCount = 200;
  state.speakers = Array.from({ length: 9 }, (_, index) => ({ ...state.me,
    participantId: index === 0 ? 'controller' : `speaker-${index - 1}`,
    role: index === 0 ? 'controller' : 'speaker', onStage: true, handRaised: false,
  }));
  state.hands = Array.from({ length: 20 }, (_, index) => ({ ...state.me,
    participantId: handRaised && index === 7 ? state.me.participantId : `hand-${index}`, handRaised: true,
  }));
  return state;
}

it('whole sample retains bounded room references for 50 fresh count-only snapshots with 9 speakers and 20 hands', async t => {
  const h = await setup(t), state = countOnlyState(); h.sdk.snapshot(clone(state));
  const people = rows(h), heading = audienceHeading(h), content = h.main.descendants(), refs = h.references();
  assert.equal(state.speakers.length, 9); assert.equal(state.hands.length, 20); assert.equal(people.length, 29);
  assert.equal(refs.heading, heading); assert.equal(refs.people.length, 29);
  assert.equal(refs.gains.length, 0); assert.equal(refs.audience.length, 0); assert.equal(refs.pending, 0);
  const initialTimers = [...h.clock.jobs.keys()]; h.reset(); let correctHeadings = 0;
  for (let index = 1; index <= 50; index++) {
    const next = clone(state); next.audienceCount = 200 + index; assert.notEqual(next, h.sdk.state);
    h.sdk.snapshot(next); assert.equal(audienceHeading(h), heading);
    assert.equal(heading.textContent, `觀眾 · ${200 + index}/300`); correctHeadings++;
    sameNodes(rows(h), people); sameNodes(h.main.descendants(), content);
    const current = h.references(); assert.equal(current.heading, heading); sameNodes(current.people, refs.people);
    assert.equal(current.gains.length, 0); assert.equal(current.audience.length, 0); assert.equal(current.pending, 0);
    assert.deepEqual([...h.clock.jobs.keys()], initialTimers);
  }
  assert.deepEqual({ ...h.counts }, { created: 0, replacements: 0, rows: 0 });
  t.diagnostic(`9 speakers + 20 hands / 50 count-only snapshots: ${JSON.stringify(h.counts)}; headings ${correctHeadings}/50; bounded fake-node operations only, not browser CPU/layout/paint or heap measurement`);
});

it('whole sample updates current count on the same mutable snapshot and uses the current audience limit', async t => {
  const h = await setup(t), state = managementState(); h.sdk.snapshot(state);
  const heading = audienceHeading(h), people = rows(h); h.reset();
  for (const count of [0, 300, 12, 1]) {
    state.audienceCount = count; h.sdk.snapshot(state);
    assert.equal(audienceHeading(h), heading); assert.equal(heading.textContent, `觀眾 · ${count}/300`);
    sameNodes(rows(h), people);
  }
  assert.deepEqual({ ...h.counts }, { created: 0, replacements: 0, rows: 0 });
  state.audienceCount = 5; state.limits.maxAudience = 99; h.sdk.snapshot(state);
  assert.equal(h.counts.replacements, 1); const current = audienceHeading(h); assert.notEqual(current, heading);
  assert.equal(current.textContent, '觀眾 · 5/99'); state.audienceCount = 0; h.sdk.snapshot(state);
  assert.equal(audienceHeading(h), current); assert.equal(current.textContent, '觀眾 · 0/99');
  assert.equal(h.counts.replacements, 1); assert.equal(heading.textContent, '觀眾 · 1/300');
});

it('whole sample count changes cannot hide other structural fields, controller roster changes or unknown metadata', async t => {
  const h = await setup(t), baseline = managementState(2, 3, 2);
  const extraChanges: { name: string; change(state: RoomStatePayload): void }[] = [
    { name: 'controller identity', change: state => { state.controllerId = 'speaker-0'; } },
    { name: 'speaker metadata', change: state => { state.speakers[1]!.joinedAt++; } },
    { name: 'hand ordering', change: state => { state.hands.reverse(); } },
    { name: 'audience membership', change: state => { state.audience!.pop(); } },
    { name: 'audience ordering', change: state => { state.audience!.reverse(); } },
    { name: 'audience name', change: state => { state.audience![2]!.name = 'Changed audience'; } },
    { name: 'unknown metadata', change: state => { Object.assign(state, { futureMetadata: { active: true } }); } },
  ];
  for (const change of [...changes.filter(change => change.name !== 'audience count'), ...extraChanges]) {
    h.sdk.snapshot(clone(baseline)); const old = rows(h), oldHeading = audienceHeading(h), next = clone(baseline);
    change.change(next); next.audienceCount++; h.reset(); h.sdk.snapshot(next);
    assert.equal(h.counts.replacements, 1, change.name); assert.equal(old.every(row => !row.isConnected), true, change.name);
    assert.notEqual(audienceHeading(h), oldHeading, change.name);
    assert.equal(audienceHeading(h).textContent, `觀眾 · ${next.audienceCount}/${next.limits.maxAudience}`);
    const current = rows(h); h.sdk.snapshot({ ...clone(next), audienceCount: next.audienceCount + 1 });
    assert.equal(h.counts.replacements, 1, change.name); sameNodes(rows(h), current);
  }
  const mutable = Object.assign(clone(baseline), { futureMetadata: { active: true } }); h.sdk.snapshot(mutable); h.reset();
  mutable.futureMetadata.active = false; mutable.audienceCount++; h.sdk.snapshot(mutable);
  assert.equal(h.counts.replacements, 1, 'in-place mutation of unknown serializable metadata');
});

it('whole sample count changes preserve effective fallback code and current SDK status invalidation', async t => {
  const h = await setup(t), state = managementState(); state.codeRequired = true;
  h.sdk.emit('created', { roomId: state.roomId, code: 'FIRST1' }); h.sdk.snapshot(clone(state));
  const old = rows(h); h.reset(); h.sdk.emit('created', { roomId: state.roomId, code: 'SECOND' });
  state.audienceCount++; h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 1); assert.equal(old.every(row => !row.isConnected), true);
  assert.match(h.find(node => node.classList.contains('invite-link')).value as string, /code=SECOND/);
  state.code = 'SERVER'; state.audienceCount++; h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 2); const current = rows(h);
  h.sdk.emit('created', { roomId: state.roomId, code: 'THIRD3' }); state.audienceCount++; h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 2); sameNodes(rows(h), current);
  assert.match(h.find(node => node.classList.contains('invite-link')).value as string, /code=SERVER/);
  h.sdk.status = 'reconnecting'; state.audienceCount++; h.sdk.emit('state', clone(state));
  assert.equal(h.counts.replacements, 3); assert.equal(gain(h).disabled, true); assert.equal(status(h).textContent, '重新連線中');
  h.sdk.status = 'live'; state.audienceCount++; h.sdk.emit('state', clone(state));
  assert.equal(h.counts.replacements, 4); assert.equal(gain(h).disabled, false); assert.equal(status(h).textContent, '直播中');
});

it('whole sample count-only updates preserve pending hand, cooldown, notices, errors, stats and queue position', async t => {
  const h = await setup(t), state = countOnlyState(); h.sdk.snapshot(clone(state));
  const hand = action(h, 'hand'); hand.click(); const pending = h.sdk.raises[0]!, timer = h.clock.timeouts()[0]; assert.ok(timer);
  emitSpeaking(h, ['speaker-0']);
  h.sdk.emit('quality', { participants: [{ participantId: 'speaker-0', uplinkLossPercent: 12, rttMs: 40 }] });
  h.sdk.emit('invite', { participantId: state.me.participantId }); h.sdk.emit('audioblocked', undefined);
  h.sdk.emit('error', { message: '保留操作錯誤。' });
  const noticeText = notices(h).textContent, people = rows(h), intervals = [...h.clock.jobs.keys()]; h.reset();
  state.audienceCount++; h.sdk.snapshot(clone(state)); sameNodes(rows(h), people);
  assert.equal(action(h, 'hand'), hand); assert.equal(hand.attributes['aria-busy'], 'true'); assert.equal(hand.disabled, true);
  assert.deepEqual(h.clock.timeouts(), [timer]); assert.deepEqual([...h.clock.jobs.keys()], intervals);
  assert.equal(notices(h).textContent, noticeText); assert.equal(errorBox(h).textContent, '保留操作錯誤。');
  assert.equal(audienceHeading(h).textContent, '觀眾 · 201/300'); assertSpeaking(h, ['speaker-0']);
  assert.equal(people.find(row => row.dataset.participantId === 'speaker-0')!.querySelector('.badge.quality')?.textContent, '連線不穩 12%');
  assert.equal(h.counts.replacements, 0); assert.equal(h.counts.rows, 0);
  h.clock.advance(2000); assert.equal(h.sdk.polls.length, 1); assert.equal(hand.disabled, true);
  h.sdk.polls[0]!.resolve({ inbound: { rtt: 0.02 }, outbound: null });
  pending.reject(new Error('current count rejection')); await flushSample();
  assert.equal(hand.disabled, false); assert.equal(errorBox(h).textContent, 'current count rejection');
  assert.equal(h.clock.timeouts().length, 0); assert.match(h.app.textContent, /延遲 20 ms/);
  const raised = countOnlyState(true); h.sdk.snapshot(clone(raised));
  const position = h.find(node => node.classList.contains('own-hand-position')), raisedRows = rows(h); h.reset();
  assert.equal(position.textContent, '你的舉手位置：佇列第 8 位。');
  raised.audienceCount++; h.sdk.snapshot(clone(raised)); sameNodes(rows(h), raisedRows);
  assert.equal(h.find(node => node.classList.contains('own-hand-position')), position);
  assert.equal(position.textContent, '你的舉手位置：佇列第 8 位。'); assert.equal(h.counts.replacements, 0);
});

it('whole sample count-only updates preserve controller filter, scalar handlers and bounded management references', async t => {
  const dialogs: string[] = [], calls: string[] = [];
  const h = await setup(t, message => { dialogs.push(message); return true; });
  Object.assign(h.sdk, {
    async mute() { calls.push('mute'); }, async unmute() { calls.push('unmute'); },
    async forceMute(id: string) { calls.push(`forceMute:${id}`); }, async forceUnmute(id: string) { calls.push(`forceUnmute:${id}`); },
    async transferControl(id: string) { calls.push(`transfer:${id}`); }, async kick(id: string) { calls.push(`kick:${id}`); },
    async setGain(id: string, value: number) { calls.push(`gain:${id}:${value}`); },
  });
  const obsolete = managementState(); obsolete.speakers[1]!.name = 'Speaker 0'; h.sdk.snapshot(obsolete);
  const search = h.id('audience-search'); search.value = 'absent name'; assert.ok(search.oninput); search.oninput();
  const people = rows(h), hidden = people.filter(row => row.hidden), refs = h.references(), heading = audienceHeading(h);
  assert.equal(hidden.length, 2); assert.equal(refs.gains.length, 2); assert.equal(refs.audience.length, 2); h.reset();
  const current = clone(obsolete); current.audienceCount++; h.sdk.snapshot(current);
  sameNodes(rows(h), people); assert.equal(search.value, 'absent name'); assert.equal(hidden.every(row => row.hidden), true);
  const after = h.references(); sameNodes(after.people, refs.people); sameNodes(after.gains, refs.gains); sameNodes(after.audience, refs.audience);
  obsolete.me.muted = true; obsolete.audienceCount = 999;
  Object.assign(obsolete.speakers[1]!, { participantId: 'obsolete-id', forceMuted: true, name: 'Obsolete name' });
  action(h, 'mute').click(); action(h, 'force-mute:speaker-0').click(); await flushSample();
  const row = people.find(row => row.dataset.participantId === 'speaker-0')!;
  row.descendants().find(node => node.dataset.roomAction === 'transfer')!.click(); action(h, 'kick:speaker-0').click();
  const slider = gain(h); slider.value = '4'; assert.ok(slider.onchange); slider.onchange(); await flushSample();
  assert.deepEqual(calls, ['mute', 'forceMute:speaker-0', 'transfer:speaker-0', 'kick:speaker-0', 'gain:speaker-0:4']);
  assert.deepEqual(dialogs, ['確定將控制權移交給 Speaker 0？', '確定將 Speaker 0 踢出房間？若要防止對方再進來，請接著更換房間代碼。']);
  assert.equal(audienceHeading(h), heading); assert.equal(heading.textContent, '觀眾 · 3/300'); assert.equal(h.counts.replacements, 0);
  current.audienceCount++; h.sdk.snapshot(clone(current));
  assert.equal(h.counts.replacements, 1, 'dirty gain remains an authoritative reset');
  assert.notEqual(gain(h), slider); assert.equal(gain(h).value, '0'); assert.equal(audienceHeading(h).textContent, '觀眾 · 4/300');
  assert.equal(search.value, 'absent name'); assert.equal(rows(h).filter(row => row.hidden).length, 2);
});

for (const overlay of ['speaking', 'quality'] as const) {
  it(`whole sample count-only update retains applied ${overlay} rows and does not conceal a silent opposite overlay mutation`, async t => {
    const h = await setup(t), state = managementState();
    const shared: ConnectionQuality = { participantId: 'audience-0', uplinkLossPercent: 8, rttMs: 10 };
    h.sdk.emit('quality', { participants: [shared] }); h.sdk.snapshot(clone(state));
    const people = rows(h); h.reset();
    if (overlay === 'speaking') emitSpeaking(h, ['speaker-0']);
    else h.sdk.emit('quality', { participants: [shared] });
    state.audienceCount++; h.sdk.snapshot(clone(state)); sameNodes(rows(h), people);
    assert.equal(h.counts.replacements, 0); assert.equal(audienceHeading(h).textContent, '觀眾 · 3/300');
    if (overlay === 'speaking') { shared.uplinkLossPercent = 15; shared.rttMs = 80; emitSpeaking(h, ['speaker-1']); }
    else { h.sdk.speaking.add('audience-0'); h.sdk.emit('quality', { participants: [shared] }); }
    state.audienceCount++; h.sdk.snapshot(clone(state));
    assert.equal(h.counts.replacements, 1); assert.equal(people.every(row => !row.isConnected), true);
    assert.equal(audienceHeading(h).textContent, '觀眾 · 4/300');
    if (overlay === 'speaking') {
      assertSpeaking(h, ['speaker-1']);
      const duplicates = rows(h).filter(row => row.dataset.participantId === 'audience-0'); assert.equal(duplicates.length, 2);
      for (const row of duplicates) {
        assert.equal(row.querySelector('.badge.quality')?.textContent, '連線不穩 15%');
        assert.match(row.querySelector('.badge.quality')!.title, /RTT 80 ms/);
      }
    } else assertSpeaking(h, ['audience-0']);
    const current = rows(h); state.audienceCount++; h.sdk.snapshot(clone(state)); sameNodes(rows(h), current);
    assert.equal(h.counts.replacements, 1);
  });
}

it('whole sample count update still misses for speaking event/getter disagreement and dirty gain after applied overlays', async t => {
  const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state)); h.reset();
  h.sdk.emit('speaking', { participantIds: ['speaker-0'] }); assertSpeaking(h, ['speaker-0']);
  state.audienceCount++; h.sdk.snapshot(clone(state)); assert.equal(h.counts.replacements, 1); assertSpeaking(h, []);
  const slider = gain(h), oldHeading = audienceHeading(h); slider.value = '7'; emitSpeaking(h, ['speaker-0']);
  h.sdk.emit('quality', { participants: [{ participantId: 'speaker-0', uplinkLossPercent: 12 }] });
  state.audienceCount++; h.sdk.snapshot(clone(state));
  assert.equal(h.counts.replacements, 2); assert.notEqual(gain(h), slider); assert.equal(gain(h).value, '0');
  assert.notEqual(audienceHeading(h), oldHeading); assert.equal(audienceHeading(h).textContent, '觀眾 · 4/300');
  assertSpeaking(h, ['speaker-0']); const current = gain(h);
  emitSpeaking(h, ['speaker-1']); state.audienceCount++; h.sdk.snapshot(clone(state));
  assert.equal(gain(h), current); assert.equal(h.counts.replacements, 2); assert.equal(audienceHeading(h).textContent, '觀眾 · 5/300');
});

it('whole sample commits the audience heading only after successful replacement and leaves discarded headings untouched', async t => {
  const h = await setup(t), state = roomState(); h.sdk.snapshot(clone(state)); const old = audienceHeading(h);
  const replace = h.main.replaceChildren.bind(h.main); let fail = true; let discarded: SampleNode | undefined;
  h.main.replaceChildren = (...nodes) => {
    if (fail) {
      fail = false; discarded = nodes.flatMap(node => node.descendants()).find(node => node.tagName === 'h2' && node.textContent.startsWith('觀眾 ·'));
      throw new Error('controlled count replacement failure');
    }
    replace(...nodes);
  };
  const changed = clone(state); changed.name = 'Changed room'; changed.audienceCount = 2;
  assert.throws(() => h.sdk.snapshot(changed), /controlled count replacement failure/); assert.ok(discarded);
  assert.equal(audienceHeading(h), old); assert.equal(h.references().heading, old); assert.equal(discarded.isConnected, false);
  h.sdk.snapshot({ ...clone(state), audienceCount: 3 });
  assert.equal(audienceHeading(h), old); assert.equal(old.textContent, '觀眾 · 3/300'); assert.equal(discarded.textContent, '觀眾 · 2/300');
  h.sdk.snapshot(changed); const current = audienceHeading(h); assert.notEqual(current, old); assert.notEqual(current, discarded);
  assert.equal(h.references().heading, current); h.sdk.snapshot({ ...clone(changed), audienceCount: 4 });
  assert.equal(current.textContent, '觀眾 · 4/300'); assert.equal(old.textContent, '觀眾 · 3/300'); assert.equal(discarded.textContent, '觀眾 · 2/300');
});

for (const transition of ['leave', 'disconnect', 'closed', 'kicked'] as const) {
  it(`whole sample ${transition} releases the audience heading and isolates count updates after same-identity rejoin`, async t => {
    const h = await setup(t), state = managementState(); h.sdk.snapshot(clone(state));
    const old = audienceHeading(h), people = rows(h); h.sdk.snapshot({ ...clone(state), audienceCount: 3 });
    assert.equal(old.textContent, '觀眾 · 3/300');
    if (transition === 'leave') { h.button('離開房間').click(); await flushSample(); }
    else if (transition === 'disconnect') await h.sdk.disconnect();
    else await h.sdk.terminal(transition, transition === 'closed' ? 'shutdown' : undefined);
    await flushSample(); assert.equal(h.references().heading, undefined); assert.equal(h.references().people.length, 0);
    assert.equal(h.references().gains.length, 0); assert.equal(h.references().audience.length, 0);
    assert.equal(old.isConnected, false); assert.equal(people.every(row => !row.isConnected), true);
    h.sdk.snapshot({ ...clone(state), audienceCount: 4 }); const current = audienceHeading(h); assert.notEqual(current, old); h.reset();
    h.sdk.snapshot({ ...clone(state), audienceCount: 5 });
    assert.equal(audienceHeading(h), current); assert.equal(current.textContent, '觀眾 · 5/300'); assert.equal(old.textContent, '觀眾 · 3/300');
    assert.equal(h.references().heading, current); assert.equal(h.counts.replacements, 0); assert.equal(h.counts.rows, 0);
  });
}
