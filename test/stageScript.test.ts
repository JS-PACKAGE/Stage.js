import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = readFileSync(new URL('../stage.sh', import.meta.url), 'utf8');
const FAKE_PID = '2147483647';
const SHELL = '/bin/sh';
const MOCKED_CALLS = new Set([
  'if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then',
  'sleep 1',
  'if kill -0 "$pid" 2>/dev/null; then',
  'kill -TERM "$pid"',
  'while kill -0 "$pid" 2>/dev/null; do',
  'kill -KILL "$pid" 2>/dev/null || true',
]);

// Reject command/builtin/path-qualified calls before sourcing: they could bypass
// shell-function mocks. A changed invocation requires reviewing this fixture.
function assertMockableScript(): void {
  for (const line of SCRIPT.split('\n')) {
    const code = line.trim();
    if (!code.startsWith('#') && /\b(?:kill|sleep)\b/.test(code)) {
      assert.ok(MOCKED_CALLS.has(code), `Unreviewed process operation: ${code}`);
    }
  }
}

const HARNESS = String.raw`
kill() {
  printf 'kill %s\n' "$*" >> "$TRACE"
  [ "$#" -eq 2 ] && [ "$2" = "$FAKE_PID" ] || exit 91
  case "$1" in
    -TERM|-KILL) return 0 ;;
    -0)
      count=$(cat "$COUNT")
      count=$((count + 1))
      printf '%s\n' "$count" > "$COUNT"
      [ "$count" -le "$ALIVE_CHECKS" ] ;;
    *) exit 92 ;;
  esac
}
sleep() {
  printf 'sleep %s\n' "$*" >> "$TRACE"
  [ "$#" -eq 1 ] && [ "$1" = 1 ] || exit 93
}
# Invalid restart must not reach start. Never launch a Node server on regression.
node() { printf 'node %s\n' "$*" >> "$TRACE"; return 94; }
nohup() { printf 'nohup %s\n' "$*" >> "$TRACE"; return 95; }
. "$0"
`;

type Options = {
  command?: 'stop' | 'restart' | 'status' | 'help';
  timeout?: string;
  aliveChecks?: number;
  pidFile?: boolean;
};

function runScript({ command = 'stop', timeout, aliveChecks = 32, pidFile = true }: Options = {}) {
  assertMockableScript();
  const root = mkdtempSync(join(tmpdir(), 'stage-script-test-'));
  try {
    const script = join(root, 'stage.sh');
    const pid = join(root, '.run', 'stage.pid');
    const trace = join(root, 'trace');
    const count = join(root, 'count');
    writeFileSync(script, SCRIPT);
    mkdirSync(join(root, '.run'));
    if (pidFile) writeFileSync(pid, `${FAKE_PID}\n`);
    writeFileSync(trace, '');
    writeFileSync(count, '0\n');
    const env: NodeJS.ProcessEnv = {
      ...process.env, TRACE: trace, COUNT: count, FAKE_PID, ALIVE_CHECKS: String(aliveChecks),
    };
    delete env.STAGE_STOP_TIMEOUT;
    if (timeout !== undefined) env.STAGE_STOP_TIMEOUT = timeout;
    const result = spawnSync(SHELL, ['-c', HARNESS, script, command], {
      cwd: root, env, encoding: 'utf8', timeout: 5_000, maxBuffer: 64 * 1024,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'fixture shell must finish within its timeout');
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      trace: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
      pid: existsSync(pid) ? readFileSync(pid, 'utf8') : undefined,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function forcedTrace(seconds: number): string[] {
  return [
    `kill -0 ${FAKE_PID}`, `kill -TERM ${FAKE_PID}`,
    ...Array.from({ length: seconds }, () => [`kill -0 ${FAKE_PID}`, 'sleep 1']).flat(),
    `kill -0 ${FAKE_PID}`, `kill -KILL ${FAKE_PID}`,
  ];
}

// The Windows control script has separate termination semantics; these tests
// exercise POSIX shell behavior without any real service, sleep, or PID signal.
const skip = process.platform === 'win32' ? 'stage.sh is POSIX-only; stage.ps1 is separate'
  : !existsSync(SHELL) ? 'POSIX /bin/sh is unavailable' : false;
describe('stage.sh stop timeout', { skip }, () => {
  const invalid = [
    'abc', '1.5', '-1', '-0', '+1', ' 2', '2 ', '1 2', '\t2', '2\n',
    '1e2', '0x10', '１２', '2; exit 0', '2147483648', '0002147483648',
    '999999999999999999999999',
  ];
  for (const command of ['stop', 'restart'] as const) {
    for (const timeout of invalid) {
      it(`${command} rejects ${JSON.stringify(timeout)} before probing or changing its PID`, () => {
        const result = runScript({ command, timeout });
        assert.deepEqual(result.trace, [], 'invalid timeout must not probe, signal, sleep, or start');
        assert.equal(result.status, 1);
        assert.equal(result.stdout, '');
        assert.equal(result.pid, `${FAKE_PID}\n`);
        assert.match(result.stderr, /^stage: [^\r\n]*STAGE_STOP_TIMEOUT[^\r\n]*\n$/);
        assert.match(result.stderr, /2147483647/);
        assert.doesNotMatch(result.stderr, /Illegal number|integer expression|out of range/i);
      });
    }
  }

  for (const timeout of [undefined, '']) {
    it(`uses the 15-second default when timeout is ${timeout === undefined ? 'unset' : 'empty'}`, () => {
      const result = runScript({ timeout });
      assert.equal(result.status, 0);
      assert.deepEqual(result.trace, forcedTrace(15));
      assert.equal(result.stderr, '15 秒內未結束，強制終止\n');
      assert.equal(result.stdout, `已停止（pid ${FAKE_PID}）\n`);
      assert.equal(result.pid, undefined);
    });
  }

  for (const timeout of ['0', '0000', '2', '0002', '08', `${'0'.repeat(64)}2`]) {
    it(`accepts decimal ${JSON.stringify(timeout)} and forces termination after its wait budget`, () => {
      const result = runScript({ timeout });
      assert.equal(result.status, 0);
      assert.deepEqual(result.trace, forcedTrace(Number(timeout)));
      assert.match(result.stderr, /^\d+ 秒內未結束，強制終止\n$/);
      assert.equal(result.stdout, `已停止（pid ${FAKE_PID}）\n`);
      assert.equal(result.pid, undefined);
    });
  }

  for (const timeout of ['15', '2147483647', '0002147483647']) {
    it(`allows graceful exit within timeout ${timeout} without KILL`, () => {
      const result = runScript({ timeout, aliveChecks: 3 });
      assert.equal(result.status, 0);
      assert.deepEqual(result.trace, [
        `kill -0 ${FAKE_PID}`, `kill -TERM ${FAKE_PID}`,
        `kill -0 ${FAKE_PID}`, 'sleep 1', `kill -0 ${FAKE_PID}`, 'sleep 1', `kill -0 ${FAKE_PID}`,
      ]);
      assert.equal(result.stderr, '');
      assert.equal(result.stdout, `已停止（pid ${FAKE_PID}）\n`);
      assert.equal(result.pid, undefined);
    });
  }

  it('does not wait or force termination when TERM immediately ends the process', () => {
    const result = runScript({ timeout: '0', aliveChecks: 1 });
    assert.equal(result.status, 0);
    assert.deepEqual(result.trace, [`kill -0 ${FAKE_PID}`, `kill -TERM ${FAKE_PID}`, `kill -0 ${FAKE_PID}`]);
    assert.equal(result.stderr, '');
    assert.equal(result.pid, undefined);
  });

  it('keeps stop idempotent when no PID file exists', () => {
    const result = runScript({ timeout: '0', pidFile: false });
    assert.equal(result.status, 0);
    assert.deepEqual(result.trace, []);
    assert.equal(result.stdout, '未在執行\n');
    assert.equal(result.stderr, '');
    assert.equal(result.pid, undefined);
  });

  it('removes a stale PID file without sending TERM or KILL', () => {
    const result = runScript({ timeout: '2', aliveChecks: 0 });
    assert.equal(result.status, 0);
    assert.deepEqual(result.trace, [`kill -0 ${FAKE_PID}`]);
    assert.equal(result.stdout, '未在執行\n');
    assert.equal(result.stderr, '');
    assert.equal(result.pid, undefined);
  });

  it('still validates an invalid stop timeout when no PID file exists', () => {
    const result = runScript({ timeout: 'abc', pidFile: false });
    assert.equal(result.status, 1);
    assert.deepEqual(result.trace, []);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^stage: [^\r\n]*STAGE_STOP_TIMEOUT[^\r\n]*\n$/);
    assert.equal(result.pid, undefined);
  });

  it('preserves status exit code 3 without applying stop-only validation', () => {
    const result = runScript({ command: 'status', timeout: 'abc', pidFile: false });
    assert.equal(result.status, 3);
    assert.deepEqual(result.trace, []);
    assert.equal(result.stdout, '未在執行\n');
    assert.equal(result.stderr, '');
  });

  it('allows help even with an invalid stop timeout', () => {
    const result = runScript({ command: 'help', timeout: 'abc', pidFile: false });
    assert.equal(result.status, 0);
    assert.deepEqual(result.trace, []);
    assert.match(result.stdout, /STAGE_STOP_TIMEOUT/);
    assert.equal(result.stderr, '');
  });
});
