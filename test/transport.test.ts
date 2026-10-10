import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { IceCandidatePayload, SessionDescriptionPayload } from '../shared/protocol.ts';
import { silentLogger } from '../src/log.ts';
import { RoomMixer } from '../src/mixer/RoomMixer.ts';
import type { TransportStats } from '../src/transport/MediaTransport.ts';
import type { DownlinkFrame, HostCounters, PeerHost, PeerHostEvents } from '../src/transport/peerHost.ts';
import { WeriftMediaTransport } from '../src/transport/WeriftMediaTransport.ts';
import { sine, testConfig } from './helpers.ts';

/** Records what the transport hands to the network layer instead of sending it. */
class FakeHost implements PeerHost {
  readonly peers = new Set<string>();
  private waiter: PromiseWithResolvers<DownlinkFrame> | undefined;
  get peerCount(): number { return this.peers.size; }
  async negotiate(_roomId: string, id: string, _offer: SessionDescriptionPayload, _allowUplink: boolean): Promise<SessionDescriptionPayload> {
    this.peers.add(id);
    return { type: 'answer', sdp: 'v=0' };
  }
  async addRemoteCandidate(_roomId: string, _id: string, _candidate: IceCandidatePayload | null): Promise<void> {}
  setUplink(): void {}
  send(frame: DownlinkFrame): void { this.waiter?.resolve(frame); this.waiter = undefined; }
  async getStats(): Promise<TransportStats | null> { return null; }
  closePeer(_roomId: string, id: string): void { this.peers.delete(id); }
  async counters(): Promise<HostCounters> { return { downlinkPackets: 0, downlinkDtxFrames: 0 }; }
  async close(): Promise<void> {}
  /** Resolves with the next frame the transport sends. */
  next(): Promise<DownlinkFrame> { this.waiter = Promise.withResolvers(); return this.waiter.promise; }
}

const ROOM = 'r';
const OFFER: SessionDescriptionPayload = { type: 'offer', sdp: 'v=0' };

async function setup() {
  const config = testConfig((c) => { c.audio.codecWorkers = 1; });
  const host = new FakeHost();
  let events!: PeerHostEvents;
  const transport = new WeriftMediaTransport(config, { onLocalCandidate() {} }, silentLogger, (e) => { events = e; return [host]; });
  const mixer = new RoomMixer({ sampleRate: 48000, frameMs: 20, maxBufferedFrames: 10, playoutFrames: 1, limiterThreshold: 0.9, speakingThreshold: 0.02, speakingHoldMs: 40 });
  mixer.addSource('a');
  transport.setMixedStream(ROOM, mixer);
  for (const id of ['a', 'b', 'c']) {
    await transport.negotiate(ROOM, id, OFFER, { allowUplink: id === 'a' });
    transport.subscribe(ROOM, id);
  }
  /** One mixer tick with `a` speaking or silent; returns which encode each participant was sent. */
  const tick = async (aSpeaks: boolean) => {
    const sent = host.next();
    if (aSpeaks) mixer.push('a', sine(960, 0.3));
    mixer.tick();
    const frame = await sent;
    const route = new Map(frame.targets);
    return { route, payloads: frame.payloads, same: (x: string, y: string) => route.get(x) === route.get(y) };
  };
  return { config, transport, events, tick };
}

describe('downlink fan-out', () => {
  it('moves a lossy listener to the low tier and back only past the hysteresis thresholds', async () => {
    const { transport, events, tick } = await setup();
    try {
      let t = await tick(true);
      assert.ok(t.same('b', 'c') && !t.same('a', 'b'), 'listeners share the full mix; the speaker gets its mix-minus');
      events.downlinkLoss(ROOM, 'b', 0.1); // 10 % ≥ enter (5 %)
      t = await tick(true);
      assert.ok(!t.same('b', 'c') && !t.same('b', 'a'), 'lossy listener gets the separate low-tier encode');
      // Smoothed 5 % → 2.5 % → 1.25 %: between exit (1 %) and enter, so it must not flap back.
      for (let i = 0; i < 3; i++) events.downlinkLoss(ROOM, 'b', 0);
      t = await tick(true);
      assert.ok(!t.same('b', 'c'), 'still low tier above the exit threshold');
      events.downlinkLoss(ROOM, 'b', 0); // 0.625 % ≤ exit
      t = await tick(true);
      assert.ok(t.same('b', 'c'), 'back on the main mix');
    } finally { await transport.close(); }
  });

  it('shares the full-mix encode with a speaker silent for a second, then stops encoding a silent room', async () => {
    const { transport, tick } = await setup();
    try {
      await tick(true);
      // 1 s = 50 frames. For 49 silent ticks the speaker keeps its own (identical) encode.
      let t;
      for (let i = 1; i <= 49; i++) t = await tick(false);
      assert.ok(!t!.same('a', 'b'), 'own encode before the second is up');
      t = await tick(false);
      assert.ok(t.same('a', 'b'), 'shares the listeners\' encode after a second of silence');
      assert.equal(t.payloads.length, 1, 'one encode for the whole room');
      t = await tick(false);
      assert.ok(t.payloads.every((p) => p.length === 0), 'silent room: empty payloads (DTX) instead of encoding');
      const skipped = (await transport.metrics()).find((m) => m.name === 'stage_mix_frames_silent_skipped_total')!;
      assert.ok(skipped.type === 'counter' && skipped.value === 1);
      t = await tick(true);
      assert.ok(t.payloads.some((p) => p.length > 2), 'encodes again as soon as someone speaks');
      assert.ok(!t.same('a', 'b'), 'and the speaker is back on its own mix-minus');
    } finally { await transport.close(); }
  });
});
