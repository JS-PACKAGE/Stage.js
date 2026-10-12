import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { StageClient, StageError } from '../src/index.ts';

describe('paced request cleanup', () => {
  let client: StageClient;
  let socket: { readyState: number; sent: string[]; send(data: string): void; close(): void };
  let originals: Map<string, PropertyDescriptor | undefined>;
  beforeEach(() => {
    originals = new Map(['window', 'WebSocket'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, value: { OPEN: 1 } });
    client = new StageClient({ url: 'ws://localhost/ws', audioElement: { pause() {} } as unknown as HTMLAudioElement });
    socket = { readyState: 1, sent: [], send(data) { this.sent.push(data); }, close() { this.readyState = 3; } };
    client['socket'] = socket as unknown as WebSocket;
  });
  afterEach(async () => {
    await client.disconnect();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it('cancels both timers for every queued request on disconnect', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const scheduled = t.mock.method(globalThis, 'setTimeout');
    const cleared = t.mock.method(globalThis, 'clearTimeout');
    const requests = Array.from({ length: 1000 }, () => client.rotateCode().catch(error => error));
    assert.equal(scheduled.mock.calls.length, 2000);
    await client.disconnect();
    const errors = await Promise.all(requests);
    assert.ok(errors.every(error => error instanceof StageError && error.code === 'disconnected'));
    const cancelled = new Set(cleared.mock.calls.map(call => call.arguments[0]));
    const retained = scheduled.mock.calls.filter(call => !cancelled.has(call.result));
    assert.equal(retained.length, 0, 'paced send closures must not remain until future send slots');
    assert.equal(client['pending'].size, 0);
    t.mock.timers.tick(200000);
    assert.equal(socket.sent.length, 0);
  });

  it('clears scheduled work when a request is settled before its send slot', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cleared = t.mock.method(globalThis, 'clearTimeout');
    const request = client.rotateCode();
    const id = [...client['pending'].keys()][0]!;
    client['finish'](id);
    await request;
    assert.equal(cleared.mock.calls.length, 2);
    t.mock.timers.tick(20000);
    assert.equal(socket.sent.length, 0);
  });

  it('settles timeouts through the same cleanup path', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const cleared = t.mock.method(globalThis, 'clearTimeout');
    const request = client.rotateCode();
    const rejected = assert.rejects(request, error => error instanceof StageError && error.code === 'timeout');
    t.mock.timers.tick(15000);
    await rejected;
    assert.equal(socket.sent.length, 1);
    assert.equal(client['pending'].size, 0);
    assert.equal(cleared.mock.calls.length, 2);
  });

  it('can immediately reuse the client after cancellation and ignores old or duplicate acknowledgements', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const old = client.rotateCode().catch(error => error);
    const oldId = [...client['pending'].keys()][0]!;
    await client.disconnect(); await old;
    socket.readyState = 1;
    client['socket'] = socket as unknown as WebSocket;
    const fresh = client.rotateCode();
    t.mock.timers.tick(0);
    assert.equal(socket.sent.length, 1);
    client['finish'](oldId);
    assert.equal(client['pending'].size, 1);
    const id = JSON.parse(socket.sent[0]!).requestId as string;
    client['finish'](id); client['finish'](id);
    await fresh;
    assert.equal(client['pending'].size, 0);
  });

  it('rejects serialization errors without leaving a pending request', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const request = client.setGain('participant', 1n as unknown as number);
    const rejected = assert.rejects(request, error => error instanceof StageError && error.code === 'disconnected');
    assert.doesNotThrow(() => t.mock.timers.tick(0));
    await rejected;
    assert.equal(socket.sent.length, 0);
    assert.equal(client['pending'].size, 0);
  });

  it('rejects and cleans up a synchronous send failure rather than throwing from the timer', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    socket.send = () => { throw new Error('socket send failed'); };
    const request = client.rotateCode();
    const rejected = assert.rejects(request, error => error instanceof StageError && error.code === 'disconnected');
    assert.doesNotThrow(() => t.mock.timers.tick(0));
    await rejected;
    assert.equal(client['pending'].size, 0);
  });
});
