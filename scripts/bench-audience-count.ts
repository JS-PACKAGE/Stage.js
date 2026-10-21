/** Getter-only microbenchmark: node scripts/bench-audience-count.ts. Not request or snapshot latency. */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { Room } from '../src/model/room.ts';

/** Preserve the previous scan without overriding the production getter. */
class ScanningRoom extends Room {
  override get audienceCount(): number {
    let count = 0;
    for (const participant of this.participants.values()) if (participant.role === 'audience') count++;
    return count;
  }
}
const participant = (id: string) => ({ participantId: id, name: id, resumeToken: id });
function make(Class: typeof Room, count: number, variant: number): Room {
  const room = new Class({ roomId: `room-${variant}`, name: 'benchmark', code: '', codeRequired: false, now: 0,
    limits: { maxSpeakers: 8, maxAudience: 300 }, controller: participant('controller') });
  for (let i = 1; i < count; i++) room.join(participant(`guest-${i}`), i);
  const speakers = variant % 2 ? Math.min(8, count - 1) : 0;
  for (let i = 1; i <= speakers; i++) {
    room.raiseHand(`guest-${i}`); room.approve('controller', `guest-${i}`, count + i);
  }
  if (variant >= 2) room.leaveStage('controller');
  return room;
}
function readMany(rooms: Room[], iterations: number): number {
  let sum = 0;
  for (let i = 0; i < iterations; i++) sum += rooms[i % rooms.length]!.audienceCount;
  return sum;
}
function sample(rooms: Room[], iterations: number): { ns: number; sum: number } {
  const start = performance.now();
  const sum = readMany(rooms, iterations);
  return { ns: (performance.now() - start) * 1e6 / iterations, sum };
}
function summary(values: number[]) {
  values.sort((a, b) => a - b);
  return { median: values[Math.floor(values.length / 2)]!, min: values[0]!, max: values.at(-1)! };
}
const iterations = 100_000, rounds = 7, warmupPasses = 3, warmupReads = 20_000;
let checksum = 0;
for (const count of [1, 9, 301]) {
  // Four valid rooms vary controller stage presence and zero/maximum non-controller speakers.
  const baseline = Array.from({ length: 4 }, (_, i) => make(ScanningRoom, count, i));
  const current = Array.from({ length: 4 }, (_, i) => make(Room, count, i));
  const expected = readMany(baseline, 4) * iterations / 4;
  assert.equal(readMany(current, 4), readMany(baseline, 4));
  for (let i = 0; i < warmupPasses; i++) {
    checksum += readMany(baseline, warmupReads); checksum += readMany(current, warmupReads);
  }
  const before: number[] = [], after: number[] = [];
  for (let round = 0; round < rounds; round++) {
    for (const optimized of round % 2 ? [true, false] : [false, true]) {
      const result = sample(optimized ? current : baseline, iterations);
      assert.equal(result.sum, expected, 'consume and verify every timed sample outside timing');
      (optimized ? after : before).push(result.ns); checksum += result.sum;
    }
  }
  console.log(JSON.stringify({ node: process.version, participants: count, roomsPerVariant: 4,
    rounds, readsPerRound: iterations, warmupPasses, warmupReads,
    nsPerRead: { previousScan: summary(before), current: summary(after) },
    scope: 'getter-only JIT timing on invariant-valid rooms; no request, broadcast, or snapshot latency claim' }));
}
assert.equal(checksum, 456_000_000);
console.log(JSON.stringify({ checksum }));
