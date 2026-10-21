/** Deterministic backlog comparison, not an RSS/latency benchmark: node scripts/bench-ws-inbound.ts. */
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';
import { MessageQueue } from '../src/ws/messageQueue.ts';

const config = loadConfig('config.example.yaml');
const count = 1000;
const payload = JSON.stringify({ type: 'rtc:ice', requestId: 'req', payload: { candidate: 'x'.repeat(1024) } });
const bytes = Buffer.byteLength(payload);
const baselineGate = Promise.withResolvers<void>();
let baselineHandled = 0;
let chain = Promise.resolve();
for (let i = 0; i < count; i++) chain = chain.then(async () => { baselineHandled++; if (i === 0) await baselineGate.promise; });
await Promise.resolve();
const baselinePending = count - baselineHandled;
// The old chain retains every accepted operation after a disconnect.
baselineGate.resolve(); await chain;

const gate = Promise.withResolvers<void>();
let handled = 0, peakMessages = 0, peakBytes = 0;
const queue = new MessageQueue<string>(config.limits.maxPendingMessages, config.limits.maxPendingBytes,
  async () => { handled++; await gate.promise; }, error => { throw error; });
for (let i = 0; i < count; i++) {
  if (!queue.enqueue(payload, bytes)) break;
  peakMessages = Math.max(peakMessages, queue.pendingMessages);
  peakBytes = Math.max(peakBytes, queue.pendingBytes);
}
const stopped = queue.stop();
assert.equal(queue.pendingMessages, 0);
assert.equal(queue.pendingBytes, 0);
gate.resolve(); await stopped;
assert.equal(handled, 1);
console.log(JSON.stringify({ offered: count, payloadBytes: bytes,
  baseline: { pendingMessages: baselinePending, pendingPayloadBytes: baselinePending * bytes, handledAfterDisconnect: baselineHandled },
  bounded: { peakPendingMessages: peakMessages, peakPendingPayloadBytes: peakBytes, pendingAfterStop: queue.pendingMessages, handledAfterDisconnect: handled },
}, null, 2));
