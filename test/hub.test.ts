import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { FakeSession, harness, RECVONLY_OFFER, SENDRECV_OFFER, sine, testConfig } from './helpers.ts';

const FRAME = 960;

function energy(x: Float32Array): number {
  let e = 0;
  for (const v of x) e += v * v;
  return e / x.length;
}

describe('flow 1 — raise hand → approve → on stage with uplink', () => {
  it('runs the full sequence and mixes the new speaker for the audience but not for themselves', async () => {
    const h = harness();
    const host = await h.create('Host');
    const aud = await h.join(host.roomId, host.code, 'Alice');
    const other = await h.join(host.roomId, host.code, 'Bob');

    assert.equal(await h.req(aud.s, { type: 'rtc:offer', payload: RECVONLY_OFFER }), 'ok');
    assert.equal(await h.req(other.s, { type: 'rtc:offer', payload: RECVONLY_OFFER }), 'ok');
    assert.equal(await h.req(aud.s, { type: 'hand:raise' }), 'ok');
    assert.deepEqual(other.s.last('hand:raise'), { type: 'hand:raise', participantId: aud.id });
    assert.deepEqual(host.s.last('room:state')!.hands.map((p) => p.participantId), [aud.id]);

    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: aud.id }), 'ok');
    assert.deepEqual(aud.s.last('stage:invite'), { type: 'stage:invite', participantId: aud.id, byId: host.id });
    const me = aud.s.last('room:state')!.me;
    assert.equal(me.role, 'speaker');
    assert.equal(me.onStage, true);
    assert.equal(me.handRaised, false);

    aud.s.clear();
    assert.equal(await h.req(aud.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
    assert.equal(aud.s.last('rtc:answer')!.fromId, 'server');
    assert.deepEqual(other.s.last('stage:joined'), { type: 'stage:joined', participantId: aud.id, role: 'speaker' });
    assert.ok(aud.s.all('rtc:ice').length > 0, 'server ICE trickled to client');

    assert.equal(h.transport.emitUplink(host.roomId, aud.id, sine(FRAME, 0.5)), true);
    h.mixers.get(host.roomId)!.tick();
    const peers = h.transport.rooms.get(host.roomId)!.peers;
    assert.ok(energy(peers.get(other.id)!.received.at(-1)!) > 0.05, 'audience hears the speaker');
    assert.equal(energy(peers.get(aud.id)!.received.at(-1)!), 0, 'speaker gets mix-minus-self');
    assert.deepEqual(other.s.last('speaking'), { type: 'speaking', participantIds: [aud.id] }, 'audience sees who is talking');
  });

  it('rejects approve without a raised hand and beyond the 8-speaker cap', async () => {
    const h = harness();
    const host = await h.create();
    const people = [];
    for (let i = 0; i < 8; i++) people.push(await h.join(host.roomId, host.code, `P${i}`));
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: people[0]!.id }), 'conflict');
    for (const p of people) assert.equal(await h.req(p.s, { type: 'hand:raise' }), 'ok');
    // Host already occupies one of the 8 seats.
    for (let i = 0; i < 7; i++) assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: people[i]!.id }), 'ok');
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: people[7]!.id }), 'stage_full');
    assert.equal(host.s.last('room:state')!.speakers.length, 8);
  });
});

describe('audience cannot send audio', () => {
  it('rejects a sendrecv offer from audience and drops any uplink', async () => {
    const h = harness();
    const host = await h.create();
    const aud = await h.join(host.roomId, host.code, 'Eve');
    assert.equal(await h.req(aud.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'forbidden');
    assert.equal(aud.s.all('rtc:answer').length, 0);
    assert.equal(h.transport.emitUplink(host.roomId, aud.id, sine(FRAME, 0.5)), false);
  });

  it('stops mixing a speaker the moment they are removed from stage', async () => {
    const h = harness();
    const host = await h.create();
    const sp = await h.join(host.roomId, host.code, 'Sam');
    await h.req(sp.s, { type: 'hand:raise' });
    await h.req(host.s, { type: 'stage:approve', targetId: sp.id });
    await h.req(sp.s, { type: 'rtc:offer', payload: SENDRECV_OFFER });
    assert.equal(h.transport.emitUplink(host.roomId, sp.id, sine(FRAME, 0.5)), true);

    assert.equal(await h.req(host.s, { type: 'stage:remove', targetId: sp.id }), 'ok');
    assert.deepEqual(sp.s.last('stage:left'), { type: 'stage:left', participantId: sp.id, role: 'audience', reason: 'removed' });
    assert.equal(h.transport.emitUplink(host.roomId, sp.id, sine(FRAME, 0.5)), false);
    // Re-offering sendrecv as audience is refused again.
    assert.equal(await h.req(sp.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'forbidden');
  });
});

describe('flow 2 — leave stage', () => {
  it('speaker leaving becomes audience and switches to the full mix', async () => {
    const h = harness();
    const host = await h.create();
    const sp = await h.join(host.roomId, host.code, 'Sam');
    await h.req(sp.s, { type: 'hand:raise' });
    await h.req(host.s, { type: 'stage:approve', targetId: sp.id });
    await h.req(sp.s, { type: 'rtc:offer', payload: SENDRECV_OFFER });
    await h.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER });

    assert.equal(await h.req(sp.s, { type: 'stage:leave' }), 'ok');
    assert.deepEqual(host.s.last('stage:left'), { type: 'stage:left', participantId: sp.id, role: 'audience', reason: 'leave' });
    assert.equal(sp.s.last('room:state')!.me.role, 'audience');
    assert.equal(h.transport.emitUplink(host.roomId, sp.id, sine(FRAME, 0.5)), false);

    h.transport.emitUplink(host.roomId, host.id, sine(FRAME, 0.5));
    h.mixers.get(host.roomId)!.tick();
    const received = h.transport.rooms.get(host.roomId)!.peers.get(sp.id)!.received.at(-1)!;
    assert.ok(energy(received) > 0.05, 'former speaker now hears the host');
  });

  it('controller leaving stage keeps control', async () => {
    const h = harness();
    const host = await h.create();
    const aud = await h.join(host.roomId, host.code, 'Ann');
    assert.equal(await h.req(host.s, { type: 'stage:leave' }), 'ok');
    const st = host.s.last('room:state')!;
    assert.equal(st.controllerId, host.id);
    assert.equal(st.me.role, 'controller');
    assert.equal(st.me.onStage, false);
    assert.equal(st.speakers.length, 0);
    assert.equal(st.status, 'waiting');
    assert.deepEqual(aud.s.last('status'), { type: 'status', state: 'waiting' });

    await h.req(aud.s, { type: 'hand:raise' });
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: aud.id }), 'ok', 'still holds approval power');
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: host.id }), 'ok', 'self-approve returns to stage');
    assert.equal(host.s.last('room:state')!.me.onStage, true);
  });
});

describe('flow 3 — control transfer', () => {
  it('moves control; old controller on stage becomes speaker and loses powers', async () => {
    const h = harness();
    const host = await h.create();
    const a = await h.join(host.roomId, host.code, 'A');
    const b = await h.join(host.roomId, host.code, 'B');

    assert.equal(await h.req(a.s, { type: 'control:transfer', targetId: a.id }), 'forbidden');
    assert.equal(await h.req(host.s, { type: 'control:transfer', targetId: a.id }), 'ok');
    assert.deepEqual(b.s.last('control:transferred'), { type: 'control:transferred', fromId: host.id, toId: a.id });
    const st = b.s.last('room:state')!;
    assert.equal(st.controllerId, a.id);
    assert.equal(host.s.last('room:state')!.me.role, 'speaker');
    assert.equal(a.s.last('room:state')!.me.role, 'controller');
    assert.equal(a.s.last('room:state')!.me.onStage, false, 'new controller keeps their stage position');
    assert.ok(a.s.last('room:state')!.audience, 'controller-only audience list');
    assert.equal(host.s.last('room:state')!.audience, undefined);

    await h.req(b.s, { type: 'hand:raise' });
    assert.equal(await h.req(host.s, { type: 'stage:approve', targetId: b.id }), 'forbidden');
    assert.equal(await h.req(a.s, { type: 'stage:approve', targetId: b.id }), 'ok');
  });

  it('concurrent transfers never yield two controllers', async () => {
    const h = harness();
    const host = await h.create();
    const a = await h.join(host.roomId, host.code, 'A');
    const b = await h.join(host.roomId, host.code, 'B');
    const results = await Promise.all([
      h.req(host.s, { type: 'control:transfer', targetId: a.id }),
      h.req(host.s, { type: 'control:transfer', targetId: b.id }),
      h.req(a.s, { type: 'control:transfer', targetId: b.id }),
    ]);
    // Queue order: host→A succeeds, host→B is now forbidden, A→B succeeds.
    assert.deepEqual(results, ['ok', 'forbidden', 'ok']);
    const st = b.s.last('room:state')!;
    const roles = [st.me, ...st.speakers, ...(st.audience ?? [])].filter((p) => p.role === 'controller');
    assert.deepEqual([...new Set(roles.map((p) => p.participantId))], [b.id]);
  });

  it('auto-transfers after the controller grace period, not before; resume reclaims the seat', async () => {
    const config = testConfig();
    const h = harness(config);
    const host = await h.create();
    const a = await h.join(host.roomId, host.code, 'A');
    const b = await h.join(host.roomId, host.code, 'B');
    await h.req(b.s, { type: 'hand:raise' });
    await h.req(host.s, { type: 'stage:approve', targetId: b.id });

    const token = host.s.last('room:state')!.resumeToken!;
    await h.hub.detach(host.s);
    const grace = h.timers.filter((t) => !t.cleared);
    assert.equal(grace.length, 1);
    assert.equal(grace[0]!.ms, config.rooms.controllerGraceMs);
    assert.equal(a.s.last('room:state')!.controllerId, host.id, 'seat held during grace');

    // Resume within grace.
    const back = new FakeSession();
    h.hub.attach(back);
    assert.equal(await h.req(back, { type: 'join', roomId: host.roomId, code: host.code, name: 'Host', resumeToken: token }), 'ok');
    assert.equal(back.last('room:state')!.me.participantId, host.id);
    assert.equal(back.last('room:state')!.me.role, 'controller');
    assert.equal(grace[0]!.cleared, true);

    // Disconnect again and let the grace expire: earliest on-stage speaker (B) wins over earlier audience (A).
    await h.hub.detach(back);
    h.timers.at(-1)!.fn();
    await nextTurn();
    const st = a.s.last('room:state')!;
    assert.equal(st.controllerId, b.id);
    assert.ok(!st.speakers.some((p) => p.participantId === host.id), 'old controller removed');
    assert.deepEqual(a.s.last('control:transferred'), { type: 'control:transferred', fromId: host.id, toId: b.id });
  });
});

describe('presence broadcasts', () => {
  it('folds a burst of audience joins and leaves into one room:state per window; stage changes stay immediate', async () => {
    const config = testConfig();
    const h = harness(config);
    const host = await h.create();
    host.s.clear();
    const crowd = [];
    for (let i = 0; i < 3; i++) crowd.push(await h.join(host.roomId, host.code, `A${i}`));
    for (const [i, p] of crowd.entries()) assert.equal(p.s.all('room:state')[0]!.audienceCount, i + 1, 'each joiner gets its own snapshot at once');
    assert.equal(host.s.all('room:state').length, 0, 'held back');
    const pending = h.timers.filter((t) => !t.cleared);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.ms, config.rooms.presenceBroadcastMs);
    pending[0]!.fn();
    assert.equal(host.s.all('room:state').length, 1);
    assert.equal(host.s.last('room:state')!.audience!.length, 3);

    host.s.clear();
    await h.hub.detach(crowd[0]!.s);
    assert.equal(host.s.all('room:state').length, 0, 'a plain audience leave is coalesced too');
    // A raised hand changes the queue everyone sees: broadcast now, superseding the pending one.
    await h.req(crowd[1]!.s, { type: 'hand:raise' });
    assert.equal(host.s.last('room:state')!.audienceCount, 2);
    assert.ok(h.timers.every((t) => t.cleared || t === pending[0]), 'pending presence broadcast superseded');
  });
});

describe('flow 4 — open and close rooms', () => {
  it('requires the room code, closes for everyone, and releases resources', async () => {
    const h = harness();
    const host = await h.create();
    assert.match(host.code, /^[A-Z0-9]{8}$/);
    assert.equal(host.s.last('room:created')!.code, host.code);

    const intruder = new FakeSession();
    assert.equal(await h.req(intruder, { type: 'join', roomId: host.roomId, name: 'X' }), 'unauthorized');
    assert.equal(await h.req(intruder, { type: 'join', roomId: host.roomId, code: 'WRONG123', name: 'X' }), 'unauthorized');
    assert.equal(await h.req(intruder, { type: 'join', roomId: 'nope', code: host.code, name: 'X' }), 'unauthorized');

    const a = await h.join(host.roomId, host.code, 'A');
    assert.equal(a.s.last('room:state')!.code, undefined, 'code only visible to the controller');
    assert.equal(await h.req(a.s, { type: 'room:close' }), 'forbidden');

    assert.equal(await h.req(host.s, { type: 'room:close' }), 'ok');
    assert.deepEqual(a.s.last('room:closed'), { type: 'room:closed', roomId: host.roomId });
    assert.deepEqual(host.s.last('room:closed'), { type: 'room:closed', roomId: host.roomId });
    assert.equal(h.hub.roomCount, 0);
    assert.equal(h.transport.rooms.has(host.roomId), false);
    assert.equal(await h.req(a.s, { type: 'hand:raise' }), 'not_joined');
    assert.equal(await h.req(a.s, { type: 'join', roomId: host.roomId, code: host.code, name: 'A' }), 'unauthorized');
  });

  it('rooms without a code accept joins without one', async () => {
    const h = harness();
    const host = await h.create('Host', { codeRequired: false });
    assert.equal(host.s.last('room:created')!.code, undefined);
    await h.join(host.roomId, undefined, 'Guest');
  });

  it('requires rooms.createToken to create a room when one is configured', async () => {
    const h = harness(testConfig((c) => { c.rooms.createToken = 'let-me-in'; }));
    const s = new FakeSession();
    assert.equal(await h.req(s, { type: 'room:create', name: 'H' }), 'unauthorized');
    assert.equal(await h.req(s, { type: 'room:create', name: 'H', token: 'let-me-iN' }), 'unauthorized');
    assert.equal(h.hub.roomCount, 0);
    assert.equal(await h.req(s, { type: 'room:create', name: 'H', token: 'let-me-in' }), 'ok');
    assert.equal(h.hub.roomCount, 1);
  });

  it('two rooms do not interfere', async () => {
    const h = harness();
    const r1 = await h.create('H1');
    const r2 = await h.create('H2');
    const a1 = await h.join(r1.roomId, r1.code, 'A1');
    const a2 = await h.join(r2.roomId, r2.code, 'A2');
    a2.s.clear();
    r2.s.clear();

    await h.req(a1.s, { type: 'hand:raise' });
    await h.req(r1.s, { type: 'stage:approve', targetId: a1.id });
    assert.equal(await h.req(r1.s, { type: 'stage:approve', targetId: a2.id }), 'not_found', 'cannot target other room');
    assert.equal(await h.req(r1.s, { type: 'room:close' }), 'ok');

    assert.equal(a2.s.inbox.length, 0, 'room 2 saw nothing');
    assert.equal(r2.s.inbox.length, 0);
    assert.equal(await h.req(a2.s, { type: 'hand:raise' }), 'ok');
    assert.equal(h.hub.roomCount, 1);
  });
});

describe('moderation', () => {
  it('kicks a speaker out of the room: media torn down, connection closed, others updated', async () => {
    const h = harness();
    const host = await h.create();
    const a = await h.join(host.roomId, host.code, 'A');
    const b = await h.join(host.roomId, host.code, 'B');
    await h.req(a.s, { type: 'hand:raise' });
    await h.req(host.s, { type: 'stage:approve', targetId: a.id });
    assert.equal(await h.req(a.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
    assert.equal(await h.req(b.s, { type: 'participant:kick', targetId: a.id }), 'forbidden', 'controller only');
    assert.equal(await h.req(host.s, { type: 'participant:kick', targetId: host.id }), 'conflict');

    assert.equal(await h.req(host.s, { type: 'participant:kick', targetId: a.id }), 'ok');
    assert.deepEqual(a.s.last('kicked'), { type: 'kicked', roomId: host.roomId });
    assert.equal(a.s.closed?.code, 4001);
    assert.equal(h.transport.emitUplink(host.roomId, a.id, sine(FRAME, 0.5)), false, 'uplink no longer reaches the mixer');
    assert.equal(h.transport.rooms.get(host.roomId)!.peers.has(a.id), false);
    const st = b.s.last('room:state')!;
    assert.ok(!st.speakers.some((p) => p.participantId === a.id));
    assert.equal(st.audienceCount, 1);
    assert.deepEqual(b.s.last('stage:left'), { type: 'stage:left', participantId: a.id, role: 'audience', reason: 'leave' });
    assert.equal(await h.req(a.s, { type: 'hand:raise' }), 'not_joined', 'the kicked session is unbound');
    await h.hub.detach(a.s);
    assert.equal(await h.req(host.s, { type: 'participant:kick', targetId: a.id }), 'not_found');
  });

  it('rotating the code locks out the old code but keeps everyone inside', async () => {
    const h = harness();
    const host = await h.create();
    const a = await h.join(host.roomId, host.code, 'A');
    assert.equal(await h.req(a.s, { type: 'room:rotate-code' }), 'forbidden');
    assert.equal(await h.req(host.s, { type: 'room:rotate-code' }), 'ok');
    const code = host.s.last('room:state')!.code!;
    assert.match(code, /^[A-Z0-9]{8}$/);
    assert.notEqual(code, host.code);
    const late = new FakeSession();
    assert.equal(await h.req(late, { type: 'join', roomId: host.roomId, code: host.code, name: 'L' }), 'unauthorized');
    await h.join(host.roomId, code, 'L');
    assert.equal(await h.req(a.s, { type: 'hand:raise' }), 'ok', 'existing participants unaffected');

    const open = await h.create('Host', { codeRequired: false });
    assert.equal(await h.req(open.s, { type: 'room:rotate-code' }), 'conflict');
  });
});

describe('connection quality', () => {
  it('reports each publisher\'s uplink loss per interval to the controller and stage only', async () => {
    const config = testConfig();
    const h = harness(config);
    const host = await h.create();
    const aud = await h.join(host.roomId, host.code, 'Aud');
    assert.equal(await h.req(host.s, { type: 'rtc:offer', payload: SENDRECV_OFFER }), 'ok');
    const timer = () => h.timers.filter((t) => !t.cleared && t.ms === config.rooms.qualityIntervalMs);
    assert.equal(timer().length, 1, 'scheduled once someone publishes');
    const peer = h.transport.rooms.get(host.roomId)!.peers.get(host.id)!;
    for (let i = 0; i < 18; i++) h.transport.emitUplink(host.roomId, host.id, sine(FRAME, 0.1));
    peer.uplink.packetsLost = 2;
    const fire = async () => { const t = timer().at(-1)!; t.cleared = true; t.fn(); await nextTurn(); };
    await fire();
    assert.deepEqual(host.s.last('quality'), { type: 'quality', participants: [{ participantId: host.id, uplinkLossPercent: 10 }] });
    assert.equal(aud.s.last('quality'), undefined, 'audience does not get it');
    for (let i = 0; i < 10; i++) h.transport.emitUplink(host.roomId, host.id, sine(FRAME, 0.1));
    await fire();
    assert.equal(host.s.last('quality')!.participants[0]!.uplinkLossPercent, 0, 'measured over the last interval only');
    await h.req(host.s, { type: 'stage:leave' });
    await fire();
    assert.equal(timer().length, 0, 'stops once nobody publishes');
  });
});

describe('mute', () => {
  it('force-mute blocks self-unmute; force-unmute preserves self-mute', async () => {
    const h = harness();
    const host = await h.create();
    const sp = await h.join(host.roomId, host.code, 'Sam');
    await h.req(sp.s, { type: 'hand:raise' });
    await h.req(host.s, { type: 'stage:approve', targetId: sp.id });
    await h.req(sp.s, { type: 'rtc:offer', payload: SENDRECV_OFFER });

    assert.equal(await h.req(host.s, { type: 'mic:force-mute', targetId: sp.id }), 'ok');
    assert.deepEqual(sp.s.last('mic:muted'), { type: 'mic:muted', participantId: sp.id });
    assert.equal(await h.req(sp.s, { type: 'mic:unmute' }), 'forbidden');
    h.transport.emitUplink(host.roomId, sp.id, sine(FRAME, 0.5));
    h.mixers.get(host.roomId)!.tick();
    assert.equal(energy(h.transport.rooms.get(host.roomId)!.peers.get(sp.id)!.received.at(-1) ?? new Float32Array(1)), 0);

    assert.equal(await h.req(sp.s, { type: 'mic:mute' }), 'ok');
    assert.equal(await h.req(host.s, { type: 'mic:force-unmute', targetId: sp.id }), 'ok');
    const me = sp.s.last('room:state')!.me;
    assert.equal(me.forceMuted, false);
    assert.equal(me.muted, true, 'self-mute kept');
    assert.equal(await h.req(sp.s, { type: 'mic:unmute' }), 'ok');
    assert.equal(sp.s.last('room:state')!.me.muted, false);
  });
});

describe('ephemeral TURN credentials', () => {
  it('issues per-participant HMAC credentials that expire after ttlSeconds', async () => {
    const secret = 'coturn-shared-secret-123';
    const h = harness(testConfig((c) => { c.rtc.turn = { urls: ['turns:turn.example:5349'], secret, ttlSeconds: 600 }; }));
    const host = await h.create('Host');
    const guest = await h.join(host.roomId, host.code, 'Guest');
    const usernames = [host, guest].map(({ s, id }) => {
      const servers = s.last('rtc:config')!.iceServers;
      const turn = servers.at(-1)!;
      assert.deepEqual(turn.urls, ['turns:turn.example:5349']);
      assert.equal(turn.username, `${h.clock.now / 1000 + 600}:${id}`);
      assert.equal(turn.credential, createHmac('sha1', secret).update(turn.username!).digest('base64'));
      assert.ok(servers.length > 1, 'static STUN servers are kept');
      assert.ok(!JSON.stringify(servers).includes(secret), 'secret never leaves the server');
      return turn.username;
    });
    assert.notEqual(usernames[0], usernames[1]);
  });
});
