import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const SCRIPT = readFileSync(new URL('../stage.sh', import.meta.url), 'utf8');
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
  'wait "$pid" 2>/dev/null || true',
  'node "$CHECKER"',
  'install      安裝依賴（npm ci）',
  'run) check_node; ensure_config; exec node "$ENTRY" ;;',
  'dev) check_node; ensure_config; exec npm run dev ;;',
  'test) check_node; npm run typecheck; npm test ;;',
]);

// Only reviewed shell functions may launch, signal or join the synthetic child.
function assertMockableScript(script: string): void {
  for (const line of script.split('\n')) {
    const code = line.trim();
    if (!code.startsWith('#') && /\b(?:kill|sleep|wait|node|nohup|npm|npx|exec|eval|env|setsid|bash|dash|sh|python|python3|perl|ruby|curl|wget)\b/.test(code)) {
      assert.ok(PROCESS_LINES.has(code), `Unreviewed process operation: ${code}`);
    }
  }
}

// No sockets, rooms, peers, dependencies or service source are used here.
const ENTRY = `
import { writeFileSync } from 'node:fs';
process.on('SIGTERM', () => writeFileSync(process.env.TERM_SEEN, 'ignored\\n'));
writeFileSync(process.env.READY, String(process.pid));
writeFileSync(process.env.CHILD_CWD, process.cwd());
if (process.env.CHILD_MODE === 'exited') process.exit(23);
setTimeout(() => {
  writeFileSync(process.env.WATCHDOG, 'expired\\n');
  process.exit(82);
}, 4_000);
`;

const HARNESS = String.raw`
owned_pid=
known_exited=0
reaped=0
cleanup() {
  result=$?
  trap - EXIT
  set +e
  alive=0
  if [ -n "$owned_pid" ]; then
    if [ "$known_exited" = 0 ] && command kill -0 "$owned_pid" 2>/dev/null; then alive=1; fi
    printf '%s %s %s\n' "$result" "$alive" "$reaped" > "$OUTCOME"
    # The trap owns this exact child and removes leaks even on a failed assertion.
    if [ "$known_exited" = 0 ] && [ "$reaped" = 0 ]; then
      command kill -KILL "$owned_pid" 2>/dev/null || true
      command wait "$owned_pid" 2>/dev/null || true
    fi
  fi
  exit "$result"
}
trap cleanup EXIT
node() {
  [ "$#" -eq 2 ] && [ "$1" = -p ] && [ "$2" = 'process.versions.node.split(".")[0]' ] || exit 90
  printf '24\n'
}
nohup() {
  [ "$#" -eq 2 ] && [ "$1" = node ] && [ "$2" = "$ROOT/dist/src/index.js" ] || exit 91
  exec "$REAL_NODE" "$2"
}
await_file() {
  attempts=0
  while [ ! -f "$1" ]; do
    attempts=$((attempts + 1))
    [ "$attempts" -le 200 ] || exit 92
    command sleep 0.01
  done
}
fixture_ready() {
  [ "$#" -eq 1 ] && [ "$1" = "$!" ] && [ "$1" != "$UNRELATED_PID" ] || exit 93
  owned_pid=$1
  printf '%s\n' "$owned_pid" > "$OWNED_PID"
  await_file "$READY"
  [ "$(cat "$READY")" = "$owned_pid" ] || exit 94
  if [ "$CHILD_MODE" = exited ]; then
    if command wait "$owned_pid"; then exit 95; else child_status=$?; fi
    [ "$child_status" = 23 ] || exit 96
    known_exited=1
  else
    # Prove TERM cannot end this child before testing the failed-start cleanup.
    command kill -TERM "$owned_pid"
    await_file "$TERM_SEEN"
  fi
}
kill() {
  [ "$#" -eq 2 ] && [ "$2" = "$owned_pid" ] && [ "$2" != "$UNRELATED_PID" ] || exit 97
  case "$1" in -0|-KILL) ;; *) exit 98 ;; esac
  printf 'kill %s\n' "$*" >> "$TRACE"
  # A known-reaped child must never become a real stale-PID signal in this fixture.
  [ "$known_exited" = 0 ] || return 1
  command kill "$@"
}
wait() {
  [ "$#" -eq 1 ] && [ "$1" = "$owned_pid" ] && [ "$1" != "$UNRELATED_PID" ] || exit 99
  printf 'wait %s\n' "$*" >> "$TRACE"
  if command wait "$1"; then wait_status=0; else wait_status=$?; fi
  reaped=1
  printf 'wait-result %s\n' "$wait_status" >> "$TRACE"
  return "$wait_status"
}
. "$0"
`;

type Failure = 'directory' | 'permissions' | 'full' | 'none';
type Options = { script?: string; failure?: Failure; exited?: boolean };

function runStart(shell: string, { script = SCRIPT, failure = 'directory', exited = false }: Options = {}) {
  assertMockableScript(script);
  // Synchronize the owned child, leaving the production printf/cleanup untouched.
  const capture = '  pid=$!\n';
  assert.equal(script.split(capture).length, 2, 'the readiness hook must have exactly one insertion point');
  const instrumented = script.replace(capture, `${capture}  fixture_ready "$pid"\n`);
  const root = mkdtempSync(join(tmpdir(), 'stage start failure '));
  const runDir = join(root, '.run');
  try {
    const scriptPath = join(root, 'stage.sh');
    const pidFile = join(runDir, 'stage.pid');
    const trace = join(root, 'trace');
    const outcome = join(root, 'outcome');
    const ownedPid = join(root, 'owned.pid');
    const termSeen = join(root, 'term-seen');
    const watchdog = join(root, 'watchdog');
    mkdirSync(runDir);
    mkdirSync(join(root, 'dist/src'), { recursive: true });
    mkdirSync(join(root, 'caller elsewhere'));
    writeFileSync(scriptPath, instrumented);
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, 'dist/src/index.js'), ENTRY);
    writeFileSync(join(root, 'config.yaml'), 'synthetic: true\n');
    writeFileSync(join(runDir, 'stage.log'), '');
    writeFileSync(trace, '');
    if (failure === 'directory') {
      mkdirSync(pidFile);
      writeFileSync(join(pidFile, 'preserve-me'), 'operator data\n');
    } else if (failure === 'permissions') {
      chmodSync(runDir, 0o555);
    } else if (failure === 'full') {
      symlinkSync('/dev/full', pidFile);
    }
    const result = spawnSync(shell, ['-c', HARNESS, scriptPath, 'start'], {
      cwd: join(root, 'caller elsewhere'), encoding: 'utf8', timeout: 6_000, maxBuffer: 64 * 1024,
      env: {
        PATH: '/usr/bin:/bin', REAL_NODE: process.execPath, TRACE: trace, OUTCOME: outcome,
        OWNED_PID: ownedPid, READY: join(root, 'ready'), TERM_SEEN: termSeen,
        CHILD_CWD: join(root, 'child-cwd'), WATCHDOG: watchdog, CHILD_MODE: exited ? 'exited' : 'live',
        UNRELATED_PID: String(process.pid),
      },
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'the fixture shell must finish within its bound');
    assert.ok(existsSync(ownedPid), result.stderr);
    const pid = readFileSync(ownedPid, 'utf8').trim();
    assert.match(pid, /^[1-9][0-9]*$/);
    assert.notEqual(pid, String(process.pid));
    assert.ok(existsSync(outcome), result.stderr);
    assert.equal(readFileSync(join(root, 'child-cwd'), 'utf8'), root, 'start must resolve its own root despite spaces and alternate CWD');
    assert.equal(existsSync(watchdog), false, 'cleanup must not depend on the child lifetime limit');
    if (!exited) assert.equal(readFileSync(termSeen, 'utf8'), 'ignored\n');
    if (failure === 'directory') {
      assert.ok(lstatSync(pidFile).isDirectory());
      assert.equal(readFileSync(join(pidFile, 'preserve-me'), 'utf8'), 'operator data\n');
    } else if (failure === 'permissions') {
      assert.equal(existsSync(pidFile), false);
      assert.equal(lstatSync(runDir).mode & 0o777, 0o555);
    } else if (failure === 'full') {
      assert.ok(lstatSync(pidFile).isSymbolicLink());
      assert.equal(readlinkSync(pidFile), '/dev/full');
    } else {
      assert.equal(readFileSync(pidFile, 'utf8'), `${pid}\n`);
    }
    return {
      ...result, pid, pidFile,
      trace: readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean),
      outcome: readFileSync(outcome, 'utf8').trim(),
    };
  } finally {
    if (existsSync(runDir)) chmodSync(runDir, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
}

it('rejects unreviewed startup process operations before creating the fixture', () => {
  assertMockableScript(SCRIPT);
  for (const operation of [
    'command kill -KILL "$pid"', '/bin/kill -KILL "$pid"', 'kill -KILL "$UNRELATED_PID"',
    'command wait "$pid"', '/bin/wait "$pid"', 'builtin wait "$pid"', 'wait "$UNRELATED_PID"',
    'exec node "$ENTRY"',
  ]) {
    const changed = SCRIPT.replace('  pid=$!\n', `  pid=$!\n  ${operation}\n`);
    assert.notEqual(changed, SCRIPT);
    assert.throws(() => assertMockableScript(changed), /Unreviewed process operation/);
  }
});

for (const shell of ['/bin/dash', '/bin/bash']) {
  const skip = process.platform === 'win32' ? 'stage.sh is POSIX-only' : !existsSync(shell) ? `${shell} is unavailable` : false;
  describe(`stage.sh failed PID persistence (${shell})`, { skip }, () => {
    it('proves the pre-fix write leaks a live child until the fixture cleans it up', () => {
      const baseline = SCRIPT.replace(/  if ! printf '%s\\n' "\$pid" >"\$PID_FILE"; then\n[\s\S]*?^  fi\n/m, '  printf \'%s\\n\' "$pid" >"$PID_FILE"\n');
      assert.notEqual(baseline, SCRIPT, 'baseline mutation must remove exactly the failed-write cleanup');
      const result = runStart(shell, { script: baseline });
      assert.notEqual(result.status, 0);
      assert.equal(result.outcome, `${result.status} 1 0`, 'the original child is alive and unjoined after failed start');
      assert.deepEqual(result.trace, []);
      assert.doesNotMatch(result.stdout, /已啟動/);
    });

    for (const failure of ['directory', 'permissions', 'full'] as const) {
      const unavailable = failure === 'permissions' && process.getuid?.() === 0 ? 'root bypasses fixture directory permissions'
        : failure === 'full' && !existsSync('/dev/full') ? '/dev/full is unavailable' : false;
      it(`kills and reaps only its TERM-ignoring child after ${failure} write failure`, { skip: unavailable }, () => {
        const result = runStart(shell, { failure });
        assert.equal(result.status, 1);
        assert.equal(result.outcome, '1 0 1', 'failure must be reported only after the child is gone and joined');
        assert.deepEqual(result.trace.slice(0, 2), [`kill -KILL ${result.pid}`, `wait ${result.pid}`]);
        assert.equal(result.trace.length, 3);
        assert.match(result.trace[2] ?? '', /^wait-result (?:137|265)$/);
        assert.ok(result.stderr.includes(`stage: 無法寫入 PID 檔：${result.pidFile}\n`));
        assert.doesNotMatch(result.stdout, /已啟動/);
      });
    }

    it('still reports PID-write failure when the owned child already exited', () => {
      const result = runStart(shell, { exited: true });
      assert.equal(result.status, 1);
      assert.equal(result.outcome, '1 0 1');
      assert.deepEqual(result.trace, [`kill -KILL ${result.pid}`, `wait ${result.pid}`, 'wait-result 23']);
      assert.ok(result.stderr.includes(`stage: 無法寫入 PID 檔：${result.pidFile}\n`));
      assert.doesNotMatch(result.stdout, /已啟動/);
    });

    it('keeps successful start alive with its PID file and no failed-start signals', () => {
      const result = runStart(shell, { failure: 'none' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.outcome, '0 1 0');
      assert.deepEqual(result.trace, [`kill -0 ${result.pid}`]);
      assert.match(result.stdout, /已啟動/);
      assert.equal(result.stderr, '');
    });
  });
}
