import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { silentLogger } from '../src/log.ts';
import { createStageServer } from '../src/ws/server.ts';
import { harness, testConfig } from './helpers.ts';

describe('concurrent metrics collection', () => {
  it('does not collect unauthorized requests and recovers after synchronous and asynchronous failures', async () => {
    const config = testConfig(c => { c.server.port = 0; c.server.metrics = { enabled: true, token: 'test' }; });
    const { hub } = harness(config);
    let collections = 0;
    const server = createStageServer({ config, hub, log: silentLogger, baseDir: tmpdir(), metrics: () => {
      collections++;
      if (collections === 1) throw new Error('synchronous failure');
      if (collections === 2) return Promise.reject(new Error('asynchronous failure'));
      return Promise.resolve('stage_test 3\n');
    } });
    const { port } = await server.listen();
    const url = `http://127.0.0.1:${port}/metrics`;
    try {
      for (const authorization of ['', 'Bearer wrong']) {
        const response = await fetch(url, { headers: { authorization } });
        assert.equal(response.status, 401);
        await response.text();
      }
      assert.equal(collections, 0);
      for (const expected of [500, 500, 200]) {
        const response = await fetch(url, { headers: { authorization: 'Bearer test' } });
        assert.equal(response.status, expected);
        const text = await response.text();
        if (expected === 200) assert.match(text, /stage_test 3/);
        else assert.equal(text, '', 'internal failures are not exposed');
      }
      assert.equal(collections, 3);
    } finally { await server.close(); }
  });

  it('isolates collections across server instances', async () => {
    const pending = Promise.withResolvers<string>();
    const started = Promise.withResolvers<void>();
    const config = testConfig(c => { c.server.port = 0; c.server.metrics = { enabled: true, token: '' }; });
    const first = createStageServer({ config, hub: harness(config).hub, log: silentLogger, baseDir: tmpdir(), metrics: () => { started.resolve(); return pending.promise; } });
    const second = createStageServer({ config, hub: harness(config).hub, log: silentLogger, baseDir: tmpdir(), metrics: async () => 'stage_second 1\n' });
    const a = await first.listen(), b = await second.listen();
    try {
      const waiting = fetch(`http://127.0.0.1:${a.port}/metrics`).then(response => response.text());
      await started.promise;
      const other = await (await fetch(`http://127.0.0.1:${b.port}/metrics`)).text();
      assert.match(other, /stage_second 1/);
      pending.resolve('stage_first 1\n');
      const result = await waiting;
      assert.match(result, /stage_first 1/);
      assert.doesNotMatch(result, /stage_second/);
    } finally { pending.resolve(''); await Promise.all([first.close(), second.close()]); }
  });

  for (const fail of [false, true]) it(`shares ${fail ? 'failed' : 'successful'} in-flight collection and refreshes afterward`, async () => {
    const count = 32;
    const arrived = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<string>();
    let requests = 0, collections = 0;
    const config = testConfig(c => { c.server.port = 0; c.server.metrics = { enabled: true, token: 'test' }; });
    Object.defineProperty(config.server.metrics, 'token', { get: () => { if (++requests === count) arrived.resolve(); return 'test'; } });
    const { hub } = harness(config);
    const server = createStageServer({ config, hub, log: silentLogger, baseDir: tmpdir(), metrics: () => { collections++; return collections === 1 ? pending.promise : Promise.resolve('stage_test 2\n'); } });
    const { port } = await server.listen();
    const url = `http://127.0.0.1:${port}/metrics`;
    const options = { headers: { authorization: 'Bearer test' } };
    try {
      const responses = Promise.all(Array.from({ length: count }, () => fetch(url, options).then(async response => ({ status: response.status, body: await response.text() }))));
      await arrived.promise;
      const denied = await fetch(url, { headers: { authorization: 'Bearer wrong' } });
      assert.equal(denied.status, 401, 'an in-flight authenticated sample does not bypass authorization');
      await denied.text();
      const simultaneousCollections = collections;
      if (fail) pending.reject(new Error('shared failure'));
      else pending.resolve('stage_test 1\n');
      const results = await responses;
      assert.ok(results.every(response => fail ? response.status === 500 && response.body === '' : response.status === 200 && response.body.includes('stage_test 1\n')));
      assert.equal(simultaneousCollections, 1);
      const refreshed = await fetch(url, options);
      assert.equal(refreshed.status, 200);
      assert.match(await refreshed.text(), /stage_test 2/);
      assert.equal(collections, 2, 'completed results are not cached');
    } finally { pending.resolve(''); await server.close(); }
  });
});
