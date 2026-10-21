import type { IceCandidatePayload, SessionDescriptionPayload } from '../../shared/protocol.ts';

/**
 * Media-plane contract (PLAN.md §3.1). The core (state machine, mixer, ws) only
 * talks to this interface; WebRTC stacks plug in as adapters (werift today,
 * MockMediaTransport for tests). Swapping the stack must not touch the core.
 *
 * PCM convention everywhere above this interface:
 *   mono Float32 in [-1, 1], `config.audio.sampleRate` (48 kHz), `frameMs` (20 ms)
 *   → 960 samples per frame at 48 kHz.
 * Opus codec runs at the same rate, so no resampling; the RTP clock is always
 * 48 kHz per RFC 7587.
 */

/** Receives one decoded uplink PCM frame from a publisher. */
export type AudioFrameHandler = (samples: Float32Array) => void;

/** One mixer tick output. Its buffers belong to the mixer and are rewritten next tick: copy to keep. */
export interface MixFrame {
  /** Monotonic tick counter. */
  readonly seq: number;
  /** Mix of all active, unmuted publishers (limited). Audience downlink. */
  readonly full: Float32Array;
  /** No publisher contributed audio this tick (all muted or starved): every mix is silence. */
  readonly silent: boolean;
  /**
   * Mix excluding `participantId` (limited) if that participant is an active
   * publisher this tick; `undefined` otherwise (→ use `full`).
   */
  minus(participantId: string): Float32Array | undefined;
}

export type MixFrameListener = (frame: MixFrame) => void;

/**
 * Receives the room's encoded full mix (the audience downlink), one Opus packet per mixer frame,
 * in order. `null` = this frame has no packet (skipped while silent, shed, or failed to encode).
 */
export type MixPacketSink = (packet: Uint8Array | null) => void;

/** Mixer output a transport can subscribe to. */
export interface MixedPcmSource {
  /** Returns an unsubscribe function. */
  onFrame(listener: MixFrameListener): () => void;
}

export interface NegotiationPolicy {
  /** Whether the server accepts an uplink audio track from this participant. */
  allowUplink: boolean;
}

export interface TransportStats {
  /** Downlink (server → participant) */
  outbound?: {
    codec?: { mimeType: string; clockRate: number; channels: number };
    bitrateKbps?: number;
    packetsSent?: number;
    /** Recent share (0..1) of these packets the participant reported lost (smoothed RTCP receiver reports). */
    fractionLost?: number;
  };
  /** Uplink (participant → server) */
  inbound?: {
    codec?: { mimeType: string; clockRate: number; channels: number };
    bitrateKbps?: number;
    packetsReceived?: number;
    packetsLost?: number;
  };
  rttMs?: number;
}

export interface MediaTransportCallbacks {
  /** Server-side ICE candidate for a participant's PeerConnection (null = end of candidates). */
  onLocalCandidate(roomId: string, participantId: string, candidate: IceCandidatePayload | null): void;
  /** PeerConnection failed/closed from the network side. */
  onPeerClosed?(roomId: string, participantId: string): void;
}

export interface MediaTransport {
  /** Apply a client offer and return the server answer. Creates the peer on first call. */
  negotiate(
    roomId: string,
    participantId: string,
    offer: SessionDescriptionPayload,
    policy: NegotiationPolicy,
  ): Promise<SessionDescriptionPayload>;
  addRemoteCandidate(roomId: string, participantId: string, candidate: IceCandidatePayload | null): Promise<void>;

  /** Start delivering decoded uplink PCM of `participantId`. Uplink packets are dropped unless registered (fail-closed). */
  addPublisher(roomId: string, participantId: string, onAudioFrame: AudioFrameHandler): void;
  removePublisher(roomId: string, participantId: string): void;
  /**
   * The mixer drops a muted publisher's audio anyway, so its uplink is not decoded meanwhile;
   * decoding restarts from a fresh codec state on unmute. No-op for unknown publishers.
   */
  setPublisherMuted(roomId: string, participantId: string, muted: boolean): void;

  /** Attach (or detach with null) the room mixer output; encoded to Opus and sent to subscribers. */
  setMixedStream(roomId: string, source: MixedPcmSource | null): void;
  /** Also deliver the room's encoded full mix to `sink` (null stops); encoded once, shared with the audience. */
  setRecording(roomId: string, sink: MixPacketSink | null): void;
  /** Downlink: subscribers receive `frame.minus(id) ?? frame.full`. */
  subscribe(roomId: string, participantId: string): void;
  unsubscribe(roomId: string, participantId: string): void;

  getStats(roomId: string, participantId: string): Promise<TransportStats | null>;

  /** Tear down one participant's peer (also removes publisher/subscription). */
  closePeer(roomId: string, participantId: string): void;
  /** Tear down every peer of a room. */
  closeRoom(roomId: string): void;
  close(): Promise<void>;
}
