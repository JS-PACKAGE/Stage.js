import assert from 'node:assert/strict';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { it } from 'node:test';
import { WebSocket } from 'ws';
import { silentLogger } from '../src/log.ts';
import { createStageServer } from '../src/ws/server.ts';
import { harness, testConfig } from './helpers.ts';

function ping(client: WebSocket): Promise<string> {
  return new Promise(resolve => {
    const message = (data: Buffer) => {
      if (JSON.parse(data.toString()).type === 'pong') done('pong');
    };
    const close = (code: number) => done(`closed:${code}`);
    const done = (value: string) => { client.off('message', message); client.off('close', close); resolve(value); };
    client.on('message', message); client.once('close', close);
    client.send(JSON.stringify({ type: 'ping' }));
  });
}

for (const [jump, rate, expected] of [[-3600000, 20, 'pong'], [3600000, 1, 'closed:1008']] as const) it(`wall-clock jump ${jump}ms does not distort the rate budget`, async t => {
  let wallTime = Date.now();
  t.mock.method(Date, 'now', () => wallTime);
  t.mock.method(performance, 'now', () => 1000);
  const config = testConfig(c => { c.server.port = 0; c.limits.controlPerSecond = rate; });
  const server = createStageServer({ config, hub: harness(config).hub, log: silentLogger, baseDir: tmpdir() });
  const { port } = await server.listen();
  const client = new WebSocket(`ws://127.0.0.1:${port}${config.server.wsPath}`);
  try {
    await once(client, 'open');
    assert.equal(await ping(client), 'pong');
    wallTime += jump;
    assert.equal(await ping(client), expected);
  } finally { client.terminate(); await server.close(); }
});
