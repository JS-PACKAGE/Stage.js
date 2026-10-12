import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { silentLogger } from '../src/log.ts';
import { createStageServer } from '../src/ws/server.ts';
import { harness, testConfig } from './helpers.ts';

function bounded(promise: Promise<unknown>, ms = 1500): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('HTTP shutdown did not finish')), ms); })])
    .finally(() => clearTimeout(timer));
}

it('bounds shutdown with an unresolved metrics response and tolerates its late completion', async () => {
  const config = testConfig(c => { c.server.port = 0; c.server.httpShutdownDrainMs = 25; });
  const gate = Promise.withResolvers<string>(), started = Promise.withResolvers<void>();
  const server = createStageServer({ config, hub: harness(config).hub, log: silentLogger, baseDir: tmpdir(),
    metrics: () => { started.resolve(); return gate.promise; } });
  const { port } = await server.listen();
  const failed = Promise.withResolvers<Error>();
  const request = get(`http://127.0.0.1:${port}/metrics`, response => response.resume());
  request.on('error', error => failed.resolve(error));
  try {
    await bounded(started.promise);
    const closing = server.close(); assert.equal(server.close(), closing);
    await bounded(closing); assert.equal((await bounded(failed.promise) as NodeJS.ErrnoException).code, 'ECONNRESET');
    gate.resolve('stage_rooms 0\n'); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  } finally { request.destroy(); gate.resolve(''); await server.close(); }
});

it('lets an active HTTP response finish during its drain window', async () => {
  const config = testConfig(c => { c.server.port = 0; c.server.httpShutdownDrainMs = 1000; });
  const gate = Promise.withResolvers<string>(), started = Promise.withResolvers<void>();
  const server = createStageServer({ config, hub: harness(config).hub, log: silentLogger, baseDir: tmpdir(),
    metrics: () => { started.resolve(); return gate.promise; } });
  const { port } = await server.listen();
  const response = fetch(`http://127.0.0.1:${port}/metrics`);
  try {
    await bounded(started.promise); const closing = server.close();
    await new Promise(resolve => setImmediate(resolve)); gate.resolve('stage_rooms 7\n');
    const result = await response; assert.equal(result.status, 200); assert.match(await result.text(), /stage_rooms 7/);
    await bounded(closing);
  } finally { gate.resolve(''); await server.close(); }
});

it('bounds shutdown when a static download reader stops consuming data', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stage-http-drain-'));
  const size = 8 * 1024 * 1024; writeFileSync(join(dir, 'large.bin'), Buffer.alloc(size));
  const config = testConfig(c => { c.server.port = 0; c.server.httpShutdownDrainMs = 25; c.server.static = [{ mount: '/', dir, cors: false }]; });
  const server = createStageServer({ config, hub: harness(config).hub, log: silentLogger, baseDir: dir });
  const { port } = await server.listen();
  const request = get(`http://127.0.0.1:${port}/large.bin`); request.on('error', () => {});
  let response: import('node:http').IncomingMessage | undefined;
  try {
    [response] = await once(request, 'response') as [import('node:http').IncomingMessage];
    response.pause(); response.on('error', () => {});
    await bounded(server.close());
    let received = 0; response.on('data', chunk => { received += chunk.length; });
    const closed = new Promise<void>(resolve => response!.once('close', resolve)); response.resume();
    await bounded(closed); assert.ok(received < size, 'deadline cuts off an unfinished response');
  } finally { request.destroy(); response?.destroy(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});

it('HTTP deadline cleanup preserves a primary room shutdown error and handles late metrics failure', async () => {
  const config = testConfig(c => { c.server.port = 0; c.server.httpShutdownDrainMs = 0; });
  const { hub } = harness(config); hub.shutdown = async () => { throw new Error('primary shutdown error'); };
  const gate = Promise.withResolvers<string>(), started = Promise.withResolvers<void>();
  const server = createStageServer({ config, hub, log: silentLogger, baseDir: tmpdir(),
    metrics: () => { started.resolve(); return gate.promise; } });
  const { port } = await server.listen();
  const request = get(`http://127.0.0.1:${port}/metrics`, response => response.resume()); request.on('error', () => {});
  try {
    await bounded(started.promise);
    await assert.rejects(bounded(server.close()), /primary shutdown error/);
    gate.reject(new Error('late metrics failure')); await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`));
  } finally { request.destroy(); gate.resolve(''); await server.close().catch(() => {}); }
});
