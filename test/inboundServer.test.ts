import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { parseConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { createStageServer } from '../src/ws/server.ts';
import type { WsSession } from '../src/ws/session.ts';
import { harness, testConfig } from './helpers.ts';

describe('inbound backlog at the WebSocket boundary', () => {
  it('defaults legacy configuration and validates both backlog bounds', () => {
    const config = testConfig();
    const { maxPendingMessages: _count, maxPendingBytes: _bytes, ...limits } = config.limits;
    const legacy = parseConfig({ ...config, limits });
    assert.equal(legacy.limits.maxPendingMessages, 128);
    assert.equal(legacy.limits.maxPendingBytes, config.limits.maxFrameBytes * 16);
    for (const maxPendingMessages of [0, -1, 1.5, Infinity]) assert.throws(() => parseConfig({ ...config, limits: { ...limits, maxPendingMessages } }), /maxPendingMessages/);
    for (const maxPendingBytes of [0, 1023, 1024.5, Infinity]) assert.throws(() => parseConfig({ ...config, limits: { ...limits, maxPendingBytes } }), /maxPendingBytes/);
    assert.equal(parseConfig({ ...config, limits: { ...limits, maxPendingMessages: 1, maxPendingBytes: 1024 } }).limits.maxPendingMessages, 1);
  });

  for (const mode of ['count', 'bytes', 'disconnect', 'policy', 'terminate', 'outbound'] as const) it(`drops waiting work on ${mode} while preserving the active operation and healthy peers`, async () => {
    const config = testConfig(c => {
      c.server.port = 0; c.limits.icePerSecond = 100;
      c.limits.maxPendingMessages = mode === 'count' ? 2 : 100;
      if (mode === 'outbound') c.limits.maxSendBufferBytes = 1024;
      c.limits.maxPendingBytes = mode === 'bytes' ? 1024 : 65536;
    });
    const { hub } = harness(config);
    const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>(), detached = Promise.withResolvers<void>();
    const sessions: WsSession[] = [], handled: string[] = [];
    const originalAttach = hub.attach.bind(hub), originalHandle = hub.handle.bind(hub), originalDetach = hub.detach.bind(hub);
    hub.attach = session => { sessions.push(session as WsSession); originalAttach(session); };
    hub.handle = async (session, message) => {
      if (message.type === 'rtc:ice') {
        handled.push(message.requestId);
        if (message.requestId === 'active') { started.resolve(); await gate.promise; }
      }
      await originalHandle(session, message);
    };
    hub.detach = async (session, intentional) => { await originalDetach(session, intentional); if (session === sessions[0]) detached.resolve(); };
    const server = createStageServer({ config, hub, log: silentLogger, baseDir: tmpdir(), metrics: async () => '' });
    const { port } = await server.listen();
    const url = `ws://127.0.0.1:${port}${config.server.wsPath}`;
    const overloaded = new WebSocket(url), healthy = new WebSocket(url);
    try {
      await Promise.all([once(overloaded, 'open'), once(healthy, 'open')]);
      const serverClosed = once(sessions[0]!.ws, 'close');
      overloaded.send(JSON.stringify({ type: 'rtc:ice', requestId: 'active', payload: null }));
      await started.promise;
      const queuedArrived = Promise.withResolvers<void>();
      let arrivals = 0;
      sessions[0]!.ws.on('message', () => { if (++arrivals === 10) queuedArrived.resolve(); });
      for (let i = 0; i < 10; i++) overloaded.send(JSON.stringify({ type: 'rtc:ice', requestId: `queued-${i}`, payload: { candidate: 'x'.repeat(500) } }));
      if (mode === 'disconnect') overloaded.close(1000);
      if (mode === 'policy' || mode === 'terminate' || mode === 'outbound') {
        await queuedArrived.promise;
        if (mode === 'policy') { overloaded.pause(); sessions[0]!.close(1008, 'rate limit'); }
        else if (mode === 'terminate') sessions[0]!.terminate();
        else sessions[0]!.send({ type: 'error', code: 'bad_request', message: 'x'.repeat(2000) });
        gate.resolve();
        await new Promise(resolve => setImmediate(resolve));
        assert.deepEqual(handled, ['active'], 'closing initiation must cancel waiting handlers before the close event');
        if (mode === 'policy') { assert.equal(sessions[0]!.ws.readyState, WebSocket.CLOSING); overloaded.resume(); }
      }
      await serverClosed;
      const pong = new Promise<void>(resolve => healthy.on('message', data => { if (JSON.parse(data.toString()).type === 'pong') resolve(); }));
      healthy.send(JSON.stringify({ type: 'ping' }));
      await pong;
      assert.deepEqual(handled, ['active']);
      gate.resolve(); await detached.promise;
      assert.deepEqual(handled, ['active'], 'discarded requests must never execute after disconnect');
      const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
      assert.match(metrics, new RegExp(`stage_ws_inbound_queue_disconnects_total ${mode === 'count' || mode === 'bytes' ? 1 : 0}\\n`));
    } finally {
      gate.resolve(); overloaded.terminate(); healthy.terminate(); await server.close();
    }
  });
});
