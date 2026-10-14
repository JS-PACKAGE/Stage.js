import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse, stringify } from 'yaml';
import type { ClientMessage } from '../shared/protocol.ts';
import { ConfigError, parseConfig, type AppConfig } from '../src/config.ts';
import type { Logger } from '../src/log.ts';
import { ERROR_MESSAGES } from '../src/model/errors.ts';
import { parseClientMessage, ValidationError } from '../src/ws/validate.ts';
import { FakeSession, harness } from './helpers.ts';

const EXAMPLE = readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8');
const LENGTH_ERROR = 'rooms.createToken: must be at most 256 UTF-16 code units';
const STRING_ERROR = 'rooms.createToken: expected string';
const BOUNDARIES = [
  { label: 'ASCII', token: 'A'.repeat(256) },
  { label: 'astral characters', token: '\u{1f408}'.repeat(128) },
  { label: 'three-byte BMP characters', token: '\u8a9e'.repeat(256) },
  { label: 'two-byte characters', token: '\u00e9'.repeat(256) },
  { label: 'NFD combining sequences', token: 'e\u0301'.repeat(128) },
  { label: 'whitespace only', token: ' '.repeat(256) },
] as const;
const WHITESPACE_TOKEN = ' \tSYNTHETIC_CREATE_SECRET_87c2d1\r\n ';

function rawConfig(token: unknown): AppConfig {
  const raw = parse(EXAMPLE) as AppConfig;
  Reflect.set(raw.rooms, 'createToken', token);
  return raw;
}

function caught(fn: () => unknown): unknown {
  try { fn(); } catch (error) { return error; }
  return undefined;
}

function assertConfigError(raw: unknown, message: string): void {
  const error = caught(() => parseConfig(raw));
  assert.ok(error instanceof ConfigError, 'expected a configuration error');
  // Boolean checks keep even a regression from printing a credential in test output.
  assert.ok(error.message === message, 'configuration diagnostic must contain only the field and constraint');
}

function createMessage(config: AppConfig, token?: unknown): Extract<ClientMessage, { type: 'room:create' }> {
  const message = parseClientMessage(JSON.stringify({
    type: 'room:create', requestId: 'create-token-test', name: 'Host', codeRequired: false,
    ...(token === undefined ? {} : { token }),
  }), config.limits);
  assert.equal(message.type, 'room:create');
  return message as Extract<ClientMessage, { type: 'room:create' }>;
}

function assertWireError(config: AppConfig, token: unknown): void {
  const error = caught(() => createMessage(config, token));
  assert.ok(error instanceof ValidationError, 'expected a wire validation error');
  assert.equal(error.code, 'bad_request');
  assert.ok(error.detail === 'room:create: token', 'wire diagnostic must not contain the token');
  assert.ok(error.message === 'bad_request: room:create: token', 'wire error must not contain the token');
  assert.equal(error.requestId, 'create-token-test');
}

function assertNoToken(output: string, tokens: readonly string[]): void {
  for (const token of tokens) {
    if (!token) continue;
    assert.ok(!output.includes(token), 'credential must not appear in diagnostics, logs or replies');
    const escaped = JSON.stringify(token).slice(1, -1);
    assert.ok(!output.includes(escaped), 'JSON-escaped credential must not appear in logs or replies');
  }
}

describe('room creation configuration and wire contract', () => {
  for (const { label, token } of BOUNDARIES) {
    it(`preserves and authenticates exactly 256 UTF-16 units of ${label}`, async () => {
      assert.equal(token.length, 256);
      if (label !== 'ASCII' && label !== 'whitespace only') assert.ok(Buffer.byteLength(token) > 256);
      const config = parseConfig(rawConfig(token));
      assert.ok(config.rooms.createToken === token, 'configuration must preserve the exact token');
      const message = createMessage(config, token);
      assert.ok(message.token === token, 'wire validation must preserve the exact token');
      const logs: string[] = [];
      const record: Logger['debug'] = (msg, fields) => { logs.push(JSON.stringify({ msg, fields })); };
      const h = harness(config, { debug: record, info: record, warn: record, error: record });
      const session = new FakeSession();
      h.hub.attach(session);
      const wrong = `${token.slice(0, -1)}!`;
      try {
        for (const attempted of [undefined, '', wrong]) {
          await h.hub.handle(session, createMessage(config, attempted));
          const error = session.last('error');
          assert.ok(error);
          assert.equal(error.code, 'unauthorized');
          assert.ok(error.message === ERROR_MESSAGES.unauthorized, 'authentication failure stays generic');
          assert.equal(h.hub.roomCount, 0);
          assert.equal(h.transport.rooms.size, 0);
          assert.equal(h.mixers.size, 0);
          assert.equal(h.hub.isJoined(session), false);
        }
        await h.hub.handle(session, message);
        assert.ok(session.last('ok'));
        assert.ok(session.last('room:created'));
        assert.equal(h.hub.roomCount, 1);
        assert.equal(h.hub.isJoined(session), true);
      } finally { await h.hub.shutdown(); }
      assertNoToken(JSON.stringify(session.inbox), [token, wrong]);
      assertNoToken(logs.join('\n'), [token, wrong]);
    });

    it(`rejects 257 UTF-16 units of ${label} in configuration and on the wire`, () => {
      const overlong = `${token}!`;
      assert.equal(overlong.length, 257);
      assertConfigError(rawConfig(overlong), LENGTH_ERROR);
      assertWireError(parseConfig(rawConfig('')), overlong);
    });
  }

  it('does not trim whitespace or normalize NFD tokens before authentication', async () => {
    for (const token of [WHITESPACE_TOKEN, BOUNDARIES[4].token]) {
      const config = parseConfig(rawConfig(token));
      assert.ok(config.rooms.createToken === token, 'configuration must not trim or normalize');
      const exact = createMessage(config, token);
      assert.ok(exact.token === token, 'wire validation must not trim or normalize');
      const changed = token === WHITESPACE_TOKEN ? token.trim() : token.normalize('NFC');
      assert.ok(changed !== token);
      const h = harness(config);
      const session = new FakeSession();
      try {
        await h.hub.handle(session, createMessage(config, changed));
        assert.equal(session.last('error')?.code, 'unauthorized');
        assert.equal(h.hub.roomCount, 0);
        await h.hub.handle(session, exact);
        assert.ok(session.last('ok'));
        assert.equal(h.hub.roomCount, 1);
      } finally { await h.hub.shutdown(); }
      assertNoToken(JSON.stringify(session.inbox), [token, changed]);
    }
  });

  it('keeps empty configuration tokens as disabled authentication', async () => {
    const config = parseConfig(rawConfig(''));
    assert.equal(config.rooms.createToken, '');
    const missing = createMessage(config);
    assert.equal(Object.hasOwn(missing, 'token'), false);
    assert.equal(createMessage(config, '').token, '');
    for (const token of [undefined, '', 'SYNTHETIC_UNUSED_CREATE_TOKEN']) {
      const h = harness(config);
      const session = new FakeSession();
      try {
        await h.hub.handle(session, createMessage(config, token));
        assert.ok(session.last('ok'));
        assert.equal(h.hub.roomCount, 1);
      } finally { await h.hub.shutdown(); }
    }
    // Disabling authentication does not disable the wire validator's size limit.
    assertWireError(config, 'x'.repeat(257));
  });

  it('retains required-string configuration errors and optional-string wire behavior', () => {
    const missing = rawConfig('');
    Reflect.deleteProperty(missing.rooms, 'createToken');
    assertConfigError(missing, STRING_ERROR);
    for (const value of [undefined, null, false, true, 123, [], {}]) {
      assertConfigError(rawConfig(value), STRING_ERROR);
    }
    const config = parseConfig(rawConfig(''));
    for (const value of [null, false, true, 123, [], {}]) assertWireError(config, value);
    assert.equal(Object.hasOwn(createMessage(config, undefined), 'token'), false);
  });
});

// Match configCheck.test.ts's isolated layout: YAML is the only installed package,
// and builtin guards independently prevent listeners, sockets and media workers.
const GUARD = `
import net from 'node:net';
import dgram from 'node:dgram';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
const forbidden = () => { throw new Error('Config check attempted network or worker startup'); };
net.Server.prototype.listen = forbidden;
net.Socket.prototype.connect = forbidden;
dgram.createSocket = forbidden;
workerThreads.Worker = class { constructor() { forbidden(); } };
syncBuiltinESMExports();
`;

describe('offline create-token configuration checks', () => {
  let root: string;
  let nextFixture = 0;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'stage-create-token-check-'));
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'dist/src'), { recursive: true });
    mkdirSync(join(root, 'node_modules'));
    const yamlDir = dirname(createRequire(import.meta.url).resolve('yaml/package.json'));
    cpSync(yamlDir, join(root, 'node_modules/yaml'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, 'guard.mjs'), GUARD);
    const check = readFileSync(new URL('../src/check-config.ts', import.meta.url), 'utf8');
    const config = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
    writeFileSync(join(root, 'src/check-config.ts'), check);
    writeFileSync(join(root, 'src/config.ts'), config);
    // The real tsc build is checked separately; this checks emitted import/layout use.
    const builtCheck = stripTypeScriptTypes(check).replace("'./config.ts'", "'./config.js'");
    assert.ok(!builtCheck.includes("'./config.ts'"));
    writeFileSync(join(root, 'dist/src/check-config.js'), builtCheck);
    writeFileSync(join(root, 'dist/src/config.js'), stripTypeScriptTypes(config));
  });

  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  function run(layout: 'source' | 'built', token: string): { status: number | null; stdout: string; stderr: string } {
    const path = join(root, `fixture-${nextFixture++}.yaml`);
    writeFileSync(path, stringify(rawConfig(token)));
    const env = { ...process.env };
    delete env.STAGE_CONFIG;
    delete env.NODE_OPTIONS;
    delete env.NODE_NO_WARNINGS;
    const entry = join(root, layout === 'source' ? 'src/check-config.ts' : 'dist/src/check-config.js');
    const result = spawnSync(process.execPath, ['--import', join(root, 'guard.mjs'), entry, path], {
      cwd: root, env, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    });
    assert.ok(!result.error, 'isolated checker must finish within its time and output bounds');
    assert.equal(result.signal, null, 'checker must exit without persistent startup work');
    assertNoToken(result.stdout + result.stderr, [token]);
    return result;
  }

  for (const layout of ['source', 'built'] as const) {
    it(`${layout} accepts exact boundaries without creating a listener or transport`, () => {
      for (const token of [...BOUNDARIES.map(value => value.token), WHITESPACE_TOKEN, '']) {
        const result = run(layout, token);
        assert.equal(result.status, 0, 'valid create tokens must pass the offline checker');
        assert.ok(result.stdout === 'Configuration is valid.\n', 'success output must contain no config values');
        assert.ok(result.stderr === '', 'valid configuration must not emit diagnostics');
      }
    });

    it(`${layout} rejects overlong tokens with only a safe field diagnostic`, () => {
      for (const { token } of BOUNDARIES) {
        const result = run(layout, `${token}!`);
        assert.equal(result.status, 1, 'overlong create tokens must fail the offline checker');
        assert.ok(result.stdout === '', 'invalid configuration must not emit success output');
        assert.ok(result.stderr === `config error: ${LENGTH_ERROR}\n`, 'failure must contain only one safe field diagnostic');
      }
    });
  }
});
