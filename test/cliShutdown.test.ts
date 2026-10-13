import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const shutdownMarker = 'let stopping = false;';
const handlersMarker = "process.on('SIGINT'";
assert.equal(source.split(shutdownMarker).length, 2, 'find exactly one production shutdown block');
assert.equal(source.split(handlersMarker).length, 2, 'find exactly one production handler block');
const shutdownSource = source.slice(source.indexOf(shutdownMarker));
const handlersSource = source.slice(source.indexOf(handlersMarker));
type Close = () => Promise<void>;
type Stop = (signal: string, code?: number) => Promise<void>;
interface LogEntry { message: string; fields?: Record<string, unknown> }

function fixture(serverClose: Close = async () => {}, transportClose: Close = async () => {}) {
  const calls: string[] = [], errors: LogEntry[] = [], infos: LogEntry[] = [];
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const process = {
    on(event: string, handler: (...args: unknown[]) => void) { handlers.set(event, handler); },
    exit(code: number) { calls.push(`exit:${code}`); },
  };
  const log = {
    info(message: string, fields?: Record<string, unknown>) { infos.push({ message, fields }); },
    error(message: string, fields?: Record<string, unknown>) { errors.push({ message, fields }); },
  };
  // Evaluate the exact production tail, without importing startup or exposing the real process.
  const { stop } = runInNewContext(stripTypeScriptTypes(`${shutdownSource}\n({ stop });`), {
    process, log, Error,
    server: { close() { calls.push('server.close'); return serverClose(); } },
    transport: { close() { calls.push('transport.close'); return transportClose(); } },
  }, { timeout: 1000, filename: 'cli-shutdown.vm.js' }) as { stop: Stop };
  function emit(event: string, ...args: unknown[]): void {
    const handler = handlers.get(event);
    assert.ok(handler, `production registered ${event}`);
    handler(...args);
  }
  return { calls, errors, infos, stop, emit, process, log };
}

function bounded<T>(promise: Promise<T>): Promise<T> {
  const completion = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([promise, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('CLI shutdown did not finish')), 1000);
      })]);
    } finally { clearTimeout(timer); }
  })();
  // A failing assertion must not turn an abandoned in-flight proof into an unhandled rejection.
  void completion.catch(() => {});
  return completion;
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  it(`CLI ${signal} closes server before transport and exits zero`, async () => {
    const gate = Promise.withResolvers<void>();
    const h = fixture(() => gate.promise);
    const closing = bounded(h.stop(signal));
    try { assert.deepEqual(h.calls, ['server.close'], 'transport must wait for server cleanup'); }
    finally { gate.resolve(); }
    await closing;
    assert.deepEqual(h.calls, ['server.close', 'transport.close', 'exit:0']);
    assert.deepEqual(h.errors, []);
    assert.equal(h.infos.length, 1);
    assert.equal(h.infos[0]!.fields?.signal, signal);
  });
}

type FailureMode = 'throw' | 'reject';
function fail(mode: FailureMode, error: unknown): Close {
  return () => {
    if (mode === 'throw') throw error;
    return Promise.reject(error);
  };
}

for (const serverMode of [undefined, 'throw', 'reject'] as const) {
  for (const transportMode of [undefined, 'throw', 'reject'] as const) {
    if (!serverMode && !transportMode) continue;
    it(`CLI finishes cleanup after server ${serverMode ?? 'success'} and transport ${transportMode ?? 'success'}`, async () => {
      const serverError = new Error('server close broke'), transportError = new Error('transport close broke');
      const h = fixture(serverMode && fail(serverMode, serverError), transportMode && fail(transportMode, transportError));
      // Observe stop itself: the production handlers intentionally discard its promise.
      await bounded(h.stop('SIGTERM'));
      await bounded(h.stop('SIGINT'));
      assert.deepEqual(h.calls, ['server.close', 'transport.close', 'exit:1']);
      const expected = [
        ...(serverMode ? [{ message: 'server shutdown failed', error: serverError }] : []),
        ...(transportMode ? [{ message: 'transport shutdown failed', error: transportError }] : []),
      ];
      assert.deepEqual(h.errors.map(entry => entry.message), expected.map(entry => entry.message));
      expected.forEach((entry, index) => assert.equal(h.errors[index]!.fields?.error, entry.error));
    });
  }
}

it('CLI reports non-Error cleanup failures without skipping the remaining cleanup', async () => {
  const h = fixture(fail('throw', null), fail('reject', 'transport unavailable'));
  await bounded(h.stop('SIGINT'));
  assert.deepEqual(h.calls, ['server.close', 'transport.close', 'exit:1']);
  assert.deepEqual(h.errors.map(entry => entry.fields?.error), [null, 'transport unavailable']);
});

it('CLI delegates hostile cleanup diagnostics to the structured logger without reading them', async () => {
  let reads = 0;
  const serverError = new Error('hostile stack');
  Object.defineProperty(serverError, 'stack', { get() { reads++; throw new Error('stack must not be read here'); } });
  const transportError = new Proxy({}, { get() { reads++; throw new Error('proxy must not be inspected here'); } });
  const h = fixture(fail('throw', serverError), fail('reject', transportError));
  await bounded(h.stop('SIGTERM')).catch(() => assert.fail('shutdown must not reject for hostile diagnostic values'));
  assert.deepEqual(h.calls, ['server.close', 'transport.close', 'exit:1']);
  assert.equal(reads, 0);
  assert.equal(h.errors[0]!.fields?.error, serverError);
  assert.equal(h.errors[1]!.fields?.error, transportError);
});

for (const failing of [false, true]) {
  for (const code of [1, 7]) {
    it(`CLI preserves initial nonzero exit ${code} with ${failing ? 'failed' : 'successful'} cleanup`, async () => {
      const failure = new Error('cleanup failure');
      const h = fixture(failing ? fail('reject', failure) : undefined, failing ? fail('throw', failure) : undefined);
      await bounded(h.stop('uncaughtException', code));
      assert.deepEqual(h.calls, ['server.close', 'transport.close', `exit:${code}`]);
    });
  }
}

for (const code of [1, 7]) {
  it(`CLI repeated signal and fatal callbacks keep exit ${code} and cannot duplicate cleanup`, async () => {
    const gate = Promise.withResolvers<void>();
    const h = fixture(() => gate.promise);
    const closing = bounded(h.stop('uncaughtException', code));
    try {
      h.emit('SIGINT'); h.emit('SIGTERM'); h.emit('uncaughtException', new Error('another fatal error'));
      assert.deepEqual(h.calls, ['server.close']);
    } finally { gate.resolve(); }
    await closing;
    h.emit('SIGINT'); h.emit('SIGTERM'); h.emit('uncaughtException', new Error('late fatal error'));
    await bounded(h.stop('manual repeat', 1));
    assert.deepEqual(h.calls, ['server.close', 'transport.close', `exit:${code}`]);
    assert.equal(h.infos.length, 1);
  });
}

for (const phase of ['server', 'transport'] as const) {
  it(`CLI fatal callback during pending ${phase} cleanup upgrades the final exit status`, async () => {
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    const pending = () => { started.resolve(); return release.promise; };
    const h = fixture(phase === 'server' ? pending : undefined, phase === 'transport' ? pending : undefined);
    const closing = bounded(h.stop('SIGTERM'));
    try {
      await bounded(started.promise);
      h.emit('uncaughtException', new Error('fatal during shutdown'));
      h.emit('SIGINT'); h.emit('SIGTERM');
    } finally { release.resolve(); }
    await closing;
    assert.deepEqual(h.calls, ['server.close', 'transport.close', 'exit:1']);
    assert.equal(h.infos.length, 1);
  });
}

it('CLI production handlers forward signal and fatal exit intent', async () => {
  const h = fixture(), requests: { signal: string; code: number | undefined }[] = [], observed: Promise<void>[] = [];
  // Run the exact registration block with an observed stop stub. This checks callback
  // wiring without discarding a failing real shutdown promise or emitting real signals.
  runInNewContext(stripTypeScriptTypes(handlersSource), {
    process: h.process, log: h.log, Error,
    stop(signal: string, code?: number) {
      requests.push({ signal, code });
      const completion = Promise.resolve();
      observed.push(completion);
      return completion;
    },
  }, { timeout: 1000, filename: 'cli-shutdown-handlers.vm.js' });
  h.emit('SIGINT'); h.emit('SIGTERM'); h.emit('uncaughtException', new Error('fatal'));
  await bounded(Promise.all(observed));
  assert.deepEqual(requests, [
    { signal: 'SIGINT', code: undefined },
    { signal: 'SIGTERM', code: undefined },
    { signal: 'uncaughtException', code: 1 },
  ]);
  assert.deepEqual(h.calls, []);
  assert.equal(h.errors[0]!.message, 'uncaught exception, shutting down');
});

it('CLI unrelated unhandled rejections remain logged without starting shutdown', async () => {
  const h = fixture(), rejection = new Error('stray WebRTC timer');
  h.emit('unhandledRejection', rejection);
  h.emit('unhandledRejection', 'non-Error rejection');
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.infos, []);
  assert.deepEqual(h.errors.map(entry => entry.message), ['unhandled rejection', 'unhandled rejection']);
  assert.deepEqual(h.errors.map(entry => entry.fields?.error), [rejection.stack, 'non-Error rejection']);
  await bounded(h.stop('SIGTERM'));
  assert.deepEqual(h.calls, ['server.close', 'transport.close', 'exit:0']);
});
