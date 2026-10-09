import { randomInt } from 'node:crypto';
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket } from 'werift';
import type { AppConfig } from '../config.ts';
import { samplesPerFrame } from '../config.ts';
import type { Logger } from '../log.ts';
import type { IceCandidatePayload, SessionDescriptionPayload } from '../../shared/protocol.ts';
import type { AudioFrameHandler, MediaTransport, MediaTransportCallbacks, MixedPcmSource, MixFrame, NegotiationPolicy, TransportStats } from './MediaTransport.ts';
import { CodecPool, type EncodeItem } from './codecPool.ts';
import { PcmChunker } from './opus.ts';

export function opusCodec(): RTCRtpCodecParameters {
  return new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111, parameters: 'minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=128000' });
}
interface Peer {
  pc: RTCPeerConnection; track: MediaStreamTrack; allowUplink: boolean;
  chunker: PcmChunker; sequence: number; timestamp: number; started: number;
  outboundBytes: number; outboundPackets: number; inboundBytes: number; inboundPackets: number;
}
interface Room {
  id: string; peers: Map<string, Peer>; publishers: Map<string, AudioFrameHandler>; subscribers: Set<string>;
  detach?: () => void;
}
/** Encoder key of the audience mix; participant ids key their mix-minus encoders. */
const FULL_MIX = '';

export class WeriftMediaTransport implements MediaTransport {
  private readonly config: AppConfig;
  private readonly callbacks: MediaTransportCallbacks;
  private readonly log: Logger;
  private readonly rooms = new Map<string, Room>();
  private readonly closing = new Set<Promise<void>>();
  private readonly codecs: CodecPool;
  constructor(config: AppConfig, callbacks: MediaTransportCallbacks, log: Logger) { this.config = config; this.callbacks = callbacks; this.log = log; this.codecs = new CodecPool(config.audio, log); }
  private room(id: string): Room {
    let room = this.rooms.get(id);
    if (!room) {
      room = { id, peers: new Map(), publishers: new Map(), subscribers: new Set() };
      this.rooms.set(id, room);
    }
    return room;
  }
  async negotiate(roomId: string, id: string, offer: SessionDescriptionPayload, policy: NegotiationPolicy): Promise<SessionDescriptionPayload> {
    const room = this.room(roomId);
    let peer = room.peers.get(id);
    if (!peer) {
      const pc = new RTCPeerConnection({ codecs: { audio: [opusCodec()], video: [] }, iceServers: this.config.rtc.serverIceServers, icePortRange: this.config.rtc.portRange.length === 2 ? this.config.rtc.portRange : undefined });
      peer = { pc, track: new MediaStreamTrack({ kind: 'audio' }), allowUplink: policy.allowUplink, chunker: new PcmChunker(samplesPerFrame(this.config.audio)), sequence: randomInt(65536), timestamp: randomInt(0x100000000), started: performance.now(), outboundBytes: 0, outboundPackets: 0, inboundBytes: 0, inboundPackets: 0 };
      room.peers.set(id, peer);
      const current = peer;
      pc.onIceCandidate.subscribe(candidate => this.callbacks.onLocalCandidate(roomId, id, candidate ? candidate.toJSON() : null));
      pc.connectionStateChange.subscribe(state => { if ((state === 'failed' || state === 'closed') && room.peers.get(id) === current) this.callbacks.onPeerClosed?.(roomId, id); });
      pc.onTrack.subscribe(track => {
        if (track.kind !== 'audio') return;
        track.onReceiveRtp.subscribe(packet => {
          if (!current.allowUplink || !room.publishers.has(id)) return;
          current.inboundBytes += packet.payload.length;
          current.inboundPackets++;
          this.codecs.decode(roomId, id, packet.payload).then(decoded => {
            // Re-check after the worker hop: the peer may have been demoted or closed meanwhile.
            const handler = room.publishers.get(id);
            if (current.allowUplink && handler && room.peers.get(id) === current) current.chunker.push(decoded, handler);
          }, () => { this.log.warn('Invalid uplink audio packet', { roomId, participantId: id }); });
        });
      });
    }
    peer.allowUplink = policy.allowUplink;
    // Disable ingress before SRD: onTrack may fire during description application.
    // werift registers the remote SSRC for receiving only if the transceiver's local direction
    // already includes recv when the offer is applied; on renegotiation (audience → speaker) the
    // transceiver is still `sendonly`, so set the policy direction first or the uplink is never routed.
    for (const t of peer.pc.getTransceivers()) {
      if (t.kind === 'audio' && !t.stopped) t.direction = policy.allowUplink ? 'sendrecv' : 'sendonly';
    }
    await peer.pc.setRemoteDescription(offer);
    const audio = peer.pc.getTransceivers().filter(t => t.kind === 'audio' && !t.stopped);
    if (audio.length !== 1) throw new Error('Exactly one audio transceiver is required');
    const transceiver = audio[0]!;
    transceiver.direction = policy.allowUplink && (transceiver.offerDirection === 'sendrecv' || transceiver.offerDirection === 'sendonly') ? 'sendrecv' : 'sendonly';
    await transceiver.sender.replaceTrack(peer.track);
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    return { type: 'answer', sdp: peer.pc.localDescription!.sdp };
  }
  async addRemoteCandidate(roomId: string, id: string, candidate: IceCandidatePayload | null): Promise<void> {
    const peer = this.rooms.get(roomId)?.peers.get(id);
    if (!peer) throw new Error('Unknown media peer');
    await peer.pc.addIceCandidate(candidate ? { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? undefined, sdpMLineIndex: candidate.sdpMLineIndex ?? undefined, usernameFragment: candidate.usernameFragment ?? undefined } : null);
  }
  addPublisher(roomId: string, id: string, handler: AudioFrameHandler): void { this.room(roomId).publishers.set(id, handler); }
  removePublisher(roomId: string, id: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.publishers.delete(id);
    this.codecs.release(roomId, 'encoder', id);
    const peer = room.peers.get(id);
    if (peer) peer.chunker = new PcmChunker(samplesPerFrame(this.config.audio));
  }
  setMixedStream(roomId: string, source: MixedPcmSource | null): void {
    const room = this.room(roomId);
    room.detach?.(); room.detach = undefined;
    if (source) room.detach = source.onFrame(frame => this.sendFrame(room, frame));
  }
  private sendFrame(room: Room, frame: MixFrame): void {
    const targets: { id: string; peer: Peer; key: string }[] = [];
    const frames: EncodeItem[] = [];
    const index = new Map<string, number>();
    for (const id of room.subscribers) {
      const peer = room.peers.get(id);
      if (!peer || peer.pc.connectionState !== 'connected') continue;
      const pcm = frame.minus(id);
      const key = pcm ? id : FULL_MIX;
      if (!index.has(key)) { index.set(key, frames.length); frames.push({ key, pcm: pcm ?? frame.full }); }
      targets.push({ id, peer, key });
    }
    if (!targets.length) return;
    // Shed frames instead of queueing unbounded latency when the room's worker falls behind.
    if (this.codecs.backlog(room.id) >= this.config.audio.mixer.maxBufferedFrames) {
      this.log.warn('Codec worker behind; dropping mixed frame', { roomId: room.id, seq: frame.seq });
      return;
    }
    const timestampStep = samplesPerFrame(this.config.audio);
    this.codecs.encode(room.id, frames).then(payloads => {
      if (this.rooms.get(room.id) !== room) return;
      for (const { id, peer, key } of targets) {
        if (room.peers.get(id) !== peer || !room.subscribers.has(id)) continue;
        const sender = peer.pc.getSenders().find(s => s.track === peer.track);
        if (!sender?.codec) continue;
        const payload = Buffer.from(payloads[index.get(key)!]!.buffer);
        const packet = new RtpPacket(new RtpHeader({ payloadType: sender.codec.payloadType, sequenceNumber: peer.sequence, timestamp: peer.timestamp, ssrc: sender.ssrc, marker: peer.outboundPackets === 0 }), payload);
        peer.sequence = (peer.sequence + 1) & 0xffff;
        peer.timestamp = (peer.timestamp + timestampStep) >>> 0;
        peer.track.writeRtp(packet);
        peer.outboundBytes += payload.length;
        peer.outboundPackets++;
      }
    }, (err: Error) => { this.log.warn('Mixed frame encode failed', { roomId: room.id, error: err.message }); });
  }
  subscribe(roomId: string, id: string): void { this.room(roomId).subscribers.add(id); }
  unsubscribe(roomId: string, id: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.subscribers.delete(id); this.codecs.release(roomId, 'encoder', id);
  }
  async getStats(roomId: string, id: string): Promise<TransportStats | null> {
    const peer = this.rooms.get(roomId)?.peers.get(id);
    if (!peer) return null;
    const seconds = Math.max((performance.now() - peer.started) / 1000, 0.001);
    const codec = { mimeType: 'audio/opus', clockRate: 48000, channels: 2 };
    const result: TransportStats = { outbound: { codec, bitrateKbps: peer.outboundBytes * 8 / seconds / 1000, packetsSent: peer.outboundPackets }, inbound: { codec, bitrateKbps: peer.inboundBytes * 8 / seconds / 1000, packetsReceived: peer.inboundPackets } };
    const stats = await peer.pc.getStats();
    for (const stat of stats.values()) {
      if (stat.type === 'remote-inbound-rtp' && 'roundTripTime' in stat && typeof stat.roundTripTime === 'number') result.rttMs = stat.roundTripTime * 1000;
      if (stat.type === 'inbound-rtp' && 'packetsLost' in stat && typeof stat.packetsLost === 'number') result.inbound!.packetsLost = stat.packetsLost;
    }
    return result;
  }
  closePeer(roomId: string, id: string): void {
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(id);
    if (!room || !peer) return;
    room.peers.delete(id); this.removePublisher(roomId, id); this.unsubscribe(roomId, id);
    peer.track.stop(); this.codecs.release(roomId, 'decoder', id);
    const closing = peer.pc.close().finally(() => { this.closing.delete(closing); });
    this.closing.add(closing);
  }
  closeRoom(id: string): void {
    const room = this.rooms.get(id);
    if (!room) return;
    room.detach?.();
    for (const peerId of room.peers.keys()) this.closePeer(id, peerId);
    this.codecs.closeRoom(id); this.rooms.delete(id);
  }
  async close(): Promise<void> { for (const id of this.rooms.keys()) this.closeRoom(id); await Promise.all(this.closing); await this.codecs.close(); }
}
