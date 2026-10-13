import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { MAX_GAIN_DB } from '../../shared/protocol.ts';
import type { ParticipantView, RoomStatePayload } from '../../shared/protocol.ts';

/** Bounded DOM fixture; browser/CSS/permission behavior is not modeled. */
export class SampleNode {
  readonly children: SampleNode[] = [];
  parentNode: SampleNode | null = null;
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  id = ''; className = ''; name = ''; type = ''; title = '';
  value: string | number = ''; min: string | number = ''; max: string | number = ''; step = '';
  hidden = false; disabled = false; checked = false; required = false; readOnly = false; maxLength = 0;
  readonly htmlFor = { value: '' };
  onclick: (() => void) | null = null;
  onchange: (() => void) | null = null;
  oninput: (() => void) | null = null;
  onsubmit: ((event: { preventDefault(): void }) => void) | null = null;
  private text = '';
  readonly tagName: string;
  constructor(tagName: string) { this.tagName = tagName; }
  get options(): SampleNode[] { return this.children.filter(child => child.tagName === 'option'); }
  get isConnected(): boolean { return this.tagName === '#document' || (this.parentNode?.isConnected ?? false); }
  get textContent(): string { return this.text + this.children.map(child => child.textContent).join(''); }
  set textContent(value: string) { this.replaceChildren(); this.text = value; }
  append(...nodes: SampleNode[]): void {
    for (const node of nodes) {
      assert.notEqual(node, this, 'a node cannot contain itself');
      node.remove(); node.parentNode = this; this.children.push(node);
    }
  }
  replaceChildren(...nodes: SampleNode[]): void {
    for (const child of this.children) child.parentNode = null;
    this.children.length = 0; this.text = ''; this.append(...nodes);
  }
  remove(): void {
    if (!this.parentNode) return;
    const siblings = this.parentNode.children;
    siblings.splice(siblings.indexOf(this), 1); this.parentNode = null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    if (name === 'id') this.id = value;
    if (name === 'class') this.className = value;
    if (name.startsWith('data-')) this.dataset[name.slice(5).replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase())] = value;
  }
  readonly classList = {
    contains: (name: string): boolean => this.className.split(/\s+/).includes(name),
    toggle: (name: string, force?: boolean): boolean => {
      const names = new Set(this.className.split(/\s+/).filter(Boolean));
      const enabled = force ?? !names.has(name);
      if (enabled) names.add(name); else names.delete(name);
      this.className = [...names].join(' '); return enabled;
    },
  };
  descendants(): SampleNode[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  querySelector(selector: string): SampleNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  querySelectorAll(selector: string): SampleNode[] {
    // Fail closed if the sample starts depending on selector semantics this fixture does not model.
    const predicates: Record<string, (node: SampleNode) => boolean> = {
      '#app': node => node.id === 'app',
      '[data-landing-submit]': node => node.dataset.landingSubmit !== undefined,
      '[data-landing-cancel]': node => node.dataset.landingCancel !== undefined,
      '[data-room-action]': node => node.dataset.roomAction !== undefined,
      '[data-return-stage]': node => node.dataset.returnStage !== undefined,
      '.badge.quality': node => node.classList.contains('badge') && node.classList.contains('quality'),
      '.identity': node => node.classList.contains('identity'),
      '.invite-link': node => node.classList.contains('invite-link'),
      '.person[data-participant-id]': node => node.classList.contains('person') && node.dataset.participantId !== undefined,
    };
    const matches = predicates[selector]; assert.ok(matches, `unmodeled selector: ${selector}`);
    return this.descendants().filter(matches);
  }
  click(): void { if (!this.disabled) { assert.ok(this.onclick, 'missing click handler'); this.onclick(); } }
  submit(): void {
    assert.equal(this.tagName, 'form'); assert.ok(this.onsubmit, 'missing submit handler');
    let prevented = false; this.onsubmit({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true, 'the sample must prevent native form navigation');
  }
}

interface ClockJob { id: number; kind: 'timeout' | 'interval'; delay: number; due: number; callback(): void }
export class SampleClock {
  now = 0;
  readonly jobs = new Map<number, ClockJob>();
  readonly fired: number[] = [];
  private nextId = 0;
  private add(kind: ClockJob['kind'], callback: () => void, delay: number): number {
    assert.ok(Number.isFinite(delay) && delay > 0, 'only positive finite timers are modeled');
    const id = ++this.nextId; this.jobs.set(id, { id, kind, delay, due: this.now + delay, callback }); return id;
  }
  readonly setTimeout = (callback: () => void, delay: number): number => this.add('timeout', callback, delay);
  readonly setInterval = (callback: () => void, delay: number): number => this.add('interval', callback, delay);
  readonly clear = (id: number | undefined): void => { if (id !== undefined) this.jobs.delete(id); };
  intervals(delay: number): number[] { return [...this.jobs.values()].filter(job => job.kind === 'interval' && job.delay === delay).map(job => job.id); }
  timeouts(): number[] { return [...this.jobs.values()].filter(job => job.kind === 'timeout').map(job => job.id); }
  advance(ms: number): void {
    assert.ok(Number.isFinite(ms) && ms >= 0);
    const end = this.now + ms; let callbacks = 0;
    while (true) {
      const next = [...this.jobs.values()].filter(job => job.due <= end).sort((a, b) => a.due - b.due || a.id - b.id)[0];
      if (!next) break;
      assert.ok(++callbacks <= 1000, 'bounded fake-clock callback budget exceeded');
      this.now = next.due;
      if (next.kind === 'timeout') this.jobs.delete(next.id); else next.due += next.delay;
      this.fired.push(next.id); next.callback();
    }
    this.now = end;
  }
}

export class Deferred<T> {
  private readonly work = Promise.withResolvers<T>();
  readonly promise = this.work.promise;
  status: 'pending' | 'fulfilled' | 'rejected' = 'pending';
  resolve(value: T): void { assert.equal(this.status, 'pending'); this.status = 'fulfilled'; this.work.resolve(value); }
  reject(error: Error): void { assert.equal(this.status, 'pending'); this.status = 'rejected'; this.work.reject(error); }
}
export class SamplePreview {
  stopCalls = 0; stops = 0; reads = 0; stopped = false;
  value: number;
  onStopped: (() => void) | undefined;
  constructor(value: number) { this.value = value; }
  level(): number { this.reads++; return this.stopped ? 0 : this.value; }
  stop(): void {
    this.stopCalls++;
    if (this.stopped) return;
    this.stopped = true; this.stops++; this.onStopped?.();
  }
}
interface Stats { inbound: { rtt?: number; lossPercent?: number; bufferMs?: number } | null; outbound: null }
type Status = 'waiting' | 'live' | 'reconnecting' | 'disconnected';
interface Events {
  state: RoomStatePayload; status: Status; micready: undefined;
  created: { roomId: string; code?: string }; closed: { roomId: string; reason?: 'shutdown' }; kicked: { roomId: string };
  invite: { participantId: string }; stageleft: { participantId: string; reason?: string };
  micerror: { message: string; name: string }; audioblocked: unknown; error: { message: string };
  speaking: { participantIds: string[] };
  quality: { participants: { participantId: string; uplinkLossPercent?: number; downlinkLossPercent?: number; rttMs?: number }[] };
}
interface JoinOptions { roomId: string; code?: string; name: string }
export interface SampleAudioDevices {
  inputs: { deviceId: string; label: string }[];
  outputs: { deviceId: string; label: string }[];
}

export class SampleSdk {
  state: RoomStatePayload | null = null;
  status: Status = 'disconnected';
  speaking = new Set<string>();
  readonly outputDeviceSupported = true;
  playbackVolume = 1; playbackMuted = false;
  micLevelValue = 0; micLevelReads = 0;
  handCooldownDurationMs = 1500;
  private cooldownUntil = 0;
  readonly joins: { options: JoinOptions; work: Deferred<void> }[] = [];
  readonly previews: Deferred<SamplePreview>[] = [];
  readonly previewSignals: (AbortSignal | undefined)[] = [];
  readonly polls: Deferred<Stats>[] = [];
  readonly raises: Deferred<void>[] = [];
  readonly deviceLists: Deferred<SampleAudioDevices>[] = [];
  readonly inputDevices: string[] = [];
  readonly outputDevices: string[] = [];
  readonly events: (keyof Events)[] = [];
  readonly activePreviews = new Set<SamplePreview>();
  private readonly listeners = new Map<keyof Events, ((event: { detail: unknown }) => void)[]>();
  readonly clock: SampleClock;
  private readonly deferAudioDevices: boolean;
  constructor(clock: SampleClock, deferAudioDevices = false) { this.clock = clock; this.deferAudioDevices = deferAudioDevices; }
  get me(): ParticipantView | null { return this.state?.me ?? null; }
  get micLevel(): number { this.micLevelReads++; return this.micLevelValue; }
  get handCooldownMs(): number { return Math.max(0, this.cooldownUntil - this.clock.now); }
  set handCooldownMs(value: number) { this.cooldownUntil = this.clock.now + value; }
  on<K extends keyof Events>(type: K, listener: (event: { detail: Events[K] }) => void): () => void {
    const listeners = this.listeners.get(type) ?? [];
    const callback = listener as (event: { detail: unknown }) => void;
    listeners.push(callback); this.listeners.set(type, listeners);
    return () => { const index = listeners.indexOf(callback); if (index >= 0) listeners.splice(index, 1); };
  }
  emit<K extends keyof Events>(type: K, detail: Events[K]): void {
    this.events.push(type);
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener({ detail });
  }
  setStatus(status: Status): void { if (this.status !== status) { this.status = status; this.emit('status', status); } }
  snapshot(state: RoomStatePayload): void {
    if (this.me?.participantId !== state.me.participantId) this.cooldownUntil = 0;
    this.state = state; this.setStatus(state.status);
    if (this.state === state) this.emit('state', state);
  }
  join(options: JoinOptions): Promise<void> {
    const work = new Deferred<void>(); this.joins.push({ options, work }); return work.promise;
  }
  acceptJoin(state: RoomStatePayload): void {
    const join = this.joins.at(-1); assert.ok(join); assert.equal(join.work.status, 'pending');
    this.snapshot(state); join.work.resolve(undefined);
  }
  async listAudioDevices(): Promise<SampleAudioDevices> {
    if (this.deferAudioDevices) {
      const work = new Deferred<SampleAudioDevices>(); this.deviceLists.push(work); return work.promise;
    }
    return { inputs: [{ deviceId: 'mic-a', label: '測試麥克風' }], outputs: [{ deviceId: 'speaker-a', label: '測試揚聲器' }] };
  }
  async setInputDevice(id: string): Promise<void> { this.inputDevices.push(id); }
  async setOutputDevice(id: string): Promise<void> { this.outputDevices.push(id); }
  setPlaybackVolume(value: number): void { assert.ok(value >= 0 && value <= 1); this.playbackVolume = value; }
  setPlaybackMuted(value: boolean): void { this.playbackMuted = value; }
  startMicTest(options: { signal?: AbortSignal } = {}): Promise<SamplePreview> {
    const signal = options.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const work = new Deferred<SamplePreview>(); this.previews.push(work); this.previewSignals.push(signal);
    const abort = () => { if (work.status === 'pending') work.reject(signal!.reason as Error); };
    signal?.addEventListener('abort', abort, { once: true });
    const settled = () => signal?.removeEventListener('abort', abort);
    void work.promise.then(settled, settled);
    return work.promise;
  }
  grantPreview(work: Deferred<SamplePreview>, preview: SamplePreview): void {
    assert.equal(work.status, 'pending', 'a canceled capture cannot later fulfill');
    this.activePreviews.add(preview); preview.onStopped = () => { this.activePreviews.delete(preview); };
    this.emit('micready', undefined); work.resolve(preview);
  }
  getStats(): Promise<Stats> { const work = new Deferred<Stats>(); this.polls.push(work); return work.promise; }
  raiseHand(): Promise<void> {
    assert.ok(this.state); assert.equal(this.handCooldownMs, 0);
    this.cooldownUntil = this.clock.now + this.handCooldownDurationMs;
    const work = new Deferred<void>(); this.raises.push(work); return work.promise;
  }
  async disconnect(): Promise<void> {
    for (const work of this.previews) if (work.status === 'pending') work.reject(new Error('麥克風測試已取消。'));
    for (const preview of this.activePreviews) preview.stop();
    for (const work of this.raises) if (work.status === 'pending') work.reject(new Error('連線已中斷。'));
    this.state = null; this.cooldownUntil = 0; this.speaking = new Set(); this.setStatus('disconnected');
  }
  async terminal(kind: 'closed' | 'kicked', reason?: 'shutdown'): Promise<void> {
    const roomId = this.state?.roomId; assert.ok(roomId);
    // Mirror SDK receive(): disconnect clears the snapshot and emits status before the terminal event.
    await this.disconnect();
    if (kind === 'closed') this.emit('closed', reason ? { roomId, reason } : { roomId });
    else this.emit('kicked', { roomId });
  }
  assertSettled(): void {
    const work = [...this.joins.map(join => join.work), ...this.previews, ...this.polls, ...this.raises, ...this.deviceLists];
    assert.equal(work.filter(item => item.status === 'pending').length, 0, 'all deferred work must settle');
    assert.equal(this.activePreviews.size, 0, 'all granted previews must stop');
  }
}

export function roomState(me: Partial<ParticipantView> = {}): RoomStatePayload {
  const person: ParticipantView = { participantId: 'same-person', name: '測試聽眾', role: 'audience', onStage: false,
    handRaised: false, muted: false, forceMuted: false, gainDb: 0, connected: true, joinedAt: 1, ...me };
  return { roomId: 'same-room', name: '測試舞台', controllerId: 'controller', speakers: person.onStage ? [person] : [],
    hands: person.handRaised ? [person] : [], audienceCount: person.onStage ? 0 : 1, codeRequired: false,
    limits: { maxSpeakers: 8, maxAudience: 300 }, status: person.onStage ? 'live' : 'waiting', me: person };
}
export async function flushSample(): Promise<void> { for (let i = 0; i < 16; i++) await Promise.resolve(); }

interface SampleAppOptions {
  source?: string;
  location?: URL;
  expectedSdkUrl?: string;
  decodeName?: (value: string) => string;
  deferAudioDevices?: boolean;
  clipboard?: { writeText(text: string): Promise<void> };
  confirm?: (message: string) => boolean;
  localStorage?: { getItem(key: string): string | null; setItem(key: string, value: string): void };
}
type SampleClient = { disconnect(): Promise<void> };
export function sampleApp<Client extends SampleClient>(options: SampleAppOptions & { sdk: Client }): ReturnType<typeof mountSampleApp<Client>>;
export function sampleApp(options?: SampleAppOptions): ReturnType<typeof mountSampleApp<SampleSdk>>;
export function sampleApp(options: SampleAppOptions & { sdk?: SampleClient } = {}) { return mountSampleApp(options); }

function mountSampleApp<Client extends SampleClient = SampleSdk>(options: SampleAppOptions & { sdk?: Client }) {
  const clock = new SampleClock();
  const sdk = (options.sdk ?? new SampleSdk(clock, options.deferAudioDevices)) as Client;
  const documentRoot = new SampleNode('#document'), documentElement = new SampleNode('html'), body = new SampleNode('body');
  const app = new SampleNode('div'); app.id = 'app';
  documentRoot.append(documentElement); documentElement.append(body); body.append(app);
  const document = { documentElement, createElement: (tag: string) => new SampleNode(tag),
    createTextNode(text: string) { const node = new SampleNode('#text'); node.textContent = text; return node; },
    querySelector: (selector: string) => documentRoot.querySelector(selector) };
  const source = options.source ?? readFileSync(new URL('../../web/src/main.ts', import.meta.url), 'utf8');
  const imports = [
    "import { MAX_GAIN_DB, StageClient, decodeName } from '../../packages/client/src/index.ts';",
    "import type { ConnectionQuality, MicTest, ParticipantView, RoomStatePayload } from '../../packages/client/src/index.ts';",
    "import './styles.css';",
  ];
  const lines = source.split('\n'); assert.deepEqual(lines.slice(0, 3), imports, 'review the fixture when sample imports change');
  const executable = stripTypeScriptTypes(lines.slice(3).join('\n'));
  assert.doesNotMatch(executable, /^\s*import\b/m);
  const storage = new Map<string, string>();
  const deviceChangeListeners: (() => void)[] = [];
  let constructions = 0;
  runInNewContext(`'use strict';\n${executable}`, {
    document, location: options.location ?? { protocol: 'https:', host: 'sample.test', search: '', pathname: '/', origin: 'https://sample.test' },
    localStorage: options.localStorage ?? { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
    navigator: { clipboard: options.clipboard, mediaDevices: { addEventListener(type: string, listener: () => void) {
      assert.equal(type, 'devicechange'); deviceChangeListeners.push(listener);
    } } },
    window: { confirm: options.confirm ?? (() => { throw new Error('Unexpected confirmation dialog in lifecycle test'); }) },
    StageClient: function (clientOptions: { url: string }) {
      constructions++; assert.equal(clientOptions.url, options.expectedSdkUrl ?? 'wss://sample.test/ws'); return sdk;
    },
    decodeName: options.decodeName ?? ((value: string) => value), MAX_GAIN_DB, URL, URLSearchParams, Error, AbortController,
    performance: { now: () => clock.now },
    setTimeout: clock.setTimeout, clearTimeout: clock.clear, setInterval: clock.setInterval, clearInterval: clock.clear,
  }, { timeout: 1000, filename: 'web/src/main.ts', contextCodeGeneration: { strings: false, wasm: false } });
  assert.equal(constructions, 1);
  const find = (predicate: (node: SampleNode) => boolean): SampleNode => {
    const matches = app.descendants().filter(predicate); assert.equal(matches.length, 1, 'expected one connected matching DOM node'); return matches[0]!;
  };
  return {
    app, sdk, clock, find, deviceChangeListeners,
    dispatchDeviceChange() { for (const listener of [...deviceChangeListeners]) listener(); },
    id: (id: string) => find(node => node.id === id),
    button: (text: string) => find(node => node.tagName === 'button' && node.textContent === text),
    async cleanup() {
      await sdk.disconnect();
      if (sdk instanceof SampleSdk) {
        for (const work of [...sdk.joins.map(join => join.work), ...sdk.polls, ...sdk.deviceLists]) if (work.status === 'pending') work.reject(new Error('fixture cleanup'));
      }
      await flushSample(); clock.jobs.clear();
      if (sdk instanceof SampleSdk) sdk.assertSettled();
    },
  };
}
