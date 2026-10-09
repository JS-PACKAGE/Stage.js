import { randomInt } from 'node:crypto';
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters, RtpHeader, RtpPacket, type RTCRtpSender } from 'werift';
import type { AppConfig } from '../config.ts';
import { samplesPerFrame } from '../config.ts';
import type { IceCandidatePayload, SessionDescriptionPayload } from '../../shared/protocol.ts';
import type { TransportStats } from './MediaTransport.ts';

export function opusCodec(): RTCRtpCodecParameters {
  return new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, payloadType: 111, parameters: 'minptime=10;useinbandfec=1;stereo=0;sprop-stereo=0;maxaveragebitrate=128000' });
}

export interface PeerHostEvents {
  localCandidate(roomId: string, id: string, candidate: IceCandidatePayload | null): void;
  peerClosed(roomId: string, id: string): void;
  /** Uplink RTP payload of a peer whose uplink is both negotiated and enabled. */
  uplink(roomId: string, id: string, seq: number, payload: Uint8Array): void;
  /** Fraction (0..1) of downlink packets lost since the participant's previous RTCP receiver report. */
  downlinkLoss(roomId: string, id: string, fraction: number): void;
}
export interface HostCounters { downlinkPackets: number; downlinkDtxFrames: number }
/** One encoded mixed frame for a room: `targets` pairs a participant with an index into `payloads`. */
export interface DownlinkFrame { roomId: string; payloads: Uint8Array[]; targets: [id: string, payload: number][] }

/**
 * Owns WebRTC peers (ICE, DTLS, SRTP, RTP packetization). Runs on the main thread or inside a
 * media worker (`mediaWorker.ts`); everything above it (codecs, mixing, policy) stays on the main thread.
 */
export interface PeerHost {
  readonly peerCount: number;
  negotiate(roomId: string, id: string, offer: SessionDescriptionPayload, allowUplink: boolean): Promise<SessionDescriptionPayload>;
  addRemoteCandidate(roomId: string, id: string, candidate: IceCandidatePayload | null): Promise<void>;
  /** Second uplink gate next to the negotiated direction: only registered publishers forward RTP. */
  setUplink(roomId: string, id: string, enabled: boolean): void;
  send(frame: DownlinkFrame): void;
  getStats(roomId: string, id: string): Promise<TransportStats | null>;
  closePeer(roomId: string, id: string): void;
  counters(): Promise<HostCounters>;
  close(): Promise<void>;
}

interface Peer {
  roomId: string; id: string;
  pc: RTCPeerConnection; track: MediaStreamTrack; sender?: RTCRtpSender;
  allowUplink: boolean; uplinkEnabled: boolean;
  sequence: number; timestamp: number; started: number;
  /** Next sent packet starts a talkspurt (stream start or end of a DTX gap): set the RTP marker. */
  talkspurt: boolean;
  outboundBytes: number; outboundPackets: number; inboundBytes: number; inboundPackets: number;
}

const peerKey = (roomId: string, id: string) => `${roomId}\u0000${id}`;

export class WeriftPeerHost implements PeerHost {
  private readonly config: AppConfig;
  private readonly events: PeerHostEvents;
  private readonly peers = new Map<string, Peer>();
  private readonly closing = new Set<Promise<void>>();
  private readonly timestampStep: number;
  private readonly totals: HostCounters = { downlinkPackets: 0, downlinkDtxFrames: 0 };
  constructor(config: AppConfig, events: PeerHostEvents) {
    this.config = config; this.events = events;
    this.timestampStep = samplesPerFrame(config.audio);
  }
  get peerCount(): number { return this.peers.size; }
  async negotiate(roomId: string, id: string, offer: SessionDescriptionPayload, allowUplink: boolean): Promise<SessionDescriptionPayload> {
    const key = peerKey(roomId, id);
    let peer = this.peers.get(key);
    if (!peer) {
      const pc = new RTCPeerConnection({ codecs: { audio: [opusCodec()], video: [] }, iceServers: this.config.rtc.serverIceServers, icePortRange: this.config.rtc.portRange.length === 2 ? this.config.rtc.portRange : undefined });
      peer = { roomId, id, pc, track: new MediaStreamTrack({ kind: 'audio' }), allowUplink, uplinkEnabled: false, sequence: randomInt(65536), timestamp: randomInt(0x100000000), started: performance.now(), talkspurt: true, outboundBytes: 0, outboundPackets: 0, inboundBytes: 0, inboundPackets: 0 };
      this.peers.set(key, peer);
      const current = peer;
      pc.onIceCandidate.subscribe(candidate => this.events.localCandidate(roomId, id, candidate ? candidate.toJSON() : null));
      pc.connectionStateChange.subscribe(state => { if ((state === 'failed' || state === 'closed') && this.peers.get(key) === current) this.events.peerClosed(roomId, id); });
      pc.onTrack.subscribe(track => {
        if (track.kind !== 'audio') return;
        track.onReceiveRtp.subscribe(packet => {
          if (!current.allowUplink || !current.uplinkEnabled || this.peers.get(key) !== current) return;
          current.inboundBytes += packet.payload.length;
          current.inboundPackets++;
          this.events.uplink(roomId, id, packet.header.sequenceNumber, packet.payload);
        });
      });
    }
    peer.allowUplink = allowUplink;
    // Disable ingress before SRD: onTrack may fire during description application.
    // werift registers the remote SSRC for receiving only if the transceiver's local direction
    // already includes recv when the offer is applied; on renegotiation (audience → speaker) the
    // transceiver is still `sendonly`, so set the policy direction first or the uplink is never routed.
    for (const t of peer.pc.getTransceivers()) {
      if (t.kind === 'audio' && !t.stopped) t.direction = allowUplink ? 'sendrecv' : 'sendonly';
    }
    await peer.pc.setRemoteDescription(offer);
    const audio = peer.pc.getTransceivers().filter(t => t.kind === 'audio' && !t.stopped);
    if (audio.length !== 1) throw new Error('Exactly one audio transceiver is required');
    const transceiver = audio[0]!;
    transceiver.direction = allowUplink && (transceiver.offerDirection === 'sendrecv' || transceiver.offerDirection === 'sendonly') ? 'sendrecv' : 'sendonly';
    await transceiver.sender.replaceTrack(peer.track);
    if (peer.sender !== transceiver.sender) {
      const { sender } = transceiver;
      const owner = peer;
      sender.onRtcp.subscribe(packet => {
        if (this.peers.get(key) !== owner || !('reports' in packet)) return;
        for (const report of packet.reports) if (report.ssrc === sender.ssrc) this.events.downlinkLoss(roomId, id, report.fractionLost / 256);
      });
    }
    peer.sender = transceiver.sender;
    const answer = await peer.pc.createAnswer();
    await peer.pc.setLocalDescription(answer);
    return { type: 'answer', sdp: peer.pc.localDescription!.sdp };
  }
  async addRemoteCandidate(roomId: string, id: string, candidate: IceCandidatePayload | null): Promise<void> {
    const peer = this.peers.get(peerKey(roomId, id));
    if (!peer) throw new Error('Unknown media peer');
    await peer.pc.addIceCandidate(candidate ? { candidate: candidate.candidate, sdpMid: candidate.sdpMid ?? undefined, sdpMLineIndex: candidate.sdpMLineIndex ?? undefined, usernameFragment: candidate.usernameFragment ?? undefined } : null);
  }
  setUplink(roomId: string, id: string, enabled: boolean): void {
    const peer = this.peers.get(peerKey(roomId, id));
    if (peer) peer.uplinkEnabled = enabled;
  }
  send({ roomId, payloads, targets }: DownlinkFrame): void {
    const wrapped = payloads.map(p => Buffer.from(p.buffer, p.byteOffset, p.byteLength));
    for (const [id, index] of targets) {
      const peer = this.peers.get(peerKey(roomId, id));
      const sender = peer?.sender;
      if (!peer || !sender?.codec || peer.pc.connectionState !== 'connected') continue;
      const payload = wrapped[index]!;
      // libopus DTX emits ≤2-byte packets for silence; like libwebrtc, skip them but keep the RTP clock running.
      if (payload.length <= 2) { peer.timestamp = (peer.timestamp + this.timestampStep) >>> 0; peer.talkspurt = true; this.totals.downlinkDtxFrames++; continue; }
      const packet = new RtpPacket(new RtpHeader({ payloadType: sender.codec.payloadType, sequenceNumber: peer.sequence, timestamp: peer.timestamp, ssrc: sender.ssrc, marker: peer.talkspurt }), payload);
      peer.talkspurt = false;
      peer.sequence = (peer.sequence + 1) & 0xffff;
      peer.timestamp = (peer.timestamp + this.timestampStep) >>> 0;
      peer.track.writeRtp(packet);
      peer.outboundBytes += payload.length;
      peer.outboundPackets++;
      this.totals.downlinkPackets++;
    }
  }
  async getStats(roomId: string, id: string): Promise<TransportStats | null> {
    const peer = this.peers.get(peerKey(roomId, id));
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
    const key = peerKey(roomId, id);
    const peer = this.peers.get(key);
    if (!peer) return;
    this.peers.delete(key);
    peer.track.stop();
    const closing = peer.pc.close().finally(() => { this.closing.delete(closing); });
    this.closing.add(closing);
  }
  async counters(): Promise<HostCounters> { return { ...this.totals }; }
  async close(): Promise<void> {
    for (const peer of [...this.peers.values()]) this.closePeer(peer.roomId, peer.id);
    await Promise.all(this.closing);
  }
}
