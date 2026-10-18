import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkServerPackage } from '../scripts/check-server-package.ts';
import type { ServerPackageCheckOptions } from '../scripts/check-server-package.ts';

const dependenciesDirectory = fileURLToPath(new URL('../node_modules/', import.meta.url));
const checker = fileURLToPath(new URL('../scripts/check-server-package.ts', import.meta.url));
interface Fixture extends ServerPackageCheckOptions {
  root: string;
  repositoryDirectory: string;
  temporaryRoot: string;
  reportPath: string;
}
async function withFixture(run: (fixture: Fixture) => Promise<void>, scenario = 'success'): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'stage-server-check-test-'));
  const fixture: Fixture = {
    root, repositoryDirectory: join(root, 'source checkout'), temporaryRoot: join(root, 'checks'),
    reportPath: join(root, 'child-report.json'), dependenciesDirectory,
    startupTimeoutMs: 3_000, requestTimeoutMs: 500, shutdownTimeoutMs: 500,
  };
  try {
    for (const part of ['dist/src/transport', 'web/dist/assets', 'packages/client/dist', 'src']) await mkdir(join(fixture.repositoryDirectory, part), { recursive: true });
    await mkdir(fixture.temporaryRoot);
    await writeFile(join(fixture.repositoryDirectory, 'package.json'), JSON.stringify({ type: 'module', version: '9.8.7' }));
    await writeFile(join(fixture.repositoryDirectory, 'config.example.yaml'), JSON.stringify({
      server: { host: '192.0.2.1', port: 1, tls: { certFile: 'not-read', keyFile: 'not-read' }, metrics: { enabled: true, token: 'not-used' }, trustProxy: true },
      rtc: { iceServers: ['not-contacted'], serverIceServers: ['not-contacted'], mediaWorkers: 8, turn: { secret: 'not-used' } },
      audio: { codecWorkers: 8 }, rooms: { createToken: 'not-used' }, log: { level: 'error' },
      limits: { controlPerSecond: 7, icePerSecond: 13, handRaiseIntervalMs: 250 },
    }));
    await writeFile(join(fixture.repositoryDirectory, 'config.yaml'), 'This user config must never be parsed.');
    await writeFile(join(fixture.repositoryDirectory, 'src', 'source.js'), 'throw new Error("Checkout source was executed");');
    await writeFile(join(fixture.repositoryDirectory, 'src', 'source.ts'), 'throw new Error("Checkout TypeScript was executed");');
    await copyFile(new URL('../scripts/fixtures/server-package/server.mjs', import.meta.url), join(fixture.repositoryDirectory, 'dist/src/index.js'));
    for (const name of ['codecWorker.js', 'mediaWorker.js']) await writeFile(join(fixture.repositoryDirectory, 'dist/src/transport', name), 'export {};\n');
    await writeFile(join(fixture.repositoryDirectory, 'dist/fixture.json'), JSON.stringify({ scenario, reportPath: fixture.reportPath }));
    await writeFile(join(fixture.repositoryDirectory, 'web/dist/index.html'), '<script type="module" src="./assets/app.js"></script><link rel="stylesheet" href="./assets/app.css">');
    await writeFile(join(fixture.repositoryDirectory, 'web/dist/embed.html'), '<p>synthetic embed</p>');
    await writeFile(join(fixture.repositoryDirectory, 'web/dist/assets/app.js'), 'export const app = true;');
    await writeFile(join(fixture.repositoryDirectory, 'web/dist/assets/app.css'), 'body { color: red; }');
    for (const name of ['stage-client.js', 'stage-element.js']) await writeFile(join(fixture.repositoryDirectory, 'packages/client/dist', name), `export const name = ${JSON.stringify(name)};`);
    try { await run(fixture); }
    finally {
      assert.deepEqual(await readdir(fixture.temporaryRoot), [], 'Delivery and alternate CWD must always be removed');
      try {
        const report = JSON.parse(await readFile(fixture.reportPath, 'utf8')) as { pid: number; root: string; cwd: string; configPath: string };
        assert.throws(() => process.kill(report.pid, 0), { code: 'ESRCH' }, 'Owned server must be reaped on every outcome');
        await assert.rejects(readFile(report.configPath), { code: 'ENOENT' });
      } catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
      assert.equal(await readFile(join(fixture.repositoryDirectory, 'config.yaml'), 'utf8'), 'This user config must never be parsed.');
    }
  } finally { await rm(root, { recursive: true, force: true }); }
}
const linux = { skip: process.platform !== 'linux' };

it('rejects unsupported platforms explicitly before touching files or child processes', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const before = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
    const { checkServerPackage } = await import(${JSON.stringify(pathToFileURL(checker).href)});
    assert.deepEqual(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)), before);
    for (const platform of ['darwin', 'win32']) {
      Object.defineProperty(process, 'platform', { value: platform });
      await assert.rejects(checkServerPackage({ repositoryDirectory: '/must-not-read', temporaryRoot: '/must-not-write' }), /requires Linux.*Windows and macOS are not verified/);
    }
  `], { encoding: 'utf8', timeout: 5_000 });
  assert.equal(result.status, 0, result.stderr);
});

it('checks real HTTP/WS behavior of copied synthetic JavaScript without repository dist or user config', linux, async () => {
  await withFixture(async fixture => {
    const before = ['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name));
    const saved = { NODE_OPTIONS: process.env.NODE_OPTIONS, NODE_PATH: process.env.NODE_PATH, STAGE_CONFIG: process.env.STAGE_CONFIG };
    try {
      process.env.NODE_OPTIONS = '--import=/must-not-import.mjs';
      process.env.NODE_PATH = '/must-not-resolve';
      process.env.STAGE_CONFIG = '/must-not-read.yaml';
      await checkServerPackage(fixture);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    assert.deepEqual(['SIGINT', 'SIGTERM'].map(name => process.listenerCount(name)), before);
  });
});

it('requires built files and refuses linked artifacts, with normal build guidance', linux, async t => {
  for (const file of ['dist/src/index.js', 'dist/src/transport/codecWorker.js', 'dist/src/transport/mediaWorker.js', 'web/dist/index.html', 'packages/client/dist/stage-element.js']) {
    await t.test(`missing ${file}`, () => withFixture(async fixture => {
      await rm(join(fixture.repositoryDirectory, file));
      await assert.rejects(checkServerPackage(fixture), /artifacts are missing or invalid\. Run npm run build/);
    }));
  }
  for (const file of ['package.json', 'dist/src/index.js', 'web/dist/assets/app.js', 'packages/client/dist']) {
    await t.test(`linked ${file}`, () => withFixture(async fixture => {
      const target = join(fixture.repositoryDirectory, file);
      await rm(target, { recursive: true });
      await symlink(join(fixture.repositoryDirectory, 'src'), target);
      await assert.rejects(checkServerPackage(fixture), /artifacts are missing or invalid\. Run npm run build/);
    }));
  }
});

it('blocks checkout imports and TypeScript fallbacks using actual Node resolution', linux, async t => {
  for (const kind of ['absolute-esm', 'absolute-require', 'copied-typescript', 'workspace-link']) await t.test(kind, () => withFixture(async fixture => {
    const entry = join(fixture.repositoryDirectory, 'dist/src/index.js');
    let prefix = '';
    if (kind === 'absolute-esm') prefix = `import ${JSON.stringify(pathToFileURL(join(fixture.repositoryDirectory, 'src/source.js')).href)};`;
    if (kind === 'absolute-require') prefix = `import { createRequire } from 'node:module'; createRequire(import.meta.url)(${JSON.stringify(join(fixture.repositoryDirectory, 'src/source.js'))});`;
    if (kind === 'copied-typescript') {
      await writeFile(join(fixture.repositoryDirectory, 'dist/src/fallback.ts'), 'export {};');
      prefix = 'import "./fallback.ts";';
    }
    if (kind === 'workspace-link') {
      const modules = join(fixture.root, 'installed node_modules');
      await mkdir(modules);
      await symlink(join(fixture.repositoryDirectory, 'src'), join(modules, 'source-link'));
      await writeFile(join(fixture.repositoryDirectory, 'src/package.json'), '{"type":"module","main":"source.js"}');
      fixture.dependenciesDirectory = modules;
      prefix = 'import "source-link";';
      // Avoid unrelated dependency resolution before the blocked workspace import.
      await writeFile(entry, prefix);
    } else await writeFile(entry, prefix + '\n' + await readFile(entry, 'utf8'));
    await assert.rejects(checkServerPackage(fixture), /module escaped delivered JavaScript and installed dependencies/);
  }));
});

it('bounds malformed startup, unexpected exit and output while reaping the child', linux, async t => {
  const cases: [string, RegExp][] = [
    ['early-exit', /Server exited before checks completed.*exit 7/],
    ['ready-then-exit', /Server exited before checks completed|ECONNRESET|ECONNREFUSED|socket hang up/],
    ['never-ready', /Server startup timed out/],
    ['malformed-log', /Malformed server JSON log/],
    ['malformed-address', /Malformed server listening addresses/],
    ['foreign-address', /expected loopback ephemeral port/],
    ['startup-error', /Server emitted an error log/],
    ['output-limit', /Server output exceeded/],
    ['late-output-limit', /Server output exceeded/],
  ];
  for (const [scenario, expected] of cases) await t.test(scenario, () => withFixture(async fixture => {
    if (scenario === 'never-ready') fixture.startupTimeoutMs = 250;
    await assert.rejects(checkServerPackage(fixture), error => {
      assert.ok(error instanceof Error); assert.match(error.message, expected);
      assert.ok(error.message.length < 8_200, 'Failure diagnostics are bounded');
      return true;
    });
  }, scenario));
});

it('bounds HTTP failures including trickling bodies and verifies exact asset bytes and MIME', linux, async t => {
  const cases: [string, RegExp][] = [
    ['http-timeout', /HTTP \/healthz timed out/], ['http-trickle', /HTTP \/healthz timed out/],
    ['http-reset', /socket hang up|ECONNRESET/], ['http-overflow', /response size limit/],
    ['health-body', /healthz body/], ['not-ready', /readyz status/], ['wrong-mime', /MIME/],
    ['wrong-bytes', /differs from delivered artifact bytes/], ['wrong-asset', /assets\/app.js differs from delivered artifact bytes/],
  ];
  for (const [scenario, expected] of cases) await t.test(scenario, () => withFixture(async fixture => {
    await assert.rejects(checkServerPackage(fixture), expected);
  }, scenario));
});

it('bounds WebSocket failures and checks the hello and real SIGTERM contracts', linux, async t => {
  const cases: [string, RegExp][] = [
    ['ws-reject', /Unexpected server response: 404/], ['ws-handshake-timeout', /timed out|Opening handshake has timed out/],
    ['ws-timeout', /WebSocket hello timed out/], ['ws-early-close', /WebSocket closed before hello/],
    ['ws-malformed', /Malformed WebSocket hello/], ['ws-overflow', /Max payload size exceeded/],
    ['wrong-hello', /WebSocket hello contract/], ['wrong-close', /WebSocket shutdown contract/],
    ['nonzero-shutdown', /Server SIGTERM must exit 0/], ['ignored-shutdown', /Server SIGTERM shutdown timed out/],
  ];
  for (const [scenario, expected] of cases) await t.test(scenario, () => withFixture(async fixture => {
    await assert.rejects(checkServerPackage(fixture), expected);
  }, scenario));
});

async function waitForPendingHttp(fixture: Fixture): Promise<void> {
  const end = Date.now() + 3_000;
  while (Date.now() < end) {
    try { await readFile(fixture.reportPath + '.http'); return; }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    await delay(20);
  }
  throw new Error('Synthetic server did not receive the pending HTTP request');
}

it('abort cancels pending HTTP and reaps the owned process without installing global handlers', linux, async () => {
  await withFixture(async fixture => {
    const controller = new AbortController();
    const pending = checkServerPackage({ ...fixture, signal: controller.signal, requestTimeoutMs: 5_000 });
    void pending.catch(() => {});
    try {
      await waitForPendingHttp(fixture);
      controller.abort();
      await assert.rejects(pending, /check aborted/);
    } finally { controller.abort(); await pending.catch(() => {}); }
  }, 'http-timeout');
});

it('CLI interruption reaps its server and removes temporary delivery files', linux, async () => {
  await withFixture(async fixture => {
    const scripts = join(fixture.repositoryDirectory, 'scripts');
    await mkdir(join(scripts, 'fixtures/server-package'), { recursive: true });
    await copyFile(checker, join(scripts, 'check-server-package.ts'));
    await copyFile(new URL('../scripts/fixtures/server-package/resolution-guard.mjs', import.meta.url), join(scripts, 'fixtures/server-package/resolution-guard.mjs'));
    await symlink(dependenciesDirectory, join(fixture.repositoryDirectory, 'node_modules'), 'dir');
    const child = spawn(process.execPath, [join(scripts, 'check-server-package.ts')], { cwd: fixture.root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: fixture.temporaryRoot } });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolveExit({ code, signal }));
    });
    void exited.catch(() => {});
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, 8_000);
    try {
      await waitForPendingHttp(fixture);
      assert.ok(child.kill('SIGTERM'));
      assert.deepEqual(await exited, { code: 1, signal: null });
      assert.match(output, /check aborted/);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
    }
  }, 'http-timeout');
});
