import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_GAIN_DB, type ErrorCode, type ParticipantView } from '../shared/protocol.ts';
import { StageError } from '../src/model/errors.ts';
import { Room, type RoomLimits } from '../src/model/room.ts';

const operations = [
  'join', 'remove', 'kick', 'raiseHand', 'withdrawHand', 'approve', 'reject',
  'leaveStage', 'removeFromStage', 'transfer', 'mute', 'unmute', 'forceMute',
  'forceUnmute', 'setGain', 'rotateCode', 'connected',
] as const;
type Operation = typeof operations[number];
const controlled = new Set<Operation>([
  'kick', 'approve', 'reject', 'removeFromStage', 'transfer', 'forceMute',
  'forceUnmute', 'setGain', 'rotateCode',
]);
interface Action {
  op: Operation;
  target: string;
  by: string;
  now: number;
  value: number;
  expected?: 'ok' | ErrorCode;
}
type PlannedAction = Pick<Action, 'op'> & Partial<Omit<Action, 'op'>>;
interface Member {
  id: string;
  token: string;
  joinedAt: number;
  stage?: number;
  hand?: number;
  selfMuted: boolean;
  forced: boolean;
  gain: number;
  connected: boolean;
}
interface Ledger {
  controller: string;
  code: string;
  codeRequired: boolean;
  limits: RoomLimits;
  members: Member[];
}

const person = (id: string, serial: number) => ({
  participantId: id, name: `Name ${id}`, resumeToken: `private-token-${id}-${serial}`,
});
const member = (id: string, now: number, serial: number): Member => ({
  id, token: person(id, serial).resumeToken, joinedAt: now,
  selfMuted: false, forced: false, gain: 0, connected: true,
});
const staged = (m: Ledger) => m.members.filter(p => p.stage !== undefined).sort((a, b) => a.stage! - b.stage!);
const hands = (m: Ledger) => m.members.filter(p => p.hand !== undefined).sort((a, b) => a.hand! - b.hand!);
const audience = (m: Ledger) => m.members.filter(p => p.id !== m.controller && p.stage === undefined);
const view = (m: Ledger, p: Member): ParticipantView => ({
  participantId: p.id, name: `Name ${p.id}`,
  role: p.id === m.controller ? 'controller' : p.stage !== undefined ? 'speaker' : 'audience',
  onStage: p.stage !== undefined, handRaised: p.hand !== undefined,
  muted: p.selfMuted || p.forced, forceMuted: p.forced,
  gainDb: p.gain, connected: p.connected, joinedAt: p.joinedAt,
});

function completeState(r: Room): unknown {
  // Map/Set deep equality ignores insertion order, so compare their ordered entries.
  return Object.fromEntries(Object.entries(r).map(([key, value]) => [key,
    structuredClone(value instanceof Map || value instanceof Set ? [...value] : value),
  ]));
}

function execute(r: Room, a: Action, serial: number): void {
  switch (a.op) {
    case 'join': r.join(person(a.target, serial), a.now); break;
    case 'approve': r.approve(a.by, a.target, a.now); break;
    case 'setGain': r.setGain(a.by, a.target, a.value); break;
    case 'rotateCode': r.rotateCode(a.by, `CODE${serial}`); break;
    // Presence is maintained by the hub directly, so it is an explicit input here too.
    case 'connected': r.get(a.target)!.connected = Boolean(a.value); break;
    case 'kick': case 'reject': case 'removeFromStage': case 'transfer':
    case 'forceMute': case 'forceUnmute': r[a.op](a.by, a.target); break;
    default: r[a.op](a.target);
  }
}

// This ledger records successful commands only. It deliberately does not copy Room's
// validation branches: fixed boundary cases below check policy, and every refusal must
// preserve the entire room. Roles, queues and stage order are derived independently.
function record(m: Ledger, a: Action, serial: number): void {
  if (a.op === 'join') { m.members.push(member(a.target, a.now, serial)); return; }
  if (a.op === 'rotateCode') { m.code = `CODE${serial}`; return; }
  const p = m.members.find(p => p.id === a.target);
  assert.ok(p, 'a successful command must address a member');
  switch (a.op) {
    case 'kick': case 'remove': m.members = m.members.filter(other => other !== p); break;
    case 'raiseHand': p.hand = serial; break;
    case 'reject': case 'withdrawHand': p.hand = undefined; break;
    case 'approve': p.stage = serial; p.hand = undefined; break;
    case 'leaveStage': case 'removeFromStage':
      p.stage = undefined; p.selfMuted = false; p.forced = false; break;
    case 'transfer': m.controller = p.id; p.hand = undefined; break;
    case 'mute': case 'unmute': p.selfMuted = a.op === 'mute'; break;
    case 'forceMute': case 'forceUnmute': p.forced = a.op === 'forceMute'; break;
    case 'setGain': p.gain = a.value; break;
    case 'connected': p.connected = Boolean(a.value); break;
  }
}

function verify(r: Room, m: Ledger): void {
  r.assertInvariants();
  const shared = {
    roomId: 'room', name: 'Sequence room', controllerId: m.controller,
    speakers: staged(m).map(p => view(m, p)), hands: hands(m).map(p => view(m, p)),
    audienceCount: audience(m).length, codeRequired: m.codeRequired, recording: false, recordingAvailable: false,
    limits: m.limits, status: staged(m).length ? 'live' : 'waiting',
  };
  assert.deepEqual(r.sharedSnapshot(), shared, 'shared snapshot has exactly the public fields');
  for (const p of m.members) {
    const personal = {
      me: view(m, p), resumeToken: p.token,
      ...(p.id === m.controller ? { audience: audience(m).map(p => view(m, p)) } : {}),
      ...(p.id === m.controller && m.codeRequired ? { code: m.code } : {}),
    };
    assert.deepEqual(r.personalSnapshot(p.id), personal, 'only the recipient token and authorized private fields');
    assert.deepEqual(r.snapshot(p.id), { ...shared, ...personal }, 'full recipient snapshot matches the ledger');
  }
  assert.equal(r.audienceCount, audience(m).length);
  assert.equal(r.speakerCount, staged(m).filter(p => p.id !== m.controller).length);
  const successor = staged(m).find(p => p.id !== m.controller && p.connected)
    ?? audience(m).find(p => p.connected);
  assert.equal(r.pickSuccessor()?.participantId, successor?.id, 'succession follows entry order, skipping disconnected seats');
}

function boundaries(limits: RoomLimits, codeRequired: boolean): PlannedAction[] {
  const steps: PlannedAction[] = [];
  const add = (op: Operation, target = 'host', extra: Partial<Action> = {}) => {
    steps.push({ op, target, expected: 'ok', ...extra });
  };
  for (let i = 0; i < limits.maxAudience; i++) {
    add('join', `p${i}`, { now: i % 2 ? 100 : 2_000_000 });
  }
  add('join', 'overflow', { expected: 'room_full' });
  add('raiseHand', 'p0');
  add('raiseHand', 'p1');
  add('raiseHand', 'p0', { expected: 'conflict' });
  add('withdrawHand', 'p0');
  add('raiseHand', 'p0');
  for (let i = 0; i < limits.maxSpeakers; i++) {
    if (i > 1) add('raiseHand', `p${i}`);
    add('approve', `p${i}`, { now: i % 2 ? 100 : 2_000_000 });
  }
  const next = `p${limits.maxSpeakers}`;
  add('raiseHand', next);
  add('approve', next, { expected: 'stage_full' });
  add('transfer', next, { expected: 'stage_full' });
  add('setGain', 'p0', { value: -MAX_GAIN_DB });
  add('setGain', 'p1', { value: MAX_GAIN_DB });
  add('setGain', 'p0', { by: 'p1', expected: 'forbidden' });
  add('rotateCode', 'host', { expected: codeRequired ? 'ok' : 'conflict' });
  add('mute', 'missing', { expected: 'not_found' });
  add('mute', 'p0');
  add('forceMute', 'p0');
  add('unmute', 'p0', { expected: 'forbidden' });
  add('forceUnmute', 'p0');
  add('unmute', 'p0');
  add('connected', 'p0', { value: 0 });
  add('connected', 'p1', { value: 0 });
  add('leaveStage', 'p0');
  add('raiseHand', 'p0');
  add('approve', 'p0', { expected: 'conflict' });
  add('connected', 'p0', { value: 1 });
  add('approve', 'p0', { now: 50 });
  add('connected', 'p1', { value: 1 });
  add('leaveStage', 'host');
  add('transfer', next);
  add('approve', next, { by: next });
  add('setGain', 'p0', { by: 'host', expected: 'forbidden' });
  add('removeFromStage', 'p1', { by: next });
  add('raiseHand', 'p1');
  add('reject', 'p1', { by: next });
  add('remove', 'p1');
  add('join', 'p1', { now: 1 });
  add('kick', 'p1', { by: next });
  return steps;
}

function random(seed: number): () => number {
  let state = Math.imul(seed, 0x9e3779b1) >>> 0;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function generate(m: Ledger, rand: () => number, serial: number): PlannedAction {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
  let op = pick([...operations, 'join', 'raiseHand', 'approve', 'connected'] as const);
  const others = m.members.filter(p => p.id !== m.controller);
  if (op === 'remove' && !others.length) op = 'join';
  if (op === 'join') return { op, target: `new-${serial}` };
  const by = rand() < 0.8 ? m.controller : pick(others)?.id ?? 'outsider';
  let candidates = m.members;
  if (rand() < 0.75) {
    switch (op) {
      case 'raiseHand': candidates = audience(m).filter(p => p.hand === undefined); break;
      case 'approve': candidates = m.members.filter(p => p.stage === undefined && (p.hand !== undefined || p.id === by)); break;
      case 'reject': case 'withdrawHand': candidates = hands(m); break;
      case 'leaveStage': case 'removeFromStage': case 'mute': case 'unmute':
      case 'forceMute': case 'forceUnmute': candidates = staged(m); break;
      case 'transfer': candidates = others.filter(p => p.connected); break;
      case 'kick': candidates = others; break;
    }
  }
  if (op === 'remove') candidates = others;
  let target = pick(candidates.length ? candidates : m.members).id;
  if (op !== 'connected' && op !== 'remove' && rand() < 0.05) target = 'missing';
  return {
    op, target, by,
    value: op === 'connected' ? Number(rand() < 0.6) : Math.round((rand() * 2 - 1) * MAX_GAIN_DB),
    ...(controlled.has(op) && by !== m.controller ? { expected: 'forbidden' } : {}),
  };
}

for (let seed = 1; seed <= 12; seed++) {
  test(`Room sequence properties, seed ${seed}`, () => {
    const limits = seed % 2 ? { maxSpeakers: 2, maxAudience: 8 } : { maxSpeakers: 8, maxAudience: 19 };
    const codeRequired = seed % 3 !== 0;
    const r = new Room({
      roomId: 'room', name: 'Sequence room', code: 'INITIALCODE', codeRequired,
      limits: { ...limits }, now: 1_000_000, controller: person('host', 0),
    });
    const m: Ledger = {
      controller: 'host', code: 'INITIALCODE', codeRequired, limits: { ...limits },
      members: [member('host', 1_000_000, 0)],
    };
    m.members[0]!.stage = 0;
    const rand = random(seed), prefix = boundaries(limits, codeRequired);
    const trace: Action[] = [], succeeded = new Set<Operation>(), rejected = new Set<ErrorCode>();
    const clockDirections = new Set<number>();
    let now = 1_000_000;
    try {
      verify(r, m);
      for (let step = 0; step < 500; step++) {
        const serial = step + 1;
        const planned = prefix[step] ?? generate(m, rand, serial);
        const nextTime = planned.now ?? Math.max(0, now + [-100_000, 0, 100_000][Math.floor(rand() * 3)]!);
        clockDirections.add(Math.sign(nextTime - now));
        now = nextTime;
        const action: Action = { target: 'host', by: m.controller, value: 0, ...planned, now };
        trace.push(action);
        // Clone all own state, including non-wire fields, Map/Set ordering and tokens.
        const before = completeState(r);
        let failure: StageError | undefined;
        try { execute(r, action, serial); }
        catch (error) { assert.ok(error instanceof StageError); failure = error; }
        if (failure) {
          assert.deepEqual(completeState(r), before, 'rejected command mutated room state');
          if (action.expected) assert.equal(failure.code, action.expected, 'unexpected rejection');
          rejected.add(failure.code);
        } else {
          assert.ok(!action.expected || action.expected === 'ok', `expected ${action.expected}, received success`);
          record(m, action, serial);
          succeeded.add(action.op);
        }
        verify(r, m);
      }
      for (const op of operations) {
        if (op !== 'rotateCode' || codeRequired) assert.ok(succeeded.has(op), `no successful ${op}`);
      }
      for (const code of ['room_full', 'stage_full', 'conflict', 'forbidden', 'not_found']) {
        assert.ok(rejected.has(code as ErrorCode), `no ${code} rejection`);
      }
      assert.deepEqual([...clockDirections].sort(), [-1, 0, 1], 'exercise backwards, repeated and forwards wall times');
    } catch (error) {
      throw new Error(`Room sequence failed: seed=${seed}, limits=${JSON.stringify(limits)}, codeRequired=${codeRequired}\nAction trace:\n${trace.map((a, i) => `${i}: ${JSON.stringify(a)}`).join('\n')}`, { cause: error });
    }
  });
}
