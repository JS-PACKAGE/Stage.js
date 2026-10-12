import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';

const source = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
// Exercise the production handlers with DOM/SDK doubles, not a duplicate pending-state model.
const actions = source.slice(source.indexOf('function resetRoomActions('), source.indexOf('function showError('));
const render = source.slice(source.indexOf('function renderRoom('), source.indexOf('function panelList('));
const cooldown = source.slice(source.indexOf('function updateCooldown('), source.indexOf("client.on('state', ({ detail })"));
interface Button {
  disabled: boolean;
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
}
function setup(): Harness {
  return runInNewContext(stripTypeScriptTypes(`
    let roomActionIdentity = '', roomActionGeneration = 0, cooldownButton = null;
    const pendingRoomActions = new Map(), nodes = [], errors = [];
    const client = { status: 'waiting', handCooldownMs: 0, me: { handRaised: false } };
    const content = { querySelectorAll: () => nodes, querySelector: () => nodes.find(node => node.dataset.returnStage),
      replaceChildren(...children) {
        nodes.length = 0;
        const visit = node => { if (node.dataset.roomAction) nodes.push(node); for (const child of node.children) visit(child); };
        children.forEach(visit);
      } };
    const brand = {}, status = {}, connectionLine = { dataset: {}, children: [] };
    const statusLabels = {}, roleLabels = {}, createdRoom = null;
    const location = { pathname: '/', origin: 'https://example.test' };
    const decodeName = value => value;
    const button = () => element(), panelList = () => element();
    function renderNotices() {}
    const errorBox = { hidden: true };
    function element() { return { isConnected: true, disabled: false, dataset: {}, attrs: {}, children: [], append(...children) { this.children.push(...children); }, setAttribute(k, v) { this.attrs[k] = v; } }; }
    function showError(error) { errors.push(error); }
    function syncMeter() {}
    ${actions}
    ${cooldown}
    ${render}
    ({ client, errors, nodes, reset: resetRoomActions, tick: updateCooldown, render(state) { client.me = state.me; renderRoom(state); },
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
