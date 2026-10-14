import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename, dirname, resolve } from 'node:path';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { parse } from 'yaml';
import { parseConfig } from '../src/config.ts';
import type { Logger } from '../src/log.ts';
import type { StageServer, StageServerDeps } from '../src/ws/server.ts';

const EXAMPLE = readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8');
const SOURCE = readFileSync(new URL('../src/ws/server.ts', import.meta.url), 'utf8');
const CONSTANTS = 'const CLOSE_POLICY = 1008;';
const FACTORY = 'export function createStageServer(';
assert.equal(SOURCE.split(CONSTANTS).length, 2, 'locate exactly one production constants block');
assert.equal(SOURCE.split(FACTORY).length, 2, 'locate exactly one complete production server factory');
assert.ok(SOURCE.indexOf(CONSTANTS) < SOURCE.indexOf(FACTORY));
// Keep the complete factory and its constants, rather than copying the grouping or reload logic.
const EXECUTABLE = stripTypeScriptTypes(SOURCE.slice(SOURCE.indexOf(CONSTANTS))
  .replace(FACTORY, 'function createStageServer(')) + '\ncreateStageServer;';
const PROTOTYPE_DIRS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty'];

function configFor(certFile: string, keyFile: string) {
  const raw = parse(EXAMPLE);
  Object.assign(raw.server, { host: '127.0.0.1', port: 0, static: [],
    allowInsecure: certFile === '' && keyFile === '', tls: { certFile, keyFile } });
  return parseConfig(raw);
}

interface Timer {
  callback: () => void;
  ms: number;
  due: number;
  interval: boolean;
  active: boolean;
  unrefs: number;
  unref(): Timer;
}
interface LogEntry { level: string; message: string; fields?: Record<string, unknown> }
interface Context { cert: Buffer; key: Buffer }
type WatchCallback = (event: string, name: string | Buffer | null) => void;

function fixture(certFile = 'ordinary/cert.pem', keyFile = 'ordinary/key.pem', failWatchDirs: string[] = []) {
  const config = configFor(certFile, keyFile);
  const calls: string[] = [], reads: string[] = [], logs: LogEntry[] = [], timers: Timer[] = [];
  const creations: string[] = [], watchAttempts: string[] = [], watchers: Watcher[] = [];
  const state = { generation: 0, readErrorFile: undefined as string | undefined, contextError: undefined as Error | undefined };
  let clock = 0;
  function schedule(callback: () => void, ms: number, interval = false): Timer {
    const timer: Timer = { callback, ms, due: clock + ms, interval, active: true, unrefs: 0,
      unref() { this.unrefs++; return this; } };
    timers.push(timer);
    return timer;
  }
  function clear(timer?: Timer): void { if (timer) timer.active = false; }
  function advance(ms: number): void {
    const until = clock + ms;
    for (;;) {
      const timer = timers.filter(t => t.active && t.due <= until).sort((a, b) => a.due - b.due)[0];
      if (!timer) break;
      clock = timer.due;
      if (timer.interval) timer.due += timer.ms;
      else timer.active = false;
      timer.callback();
    }
    clock = until;
  }
  class Watcher extends EventEmitter {
    dir: string;
    change: WatchCallback;
    unrefs = 0;
    closes = 0;
    constructor(dir: string, change: WatchCallback) { super(); this.dir = dir; this.change = change; }
    unref(): this { this.unrefs++; return this; }
    close(): void { this.closes++; calls.push(`watch.close:${this.dir}`); }
  }
  class HttpServer extends EventEmitter {
    context: Context | undefined;
    contextAttempts: Context[] = [];
    setSecureContext(context: Context): void {
      this.contextAttempts.push(context);
      if (state.contextError) throw state.contextError;
      this.context = context;
    }
    close(done: () => void): void { calls.push('server.close'); done(); }
    closeAllConnections(): void { calls.push('server.closeAllConnections'); }
  }
  class SocketServer extends EventEmitter {
    close(done: () => void): void { calls.push('wss.close'); done(); }
  }
  const server = new HttpServer();
  const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level,
    (message: string, fields?: Record<string, unknown>) => { logs.push({ level, message, fields }); },
  ])) as unknown as Logger;
  const create = runInNewContext(EXECUTABLE, {
    basename, dirname, Buffer, Promise, performance,
    readFileSync(file: string) {
      reads.push(file);
      if (state.readErrorFile === file) throw new Error('synthetic read failure');
      return Buffer.from(`${state.generation}:${file}`);
    },
    watch(dir: string, change: WatchCallback) {
      watchAttempts.push(dir);
      if (failWatchDirs.includes(dir)) throw new Error('synthetic watch failure');
      const watcher = new Watcher(dir, change); watchers.push(watcher); return watcher;
    },
    createHttpsServer(context: Context) { creations.push('https'); server.context = context; return server; },
    createHttpServer() { creations.push('http'); return server; },
    createStaticHandler: () => async () => false,
    WebSocketServer: SocketServer,
    setTimeout: schedule, clearTimeout: clear,
    setInterval: (callback: () => void, ms: number) => schedule(callback, ms, true), clearInterval: clear,
  }, { filename: 'tls-watch-paths.vm.js', timeout: 1000 }) as (deps: StageServerDeps) => StageServer;
  const hub = { shutdown: async () => { calls.push('hub.shutdown'); } } as StageServerDeps['hub'];
  const stage = create({ config, hub, log, baseDir: '.', now: () => clock });
  return { config, stage, server, state, calls, reads, logs, timers, creations, watchAttempts, watchers, advance,
    pending: () => timers.filter(timer => timer.active && !timer.interval) };
}

for (const dir of [...PROTOTYPE_DIRS, 'ordinary', './__proto__', resolve('synthetic-tls', '__proto__')]) {
  it(`TLS accepts and coalesces cert/key watchers in ${dir}`, async () => {
    const certFile = `${dir}/cert.pem`, keyFile = `${dir}/key.pem`;
    const h = fixture(certFile, keyFile);
    try {
      assert.deepEqual(h.config.server.tls, { certFile, keyFile }, 'configuration preserves valid path spellings');
      assert.deepEqual(h.creations, ['https']);
      assert.deepEqual(h.reads, [certFile, keyFile]);
      assert.deepEqual(h.watchAttempts, [dir]);
      assert.equal(h.watchers[0]!.unrefs, 1);
      assert.equal(h.watchers[0]!.listenerCount('error'), 1);
      h.watchers[0]!.change('rename', 'key.pem');
      h.advance(2000);
      assert.equal(h.server.contextAttempts.length, 1, 'the grouped watcher also accepts the key basename');
      assert.deepEqual(h.reads, [certFile, keyFile, certFile, keyFile]);
    } finally { await h.stage.close(); }
    assert.equal(h.watchers[0]!.closes, 1);
  });
}

for (const [certFile, keyFile, expectedDirs] of [
  ['certs/cert.pem', 'keys/key.pem', ['certs', 'keys']],
  ['__proto__/cert.pem', 'constructor/key.pem', ['__proto__', 'constructor']],
  ['10/cert.pem', '2/key.pem', ['2', '10']],
] as const) {
  it(`TLS preserves separate-directory enumeration for ${certFile} and ${keyFile}`, async () => {
    const h = fixture(certFile, keyFile);
    try {
      assert.deepEqual(h.watchAttempts, expectedDirs);
      for (const watcher of h.watchers) {
        const ownFile = [certFile, keyFile].find(file => dirname(file) === watcher.dir)!;
        const otherFile = [certFile, keyFile].find(file => dirname(file) !== watcher.dir)!;
        const before = h.server.contextAttempts.length;
        watcher.change('change', basename(otherFile));
        assert.equal(h.pending().length, 0, 'a watcher filters the other directory basename');
        watcher.change('rename', Buffer.from(basename(ownFile)));
        h.advance(2000);
        assert.equal(h.server.contextAttempts.length, before + 1);
      }
    } finally { await h.stage.close(); }
    assert.ok(h.watchers.every(w => w.unrefs === 1 && w.closes === 1));
  });
}

it('TLS filters unrelated names and debounces matching string, Buffer and null events across directories', async () => {
  const h = fixture('__proto__/cert.pem', 'constructor/key.pem');
  try {
    const [certWatch, keyWatch] = h.watchers;
    certWatch!.change('change', 'unrelated.pem');
    certWatch!.change('rename', Buffer.from('unrelated.pem'));
    assert.equal(h.pending().length, 0);
    certWatch!.change('change', 'cert.pem');
    const first = h.pending()[0]!;
    assert.equal(first.ms, 2000);
    h.advance(1500);
    keyWatch!.change('rename', Buffer.from('key.pem'));
    assert.equal(first.active, false);
    const second = h.pending()[0]!;
    assert.equal(h.pending().length, 1);
    h.advance(1999);
    assert.equal(h.server.contextAttempts.length, 0);
    certWatch!.change('change', null);
    assert.equal(second.active, false);
    const last = h.pending()[0]!;
    h.advance(1000);
    certWatch!.change('change', 'ignored.pem');
    assert.equal(h.pending()[0], last, 'unrelated files do not postpone a pending reload');
    h.advance(999);
    assert.equal(h.server.contextAttempts.length, 0);
    h.state.generation = 1;
    h.advance(1);
    assert.equal(h.pending().length, 0);
    assert.equal(h.server.contextAttempts.length, 1);
    assert.equal(h.server.context!.cert.toString(), '1:__proto__/cert.pem');
    assert.equal(h.server.context!.key.toString(), '1:constructor/key.pem');
    assert.deepEqual(h.logs.map(({ level, message }) => [level, message]), [['info', 'TLS certificate reloaded']]);
  } finally { await h.stage.close(); }
});

for (const failure of ['certificate read', 'key read', 'secure context'] as const) {
  it(`TLS retains the previous context and permits recovery after ${failure} failure`, async () => {
    const h = fixture('__proto__/cert.pem', 'constructor/key.pem');
    try {
      const previous = h.server.context;
      if (failure === 'secure context') h.state.contextError = new Error('synthetic invalid pair');
      else h.state.readErrorFile = failure === 'certificate read' ? '__proto__/cert.pem' : 'constructor/key.pem';
      h.state.generation = 1;
      h.watchers[0]!.change('rename', null);
      h.advance(2000);
      assert.equal(h.server.context, previous);
      assert.equal(h.server.contextAttempts.length, failure === 'secure context' ? 1 : 0);
      assert.equal(h.pending().length, 0);
      assert.equal(h.logs.length, 1);
      assert.equal(h.logs[0]!.level, 'error');
      assert.equal(h.logs[0]!.message, 'TLS certificate reload failed, keeping the previous one');
      assert.equal(h.logs[0]!.fields?.error, failure === 'secure context'
        ? 'Error: synthetic invalid pair' : 'Error: synthetic read failure');
      h.state.contextError = undefined; h.state.readErrorFile = undefined;
      h.watchers[1]!.change('change', 'key.pem');
      h.advance(2000);
      assert.notEqual(h.server.context, previous);
      assert.equal(h.server.context!.cert.toString(), '1:__proto__/cert.pem');
      assert.equal(h.logs[1]!.message, 'TLS certificate reloaded');
    } finally { await h.stage.close(); }
  });
}

for (const failedDir of ['__proto__', 'constructor']) {
  it(`TLS logs failed watch creation for ${failedDir} and keeps the other directory watched`, async () => {
    const h = fixture('__proto__/cert.pem', 'constructor/key.pem', [failedDir]);
    try {
      assert.deepEqual(h.watchAttempts, ['__proto__', 'constructor']);
      assert.equal(h.watchers.length, 1);
      const watcher = h.watchers[0]!;
      assert.notEqual(watcher.dir, failedDir);
      assert.equal(watcher.unrefs, 1);
      assert.equal(h.logs[0]!.level, 'warn');
      assert.equal(h.logs[0]!.message, 'TLS certificate watch failed');
      assert.equal(h.logs[0]!.fields?.dir, failedDir);
      assert.equal(h.logs[0]!.fields?.error, 'Error: synthetic watch failure');
      watcher.emit('error', new Error('synthetic watcher event'));
      assert.equal(h.logs[1]!.level, 'warn');
      assert.equal(h.logs[1]!.message, 'TLS certificate watch failed');
      assert.equal(h.logs[1]!.fields?.dir, watcher.dir);
      assert.equal(h.logs[1]!.fields?.error, 'Error: synthetic watcher event');
      watcher.change('rename', null); h.advance(2000);
      assert.equal(h.server.contextAttempts.length, 1);
    } finally { await h.stage.close(); }
    assert.equal(h.watchers[0]!.closes, 1);
  });
}

it('TLS close cancels a pending reload, unreferences the heartbeat and closes each watcher only once', async () => {
  const h = fixture('__proto__/cert.pem', 'constructor/key.pem');
  h.watchers[0]!.change('rename', null);
  const pending = h.pending()[0]!;
  const heartbeat = h.timers.find(timer => timer.interval)!;
  assert.equal(heartbeat.unrefs, 1);
  const closing = h.stage.close();
  assert.equal(h.stage.close(), closing);
  await closing;
  assert.equal(h.stage.close(), closing);
  assert.equal(pending.active, false);
  assert.equal(heartbeat.active, false);
  assert.equal(h.timers.filter(timer => timer.active).length, 0);
  assert.deepEqual(h.calls, ['watch.close:__proto__', 'watch.close:constructor', 'hub.shutdown', 'wss.close', 'server.close']);
  assert.ok(h.watchers.every(watcher => watcher.closes === 1));
  h.advance(3000);
  assert.equal(h.server.contextAttempts.length, 0);
  assert.equal(h.reads.length, 2);
  await assert.rejects(h.stage.listen(), /server is closing/);
});

it('plaintext startup and close do not read TLS files, install watchers or reload contexts', async () => {
  const h = fixture('', '');
  assert.deepEqual(h.creations, ['http']);
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.watchAttempts, []);
  assert.equal(h.server.context, undefined);
  assert.equal(h.pending().length, 0);
  await h.stage.close();
  assert.deepEqual(h.calls, ['hub.shutdown', 'wss.close', 'server.close']);
  assert.equal(h.timers.filter(timer => timer.active).length, 0);
  assert.deepEqual(h.logs, []);
});

it('native HTTPS factory accepts prototype-named relative directories with an ephemeral certificate', () => {
  // Real TLS parsing and fs.watch supplement the deterministic VM tests. A child isolates chdir;
  // the existing pinned werift dependency generates a throwaway pair without openssl or fixtures.
  const script = `
    import assert from 'node:assert/strict';
    import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { parse } from ${JSON.stringify(import.meta.resolve('yaml'))};
    import { createSelfSignedCertificate, HashAlgorithm, SignatureAlgorithm, NamedCurveAlgorithm } from ${JSON.stringify(import.meta.resolve('werift'))};
    import { parseConfig } from ${JSON.stringify(new URL('../src/config.ts', import.meta.url).href)};
    import { createStageServer } from ${JSON.stringify(new URL('../src/ws/server.ts', import.meta.url).href)};
    const originalCwd = process.cwd(), root = mkdtempSync(join(tmpdir(), 'stage-tls-paths-'));
    const completed = [];
    try {
      const { certPem, keyPem } = await createSelfSignedCertificate(
        { hash: HashAlgorithm.sha256_4, signature: SignatureAlgorithm.ecdsa_3 }, NamedCurveAlgorithm.secp256r1_23);
      for (const dir of ${JSON.stringify([...PROTOTYPE_DIRS, 'ordinary'])}) {
        mkdirSync(join(root, dir));
        writeFileSync(join(root, dir, 'cert.pem'), certPem);
        writeFileSync(join(root, dir, 'key.pem'), keyPem, { mode: 0o600 });
      }
      process.chdir(root);
      const cases = ${JSON.stringify([...PROTOTYPE_DIRS, 'ordinary', './__proto__'])}
        .map(dir => [dir, dir + '/cert.pem', dir + '/key.pem']);
      cases.push(['absolute', join(root, '__proto__/cert.pem'), join(root, '__proto__/key.pem')]);
      cases.push(['split', '__proto__/cert.pem', 'constructor/key.pem']);
      for (const [label, certFile, keyFile] of cases) {
        const raw = parse(${JSON.stringify(EXAMPLE)});
        Object.assign(raw.server, { host: '127.0.0.1', port: 0, allowInsecure: false, static: [], tls: { certFile, keyFile } });
        const config = parseConfig(raw), logs = [];
        const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => logs.push([level, ...args])]));
        let shutdowns = 0;
        const server = createStageServer({ config, hub: { shutdown: async () => { shutdowns++; } }, log, baseDir: root });
        const closing = server.close();
        assert.equal(server.close(), closing);
        await closing;
        assert.equal(shutdowns, 1);
        assert.deepEqual(logs, [], label + ': native watchers must install without warnings');
        completed.push(label);
      }
      console.log(JSON.stringify(completed));
    } finally {
      process.chdir(originalCwd);
      rmSync(root, { recursive: true, force: true });
    }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', script], { encoding: 'utf8', timeout: 15000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  assert.deepEqual(JSON.parse(child.stdout), [...PROTOTYPE_DIRS, 'ordinary', './__proto__', 'absolute', 'split']);
});
