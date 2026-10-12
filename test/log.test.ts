import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../src/log.ts';

function capture(fields: Record<string, unknown>) {
  let line = '';
  createLogger('info', value => { line = value; }).info('test', fields);
  return { line, value: JSON.parse(line) as Record<string, any> };
}

describe('structured log redaction', () => {
  it('redacts sensitive field names recursively in objects and arrays without changing input', () => {
    const fields = { token: 'top', rtc: { turn: { SeCrEt: 'nested', urls: ['turn:example.invalid'] } }, rows: [{ password: 'array', safe: 42 }], resumeToken: { nested: 'hidden' } };
    const original = structuredClone(fields);
    const { line, value } = capture(fields);
    assert.equal(value.token, '[redacted]');
    assert.equal(value.rtc.turn.SeCrEt, '[redacted]');
    assert.equal(value.rows[0].password, '[redacted]');
    assert.equal(value.resumeToken, '[redacted]');
    assert.equal(value.rows[0].safe, 42);
    assert.deepEqual(value.rtc.turn.urls, ['turn:example.invalid']);
    assert.doesNotMatch(line, /"top"|"nested"|"array"|"hidden"/);
    assert.deepEqual(fields, original);
  });

  it('never invokes accessors, toJSON or proxy traps', () => {
    let calls = 0;
    const object = { safe: 1, toJSON() { calls++; throw new Error('must not run'); } };
    Object.defineProperty(object, 'computed', { enumerable: true, get() { calls++; throw new Error('must not run'); } });
    Object.defineProperty(object, 'secret', { enumerable: true, get() { calls++; throw new Error('must not read'); } });
    const proxy = new Proxy({}, { ownKeys() { calls++; throw new Error('must not inspect'); }, get() { calls++; throw new Error('must not read'); } });
    const { value } = capture({ object, proxy });
    assert.equal(calls, 0);
    assert.equal(value.object.safe, 1);
    assert.equal(value.object.computed, '[Accessor]');
    assert.equal(value.object.secret, '[redacted]');
    assert.equal(value.object.toJSON, '[Function]');
    assert.equal(value.proxy, '[Proxy]');
  });

  it('handles cycles while retaining repeated non-cyclic references', () => {
    const shared = { safe: 'shared', token: 'never' };
    const cycle: Record<string, unknown> = { shared };
    cycle.self = cycle;
    const { value } = capture({ cycle, again: shared });
    assert.equal(value.cycle.self, '[Circular]');
    assert.deepEqual(value.cycle.shared, value.again);
    assert.equal(value.again.token, '[redacted]');
  });

  it('bounds deep and wide diagnostic data', () => {
    const root: Record<string, unknown> = {};
    let node = root;
    for (let i = 0; i < 10000; i++) { const next = {}; node.next = next; node = next; }
    const deep = capture({ root });
    assert.match(deep.line, /\[MaxDepth\]/);
    const wide = capture({ rows: Array.from({ length: 10000 }, (_, i) => i) });
    assert.ok(wide.value.rows.length <= 1001);
    assert.equal(wide.value.rows.at(-1), '[Truncated]');
  });

  it('keeps Error diagnostics and redacts structured causes, dates and bigints safely', () => {
    class SpecificError extends TypeError {}
    const error = new SpecificError('ordinary failure', { cause: { secret: 'synthetic', retryable: true } });
    const date = new Date('2026-01-02T03:04:05.000Z');
    const { value } = capture({ error, date, invalidDate: new Date(NaN), count: 123n });
    assert.equal(value.error.name, 'TypeError');
    assert.equal(value.error.message, 'ordinary failure');
    const stack = Object.getOwnPropertyDescriptor(error, 'stack')!;
    assert.equal(value.error.stack, 'value' in stack ? stack.value : '[Accessor]');
    assert.deepEqual(value.error.cause, { secret: '[redacted]', retryable: true });
    assert.equal(value.date, date.toISOString());
    assert.equal(value.invalidDate, null);
    assert.equal(value.count, '123');
  });

  it('handles sparse arrays, revoked proxies and special property names without side effects', () => {
    const rows = Array(3) as unknown[];
    rows[0] = { token: 'synthetic' };
    Object.defineProperty(rows, '2', { get() { assert.fail('array getter must not run'); } });
    const revocable = Proxy.revocable({}, {}); revocable.revoke();
    const fields = JSON.parse('{"__proto__":{"secret":"synthetic"},"constructor":{"password":"synthetic"}}') as Record<string, unknown>;
    fields.rows = rows; fields.revoked = revocable.proxy;
    const { value } = capture(fields);
    assert.deepEqual(value.rows, [{ token: '[redacted]' }, null, '[Accessor]']);
    assert.equal(value.revoked, '[Proxy]');
    assert.deepEqual(value.__proto__, { secret: '[redacted]' });
    assert.deepEqual(value.constructor, { password: '[redacted]' });
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
  });

  it('does no traversal for filtered messages and preserves log levels', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', line => lines.push(line));
    const fields = { get unsafe() { assert.fail('filtered fields must not be read'); return 1; } };
    logger.debug('hidden', fields); logger.info('hidden', fields);
    logger.warn('visible', { count: 1 }); logger.error('also visible');
    assert.deepEqual(lines.map(line => JSON.parse(line).level), ['warn', 'error']);
  });
});
