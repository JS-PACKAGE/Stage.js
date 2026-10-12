import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { WebSocket } from 'ws';
import type { ServerMessage } from '../shared/protocol.ts';
import { WsSession } from '../src/ws/session.ts';

function setup(limit: number) {
  const sent: string[] = [];
  const overflows: number[][] = [];
  let terminated = 0;
  const ws = {
    OPEN: 1, readyState: 1, bufferedAmount: 0,
    send(data: string) { sent.push(data); this.bufferedAmount += Buffer.byteLength(data) + 2; },
    terminate() { terminated++; this.readyState = 2; },
    close() { this.readyState = 2; },
  };
  const session = new WsSession(ws as unknown as WebSocket, limit, (...bytes) => overflows.push(bytes));
  return { session, ws, sent, overflows, terminated: () => terminated };
}

const msg: ServerMessage = { type: 'pong' };
const encoded = JSON.stringify(msg);
const frameBytes = Buffer.byteLength(encoded) + 2;

describe('outbound WebSocket backpressure', () => {
  it('accepts the exact limit and terminates before the next frame is queued', () => {
    const h = setup(frameBytes * 2);
    h.session.send(msg);
    h.session.send(msg, encoded);
    assert.deepEqual(h.sent, [encoded, encoded]);
    h.session.send(msg);
    assert.equal(h.sent.length, 2);
    assert.equal(h.terminated(), 1);
    assert.deepEqual(h.overflows, [[frameBytes * 2, Buffer.byteLength(encoded)]]);
    h.session.send(msg);
    assert.equal(h.terminated(), 1);
    assert.equal(h.overflows.length, 1);
  });

  it('counts UTF-8 bytes, including a single message larger than the limit', () => {
    const unicode: ServerMessage = { type: 'error', code: 'bad_request', message: '語喵語喵語喵' };
    const data = JSON.stringify(unicode);
    assert.ok(Buffer.byteLength(data) > data.length);
    const h = setup(data.length);
    h.session.send(unicode, data);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.overflows, [[0, Buffer.byteLength(data)]]);
  });

  it('allows recovered readers to drain and respects pre-serialized messages', () => {
    const h = setup(frameBytes);
    h.session.send(msg, encoded);
    h.ws.bufferedAmount = 0;
    h.session.send(msg, encoded);
    assert.deepEqual(h.sent, [encoded, encoded]);
    assert.equal(h.terminated(), 0);
  });

  it('does no serialization or sending for closed connections', () => {
    const h = setup(1024);
    h.ws.readyState = 3;
    h.session.send({ ...msg, toJSON() { throw new Error('must not serialize'); } } as ServerMessage);
    assert.deepEqual(h.sent, []);
    assert.equal(h.terminated(), 0);
  });
});
