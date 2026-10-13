import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { ConfigError, parseConfig } from '../src/config.ts';
import { ConnectionRateLimiter } from '../src/ws/rateLimit.ts';

const MAX_TIMER_MS = 2_147_483_647;
const EXAMPLE = readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8');
const FIELDS = [
  { section: 'limits', key: 'joinTimeoutMs', min: 0, default: 30000 },
  { section: 'rooms', key: 'controllerGraceMs', min: 0, default: 60000 },
  { section: 'rooms', key: 'participantGraceMs', min: 0, default: 15000 },
  { section: 'rooms', key: 'heartbeatIntervalMs', min: 1000, default: 30000 },
] as const;

function rawConfig(): Record<string, Record<string, unknown>> {
  return parse(EXAMPLE) as Record<string, Record<string, unknown>>;
}

describe('server timer configuration bounds', () => {
  for (const field of FIELDS) {
    const path = `${field.section}.${field.key}`;

    it(`${path} preserves its example default and inclusive supported range`, () => {
      const raw = rawConfig();
      assert.equal(Reflect.get(parseConfig(raw)[field.section], field.key), field.default);
      for (const valid of [field.min, field.min + 1, MAX_TIMER_MS]) {
        raw[field.section]![field.key] = valid;
        assert.equal(Reflect.get(parseConfig(raw)[field.section], field.key), valid);
      }
    });

    it(`${path} rejects timer overflow instead of silently scheduling at 1 ms`, () => {
      for (const invalid of [MAX_TIMER_MS + 1, Number.MAX_SAFE_INTEGER]) {
        const raw = rawConfig();
        raw[field.section]![field.key] = invalid;
        assert.throws(() => parseConfig(raw), (error: unknown) =>
          error instanceof ConfigError && error.message === `${path}: expected integer in [${field.min}, ${MAX_TIMER_MS}]`);
      }
    });

    it(`${path} rejects below-minimum, fractional, non-finite and non-number values`, () => {
      for (const invalid of [field.min - 1, field.min + 0.5, Infinity, -Infinity, NaN, '1000', true, null, undefined, [], {}]) {
        const raw = rawConfig();
        raw[field.section]![field.key] = invalid;
        assert.throws(() => parseConfig(raw), (error: unknown) =>
          error instanceof ConfigError && error.message.startsWith(`${path}: expected integer in [`));
      }
    });
  }

  it('preserves zero sentinels for joining and grace, while heartbeat still needs at least 1000 ms', () => {
    const raw = rawConfig();
    raw.limits!.joinTimeoutMs = 0;
    raw.rooms!.controllerGraceMs = 0;
    raw.rooms!.participantGraceMs = 0;
    const config = parseConfig(raw);
    assert.equal(config.limits.joinTimeoutMs, 0);
    assert.equal(config.rooms.controllerGraceMs, 0);
    assert.equal(config.rooms.participantGraceMs, 0);
    for (const invalid of [0, 1, 999]) {
      raw.rooms!.heartbeatIntervalMs = invalid;
      assert.throws(() => parseConfig(raw), /rooms\.heartbeatIntervalMs/);
    }
  });

  it('does not restrict hand-raise elapsed comparisons to the native timer range', () => {
    for (const valid of [0, 10000, MAX_TIMER_MS + 1, Number.MAX_SAFE_INTEGER]) {
      const raw = rawConfig();
      raw.limits!.handRaiseIntervalMs = valid;
      assert.equal(parseConfig(raw).limits.handRaiseIntervalMs, valid);
    }
    const raw = rawConfig();
    raw.limits!.handRaiseIntervalMs = MAX_TIMER_MS + 1;
    const limiter = new ConnectionRateLimiter(parseConfig(raw).limits, 0);
    assert.equal(limiter.allow('hand:raise', 0), true);
    assert.equal(limiter.allow('hand:raise', 1), false);
    assert.equal(limiter.allow('hand:raise', MAX_TIMER_MS), false);
    assert.equal(limiter.allow('hand:raise', MAX_TIMER_MS + 1), true);
  });

  it('matches native timeout and interval bounds without running their callbacks', t => {
    const warnings = t.mock.method(process, 'emitWarning', () => {});
    let callbacks = 0;
    for (const delay of [MAX_TIMER_MS, MAX_TIMER_MS + 1, Number.MAX_SAFE_INTEGER]) {
      for (const schedule of [setTimeout, setInterval]) {
        const timer = schedule(() => { callbacks++; }, delay);
        // Inspect normalization synchronously and always clear: no day-long wait or hot interval.
        try {
          const normalized = (timer as NodeJS.Timeout & { _idleTimeout: number })._idleTimeout;
          assert.equal(normalized, delay === MAX_TIMER_MS ? MAX_TIMER_MS : 1);
        } finally { clearTimeout(timer); }
      }
    }
    assert.equal(callbacks, 0);
    assert.equal(warnings.mock.callCount(), 4);
  });
});
