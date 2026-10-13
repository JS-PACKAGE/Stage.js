import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parse, stringify } from 'yaml';
import type { AppConfig } from '../src/config.ts';

const EXAMPLE = readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8');
const CHECK_SOURCE = readFileSync(new URL('../src/check-config.ts', import.meta.url), 'utf8');
const CONFIG_SOURCE = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
const SECRET = 'SYNTHETIC_CONFIG_SECRET_4be7f9';
const YAML_DIR = dirname(createRequire(import.meta.url).resolve('yaml/package.json'));
type Layout = 'source' | 'built';
type RunOptions = { cwd?: string; envPath?: string };

function fixtureText(change?: (config: AppConfig) => void): string {
  const config = parse(EXAMPLE) as AppConfig;
  config.rooms.createToken = SECRET;
  config.server.metrics.token = SECRET;
  config.rtc.turn.secret = SECRET;
  change?.(config);
  return stringify(config);
}

// Only YAML is installed in this isolated tree. Startup/media imports must fail before
// doing any work, and built-in networking/worker creation is blocked independently.
const GUARD = `
import net from 'node:net';
import dgram from 'node:dgram';
import workerThreads from 'node:worker_threads';
import { syncBuiltinESMExports } from 'node:module';
const forbidden = () => { throw new Error('Config check attempted a listener, socket or worker'); };
net.Server.prototype.listen = forbidden;
net.Socket.prototype.connect = forbidden;
dgram.createSocket = forbidden;
workerThreads.Worker = class { constructor() { forbidden(); } };
syncBuiltinESMExports();
`;

describe('offline configuration checker', () => {
  let root: string;
  let cwd: string;
  let valid: string;
  let invalid: string;
  let nextFixture = 0;

  function writeFixture(text: string, name = `fixture-${nextFixture++}.yaml`): string {
    const path = join(cwd, name);
    writeFileSync(path, text);
    return path;
  }

  function run(layout: Layout, args: string[] = [], options: RunOptions = {}) {
    const env = { ...process.env };
    delete env.STAGE_CONFIG;
    // Ambient preloads/warning flags must not hide leaks or run code outside the fixture.
    delete env.NODE_OPTIONS;
    delete env.NODE_NO_WARNINGS;
    if (options.envPath !== undefined) env.STAGE_CONFIG = options.envPath;
    const entry = join(root, layout === 'source' ? 'src/check-config.ts' : 'dist/src/check-config.js');
    const result = spawnSync(process.execPath, ['--import', join(root, 'guard.mjs'), entry, ...args], {
      cwd: options.cwd ?? cwd, env, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'checker must exit without starting persistent work');
    const output = result.stdout + result.stderr;
    assert.ok(!output.includes(SECRET), 'configuration values must never reach stdout or stderr');
    assert.doesNotMatch(output, /YAMLWarning|\n\s+at\s/, 'no warning excerpts or stack traces');
    return result;
  }

  function assertValid(result: ReturnType<typeof run>): void {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'Configuration is valid.\n');
    assert.equal(result.stderr, '');
  }

  function assertInvalid(result: ReturnType<typeof run>, diagnostic: RegExp): void {
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, diagnostic);
    assert.equal(result.stderr.split('\n').length, 2, 'only one diagnostic line');
  }

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'stage-config-check-'));
    cwd = join(root, 'different working directory');
    mkdirSync(cwd);
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'dist/src'), { recursive: true });
    mkdirSync(join(root, 'node_modules'));
    cpSync(YAML_DIR, join(root, 'node_modules/yaml'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, 'guard.mjs'), GUARD);
    writeFileSync(join(root, 'src/check-config.ts'), CHECK_SOURCE);
    writeFileSync(join(root, 'src/config.ts'), CONFIG_SOURCE);
    // This tests the built directory/import layout, not tsc emission. The real build is
    // verified separately; stripping also keeps this test independent of prebuilt dist/.
    const builtCheck = stripTypeScriptTypes(CHECK_SOURCE).replace("'./config.ts'", "'./config.js'");
    assert.ok(!builtCheck.includes("'./config.ts'"));
    writeFileSync(join(root, 'dist/src/check-config.js'), builtCheck);
    writeFileSync(join(root, 'dist/src/config.js'), stripTypeScriptTypes(CONFIG_SOURCE));
    writeFileSync(join(root, 'config.example.yaml'), fixtureText());
    writeFileSync(join(root, 'config.yaml'), fixtureText());
    valid = writeFixture(fixtureText(), 'valid configuration.yaml');
    invalid = writeFixture(fixtureText(config => { config.server.port = -1; }));
    // A cwd fallback would select this invalid file instead of the fixture repository's.
    writeFileSync(join(cwd, 'config.yaml'), fixtureText(config => { config.audio.sampleRate = 12345; }));
  });

  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  for (const layout of ['source', 'built'] as const) {
    describe(layout, () => {
      it('validates an explicit file without listeners, workers, TLS or asset access', () => {
        assertValid(run(layout, [valid]));
        const path = writeFixture(fixtureText(config => {
          config.server.allowInsecure = false;
          config.server.host = '0.0.0.0';
          config.server.tls = { certFile: 'absent-cert.pem', keyFile: 'absent-key.pem' };
          config.server.static = [{ mount: '/', dir: 'absent-assets', cors: false }];
          config.rtc.turn.urls = ['turn:offline.invalid:3478'];
        }));
        assertValid(run(layout, [path]));
        assert.equal(existsSync(join(cwd, '.run')), false);
        assert.equal(existsSync(join(root, '.run')), false);
      });

      it('uses explicit path before environment, and environment before repository default', () => {
        assertValid(run(layout, [valid], { envPath: invalid }));
        assertInvalid(run(layout, [invalid], { envPath: valid }), /server\.port/);
        assertValid(run(layout, [], { envPath: valid }));
        assertInvalid(run(layout, [], { envPath: invalid }), /server\.port/);
      });

      it('resolves explicit and environment relative paths against cwd, including spaces', () => {
        assertValid(run(layout, [relative(cwd, valid)]));
        assertValid(run(layout, [], { envPath: relative(cwd, valid) }));
        assertValid(run(layout, [relative(root, valid)], { cwd: root }));
      });

      it('uses the repository default independently of cwd and keeps an empty environment override', () => {
        assertValid(run(layout));
        assertInvalid(run(layout, [], { envPath: '' }), /cannot read configuration file/);
      });

      it('reports unreadable paths without echoing a secret-bearing filename or creating files', () => {
        const missing = join(cwd, `${SECRET}.yaml`);
        assertInvalid(run(layout, [missing]), /cannot read configuration file/);
        assert.equal(existsSync(missing), false);
        assertInvalid(run(layout, [cwd]), /cannot read configuration file/);
      });

      it('does not create a missing default configuration from the example', () => {
        const defaultPath = join(root, 'config.yaml');
        rmSync(defaultPath);
        try {
          assertInvalid(run(layout), /cannot read configuration file/);
          assert.equal(existsSync(defaultPath), false);
        } finally { writeFileSync(defaultPath, fixtureText()); }
      });

      it('prints help before loading configuration', () => {
        for (const help of ['-h', '--help']) {
          const result = run(layout, [help], { envPath: join(cwd, SECRET) });
          assert.equal(result.status, 0);
          assert.match(result.stdout, /^Usage:/);
          assert.match(result.stdout, /explicit path > STAGE_CONFIG > repository config\.yaml/);
          assert.equal(result.stderr, '');
        }
      });

      it('rejects malformed argument lists without echoing their contents or loading configuration', () => {
        for (const args of [[''], ['--'], ['--unknown'], [`--${SECRET}`], [valid, SECRET], ['--', valid, SECRET], ['--help', valid], ['-h', valid]]) {
          const result = run(layout, args, { envPath: join(cwd, SECRET) });
          assert.equal(result.status, 2, JSON.stringify(args));
          assert.equal(result.stdout, '');
          assert.match(result.stderr, /^Usage:/);
          assert.doesNotMatch(result.stderr, /config error:/);
        }
      });

      it('uses the option terminator for dash-prefixed paths, including a file named --help', () => {
        writeFixture(fixtureText(), '-configuration.yaml');
        writeFixture(fixtureText(), '--help');
        assertValid(run(layout, ['--', '-configuration.yaml']));
        assertValid(run(layout, ['--', '--help']));
        assertInvalid(run(layout, ['--', `-${SECRET}`]), /cannot read configuration file/);
      });

      it('retains schema and cross-field diagnostics without printing supplied values', () => {
        const cases: Array<[(config: AppConfig) => void, RegExp]> = [
          [config => { config.server.port = SECRET as unknown as number; }, /server\.port: expected integer/],
          [config => { config.audio.opus.minBitrate = config.audio.opus.maxBitrate + 1; }, /audio\.opus: minBitrate > maxBitrate/],
          [config => { config.rooms.codeLength = config.limits.codeMaxLength + 1; }, /rooms\.codeLength/],
          [config => { config.audio.jitter.playoutFrames = config.audio.mixer.maxBufferedFrames + 1; }, /audio\.jitter\.playoutFrames/],
          [config => { config.server.host = '0.0.0.0'; }, /server\.allowInsecure/],
        ];
        for (const [change, diagnostic] of cases) assertInvalid(run(layout, [writeFixture(fixtureText(change))]), diagnostic);
      });

      it('rejects oversized server timer delays with safe field diagnostics', () => {
        const fields = [
          ['limits', 'joinTimeoutMs', 0],
          ['rooms', 'controllerGraceMs', 0],
          ['rooms', 'participantGraceMs', 0],
          ['rooms', 'heartbeatIntervalMs', 1000],
        ] as const;
        for (const [section, key, min] of fields) {
          for (const invalid of [2147483648, SECRET]) {
            const path = writeFixture(fixtureText(config => { Reflect.set(config[section], key, invalid); }));
            const result = run(layout, [path]);
            assertInvalid(result, /expected integer/);
            assert.equal(result.stderr, `config error: ${section}.${key}: expected integer in [${min}, 2147483647]\n`);
          }
        }
      });

      it('keeps warning-only YAML accepted while suppressing all parser and conversion warnings', () => {
        const text = fixtureText();
        const warnings = [
          text.replace(`createToken: ${SECRET}`, `createToken: !${SECRET} ${SECRET}`),
          `%${SECRET}\n---\n${text}`,
          `%YAML 1.3 # ${SECRET}\n---\n${text}`,
          `${text}\n? [${SECRET}]\n: ignored\n`,
        ];
        for (const warning of warnings) assertValid(run(layout, [writeFixture(warning)]));
      });

      it('rejects syntax errors and multiple documents using only safe codes and positions', () => {
        const text = fixtureText();
        const malformed = [
          text.replace(`createToken: ${SECRET}`, `createToken: [${SECRET}}`),
          text.replace(`createToken: ${SECRET}`, `createToken: "${SECRET}" trailing`),
          `${text}\nrooms: ${SECRET}\n`,
          `${text}\n---\nsecret: ${SECRET}\n`,
          `${text}\nextra: !unresolved!${SECRET} value\n`,
        ];
        for (const input of malformed) {
          assertInvalid(run(layout, [writeFixture(input)]), /^config error: invalid YAML \([A-Z_]+, line \d+, column \d+\)\n$/);
        }
      });

      it('preserves valid aliases but safely rejects unresolved and excessive aliases', () => {
        const text = fixtureText();
        assertValid(run(layout, [writeFixture(text.replace(`createToken: ${SECRET}`, `createToken: &credential ${SECRET}`) + '\nextra: *credential\n')]));
        assertInvalid(run(layout, [writeFixture(`${text}\nextra: *${SECRET}\n`)]), /^config error: invalid YAML\n$/);
        const many = (name: string) => Array.from({ length: 12 }, () => `*${name}`).join(', ');
        const excessive = `${text}\na: &a [${SECRET}]\nb: &b [${many('a')}]\nc: &c [${many('b')}]\nd: [${many('c')}]\n`;
        assertInvalid(run(layout, [writeFixture(excessive)]), /^config error: invalid YAML\n$/);
      });
    });
  }
});
