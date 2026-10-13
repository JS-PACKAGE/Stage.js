import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';

type Status = 'waiting' | 'live' | 'reconnecting' | 'disconnected';
interface Me { participantId: string; name: string; onStage: boolean; handRaised: boolean }
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
export class EmbedSdk {
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
const source = readFileSync(new URL('../../web/src/embed.ts', import.meta.url), 'utf8');
export const flush = async (): Promise<void> => { for (let i = 0; i < 16; i++) await Promise.resolve(); };

export function embedApp(options: { libraryLoad?: Promise<void> } = {}) {
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
    loadLibrary: async (url: string) => { moduleUrls.push(url); if (options.libraryLoad) await options.libraryLoad; return library; },
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
