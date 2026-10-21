import { types } from 'node:util';

/**
 * Minimal structured logger. Security rule (AGENTS.md §S5/§S8/§S10): never pass
 * room codes, resume tokens, TURN credentials or raw SDP into log fields.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** Field names that must never reach the log, even by accident. */
const REDACT = /^(code|resumeToken|token|credential|password|username|secret|sdp|payload)$/i;

/** Formatting bounds keep unexpected diagnostic objects from recursively expanding a log entry. */
const MAX_DEPTH = 8;
const MAX_ENTRIES = 1000;
function safeFields(fields: Record<string, unknown>): Record<string, unknown> {
  const ancestors = new WeakSet<object>();
  let remaining = MAX_ENTRIES;
  const visit = (value: unknown, depth: number): unknown => {
    if (typeof value === 'bigint') return String(value);
    if (typeof value === 'function') return '[Function]';
    if (value === null || typeof value !== 'object') return value;
    // A proxy's reflection traps are arbitrary code, just like accessors and toJSON hooks.
    if (types.isProxy(value)) return '[Proxy]';
    if (ancestors.has(value)) return '[Circular]';
    if (depth >= MAX_DEPTH) return '[MaxDepth]';
    ancestors.add(value);
    try {
      if (types.isDate(value)) return Number.isFinite(Date.prototype.getTime.call(value)) ? Date.prototype.toISOString.call(value) : null;
      const read = (key: string, descriptor?: PropertyDescriptor): unknown => REDACT.test(key) ? '[redacted]'
        : descriptor && ('value' in descriptor ? visit(descriptor.value, depth + 1) : '[Accessor]');
      if (Array.isArray(value)) {
        const out: unknown[] = [];
        for (let i = 0; i < value.length; i++) {
          if (remaining-- <= 0) { out.push('[Truncated]'); break; }
          out.push(read(String(i), Object.getOwnPropertyDescriptor(value, String(i))) ?? null);
        }
        return out;
      }
      const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      const error = types.isNativeError(value);
      const keys = error ? [...new Set(['name', 'message', 'stack', 'cause', ...Object.keys(value)])] : Object.keys(value);
      for (const key of keys) {
        if (remaining-- <= 0) { out['[truncated]'] = '[Truncated]'; break; }
        if (REDACT.test(key)) { out[key] = '[redacted]'; continue; }
        let descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (error && key === 'name' && !descriptor) {
          let prototype: unknown = Object.getPrototypeOf(value);
          for (let i = 0; i < MAX_DEPTH && prototype && typeof prototype === 'object' && !types.isProxy(prototype); i++) {
            descriptor = Object.getOwnPropertyDescriptor(prototype, 'name');
            if (descriptor) break;
            prototype = Object.getPrototypeOf(prototype);
          }
          if (!descriptor) descriptor = { value: 'Error' };
        }
        out[key] = read(key, descriptor);
      }
      return out;
    } catch { return '[Unserializable]'; }
    finally { ancestors.delete(value); }
  };
  const result = visit(fields, 0);
  return result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : { fields: result };
}


export function createLogger(level: LogLevel, sink: (line: string) => void = (l) => process.stderr.write(l + '\n')): Logger {
  const min = ORDER[level];
  const emit = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    sink(JSON.stringify({ t: new Date().toISOString(), level: lvl, msg, ...(fields ? safeFields(fields) : {}) }));
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
