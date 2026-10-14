import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClientMessage, sanitizeName, ValidationError } from '../src/ws/validate.ts';
import { testConfig } from './helpers.ts';

const limits = testConfig().limits;

// Keep the former spread-based implementation independent of the optimized counter.
function historicalName(raw: unknown, maxLength: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const cleaned = raw.normalize('NFC').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  const length = [...cleaned].length;
  if (length === 0 || length > maxLength) return undefined;
  const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return cleaned.replace(/[&<>"']/g, character => escapes[character] ?? character);
}

test('name length preserves cleaning order, code points, and escaping boundaries', () => {
  const cases: [label: string, raw: string, cap: number, expected: string | undefined][] = [
    ['NFC composition', 'e\u0301', 1, 'é'],
    ['Hangul composition', '\u1100\u1161', 1, '가'],
    ['NFC expansion fits', '\u0344', 2, '\u0308\u0301'],
    ['NFC expansion exceeds cap', '\u0344', 1, undefined],
    ['normalization precedes stripping', 'e\u200b\u0301', 2, 'e\u0301'],
    ['no second normalization after stripping', 'e\u200b\u0301', 1, undefined],
    ['stripping joins surrogate halves', '\ud83d\u200b\udc31', 1, '🐱'],
    ['stripping joins halves around separators', '\ud83d\u2028\u2029\udc31', 1, '🐱'],
    ['trim follows stripping', '\u200b \u00a0A\u3000 \u200b', 1, 'A'],
    ['all unsafe categories', '\0A\u001f\u007f\u0085\u200b\u202e\u2066\u2028\u2029B\n', 2, 'AB'],
    ['internal whitespace remains', ' A\u00a0B ', 3, 'A\u00a0B'],
    ['internal whitespace counts', 'A B', 2, undefined],
    ['combining marks count separately', 'x\u0301', 1, undefined],
    ['astral counts once', '🐱', 1, '🐱'],
    ['variation selector counts separately', '☕\ufe0f', 1, undefined],
    ['ZWJ removal does not merge emoji', '👩\u200d💻', 2, '👩💻'],
    ['lone high surrogate', '\ud83d', 1, '\ud83d'],
    ['lone low surrogate', '\udc31', 1, '\udc31'],
    ['reversed surrogate halves', '\udc31\ud83d', 1, undefined],
    ['unpaired half followed by a pair', '\ud83d\ud83d\udc31', 2, '\ud83d🐱'],
    ['escape after measuring', '<&>"\'', 5, '&lt;&amp;&gt;&quot;&#39;'],
    ['escaped output may exceed cap', '&'.repeat(32), 32, '&amp;'.repeat(32)],
    ['existing entity is escaped again', '&lt;', 4, '&amp;lt;'],
    ['whitespace and unsafe only', '\u00a0\0\u200b\u2028\u2029 ', 32, undefined],
  ];
  for (const [label, raw, cap, expected] of cases) {
    assert.equal(historicalName(raw, cap), expected, `${label}: historical contract`);
    assert.equal(sanitizeName(raw, cap), expected, label);
  }
});

test('non-string names are rejected without coercion and empty names never fit', () => {
  const noCoercion = { toString() { assert.fail('names must not be coerced'); } };
  const nonstrings = [undefined, null, true, false, 0, 1n, Symbol('name'), [], {}, new String('Alice'), noCoercion, () => 'Alice'];
  for (const cap of [limits.nameMaxLength, 0, -1, NaN, Infinity]) {
    for (const raw of nonstrings) assert.equal(sanitizeName(raw, cap), undefined);
    for (const raw of ['', ' \t\n ', '\u200b\u202e\u2028']) assert.equal(sanitizeName(raw, cap), undefined);
  }
});

test('bounded Unicode matrix matches historical validation at default and custom caps', () => {
  const units = ['A', '字', '🐱', 'e\u0301', '\u0344', 'x\u0301', '&', '<', '\ud83d', '\udc31', '\udc31\ud83d', '\ud83d\u200b\udc31'];
  for (const cap of [1, 2, 8, limits.nameMaxLength, 40, 64]) {
    for (const unit of units) {
      for (const count of new Set([0, 1, cap - 1, cap, cap + 1])) {
        const repeated = unit.repeat(count);
        for (const raw of [repeated, `\u200b \u00a0${repeated}\u3000\u202e`, `${repeated}\u0000&`]) {
          assert.equal(sanitizeName(raw, cap), historicalName(raw, cap), `cap=${cap}, raw=${JSON.stringify(raw)}`);
        }
      }
    }
  }
  // Adjacent fragments exercise malformed surrogates and normalization across joins.
  for (const first of units) {
    for (const second of units) {
      for (const cap of [1, 2, 3, 8]) {
        const raw = first + second;
        assert.equal(sanitizeName(raw, cap), historicalName(raw, cap), `cap=${cap}, joined=${JSON.stringify(raw)}`);
      }
    }
  }
});

test('exported sanitizer retains historical behavior for unusual numeric bounds', () => {
  const caps = [-Infinity, -2, -0.5, -0, 0, Number.MIN_VALUE, 0.5, 1, 1.5, 2.5, NaN, Infinity, Number.MAX_SAFE_INTEGER];
  const names = ['', ' ', '\u200b', 'A', 'AB', '🐱', '🐱🐱', 'e\u0301', '\u0344', '\ud83d', '&', 'A'.repeat(128)];
  for (const cap of caps) {
    for (const raw of names) {
      assert.equal(sanitizeName(raw, cap), historicalName(raw, cap), `cap=${String(cap)}, raw=${JSON.stringify(raw)}`);
    }
  }
});

const routes = [
  { label: 'create name', field: 'name', base: { type: 'room:create', requestId: 'length' } },
  { label: 'create roomName', field: 'roomName', base: { type: 'room:create', requestId: 'length' } },
  { label: 'join name', field: 'name', base: { type: 'join', requestId: 'length', roomId: 'room_1' } },
  { label: 'participant rename', field: 'name', base: { type: 'participant:rename', requestId: 'length' } },
  { label: 'room rename', field: 'name', base: { type: 'room:rename', requestId: 'length' } },
] as const;

function rejects(action: () => unknown, detail: string, requestId: string | undefined, code: 'bad_request' | 'unknown_type' = 'bad_request'): void {
  assert.throws(action, error => {
    assert.ok(error instanceof ValidationError);
    assert.equal(error.code, code);
    assert.equal(error.detail, detail);
    assert.equal(error.message, `${code}: ${detail}`);
    assert.equal(error.requestId, requestId);
    return true;
  });
}

for (const route of routes) {
  test(`${route.label} uses configured cleaned-name caps and drops unknown fields`, () => {
    for (const cap of [1, 8, limits.nameMaxLength, 64]) {
      const inputs: unknown[] = [null, false, 42, [], {}, '', ' \u200b\n '];
      for (const unit of ['A', '字', '🐱', 'e\u0301', '\ud83d\u200b\udc31', '\ud83d', '&']) {
        inputs.push(` \u200b${unit.repeat(cap)}\u202e `, unit.repeat(cap + 1));
      }
      for (const raw of inputs) {
        const input = { ...route.base, [route.field]: raw, targetId: {}, ignoredName: 'x'.repeat(100), role: 'controller' };
        const text = JSON.stringify(input);
        const parse = () => parseClientMessage(text, { ...limits, nameMaxLength: cap });
        const expected = historicalName(raw, cap);
        if (expected === undefined) rejects(parse, `${route.base.type}: ${route.field}`, 'length');
        else assert.deepEqual(parse(), { ...route.base, [route.field]: expected });
      }
    }
  });
}

test('name-bearing parser messages preserve optional fields and other valid values', () => {
  const parse = (input: unknown) => parseClientMessage(JSON.stringify(input), limits);
  assert.deepEqual(parse({ type: 'room:create', requestId: 'length' }), { type: 'room:create', requestId: 'length' });
  assert.deepEqual(parse({ type: 'room:create', requestId: 'length', name: ' e\u0301 ', roomName: '<&>', codeRequired: false, token: ' exact token ' }), {
    type: 'room:create', requestId: 'length', name: 'é', roomName: '&lt;&amp;&gt;', codeRequired: false, token: ' exact token ',
  });
  assert.deepEqual(parse({ type: 'join', requestId: 'length', roomId: 'room_1', name: '🐱', code: 'abc234', resumeToken: 'resume_1' }), {
    type: 'join', requestId: 'length', roomId: 'room_1', name: '🐱', code: 'ABC234', resumeToken: 'resume_1',
  });
  for (const route of routes) {
    if (route.base.type !== 'room:create') rejects(() => parse(route.base), `${route.base.type}: name`, 'length');
    for (const requestId of [undefined, null, '', 'invalid id', 'x'.repeat(65)]) {
      rejects(() => parse({ ...route.base, requestId, [route.field]: 'x'.repeat(100) }), `${route.base.type}: requestId`, undefined);
    }
  }
});

test('invalid names retain requestId and existing field-error precedence', () => {
  const parse = (input: unknown) => parseClientMessage(JSON.stringify(input), limits);
  rejects(() => parseClientMessage('{', limits), 'invalid json', undefined);
  for (const input of [null, [], 'name', 42]) rejects(() => parse(input), 'not an object', undefined);
  rejects(() => parse({ type: 'unknown', requestId: 'length', name: null }), 'unknown type', 'length', 'unknown_type');
  rejects(() => parse({ type: 'unknown', requestId: 'invalid id', name: null }), 'unknown type', undefined, 'unknown_type');
  assert.deepEqual(parse({ type: 'ping', requestId: null, name: 'x'.repeat(100) }), { type: 'ping' });
  const create = { type: 'room:create', requestId: 'length', name: null, roomName: null, codeRequired: 'bad', token: 42 };
  rejects(() => parse(create), 'room:create: name', 'length');
  rejects(() => parse({ ...create, name: 'A' }), 'room:create: roomName', 'length');
  rejects(() => parse({ ...create, name: 'A', roomName: 'B' }), 'room:create: codeRequired', 'length');
  rejects(() => parse({ ...create, name: 'A', roomName: 'B', codeRequired: true }), 'room:create: token', 'length');
  const join = { type: 'join', requestId: 'length', roomId: null, name: null, code: 'bad code', resumeToken: null };
  rejects(() => parse(join), 'join: roomId', 'length');
  rejects(() => parse({ ...join, roomId: 'room' }), 'join: name', 'length');
  rejects(() => parse({ ...join, roomId: 'room', name: 'A' }), 'join: code', 'length');
  rejects(() => parse({ ...join, roomId: 'room', name: 'A', code: 'OK' }), 'join: resumeToken', 'length');
});

function countedName(raw: string, cap: number) {
  const original = String.prototype[Symbol.iterator];
  const strings: string[] = [];
  let yielded = 0;
  // Synchronous, untimed, and restored before assertions; other test files run in isolated processes.
  String.prototype[Symbol.iterator] = function* (this: string): Generator<string, undefined, unknown> {
    strings.push(String(this));
    const iterator = original.call(this);
    for (let item = iterator.next(); !item.done; item = iterator.next()) {
      yielded++;
      yield item.value;
    }
  };
  try {
    const result = sanitizeName(raw, cap);
    return { result, strings, yielded };
  }
  finally { String.prototype[Symbol.iterator] = original; }
}

test('fitting UTF-16 names need no code-point iteration, including after full cleaning', () => {
  for (const raw of ['Alice', '小明茶室', '🐱😀🎵', 'A'.repeat(32), '字'.repeat(32), '&'.repeat(32), 'e\u0301'.repeat(32), '\u200b'.repeat(8192) + ' Alice ']) {
    const expected = historicalName(raw, 32);
    assert.ok(expected);
    const counted = countedName(raw, 32);
    assert.equal(counted.result, expected);
    assert.deepEqual(counted.strings, []);
    assert.equal(counted.yielded, 0);
  }
});

test('astral names above the UTF-16 fast-path threshold are counted as code points', () => {
  for (const cap of [1, 8, limits.nameMaxLength, 64]) {
    for (const raw of ['🐱'.repeat(cap), '\ud83d\u200b\udc31'.repeat(cap)]) {
      const cleaned = '🐱'.repeat(cap);
      const counted = countedName(raw, cap);
      assert.equal(counted.result, cleaned);
      assert.deepEqual(counted.strings, [cleaned]);
      assert.equal(counted.yielded, cap);
    }
  }
});

test('long invalid names stop counting at cap plus one after whole-string cleaning', () => {
  for (const cap of [1, 8, limits.nameMaxLength, 64]) {
    for (const unit of ['A', '字', '🐱']) {
      const cleaned = unit.repeat(4096) + 'éZ';
      const raw = `\u200b ${unit.repeat(4096)}e\u0301\u202eZ\u2028\u3000`;
      const counted = countedName(raw, cap);
      assert.equal(counted.result, undefined);
      assert.deepEqual(counted.strings, [cleaned], 'normalization, stripping, and trim still process the full input');
      assert.equal(counted.yielded, cap + 1, 'rejection must not enumerate the remaining code points');
    }
  }
});
