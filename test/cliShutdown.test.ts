import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createLogger } from '../src/log.ts';

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
    process, log, Error, clearInterval, saveTimer: undefined, stateFile: '',
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
  h.emit('unhandledRejection', null);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.infos, []);
  assert.deepEqual(h.errors.map(entry => entry.message), Array(3).fill('unhandled rejection'));
  assert.equal(h.errors[0]!.fields?.error, rejection);
  assert.equal(h.errors[1]!.fields?.error, 'non-Error rejection');
  assert.equal(h.errors[2]!.fields?.error, null);
  await bounded(h.stop('SIGTERM'));
  assert.deepEqual(h.calls, ['server.close', 'transport.close', 'exit:0']);
});

function hostileDiagnostics() {
  const reads: string[] = [];
  const forbidden = (hook: string): never => { reads.push(hook); throw new Error(`unexpected ${hook}`); };
  const error = new Error('hostile error');
  Object.defineProperty(error, 'stack', { get() { return forbidden('error.stack'); } });
  Object.defineProperty(error, 'message', { get() { return forbidden('error.message'); } });
  Object.defineProperty(error, 'name', { get() { return forbidden('error.name'); } });
  const object = {
    safe: 'retained',
    toString() { return forbidden('toString'); },
    valueOf() { return forbidden('valueOf'); },
    toJSON() { return forbidden('toJSON'); },
    [Symbol.toPrimitive]() { return forbidden('Symbol.toPrimitive'); },
    get computed() { return forbidden('computed'); },
    get secret() { return forbidden('secret'); },
  };
  const proxy = new Proxy({}, {
    get() { return forbidden('proxy.get'); },
    getPrototypeOf() { return forbidden('proxy.getPrototypeOf'); },
    getOwnPropertyDescriptor() { return forbidden('proxy.getOwnPropertyDescriptor'); },
    ownKeys() { return forbidden('proxy.ownKeys'); },
  });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const values: { label: string; value: unknown; serialized: unknown }[] = [
    { label: 'null-prototype object', value: Object.assign(Object.create(null), { safe: 'null-prototype' }), serialized: { safe: 'null-prototype' } },
    { label: 'hostile Error accessors', value: error, serialized: { name: '[Accessor]', message: '[Accessor]', stack: '[Accessor]' } },
    { label: 'hostile coercion and JSON hooks', value: object, serialized: {
      safe: 'retained', toString: '[Function]', valueOf: '[Function]', toJSON: '[Function]', computed: '[Accessor]', secret: '[redacted]',
    } },
    { label: 'hostile proxy', value: proxy, serialized: '[Proxy]' },
    { label: 'revoked proxy', value: revoked.proxy, serialized: '[Proxy]' },
  ];
  return { reads, values };
}

for (const event of ['unhandledRejection', 'uncaughtException'] as const) {
  it(`CLI ${event} passes hostile diagnostics unchanged without inspecting them`, async () => {
    const { reads, values } = hostileDiagnostics();
    const gate = Promise.withResolvers<void>();
    const h = fixture(() => gate.promise);
    let closing: Promise<void> | undefined;
    try {
      if (event === 'uncaughtException') closing = bounded(h.stop('SIGTERM'));
      for (const { label, value } of values) {
        assert.doesNotThrow(() => h.emit(event, value), label);
        assert.equal(h.errors.at(-1)!.fields?.error, value, `${label} is passed by identity`);
      }
      assert.equal(h.errors.length, values.length);
      assert.deepEqual(h.errors.map(entry => entry.message), Array(values.length).fill(event === 'unhandledRejection'
        ? 'unhandled rejection' : 'uncaught exception, shutting down'));
      assert.deepEqual(reads, []);
      assert.deepEqual(h.calls, event === 'unhandledRejection' ? [] : ['server.close']);
      if (event === 'unhandledRejection') assert.deepEqual(h.infos, []);
    } finally {
      gate.resolve();
      if (closing) await closing;
    }
    if (event === 'uncaughtException') {
      assert.deepEqual(h.calls, ['server.close', 'transport.close', 'exit:1']);
      assert.equal(h.infos.length, 1, 'concurrent hostile fatals do not duplicate shutdown');
    }
  });

  it(`CLI ${event} delegates safe structured output and redaction to the real logger`, async () => {
    const lines: string[] = [], requests: { signal: string; code: number | undefined }[] = [], observed: Promise<void>[] = [];
    const h = fixture();
    runInNewContext(stripTypeScriptTypes(handlersSource), {
      process: h.process, log: createLogger('error', line => lines.push(line)), Error,
      stop(signal: string, code?: number) {
        requests.push({ signal, code });
        const completion = Promise.resolve();
        observed.push(completion);
        return completion;
      },
    }, { timeout: 1000, filename: 'cli-process-errors-logger.vm.js' });
    const { reads, values } = hostileDiagnostics();
    const cause = { token: 'synthetic-token', nested: [{ SeCrEt: 'synthetic-secret', safe: 42 }] };
    const error = new TypeError('ordinary failure', { cause });
    // V8 can expose a lazy stack accessor; a data property gives this assertion a stable diagnostic.
    Object.defineProperty(error, 'stack', { value: 'TypeError: ordinary failure\n    at synthetic', configurable: true });
    values.push(
      { label: 'ordinary Error', value: error, serialized: {
        name: 'TypeError', message: 'ordinary failure', stack: 'TypeError: ordinary failure\n    at synthetic',
        cause: { token: '[redacted]', nested: [{ SeCrEt: '[redacted]', safe: 42 }] },
      } },
      { label: 'ordinary string', value: 'ordinary rejection', serialized: 'ordinary rejection' },
      { label: 'null', value: null, serialized: null },
    );
    for (const { label, value } of values) assert.doesNotThrow(() => h.emit(event, value), label);
    await bounded(Promise.all(observed));
    assert.deepEqual(reads, []);
    assert.equal(lines.length, values.length);
    const entries = lines.map(line => JSON.parse(line) as { level: string; msg: string; error: unknown });
    values.forEach(({ label, serialized }, index) => {
      const entry = entries[index]!;
      assert.equal(entry.level, 'error', label);
      assert.equal(entry.msg, event === 'unhandledRejection' ? 'unhandled rejection' : 'uncaught exception, shutting down', label);
      assert.deepEqual(entry.error, serialized, label);
    });
    assert.doesNotMatch(lines.join('\n'), /synthetic-token|synthetic-secret/);
    assert.deepEqual(cause, { token: 'synthetic-token', nested: [{ SeCrEt: 'synthetic-secret', safe: 42 }] });
    assert.deepEqual(requests, event === 'unhandledRejection' ? []
      : Array.from({ length: values.length }, () => ({ signal: 'uncaughtException', code: 1 })));
    assert.deepEqual(h.calls, [], 'no real process events, shutdown or exit are exposed to the handler proof');
  });
}
