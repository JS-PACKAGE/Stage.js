import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { parse, stringify } from 'yaml';
import type { AppConfig } from '../src/config.ts';

const SCRIPT = readFileSync(new URL('../stage.sh', import.meta.url), 'utf8');
const EXAMPLE = readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8');
const CHECK_SOURCE = readFileSync(new URL('../src/check-config.ts', import.meta.url), 'utf8');
const CONFIG_SOURCE = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8');
const YAML_DIR = dirname(createRequire(import.meta.url).resolve('yaml/package.json'));
const FAKE_PID = '2147483647';
const SECRET = 'SYNTHETIC_RESTART_SECRET_f8a693';
const PROCESS_LINES = new Set([
  '用法：./stage.sh <command> [args]',
  'command -v node >/dev/null 2>&1 || die "找不到 node（需要 Node.js 24 以上）"',
  'major=$(node -p \'process.versions.node.split(".")[0]\')',
  '[ "$major" -ge 24 ] || die "Node.js 版本為 $(node --version)，需要 24 以上"',
  'if kill -0 "$pid" 2>/dev/null; then',
  'cmd_install() { check_node; npm ci; }',
  'cmd_build() { check_node; npm run build; }',
  'nohup node "$ENTRY" >>"$LOG_FILE" 2>&1 &',
  'sleep 1',
  'kill -TERM "$pid"',
  'while kill -0 "$pid" 2>/dev/null; do',
  'kill -KILL "$pid" 2>/dev/null || true',
  'node "$CHECKER"',
  'install      安裝依賴（npm ci）',
  'run) check_node; ensure_config; exec node "$ENTRY" ;;',
  'dev) check_node; ensure_config; exec npm run dev ;;',
  'test) check_node; npm run typecheck; npm test ;;',
]);

// Reject wrappers and path-qualified process operations before sourcing anything.
// Only the exact checker call below can reach a real Node process; all service
// probes, signals, delays and launches stay inside shell functions.
function assertMockableScript(script: string): void {
  for (const line of script.split('\n')) {
    const code = line.trim();
    if (!code.startsWith('#') && /\b(?:kill|sleep|node|nohup|npm|npx|exec|eval|env|setsid|bash|dash|sh|python|python3|perl|ruby|curl|wget)\b/.test(code)) {
      assert.ok(PROCESS_LINES.has(code), `Unreviewed process operation: ${code}`);
    }
  }
}

// Defense-in-depth assertions for the checker fixture, not an OS sandbox. Only
// YAML is installed, and the actual service entry is an inert failure sentinel.
const GUARD = `
import net from 'node:net';
import dgram from 'node:dgram';
import workerThreads from 'node:worker_threads';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const forbidden = () => { throw new Error('Checker attempted a listener, socket, worker or child process'); };
net.Server.prototype.listen = forbidden;
net.Socket.prototype.connect = forbidden;
dgram.createSocket = forbidden;
workerThreads.Worker = class { constructor() { forbidden(); } };
for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) childProcess[name] = forbidden;
process.kill = forbidden;
syncBuiltinESMExports();
`;

const HARNESS = String.raw`
command() {
  [ "$#" -eq 2 ] && [ "$1" = -v ] && [ "$2" = node ] || exit 90
  printf 'node-available\n' >> "$TRACE"
  [ "$MISSING_NODE" = 0 ]
}
node() {
  if [ "$#" -eq 2 ] && [ "$1" = -p ] && [ "$2" = 'process.versions.node.split(".")[0]' ]; then
    printf 'node-version\n' >> "$TRACE"
    printf '%s\n' "$NODE_MAJOR"
  elif [ "$#" -eq 1 ] && [ "$1" = --version ]; then
    printf 'node-version-label\n' >> "$TRACE"
    printf 'v%s.0.0\n' "$NODE_MAJOR"
  elif [ "$#" -eq 1 ] && [ "$1" = "$ROOT/dist/src/check-config.js" ]; then
    printf 'checker\n' >> "$TRACE"
    if "$REAL_NODE" --import "$ROOT/guard.mjs" "$1"; then
      printf 'checker-valid\n' >> "$TRACE"
      printf 'checked\n' > "$CHECKED"
    else
      return "$?"
    fi
  else
    printf 'blocked-node\n' >> "$TRACE"
    return 91
  fi
}
kill() {
  [ "$#" -eq 2 ] || exit 92
  if [ "$2" = "$FAKE_PID" ]; then
    printf 'kill %s\n' "$*" >> "$TRACE"
    case "$1" in
      -0) [ "$STALE_PID" = 0 ] && [ ! -f "$STOPPED" ] ;;
      -TERM) printf 'stopped\n' > "$STOPPED" ;;
      -KILL) return 0 ;;
      *) exit 93 ;;
    esac
  elif [ "$1" = -0 ] && [ -f "$LAUNCHED" ] && [ "$2" = "$(cat "$PID_FILE")" ]; then
    printf 'kill -0 started\n' >> "$TRACE"
  else
    exit 94
  fi
}
nohup() {
  [ "$#" -eq 2 ] && [ "$1" = node ] && [ "$2" = "$ROOT/dist/src/index.js" ] || exit 95
  printf 'start\n' >> "$TRACE"
  printf 'launched\n' > "$LAUNCHED"
}
sleep() {
  [ "$#" -eq 1 ] && [ "$1" = 1 ] || exit 96
  # Join only our short-lived nohup shell function; never wait on a real service.
  wait "$pid"
  printf 'sleep 1\n' >> "$TRACE"
}
od() {
  if [ "$PID_READ_FAIL" = 1 ]; then
    printf ' 49 10\n'
    return 97
  fi
  "$OD_BIN" "$@"
}
. "$0"
`;

type Options = {
  script?: string;
  missingNode?: boolean;
  nodeMajor?: string;
  missingEntry?: boolean;
  missingChecker?: boolean;
  missingDependency?: 'yaml' | 'config';
  configText?: string;
  defaultConfigText?: string;
  configExists?: boolean;
  configPath?: string;
  absoluteConfig?: boolean;
  exampleText?: string;
  timeout?: string;
  pidContent?: string;
  pidFile?: boolean;
  pidReadFail?: boolean;
  stalePid?: boolean;
};

function fixtureText(change?: (config: AppConfig) => void): string {
  const config = parse(EXAMPLE) as AppConfig;
  config.rooms.createToken = SECRET;
  config.server.metrics.token = SECRET;
  config.rtc.turn.secret = SECRET;
  change?.(config);
  return stringify(config);
}

const VALID = fixtureText();
const INVALID_SCHEMA = fixtureText(config => { config.server.port = -1; });
const INVALID_SYNTAX = `${VALID}\nextra: [${SECRET}}\n`;

function runRestart(shell: string, options: Options = {}) {
  const scriptText = options.script ?? SCRIPT;
  assertMockableScript(scriptText);
  const root = mkdtempSync(join(tmpdir(), 'stage-restart-test-'));
  try {
    const script = join(root, 'stage.sh');
    const pidFile = join(root, '.run/stage.pid');
    const trace = join(root, 'trace');
    const config = join(root, options.configPath || 'config.yaml');
    mkdirSync(join(root, '.run'));
    mkdirSync(join(root, 'dist/src'), { recursive: true });
    mkdirSync(join(root, 'src'));
    mkdirSync(join(root, 'node_modules'));
    mkdirSync(join(root, 'caller directory'));
    writeFileSync(script, scriptText);
    writeFileSync(trace, '');
    writeFileSync(join(root, 'guard.mjs'), GUARD);
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    // Match the real built import/layout without making npm test require dist/.
    writeFileSync(join(root, 'dist/src/check-config.js'), stripTypeScriptTypes(CHECK_SOURCE).replace("'./config.ts'", "'./config.js'"));
    writeFileSync(join(root, 'dist/src/config.js'), stripTypeScriptTypes(CONFIG_SOURCE));
    writeFileSync(join(root, 'dist/src/index.js'), 'throw new Error("SERVICE_ENTRY_MUST_NOT_RUN");\n');
    // Presence of source must never make a missing built checker acceptable.
    writeFileSync(join(root, 'src/check-config.ts'), 'throw new Error("SOURCE_FALLBACK_MUST_NOT_RUN");\n');
    cpSync(YAML_DIR, join(root, 'node_modules/yaml'), { recursive: true });
    if (options.missingEntry) rmSync(join(root, 'dist/src/index.js'));
    if (options.missingChecker) rmSync(join(root, 'dist/src/check-config.js'));
    if (options.missingDependency === 'yaml') rmSync(join(root, 'node_modules/yaml'), { recursive: true });
    if (options.missingDependency === 'config') rmSync(join(root, 'dist/src/config.js'));
    if (options.pidFile !== false) writeFileSync(pidFile, options.pidContent ?? `${FAKE_PID}\n`);
    writeFileSync(join(root, 'config.example.yaml'), options.exampleText ?? VALID);
    if (options.configExists !== false) {
      mkdirSync(dirname(config), { recursive: true });
      writeFileSync(config, options.configText ?? VALID);
    }
    if (options.defaultConfigText !== undefined) writeFileSync(join(root, 'config.yaml'), options.defaultConfigText);
    // Restart must cd to its own root before resolving relative STAGE_CONFIG.
    writeFileSync(join(root, 'caller directory/config.yaml'), INVALID_SCHEMA);
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin', TRACE: trace, REAL_NODE: process.execPath,
      OD_BIN: existsSync('/usr/bin/od') ? '/usr/bin/od' : '/bin/od',
      MISSING_NODE: options.missingNode ? '1' : '0', NODE_MAJOR: options.nodeMajor ?? '24',
      CHECKED: join(root, 'checked'), STOPPED: join(root, 'stopped'), LAUNCHED: join(root, 'launched'),
      FAKE_PID, PID_READ_FAIL: options.pidReadFail ? '1' : '0', STALE_PID: options.stalePid ? '1' : '0',
      STAGE_STOP_TIMEOUT: options.timeout ?? '0',
    };
    if (options.configPath !== undefined) env.STAGE_CONFIG = options.absoluteConfig ? config : options.configPath;
    const result = spawnSync(shell, ['-c', HARNESS, script, 'restart'], {
      cwd: join(root, 'caller directory'), env, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'fixture must exit without persistent service work');
    assert.ok(!(result.stdout + result.stderr).includes(SECRET), 'synthetic configuration secrets must not leak');
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      trace: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
      pid: existsSync(pidFile) ? readFileSync(pidFile, 'utf8') : undefined,
      defaultConfig: existsSync(join(root, 'config.yaml')) ? readFileSync(join(root, 'config.yaml'), 'utf8') : undefined,
      selectedConfig: existsSync(config) ? readFileSync(config, 'utf8') : undefined,
      stopped: existsSync(join(root, 'stopped')),
      launched: existsSync(join(root, 'launched')),
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

type Result = ReturnType<typeof runRestart>;
function assertRetained(result: Result, diagnostic: RegExp): void {
  assert.notEqual(result.status, 0, 'preflight failure must be nonzero');
  assert.equal(result.pid, `${FAKE_PID}\n`, 'live PID must survive preflight failure');
  assert.equal(result.stopped, false, 'preflight failure must precede TERM');
  assert.equal(result.launched, false, 'preflight failure must not start a replacement');
  assert.ok(result.trace.every(line => !/^kill -(?:TERM|KILL)|^start$|^sleep /.test(line)), result.trace.join('\n'));
  assert.match(result.stderr, diagnostic);
}

function assertSuccessful(result: Result): void {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stopped, true);
  assert.equal(result.launched, true);
  assert.match(result.pid ?? '', /^[1-9][0-9]*\n$/);
  assert.notEqual(result.pid, `${FAKE_PID}\n`);
  assert.deepEqual(result.trace, [
    `kill -0 ${FAKE_PID}`, 'node-available', 'node-version', 'checker', 'checker-valid',
    `kill -0 ${FAKE_PID}`, `kill -TERM ${FAKE_PID}`, `kill -0 ${FAKE_PID}`,
    'node-available', 'node-version', 'start', 'sleep 1', 'kill -0 started',
  ]);
  assert.ok(result.stdout.indexOf('Configuration is valid.') < result.stdout.indexOf('已停止'));
  assert.ok(result.stdout.indexOf('已停止') < result.stdout.indexOf('已啟動'));
}

it('rejects unreviewed process wrappers, direct startup and checker arguments before running a fixture', () => {
  assertMockableScript(SCRIPT);
  for (const replacement of [
    'command kill -TERM "$pid"', '/bin/kill -TERM "$pid"', 'builtin kill -TERM "$pid"',
    'exec node "$ENTRY"', 'node "$ROOT/src/check-config.ts"', 'node "$CHECKER" "$cfg"',
  ]) {
    const mutated = SCRIPT.replace('  node "$CHECKER"', `  ${replacement}`);
    assert.notEqual(mutated, SCRIPT);
    assert.throws(() => assertMockableScript(mutated), /Unreviewed process operation/);
  }
});

for (const shell of ['/bin/dash', '/bin/bash']) {
  const skip = process.platform === 'win32' ? 'stage.sh is POSIX-only' : !existsSync(shell) ? `${shell} is unavailable` : false;
  describe(`stage.sh restart preflight (${shell})`, { skip }, () => {
    it('rejects missing Node before TERM, even when build/config are also missing', () => {
      const result = runRestart(shell, { missingNode: true, missingEntry: true, missingChecker: true, configExists: false });
      assertRetained(result, /找不到 node/);
      assert.deepEqual(result.trace, [`kill -0 ${FAKE_PID}`, 'node-available']);
      assert.equal(result.defaultConfig, undefined);
    });

    it('rejects old Node before TERM and before build/config checks', () => {
      const result = runRestart(shell, { nodeMajor: '23', missingEntry: true, configExists: false });
      assertRetained(result, /Node\.js 版本為 v23\.0\.0，需要 24 以上/);
      assert.deepEqual(result.trace, [`kill -0 ${FAKE_PID}`, 'node-available', 'node-version', 'node-version-label']);
      assert.equal(result.defaultConfig, undefined);
    });

    it('rejects a missing entry before checker/config processing', () => {
      const result = runRestart(shell, { missingEntry: true, missingChecker: true, configExists: false });
      assertRetained(result, /找不到 .*dist\/src\/index\.js.*build/);
      assert.equal(result.defaultConfig, undefined);
      assert.ok(!result.trace.includes('checker'));
    });

    it('requires a built checker, requests rebuild, and never falls back to source', () => {
      const result = runRestart(shell, { missingChecker: true, configExists: false });
      assertRetained(result, /找不到已建置的設定檢查器，請先執行 build/);
      assert.equal(result.defaultConfig, undefined);
      assert.ok(!result.trace.includes('checker'));
    });

    for (const missingDependency of ['yaml', 'config'] as const) {
      it(`retains the live PID when the checker cannot load ${missingDependency}`, () => {
        const result = runRestart(shell, { missingDependency });
        assertRetained(result, /ERR_MODULE_NOT_FOUND/);
        assert.deepEqual(result.trace, [`kill -0 ${FAKE_PID}`, 'node-available', 'node-version', 'checker']);
      });
    }

    for (const [name, configText, diagnostic] of [
      ['syntax', INVALID_SYNTAX, /config error: invalid YAML/],
      ['schema', INVALID_SCHEMA, /config error: server\.port/],
    ] as const) {
      it(`retains the live PID for invalid configuration ${name}`, () => {
        const result = runRestart(shell, { configText });
        assertRetained(result, diagnostic);
        assert.equal(result.defaultConfig, configText);
        assert.deepEqual(result.trace, [`kill -0 ${FAKE_PID}`, 'node-available', 'node-version', 'checker']);
      });
    }

    it('retains the live PID when an explicit config file is missing', () => {
      const result = runRestart(shell, { configPath: 'missing config.yaml', configExists: false });
      assertRetained(result, /STAGE_CONFIG 指向的檔案不存在/);
      assert.equal(result.defaultConfig, undefined);
      assert.equal(result.selectedConfig, undefined);
      assert.ok(!result.trace.includes('checker'));
    });

    it('keeps the actual checker empty-environment behavior instead of passing a default path', () => {
      const result = runRestart(shell, { configPath: '' });
      assertRetained(result, /config error: cannot read configuration file/);
      assert.equal(result.defaultConfig, VALID);
      assert.ok(result.trace.includes('checker'));
    });

    it('keeps default auto-copy for an empty override but still rejects the empty checker path', () => {
      const result = runRestart(shell, { configPath: '', configExists: false });
      assertRetained(result, /config error: cannot read configuration file/);
      assert.equal(result.defaultConfig, VALID);
      assert.match(result.stdout, /已從 config\.example\.yaml 建立 config\.yaml/);
    });

    it('validates a relative config containing spaces against the script root', () => {
      const result = runRestart(shell, { configPath: 'settings/valid config.yaml', defaultConfigText: INVALID_SCHEMA });
      assertSuccessful(result);
      assert.equal(result.selectedConfig, VALID);
      assert.equal(result.defaultConfig, INVALID_SCHEMA);
    });

    it('validates an absolute config override instead of the invalid default', () => {
      const result = runRestart(shell, { configPath: 'settings/absolute config.yaml', absoluteConfig: true, defaultConfigText: INVALID_SCHEMA });
      assertSuccessful(result);
      assert.equal(result.selectedConfig, VALID);
      assert.equal(result.defaultConfig, INVALID_SCHEMA);
    });

    it('does not fall back to a valid default when the relative override is invalid', () => {
      const result = runRestart(shell, { configPath: 'settings/invalid config.yaml', configText: INVALID_SCHEMA, defaultConfigText: VALID });
      assertRetained(result, /config error: server\.port/);
      assert.equal(result.defaultConfig, VALID);
    });

    it('checks config, then stops, then performs the existing mocked start sequence', () => {
      assertSuccessful(runRestart(shell));
    });

    it('auto-copies a missing default before validating and stopping', () => {
      const result = runRestart(shell, { configExists: false });
      assertSuccessful(result);
      assert.equal(result.defaultConfig, VALID);
      assert.ok(result.stdout.indexOf('已從 config.example.yaml') < result.stdout.indexOf('Configuration is valid.'));
    });

    it('retains the old PID if the copied example is invalid', () => {
      const result = runRestart(shell, { configExists: false, exampleText: INVALID_SCHEMA });
      assertRetained(result, /config error: server\.port/);
      assert.equal(result.defaultConfig, INVALID_SCHEMA);
      assert.match(result.stdout, /已從 config\.example\.yaml 建立 config\.yaml/);
    });

    for (const pidContent of ['0\n', '-1\n', '1\n2\n', '1\0\n']) {
      it(`preserves malformed PID ${JSON.stringify(pidContent)} before checking Node`, () => {
        const result = runRestart(shell, { pidContent, missingNode: true });
        assert.equal(result.status, 1);
        assert.equal(result.pid, pidContent);
        assert.deepEqual(result.trace, []);
        assert.match(result.stderr, /PID 檔必須包含/);
      });
    }

    it('preserves an unreadable PID and aborts before checking Node', () => {
      const result = runRestart(shell, { pidReadFail: true, missingNode: true });
      assertRetained(result, /無法讀取 PID 檔/);
      assert.deepEqual(result.trace, []);
    });

    for (const timeout of ['abc', '-1', '2147483648']) {
      it(`validates timeout ${JSON.stringify(timeout)} before malformed PID and missing Node`, () => {
        const result = runRestart(shell, { timeout, pidContent: '0\n', missingNode: true });
        assert.equal(result.status, 1);
        assert.equal(result.pid, '0\n');
        assert.deepEqual(result.trace, []);
        assert.match(result.stderr, /STAGE_STOP_TIMEOUT/);
        assert.doesNotMatch(result.stderr, /PID 檔|找不到 node/);
      });
    }

    for (const state of ['absent', 'stale'] as const) {
      it(`still checks config when the PID is ${state}`, () => {
        const result = runRestart(shell, { pidFile: state !== 'absent', stalePid: state === 'stale', configText: INVALID_SCHEMA });
        assert.equal(result.status, 1);
        assert.equal(result.pid, undefined);
        assert.equal(result.stopped, false);
        assert.equal(result.launched, false);
        assert.deepEqual(result.trace, [...(state === 'stale' ? [`kill -0 ${FAKE_PID}`] : []), 'node-available', 'node-version', 'checker']);
        assert.match(result.stderr, /config error: server\.port/);
      });
    }

    it('demonstrates that the old stop-first dispatch fails the same retention assertions', () => {
      const legacy = SCRIPT.replace('restart) cmd_restart ;;', 'restart) cmd_stop; cmd_start ;;');
      assert.notEqual(legacy, SCRIPT, 'baseline substitution must actually change the dispatch');
      const baseline = runRestart(shell, { script: legacy, configText: INVALID_SYNTAX });
      assert.equal(baseline.stopped, true, 'the old dispatch reaches only our mocked TERM');
      assert.ok(!baseline.trace.includes('checker'));
      assert.throws(() => assertRetained(baseline, /config error:/), { name: 'AssertionError' });
    });
  });
}
