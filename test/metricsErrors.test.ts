import assert from 'node:assert/strict';
import { request, type ClientRequest, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { createLogger } from '../src/log.ts';
import { createStageServer } from '../src/ws/server.ts';
import { harness, testConfig } from './helpers.ts';

const AUTHORIZATION = 'Bearer metrics-error-fixture';
const SECRET = 'synthetic-metrics-secret-95';
const TOKEN = 'synthetic-metrics-token-95';
const DEADLINE_MS = 5000;

interface Response {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface Fixture {
  get(authorization: string | undefined): Promise<Response>;
  lines: string[];
}

interface Failure {
  value: unknown;
  expected: unknown;
  calls(): number;
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Metrics fixture timed out: ${label}`)), DEADLINE_MS);
    })]);
  } finally { clearTimeout(timer); }
}

async function withMetrics(metrics: () => Promise<string>, run: (fixture: Fixture) => Promise<void>, onAuthorizationCheck?: () => void): Promise<void> {
  const config = testConfig(c => {
    c.server.host = '127.0.0.1';
    c.server.port = 0;
    c.server.httpShutdownDrainMs = 25;
    c.server.static = [];
    c.server.metrics = { enabled: true, token: 'metrics-error-fixture' };
  });
  if (onAuthorizationCheck) Object.defineProperty(config.server.metrics, 'token', { get() {
    onAuthorizationCheck();
    return 'metrics-error-fixture';
  } });
  const lines: string[] = [];
  const active = new Set<ClientRequest>();
  const server = createStageServer({ config, hub: harness(config).hub, log: createLogger('error', line => lines.push(line)), baseDir: tmpdir(), metrics });
  try {
    const { port } = await bounded(server.listen(), 'listen');
    await run({ lines, get: authorization => new Promise<Response>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/metrics', agent: false,
        headers: authorization === undefined ? {} : { authorization } }, res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => { body += chunk; });
        res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      active.add(req);
      // A missing response must fail and release its socket even if the rejection handler throws.
      const timer = setTimeout(() => req.destroy(new Error('Metrics request timed out')), DEADLINE_MS);
      req.on('close', () => { clearTimeout(timer); active.delete(req); });
      req.on('error', reject);
      req.end();
    }) });
  } finally {
    for (const req of active) req.destroy();
    await bounded(server.close(), 'close');
  }
}

const nested = () => ({ SeCrEt: SECRET, rows: [{ token: TOKEN, safe: 7 }] });
const redacted = () => ({ SeCrEt: '[redacted]', rows: [{ token: '[redacted]', safe: 7 }] });

function nullPrototype(): Failure {
  const value = Object.assign(Object.create(null) as Record<string, unknown>, { detail: 'null-prototype failure', nested: nested() });
  return { value, expected: { detail: 'null-prototype failure', nested: redacted() }, calls: () => 0 };
}

function throwingToString(): Failure {
  let calls = 0;
  const value = {
    detail: 'throwing-toString failure', nested: nested(),
    toString() { calls++; throw new Error('diagnostic toString must not execute'); },
    toJSON() { calls++; throw new Error('diagnostic toJSON must not execute'); },
    get computed() { calls++; throw new Error('diagnostic accessor must not execute'); },
    get password() { calls++; return SECRET; },
  };
  return { value, expected: { detail: value.detail, nested: redacted(), toString: '[Function]', toJSON: '[Function]', computed: '[Accessor]', password: '[redacted]' }, calls: () => calls };
}

function coercionAccessors(): Failure {
  let calls = 0;
  const value = { detail: 'coercion-accessor failure', nested: nested() };
  for (const key of [Symbol.toPrimitive, 'toString', 'valueOf', 'toJSON']) Object.defineProperty(value, key, {
    enumerable: true,
    get() { calls++; throw new Error('coercion accessor must not execute'); },
  });
  return { value, expected: { detail: value.detail, nested: redacted(), toString: '[Accessor]', valueOf: '[Accessor]', toJSON: '[Accessor]' }, calls: () => calls };
}

function ordinaryError(): Failure {
  const value = new Error('ordinary metrics failure', { cause: nested() });
  const stack = Object.getOwnPropertyDescriptor(value, 'stack')!;
  return { value, expected: { name: 'Error', message: value.message, stack: 'value' in stack ? stack.value : '[Accessor]', cause: redacted() }, calls: () => 0 };
}

function plainString(): Failure {
  return { value: 'ordinary string failure', expected: 'ordinary string failure', calls: () => 0 };
}

function assertDiagnostics(lines: string[], failure: Failure, count: number): void {
  assert.equal(lines.length, count, 'each failed response retains a local diagnostic');
  for (const line of lines) {
    const entry = JSON.parse(line) as Record<string, unknown>;
    assert.equal(entry.level, 'error');
    assert.equal(entry.msg, 'metrics error');
    assert.deepEqual(entry.error, failure.expected);
    assert.ok(!line.includes(SECRET) && !line.includes(TOKEN), 'nested synthetic secrets stay redacted');
  }
  assert.equal(failure.calls(), 0, 'logging must not execute coercion, serialization, or accessor hooks');
}

function assertFailed(response: Response): void {
  assert.equal(response.status, 500);
  assert.equal(response.body, '', 'internal diagnostics must not enter the response');
  assert.equal(response.headers['www-authenticate'], undefined);
}

function assertRecovered(response: Response, collection: number): void {
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'text/plain; version=0.0.4');
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.ok(response.body.startsWith(`stage_error_fixture ${collection}\n`));
  assert.match(response.body, /stage_ws_backpressure_disconnects_total 0\n/);
  assert.match(response.body, /stage_ws_inbound_queue_disconnects_total 0\n/);
}

describe('metrics rejection diagnostics', () => {
  const failures = [
    ['null-prototype object', nullPrototype],
    ['throwing toString', throwingToString],
    ['coercion accessors', coercionAccessors],
    ['ordinary Error', ordinaryError],
    ['plain string', plainString],
  ] as const;

  for (const [name, createFailure] of failures) for (const mode of ['synchronous throw', 'asynchronous rejection'] as const) {
    it(`returns an empty 500 for ${name} ${mode} and collects fresh samples afterward`, async () => {
      const failure = createFailure();
      let collections = 0;
      await withMetrics(() => {
        collections++;
        if (collections === 1) {
          if (mode === 'synchronous throw') throw failure.value;
          return Promise.reject(failure.value);
        }
        return Promise.resolve(`stage_error_fixture ${collections}\n`);
      }, async ({ get, lines }) => {
        assertFailed(await get(AUTHORIZATION));
        assert.equal(collections, 1);
        assertDiagnostics(lines, failure, 1);
        for (const collection of [2, 3]) {
          assertRecovered(await get(AUTHORIZATION), collection);
          assert.equal(collections, collection, 'completed failure and success results are not cached');
        }
        assertDiagnostics(lines, failure, 1);
      });
    });
  }

  for (const [name, createFailure] of failures.slice(0, 2)) {
    it(`settles overlapping authorized scrapes rejected with ${name}, keeps auth checks, and recovers`, async () => {
      const failure = createFailure();
      const pending = Promise.withResolvers<string>();
      const arrived = Promise.withResolvers<void>();
      const count = 4;
      let collections = 0, authorizationChecks = 0, arrivalTarget = Infinity;
      await withMetrics(() => {
        collections++;
        return collections === 1 ? pending.promise : Promise.resolve(`stage_error_fixture ${collections}\n`);
      }, async ({ get, lines }) => {
        try {
          for (const authorization of [undefined, 'Bearer wrong']) {
            const denied = await get(authorization);
            assert.equal(denied.status, 401);
            assert.equal(denied.headers['www-authenticate'], 'Bearer');
            assert.equal(denied.body, 'unauthorized');
          }
          assert.equal(collections, 0, 'unauthorized requests must not collect');
          arrivalTarget = authorizationChecks + count;
          let settled = 0;
          // Observe every client promise immediately, including errors during failed-test cleanup.
          const responses = Promise.allSettled(Array.from({ length: count }, () => get(AUTHORIZATION).then(response => { settled++; return response; })));
          await bounded(arrived.promise, 'overlapping authorized requests');
          for (const authorization of [undefined, 'Bearer wrong']) {
            const denied = await get(authorization);
            assert.equal(denied.status, 401, 'an in-flight sample must not bypass authorization');
            assert.equal(denied.headers['www-authenticate'], 'Bearer');
            assert.equal(denied.body, 'unauthorized');
          }
          assert.equal(collections, 1, 'overlapping authorized requests share one collection');
          assert.equal(settled, 0, 'all authorized scrapes are waiting on the same sample');
          assert.equal(lines.length, 0);
          pending.reject(failure.value);
          for (const result of await responses) {
            assert.equal(result.status, 'fulfilled', 'every authorized scrape must receive an HTTP response');
            if (result.status === 'fulfilled') assertFailed(result.value);
          }
          assert.equal(settled, count);
          assertDiagnostics(lines, failure, count);
          for (const collection of [2, 3]) {
            assertRecovered(await get(AUTHORIZATION), collection);
            assert.equal(collections, collection);
          }
          assertDiagnostics(lines, failure, count);
        } finally { pending.resolve(''); }
      }, () => { if (++authorizationChecks === arrivalTarget) arrived.resolve(); });
    });
  }
});
