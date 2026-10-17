import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { before, describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const FIXTURES = new URL('./fixtures/windows-stage/', import.meta.url);
const SCRIPT = readFileSync(new URL('../stage.ps1', import.meta.url));
// Exact stage.ps1 blob from a05dd44e3d0627d0ae01e5798f2ec057eeadd107.
const BASELINE = readFileSync(new URL('stage-before-run-directory.ps1', FIXTURES));
const BASELINE_SHA256 = '8568a826f5e6e6e0b3d800fb1795a92abb400f0d3eb0dd964ec5ea3aab9744ea';
// Exact stage.ps1 blob from e12a02a453c666ac7c74e15e81d30d2486938036.
const PID_BASELINE = readFileSync(new URL('stage-before-pid-cleanup.ps1', FIXTURES));
const PID_BASELINE_SHA256 = '00c777cedf11524997a3dad534396d6e7dccef0067f7014fb8db64f2872a081a';
// Exact stage.ps1 blob from f62b4a2501ed502ef0b096a146c6bea1a5eccc21.
const RESTART_BASELINE = readFileSync(new URL('stage-before-restart-preflight.ps1', FIXTURES));
const RESTART_BASELINE_SHA256 = '18f1880820785524465382a867de74dd55c53047b1997c886b3e319bd30c7543';
const PROCESS_LINES = new Set([
  '& $File @Arguments',
  "Invoke-Checked 'node' @($Checker)",
  "if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail '找不到 node（需要 Node.js 24 以上）' }",
  '$major = [int](& node -p \'process.versions.node.split(".")[0]\')',
  "$major = [int](& node -p 'parseInt(process.versions.node)')",
  'if ($major -lt 24) { Fail "Node.js 版本為 $(& node --version)，需要 24 以上" }',
  "$proc = if ($id) { Get-Process -Id $id -ErrorAction SilentlyContinue } else { $null }",
  '$proc = Start-Process @startArgs',
  'Stop-Process -Id $proc.Id',
  'Stop-Process -Id $proc.Id -Force',
  'Stop-Process -InputObject $proc -Force -ErrorAction Stop',
]);

// The wrappers below cover these reviewed process operations only. This is a
// regression-fixture guard, not a sandbox for arbitrary PowerShell programs.
function assertReviewedProcessOperations(script: Buffer): void {
  for (const line of script.toString('utf8').split('\n')) {
    const code = line.trim();
    if (code.startsWith('#')) continue;
    if (/\b(?:Start-Process|Get-Process|Stop-Process|Get-Command|Invoke-Expression|Start-Job|Start-ThreadJob|taskkill|wmic)\b|^& |\(& node|^Invoke-Checked 'node'/.test(code)) {
      assert.ok(PROCESS_LINES.has(code), `Unreviewed process operation: ${code}`);
    }
  }
}

type Action = {
  command: string; code: number; failure: string | null; output: string;
  failureId: string | null; failureMessage: string | null; elapsedMs: number;
  processesAtReturn: { pid: number; hasExited: boolean; waitForExit: boolean }[];
  pidText: string | null; pidBytes: string | null; launched: number; attempts: number; stops: number;
};
type Report = {
  version: string; actions: Action[]; parseErrors: string[]; lookups: number[];
  stops: number[]; launchAttempts: number; ownedLaunches: number; error: string | null;
  objectStops: number[]; foreignObjectRejections: number;
  pidWriteFailure: { message: string; id: string } | null;
  events: { kind: string; phase: string; pid?: number; code?: number }[];
  restartEnvironment: string | null;
  cleanup: { pid: number; exited: boolean; neededCleanup: boolean }[];
};
type ChildRecord = { token: string; pid: number; cwd: string; reason?: string };
type CheckRecord = { token: string; cwd: string; argv: string[]; config: string | null };
type RestartCase = 'missing-entry' | 'entry-directory' | 'missing-checker' | 'checker-directory'
  | 'missing-config' | 'missing-default-example' | 'checker-failure' | 'node-failure' | 'missing-node' | 'old-node'
  | 'valid-absolute' | 'valid-relative' | 'valid-default' | 'valid-default-copy' | 'empty-environment-transport' | 'no-current-process';
type Scenario = `restart-${RestartCase}` | 'restart-baseline' | 'baseline' | 'fresh' | 'existing' | 'collision'
  | 'pid-baseline' | 'pid-collision' | 'pid-already-exited' | 'pid-cleanup-throw' | 'pid-cleanup-timeout';

function records(path: string): ChildRecord[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as ChildRecord);
}

function fixtureEnvironment(root: string, token: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  // Do not inherit a real configuration, preload, or another Node on PATH.
  for (const key of Object.keys(env)) {
    if (/^(?:PATH|NODE_OPTIONS|STAGE_CONFIG|STAGE_STOP_TIMEOUT|STAGE_FIXTURE_TOKEN)$/i.test(key)) delete env[key];
  }
  const oldPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? '';
  env.Path = `${dirname(process.execPath)};${oldPath}`;
  env.STAGE_FIXTURE_TOKEN = token;
  env.STAGE_STOP_TIMEOUT = '2';
  env.STAGE_CONFIG = join(root, 'config.yaml');
  return env;
}

function rawFailureProbe(shell: string, scenario: 'baseline' | 'collision' | 'restart-checker') {
  const script = scenario === 'baseline' ? BASELINE : SCRIPT;
  assertReviewedProcessOperations(script);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'stage Windows raw failure ')));
  try {
    mkdirSync(join(root, 'dist/src'), { recursive: true });
    mkdirSync(join(root, 'caller elsewhere'));
    writeFileSync(join(root, 'stage.ps1'), script);
    assert.deepEqual(readFileSync(join(root, 'stage.ps1')), script);
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, 'config.yaml'), 'synthetic: true\n');
    // Unexpected execution is recorded and exits immediately. The direct raw
    // probe cannot leave a background service even if startup regresses.
    writeFileSync(join(root, 'dist/src/index.js'), [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync('unexpected-child', 'launched');",
      'process.exit(91);',
    ].join('\n'));
    if (scenario === 'collision') writeFileSync(join(root, '.run'), 'operator file\n');
    if (scenario === 'restart-checker') {
      copyFileSync(new URL('checker.mjs', FIXTURES), join(root, 'dist/src/check-config.js'));
      writeFileSync(join(root, 'fixture-settings.json'), JSON.stringify({ checkerExit: 29 }));
    }
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(root, 'stage.ps1'), scenario === 'restart-checker' ? 'restart' : 'start'], {
      cwd: join(root, 'caller elsewhere'), env: fixtureEnvironment(root, randomBytes(16).toString('hex')),
      encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024, windowsHide: true,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0, 'observe the real PowerShell host exit code, without the driver mapping exceptions');
    assert.equal(existsSync(join(root, 'unexpected-child')), false, 'raw negative probe must fail before launching its inert entry');
    assert.equal(existsSync(join(root, '.run/stage.pid')), false);
    if (scenario === 'collision') assert.equal(readFileSync(join(root, '.run'), 'utf8'), 'operator file\n');
    else assert.equal(existsSync(join(root, '.run')), false);
    if (scenario === 'restart-checker') assert.equal(result.status, 29, 'raw PowerShell host must propagate the native checker status');
    return result;
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function runFixture(shell: string, scenario: Scenario) {
  const script = scenario === 'baseline' ? BASELINE : scenario === 'pid-baseline' ? PID_BASELINE
    : scenario === 'restart-baseline' ? RESTART_BASELINE : SCRIPT;
  const restart = scenario.startsWith('restart-');
  const restartCase = scenario === 'restart-baseline' ? 'missing-entry' : scenario.slice('restart-'.length);
  const pidCollision = scenario.startsWith('pid-');
  assertReviewedProcessOperations(script);
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'stage Windows first start ')));
  const token = randomBytes(16).toString('hex');
  const runDir = join(root, '.run');
  let report: Report | undefined;
  let driverFinished = false;
  let cleanupVerified = false;
  try {
    mkdirSync(join(root, 'dist/src'), { recursive: true });
    mkdirSync(join(root, 'caller elsewhere'));
    writeFileSync(join(root, 'stage.ps1'), script);
    assert.deepEqual(readFileSync(join(root, 'stage.ps1')), script, 'execute the shipped script bytes without fixture-only re-encoding');
    copyFileSync(new URL('entry.mjs', FIXTURES), join(root, 'dist/src/index.js'));
    copyFileSync(new URL('driver.ps1', FIXTURES), join(root, 'fixture-driver.ps1'));
    copyFileSync(new URL('checker.mjs', FIXTURES), join(root, 'dist/src/check-config.js'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src/check-config.ts'), "throw new Error('Source checker fallback must not run');\n");
    writeFileSync(join(root, 'fixture-node-failure.cjs'), "process.stdout.write('24\\n'); process.exit(23);\n");
    writeFileSync(join(root, 'fixture-node-old.cjs'), "process.stdout.write('23\\n');\n");
    writeFileSync(join(root, 'fixture-node-label.cjs'), "process.stdout.write('v23.0.0\\n');\n");
    mkdirSync(join(root, 'configuration files'));
    writeFileSync(join(root, 'configuration files/custom config.yaml'), 'custom: synthetic\n');
    writeFileSync(join(root, 'config.example.yaml'), 'copied: synthetic\n');
    writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
    writeFileSync(join(root, 'config.yaml'), 'synthetic: true\n');
    writeFileSync(join(root, 'fixture-settings.json'), JSON.stringify({
      lifecycle: scenario === 'fresh' || scenario === 'existing', pidCollision,
      restart, restartCase, skipInitialStart: restart && restartCase === 'no-current-process',
      checkerExit: restartCase === 'checker-failure' ? 29 : 0,
      exitBeforePidWrite: scenario === 'pid-already-exited',
      cleanupFailure: scenario === 'pid-cleanup-throw' ? 'throw' : scenario === 'pid-cleanup-timeout' ? 'timeout' : null,
    }));
    if (scenario === 'existing') {
      mkdirSync(runDir);
      writeFileSync(join(runDir, 'preserve-me'), 'operator data\n');
    } else if (scenario === 'collision') {
      writeFileSync(runDir, 'operator file\n');
    }
    const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(root, 'fixture-driver.ps1')], {
      cwd: join(root, 'caller elsewhere'), env: fixtureEnvironment(root, token),
      encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024, windowsHide: true,
    });
    driverFinished = !result.error && result.signal === null;
    const reportPath = join(root, 'fixture-report.json');
    if (existsSync(reportPath)) report = JSON.parse(readFileSync(reportPath, 'utf8')) as Report;
    assert.ifError(result.error);
    assert.equal(result.signal, null, 'PowerShell driver must finish within 20 seconds');
    assert.equal(result.status, 0, `driver failed: ${result.stdout}\n${result.stderr}`);
    assert.ok(report, `driver omitted its report: ${result.stdout}\n${result.stderr}`);
    assert.equal(report.error, null);
    const starts = records(join(root, 'fixture-starts.jsonl'));
    const exits = records(join(root, 'fixture-exits.jsonl'));
    for (const child of starts) {
      assert.equal(child.token, token);
      assert.equal(realpathSync.native(child.cwd), root, 'script must use its own physical spaced root, despite the caller CWD or Windows short-path aliases');
      assert.ok(Number.isSafeInteger(child.pid) && child.pid > 0);
      assert.notEqual(child.pid, process.pid);
      assert.deepEqual(JSON.parse(readFileSync(join(root, `fixture-ready-${child.pid}.json`), 'utf8')), child);
    }
    assert.equal(report.cleanup.length, report.ownedLaunches, 'each returned process must have a joined observer, even if observer acquisition fails');
    assert.equal(report.cleanup.length, starts.length, 'each launched child must have an owned process handle and readiness receipt');
    assert.ok(report.cleanup.every(child => child.exited), 'every owned child must be joined before the driver finishes');
    cleanupVerified = true;
    assert.equal(report.foreignObjectRejections, starts.length, 'a separate process object with an owned ID must be rejected');
    assert.ok(report.lookups.every(pid => starts.some(child => child.pid === pid)), 'only owned child IDs may be queried');
    assert.ok(report.stops.every(pid => starts.some(child => child.pid === pid)), 'only owned child handles may be terminated');
    assert.deepEqual(exits, scenario === 'pid-already-exited' ? starts.map(child => ({ ...child, reason: 'before-pid-write' })) : [],
      'test completion must not depend on the cleanup-file fallback or watchdog');
    return {
      report, starts, token, root, stderr: result.stderr,
      log: existsSync(join(runDir, 'stage.log')) ? readFileSync(join(runDir, 'stage.log'), 'utf8') : null,
      errLog: existsSync(join(runDir, 'stage.err.log')) ? readFileSync(join(runDir, 'stage.err.log'), 'utf8') : null,
      pidExists: existsSync(join(runDir, 'stage.pid')),
      runExists: existsSync(runDir),
      preserved: scenario === 'existing' ? readFileSync(join(runDir, 'preserve-me'), 'utf8')
        : scenario === 'collision' ? readFileSync(runDir, 'utf8')
          : pidCollision ? readFileSync(join(runDir, 'stage.pid/preserve-me'), 'utf8') : null,
      config: existsSync(join(root, 'config.yaml')) ? readFileSync(join(root, 'config.yaml'), 'utf8') : null,
      checks: existsSync(join(root, 'fixture-checks.jsonl'))
        ? readFileSync(join(root, 'fixture-checks.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as CheckRecord) : [],
    };
  } finally {
    // No process.kill, taskkill or untrusted PID-file cleanup. If the driver
    // failed before reporting retained-handle cleanup, the synthetic entry
    // exits only for its nonce-scoped file request, with a 30-second watchdog.
    writeFileSync(join(root, 'fixture-cleanup'), token);
    if (!driverFinished || !cleanupVerified) {
      await delay(35_000);
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

it('pins the immutable Windows baseline and guards reviewed process operations', () => {
  assert.equal(createHash('sha256').update(BASELINE).digest('hex'), BASELINE_SHA256);
  assert.equal(createHash('sha256').update(PID_BASELINE).digest('hex'), PID_BASELINE_SHA256);
  assert.equal(createHash('sha256').update(RESTART_BASELINE).digest('hex'), RESTART_BASELINE_SHA256);
  assert.deepEqual(SCRIPT.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]), 'non-ASCII production script needs its own UTF-8 BOM for Windows PowerShell 5.1');
  assertReviewedProcessOperations(BASELINE);
  assertReviewedProcessOperations(PID_BASELINE);
  assertReviewedProcessOperations(RESTART_BASELINE);
  assertReviewedProcessOperations(SCRIPT);
  for (const operation of ['Stop-Process -Id 1', 'Stop-Process -InputObject $other -Force', 'Microsoft.PowerShell.Management\\Stop-Process -Id 1', 'taskkill /PID 1 /F', "Invoke-Checked 'node' @($Other)"]) {
    assert.throws(() => assertReviewedProcessOperations(Buffer.concat([SCRIPT, Buffer.from(`\n${operation}\n`)])), /Unreviewed process operation/);
  }
  const text = SCRIPT.toString('utf8').replaceAll('\r\n', '\n');
  const mkdir = text.indexOf('[System.IO.Directory]::CreateDirectory($RunDir) | Out-Null');
  assert.ok(mkdir > text.indexOf('  Initialize-Config\n'));
  assert.ok(mkdir < text.indexOf('  $proc = Start-Process @startArgs'));
});

for (const [shell, major] of [['powershell.exe', 5], ['pwsh.exe', 7]] as const) {
  describe(`stage.ps1 native first start (${shell})`, {
    skip: process.platform !== 'win32' ? 'requires native Windows PowerShell; Linux does not verify stage.ps1 execution' : false,
    timeout: 180_000,
  }, () => {
    before(() => {
      const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Console]::Out.Write($PSVersionTable.PSVersion.ToString())'], {
        encoding: 'utf8', timeout: 10_000, windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, `${shell} is required, not optional: ${result.stderr}`);
      assert.match(result.stdout.trim(), major === 5 ? /^5\.1\./ : /^7\./, `unexpected ${shell} version`);
      assert.equal(Number(process.versions.node.split('.')[0]), 24, 'this dependency-free fixture is verified on Node 24');
    });

    it('passes the production quote-free Node major expression through native argument parsing', () => {
      const expression = SCRIPT.toString('utf8').match(/\$major = \[int\]\(& node -p '([^']+)'\)/)?.[1];
      assert.equal(expression, 'parseInt(process.versions.node)');
      const result = spawnSync(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        `$major = [int](& node -p '${expression}'); if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; [Console]::Out.Write($major)`,
      ], {
        env: fixtureEnvironment(tmpdir(), randomBytes(16).toString('hex')),
        encoding: 'utf8', timeout: 10_000, windowsHide: true,
      });
      assert.ifError(result.error);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), '24');
    });

    it('demonstrates the immutable baseline cannot complete first start', { timeout: 70_000 }, async t => {
      const raw = rawFailureProbe(shell, 'baseline');
      const result = await runFixture(shell, 'baseline');
      const [start] = result.report.actions;
      assert.ok(start);
      assert.notEqual(start.code, 0);
      assert.equal(start.launched, 0);
      assert.deepEqual(result.starts, []);
      assert.equal(result.runExists, false);
      assert.equal(result.pidExists, false);
      if (result.report.parseErrors.length > 0) {
        assert.equal(major, 5, 'PowerShell 7 must reach the missing-directory failure');
        assert.equal(result.report.launchAttempts, 0);
        t.diagnostic(`Raw UTF-8 baseline parser diagnostics on ${result.report.version}: ${result.report.parseErrors.join(' | ')}`);
      } else if (major === 5 && result.report.launchAttempts === 0) {
        assert.match(raw.stderr, /SyntaxError/);
        assert.match(raw.stderr, /split\(\.\)|Unexpected token/);
        t.diagnostic(`Raw baseline reached the legacy native-argument quote failure on ${result.report.version}`);
      } else {
        assert.equal(result.report.launchAttempts, 1, 'baseline must reach native Start-Process redirect validation');
        assert.match(start.failure ?? result.stderr, /\.run|stage\.log|stage\.err\.log/i);
      }
      t.diagnostic(`${shell} ${result.report.version}: raw baseline host exit ${raw.status}; driver command result ${start.code}`);
    });

    for (const scenario of ['fresh', 'existing'] as const) {
      it(`${scenario} .run supports first start, logs, duplicate rejection and force-stop`, { timeout: 70_000 }, async t => {
        const result = await runFixture(shell, scenario);
        const { report } = result;
        assert.deepEqual(report.parseErrors, [], 'shipped stage.ps1 must parse without fixture-only encoding changes');
        assert.deepEqual(report.actions.map(action => action.command), ['start', 'status', 'logs', 'start', 'stop', 'status', 'stop']);
        assert.deepEqual(report.actions.map(action => action.code), [0, 0, 0, 1, 0, 3, 0], JSON.stringify(report.actions));
        assert.equal(result.starts.length, 1, 'duplicate start must not launch another child');
        const child = result.starts[0]!;
        assert.equal(report.actions[0]!.pidText, String(child.pid));
        assert.equal(report.actions[1]!.pidText, String(child.pid));
        assert.equal(report.actions[3]!.pidText, String(child.pid), 'duplicate rejection must preserve the original PID');
        assert.equal(report.launchAttempts, 1);
        assert.deepEqual(report.stops, [child.pid], 'stop uses the real Windows termination operation only once');
        assert.deepEqual(report.objectStops, [], 'ordinary stop behavior remains ID-based');
        assert.deepEqual(report.cleanup, [{ pid: child.pid, exited: true, neededCleanup: false }]);
        assert.match(report.actions[2]!.output, new RegExp(`fixture stdout ${result.token}`));
        assert.match(report.actions[2]!.output, new RegExp(`fixture stderr ${result.token}`));
        assert.match(result.log ?? '', new RegExp(`fixture stdout ${result.token}`));
        assert.match(result.errLog ?? '', new RegExp(`fixture stderr ${result.token}`));
        assert.equal(result.pidExists, false);
        assert.equal(result.runExists, true);
        assert.equal(result.config, 'synthetic: true\n');
        if (scenario === 'existing') assert.equal(result.preserved, 'operator data\n');
        t.diagnostic(`${shell} ${report.version}: ${report.actions.map(action => `${action.command}=${action.code}`).join(', ')}`);
      });
    }

    it('preserves a .run file collision and fails before launching a child', { timeout: 70_000 }, async t => {
      const raw = rawFailureProbe(shell, 'collision');
      const result = await runFixture(shell, 'collision');
      assert.deepEqual(result.report.parseErrors, []);
      const [start] = result.report.actions;
      assert.ok(start);
      assert.notEqual(start.code, 0);
      assert.equal(result.report.launchAttempts, 0);
      assert.deepEqual(result.starts, []);
      assert.deepEqual(result.report.stops, []);
      assert.equal(result.preserved, 'operator file\n');
      assert.equal(result.pidExists, false);
      t.diagnostic(`${shell} ${result.report.version}: raw collision host exit ${raw.status}; driver command result ${start.code}`);
    });

    for (const scenario of ['pid-baseline', 'pid-collision', 'pid-already-exited', 'pid-cleanup-throw', 'pid-cleanup-timeout'] as const) {
      it(`${scenario} preserves the PID write error and observes cleanup before harness finally`, { timeout: 70_000 }, async t => {
        const result = await runFixture(shell, scenario);
        const { report } = result;
        assert.deepEqual(report.parseErrors, []);
        const [start] = report.actions;
        assert.ok(start);
        assert.notEqual(start.code, 0);
        assert.equal(report.launchAttempts, 1);
        assert.equal(result.starts.length, 1);
        const child = result.starts[0]!;
        assert.ok(report.pidWriteFailure, 'observe the real native Set-Content failure');
        assert.equal(start.failureMessage, report.pidWriteFailure.message, 'cleanup must preserve the original write exception');
        assert.equal(start.failureId, report.pidWriteFailure.id, 'cleanup must preserve the original write error ID');
        assert.deepEqual(report.lookups, [], 'failed persistence must not look up a process through the invalid PID path');
        const alreadyExited = scenario === 'pid-already-exited';
        const stopped = scenario === 'pid-collision' || alreadyExited;
        const attemptsStop = scenario !== 'pid-baseline' && !alreadyExited;
        assert.deepEqual(start.processesAtReturn, [{ pid: child.pid, hasExited: stopped, waitForExit: stopped }],
          'snapshot is captured as start returns, before driver finally can terminate the child');
        assert.deepEqual(report.stops, attemptsStop ? [child.pid] : []);
        assert.deepEqual(report.objectStops, attemptsStop ? [child.pid] : [], 'production cleanup must use the exact returned Process object');
        assert.deepEqual(report.cleanup, [{ pid: child.pid, exited: true, neededCleanup: !stopped }]);
        assert.equal(result.preserved, 'operator data');
        assert.equal(result.pidExists, true, 'do not remove or replace the operator-owned invalid PID path');
        assert.equal(start.pidText, null);
        assert.doesNotMatch(`${start.output}\n${result.stderr}`, /已啟動|已停止/, 'failed starts must not report lifecycle success');
        if (scenario === 'pid-cleanup-throw') {
          assert.match(result.stderr, /Synthetic owned-process stop failure/);
          assert.doesNotMatch(start.failure ?? '', /Synthetic owned-process stop failure/);
        } else if (scenario === 'pid-cleanup-timeout') {
          assert.match(result.stderr, /5 秒內未結束/);
          assert.ok(start.elapsedMs >= 4500, 'exercise the real bounded WaitForExit, not a simulated timeout');
        } else {
          assert.equal(result.stderr, '', 'successful cleanup and baseline failure add no secondary cleanup diagnostic');
        }
        t.diagnostic(`${shell} ${report.version}: ${scenario}; return hasExited=${stopped}, waitForExit=${stopped}; exact-object stops=${report.objectStops.length}; harness neededCleanup=${!stopped}`);
      });
    }

    it('raw restart propagates a native checker failure without launching a child', () => {
      rawFailureProbe(shell, 'restart-checker');
    });

    it('immutable preflight baseline stops its healthy child before discovering the missing replacement', { timeout: 70_000 }, async t => {
      const { report, starts, checks } = await runFixture(shell, 'restart-baseline');
      assert.deepEqual(report.parseErrors, []);
      assert.deepEqual(report.actions.map(action => action.command), ['start', 'restart']);
      const [start, restart] = report.actions;
      assert.ok(start && restart);
      assert.equal(start.code, 0);
      assert.equal(starts.length, 1);
      const old = starts[0]!;
      assert.deepEqual(start.processesAtReturn, [{ pid: old.pid, hasExited: false, waitForExit: false }]);
      assert.equal(restart.code, 1);
      assert.deepEqual(restart.processesAtReturn, [{ pid: old.pid, hasExited: true, waitForExit: true }]);
      assert.equal(restart.pidBytes, null, 'baseline has already deleted the healthy service PID');
      assert.equal(restart.launched, 1);
      assert.equal(restart.attempts, 1);
      assert.deepEqual(report.stops, [old.pid]);
      assert.deepEqual(checks, []);
      assert.deepEqual(report.cleanup, [{ pid: old.pid, exited: true, neededCleanup: false }]);
      t.diagnostic(`${shell} ${report.version}: immutable baseline caused a preventable outage before harness cleanup`);
    });

    for (const scenario of ['missing-entry', 'entry-directory', 'missing-checker', 'checker-directory',
      'missing-config', 'missing-default-example', 'checker-failure', 'node-failure', 'missing-node', 'old-node'] as const) {
      it(`restart ${scenario} preserves the healthy child before harness finally`, { timeout: 70_000 }, async t => {
        const { report, starts, checks, token, root } = await runFixture(shell, `restart-${scenario}`);
        assert.deepEqual(report.parseErrors, []);
        assert.deepEqual(report.actions.map(action => action.command), ['start', 'restart']);
        const [start, restart] = report.actions;
        assert.ok(start && restart);
        assert.equal(start.code, 0);
        assert.equal(starts.length, 1);
        const old = starts[0]!;
        assert.deepEqual(start.processesAtReturn, [{ pid: old.pid, hasExited: false, waitForExit: false }]);
        assert.equal(restart.code, scenario === 'checker-failure' ? 29 : scenario === 'node-failure' ? 23 : 1,
          'native preflight failure status must reach the script caller');
        assert.equal(restart.pidText, String(old.pid));
        assert.ok(start.pidBytes);
        assert.equal(restart.pidBytes, start.pidBytes, 'preserve the original PID file byte-for-byte');
        assert.deepEqual(restart.processesAtReturn, [{ pid: old.pid, hasExited: false, waitForExit: false }],
          'observe live old child before harness finally can conceal an outage');
        assert.equal(restart.launched, 1);
        assert.equal(restart.attempts, 1);
        assert.equal(restart.stops, 0);
        assert.deepEqual(report.stops, []);
        assert.deepEqual(report.objectStops, []);
        assert.deepEqual(report.lookups, [], 'preflight rejection must not enter the existing stop/start process path');
        assert.deepEqual(report.cleanup, [{ pid: old.pid, exited: true, neededCleanup: true }]);
        assert.doesNotMatch(restart.output, /已啟動|已停止/);
        const events = report.events.filter(event => event.phase === 'restart');
        assert.deepEqual(events.map(event => event.kind), scenario === 'checker-failure'
          ? ['node-version', 'checker', 'checker-exit']
          : scenario === 'missing-node' ? ['node-missing']
            : scenario === 'old-node' ? ['node-version', 'node-label'] : ['node-version']);
        assert.deepEqual(checks, scenario === 'checker-failure'
          ? [{ token, cwd: root, argv: [], config: join(root, 'config.yaml') }] : []);
        if (scenario === 'checker-failure') assert.equal(events.at(-1)?.code, 29);
        t.diagnostic(`${shell} ${report.version}: ${scenario} exits ${restart.code}; old PID unchanged and alive, zero stops/new launches`);
      });
    }

    for (const scenario of ['valid-absolute', 'valid-relative', 'valid-default', 'valid-default-copy', 'empty-environment-transport', 'no-current-process'] as const) {
      it(`restart ${scenario} checks the inherited config selection before the existing stop/start`, { timeout: 70_000 }, async t => {
        const { report, starts, checks, token, root, config } = await runFixture(shell, `restart-${scenario}`);
        const hasOld = scenario !== 'no-current-process';
        assert.deepEqual(report.parseErrors, []);
        assert.deepEqual(report.actions.map(action => action.command), hasOld ? ['start', 'restart'] : ['restart']);
        assert.ok(report.actions.every(action => action.code === 0), JSON.stringify(report.actions));
        assert.equal(starts.length, hasOld ? 2 : 1);
        const replacement = starts.at(-1)!;
        const restart = report.actions.at(-1)!;
        const old = hasOld ? starts[0]! : null;
        assert.equal(restart.pidText, String(replacement.pid));
        assert.equal(restart.launched, starts.length);
        assert.equal(restart.attempts, starts.length);
        assert.deepEqual(restart.processesAtReturn, [
          ...(old ? [{ pid: old.pid, hasExited: true, waitForExit: true }] : []),
          { pid: replacement.pid, hasExited: false, waitForExit: false },
        ]);
        assert.deepEqual(report.stops, old ? [old.pid] : []);
        assert.deepEqual(report.objectStops, [], 'ordinary stop retains its existing ID-based behavior');
        assert.deepEqual(report.cleanup, [
          ...(old ? [{ pid: old.pid, exited: true, neededCleanup: false }] : []),
          { pid: replacement.pid, exited: true, neededCleanup: true },
        ]);
        assert.deepEqual(report.events.filter(event => event.phase === 'restart').map(event => event.kind), [
          'node-version', 'checker', 'checker-exit', ...(hasOld ? ['stop'] : []), 'node-version', 'launch',
        ], 'successful built checker must complete before stop or replacement launch');
        assert.equal(report.events.find(event => event.kind === 'checker-exit')?.code, 0);
        // The synthetic checker always accepts these transport cases. A real
        // checker rejects preserved empty STAGE_CONFIG, covered by configCheck.
        assert.deepEqual(checks, [{ token, cwd: root, argv: [], config: report.restartEnvironment }],
          'checker receives zero positional arguments, unchanged environment and script-root CWD');
        if (scenario === 'valid-relative') assert.equal(report.restartEnvironment, 'configuration files/custom config.yaml');
        else if (scenario === 'valid-default' || scenario === 'valid-default-copy') assert.equal(report.restartEnvironment, null);
        else if (scenario === 'empty-environment-transport') assert.ok(report.restartEnvironment === null || report.restartEnvironment === '',
          'Windows PowerShell may normalize an empty environment variable to absent');
        else assert.equal(report.restartEnvironment, join(root, 'config.yaml'));
        assert.equal(config, scenario === 'valid-default-copy' ? 'copied: synthetic\n' : 'synthetic: true\n');
        t.diagnostic(`${shell} ${report.version}: ${scenario}; checker completed before stop, replacement is alive at return`);
      });
    }
  });
}
