import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { get } from 'node:http';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { ConfigError, parseConfig } from '../src/config.ts';
import { silentLogger } from '../src/log.ts';
import { createStageServer } from '../src/ws/server.ts';
import { harness, testConfig } from './helpers.ts';

const EXAMPLE = readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8');
const PATH_ERROR = 'server.wsPath: must be a literal HTTP URL pathname without query, fragment or normalization';
const SECRET = 'SYNTHETIC_WS_PATH_SECRET_18ab7c';
const IO_MS = 2500;

function rawConfig(wsPath: unknown): unknown {
  const raw = parse(EXAMPLE) as { server: { wsPath: unknown } };
  raw.server.wsPath = wsPath;
  return raw;
}

describe('WebSocket pathname configuration', () => {
  it('preserves the default and representable literal pathnames without normalization', () => {
    assert.equal(parseConfig(parse(EXAMPLE)).server.wsPath, '/ws');
    for (const path of [
      '/', '/ws', '/custom/stage/', '//other/ws', '///other/ws', '/stage//ws',
      '/%2F/%2f', '/%zz', '/%E8%AA%9E/%20ws', '/%3F/%23/%5C', '/a/.../ws',
    ]) assert.equal(parseConfig(rawConfig(path)).server.wsPath, path);
  });

  it('rejects query, fragment and URL-normalized values with one safe field diagnostic', () => {
    for (const path of [
      '/ws?', '/ws#', `/ws?token=${SECRET}`, `/ws#${SECRET}`,
      '/a/../ws', '/./ws', '/a/%2e%2e/ws', '/a/.%2E/ws', '/ws/..',
      `/a\\${SECRET}`, '/語/ws', '/ws x', '/ws ', '/ws\t', '/ws\n', '/ws\r', '/ws\0',
    ]) {
      assert.throws(() => parseConfig(rawConfig(path)), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.equal(error.message, PATH_ERROR);
        assert.ok(!error.message.includes(SECRET));
        return true;
      }, JSON.stringify(path));
    }
  });

  it('retains the existing string and leading-slash diagnostics', () => {
    for (const value of [undefined, null, false, 123, [], {}]) {
      assert.throws(() => parseConfig(rawConfig(value)), { name: 'Error', message: 'server.wsPath: expected string' });
    }
    for (const value of ['', 'ws', 'https://localhost/ws']) {
      assert.throws(() => parseConfig(rawConfig(value)), { name: 'Error', message: 'server.wsPath: must start with "/"' });
    }
  });

  it('requires an HTTP pathname even when a non-HTTP scheme preserves a backslash', () => {
    const path = '/a\\b';
    assert.equal(new URL(`foo://x${path}`).pathname, path);
    assert.notEqual(new URL(`http://x${path}`).pathname, path);
    assert.throws(() => parseConfig(rawConfig(path)), { message: PATH_ERROR });
  });
});

async function bounded<T>(promise: Promise<T>, label: string, ms = IO_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); }),
    ]);
  } finally { clearTimeout(timer); }
}

async function setup(wsPath: string, validate = true) {
  const raw = testConfig(config => {
    config.server.host = '127.0.0.1';
    config.server.port = 0;
    config.server.wsPath = wsPath;
    config.server.static = [];
    config.server.httpShutdownDrainMs = 100;
    config.limits.joinTimeoutMs = 0;
    config.rooms.heartbeatIntervalMs = 60000;
  });
  const config = validate ? parseConfig(raw) : raw;
  const { hub, transport } = harness(config);
  let attached = 0;
  const attach = hub.attach.bind(hub);
  hub.attach = session => { attached++; attach(session); };
  const server = createStageServer({ config, hub, log: silentLogger, baseDir: tmpdir() });
  const sockets = new Set<Socket>();
  let port: number;
  try { ({ port } = await bounded(server.listen(), 'listen')); }
  catch (error) { await bounded(server.close(), 'failed-listen cleanup', 4000); throw error; }

  function upgrade(target: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: '127.0.0.1', port });
      sockets.add(socket);
      let response = '';
      let failure: Error | undefined;
      const timer = setTimeout(() => {
        failure = new Error('Raw upgrade timed out');
        socket.destroy();
        reject(failure);
      }, IO_MS);
      socket.on('data', chunk => {
        response += chunk.toString('latin1');
        if (response.length > 65536) { failure = new Error('Oversized upgrade response'); socket.destroy(); }
        // Successful upgrades remain open; close only after observing the native handshake.
        if (response.startsWith('HTTP/1.1 101 ') && response.includes('\r\n\r\n')) socket.destroy();
      });
      socket.on('error', error => { failure = error; });
      socket.once('close', () => {
        clearTimeout(timer);
        sockets.delete(socket);
        if (failure) reject(failure); else resolve(response);
      });
      socket.once('connect', () => socket.write([
        `GET ${target} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket',
        'Sec-WebSocket-Version: 13', 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', '', '',
      ].join('\r\n')));
    });
  }

  function http(path: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const request = get({ host: '127.0.0.1', port, path, agent: false }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('error', reject);
        response.once('end', () => resolve({ status: response.statusCode ?? 0, body }));
      });
      const timer = setTimeout(() => request.destroy(new Error('HTTP request timed out')), IO_MS);
      request.once('error', reject);
      request.once('close', () => clearTimeout(timer));
    });
  }

  async function close(): Promise<void> {
    for (const socket of sockets) socket.destroy();
    await bounded(server.close(), 'shutdown', 4000);
    assert.equal(sockets.size, 0);
    assert.equal(hub.roomCount, 0);
    assert.equal(transport.rooms.size, 0);
  }

  return { port, upgrade, http, close, attached: () => attached };
}

describe('configured WebSocket routes on native localhost HTTP', () => {
  const routes = [
    ['/', ['/']],
    ['/custom/stage', ['/custom/stage']],
    ['//other/ws', ['/.//other/ws']],
    ['///other/ws', ['/.///other/ws']],
    ['/stage//ws', ['/stage//ws']],
    ['/%2F/%2f/%zz', ['/%2F/%2f/%zz']],
    ['/%E8%AA%9E/%20ws', ['/%E8%AA%9E/%20ws']],
  ] as const;

  for (const [path, originTargets] of routes) {
    it(`admits the literal ${path} route with query strings and absolute targets`, async () => {
      const fixture = await setup(path);
      try {
        const targets = [...originTargets, ...originTargets.map(target => `${target}?source=embed&next=//[`),
          `http://127.0.0.1:${fixture.port}${path}?source=absolute`];
        for (const target of targets) {
          const response = await fixture.upgrade(target);
          assert.match(response, /^HTTP\/1\.1 101 Switching Protocols\r\n/, target);
          assert.match(response, /\r\nSec-WebSocket-Accept: /i);
        }
        assert.equal(fixture.attached(), targets.length);
        assert.match(await fixture.upgrade('/not-the-configured-route'), /^HTTP\/1\.1 503 Service Unavailable\r\n/);
        assert.equal(fixture.attached(), targets.length, 'mismatched routes must not attach a session');
        assert.deepEqual(await fixture.http('/readyz'), { status: 200, body: 'ready' });
      } finally { await fixture.close(); }
    });
  }

  for (const path of ['/ws?x', '/a/../ws']) {
    it(`shows why ${path} must fail configuration despite healthy probes`, async () => {
      assert.throws(() => parseConfig(rawConfig(path)), { message: PATH_ERROR });
      // Deliberately bypass validation to preserve a native reproduction of the old failure.
      const fixture = await setup(path, false);
      try {
        const normalized = new URL(`http://x${path}`).pathname;
        assert.notEqual(normalized, path);
        for (const target of [path, normalized, `http://127.0.0.1:${fixture.port}${path}`]) {
          assert.match(await fixture.upgrade(target), /^HTTP\/1\.1 503 Service Unavailable\r\n/, target);
        }
        assert.equal(fixture.attached(), 0);
        assert.deepEqual(await fixture.http('/healthz'), { status: 200, body: 'ok' });
        assert.deepEqual(await fixture.http('/readyz'), { status: 200, body: 'ready' });
      } finally { await fixture.close(); }
    });
  }
});
