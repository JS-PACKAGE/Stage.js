import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import type { ParticipantView } from '../../shared/protocol.ts';

type Status = 'waiting' | 'live' | 'reconnecting' | 'disconnected';
type Me = Pick<ParticipantView, 'participantId' | 'name' | 'role' | 'onStage' | 'handRaised'>;
interface State { roomId: string; name: string; me: Me }
interface JoinOptions { roomId: string; code?: string; name: string }
interface ClientOptions { url: string; audioElement: EmbedNode }
type Action = 'raise' | 'withdraw';

export class Deferred {
  private readonly work = Promise.withResolvers<void>();
  readonly promise = this.work.promise;
  settled = false;
  resolve(): void { assert.equal(this.settled, false); this.settled = true; this.work.resolve(); }
  reject(message: string): void { assert.equal(this.settled, false); this.settled = true; this.work.reject(new Error(message)); }
}
export class EmbedNode {
  private disabledValue = false;
  private textValue = '';
  value = '';
  readonly writes = { disabled: 0, textContent: 0, attributes: 0, unchanged: 0 };
  get disabled(): boolean { return this.disabledValue; }
  set disabled(value: boolean) {
    this.writes.disabled++; if (value === this.disabledValue) this.writes.unchanged++;
    this.disabledValue = value;
  }
  get textContent(): string { return this.textValue; }
  set textContent(value: string) {
    this.writes.textContent++; if (value === this.textValue) this.writes.unchanged++;
    this.textValue = value;
  }
  resetWrites(): void { this.writes.disabled = this.writes.textContent = this.writes.attributes = this.writes.unchanged = 0; }
  readonly attributes: Record<string, string> = {};
  onclick: (() => void) | null = null;
  onsubmit: ((event: { preventDefault(): void }) => void) | null = null;
  submitButton: EmbedNode | null = null;
  setAttribute(key: string, value: string): void {
    this.writes.attributes++; if (value === this.attributes[key]) this.writes.unchanged++;
    this.attributes[key] = value;
  }
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
export class EmbedSdk {
  status: Status = 'disconnected';
  me: Me | null = null;
  private cooldownUntil = 0;
  private readonly now: () => number;
  get handCooldownMs(): number { return Math.max(0, this.cooldownUntil - this.now()); }
  set handCooldownMs(value: number) { this.cooldownUntil = this.now() + value; }
  readonly options: ClientOptions;
  readonly joins: JoinOptions[] = [];
  readonly actions: { type: Action; work: Deferred }[] = [];
  private readonly listeners = new Map<string, ((event: { detail: unknown }) => void)[]>();
  constructor(options: ClientOptions, now: () => number = () => 0) { this.options = options; this.now = now; }
  on(type: string, listener: (event: { detail: unknown }) => void): void {
    const listeners = this.listeners.get(type) ?? []; listeners.push(listener); this.listeners.set(type, listeners);
  }
  emit(type: string, detail: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ detail });
  }
  setStatus(status: Status): void { this.status = status; this.emit('status', status); }
  snapshot(overrides: Partial<Me> = {}): void {
    this.me = { participantId: 'listener', name: '測試聽眾', role: 'audience', onStage: false, handRaised: false, ...this.me, ...overrides };
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
const source = readFileSync(new URL('../../web/src/embed.ts', import.meta.url), 'utf8');
export const flush = async (): Promise<void> => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

export function embedApp(options: { libraryLoad?: Promise<void> } = {}) {
  const nodes = new Map(['host', 'room', 'code', 'name', 'status', 'join', 'hand', 'leave', 'audio', 'unlock'].map(id => [id, new EmbedNode()]));
  const node = (id: string): EmbedNode => { const found = nodes.get(id); assert.ok(found, `unmodeled node: ${id}`); return found; };
  const hand = node('hand'), leave = node('leave'), form = node('join'), status = node('status');
  hand.disabled = leave.disabled = true; hand.textContent = '舉手發言'; status.textContent = '尚未加入';
  const submit = new EmbedNode(); form.submitButton = submit; node('name').value = ' 測試聽眾 ';
  const clients: EmbedSdk[] = [], moduleUrls: string[] = [];
  type Timer = { id: number; kind: 'timeout' | 'interval'; callback(): void; ms: number; due: number };
  const timers = new Map<number, Timer>(), retired = new Map<number, Timer>();
  let timerId = 0, now = 0, callbacks = 0;
  const metrics = { timeoutScheduled: 0, intervalScheduled: 0, timeoutCleared: 0, intervalCleared: 0, callbacks: 0 };
  const schedule = (kind: Timer['kind'], callback: () => void, ms: number): number => {
    assert.ok(Number.isFinite(ms) && ms >= 1 && ms <= 10000, 'bounded positive embed timer delay');
    if (kind === 'interval') assert.equal(ms, 250, 'only the baseline embed interval is modeled');
    const id = ++timerId; timers.set(id, { id, kind, callback, ms, due: now + ms });
    metrics[kind === 'timeout' ? 'timeoutScheduled' : 'intervalScheduled']++; return id;
  };
  const clear = (kind: Timer['kind'], id: number): void => {
    const timer = timers.get(id); if (!timer) return;
    assert.equal(timer.kind, kind); timers.delete(id); retired.set(id, timer);
    metrics[kind === 'timeout' ? 'timeoutCleared' : 'intervalCleared']++;
  };
  const fire = (timer: Timer): void => {
    assert.ok(++callbacks <= 1000, 'bounded embed timer callbacks'); metrics.callbacks++;
    if (timer.kind === 'timeout') { timers.delete(timer.id); retired.set(timer.id, timer); }
    else timer.due = now + timer.ms;
    timer.callback();
  };
  const nextDue = (end: number): Timer | undefined => [...timers.values()]
    .filter(timer => timer.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0];
  const checkElapsed = (elapsed: number): void => {
    assert.ok(Number.isFinite(elapsed) && elapsed >= 0 && elapsed <= 10000, 'bounded fake timer advance');
  };
  const tick = (elapsed = 250): void => {
    checkElapsed(elapsed); const end = now + elapsed;
    for (let timer = nextDue(end); timer; timer = nextDue(end)) { now = Math.max(now, timer.due); fire(timer); }
    now = end;
  };
  const clock = {
    get now(): number { return now; },
    get timers(): Omit<Timer, 'callback'>[] { return [...timers.values()].map(({ callback: _callback, ...timer }) => timer); },
    get metrics(): typeof metrics { return { ...metrics }; },
    resetMetrics(): void { for (const key of Object.keys(metrics) as (keyof typeof metrics)[]) metrics[key] = 0; },
    elapse(elapsed: number): void { checkElapsed(elapsed); now += elapsed; },
    runDue(): void { tick(0); },
    fireRetired(id: number): void {
      assert.equal(timers.has(id), false, 'only retired callbacks may be delivered manually');
      const timer = retired.get(id); assert.ok(timer); assert.equal(timer.kind, 'timeout');
      assert.ok(++callbacks <= 1000); metrics.callbacks++; timer.callback();
    },
  };
  const library = {
    StageClient: class extends EmbedSdk { constructor(options: ClientOptions) { super(options, () => now); clients.push(this); } },
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
    URL, URLSearchParams, Error, Promise, performance: { now: () => now },
    loadLibrary: async (url: string) => { moduleUrls.push(url); if (options.libraryLoad) await options.libraryLoad; return library; },
    setInterval: (callback: () => void, ms: number) => schedule('interval', callback, ms),
    clearInterval: (id: number) => clear('interval', id),
    setTimeout: (callback: () => void, ms: number) => schedule('timeout', callback, ms),
    clearTimeout: (id: number) => clear('timeout', id),
  }, { filename: 'web/src/embed.ts', timeout: 1000 });
  return {
    hand, leave, form, submit, status, clients, moduleUrls, node, tick, clock,
    async join(overrides: Partial<Me> = {}): Promise<EmbedSdk> {
      const count = clients.length; form.submit(); assert.equal(submit.disabled, true); await flush();
      assert.equal(clients.length, count + 1); const sdk = clients.at(-1)!;
      assert.equal(sdk.joins.length, 1); sdk.snapshot(overrides); assert.equal(submit.disabled, false); return sdk;
    },
    async cleanup(): Promise<void> {
      for (const sdk of clients) for (const action of sdk.actions) if (!action.work.settled) action.work.resolve();
      await flush(); timers.clear(); retired.clear();
      assert.ok(clients.every(sdk => sdk.actions.every(action => action.work.settled)), 'all command promises must settle');
      assert.equal(timers.size, 0);
    },
  };
}
