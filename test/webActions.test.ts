import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';

const source = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
// Exercise the production handlers with DOM/SDK doubles, not a duplicate pending-state model.
const actions = source.slice(source.indexOf('function resetRoomActions('), source.indexOf('function showError('));
const people = source.slice(source.indexOf('function panelList('), source.indexOf('/** Controller\'s per-speaker')) ;
const landing = source.slice(source.indexOf('function landing()'), source.indexOf('function renderNotices()'));
const audienceFilter = source.slice(source.indexOf('function resetAudienceFilter()'), source.indexOf('function renderRoom('));
const render = source.slice(source.indexOf('function renderRoom('), source.indexOf('function panelList('));
const cooldown = source.slice(source.indexOf('function updateCooldown('), source.indexOf("client.on('state', ({ detail })"));
interface Button {
  disabled: boolean;
  textContent: string;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  onclick(): void;
}
interface Harness {
  client: { status: string; handCooldownMs: number; me: { handRaised: boolean } };
  errors: string[];
  nodes: Button[];
  button(key: string, action: () => Promise<unknown>): Button;
  reset(identity: string): void;
  tick(): void;
  render(state: unknown): void;
  landing(): void;
  invitation(): string;
  delays(): number[];
  callbacks(): number;
  advance(ms: number): void;
}
function setup(): Harness {
  return runInNewContext(stripTypeScriptTypes(`
    let busy = false;
    let roomActionIdentity = '', roomActionGeneration = 0, cooldownButton = null, cooldownTimer, cooldownDue = 0, invitation = '';
    const pendingRoomActions = new Map(), nodes = [], errors = [];
    const personRows = new Map(), quality = new Map(); let speakingIds = new Set();
    let renderedRoomSignature; const renderedGainInputs = [];
    let audienceFilterIdentity = ''; const audienceFilterRows = [];
    const audienceFilter = {}, audienceSearch = { value: '' }, audienceFilterClear = {}, audienceFilterCount = {};
    let nextTimer = 0, clock = 0, callbacks = 0;
    const performance = { now: () => clock };
    const timers = new Map();
    const setTimeout = (fn, delay) => { const id = ++nextTimer; timers.set(id, { fn, at: clock + delay }); return id; };
    const clearTimeout = id => timers.delete(id);
    const client = { state: null, status: 'waiting', handCooldownMs: 0, me: { handRaised: false }, speaking: new Set() };
    const content = { querySelectorAll: selector => selector === '[data-room-action]' ? nodes : [], querySelector: () => nodes.find(node => node.dataset.returnStage),
      replaceChildren(...children) {
        nodes.length = 0;
        const visit = node => { if (node.dataset.roomAction) nodes.push(node); for (const child of node.children) visit(child); };
        children.forEach(visit);
      } };
    const brand = {}, status = {}, connectionLine = { dataset: {}, children: [] };
    const statusLabels = {}, roleLabels = {}, createdRoom = null;
    const location = { pathname: '/', origin: 'https://example.test' };
    const decodeName = value => value;
    const button = () => element(), field = () => element(), gainSlider = () => element();
    const window = { confirm: () => true };
    function applyQuality() {}
    const params = { get: () => null }, document = { createTextNode: () => element() };
    function renderNotices() {}
    function resetMicSettings() {}
    const errorBox = { hidden: true };
    function element(tag, className, text) { return { textContent: text ?? '', classList: { toggle() {} }, isConnected: true, disabled: false, dataset: {}, attrs: {}, children: [], append(...children) { this.children.push(...children); }, setAttribute(k, v) { this.attrs[k] = v; } }; }
    function showError(error) { errors.push(error); }
    function syncMeter() {}
    ${actions}
    ${cooldown}
    ${audienceFilter}
    ${render}
    ${people}
    ${landing}
    ({ client, errors, nodes, landing, invitation: () => invitation,
      delays: () => [...timers.values()].map(timer => timer.at - clock), callbacks: () => callbacks,
      advance(ms) {
        clock += ms; client.handCooldownMs = Math.max(0, client.handCooldownMs - ms);
        for (const [id, timer] of [...timers]) if (timer.at <= clock && timers.has(id)) {
          timers.delete(id); callbacks++; timer.fn();
        }
      }, reset: resetRoomActions, tick: updateCooldown, render(state) { client.state = state; client.me = state.me; renderRoom(state); },
      button(key, action) { const node = roomButton(key, key, action); nodes.push(node); updateCooldown(); return node; } });
  `), { Symbol, Map, Error, Math, Promise, URL }) as Harness;
}
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

it('keeps a pending return-to-stage disabled across cooldown ticks and snapshot node replacement', async () => {
  const h = setup(); h.reset('room/participant');
  const work = Promise.withResolvers<void>(); let calls = 0;
  const action = () => { calls++; return work.promise; };
  const first = h.button('stage', action); first.dataset.returnStage = 'true'; first.onclick(); h.tick();
  assert.equal(first.disabled, true); assert.equal(first.attrs['aria-busy'], 'true');
  h.nodes.length = 0; h.reset('room/participant');
  const replacement = h.button('stage', action); replacement.onclick(); first.onclick();
  assert.equal(replacement.disabled, true); assert.equal(calls, 1);
  work.resolve(); await flush(); assert.equal(replacement.disabled, false);
  assert.equal(replacement.attrs['aria-busy'], 'false');
});

it('allows retry after rejection and reapplies current server and reconnect restrictions', async () => {
  const h = setup(); h.reset('room/p'); const work = Promise.withResolvers<void>(); let calls = 0;
  const node = h.button('mute', () => { calls++; return calls === 1 ? work.promise : Promise.resolve(); });
  node.onclick(); work.reject(new Error('try again')); await flush();
  assert.deepEqual([...h.errors], ['try again']); assert.equal(node.disabled, false);
  node.onclick(); await flush(); assert.equal(calls, 2);
  node.dataset.policyDisabled = 'true'; h.tick(); assert.equal(node.disabled, true);
  node.dataset.policyDisabled = 'false'; h.client.status = 'reconnecting'; h.tick(); assert.equal(node.disabled, true);
  h.client.status = 'waiting'; h.tick(); assert.equal(node.disabled, false);
});

it('old settlement and stale DOM clicks cannot unlock or invoke a new room action', async () => {
  const h = setup(); h.reset('room/p'); const old = Promise.withResolvers<void>(), next = Promise.withResolvers<void>();
  let calls = 0; const first = h.button('stage', () => { calls++; return old.promise; }); first.onclick();
  h.reset(''); h.nodes.length = 0; h.reset('room/p');
  const replacement = h.button('stage', () => { calls++; return next.promise; }); replacement.onclick();
  old.reject(new Error('old failure')); await flush(); first.disabled = false; first.onclick();
  assert.equal(calls, 2); assert.equal(h.errors.length, 0); assert.equal(replacement.disabled, true);
  next.resolve(); await flush(); assert.equal(replacement.disabled, false);
});

it('shares a pending hand toggle across state changes and preserves cooldown on completion', async () => {
  const h = setup(); h.reset('room/p'); const work = Promise.withResolvers<void>();
  const first = h.button('hand', () => work.promise); first.onclick();
  h.client.me.handRaised = true; h.nodes.length = 0;
  const withdrawal = h.button('hand', () => Promise.resolve()); assert.equal(withdrawal.disabled, true);
  h.client.me.handRaised = false; h.client.handCooldownMs = 1000;
  work.resolve(); await flush(); assert.equal(withdrawal.disabled, true);
  h.client.handCooldownMs = 0; h.tick(); assert.equal(withdrawal.disabled, false);
});

it('keeps reconnect and force-mute policy after a pending action settles', async () => {
  const h = setup(); h.reset('room/p'); const work = Promise.withResolvers<void>();
  const node = h.button('mute', () => work.promise); node.onclick();
  h.client.status = 'reconnecting'; node.dataset.policyDisabled = 'true'; work.resolve(); await flush();
  assert.equal(node.disabled, true); assert.equal(node.attrs['aria-busy'], 'false');
  h.client.status = 'waiting'; h.tick(); assert.equal(node.disabled, true);
});

it('actual room renderer preserves the stage pending key and resets it for a replacement identity', async () => {
  const h = setup(); const work = Promise.withResolvers<void>(); let calls = 0;
  Object.assign(h.client, { returnToStage: () => { calls++; return work.promise; }, leaveStage: () => Promise.resolve() });
  const state = { roomId: 'room', name: 'Room', controllerId: 'p', codeRequired: false,
    me: { participantId: 'p', name: 'Guest', role: 'controller', onStage: false, handRaised: false },
    speakers: [], hands: [], audienceCount: 0, limits: { maxSpeakers: 8, maxAudience: 300 } };
  h.render(state); const first = h.nodes.find(node => node.dataset.roomAction === 'stage')!; first.onclick();
  h.render({ ...state, me: { ...state.me, onStage: true, forceMuted: true } });
  const replacement = h.nodes.find(node => node.dataset.roomAction === 'stage')!;
  assert.equal(replacement.disabled, true); replacement.onclick(); assert.equal(calls, 1);
  assert.equal(h.nodes.find(node => node.dataset.roomAction === 'mute')!.disabled, true);
  h.render({ ...state, me: { ...state.me, participantId: 'new' } });
  assert.equal(h.nodes.find(node => node.dataset.roomAction === 'stage')!.disabled, false);
  work.resolve(); await flush();
});

it('releases the logical action after a synchronous throw', async () => {
  const h = setup(); h.reset('room/p'); let calls = 0;
  const node = h.button('stage', () => { calls++; throw new Error('sync failure'); });
  node.onclick(); await flush(); assert.equal(node.disabled, false);
  node.onclick(); await flush(); assert.equal(calls, 2); assert.equal(h.errors.length, 2);
});

it('actual audience renderer keeps the cooldown button pending across its timer overwrite', async () => {
  const h = setup(); const work = Promise.withResolvers<void>(); let calls = 0;
  Object.assign(h.client, { raiseHand: () => { calls++; return work.promise; } });
  h.render({ roomId: 'room', name: 'Room', controllerId: 'host', codeRequired: false,
    me: { participantId: 'p', name: 'Guest', role: 'audience', onStage: false, handRaised: false },
    speakers: [], hands: [], audienceCount: 1, limits: { maxSpeakers: 8, maxAudience: 300 } });
  const node = h.nodes.find(node => node.dataset.roomAction === 'hand')!;
  node.onclick(); h.tick(); node.onclick(); assert.equal(calls, 1); assert.equal(node.disabled, true);
  work.resolve(); await flush(); assert.equal(node.disabled, false);
});

function audienceState(handRaised = false, onStage = false) {
  return { roomId: 'room', name: 'Room', controllerId: 'host', codeRequired: false,
    me: { participantId: 'p', name: 'Guest', role: 'audience', onStage, handRaised },
    speakers: [], hands: [], audienceCount: 1, limits: { maxSpeakers: 8, maxAudience: 300 } };
}

it('schedules only displayed countdown boundaries without postponing an existing wake', () => {
  const h = setup(); h.client.handCooldownMs = 1500.75; h.render(audienceState());
  assert.deepEqual([...h.delays()], [501]);
  h.advance(100); h.render(audienceState()); h.tick(); assert.deepEqual([...h.delays()], [401]);
  h.advance(401); assert.deepEqual([...h.delays()], [1000]);
  h.advance(1000); assert.deepEqual([...h.delays()], []); assert.equal(h.callbacks(), 2);
  assert.equal(h.nodes[0]!.disabled, false);
});

it('a late countdown callback recomputes current state without replaying missed ticks', () => {
  const h = setup(); h.client.handCooldownMs = 5500; h.render(audienceState());
  h.advance(6000); assert.equal(h.callbacks(), 1); assert.deepEqual([...h.delays()], []);
  assert.equal(h.nodes[0]!.disabled, false);
});

it('cancels countdowns on raised hand or stage changes and keeps pending expiry disabled', async () => {
  const h = setup(); h.client.handCooldownMs = 1500; h.render(audienceState());
  h.render(audienceState(true)); assert.deepEqual([...h.delays()], []);
  h.render(audienceState()); assert.equal(h.delays().length, 1);
  h.render(audienceState(false, true)); assert.deepEqual([...h.delays()], []);
  h.client.handCooldownMs = 0; const work = Promise.withResolvers<void>();
  Object.assign(h.client, { raiseHand: () => { h.client.handCooldownMs = 1500; return work.promise; } });
  h.render(audienceState()); h.nodes[0]!.onclick();
  assert.deepEqual([...h.delays()], [500], 'local cooldown schedules before the ACK'); h.advance(1500);
  assert.equal(h.nodes[0]!.disabled, true); assert.equal(h.delays().length, 0);
  work.resolve(); await flush(); assert.equal(h.nodes[0]!.disabled, false);
});

it('production room scheduler keeps stats cadence with zero idle cooldown polling', () => {
  const scheduling = source.slice(source.indexOf('function syncRoomTimers()'), source.indexOf("client.on('state', syncRoomTimers)"));
  const jobs: { fn: () => void; ms: number }[] = []; let stats = 0, cooldownCalls = 0;
  runInNewContext(stripTypeScriptTypes(`let roomTimers = []; ${scheduling}; syncRoomTimers();`), {
    client: { state: {} }, connectionLine: {}, clearInterval() {},
    setInterval(fn: () => void, ms: number) { jobs.push({ fn, ms }); return jobs.length; },
    refreshConnectionLine() { stats++; }, updateCooldown() { cooldownCalls++; },
  });
  for (const job of jobs) for (let elapsed = job.ms; elapsed <= 60000; elapsed += job.ms) job.fn();
  assert.equal(stats, 30); assert.equal(cooldownCalls, 0);
  const h = setup(); h.render(audienceState()); h.advance(60000);
  assert.equal(h.callbacks(), 0); assert.equal(h.delays().length, 0);
});

it('landing cancels the old countdown and rejoin/controller transitions own only current timers', () => {
  const h = setup(); h.client.handCooldownMs = 1500; h.render(audienceState());
  assert.equal(h.delays().length, 1); h.landing(); assert.equal(h.delays().length, 0);
  h.advance(500); assert.equal(h.callbacks(), 0); h.render(audienceState()); assert.equal(h.delays().length, 1);
  const state = audienceState(); h.render({ ...state, me: { ...state.me, role: 'controller' } });
  assert.equal(h.delays().length, 0); h.client.status = 'disconnected'; h.landing();
  h.advance(60000); assert.equal(h.callbacks(), 0);
});

function moderatorState(kind: 'hand' | 'speaker' | 'audience' = 'hand', forceMuted = false) {
  const person = { participantId: 'target', name: 'Target', role: kind === 'speaker' ? 'speaker' : 'audience',
    connected: true, muted: forceMuted, forceMuted, gainDb: 0, handRaised: kind === 'hand', onStage: kind === 'speaker' };
  return { ...audienceState(), codeRequired: true, code: 'OLD123', controllerId: 'p',
    me: { ...audienceState().me, role: 'controller' },
    hands: kind === 'hand' ? [person] : [], speakers: kind === 'speaker' ? [person] : [],
    audience: kind === 'audience' ? [person] : [] };
}

for (const [method, label, kind] of [
  ['approve', '核准上台', 'hand'], ['reject', '婉拒', 'hand'],
  ['forceMute', '強制靜音', 'speaker'], ['forceUnmute', '解除強制靜音', 'speaker'],
  ['removeFromStage', '移出舞台', 'speaker'], ['transferControl', '移交控制權', 'audience'],
  ['kick', '踢出房間', 'audience'], ['rotateCode', '更換房間代碼', 'hand'], ['closeRoom', '關閉房間', 'hand'],
] as const) {
  it(`keeps ${method} pending across actual management list/room reconstruction`, async () => {
    const h = setup(), work = Promise.withResolvers<void>(); let calls = 0;
    Object.assign(h.client, { [method]: () => { calls++; return work.promise; } });
    const state = moderatorState(kind, method === 'forceUnmute'); h.render(state);
    h.nodes.find(node => node.textContent === label)!.onclick();
    h.render({ ...state, code: 'NEW111' });
    const replacement = h.nodes.find(node => node.textContent === label)!;
    assert.equal(replacement.disabled, true); assert.equal(replacement.attrs['aria-busy'], 'true');
    replacement.onclick(); assert.equal(calls, 1);
    work.resolve(); await flush(); assert.equal(replacement.disabled, false);
  });
}

it('shares target stage and force-mute keys across opposite action snapshots', async () => {
  const h = setup(), stage = Promise.withResolvers<void>(), mute = Promise.withResolvers<void>();
  Object.assign(h.client, { approve: () => stage.promise, forceMute: () => mute.promise });
  h.render(moderatorState('hand')); h.nodes.find(node => node.textContent === '核准上台')!.onclick();
  assert.equal(h.nodes.find(node => node.textContent === '婉拒')!.disabled, true);
  h.render(moderatorState('speaker')); assert.equal(h.nodes.find(node => node.textContent === '移出舞台')!.disabled, true);
  h.nodes.find(node => node.textContent === '強制靜音')!.onclick();
  h.render(moderatorState('speaker', true)); assert.equal(h.nodes.find(node => node.textContent === '解除強制靜音')!.disabled, true);
  stage.resolve(); mute.resolve(); await flush();
});

it('one transfer locks all target transfer buttons without locking unrelated targets', async () => {
  const h = setup(), work = Promise.withResolvers<void>();
  Object.assign(h.client, { transferControl: () => work.promise });
  const state = moderatorState('audience'); state.audience.push({ ...state.audience[0]!, participantId: 'other' });
  h.render(state); h.nodes.find(node => node.dataset.roomAction === 'transfer')!.onclick();
  assert.ok(h.nodes.filter(node => node.dataset.roomAction === 'transfer').every(node => node.disabled));
  assert.ok(h.nodes.filter(node => node.dataset.roomAction?.startsWith('kick:')).every(node => !node.disabled));
  work.resolve(); await flush();
});

it('old rotation success cannot change the replacement room notice or pending state', async () => {
  const h = setup(), old = Promise.withResolvers<void>(), next = Promise.withResolvers<void>(); let calls = 0;
  Object.assign(h.client, { rotateCode: () => ++calls === 1 ? old.promise : next.promise });
  h.render(moderatorState()); h.nodes.find(node => node.dataset.roomAction === 'rotate-code')!.onclick();
  h.render({ ...moderatorState(), roomId: 'new-room' });
  const replacement = h.nodes.find(node => node.dataset.roomAction === 'rotate-code')!; replacement.onclick();
  old.resolve(); await flush(); assert.equal(h.invitation(), ''); assert.equal(replacement.disabled, true);
  next.resolve(); await flush(); assert.match(h.invitation(), /已更換房間代碼/); assert.equal(replacement.disabled, false);
});
