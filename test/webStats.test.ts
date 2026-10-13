import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { runInNewContext } from 'node:vm';
import { it } from 'node:test';

const source = readFileSync(new URL('../web/src/main.ts', import.meta.url), 'utf8');
const refresh = source.slice(source.indexOf('function refreshConnectionLine()'), source.indexOf('/** Connection stats matter'));
const reset = source.slice(source.indexOf('function resetRoomActions('), source.indexOf('function roomButton('));
const sync = source.slice(source.indexOf('function syncRoomTimers()'), source.indexOf("client.on('state', syncRoomTimers)"));
type Report = { inbound: { rtt?: number; lossPercent?: number } | null; outbound: null };
function setup() {
  const polls: ReturnType<typeof Promise.withResolvers<Report>>[] = [];
  const ui = runInNewContext(stripTypeScriptTypes(`
    let roomActionIdentity = '', roomActionGeneration = 0, connectionPollSequence = 0, roomTimers = [];
    const pendingRoomActions = new Map(), POOR_LOSS_PERCENT = 5;
    const client = { state: null, getStats: collect }, document = { hidden: false };
    const connectionLine = { textContent: '', error: false, classList: { toggle(_name, value) { connectionLine.error = value; } } };
    const setInterval = () => 1, clearInterval = () => {};
    ${reset}
    ${refresh}
    ${sync}
    ({ refresh: refreshConnectionLine, line: () => connectionLine.textContent, error: () => connectionLine.error,
      room(identity) { resetRoomActions(identity); client.state = identity ? {} : null; syncRoomTimers(); } });
  `), { collect() { const poll = Promise.withResolvers<Report>(); polls.push(poll); return poll.promise; }, Map, Math }) as {
    refresh(): void; line(): string; error(): boolean; room(identity: string): void;
  };
  return { ui, polls };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

it('an obsolete empty stats result cannot erase a newer connection display', async () => {
  const { ui, polls } = setup(); ui.room('room/p'); ui.refresh(); ui.refresh();
  polls[1]!.resolve({ inbound: { rtt: 0.04 }, outbound: null }); await flush(); assert.match(ui.line(), /40 ms/);
  polls[0]!.resolve({ inbound: null, outbound: null }); await flush(); assert.match(ui.line(), /40 ms/);
});

it('old room success cannot populate landing or overwrite the same identity after rejoin', async () => {
  const { ui, polls } = setup(); ui.room('room/p'); ui.refresh();
  ui.room(''); polls[0]!.resolve({ inbound: { rtt: 0.8, lossPercent: 20 }, outbound: null }); await flush();
  assert.equal(ui.line(), ''); assert.equal(ui.error(), false);
  ui.room('room/p'); ui.refresh(); ui.room(''); ui.room('room/p'); ui.refresh();
  polls[2]!.resolve({ inbound: { rtt: 0.02 }, outbound: null }); await flush();
  polls[1]!.resolve({ inbound: { rtt: 0.9, lossPercent: 30 }, outbound: null }); await flush();
  assert.match(ui.line(), /20 ms/); assert.equal(ui.error(), false);
});

it('a pending older poll does not block fresh polls and rejected polls do not stop recovery', async () => {
  const { ui, polls } = setup(); ui.room('room/p'); ui.refresh(); ui.refresh();
  assert.equal(polls.length, 2);
  polls[1]!.reject(new Error('stats temporarily unavailable')); await flush();
  ui.refresh(); assert.equal(polls.length, 3);
  polls[2]!.resolve({ inbound: { rtt: 0.06, lossPercent: 8 }, outbound: null }); await flush();
  assert.match(ui.line(), /60 ms/); assert.equal(ui.error(), true);
  polls[0]!.reject(new Error('old peer failed')); await flush(); assert.match(ui.line(), /60 ms/);
});

it('same-room snapshots preserve a current poll and a latest empty report clears stale metrics', async () => {
  const { ui, polls } = setup(); ui.room('room/p'); ui.refresh(); ui.room('room/p');
  polls[0]!.resolve({ inbound: { rtt: 0.03, lossPercent: 10 }, outbound: null }); await flush();
  assert.match(ui.line(), /30 ms/); assert.equal(ui.error(), true);
  ui.refresh(); polls[1]!.resolve({ inbound: null, outbound: null }); await flush();
  assert.equal(ui.line(), ''); assert.equal(ui.error(), false);
});

it('an already queued stats callback does no collection after landing and cannot block rejoin', async () => {
  const { ui, polls } = setup(); ui.room('room/p'); ui.refresh(); ui.room('');
  ui.refresh(); assert.equal(polls.length, 1);
  ui.room('room/p'); ui.refresh(); assert.equal(polls.length, 2);
  polls[1]!.resolve({ inbound: { rtt: 0.01 }, outbound: null }); await flush();
  polls[0]!.resolve({ inbound: null, outbound: null }); await flush(); assert.match(ui.line(), /10 ms/);
});
