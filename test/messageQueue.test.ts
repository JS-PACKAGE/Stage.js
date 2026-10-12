import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MessageQueue } from '../src/ws/messageQueue.ts';

describe('bounded inbound message queue', () => {
  it('runs arrivals between an empty drain and its settling promise', async () => {
    const handled: number[] = [];
    const queue = new MessageQueue<number>(2, 10, async value => { handled.push(value); }, error => { throw error; });
    queue.enqueue(1, 1);
    await Promise.resolve();
    queue.enqueue(2, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(handled, [1, 2]);
    await queue.stop();
  });

  it('bounds waiting count and bytes independently of the active operation and preserves order', async () => {
    const gate = Promise.withResolvers<void>();
    const handled: number[] = [];
    const queue = new MessageQueue<number>(2, 10, async value => { handled.push(value); if (value === 1) await gate.promise; }, error => { throw error; });
    assert.equal(queue.enqueue(1, 80), true, 'an immediately active frame is bounded by maxFrameBytes, not waiting bytes');
    assert.equal(queue.pendingMessages, 0);
    assert.equal(queue.enqueue(2, 6), true);
    assert.equal(queue.enqueue(3, 5), false, 'byte overflow');
    assert.equal(queue.enqueue(3, 4), true);
    assert.equal(queue.enqueue(4, 0), false, 'count overflow');
    assert.equal(queue.pendingBytes, 10);
    gate.resolve();
    // Wait for each already-enqueued job, without stopping/discarding it.
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(handled, [1, 2, 3]);
    assert.equal(queue.pendingBytes, 0);
    assert.equal(queue.pendingMessages, 0);
    assert.equal(queue.enqueue(4, 1), true);
    await queue.stop();
    assert.deepEqual(handled, [1, 2, 3, 4]);
  });

  it('drops waiting payloads immediately on stop, rejects new arrivals and waits only for active work', async () => {
    const gate = Promise.withResolvers<void>();
    const handled: number[] = [];
    const queue = new MessageQueue<number>(3, 100, async value => { handled.push(value); await gate.promise; }, error => { throw error; });
    queue.enqueue(1, 20); queue.enqueue(2, 30); queue.enqueue(3, 40);
    let stopped = false;
    const done = queue.stop().then(() => { stopped = true; });
    assert.equal(queue.pendingMessages, 0);
    assert.equal(queue.pendingBytes, 0);
    assert.equal(queue.enqueue(4, 1), false);
    await Promise.resolve();
    assert.equal(stopped, false);
    gate.resolve(); await done;
    assert.deepEqual(handled, [1]);
    await queue.stop();
  });

  it('clears queued work after a handler failure and reports it once', async () => {
    const gate = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    const handled: number[] = [];
    const queue = new MessageQueue<number>(3, 100, async value => { handled.push(value); await gate.promise; throw new Error('failed'); }, error => { errors.push(error); });
    queue.enqueue(1, 1); queue.enqueue(2, 1);
    gate.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors.length, 1);
    assert.deepEqual(handled, [1]);
    assert.equal(queue.pendingMessages, 0);
    assert.equal(queue.enqueue(3, 1), false);
    await queue.stop();
  });
});
