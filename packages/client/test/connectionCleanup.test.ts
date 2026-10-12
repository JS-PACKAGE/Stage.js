import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { it, type TestContext } from 'node:test';
import { StageClient, StageError } from '../src/index.ts';

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  static failConstruction = false;
  readyState = 0;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  deferClose = false;
  constructor(_url: string) { if (Socket.failConstruction) throw new Error('invalid URL'); Socket.instances.push(this); }
  send(data: string) { const request = JSON.parse(data); if (request.requestId) queueMicrotask(() => this.deliver({ type: 'ok', requestId: request.requestId })); }
  deliver(message: unknown) { this.onmessage?.({ data: JSON.stringify(message) }); }
  hello() { this.readyState = 1; this.deliver({ type: 'hello', protocol: 1, serverVersion: 'test', limits: { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 } }); }
  close() { this.readyState = 3; if (!this.deferClose) this.onclose?.(); }
}
class Audio {
  isConnected = false;
  autoplay = false;
  hidden = false;
  volume = 1;
  muted = false;
  srcObject: unknown = null;
  pause() {}
  remove() { this.isConnected = false; }
}
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function setup(t: TestContext) {
  Socket.instances = []; Socket.failConstruction = false;
  const target = new EventTarget(), clients: StageClient[] = [], owned: Audio[] = [];
  const originals = new Map(['window', 'WebSocket', 'document'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.defineProperty(globalThis, 'window', { configurable: true, value: target });
  Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: Socket });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement() { const audio = new Audio(); owned.push(audio); return audio; }, body: { append(audio: Audio) { audio.isConnected = true; } } } });
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.after(async () => {
    for (const client of clients) await client.disconnect();
    for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  });
  return {
    target, owned, clients,
    listeners: () => getEventListeners(target, 'pagehide').length,
    make(custom = true) { const client = new StageClient({ url: 'ws://localhost/ws', ...(custom ? { audioElement: { pause() {} } as unknown as HTMLAudioElement } : {}), requestTimeoutMs: 1000 }); clients.push(client); return client; },
  };
}

it('does not retain failed clients through window after WebSocket construction throws', async t => {
  const { make, listeners } = setup(t); Socket.failConstruction = true;
  for (let i = 0; i < 8; i++) await assert.rejects(make().connect(), /invalid URL/);
  await flush(); assert.equal(listeners(), 0);
});

it('removes pagehide after an unjoined connection closes and adds it again on reuse', async t => {
  const { make, listeners, target } = setup(t), client = make();
  const first = client.connect(); Socket.instances[0]!.hello(); await first;
  assert.equal(listeners(), 1); Socket.instances[0]!.close(); assert.equal(listeners(), 0);
  const second = client.connect(); Socket.instances[1]!.hello(); await second;
  assert.equal(listeners(), 1); target.dispatchEvent(new Event('pagehide'));
  assert.equal(Socket.instances[1]!.readyState, 3); assert.equal(listeners(), 0);
});

it('removes pagehide when the server never sends hello', async t => {
  const { make, listeners } = setup(t), client = make();
  const failed = assert.rejects(client.connect(), error => error instanceof StageError && error.code === 'timeout');
  t.mock.timers.tick(1000); await failed; await flush();
  assert.equal(listeners(), 0); assert.equal(Socket.instances[0]!.readyState, 3);
});

it('does not let a late failed attempt remove a replacement connection listener', async t => {
  const { make, listeners, target, owned } = setup(t), client = make(false);
  const first = client.connect(); const failed = assert.rejects(first, error => error instanceof StageError && error.code === 'disconnected');
  const old = Socket.instances[0]!; old.deferClose = true; await client.disconnect();
  const next = client.connect(), replacement = Socket.instances[1]!;
  old.onclose?.(); await failed; await flush();
  assert.equal(listeners(), 1, 'old finally must not clean the newer CONNECTING attempt');
  assert.equal(owned[0]!.isConnected, true); replacement.hello(); await next;
  assert.equal(listeners(), 1); target.dispatchEvent(new Event('pagehide')); assert.equal(replacement.readyState, 3);
});

it('keeps the listener installed by a replacement started inside reconnect status', async t => {
  const { make, listeners } = setup(t), client = make();
  const joined = client.join({ roomId: 'room', name: 'Guest' });
  Socket.instances[0]!.hello(); await flush(); t.mock.timers.tick(0); await joined;
  let next: Promise<void> | undefined;
  client.on('status', event => {
    if (event.detail === 'reconnecting') { void client.disconnect(); next = client.connect(); next.catch(() => {}); }
  });
  Socket.instances[0]!.close(); assert.ok(next); Socket.instances[1]!.hello(); await next;
  assert.equal(listeners(), 1); assert.equal(Socket.instances[1]!.readyState, Socket.OPEN);
  await client.disconnect(); assert.equal(listeners(), 0);
});

it('detaches failed owned audio and reuses the same settings and element on the next connection', async t => {
  const { make, owned } = setup(t), client = make(false);
  client.setPlaybackVolume(0.4); client.setPlaybackMuted(true);
  Socket.failConstruction = true; await assert.rejects(client.connect(), /invalid URL/); await flush();
  assert.equal(owned[0]!.isConnected, false);
  Socket.failConstruction = false; const connected = client.connect(); Socket.instances[0]!.hello(); await connected;
  assert.equal(owned.length, 1); assert.equal(owned[0]!.isConnected, true);
  assert.equal(client.playbackVolume, 0.4); assert.equal(client.playbackMuted, true);
  assert.equal(owned[0]!.autoplay, true); assert.equal(owned[0]!.hidden, true);
  Socket.instances[0]!.close(); assert.equal(owned[0]!.isConnected, false);
});

it('detaches owned audio after hello timeout', async t => {
  const { make, owned } = setup(t), client = make(false);
  const failed = assert.rejects(client.connect(), error => error instanceof StageError && error.code === 'timeout');
  t.mock.timers.tick(1000); await failed; await flush(); assert.equal(owned[0]!.isConnected, false);
});

it('keeps owned audio attached while the same joined session automatically resumes', async t => {
  const { make, owned } = setup(t), client = make(false);
  const joined = client.join({ roomId: 'room', name: 'Guest' });
  Socket.instances[0]!.hello(); await flush(); t.mock.timers.tick(0); await joined;
  Socket.instances[0]!.close(); assert.equal(owned[0]!.isConnected, true);
  t.mock.timers.tick(500); Socket.instances[1]!.hello(); await flush(); t.mock.timers.tick(0); await flush();
  assert.equal(owned.length, 1); assert.equal(owned[0]!.isConnected, true);
  await client.disconnect(); assert.equal(owned[0]!.isConnected, false);
});

it('never removes a caller-owned audio element after failed or closed connections', async t => {
  const { clients } = setup(t), audio = new Audio(); audio.isConnected = true;
  const client = new StageClient({ url: 'ws://localhost/ws', audioElement: audio as unknown as HTMLAudioElement }); clients.push(client);
  Socket.failConstruction = true; await assert.rejects(client.connect(), /invalid URL/); await flush();
  assert.equal(audio.isConnected, true);
  Socket.failConstruction = false; const connected = client.connect(); Socket.instances[0]!.hello(); await connected;
  Socket.instances[0]!.close(); assert.equal(audio.isConnected, true);
  await client.disconnect(); assert.equal(audio.isConnected, true);
});
