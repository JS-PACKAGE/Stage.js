import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';

type Status = 'waiting' | 'live' | 'reconnecting' | 'disconnected';
interface Me { participantId: string; name: string; onStage: boolean; handRaised: boolean }
interface State { roomId: string; name: string; me: Me }
interface JoinOptions { roomId: string; code?: string; name: string }
interface ClientOptions { url: string; audioElement: EmbedNode }
type Action = 'raise' | 'withdraw';

class Deferred {
  private readonly work = Promise.withResolvers<void>();
  readonly promise = this.work.promise;
  settled = false;
  resolve(): void { assert.equal(this.settled, false); this.settled = true; this.work.resolve(); }
  reject(message: string): void { assert.equal(this.settled, false); this.settled = true; this.work.reject(new Error(message)); }
}
class EmbedNode {
  disabled = false; value = ''; textContent = '';
  readonly attributes: Record<string, string> = {};
  onclick: (() => void) | null = null;
  onsubmit: ((event: { preventDefault(): void }) => void) | null = null;
  submitButton: EmbedNode | null = null;
  setAttribute(key: string, value: string): void { this.attributes[key] = value; }
  querySelector(selector: string): EmbedNode | null {
    assert.equal(selector, 'button', 'unmodeled form selector'); return this.submitButton;
  }
  click(): void { if (!this.disabled) this.invoke(); }
  invoke(): void { assert.ok(this.onclick); this.onclick(); }
  submit(): void {
    assert.ok(this.onsubmit); let prevented = false;
    this.onsubmit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true, 'joining must prevent native form navigation');
  }
  async play(): Promise<void> {}
}
class EmbedSdk {
  status: Status = 'disconnected';
  me: Me | null = null;
  handCooldownMs = 0;
  readonly options: ClientOptions;
  readonly joins: JoinOptions[] = [];
  readonly actions: { type: Action; work: Deferred }[] = [];
  private readonly listeners = new Map<string, ((event: { detail: unknown }) => void)[]>();
  constructor(options: ClientOptions) { this.options = options; }
  on(type: string, listener: (event: { detail: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? []; listeners.push(listener); this.listeners.set(type, listeners);
  }
  emit(type: string, detail: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ detail });
  }
  setStatus(status: Status): void { this.status = status; this.emit('status', status); }
  snapshot(overrides: Partial<Me> = {}): void {
    this.me = { participantId: 'listener', name: '測試聽眾', onStage: false, handRaised: false, ...this.me, ...overrides };
    const state: State = { roomId: 'same-room', name: '測試舞台', me: this.me };
    this.emit('state', state);
  }
  async connect(): Promise<void> { this.setStatus('waiting'); }
  async join(options: JoinOptions): Promise<void> { this.joins.push(options); }
  async disconnect(): Promise<void> {
    // Keep command promises deferred so tests can deliver adversarial late settlements explicitly.
    this.me = null; this.handCooldownMs = 0; this.setStatus('disconnected');
  }
  async unlockAudio(): Promise<void> {}
  private request(type: Action): Promise<void> {
    const work = new Deferred(); this.actions.push({ type, work }); return work.promise;
  }
  raiseHand(): Promise<void> { this.handCooldownMs = 1500; return this.request('raise'); }
  withdrawHand(): Promise<void> { return this.request('withdraw'); }
}
const source = readFileSync(new URL('../web/src/embed.ts', import.meta.url), 'utf8');
const flush = async (): Promise<void> => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

function embedApp() {
  const nodes = new Map(['host', 'room', 'code', 'name', 'status', 'join', 'hand', 'leave', 'audio', 'unlock'].map(id => [id, new EmbedNode()]));
  const node = (id: string): EmbedNode => { const found = nodes.get(id); assert.ok(found, `unmodeled node: ${id}`); return found; };
  const hand = node('hand'), leave = node('leave'), form = node('join'), status = node('status');
  hand.disabled = leave.disabled = true; hand.textContent = '舉手發言'; status.textContent = '尚未加入';
  const submit = new EmbedNode(); form.submitButton = submit; node('name').value = ' 測試聽眾 ';
  const clients: EmbedSdk[] = [], moduleUrls: string[] = [];
  const intervals = new Map<number, { callback(): void; ms: number }>(); let timerId = 0, callbacks = 0;
  const library = {
    StageClient: class extends EmbedSdk { constructor(options: ClientOptions) { super(options); clients.push(this); } },
    decodeName: (value: string) => value,
  };
  // Execute the complete module; replace only its external-host import and stylesheet import.
  const dynamicImport = 'import(/* @vite-ignore */ moduleUrl)';
  assert.equal(source.split(dynamicImport).length, 2, 'the external library import seam must stay exact and unique');
  assert.equal(source.split("import './styles.css';").length, 2, 'the stylesheet import seam must stay exact and unique');
  const executable = stripTypeScriptTypes(source.replace("import './styles.css';", '').replace(dynamicImport, 'loadLibrary(moduleUrl)'));
  assert.doesNotMatch(executable, /\bimport\s*(?:\(|['"])/, 'the fixture must never import a real external library');
  runInNewContext(executable, {
    document: { querySelector(selector: string) { assert.match(selector, /^#[a-z]+$/); return node(selector.slice(1)); } },
    location: { search: '?host=https%3A%2F%2Fstage.example.test%2Fprefix&room=%20same-room%20&code=%20TEST42%20', origin: 'https://embed.example.test' },
    URL, URLSearchParams, Error, Promise,
    loadLibrary: async (url: string) => { moduleUrls.push(url); return library; },
    setInterval(callback: () => void, ms: number) {
      assert.equal(ms, 250, 'only the embed cooldown interval is modeled');
      const id = ++timerId; intervals.set(id, { callback, ms }); return id;
    },
    clearInterval(id: number) { intervals.delete(id); },
  }, { filename: 'web/src/embed.ts', timeout: 1000 });
  assert.equal(intervals.size, 1);
  const tick = (elapsed = 250): void => {
    assert.ok(elapsed >= 0 && elapsed % 250 === 0 && elapsed <= 10000, 'bounded fake timer advance');
    for (let i = 0; i < elapsed / 250; i++) {
      for (const sdk of clients) sdk.handCooldownMs = Math.max(0, sdk.handCooldownMs - 250);
      for (const job of intervals.values()) { assert.ok(++callbacks <= 1000); job.callback(); }
    }
  };
  return {
    hand, leave, form, submit, status, clients, moduleUrls, node, tick,
    async join(overrides: Partial<Me> = {}): Promise<EmbedSdk> {
      const count = clients.length; form.submit(); assert.equal(submit.disabled, true); await flush();
      assert.equal(clients.length, count + 1); const sdk = clients.at(-1)!;
      assert.equal(sdk.joins.length, 1); sdk.snapshot(overrides); assert.equal(submit.disabled, false); return sdk;
    },
    async cleanup(): Promise<void> {
      for (const sdk of clients) for (const action of sdk.actions) if (!action.work.settled) action.work.resolve();
      await flush(); intervals.clear();
      assert.ok(clients.every(sdk => sdk.actions.every(action => action.work.settled)), 'all command promises must settle');
      assert.equal(intervals.size, 0);
    },
  };
}
const latest = (sdk: EmbedSdk): Deferred => { const action = sdk.actions.at(-1); assert.ok(action); return action.work; };
function assertPending(hand: EmbedNode, pending: boolean): void {
  assert.equal(hand.attributes['aria-busy'], String(pending));
  if (pending) assert.equal(hand.disabled, true);
}

it('whole embed joins through the injected host library and ignores hand clicks before a snapshot', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); h.hand.invoke(); h.tick();
  assert.equal(h.hand.disabled, true); assert.equal(h.clients.length, 0);
  h.form.submit(); await flush(); const sdk = h.clients[0]!; h.hand.invoke(); h.tick();
  assert.deepEqual(h.moduleUrls, ['https://stage.example.test/lib/stage-client.js']);
  assert.equal(sdk.options.url, 'wss://stage.example.test/ws'); assert.equal(sdk.options.audioElement, h.node('audio'));
  assert.deepEqual({ ...sdk.joins[0] }, { roomId: 'same-room', code: 'TEST42', name: '測試聽眾' });
  assert.equal(sdk.actions.length, 0); assert.equal(h.hand.disabled, true);
  sdk.snapshot(); assert.equal(h.hand.disabled, false); assert.equal(h.leave.disabled, false);
});

for (const repaint of ['timer', 'state', 'handler'] as const) {
  it(`whole embed pending withdrawal survives ${repaint} reentry without a duplicate request`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ handRaised: true });
    h.hand.click(); assert.equal(sdk.actions.length, 1); assert.equal(sdk.actions[0]!.type, 'withdraw');
    if (repaint === 'timer') { h.tick(); assert.equal(h.hand.disabled, true, 'timer repaint must preserve pending'); h.hand.click(); }
    else if (repaint === 'state') { sdk.snapshot({ handRaised: true }); assert.equal(h.hand.disabled, true, 'state repaint must preserve pending'); h.hand.click(); }
    else h.hand.invoke();
    assert.equal(sdk.actions.length, 1, `${repaint} must not admit another pending withdrawal`);
    assertPending(h.hand, true); assert.equal(h.hand.textContent, '收回舉手');
    sdk.snapshot({ handRaised: false }); h.tick(); h.hand.invoke();
    assert.equal(sdk.actions.length, 1, 'state-before-ACK must not admit the opposite hand action');
    latest(sdk).resolve(); await flush(); assertPending(h.hand, false); assert.equal(h.hand.disabled, false);
    h.hand.click(); assert.equal(sdk.actions.length, 2); assert.equal(sdk.actions[1]!.type, 'raise');
  });
}

it('whole embed shares the pending toggle across state-before-ACK and keeps the current cooldown on settlement', async t => {
  const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join();
  h.hand.click(); sdk.snapshot({ handRaised: true }); h.tick(); h.hand.invoke();
  assert.equal(sdk.actions.length, 1); assertPending(h.hand, true); assert.equal(h.hand.textContent, '收回舉手');
  latest(sdk).resolve(); await flush(); assertPending(h.hand, false); assert.equal(h.hand.disabled, false);
  assert.ok(sdk.handCooldownMs > 0, 'cooldown must not block withdrawal of a raised hand');
  h.hand.click(); sdk.snapshot({ handRaised: false }); h.tick(); h.hand.invoke();
  assert.equal(sdk.actions.length, 2); assert.equal(sdk.actions[1]!.type, 'withdraw'); assertPending(h.hand, true);
  latest(sdk).resolve(); await flush(); assertPending(h.hand, false); assert.equal(h.hand.disabled, true);
  assert.equal(h.hand.textContent, '舉手發言（1 秒）');
  h.tick(1000); assert.equal(h.hand.disabled, false); assert.equal(h.hand.textContent, '舉手發言');
  h.hand.click(); assert.equal(sdk.actions.length, 3); assert.equal(sdk.actions[2]!.type, 'raise');
});

for (const failure of ['rejection', 'synchronous throw'] as const) {
  it(`whole embed releases a current ${failure} for retry without leaving a busy lock`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ handRaised: true });
    const withdraw = sdk.withdrawHand.bind(sdk); let attempts = 0;
    if (failure === 'synchronous throw') sdk.withdrawHand = () => { if (++attempts === 1) throw new Error('請重試。'); return withdraw(); };
    h.hand.click();
    if (failure === 'rejection') { assertPending(h.hand, true); latest(sdk).reject('請重試。'); }
    await flush(); assert.equal(h.status.textContent, '請重試。'); assertPending(h.hand, false); assert.equal(h.hand.disabled, false);
    const before = sdk.actions.length; h.hand.click(); assert.equal(sdk.actions.length, before + 1); assertPending(h.hand, true);
    latest(sdk).resolve(); await flush(); assertPending(h.hand, false);
  });
}

for (const policy of ['onStage', 'reconnecting', 'cooldown'] as const) {
  it(`whole embed retains ${policy} restrictions when a hand request settles and checks the handler gate`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ handRaised: true });
    h.hand.click(); sdk.snapshot({ handRaised: false });
    if (policy === 'onStage') sdk.snapshot({ onStage: true });
    else if (policy === 'reconnecting') sdk.setStatus('reconnecting');
    else sdk.handCooldownMs = 1000;
    latest(sdk).resolve(); await flush(); assertPending(h.hand, false); assert.equal(h.hand.disabled, true);
    h.hand.disabled = false; h.hand.invoke(); h.tick();
    assert.equal(sdk.actions.length, 1, 'direct handler invocation must recheck current policy'); assert.equal(h.hand.disabled, true);
    if (policy === 'onStage') sdk.snapshot({ onStage: false });
    else if (policy === 'reconnecting') { sdk.setStatus('waiting'); sdk.snapshot(); }
    else h.tick(750);
    assert.equal(h.hand.disabled, false); h.hand.click(); assert.equal(sdk.actions.length, 2);
  });
}

for (const terminal of ['leave', 'disconnected', 'closed', 'kicked'] as const) {
  it(`whole embed ${terminal} revokes pending ownership and late failure cannot replace terminal status`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const sdk = await h.join({ handRaised: true });
    h.hand.click(); const work = latest(sdk);
    if (terminal === 'leave') h.leave.click();
    else { await sdk.disconnect(); if (terminal !== 'disconnected') sdk.emit(terminal, { roomId: 'same-room' }); }
    await flush(); const status = h.status.textContent; h.tick(); h.hand.invoke();
    assert.equal(h.hand.disabled, true); assertPending(h.hand, false); assert.equal(sdk.actions.length, 1);
    work.reject('retired request failure'); await flush();
    assert.equal(h.status.textContent, status); assert.equal(h.hand.disabled, true); assertPending(h.hand, false);
  });
}

for (const settlement of ['resolve', 'reject'] as const) {
  it(`whole embed old-client ${settlement} cannot unlock, relabel, or report into a replacement pending action`, async t => {
    const h = embedApp(); t.after(() => h.cleanup()); const old = await h.join({ handRaised: true });
    h.hand.click(); const retired = latest(old);
    const current = await h.join({ handRaised: true }); assert.notEqual(current, old);
    h.hand.click(); const active = latest(current), status = h.status.textContent;
    if (settlement === 'resolve') retired.resolve(); else retired.reject('old failure');
    await flush(); assertPending(h.hand, true); assert.equal(h.status.textContent, status);
    assert.equal(h.hand.textContent, '收回舉手');
    old.snapshot({ onStage: true }); old.setStatus('disconnected'); old.emit('closed', { roomId: 'same-room' }); old.emit('kicked', { roomId: 'same-room' });
    h.tick(); h.hand.invoke();
    assertPending(h.hand, true); assert.equal(h.status.textContent, status); assert.equal(h.hand.textContent, '收回舉手');
    assert.equal(old.actions.length, 1); assert.equal(current.actions.length, 1);
    current.snapshot({ handRaised: false }); active.resolve(); await flush(); assertPending(h.hand, false); assert.equal(h.hand.disabled, false);
    h.hand.click(); assert.equal(current.actions.length, 2); assert.equal(current.actions[1]!.type, 'raise');
  });
}
