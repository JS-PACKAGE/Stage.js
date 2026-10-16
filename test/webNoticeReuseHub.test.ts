import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import type { TestContext } from 'node:test';
import type { ClientMessage, ParticipantView, RoomStatePayload, ServerMessage } from '../shared/protocol.ts';
import { parseClientMessage } from '../src/ws/validate.ts';
import { harness, testConfig } from './helpers.ts';
import { StagePeer } from './fixtures/embedSdkApp.ts';
import { Deferred, flushSample, sampleApp } from './fixtures/sampleApp.ts';
import type { SampleNode } from './fixtures/sampleApp.ts';

interface ActualClient {
  readonly state: RoomStatePayload | null;
  readonly me: ParticipantView | null;
  readonly status: string;
  setName(name: string): Promise<void>;
  disconnect(): Promise<void>;
  on(type: string, listener: (event: { detail: { code: string } }) => void): () => void;
}

// Instrument only node creation; all production event handlers and renderers execute unchanged.
const original = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
const anchor = "const app = document.querySelector<HTMLDivElement>('#app')!;";
assert.equal(original.split(anchor).length, 2);
const source = original.replace(anchor, `${anchor}
const countedCreation = document.createElement.bind(document);
(app as any).creations = 0;
document.createElement = ((tag: string) => { (app as any).creations++; return countedCreation(tag); }) as typeof document.createElement;`);

/** Whole sample and public SDK through the actual validator/Hub; DOM, socket, clock and native media are controlled. */
async function actualSample(t: TestContext) {
  const { StageClient } = await import(new URL('../packages/client/src/index.ts', import.meta.url).href);
  const config = testConfig(c => { c.rooms.qualityIntervalMs = 0; });
  const server = harness(config), host = await server.create();
  let serverWork = Promise.resolve();
  class Socket {
    static OPEN = 1;
    static instances: Socket[] = [];
    readyState = 1;
    readonly id = `notice-${Socket.instances.length}`;
    readonly sent: ClientMessage[] = [];
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    readonly session = { id: this.id, send: (message: ServerMessage) => this.deliver(message), close: () => this.close() };
    constructor() { Socket.instances.push(this); queueMicrotask(() => server.hub.attach(this.session)); }
    deliver(message: ServerMessage): void {
      if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(message) });
    }
    send(data: string): void {
      assert.equal(this.readyState, 1);
      const message = parseClientMessage(data, config.limits); this.sent.push(message);
      serverWork = serverWork.then(() => server.hub.handle(this.session, message));
    }
    close(code?: number): void {
      if (this.readyState === 3) return;
      this.readyState = 3; this.onclose?.();
      serverWork = serverWork.then(() => server.hub.detach(this.session, code === 1000));
    }
  }
  StagePeer.instances = [];
  const plays: Deferred<void>[] = [];
  const pending = () => plays.filter(work => work.status === 'pending');
  const audio = { srcObject: null as unknown, volume: 1, muted: false,
    play() { const work = new Deferred<void>(); plays.push(work); return work.promise; },
    pause() { for (const work of pending()) work.reject(new DOMException('Playback interrupted', 'AbortError')); } };
  let captures = 0;
  const globals = { window: new EventTarget(), WebSocket: Socket, RTCPeerConnection: StagePeer,
    navigator: { mediaDevices: { async enumerateDevices() { return []; },
      async getUserMedia(): Promise<never> { captures++; throw new DOMException('受控麥克風拒絕。', 'NotAllowedError'); } } } };
  const originals = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  let now = 0; t.mock.method(performance, 'now', () => now);
  const sdk: ActualClient = new StageClient({ url: 'wss://sample.test/ws', audioElement: audio });
  const errors: string[] = []; sdk.on('error', event => errors.push(event.detail.code));
  const h = sampleApp({ sdk, source });
  const notices = h.find(node => node.classList.contains('notices'));
  const main = h.find(node => node.tagName === 'main');
  const error = h.find(node => node.attributes.role === 'alert');
  const app = h.app as SampleNode & { creations: number };
  let replacements = 0, mainReplacements = 0, states = 0;
  const replace = notices.replaceChildren.bind(notices), replaceMain = main.replaceChildren.bind(main);
  notices.replaceChildren = (...nodes) => { replacements++; replace(...nodes); };
  main.replaceChildren = (...nodes) => { mainReplacements++; replaceMain(...nodes); };
  sdk.on('state', () => states++);
  async function flush(): Promise<void> { for (let i = 0; i < 80; i++) await Promise.resolve(); }
  async function tick(): Promise<void> { now += 25; t.mock.timers.tick(25); await flush(); }
  async function until(predicate: () => boolean, label: string): Promise<void> {
    for (let i = 0; i < 120 && !predicate(); i++) await tick(); assert.ok(predicate(), label);
  }
  async function request(work: Promise<void>): Promise<void> {
    let done = false; void work.then(() => { done = true; }, () => { done = true; });
    await until(() => done, 'SDK request settlement'); await work;
  }
  async function presence(): Promise<void> {
    for (const timer of server.timers) if (!timer.cleared && timer.ms === config.rooms.presenceBroadcastMs) {
      timer.cleared = true; timer.fn();
    }
    await flush();
  }
  async function join(onStage = false) {
    const title = onStage ? '建立房間' : '加入房間';
    const form = h.find(node => node.tagName === 'form' && node.children.some(child => child.tagName === 'h2' && child.textContent === title));
    const values = onStage ? { name: 'Listener', roomName: 'Fixture' } : { roomId: host.roomId, code: host.code, name: 'Listener' };
    for (const [name, value] of Object.entries(values)) {
      const input = form.descendants().find(node => node.name === name); assert.ok(input); input.value = value;
    }
    form.submit();
    await until(() => sdk.state !== null && StagePeer.instances.at(-1)?.localDescription !== null, 'room entry and offer');
    await until(() => StagePeer.instances.at(-1)?.signalingState === 'stable', 'initial negotiation');
    await serverWork; await presence(); await flush();
    return { socket: Socket.instances.at(-1)!, peer: StagePeer.instances.at(-1)!, id: sdk.me!.participantId, roomId: sdk.state!.roomId };
  }
  async function block(peer: StagePeer): Promise<void> {
    assert.ok(peer.ontrack); peer.ontrack({ streams: [{ getTracks: () => [], getAudioTracks: () => [] }] });
    for (const work of pending()) work.reject(new DOMException('User activation required', 'NotAllowedError'));
    await flush(); assert.match(notices.textContent, /自動播放遭阻擋/);
  }
  t.after(async () => {
    try {
      await h.cleanup(); await flush(); await serverWork; await server.hub.shutdown(); await server.transport.close();
      assert.equal(pending().length, 0); assert.equal(sdk.state, null); assert.equal(sdk.status, 'disconnected');
      assert.ok(Socket.instances.every(socket => socket.readyState === 3));
      assert.ok(StagePeer.instances.every(peer => peer.connectionState === 'closed')); assert.equal(h.clock.jobs.size, 0);
    } finally {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
      }
    }
  });
  return { ...h, notices, main, error, server, host, sdk, plays, pending, errors, join, block, request, until,
    sockets: Socket.instances, peers: StagePeer.instances, captures: () => captures,
    reset() { app.creations = replacements = mainReplacements = states = 0; },
    counts: () => ({ created: app.creations, replacements, mainReplacements, states }) };
}

for (const workload of ['empty', 'autoplay', 'autoplay-and-microphone'] as const) {
  it(`whole sample notice reuse: 100 public SDK same-name requests through validator/Hub with ${workload}`, async t => {
    const h = await actualSample(t), joined = await h.join(workload === 'autoplay-and-microphone');
    if (workload === 'autoplay-and-microphone') {
      await h.until(() => h.captures() === 1 && h.notices.textContent.includes('NotAllowedError'), 'microphone rejection');
    }
    if (workload !== 'empty') await h.block(joined.peer);
    const buttons = h.notices.descendants().filter(node => node.tagName === 'button');
    const children = [...h.notices.children], mainChildren = [...h.main.children], text = h.notices.textContent;
    h.reset();
    for (let index = 0; index < 100; index++) await h.request(h.sdk.setName('Listener'));
    assert.deepEqual(h.counts(), { created: 0, replacements: 0, mainReplacements: 0, states: 100 });
    assert.equal(h.notices.textContent, text); assert.deepEqual(h.notices.children, children); assert.deepEqual(h.main.children, mainChildren);
    assert.ok(buttons.every(button => button.isConnected)); assert.equal(h.notices.attributes['aria-live'], 'polite');
    assert.equal(h.sockets.length, 1); assert.equal(h.peers.length, 1);
    assert.equal(h.plays.length, workload === 'empty' ? 0 : 1); assert.equal(h.captures(), workload === 'autoplay-and-microphone' ? 1 : 0);
    assert.equal(h.server.hub.isJoined(joined.socket.session), true);
    assert.equal(h.server.transport.rooms.get(joined.roomId)!.subscribers.has(joined.id), true);
    assert.equal(joined.socket.sent.filter(message => message.type === 'participant:rename').length, 100);
    assert.deepEqual(h.errors, []);
    t.diagnostic(JSON.stringify({ workload, commands: 100, ...h.counts(), retainedButtons: buttons.length }));
    if (workload !== 'empty') {
      const unlock = h.button('點擊啟用音訊'); unlock.onclick!(); assert.equal(h.plays.length, 2);
      h.pending()[0]!.resolve(undefined); await flushSample();
      assert.equal(unlock.isConnected, false); assert.doesNotMatch(h.notices.textContent, /自動播放遭阻擋/);
      unlock.onclick!(); assert.equal(h.plays.length, 2);
    }
  });
}

it('whole sample notice reuse: actual SDK pending playback stays single across 100 Hub ACK snapshots and retries after failure', async t => {
  const h = await actualSample(t), joined = await h.join(); await h.block(joined.peer);
  const first = h.button('點擊啟用音訊'); first.click(); assert.equal(h.plays.length, 2);
  h.reset(); for (let index = 0; index < 100; index++) await h.request(h.sdk.setName('Listener'));
  assert.deepEqual(h.counts(), { created: 3, replacements: 1, mainReplacements: 0, states: 100 });
  const pending = h.button('點擊啟用音訊');
  assert.equal(first.isConnected, false); assert.equal(pending.disabled, true); assert.equal(pending.attributes['aria-busy'], 'true');
  first.onclick!(); pending.onclick!(); pending.click(); assert.equal(h.plays.length, 2);
  h.pending()[0]!.reject(new Error('current playback failure')); await flushSample();
  assert.equal(h.error.textContent, 'current playback failure'); assert.equal(pending.isConnected, false);
  const retry = h.button('點擊啟用音訊'); assert.equal(retry.disabled, false); assert.equal(retry.attributes['aria-busy'], 'false');
  pending.onclick!(); first.onclick!(); assert.equal(h.plays.length, 2); assert.equal(h.error.hidden, false);
  retry.click(); assert.equal(h.plays.length, 3); h.pending()[0]!.resolve(undefined); await flushSample();
  assert.equal(h.notices.textContent, ''); assert.deepEqual(h.errors, []);
});
