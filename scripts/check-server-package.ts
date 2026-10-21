import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';
import { parse, stringify } from 'yaml';

const repositoryDirectory = fileURLToPath(new URL('../', import.meta.url));
const wsPath = '/delivery-control';
const staticPrefix = '/delivery/';
const outputLimit = 64 * 1024;
const diagnosticLimit = 4_000;
const bodyLimit = 2 * 1024 * 1024;
const buildGuidance = 'Server package artifacts are missing or invalid. Run npm run build from the repository root.';

export interface ServerPackageCheckOptions {
  repositoryDirectory?: string;
  dependenciesDirectory?: string;
  temporaryRoot?: string;
  startupTimeoutMs?: number;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  signal?: AbortSignal;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function within(root: string, path: string): boolean {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}
async function regularFile(path: string): Promise<void> {
  if (!(await lstat(path)).isFile()) throw new Error(`Expected a regular artifact file: ${path}`);
}
async function copyTree(source: string, destination: string): Promise<void> {
  if (!(await lstat(source)).isDirectory()) throw new Error(`Expected a regular artifact directory: ${source}`);
  await mkdir(destination, { recursive: true });
  for (const item of await readdir(source, { withFileTypes: true })) {
    const from = join(source, item.name), to = join(destination, item.name);
    if (item.isDirectory()) await copyTree(from, to);
    else if (item.isFile()) await copyFile(from, to);
    else throw new Error(`Only regular artifact files and directories are allowed: ${from}`);
  }
}
async function deadline<T>(promise: Promise<T>, label: string, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds}ms`)), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
function timeout(value: number | undefined, fallback: number): number {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) throw new Error('Timeouts must be positive safe integers');
  return value ?? fallback;
}

async function syntheticConfig(directory: string): Promise<Record<string, unknown>> {
  const config: unknown = parse(await readFile(join(directory, 'config.example.yaml'), 'utf8'));
  if (!record(config) || !record(config.server) || !record(config.rtc) || !record(config.audio) || !record(config.limits) || !record(config.log) || !record(config.rooms)) {
    throw new Error('Expected config.example.yaml with server, rtc, audio, limits, rooms and log sections');
  }
  Object.assign(config.server, {
    host: '127.0.0.1', port: 0, wsPath, allowInsecure: true, trustProxy: false,
    tls: { certFile: '', keyFile: '' }, metrics: { enabled: false, token: '' },
    static: [{ mount: staticPrefix, dir: 'web/dist', cors: false }, { mount: '/lib/', dir: 'packages/client/dist', cors: true }],
  });
  Object.assign(config.rtc, { iceServers: [], serverIceServers: [], mediaWorkers: 0, turn: { urls: [], secret: '', ttlSeconds: 86400 } });
  config.audio.codecWorkers = 1;
  config.rooms.createToken = '';
  config.log.level = 'info';
  return config;
}

function addresses(log: Record<string, unknown>): { http: URL; ws: URL } {
  if (typeof log.url !== 'string' || typeof log.ws !== 'string') throw new Error('Malformed server listening addresses');
  let http: URL, ws: URL;
  try { http = new URL(log.url); ws = new URL(log.ws); }
  catch { throw new Error('Malformed server listening addresses'); }
  if (http.protocol !== 'http:' || http.hostname !== '127.0.0.1' || !/^\d+$/.test(http.port) || Number(http.port) < 1 ||
      http.username || http.password || http.pathname !== '/' || http.search || http.hash ||
      ws.protocol !== 'ws:' || ws.host !== http.host || ws.username || ws.password || ws.pathname !== wsPath || ws.search || ws.hash) {
    throw new Error('Server listening addresses must use the expected loopback ephemeral port and custom WebSocket path');
  }
  return { http, ws };
}

/** Linux delivery smoke only: no build/install, room, peer, media exchange or production configuration. */
export async function checkServerPackage(options: ServerPackageCheckOptions = {}): Promise<void> {
  if (process.platform !== 'linux') throw new Error('Server package smoke requires Linux for verified SIGTERM behavior; Windows and macOS are not verified.');
  const startupTimeout = timeout(options.startupTimeoutMs, 8_000);
  const requestTimeout = timeout(options.requestTimeoutMs, 3_000);
  const shutdownTimeout = timeout(options.shutdownTimeoutMs, 5_000);
  options.signal?.throwIfAborted();
  const directory = resolve(options.repositoryDirectory ?? repositoryDirectory);
  let manifest: Record<string, unknown>, config: Record<string, unknown>;
  try {
    await regularFile(join(directory, 'package.json'));
    const parsed: unknown = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (!record(parsed) || parsed.type !== 'module' || typeof parsed.version !== 'string' || !parsed.version) throw new Error('Expected an ESM package.json with a version');
    manifest = parsed;
    for (const path of ['dist/src/index.js', 'dist/src/transport/codecWorker.js', 'dist/src/transport/mediaWorker.js', 'web/dist/index.html', 'web/dist/embed.html', 'packages/client/dist/stage-client.js', 'packages/client/dist/stage-element.js']) {
      await regularFile(join(directory, path));
    }
    config = await syntheticConfig(directory);
  } catch (error) { throw new Error(`${buildGuidance}\n${message(error)}`); }
  const dependencies = await realpath(options.dependenciesDirectory ?? join(directory, 'node_modules'));
  if (!(await lstat(dependencies)).isDirectory()) throw new Error('Expected existing installed node_modules dependencies');
  const temporary = await mkdtemp(join(options.temporaryRoot ?? tmpdir(), 'stage-server-package-'));
  try {
    const base = await realpath(temporary);
    const delivery = join(base, 'delivery with spaces'), cwd = join(base, 'alternate cwd');
    await mkdir(delivery); await mkdir(cwd);
    try {
      await copyFile(join(directory, 'package.json'), join(delivery, 'package.json'));
      for (const part of ['dist', 'web/dist', 'packages/client/dist']) await copyTree(join(directory, part), join(delivery, part));
    } catch (error) { throw new Error(`${buildGuidance}\n${message(error)}`); }
    await symlink(dependencies, join(delivery, 'node_modules'), 'dir');
    const guard = join(base, 'resolution-guard.mjs');
    await copyFile(new URL('./fixtures/server-package/resolution-guard.mjs', import.meta.url), guard);
    const configPath = join(base, 'synthetic config.yaml');
    await writeFile(configPath, stringify(config));
    const env: NodeJS.ProcessEnv = { ...process.env, STAGE_CONFIG: configPath, STAGE_PACKAGE_DELIVERY: delivery, STAGE_PACKAGE_DEPENDENCIES: dependencies };
    delete env.NODE_OPTIONS; delete env.NODE_PATH;
    options.signal?.throwIfAborted();
    const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, join(delivery, 'dist/src/index.js')], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const fault = Promise.withResolvers<never>();
    const started = Promise.withResolvers<Record<string, unknown>>();
    void fault.promise.catch(() => {}); void started.promise.catch(() => {});
    let output = '', outputBytes = 0, lineBuffers = { stdout: '', stderr: '' }, listening = false, shutdownLogged = false, closed = false;
    let socket: WebSocket | undefined;
    let socketClosed: Promise<{ code: number; reason: string }> | undefined;
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolveExit => {
      child.once('close', (code, signal) => { closed = true; resolveExit({ code, signal }); });
    });
    child.once('error', error => fault.reject(new Error(`Server process failed: ${message(error)}`)));
    const unexpectedExit = exit.then(status => { throw new Error(`Server exited before checks completed (exit ${status.code ?? 'none'}, signal ${status.signal ?? 'none'})`); });
    void unexpectedExit.catch(() => {});
    const abort = () => fault.reject(new Error('Server package check aborted'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) abort();
    const capture = (data: Buffer, stream: 'stdout' | 'stderr') => {
      outputBytes += data.length;
      output = (output + data.toString()).slice(0, diagnosticLimit);
      if (outputBytes > outputLimit) { fault.reject(new Error('Server output exceeded 65536 bytes')); return; }
      lineBuffers[stream] += data.toString();
      let end: number;
      while ((end = lineBuffers[stream].indexOf('\n')) >= 0) {
        const line = lineBuffers[stream].slice(0, end); lineBuffers[stream] = lineBuffers[stream].slice(end + 1);
        if (!line.trim() || (stream === 'stderr' && !line.trimStart().startsWith('{'))) continue;
        let log: unknown;
        try { log = JSON.parse(line); }
        catch { fault.reject(new Error('Malformed server JSON log')); continue; }
        if (!record(log)) { fault.reject(new Error('Malformed server JSON log')); continue; }
        if (log.level === 'error') fault.reject(new Error(`Server emitted an error log: ${String(log.msg).slice(0, 200)}`));
        if (log.msg === 'shutting down' && log.signal === 'SIGTERM') shutdownLogged = true;
        if (log.msg === 'Stage.js listening') {
          if (listening) fault.reject(new Error('Server emitted duplicate listening logs'));
          listening = true; started.resolve(log);
        }
      }
    };
    child.stdout.on('data', (data: Buffer) => capture(data, 'stdout'));
    child.stderr.on('data', (data: Buffer) => capture(data, 'stderr'));
    const run = <T>(promise: Promise<T>, label: string, ms: number, stopping = false): Promise<T> => deadline(Promise.race([promise, fault.promise, ...(!stopping ? [unexpectedExit] : [])]), label, ms);
    const get = async (url: URL): Promise<{ status: number | undefined; type: string | undefined; body: Buffer }> => {
      let timer: NodeJS.Timeout | undefined;
      const req = request(url, { agent: false, headers: { 'accept-encoding': 'identity' } });
      const response = new Promise<{ status: number | undefined; type: string | undefined; body: Buffer }>((resolveResponse, reject) => {
        req.once('error', reject);
        req.once('response', res => {
          const chunks: Buffer[] = []; let size = 0;
          res.once('error', reject);
          res.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > bodyLimit) req.destroy(new Error(`HTTP ${url.pathname} exceeded response size limit`));
            else chunks.push(chunk);
          });
          res.once('end', () => resolveResponse({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
        });
        timer = setTimeout(() => req.destroy(new Error(`HTTP ${url.pathname} timed out`)), requestTimeout);
        req.end();
      });
      try { return await run(response, `HTTP ${url.pathname}`, requestTimeout); }
      finally { clearTimeout(timer); req.destroy(); }
    };
    try {
      const urls = addresses(await run(started.promise, 'Server startup', startupTimeout));
      for (const [path, body] of [['/healthz', 'ok'], ['/readyz', 'ready']] as const) {
        const res = await get(new URL(path, urls.http));
        assert.equal(res.status, 200, `${path} status`);
        assert.equal(res.body.toString(), body, `${path} body`);
      }
      const staticFile = async (path: string, file: string, type: string): Promise<Buffer> => {
        const res = await get(new URL(path, urls.http));
        assert.equal(res.status, 200, `${path} status`);
        assert.equal(res.type, type, `${path} MIME`);
        assert.ok(res.body.equals(await readFile(join(delivery, file))), `${path} differs from delivered artifact bytes`);
        return res.body;
      };
      const html = await staticFile(staticPrefix, 'web/dist/index.html', 'text/html; charset=utf-8');
      await staticFile(`${staticPrefix}embed.html`, 'web/dist/embed.html', 'text/html; charset=utf-8');
      for (const name of ['stage-client.js', 'stage-element.js']) await staticFile(`/lib/${name}`, `packages/client/dist/${name}`, 'text/javascript; charset=utf-8');
      const assets = [...html.toString().matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]!);
      assert.ok(assets.length > 0, 'Built HTML must reference JS/CSS assets');
      assert.ok(assets.length <= 32, 'Built HTML has too many direct assets');
      for (const asset of assets) {
        const url = new URL(asset, new URL(staticPrefix, urls.http));
        assert.ok(url.origin === urls.http.origin && url.pathname.startsWith(staticPrefix) && !url.search && !url.hash, 'HTML assets must stay under the configured static prefix');
        const path = resolve(delivery, 'web/dist', decodeURIComponent(url.pathname.slice(staticPrefix.length)));
        assert.ok(within(join(delivery, 'web/dist'), path), 'HTML asset escapes delivered web files');
        await staticFile(url.pathname, relative(delivery, path), url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/javascript; charset=utf-8');
      }
      socket = new WebSocket(urls.ws, { handshakeTimeout: requestTimeout, maxPayload: 64 * 1024 });
      socketClosed = new Promise(resolveClose => socket!.once('close', (code, reason) => resolveClose({ code, reason: reason.toString() })));
      const hello = new Promise<unknown>((resolveHello, reject) => {
        socket!.on('error', error => { reject(error); fault.reject(new Error(`WebSocket failed: ${message(error)}`)); });
        socket!.once('message', (data, binary) => {
          if (binary) { reject(new Error('WebSocket hello must be text')); return; }
          try { resolveHello(JSON.parse(data.toString())); } catch { reject(new Error('Malformed WebSocket hello')); }
        });
        socket!.once('close', () => reject(new Error('WebSocket closed before hello')));
      });
      const limits = config.limits as Record<string, unknown>;
      assert.deepEqual(await run(hello, 'WebSocket hello', requestTimeout), {
        type: 'hello', protocol: 1, serverVersion: manifest.version,
        limits: { controlPerSecond: limits.controlPerSecond, icePerSecond: limits.icePerSecond, handRaiseIntervalMs: limits.handRaiseIntervalMs },
      }, 'WebSocket hello contract');
      assert.equal(socket.readyState, WebSocket.OPEN, 'Hello socket must remain open until SIGTERM');
      assert.ok(!closed && child.kill('SIGTERM'), 'Expected to signal the running owned server');
      const status = await run(exit, 'Server SIGTERM shutdown', shutdownTimeout, true);
      assert.deepEqual(status, { code: 0, signal: null }, 'Server SIGTERM must exit 0 without a terminating signal');
      assert.deepEqual(await run(socketClosed, 'WebSocket shutdown', shutdownTimeout, true), { code: 1001, reason: 'server shutdown' }, 'WebSocket shutdown contract');
      assert.ok(shutdownLogged, 'Server must log its SIGTERM shutdown');
    } catch (error) {
      throw new Error(`${message(error).slice(0, diagnosticLimit)}\n${output}${outputBytes > diagnosticLimit ? '\n[output truncated]' : ''}`);
    } finally {
      options.signal?.removeEventListener('abort', abort);
      if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
      if (!closed) child.kill('SIGKILL');
      // Reap this exact child before deleting files; never signal a process group or unrelated PID.
      await deadline(exit, 'Owned server cleanup', 3_000);
      if (socketClosed) await deadline(socketClosed, 'Owned WebSocket cleanup', 3_000);
    }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  // CLI-only handlers leave importing test processes unchanged and let finally reap owned resources.
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try {
    await checkServerPackage({ signal: controller.signal });
    console.log('Server package passed on Linux: copied compiled entry, health/readiness, static artifact bytes, custom-path hello and SIGTERM shutdown.');
  } catch (error) {
    console.error(message(error)); process.exitCode = 1;
  } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
