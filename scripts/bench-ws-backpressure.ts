/** Compare modes in separate processes: node scripts/bench-ws-backpressure.ts bounded|unbounded. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { setImmediate } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { loadConfig } from '../src/config.ts';
import { WsSession } from '../src/ws/session.ts';

const mode = process.argv[2] ?? 'bounded';
if (mode !== 'bounded' && mode !== 'unbounded') throw new Error('Expected bounded or unbounded');
const config = loadConfig('config.example.yaml');
const limit = mode === 'bounded' ? config.limits.maxSendBufferBytes : Infinity;
const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await once(wss, 'listening');
const url = `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`;
async function pair(): Promise<{ client: WebSocket; server: WebSocket }> {
  const connected = once(wss, 'connection');
  const client = new WebSocket(url);
  await once(client, 'open');
  const [server] = await connected as [WebSocket];
  return { client, server };
}
const slow = await pair();
const healthy = await pair();
slow.client.pause();
let disconnects = 0;
const session = new WsSession(slow.server, limit, () => { disconnects++; });
healthy.server.on('message', (data) => healthy.server.send(data));
const message = { type: 'error' as const, code: 'bad_request' as const, message: 'x'.repeat(16 * 1024) };
const encoded = JSON.stringify(message);
const rssBefore = process.memoryUsage().rss;
let maxRss = rssBefore;
let maxBufferedBytes = 0;
const healthyRtt: number[] = [];
const start = performance.now();
try {
  for (let batch = 0; batch < 128; batch++) {
    const reply = once(healthy.client, 'message');
    const pingStart = performance.now();
    healthy.client.send('ping');
    for (let i = 0; i < 32; i++) {
      session.send(message, encoded);
      maxBufferedBytes = Math.max(maxBufferedBytes, slow.server.bufferedAmount);
    }
    await setImmediate();
    await reply;
    healthyRtt.push(performance.now() - pingStart);
    maxRss = Math.max(maxRss, process.memoryUsage().rss);
  }
  healthyRtt.sort((a, b) => a - b);
  console.log(JSON.stringify({ mode, framesAttempted: 4096, payloadBytes: Buffer.byteLength(encoded), maxBufferedBytes, disconnects, rssGrowthBytes: maxRss - rssBefore, healthyRttP95Ms: healthyRtt[Math.floor(healthyRtt.length * 0.95)], elapsedMs: performance.now() - start }));
  if (mode === 'bounded') {
    assert.equal(disconnects, 1, 'paused reader should exceed its outbound budget');
    assert.ok(maxBufferedBytes <= limit, 'queued output must stay within the configured budget');
  }
} finally {
  slow.client.resume();
  for (const ws of [slow.client, slow.server, healthy.client, healthy.server]) ws.terminate();
  await new Promise<void>((resolve) => wss.close(() => resolve()));
}
