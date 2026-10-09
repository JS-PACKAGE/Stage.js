import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { WebSocket } from 'ws';
import type { ServerMessage } from '../shared/protocol.ts';
import { ConfigError, parseConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { RoomMixer } from '../src/mixer/RoomMixer.ts';
import { MockMediaTransport } from '../src/transport/MockMediaTransport.ts';
import { StageHub } from '../src/ws/hub.ts';
import { createStageServer, type StageServer } from '../src/ws/server.ts';
import { parse } from 'yaml';
import { testConfig } from './helpers.ts';

class Client {
  readonly ws: WebSocket;
  readonly inbox: ServerMessage[] = [];
  readonly closed: Promise<number>;
  private waiters: (() => void)[] = [];
  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => {
      this.inbox.push(JSON.parse(d.toString()));
      for (const w of this.waiters.splice(0)) w();
    });
    const { promise, resolve } = Promise.withResolvers<number>();
    this.ws.on('close', (code) => {
      resolve(code);
      for (const w of this.waiters.splice(0)) w();
    });
    this.closed = promise;
  }
  async open(): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    this.ws.once('open', () => resolve());
    this.ws.once('error', reject);
    await promise;
  }
  send(obj: unknown): void {
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }
  /** Resolves on the first matching message; wakes only on message/close events (test-runner timeout bounds it). */
  async waitFor(pred: (m: ServerMessage) => boolean): Promise<ServerMessage> {
    for (;;) {
      const hit = this.inbox.find(pred);
      if (hit) return hit;
      if (this.ws.readyState === WebSocket.CLOSED) throw new Error('connection closed before expected message');
      const { promise, resolve } = Promise.withResolvers<void>();
      this.waiters.push(resolve);
      await promise;
    }
  }
  async reply(requestId: string): Promise<ServerMessage> {
    return this.waitFor((m) => (m.type === 'ok' || m.type === 'error') && m.requestId === requestId);
  }
}

describe('ws server boundary', () => {
  let server: StageServer;
  let url: string;
  let base: string;
  const staticDir = mkdtempSync(join(tmpdir(), 'stage-static-'));
  mkdirSync(join(staticDir, 'pub'));
  writeFileSync(join(staticDir, 'pub', 'index.html'), '<h1>hi</h1>');
  writeFileSync(join(staticDir, 'secret.txt'), 'nope');

  before(async () => {
    const config = testConfig((c) => {
      c.server.port = 0;
      c.limits.controlPerSecond = 5;
      c.server.static = [{ mount: '/', dir: join(staticDir, 'pub'), cors: false }];
    });
    let hub: StageHub | undefined;
    const transport = new MockMediaTransport({ onLocalCandidate: (r, p, c) => hub?.onLocalCandidate(r, p, c) });
    hub = new StageHub({
      config,
      transport,
      log: silentLogger,
      serverVersion: 'test',
      createMixer: () => new RoomMixer({ sampleRate: 48000, frameMs: 20, maxBufferedFrames: 10, playoutFrames: 1, limiterThreshold: 0.9 }),
    });
    server = createStageServer({ config, hub, log: silentLogger, baseDir: staticDir });
    const addr = await server.listen();
    base = `http://127.0.0.1:${addr.port}`;
    url = `ws://127.0.0.1:${addr.port}${config.server.wsPath}`;
  });
  after(() => server.close());

  it('greets, rejects unknown types and malformed input with generic errors', async () => {
    const c = new Client(url);
    await c.open();
    await c.waitFor((m) => m.type === 'hello');
    c.send({ type: 'nuke', requestId: 'r1' });
    assert.deepEqual(await c.reply('r1'), { type: 'error', requestId: 'r1', code: 'unknown_type', message: 'Unknown message type' });
    c.send({ type: 'join', requestId: 'r2', roomId: 'x', name: 'a'.repeat(33) });
    assert.equal((await c.reply('r2')).type, 'error');
    c.send('not json');
    await c.waitFor((m) => m.type === 'error' && m.code === 'bad_request' && m.requestId === undefined);
    c.ws.close();
  });

  it('escapes display names and keeps the room code out of non-controller state', async () => {
    const host = new Client(url);
    await host.open();
    host.send({ type: 'room:create', requestId: 'c1', name: '<img src=x onerror=alert(1)>', roomName: 'R&D' });
    assert.equal((await host.reply('c1')).type, 'ok');
    const st = await host.waitFor((m) => m.type === 'room:state');
    assert.ok(st.type === 'room:state');
    assert.equal(st.me.name, '&lt;img src=x onerror=alert(1)&gt;');
    assert.equal(st.name, 'R&amp;D');

    const guest = new Client(url);
    await guest.open();
    guest.send({ type: 'join', requestId: 'j1', roomId: st.roomId, code: st.code!.toLowerCase(), name: 'Guest' });
    assert.equal((await guest.reply('j1')).type, 'ok', 'code is case-insensitive');
    const gst = await guest.waitFor((m) => m.type === 'room:state');
    assert.ok(gst.type === 'room:state' && gst.code === undefined && gst.audience === undefined);
    host.ws.close();
    guest.ws.close();
  });

  it('disconnects with 1008 when the control rate limit is exceeded', async () => {
    const c = new Client(url);
    await c.open();
    for (let i = 0; i < 20; i++) c.send({ type: 'ping' });
    assert.equal(await c.closed, 1008);
  });

  it('disconnects when hand:raise repeats within the interval', async () => {
    const host = new Client(url);
    await host.open();
    host.send({ type: 'room:create', requestId: 'c', name: 'H' });
    const st = await host.waitFor((m) => m.type === 'room:state');
    assert.ok(st.type === 'room:state');
    const a = new Client(url);
    await a.open();
    a.send({ type: 'join', requestId: 'j', roomId: st.roomId, code: st.code, name: 'A' });
    await a.reply('j');
    a.send({ type: 'hand:raise', requestId: 'h1' });
    assert.equal((await a.reply('h1')).type, 'ok');
    a.send({ type: 'hand:withdraw', requestId: 'h2' });
    a.send({ type: 'hand:raise', requestId: 'h3' });
    assert.equal(await a.closed, 1008);
    host.ws.close();
  });

  it('closes connections that send frames over the size limit', async () => {
    const c = new Client(url);
    await c.open();
    c.send({ type: 'ping', pad: 'x'.repeat(70_000) });
    assert.equal(await c.closed, 1009);
  });

  it('serves static files without path traversal', async () => {
    assert.equal(await (await fetch(`${base}/`)).text(), '<h1>hi</h1>');
    assert.equal((await fetch(`${base}/..%2fsecret.txt`)).status, 404);
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
  });
});

describe('transport security policy', () => {
  const raw = () => parse(readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8'));
  it('refuses plaintext ws unless explicitly enabled on loopback', () => {
    const offLoopback = raw();
    offLoopback.server.host = '0.0.0.0';
    assert.throws(() => parseConfig(offLoopback), ConfigError);
    const notEnabled = raw();
    notEnabled.server.allowInsecure = false;
    assert.throws(() => parseConfig(notEnabled), ConfigError);
  });
});
