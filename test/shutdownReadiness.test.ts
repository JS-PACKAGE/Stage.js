import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { WebSocket } from 'ws';
import { silentLogger } from '../src/log.ts';
import type { WsSession } from '../src/ws/session.ts';
import { createStageServer } from '../src/ws/server.ts';
import { harness, testConfig } from './helpers.ts';

describe('shutdown readiness and admission', () => {
  it('closes the listener even when room shutdown fails and preserves the rejection', async () => {
    const config = testConfig(c => { c.server.port = 0; });
    const { hub } = harness(config);
    hub.shutdown = async () => { throw new Error('shutdown failed'); };
    let session: WsSession;
    const attach = hub.attach.bind(hub);
    hub.attach = value => { session = value as WsSession; attach(value); };
    const server = createStageServer({ config, hub, log: silentLogger, baseDir: tmpdir() });
    const { port } = await server.listen();
    const client = new WebSocket(`ws://127.0.0.1:${port}${config.server.wsPath}`);
    await once(client, 'open');
    const close = session!.close.bind(session!);
    session!.close = (code, reason) => {
      close(code, reason);
      session!.ws.emit('error', new Error('closing socket error'));
      session!.terminate();
    };
    const closing = server.close();
    await assert.rejects(closing, /shutdown failed/, 'a closing socket error must not replace the primary shutdown failure');
    client.terminate();
    assert.equal(server.close(), closing);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  });

  it('drops already-queued successors at close start without cancelling active work', async () => {
    const config = testConfig(c => { c.server.port = 0; });
    const { hub } = harness(config);
    const active = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), shutdown = Promise.withResolvers<void>();
    const handled: string[] = [];
    let session: WsSession;
    const originalAttach = hub.attach.bind(hub), originalShutdown = hub.shutdown.bind(hub);
    hub.attach = value => { session = value as WsSession; originalAttach(value); };
    hub.handle = async (_session, message) => {
      if (message.type !== 'rtc:ice') return;
      handled.push(message.requestId);
      if (message.requestId === 'active') { active.resolve(); await release.promise; }
    };
    hub.shutdown = async () => { await shutdown.promise; await originalShutdown(); };
    const server = createStageServer({ config, hub, log: silentLogger, baseDir: tmpdir() });
    const { port } = await server.listen();
    const client = new WebSocket(`ws://127.0.0.1:${port}${config.server.wsPath}`);
    await once(client, 'open');
    try {
      client.send(JSON.stringify({ type: 'rtc:ice', requestId: 'active', payload: null }));
      await active.promise;
      const queued = once(session!.ws, 'message');
      client.send(JSON.stringify({ type: 'rtc:ice', requestId: 'queued', payload: null }));
      await queued;
      const closing = server.close();
      release.resolve();
      await new Promise(resolve => setImmediate(resolve));
      assert.deepEqual(handled, ['active']);
      assert.equal(session!.ws.readyState, WebSocket.OPEN, 'input stops before shutdown notifications and socket closure');
      shutdown.resolve();
      await closing;
      assert.deepEqual(handled, ['active']);
    } finally { release.resolve(); shutdown.resolve(); client.terminate(); await server.close(); }
  });

  it('serves a noncached GET/HEAD readiness probe and restricts its methods', async () => {
    const config = testConfig(c => { c.server.port = 0; });
    const server = createStageServer({ config, hub: harness(config).hub, log: silentLogger, baseDir: tmpdir() });
    const { port } = await server.listen();
    try {
      const url = `http://127.0.0.1:${port}/readyz`;
      const get = await fetch(url);
      assert.equal(get.status, 200);
      assert.equal(get.headers.get('cache-control'), 'no-store');
      assert.equal(await get.text(), 'ready');
      const head = await fetch(url, { method: 'HEAD' });
      assert.equal(head.status, 200);
      assert.equal(await head.text(), '');
      const post = await fetch(url, { method: 'POST' });
      assert.equal(post.status, 405);
      assert.equal(post.headers.get('allow'), 'GET, HEAD');
      await post.text();
    } finally { await server.close(); }
  });

  it('stops admission and existing-client commands immediately, reports draining, and closes only once', async () => {
    const config = testConfig(c => { c.server.port = 0; });
    const { hub } = harness(config);
    const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>();
    let shutdowns = 0, attached = 0, handled = 0;
    let serverSession: WsSession;
    const originalShutdown = hub.shutdown.bind(hub), originalAttach = hub.attach.bind(hub);
    hub.shutdown = async () => { shutdowns++; started.resolve(); await gate.promise; await originalShutdown(); };
    hub.attach = session => { attached++; serverSession = session as WsSession; originalAttach(session); };
    hub.handle = async () => { handled++; };
    const server = createStageServer({ config, hub, log: silentLogger, baseDir: tmpdir() });
    const { port } = await server.listen();
    const base = `http://127.0.0.1:${port}`, url = `ws://127.0.0.1:${port}${config.server.wsPath}`;
    const existing = new WebSocket(url);
    await once(existing, 'open');
    const closing = server.close();
    assert.equal(server.close(), closing);
    await started.promise;
    try {
      const arrived = once(serverSession!.ws, 'message');
      existing.send(JSON.stringify({ type: 'ping' }));
      await arrived;
      const rejected = await new Promise<number>((resolve, reject) => {
        const client = new WebSocket(url);
        client.on('open', () => { client.terminate(); reject(new Error('accepted an upgrade while draining')); });
        client.on('error', () => {});
        client.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); client.terminate(); });
      });
      assert.equal(rejected, 503);
      assert.equal(attached, 1);
      const readiness = await fetch(`${base}/readyz`);
      assert.equal(readiness.status, 503);
      assert.equal(await readiness.text(), 'draining');
      const health = await fetch(`${base}/healthz`);
      assert.equal(health.status, 200);
      assert.equal(await health.text(), 'ok');
      assert.equal(handled, 0);
      assert.equal(shutdowns, 1);
    } finally { gate.resolve(); existing.terminate(); await closing; }
    assert.equal(server.close(), closing);
    await assert.rejects(server.listen(), /closing/);
    assert.equal(shutdowns, 1);
  });
});
