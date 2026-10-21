import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('./node_modules/@stage-js/client/dist/', import.meta.url));
registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const path = resolved.url.startsWith('file:') ? relative(dist, fileURLToPath(resolved.url)) : null;
    assert.ok(path !== null && !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`),
      `Runtime import resolved outside the copied package dist: ${resolved.url}`);
    return resolved;
  },
});

for (const name of [
  'window', 'document', 'navigator', 'HTMLElement', 'customElements', 'Audio', 'AudioContext',
  'webkitAudioContext', 'WebSocket', 'RTCPeerConnection', 'MediaStream', 'fetch', 'XMLHttpRequest', 'EventSource',
]) {
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() { throw new Error(`Unexpected import-time browser/network/audio access: ${name}`); },
  });
}

const root = await import('@stage-js/client');
for (const name of ['StageClient', 'StageError', 'decodeName']) assert.equal(typeof root[name], 'function', `Root export ${name}`);
assert.equal(root.MAX_GAIN_DB, 20);
assert.equal(root.decodeName('&lt;&amp;&gt;'), '<&>');
const error = new root.StageError('disconnected', 'consumer check');
assert.ok(error instanceof Error);
assert.equal(error.code, 'disconnected');

// This registry enforces duplicate tag/constructor rules; it does not emulate a native browser.
const definitions = new Map();
const constructors = new Set();
const HTMLElement = class extends EventTarget {};
Object.defineProperty(globalThis, 'HTMLElement', { configurable: true, value: HTMLElement });
Object.defineProperty(globalThis, 'customElements', {
  configurable: true,
  value: {
    get(name) { return definitions.get(name); },
    define(name, constructor) {
      assert.equal(definitions.has(name), false, `Duplicate element tag: ${name}`);
      assert.equal(constructors.has(constructor), false, `Duplicate element constructor: ${name}`);
      definitions.set(name, constructor);
      constructors.add(constructor);
    },
  },
});

const element = await import('@stage-js/client/element');
for (const name of Object.keys(root)) assert.equal(element[name], root[name], `Shared ${name} identity across entries`);
assert.equal(typeof element.defineStageElement, 'function');
assert.equal(typeof element.StageElement, 'function');
assert.ok(element.StageElement.prototype instanceof HTMLElement);
assert.equal(definitions.get('stage-client'), element.StageElement, 'Element entry automatically registers stage-client');
assert.equal(definitions.size, 1);
element.defineStageElement();
element.defineStageElement('consumer-stage');
const alias = definitions.get('consumer-stage');
assert.notEqual(alias, element.StageElement);
assert.ok(alias?.prototype instanceof element.StageElement, 'Custom tags use a StageElement subclass');
element.defineStageElement('consumer-stage');
assert.equal(definitions.get('consumer-stage'), alias, 'Repeated registration preserves the alias');
assert.equal(definitions.size, 2);
console.log('Client package runtime assertions completed.');
