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

/** Main-thread uplink state of one publisher: RTP reorder before the stateful decoder, PCM re-chunking after. */
interface Uplink { reorder: RtpReorderBuffer; chunker: PcmChunker }
interface Room {
  id: string;
  /** Which host owns each participant's PeerConnection. */
  peers: Map<string, PeerHost>;
  publishers: Map<string, AudioFrameHandler>;
  subscribers: Set<string>;
  uplinks: Map<string, Uplink>;
  detach?: () => void;
}
/** Encoder key of the audience mix; participant ids key their mix-minus encoders. */
const FULL_MIX = '';

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
  private readonly counters = { uplinkPackets: 0, uplinkConcealed: 0, shedFrames: 0, encodeFailures: 0 };
  constructor(config: AppConfig, callbacks: MediaTransportCallbacks, log: Logger) {
    this.config = config; this.callbacks = callbacks; this.log = log;
    this.codecs = new CodecPool(config.audio, log);
    const events: PeerHostEvents = {
      localCandidate: (roomId, id, candidate) => this.callbacks.onLocalCandidate(roomId, id, candidate),
      peerClosed: (roomId, id) => this.callbacks.onPeerClosed?.(roomId, id),
      uplink: (roomId, id, seq, payload) => this.onUplink(roomId, id, seq, payload),
    };
    const shards = config.rtc.mediaWorkers;
    this.hosts = shards === 0 ? [new WeriftPeerHost(config, events)] : Array.from({ length: shards }, () => new MediaShard(config, events, log));
  }
  async metrics(): Promise<MetricSample[]> {
    let peers = 0, subscribers = 0, backlog = 0;
    for (const room of this.rooms.values()) { peers += room.peers.size; subscribers += room.subscribers.size; backlog = Math.max(backlog, this.codecs.backlog(room.id)); }
    const hosts = await Promise.all(this.hosts.map(h => h.counters()));
    const c = this.counters;
    return [
      { name: 'stage_media_peers', help: 'Open server-side PeerConnections.', type: 'gauge', value: peers },
      { name: 'stage_media_subscribers', help: 'Participants receiving the downlink mix.', type: 'gauge', value: subscribers },
      { name: 'stage_codec_backlog_max', help: 'Largest in-flight codec job count of any room.', type: 'gauge', value: backlog },
      { name: 'stage_uplink_packets_total', help: 'Accepted uplink RTP packets.', type: 'counter', value: c.uplinkPackets },
      { name: 'stage_uplink_concealed_total', help: 'Uplink packets declared lost and concealed.', type: 'counter', value: c.uplinkConcealed },
      { name: 'stage_downlink_packets_total', help: 'Downlink RTP packets sent.', type: 'counter', value: hosts.reduce((n, h) => n + h.downlinkPackets, 0) },
      { name: 'stage_downlink_dtx_frames_total', help: 'Downlink frames suppressed by Opus DTX.', type: 'counter', value: hosts.reduce((n, h) => n + h.downlinkDtxFrames, 0) },
      { name: 'stage_mix_frames_shed_total', help: 'Mixed frames dropped because a codec worker fell behind.', type: 'counter', value: c.shedFrames },
      { name: 'stage_encode_failures_total', help: 'Mixed frames whose encode failed.', type: 'counter', value: c.encodeFailures },
    ];
  }
  private room(id: string): Room {
    let room = this.rooms.get(id);
    if (!room) {
      room = { id, peers: new Map(), publishers: new Map(), subscribers: new Set(), uplinks: new Map() };
      this.rooms.set(id, room);
    }
    return room;
  }
  private uplink(): Uplink {
    return { reorder: new RtpReorderBuffer(this.config.audio.jitter.reorderPackets), chunker: new PcmChunker(samplesPerFrame(this.config.audio)) };
  }
  private onUplink(roomId: string, id: string, seq: number, payload: Uint8Array): void {
    const room = this.rooms.get(roomId);
    const uplink = room?.uplinks.get(id);
    // Hosts only forward enabled uplinks, but a packet can cross a removePublisher in flight.
    if (!room || !uplink || !room.publishers.has(id)) return;
    this.counters.uplinkPackets++;
    const packets = uplink.reorder.push(seq, payload);
    if (!packets.length) return;
    // `null` = declared lost: the worker rebuilds it from the next packet's FEC, in stream order.
    for (const packet of packets) if (packet === null) this.counters.uplinkConcealed++;
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
  }
  setMixedStream(roomId: string, source: MixedPcmSource | null): void {
    const room = this.room(roomId);
    room.detach?.(); room.detach = undefined;
    if (source) room.detach = source.onFrame(frame => this.sendFrame(room, frame));
  }
  private sendFrame(room: Room, frame: MixFrame): void {
    const frames: EncodeItem[] = [];
    const index = new Map<string, number>();
    const targets = new Map<PeerHost, [string, number][]>();
    for (const id of room.subscribers) {
      const host = room.peers.get(id);
      if (!host) continue;
      const pcm = frame.minus(id);
      const key = pcm ? id : FULL_MIX;
      let at = index.get(key);
      if (at === undefined) { at = frames.length; index.set(key, at); frames.push({ key, pcm: pcm ?? frame.full }); }
      let list = targets.get(host);
      if (!list) { list = []; targets.set(host, list); }
      list.push([id, at]);
    }
    if (!frames.length) return;
    // Shed frames instead of queueing unbounded latency when the room's worker falls behind.
    if (this.codecs.backlog(room.id) >= this.config.audio.mixer.maxBufferedFrames) {
      this.counters.shedFrames++;
      this.log.warn('Codec worker behind; dropping mixed frame', { roomId: room.id, seq: frame.seq });
      return;
    }
    this.codecs.encode(room.id, frames).then(payloads => {
      if (this.rooms.get(room.id) !== room) return;
      for (const [host, list] of targets) host.send({ roomId: room.id, payloads, targets: list });
    }, (err: Error) => { this.counters.encodeFailures++; this.log.warn('Mixed frame encode failed', { roomId: room.id, error: err.message }); });
  }
  subscribe(roomId: string, id: string): void { this.room(roomId).subscribers.add(id); }
  unsubscribe(roomId: string, id: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.subscribers.delete(id); this.codecs.release(roomId, 'encoder', id);
  }
  async getStats(roomId: string, id: string): Promise<TransportStats | null> {
    const host = this.rooms.get(roomId)?.peers.get(id);
    return host ? host.getStats(roomId, id) : null;
  }
  closePeer(roomId: string, id: string): void {
    const room = this.rooms.get(roomId);
    const host = room?.peers.get(id);
    if (!room || !host) return;
    room.peers.delete(id); this.removePublisher(roomId, id); this.unsubscribe(roomId, id);
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
