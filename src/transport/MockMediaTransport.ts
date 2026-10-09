import type { IceCandidatePayload, SessionDescriptionPayload } from '../../shared/protocol.ts';
import { summarizeOffer } from '../rtc/sdp.ts';
import type {
  AudioFrameHandler,
  MediaTransport,
  MediaTransportCallbacks,
  MixedPcmSource,
  NegotiationPolicy,
  TransportStats,
} from './MediaTransport.ts';

interface MockPeer {
  allowUplink: boolean;
  candidates: (IceCandidatePayload | null)[];
  /** Downlink frames this participant received (mix or mix-minus-self). */
  received: Float32Array[];
  /** Uplink frames accepted, and lost ones a test may add to simulate a bad connection. */
  uplink: { packetsReceived: number; packetsLost: number };
}

interface MockRoom {
  peers: Map<string, MockPeer>;
  publishers: Map<string, AudioFrameHandler>;
  muted: Set<string>;
  subscribers: Set<string>;
  unsubscribeMix?: () => void;
}

/**
 * In-memory MediaTransport for tests and WebRTC-less development. Mirrors the
 * real adapter's policy: uplink frames reach the mixer only for registered
 * publishers whose last negotiation allowed uplink.
 */
export class MockMediaTransport implements MediaTransport {
  readonly rooms = new Map<string, MockRoom>();
  readonly callbacks: MediaTransportCallbacks;

  constructor(callbacks: MediaTransportCallbacks) {
    this.callbacks = callbacks;
  }

  private room(roomId: string): MockRoom {
    let r = this.rooms.get(roomId);
    if (!r) {
      r = { peers: new Map(), publishers: new Map(), muted: new Set(), subscribers: new Set() };
      this.rooms.set(roomId, r);
    }
    return r;
  }

  async negotiate(roomId: string, participantId: string, offer: SessionDescriptionPayload, policy: NegotiationPolicy): Promise<SessionDescriptionPayload> {
    const r = this.room(roomId);
    let peer = r.peers.get(participantId);
    if (!peer) {
      peer = { allowUplink: false, candidates: [], received: [], uplink: { packetsReceived: 0, packetsLost: 0 } };
      r.peers.set(participantId, peer);
    }
    peer.allowUplink = policy.allowUplink;
    const answerDirections = summarizeOffer(offer.sdp).audioDirections.map((d) =>
      policy.allowUplink && (d === 'sendrecv' || d === 'sendonly') ? 'sendrecv' : 'sendonly',
    );
    this.callbacks.onLocalCandidate(roomId, participantId, { candidate: 'candidate:mock 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 });
    this.callbacks.onLocalCandidate(roomId, participantId, null);
    return { type: 'answer', sdp: ['v=0', ...answerDirections.map((d) => `m=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=${d}`)].join('\r\n') };
  }

  async addRemoteCandidate(roomId: string, participantId: string, candidate: IceCandidatePayload | null): Promise<void> {
    this.rooms.get(roomId)?.peers.get(participantId)?.candidates.push(candidate);
  }

  addPublisher(roomId: string, participantId: string, onAudioFrame: AudioFrameHandler): void {
    this.room(roomId).publishers.set(participantId, onAudioFrame);
  }

  removePublisher(roomId: string, participantId: string): void {
    const r = this.rooms.get(roomId);
    r?.publishers.delete(participantId);
    r?.muted.delete(participantId);
  }

  setPublisherMuted(roomId: string, participantId: string, muted: boolean): void {
    const r = this.rooms.get(roomId);
    if (!r?.publishers.has(participantId)) return;
    if (muted) r.muted.add(participantId); else r.muted.delete(participantId);
  }

  setMixedStream(roomId: string, source: MixedPcmSource | null): void {
    const r = this.room(roomId);
    r.unsubscribeMix?.();
    r.unsubscribeMix = source?.onFrame((frame) => {
      for (const id of r.subscribers) r.peers.get(id)?.received.push((frame.minus(id) ?? frame.full).slice());
    });
  }

  subscribe(roomId: string, participantId: string): void {
    this.room(roomId).subscribers.add(participantId);
  }

  unsubscribe(roomId: string, participantId: string): void {
    this.rooms.get(roomId)?.subscribers.delete(participantId);
  }

  async getStats(roomId: string, participantId: string): Promise<TransportStats | null> {
    const peer = this.rooms.get(roomId)?.peers.get(participantId);
    if (!peer) return null;
    return { outbound: { codec: { mimeType: 'audio/opus', clockRate: 48000, channels: 1 }, packetsSent: peer.received.length }, inbound: { ...peer.uplink } };
  }

  closePeer(roomId: string, participantId: string): void {
    const r = this.rooms.get(roomId);
    if (!r) return;
    r.peers.delete(participantId);
    r.publishers.delete(participantId);
    r.muted.delete(participantId);
    r.subscribers.delete(participantId);
  }

  closeRoom(roomId: string): void {
    this.rooms.get(roomId)?.unsubscribeMix?.();
    this.rooms.delete(roomId);
  }

  async close(): Promise<void> {
    for (const id of [...this.rooms.keys()]) this.closeRoom(id);
  }

  /** Test helper: simulate decoded uplink audio. Dropped unless the participant is a registered, uplink-allowed, unmuted publisher. */
  emitUplink(roomId: string, participantId: string, samples: Float32Array): boolean {
    const r = this.rooms.get(roomId);
    const handler = r?.publishers.get(participantId);
    if (!handler || !r?.peers.get(participantId)?.allowUplink || r.muted.has(participantId)) return false;
    r.peers.get(participantId)!.uplink.packetsReceived++;
    handler(samples);
    return true;
  }
}
