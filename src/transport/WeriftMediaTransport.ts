import type { AppConfig } from '../config.ts';
import { samplesPerFrame } from '../config.ts';
import type { Logger } from '../log.ts';
import type { MetricSample } from '../metrics.ts';
import type { IceCandidatePayload, SessionDescriptionPayload } from '../../shared/protocol.ts';
import type { AudioFrameHandler, MediaTransport, MediaTransportCallbacks, MixedPcmSource, MixFrame, NegotiationPolicy, TransportStats } from './MediaTransport.ts';
import { CodecPool, type EncodeItem } from './codecPool.ts';
import { RtpReorderBuffer } from './jitter.ts';
import { MediaShard } from './mediaShards.ts';
import { PcmChunker } from './opus.ts';
import { WeriftPeerHost, type PeerHost, type PeerHostEvents } from './peerHost.ts';

/**
 * Main-thread uplink state of one publisher: RTP reorder before the stateful decoder, PCM
 * re-chunking after. While `muted`, packets still pass the reorder buffer (it keeps tracking
 * sequence numbers, and loss keeps being counted) but are not decoded. `packets`/`lost` count
 * accepted packets and packets the reorder buffer declared lost.
 */
interface Uplink { reorder: RtpReorderBuffer; chunker: PcmChunker; muted: boolean; packets: number; lost: number }
/**
 * Who gets which encode, in subscriber order. Rebuilt only when that routing changes; otherwise
 * every tick reuses it, so steady-state fan-out allocates nothing. Never mutated once built:
 * encodes still in flight may hold it.
 */
interface FanoutPlan {
  ids: string[]; hosts: PeerHost[]; frameOf: number[];
  frames: EncodeItem[];
  /** One empty payload per frame: what hosts get instead of an encode while the room is silent. */
  silence: Uint8Array[];
  targets: [PeerHost, [id: string, frame: number][]][];
}
interface Room {
  id: string;
  /** Which host owns each participant's PeerConnection. */
  peers: Map<string, PeerHost>;
  publishers: Map<string, AudioFrameHandler>;
  subscribers: Set<string>;
  uplinks: Map<string, Uplink>;
  /** Smoothed downlink loss (0..1) per participant, from their RTCP receiver reports. */
  downlinkLoss: Map<string, number>;
  /** Audience listeners currently served the low-bitrate, FEC-heavy mix (`audio.lowTier`). */
  lowTier: Set<string>;
  /** Consecutive frames each subscribed source contributed nothing (muted or starved). */
  silentFrames: Map<string, number>;
  plan: FanoutPlan | undefined;
  /** Consecutive ticks in which no publisher contributed audio. */
  silentTicks: number;
  /** This tick's routing, reused across ticks; compared against `plan`. */
  scratch: { ids: string[]; hosts: PeerHost[]; keys: string[]; pcms: Float32Array[] };
  detach?: () => void;
}
/** Encoder keys of the audience mixes; participant ids (base64url) key their mix-minus encoders. */
const FULL_MIX = '';
const FULL_MIX_LOW = '~low';
/** Weight of the newest receiver report in the smoothed loss: one report alone cannot flip a tier. */
const LOSS_SMOOTHING = 0.5;
/**
 * A source silent this long shares the full-mix encode instead of encoding an identical mix-minus
 * of its own. Each switch restarts an encoder stream, so brief underruns must not flip it.
 */
const SHARE_SILENT_AFTER_MS = 1000;
/**
 * After this long with nobody audible (DTX downlink only), mixes are not encoded at all: hosts get
 * empty payloads, which they treat as DTX (timestamps advance, nothing is sent). The wait lets
 * the encoders emit their own transition into DTX first.
 */
const SKIP_SILENCE_AFTER_MS = 1000;

/**
 * werift adapter. Peers live on `rtc.mediaWorkers` worker threads (0 = on this thread), placed on
 * the least-loaded host; codecs run on the CodecPool; reordering, chunking, mixing fan-out and
 * policy stay here so a room's state has a single owner.
 */
export class WeriftMediaTransport implements MediaTransport {
  private readonly config: AppConfig;
  private readonly callbacks: MediaTransportCallbacks;
  private readonly log: Logger;
  private readonly rooms = new Map<string, Room>();
  private readonly codecs: CodecPool;
  private readonly hosts: PeerHost[];
  private readonly counters = { uplinkPackets: 0, uplinkConcealed: 0, shedFrames: 0, encodeFailures: 0, silentSkipped: 0 };
  /** `createHosts` replaces the configured werift hosts (tests drive the fan-out through fakes). */
  constructor(config: AppConfig, callbacks: MediaTransportCallbacks, log: Logger, createHosts?: (events: PeerHostEvents) => PeerHost[]) {
    this.config = config; this.callbacks = callbacks; this.log = log;
    this.codecs = new CodecPool(config.audio, log);
    const events: PeerHostEvents = {
      localCandidate: (roomId, id, candidate) => this.callbacks.onLocalCandidate(roomId, id, candidate),
      peerClosed: (roomId, id) => this.callbacks.onPeerClosed?.(roomId, id),
      uplink: (roomId, id, seq, payload) => this.onUplink(roomId, id, seq, payload),
      downlinkLoss: (roomId, id, fraction) => this.onDownlinkLoss(roomId, id, fraction),
    };
    const shards = config.rtc.mediaWorkers;
    this.hosts = createHosts?.(events) ?? (shards === 0 ? [new WeriftPeerHost(config, events)] : Array.from({ length: shards }, () => new MediaShard(config, events, log)));
  }
  async metrics(): Promise<MetricSample[]> {
    let peers = 0, subscribers = 0, backlog = 0, lowTier = 0;
    for (const room of this.rooms.values()) { peers += room.peers.size; subscribers += room.subscribers.size; lowTier += room.lowTier.size; backlog = Math.max(backlog, this.codecs.backlog(room.id)); }
    const hosts = await Promise.all(this.hosts.map(h => h.counters()));
    const c = this.counters;
    return [
      { name: 'stage_media_peers', help: 'Open server-side PeerConnections.', type: 'gauge', value: peers },
      { name: 'stage_media_subscribers', help: 'Participants receiving the downlink mix.', type: 'gauge', value: subscribers },
      { name: 'stage_codec_backlog_max', help: 'Largest count of mixed frames still being encoded for any room.', type: 'gauge', value: backlog },
      { name: 'stage_downlink_low_tier', help: 'Listeners served the low-bitrate mix because of downlink loss.', type: 'gauge', value: lowTier },
      { name: 'stage_uplink_packets_total', help: 'Accepted uplink RTP packets.', type: 'counter', value: c.uplinkPackets },
      { name: 'stage_uplink_concealed_total', help: 'Uplink packets declared lost and concealed.', type: 'counter', value: c.uplinkConcealed },
      { name: 'stage_downlink_packets_total', help: 'Downlink RTP packets sent.', type: 'counter', value: hosts.reduce((n, h) => n + h.downlinkPackets, 0) },
      { name: 'stage_downlink_dtx_frames_total', help: 'Downlink frames suppressed by Opus DTX.', type: 'counter', value: hosts.reduce((n, h) => n + h.downlinkDtxFrames, 0) },
      { name: 'stage_mix_frames_shed_total', help: 'Mixed frames dropped because a codec worker fell behind.', type: 'counter', value: c.shedFrames },
      { name: 'stage_encode_failures_total', help: 'Mixed frames whose encode failed.', type: 'counter', value: c.encodeFailures },
      { name: 'stage_mix_frames_silent_skipped_total', help: 'Mixed frames not encoded because nobody had been audible for a while (sent as DTX).', type: 'counter', value: c.silentSkipped },
    ];
  }
  private room(id: string): Room {
    let room = this.rooms.get(id);
    if (!room) {
      room = {
        id, peers: new Map(), publishers: new Map(), subscribers: new Set(), uplinks: new Map(), downlinkLoss: new Map(), lowTier: new Set(), silentFrames: new Map(),
        plan: undefined, silentTicks: 0, scratch: { ids: [], hosts: [], keys: [], pcms: [] },
      };
      this.rooms.set(id, room);
    }
    return room;
  }
  private uplink(): Uplink {
    return { reorder: new RtpReorderBuffer(this.config.audio.jitter.reorderPackets), chunker: new PcmChunker(samplesPerFrame(this.config.audio)), muted: false, packets: 0, lost: 0 };
  }
  private onDownlinkLoss(roomId: string, id: string, fraction: number): void {
    const room = this.rooms.get(roomId);
    if (!room?.peers.has(id)) return;
    const previous = room.downlinkLoss.get(id);
    const loss = previous === undefined ? fraction : previous + LOSS_SMOOTHING * (fraction - previous);
    room.downlinkLoss.set(id, loss);
    const tier = this.config.audio.lowTier;
    if (!tier.enabled) return;
    if (loss * 100 >= tier.enterLossPercent) room.lowTier.add(id);
    else if (loss * 100 <= tier.exitLossPercent) room.lowTier.delete(id);
  }
  private onUplink(roomId: string, id: string, seq: number, payload: Uint8Array): void {
    const room = this.rooms.get(roomId);
    const uplink = room?.uplinks.get(id);
    // Hosts only forward enabled uplinks, but a packet can cross a removePublisher in flight.
    if (!room || !uplink || !room.publishers.has(id)) return;
    this.counters.uplinkPackets++;
    uplink.packets++;
    const packets = uplink.reorder.push(seq, payload);
    // `null` = declared lost: the worker rebuilds it from the next packet's FEC, in stream order.
    for (const packet of packets) if (packet === null) { this.counters.uplinkConcealed++; uplink.lost++; }
    if (!packets.length || uplink.muted) return;
    this.codecs.decode(roomId, id, packets).then(decoded => {
      // Re-check after the worker hop: the publisher may have been removed (and re-added) meanwhile.
      const handler = room.publishers.get(id);
      if (handler && room.uplinks.get(id) === uplink) uplink.chunker.push(decoded, handler);
    }, () => { this.log.warn('Invalid uplink audio packet', { roomId, participantId: id }); });
  }
  private host(room: Room, id: string): PeerHost {
    let host = room.peers.get(id);
    if (!host) {
      host = this.hosts.reduce((best, h) => h.peerCount < best.peerCount ? h : best);
      room.peers.set(id, host);
    }
    return host;
  }
  negotiate(roomId: string, id: string, offer: SessionDescriptionPayload, policy: NegotiationPolicy): Promise<SessionDescriptionPayload> {
    const room = this.room(roomId);
    const host = this.host(room, id);
    const answer = host.negotiate(roomId, id, offer, policy.allowUplink);
    // Hosts create the peer synchronously (and shards process messages in order), so a publisher
    // registered before its first offer is enabled right away.
    if (room.publishers.has(id)) host.setUplink(roomId, id, true);
    return answer;
  }
  async addRemoteCandidate(roomId: string, id: string, candidate: IceCandidatePayload | null): Promise<void> {
    const host = this.rooms.get(roomId)?.peers.get(id);
    if (!host) throw new Error('Unknown media peer');
    await host.addRemoteCandidate(roomId, id, candidate);
  }
  addPublisher(roomId: string, id: string, handler: AudioFrameHandler): void {
    const room = this.room(roomId);
    room.publishers.set(id, handler);
    room.uplinks.set(id, this.uplink());
    room.peers.get(id)?.setUplink(roomId, id, true);
  }
  removePublisher(roomId: string, id: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.publishers.delete(id);
    room.uplinks.delete(id);
    room.peers.get(id)?.setUplink(roomId, id, false);
    this.codecs.release(roomId, 'encoder', id);
    room.silentFrames.delete(id);
  }
  setPublisherMuted(roomId: string, id: string, muted: boolean): void {
    const room = this.rooms.get(roomId);
    const uplink = room?.uplinks.get(id);
    if (!room || !uplink || uplink.muted === muted) return;
    uplink.muted = muted;
    if (!muted) return;
    // A decoder resumed after a gap would extrapolate from stale state; the next packet gets a fresh one.
    this.codecs.release(roomId, 'decoder', id);
    room.uplinks.set(id, { ...this.uplink(), reorder: uplink.reorder, muted: true, packets: uplink.packets, lost: uplink.lost });
  }
  setMixedStream(roomId: string, source: MixedPcmSource | null): void {
    const room = this.room(roomId);
    room.detach?.(); room.detach = undefined;
    if (source) room.detach = source.onFrame(frame => this.sendFrame(room, frame));
  }
  private sendFrame(room: Room, frame: MixFrame): void {
    const plan = this.fanout(room, frame);
    if (!plan.frames.length) return;
    room.silentTicks = frame.silent ? room.silentTicks + 1 : 0;
    // Only with nothing in flight: a silence send overtaking a pending encode would reorder audio.
    if (this.config.audio.opus.dtx && room.silentTicks > SKIP_SILENCE_AFTER_MS / this.config.audio.frameMs && !this.codecs.backlog(room.id)) {
      this.counters.silentSkipped++;
      for (const [host, list] of plan.targets) host.send({ roomId: room.id, payloads: plan.silence, targets: list });
      return;
    }
    // Shed frames instead of queueing unbounded latency when the room's worker falls behind.
    if (this.codecs.backlog(room.id) >= this.config.audio.mixer.maxBufferedFrames) {
      this.counters.shedFrames++;
      this.log.warn('Codec worker behind; dropping mixed frame', { roomId: room.id, seq: frame.seq });
      return;
    }
    this.codecs.encode(room.id, plan.frames).then(payloads => {
      if (this.rooms.get(room.id) !== room) return;
      for (const [host, list] of plan.targets) host.send({ roomId: room.id, payloads, targets: list });
    }, (err: Error) => { this.counters.encodeFailures++; this.log.warn('Mixed frame encode failed', { roomId: room.id, error: err.message }); });
  }
  /** This tick's routing; the cached plan when nothing about it changed. */
  private fanout(room: Room, frame: MixFrame): FanoutPlan {
    const { ids, hosts, keys, pcms } = room.scratch;
    let n = 0;
    for (const id of room.subscribers) {
      const host = room.peers.get(id);
      if (!host) continue;
      const minus = frame.minus(id);
      const own = minus && this.ownMix(room, id, minus, frame.full);
      ids[n] = id; hosts[n] = host; pcms[n] = own ?? frame.full;
      keys[n++] = own ? id : !minus && room.lowTier.has(id) ? FULL_MIX_LOW : FULL_MIX;
    }
    ids.length = hosts.length = keys.length = pcms.length = n;
    const cached = room.plan;
    if (cached && this.planMatches(cached, n, ids, hosts, keys, pcms)) return cached;
    const frames: EncodeItem[] = [];
    const frameOf: number[] = [];
    const index = new Map<string, number>();
    const targets = new Map<PeerHost, [string, number][]>();
    for (let i = 0; i < n; i++) {
      const key = keys[i]!;
      let at = index.get(key);
      if (at === undefined) { at = frames.length; index.set(key, at); frames.push({ key, pcm: pcms[i]!, low: key === FULL_MIX_LOW }); }
      frameOf.push(at);
      let list = targets.get(hosts[i]!);
      if (!list) { list = []; targets.set(hosts[i]!, list); }
      list.push([ids[i]!, at]);
    }
    room.plan = { ids: ids.slice(), hosts: hosts.slice(), frameOf, frames, silence: frames.map(() => new Uint8Array(0)), targets: [...targets] };
    return room.plan;
  }
  private planMatches(plan: FanoutPlan, n: number, ids: string[], hosts: PeerHost[], keys: string[], pcms: Float32Array[]): boolean {
    if (plan.ids.length !== n) return false;
    for (let i = 0; i < n; i++) {
      const item = plan.frames[plan.frameOf[i]!]!;
      if (plan.ids[i] !== ids[i] || plan.hosts[i] !== hosts[i] || item.key !== keys[i] || item.pcm !== pcms[i]) return false;
    }
    return true;
  }
  /**
   * A source's own mix-minus, or undefined once it has been silent for SHARE_SILENT_AFTER_MS: its
   * mix-minus is then the full mix, so it shares that encode (sources stay off the low tier).
   * The idle encoder is released so the source's stream restarts clean when it speaks again.
   */
  private ownMix(room: Room, id: string, minus: Float32Array, full: Float32Array): Float32Array | undefined {
    if (minus !== full) { room.silentFrames.delete(id); return minus; }
    const shareAfter = Math.ceil(SHARE_SILENT_AFTER_MS / this.config.audio.frameMs);
    const silent = room.silentFrames.get(id) ?? 0;
    if (silent >= shareAfter) return undefined;
    room.silentFrames.set(id, silent + 1);
    if (silent + 1 < shareAfter) return minus;
    this.codecs.release(room.id, 'encoder', id);
    return undefined;
  }
  subscribe(roomId: string, id: string): void { this.room(roomId).subscribers.add(id); }
  unsubscribe(roomId: string, id: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.subscribers.delete(id); room.silentFrames.delete(id); this.codecs.release(roomId, 'encoder', id);
  }
  /** Uplink counts come from this side's reorder buffer (what the mixer actually got); downlink loss from receiver reports. */
  async getStats(roomId: string, id: string): Promise<TransportStats | null> {
    const room = this.rooms.get(roomId);
    const host = room?.peers.get(id);
    const stats = host && await host.getStats(roomId, id);
    if (!room || !stats) return null;
    const uplink = room.uplinks.get(id);
    if (uplink) stats.inbound = { ...stats.inbound, packetsReceived: uplink.packets, packetsLost: uplink.lost };
    const loss = room.downlinkLoss.get(id);
    if (loss !== undefined) stats.outbound = { ...stats.outbound, fractionLost: loss };
    return stats;
  }
  closePeer(roomId: string, id: string): void {
    const room = this.rooms.get(roomId);
    const host = room?.peers.get(id);
    if (!room || !host) return;
    room.peers.delete(id); room.downlinkLoss.delete(id); room.lowTier.delete(id);
    this.removePublisher(roomId, id); this.unsubscribe(roomId, id);
    host.closePeer(roomId, id); this.codecs.release(roomId, 'decoder', id);
  }
  closeRoom(id: string): void {
    const room = this.rooms.get(id);
    if (!room) return;
    room.detach?.();
    for (const peerId of room.peers.keys()) this.closePeer(id, peerId);
    this.codecs.closeRoom(id); this.rooms.delete(id);
  }
  async close(): Promise<void> {
    for (const id of this.rooms.keys()) this.closeRoom(id);
    await Promise.all(this.hosts.map(h => h.close()));
    await this.codecs.close();
  }
}
