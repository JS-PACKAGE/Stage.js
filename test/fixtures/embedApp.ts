import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import type { ParticipantView } from '../../shared/protocol.ts';

type Status = 'waiting' | 'live' | 'reconnecting' | 'disconnected';
type Me = Pick<ParticipantView, 'participantId' | 'name' | 'role' | 'onStage' | 'handRaised' | 'muted' | 'forceMuted'>;
interface State { roomId: string; name: string; me: Me; hands: ParticipantView[] }
interface JoinOptions { roomId: string; code?: string; name: string }
interface ClientOptions { url: string; audioElement: EmbedNode }
type Action = 'raise' | 'withdraw' | 'mute' | 'unmute' | 'leaveStage' | 'returnToStage';

export class Deferred {
  private readonly work = Promise.withResolvers<void>();
  readonly promise = this.work.promise;
  settled = false;
  resolve(): void { assert.equal(this.settled, false); this.settled = true; this.work.resolve(); }
  reject(message: string): void { assert.equal(this.settled, false); this.settled = true; this.work.reject(new Error(message)); }
}
export interface EmbedDevices { inputs: { kind: string; deviceId: string; label: string }[]; outputs: { kind: string; deviceId: string; label: string }[] }
export class DeviceDeferred {
  private readonly work = Promise.withResolvers<EmbedDevices>();
  readonly promise = this.work.promise;
  settled = false;
  resolve(value: EmbedDevices = { inputs: [], outputs: [] }): void { assert.equal(this.settled, false); this.settled = true; this.work.resolve(value); }
  reject(message: string): void { assert.equal(this.settled, false); this.settled = true; this.work.reject(new Error(message)); }
}
export class EmbedNode {
  private disabledValue = false;
  private textValue = '';
  value = '';
  hidden = false;
  open = false;
  type = '';
  className = '';
  parentElement: EmbedNode | null = null;
  readonly tagName: string;
  constructor(tag = 'div') { this.tagName = tag.toUpperCase(); }
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
  readonly children: EmbedNode[] = [];
  onchange: (() => void) | null = null;
  append(...nodes: EmbedNode[]): void {
    for (const node of nodes) { node.remove(); node.parentElement = this; this.children.push(node); }
  }
  remove(): void {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children, index = siblings.indexOf(this);
    assert.ok(index >= 0); siblings.splice(index, 1); this.parentElement = null;
  }
  contains(node: EmbedNode): boolean { return this === node || this.children.some(child => child.contains(node)); }
  replaceChildren(...nodes: EmbedNode[]): void { for (const child of [...this.children]) child.remove(); this.append(...nodes); }
  change(value: string): void { if (!this.disabled) { this.value = value; this.invokeChange(); } }
  invokeChange(): void { assert.ok(this.onchange); this.onchange(); }
  onclick: (() => void) | null = null;
  onsubmit: ((event: { preventDefault(): void }) => void) | null = null;
  submitButton: EmbedNode | null = null;
  setAttribute(key: string, value: string): void {
    this.writes.attributes++; if (value === this.attributes[key]) this.writes.unchanged++;
    this.attributes[key] = value;
  }
  getAttribute(key: string): string | null { return this.attributes[key] ?? null; }
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
  state: State | null = null;
  private cooldownUntil = 0;
  private readonly now: () => number;
  get handCooldownMs(): number { return Math.max(0, this.cooldownUntil - this.now()); }
  set handCooldownMs(value: number) { this.cooldownUntil = this.now() + value; }
  readonly options: ClientOptions;
  readonly joins: JoinOptions[] = [];
  readonly deviceLists: DeviceDeferred[] = [];
  listAudioDevices(): Promise<EmbedDevices> { const work = new DeviceDeferred(); this.deviceLists.push(work); return work.promise; }
  readonly inputSelections: { deviceId: string; work: Deferred }[] = [];
  setInputDevice(deviceId: string): Promise<void> { const work = new Deferred(); this.inputSelections.push({ deviceId, work }); return work.promise; }
  retryCalls = 0;
  retryAdmission: () => boolean = () => true;
  retryMicrophone(): boolean { this.retryCalls++; return this.retryAdmission(); }
  readonly actions: { type: Action; work: Deferred }[] = [];
  readonly renames: { name: string; work: Deferred }[] = [];
  setName(name: string): Promise<void> { const work = new Deferred(); this.renames.push({ name, work }); return work.promise; }
  readonly moderations: { kind: 'approve' | 'reject'; id: string; work: Deferred }[] = [];
  approve(id: string): Promise<void> { const work = new Deferred(); this.moderations.push({ kind: 'approve', id, work }); return work.promise; }
  reject(id: string): Promise<void> { const work = new Deferred(); this.moderations.push({ kind: 'reject', id, work }); return work.promise; }
  readonly roomRenames: { name: string; work: Deferred }[] = [];
  setRoomName(name: string): Promise<void> { const work = new Deferred(); this.roomRenames.push({ name, work }); return work.promise; }
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
    this.me = { participantId: 'listener', name: '測試聽眾', role: 'audience', onStage: false, handRaised: false, muted: false, forceMuted: false, ...this.me, ...overrides };
    this.state = { roomId: 'same-room', name: '測試舞台', me: this.me, hands: [] };
    this.emit('state', this.state);
  }
  async connect(): Promise<void> { this.setStatus('waiting'); }
  async join(options: JoinOptions): Promise<void> { this.joins.push(options); }
  async disconnect(): Promise<void> {
    // Keep command promises deferred so tests can deliver adversarial late settlements explicitly.
    this.me = null; this.state = null; this.handCooldownMs = 0; this.setStatus('disconnected');
  }
  async unlockAudio(): Promise<void> {}
  private request(type: Action): Promise<void> {
    const work = new Deferred(); this.actions.push({ type, work }); return work.promise;
  }
  raiseHand(): Promise<void> { this.handCooldownMs = 1500; return this.request('raise'); }
  withdrawHand(): Promise<void> { return this.request('withdraw'); }
  mute(): Promise<void> { return this.request('mute'); }
  unmute(): Promise<void> { return this.request('unmute'); }
  leaveStage(): Promise<void> { return this.request('leaveStage'); }
  returnToStage(): Promise<void> { return this.request('returnToStage'); }
}
export const flush = async (): Promise<void> => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

export function embedApp(options: { libraryLoad?: Promise<void> | ((url: string, attempt: number) => Promise<void>); source?: string; search?: string } = {}) {
  const nodes = new Map(['host', 'ws-path', 'room', 'code', 'name', 'status', 'hand-rejected', 'error-notice', 'last-error', 'error-dismiss', 'join', 'hand', 'mic', 'rename', 'room-name-panel', 'room-name-current', 'room-name-draft', 'room-name-update', 'hand-queue', 'hand-queue-summary', 'hand-queue-notice', 'hand-queue-list', 'stage', 'mic-retry', 'audio-retry', 'audio-retry-status', 'microphone-panel', 'microphone-device', 'microphone-refresh', 'microphone-apply', 'microphone-draft-notice', 'output-panel', 'output-device', 'output-refresh', 'output-apply', 'output-draft-notice', 'output-support', 'cancel-join', 'leave', 'audio', 'unlock'].map(id => [id, new EmbedNode()]));
  const node = (id: string): EmbedNode => { const found = nodes.get(id); assert.ok(found, `unmodeled node: ${id}`); return found; };
  node('error-notice').hidden = true; node('hand-rejected').hidden = true;
  const cancel = node('cancel-join'); cancel.hidden = cancel.disabled = true; cancel.textContent = '取消連線';
  const hand = node('hand'), mic = node('mic'), stage = node('stage'), micRetry = node('mic-retry'), leave = node('leave'), form = node('join'), status = node('status');
  hand.disabled = leave.disabled = true; hand.textContent = '舉手發言'; status.textContent = '尚未加入';
  mic.hidden = mic.disabled = true; mic.textContent = '靜音麥克風';
  mic.setAttribute('aria-label', '麥克風靜音'); mic.setAttribute('aria-pressed', 'false'); mic.setAttribute('aria-busy', 'false');
  stage.hidden = stage.disabled = true; stage.textContent = '離開舞台'; stage.setAttribute('aria-busy', 'false');
  micRetry.hidden = micRetry.disabled = true; micRetry.textContent = '重試麥克風'; micRetry.setAttribute('aria-busy', 'false');
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
  const source = options.source ?? readFileSync(new URL('../../web/src/embed.ts', import.meta.url), 'utf8');
  const dynamicImport = 'import(/* @vite-ignore */ moduleUrl)';
  assert.equal(source.split(dynamicImport).length, 2, 'the external library import seam must stay exact and unique');
  assert.equal(source.split("import './styles.css';").length, 2, 'the stylesheet import seam must stay exact and unique');
  const executable = stripTypeScriptTypes(source.replace("import './styles.css';", '').replace(dynamicImport, 'loadLibrary(moduleUrl)'));
  assert.doesNotMatch(executable, /\bimport\s*(?:\(|['"])/, 'the fixture must never import a real external library');
  runInNewContext(executable, {
    document: { createElement(tag: string) { assert.ok(['option', 'li', 'span', 'div', 'button'].includes(tag), `unmodeled element: ${tag}`); return new EmbedNode(tag); }, querySelector(selector: string) { assert.match(selector, /^#[a-z-]+$/); return node(selector.slice(1)); } },
    location: { search: options.search ?? '?host=https%3A%2F%2Fstage.example.test%2Fprefix&room=%20same-room%20&code=%20TEST42%20', origin: 'https://embed.example.test' },
    URL, URLSearchParams, Error, Promise, performance: { now: () => now },
    loadLibrary: async (url: string) => {
      moduleUrls.push(url);
      if (typeof options.libraryLoad === 'function') await options.libraryLoad(url, moduleUrls.length);
      else if (options.libraryLoad) await options.libraryLoad;
      return library;
    },
    setInterval: (callback: () => void, ms: number) => schedule('interval', callback, ms),
    clearInterval: (id: number) => clear('interval', id),
    setTimeout: (callback: () => void, ms: number) => schedule('timeout', callback, ms),
    clearTimeout: (id: number) => clear('timeout', id),
  }, { filename: 'web/src/embed.ts', timeout: 1000 });
  return {
    hand, mic, stage, micRetry, leave, form, submit, status, clients, moduleUrls, node, tick, clock,
    async join(overrides: Partial<Me> = {}): Promise<EmbedSdk> {
      const count = clients.length; form.submit(); assert.equal(submit.disabled, true); await flush();
      assert.equal(clients.length, count + 1); const sdk = clients.at(-1)!;
      assert.equal(sdk.joins.length, 1); sdk.snapshot(overrides); assert.equal(submit.disabled, false); return sdk;
    },
    async cleanup(): Promise<void> {
      for (const sdk of clients) for (const action of [...sdk.actions, ...sdk.renames, ...sdk.roomRenames, ...sdk.inputSelections, ...sdk.moderations]) if (!action.work.settled) action.work.resolve();
      for (const sdk of clients) for (const work of sdk.deviceLists) if (!work.settled) work.resolve();
      await flush(); timers.clear(); retired.clear();
      assert.ok(clients.every(sdk => [...sdk.actions, ...sdk.renames, ...sdk.roomRenames, ...sdk.inputSelections, ...sdk.moderations].every(action => action.work.settled)), 'all command promises must settle');
      assert.equal(timers.size, 0);
    },
  };
}
