import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, type TestContext } from 'node:test';
import { StageClient, type StageClientOptions } from '../src/index.ts';

interface Request { type: string; requestId?: string }
class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  sent: Request[] = [];
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(_url: string) { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as Request); }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  close() { this.readyState = 3; this.onclose?.(); }
}

const MAX_DELAY = 2147483647;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const hello = (socket: Socket) => socket.deliver({ type: 'hello', instance: 'test-instance', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 } });
const invalidValues: unknown[] = [NaN, Infinity, -Infinity, -1, -Number.MIN_VALUE, MAX_DELAY + 1, Number.MAX_VALUE, '500', null, undefined, true, false, {}, [], 1n, Symbol('delay')];

describe('client reconnect options', () => {
  const clients: StageClient[] = [];
  let originals: Map<string, PropertyDescriptor | undefined>;
  let createdAudio: number;
  let appendedAudio: number;
  beforeEach(t => {
    assert.ok('mock' in t);
    Socket.instances = []; createdAudio = appendedAudio = 0;
    originals = new Map(['window', 'WebSocket', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
      createElement() { createdAudio++; return { autoplay: false, hidden: false, pause() {}, remove() {} }; },
      body: { append() { appendedAudio++; } },
    } });
    t.mock.method(performance, 'now', () => 1000);
    t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  });
  afterEach(async () => {
    for (const client of clients.splice(0)) await client.disconnect();
    await flush();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
  function make(options: Partial<StageClientOptions> = {}): StageClient {
    const client = new StageClient({ url: 'ws://localhost/ws', audioElement: { pause() {} } as unknown as HTMLAudioElement, ...options });
    clients.push(client); return client;
  }
  async function joined(t: TestContext, client: StageClient): Promise<Socket> {
    const pending = client.join({ roomId: 'room', name: 'guest' });
    pending.catch(() => {});
    const socket = Socket.instances.at(-1)!;
    hello(socket); await flush(); t.mock.timers.tick(0);
    const request = socket.sent.at(-1)!;
    assert.equal(request.type, 'join');
    socket.deliver({ type: 'ok', requestId: request.requestId });
    await pending; return socket;
  }
  async function assertRetryDelays(t: TestContext, client: StageClient, expected: readonly number[], beforeClose?: () => void): Promise<void> {
    const old = await joined(t, client);
    const scheduled = t.mock.method(globalThis, 'setTimeout');
    beforeClose?.(); old.close();
    for (const delay of expected) {
      assert.equal(scheduled.mock.calls.at(-1)!.arguments[1], delay);
      const count = Socket.instances.length;
      if (delay >= 1) {
        t.mock.timers.tick(delay - 1);
        assert.equal(Socket.instances.length, count, 'the retry must wait for its delay');
        t.mock.timers.tick(1);
      } else t.mock.timers.tick(delay);
      assert.equal(Socket.instances.length, count + 1);
      // Fail before hello so each explicitly advanced retry is bounded and cannot create media.
      Socket.instances.at(-1)!.close(); await flush();
    }
    assert.equal(client.status, 'reconnecting');
    await client.disconnect();
    const count = Socket.instances.length;
    t.mock.timers.tick(MAX_DELAY);
    assert.equal(Socket.instances.length, count, 'disconnect cancels the remaining retry');
    assert.equal(client.status, 'disconnected');
  }

  for (const field of ['initialDelayMs', 'maxDelayMs'] as const) {
    it(`rejects invalid ${field} before mutating supplied audio`, () => {
      for (const value of invalidValues) {
        const audio = { autoplay: false } as HTMLAudioElement;
        const reconnect = { initialDelayMs: 500, maxDelayMs: 15000, [field]: value } as StageClientOptions['reconnect'];
        assert.throws(() => new StageClient({ url: 'ws://localhost/ws', audioElement: audio, reconnect }), RangeError);
        assert.equal(audio.autoplay, false);
      }
      assert.equal(createdAudio, 0); assert.equal(appendedAudio, 0);
    });

    it(`rejects invalid ${field} before creating or appending owned audio`, () => {
      for (const value of invalidValues) {
        const reconnect = { initialDelayMs: 500, maxDelayMs: 15000, [field]: value } as StageClientOptions['reconnect'];
        assert.throws(() => new StageClient({ url: 'ws://localhost/ws', reconnect }), RangeError);
        assert.equal(createdAudio, 0); assert.equal(appendedAudio, 0);
      }
    });
  }

  it('requires both fields when a reconnect configuration is supplied', () => {
    for (const reconnect of [{}, { initialDelayMs: 500 }, { maxDelayMs: 15000 }]) {
      const audio = { autoplay: false } as HTMLAudioElement;
      assert.throws(() => new StageClient({ url: 'ws://localhost/ws', audioElement: audio, reconnect: reconnect as unknown as StageClientOptions['reconnect'] }), RangeError);
      assert.equal(audio.autoplay, false);
      assert.throws(() => new StageClient({ url: 'ws://localhost/ws', reconnect: reconnect as unknown as StageClientOptions['reconnect'] }), RangeError);
    }
    assert.equal(createdAudio, 0); assert.equal(appendedAudio, 0);
  });

  for (const value of [undefined, null]) it(`preserves default backoff for ${String(value)} reconnect`, async t => {
    const client = make({ reconnect: value as unknown as StageClientOptions['reconnect'] });
    await assertRetryDelays(t, client, [500, 1000, 2000, 4000, 8000, 15000, 15000]);
  });

  const validCases = [
    { name: 'zero initial delay', reconnect: { initialDelayMs: 0, maxDelayMs: 15000 }, delays: [0, 0, 0] },
    { name: 'zero maximum delay', reconnect: { initialDelayMs: 500, maxDelayMs: 0 }, delays: [0, 0, 0] },
    { name: 'fractional delays', reconnect: { initialDelayMs: 1.5, maxDelayMs: 10.25 }, delays: [1.5, 3, 6, 10.25, 10.25] },
    { name: 'maximum below initial delay', reconnect: { initialDelayMs: 500, maxDelayMs: 10 }, delays: [10, 10, 10] },
    { name: 'signed timer ceiling', reconnect: { initialDelayMs: MAX_DELAY, maxDelayMs: MAX_DELAY }, delays: [MAX_DELAY, MAX_DELAY] },
    { name: 'a ceiling cap before exponential overflow', reconnect: { initialDelayMs: 5000, maxDelayMs: MAX_DELAY }, delays: Array.from({ length: 23 }, (_, i) => Math.min(MAX_DELAY, 5000 * 2 ** Math.min(i, 20))) },
    { name: 'the existing exponent limit after attempt 20', reconnect: { initialDelayMs: 1, maxDelayMs: MAX_DELAY }, delays: Array.from({ length: 23 }, (_, i) => 2 ** Math.min(i, 20)) },
  ];
  for (const { name, reconnect, delays } of validCases) it(`preserves ${name}`, async t => {
    await assertRetryDelays(t, make({ reconnect }), delays);
  });

  it('snapshots reconnect values before caller mutation of the original object', async t => {
    const reconnect = { initialDelayMs: 5, maxDelayMs: 12 };
    const client = make({ reconnect });
    reconnect.initialDelayMs = NaN; reconnect.maxDelayMs = Infinity;
    await assertRetryDelays(t, client, [5, 10, 12, 12]);
  });

  it('ignores replacement reconnect options after construction', async t => {
    const options: StageClientOptions = { url: 'ws://localhost/ws', audioElement: { pause() {} } as unknown as HTMLAudioElement, reconnect: { initialDelayMs: 5, maxDelayMs: 12 } };
    const client = new StageClient(options); clients.push(client);
    await assertRetryDelays(t, client, [5, 10, 12, 12], () => {
      options.reconnect = { initialDelayMs: -1, maxDelayMs: MAX_DELAY + 1 };
    });
  });

  it('snapshots the default policy when reconnect is added later', async t => {
    const options: StageClientOptions = { url: 'ws://localhost/ws', audioElement: { pause() {} } as unknown as HTMLAudioElement };
    const client = new StageClient(options); clients.push(client);
    await assertRetryDelays(t, client, [500, 1000, 2000], () => {
      options.reconnect = { initialDelayMs: NaN, maxDelayMs: Infinity };
    });
  });
});
