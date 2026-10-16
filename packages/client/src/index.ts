import type { ClientMessageMap, ClientMessageType, ErrorCode, IceCandidatePayload, ParticipantView, RateLimits, RoomStatePayload, ServerMessage, ServerMessageMap } from '../../../shared/protocol.ts';
export type { ParticipantView, RoomStatePayload, Role, StageStatus, ErrorCode, IceServerConfig, ConnectionQuality } from '../../../shared/protocol.ts';
export { MAX_GAIN_DB } from '../../../shared/protocol.ts';

export function decodeName(value: string): string {
  const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity]!);
}

export class StageError extends Error {
  readonly code: ErrorCode | 'timeout' | 'disconnected' | 'media_error' | 'queue_full';
  constructor(code: StageError['code'], message: string) {
    super(message);
    this.name = 'StageError';
    this.code = code;
  }
}
export interface StageClientOptions {
  /** Captured at construction for every connection and resume; create a new client to change servers. */
  url: string;
  /** Connection hello, request acknowledgement and SDP answer deadline; default 15000 ms. */
  requestTimeoutMs?: number;
  /** Optional cap on queued/unacknowledged caller controls; RTC and automatic resume are excluded. */
  maxPendingControlRequests?: number;
  /** Finite delays in 0–2147483647 ms; values are captured when the client is constructed. */
  reconnect?: { initialDelayMs: number; maxDelayMs: number };
  audioElement?: HTMLAudioElement;
  micConstraints?: MediaTrackConstraints;
  /** Automatic room microphone RMS meter; default true. False makes micLevel zero; previews are independent. */
  enableMicMeter?: boolean;
}
export type ClientStatus = 'waiting' | 'live' | 'reconnecting' | 'disconnected';
export interface AudioStats {
  mimeType?: string;
  clockRate?: number;
  channels?: number;
  bitrateKbps?: number;
  packetsLost?: number;
  jitter?: number;
  rtt?: number;
  /**
   * Recent loss in percent: for inbound, packets lost since the previous `getStats()` call (absent
   * on the first call); for outbound, the share the server last reported losing.
   */
  lossPercent?: number;
  /**
   * Inbound only: how long received audio waited in the browser's jitter buffer before playing,
   * averaged since the previous `getStats()` call (absent on the first call). Network jitter
   * shows up here; together with `rtt` it is the listener's share of the end-to-end delay.
   */
  bufferMs?: number;
}
export interface StageStats { inbound: AudioStats | null; outbound: AudioStats | null }
export interface AudioDevices { inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }
/** Preview levels become zero after explicit stop or natural capture end; stop remains idempotent. */
export interface MicTest {
  /** SDK handles expose a terminal stop flag; optional for older structural implementations.
   * True means cleanup has started, not that asynchronous AudioContext.close has completed. */
  readonly stopped?: boolean;
  level(): number;
  stop(): void;
}
export interface MicTestOptions { signal?: AbortSignal }


function abortReason(signal: AbortSignal): unknown {
  return signal.reason === undefined ? new DOMException('麥克風測試已取消。', 'AbortError') : signal.reason;
}
/** getUserMedia cannot dismiss an existing permission prompt; dispose any late stream instead. */
function abortableMicStream(request: Promise<MediaStream>, signal: AbortSignal): Promise<MediaStream> {
  return new Promise((resolve, reject) => {
    let cancelled = false;
    const abort = () => {
      cancelled = true;
      signal.removeEventListener('abort', abort);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', abort, { once: true });
    void request.then(stream => {
      signal.removeEventListener('abort', abort);
      if (cancelled) stream.getTracks().forEach(track => track.stop());
      else resolve(stream);
    }, error => {
      signal.removeEventListener('abort', abort);
      if (!cancelled) reject(error);
    });
    if (signal.aborted) abort();
  });
}

function createMicMeter(stream: MediaStream): MicTest {
  const context = new AudioContext();
  try {
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    let stopped = false;
    void context.resume().catch(() => {});
    return {
      level() {
        if (stopped) return 0;
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        return Math.min(1, Math.sqrt(sum / samples.length));
      },
      stop() {
        if (stopped) return;
        stopped = true;
        source.disconnect();
        analyser.disconnect();
        void context.close().catch(() => {});
      },
    };
  } catch (error) {
    void context.close().catch(() => {});
    throw error;
  }
}
export interface StageClientEventOptions { once?: boolean; signal?: AbortSignal }
export interface StageEventMap {
  state: RoomStatePayload;
  status: ClientStatus;
  created: ServerMessageMap['room:created'];
  closed: ServerMessageMap['room:closed'];
  /** The controller removed you from the room; you are disconnected and will not rejoin on your own. */
  kicked: ServerMessageMap['kicked'];
  hand: { participantId: string; raised: boolean };
  /** An explicit controller rejection of your hand request. Transient; no replay or per-raise epoch. */
  handrejected: ServerMessageMap['hand:rejected'];
  invite: ServerMessageMap['stage:invite'];
  stagejoined: ServerMessageMap['stage:joined'];
  stageleft: ServerMessageMap['stage:left'];
  transferred: ServerMessageMap['control:transferred'];
  mic: { participantId: string; muted: boolean };
  role: ServerMessageMap['role:update'];
  error: StageError;
  micerror: { name: string; message: string };
  /** Shared capture-ready signal: initial/retry room capture precedes sender installation;
   * active device replacement follows replaceTrack, while preview is independent. Not proof of audible delivery. */
  micready: undefined;
  audioblocked: { message: string };
  /** Full audible set: seeded after create/join/resume state and before ACK, then updated on changes. */
  speaking: { participantIds: string[] };
  /** Full replacement of available publisher reports, possibly empty; controller and stage only. */
  quality: ServerMessageMap['quality'];
}
interface StatsCounters { timestamp: number; bytes?: number; received?: number; lost?: number; bufferDelay?: number; emitted?: number }
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const nonnegative = (value: unknown): number | undefined => { const n = finite(value); return n !== undefined && n >= 0 ? n : undefined; };

interface Pending { control: boolean; resolve: () => void; reject: (error: StageError) => void; timer: ReturnType<typeof setTimeout>; sendTimer?: ReturnType<typeof setTimeout> }
interface NegotiationRun { promise: Promise<void>; resolve: () => void; reject: (error: unknown) => void }
type JoinOptions = { roomId: string; code?: string; name: string; resumeToken?: string };
type AcceptedName = { readonly roomId: string; readonly participantId: string; readonly revision: number; readonly name: string };
const DEFAULT_REQUEST_TIMEOUT = 15000;
/** Until the server's `hello` says otherwise: the config.example.yaml defaults. */
const DEFAULT_LIMITS: RateLimits = { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000 };
const KEEPALIVE_INTERVAL_MS = 15000;
/** Two missed keepalive rounds. */
const KEEPALIVE_TIMEOUT_MS = 2 * KEEPALIVE_INTERVAL_MS + 5000;
/** `disconnected` this long → ICE restart (browsers take 15 s+ to reach `failed` on their own). */
const ICE_RESTART_AFTER_MS = 3000;
/** Application close code (browsers only allow 1000 and 3000–4999): page hidden, hold my seat. */
const CLOSE_PAGE_HIDDEN = 4002;

export class StageClient extends EventTarget {
  private readonly options: StageClientOptions;
  private readonly url: string;
  private readonly audio: HTMLAudioElement;
  private readonly ownsAudio: boolean;
  private socket: WebSocket | null = null;
  private readonly requestTimeoutMs: number;
  private readonly reconnectConfig: { initialDelayMs: number; maxDelayMs: number };
  private connecting: Promise<void> | null = null;
  private helloWait: { cancel: () => void } | null = null;
  private pending = new Map<string, Pending>();
  private pendingControlRequests = 0;
  private readonly maxPendingControlRequests: number;
  private snapshot: RoomStatePayload | null = null;
  private currentStatus: ClientStatus = 'disconnected';
  private session: JoinOptions | null = null;
  private acceptedName: AcceptedName | undefined;
  private created: ServerMessageMap['room:created'] | null = null;
  private intentional = false;
  private sessionRevision = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private pc: RTCPeerConnection | null = null;
  private pcParticipantId: string | null = null;
  private transceiver: RTCRtpTransceiver | null = null;
  private mic: MediaStream | null = null;
  private micFailed = false;
  private removeMicEndedListener: (() => void) | undefined;
  private inputDeviceId = '';
  private micMeter: MicTest | null = null;
  private readonly roomMicMeterEnabled: boolean;
  private readonly pendingMicReplacements = new Map<MediaStream, () => void>();
  private micTests = new Set<MicTest>();
  private readonly micTestRequests = new Set<AbortController>();
  private testRevision = 0;
  private remoteIce: (IceCandidatePayload | null)[] = [];
  private mediaRevision = 0;
  private mediaTask: Promise<void> = Promise.resolve();
  /** Permission waits and queued device changes belong to one PeerConnection generation. */
  private mediaAbort = new AbortController();
  private micRequest: AbortController | undefined;
  private captureRevision = 0;
  private negotiationDirty = false;
  private negotiating = false;
  private negotiationRun: NegotiationRun | null = null;
  private answerWait: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | undefined;
  private limits: RateLimits = DEFAULT_LIMITS;
  private lastHandAt = -Infinity;
  private nextControlAt = 0;
  private nextIceAt = 0;
  /** Latest scheduled send of any kind: the server processes frames in arrival order, so ICE must never overtake its offer. */
  private lastSendAt = 0;
  private previousStats = new Map<string, StatsCounters>();
  private statsSequence = 0;
  private completedStatsSequence = 0;
  private speakingIds: ReadonlySet<string> = new Set();
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private lastHeardAt = 0;
  private iceServers: RTCIceServer[] = [];
  private iceRestartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: StageClientOptions) {
    super();
    const timeout = options.requestTimeoutMs === undefined ? DEFAULT_REQUEST_TIMEOUT : options.requestTimeoutMs;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300000) throw new RangeError('請求逾時必須是 1 到 300000 之間的整數毫秒。');
    const capacity = options.maxPendingControlRequests;
    if (capacity !== undefined && (!Number.isSafeInteger(capacity) || capacity < 1)) throw new RangeError('待回覆控制請求上限必須是正安全整數。');
    const { initialDelayMs, maxDelayMs } = options.reconnect ?? { initialDelayMs: 500, maxDelayMs: 15000 };
    for (const delay of [initialDelayMs, maxDelayMs]) {
      if (!Number.isFinite(delay) || delay < 0 || delay > 2147483647) throw new RangeError('重連延遲必須是 0 到 2147483647 之間的有限毫秒數。');
    }
    const enableMicMeter = options.enableMicMeter;
    if (enableMicMeter !== undefined && typeof enableMicMeter !== 'boolean') throw new TypeError('enableMicMeter 必須是布林值。');
    this.roomMicMeterEnabled = enableMicMeter ?? true;
    // Retain the validated values, not a caller-owned object that could invalidate future timers.
    this.reconnectConfig = { initialDelayMs, maxDelayMs };
    this.maxPendingControlRequests = capacity ?? Infinity;
    this.requestTimeoutMs = timeout;
    this.options = options;
    // Reusing a caller-owned option bag must not redirect this session and its resume credentials.
    this.url = options.url;
    this.ownsAudio = !options.audioElement;
    this.audio = options.audioElement ?? document.createElement('audio');
    this.audio.autoplay = true;
    if (this.ownsAudio) { this.audio.hidden = true; document.body.append(this.audio); }
  }
  /**
   * Tell the server we are going instead of letting it find out at the next heartbeat. Not 1000
   * (that means "leaving"): the seat is held, so a page restored from the back/forward cache
   * reconnects and resumes. Registered only while connected, so a discarded client is not kept
   * alive by the window.
   */
  private readonly onPageHide = (): void => { this.socket?.close(CLOSE_PAGE_HIDDEN, 'page hidden'); };

  get state(): RoomStatePayload | null { return this.snapshot; }
  get status(): ClientStatus { return this.currentStatus; }
  get me(): ParticipantView | null { return this.snapshot?.me ?? null; }
  /** Participants currently audible in the mix (server voice activity). */
  get speaking(): ReadonlySet<string> { return this.speakingIds; }
  get handCooldownMs(): number { return Math.max(0, this.limits.handRaiseIntervalMs - (performance.now() - this.lastHandAt)); }
  /** Limits the connected server enforces per connection (from `hello`; defaults before connecting). */
  get rateLimits(): RateLimits { return this.limits; }
  /** Local listening level (0–1); independent of microphone mute and room-wide gain. */
  get playbackVolume(): number { return this.audio.volume; }
  /** Local speaker mute; changing volume does not unmute playback. */
  get playbackMuted(): boolean { return this.audio.muted; }
  setPlaybackVolume(volume: number): void {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) throw new RangeError('收聽音量必須是 0 到 1 之間的有限數值。');
    this.audio.volume = volume;
  }
  setPlaybackMuted(muted: boolean): void { this.audio.muted = muted; }
  get outputDeviceSupported(): boolean { return typeof this.audio.setSinkId === 'function'; }
  /** RMS amplitude in [0, 1]; zero when offstage, muted, or enableMicMeter is false. */
  get micLevel(): number {
    const me = this.me;
    return me?.onStage && !me.muted && this.mic?.getAudioTracks()[0]?.enabled ? this.micMeter?.level() ?? 0 : 0;
  }
  async listAudioDevices(): Promise<AudioDevices> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return { inputs: devices.filter((device) => device.kind === 'audioinput'), outputs: devices.filter((device) => device.kind === 'audiooutput') };
  }
  async setOutputDevice(deviceId: string): Promise<void> {
    if (!this.outputDeviceSupported) throw new StageError('media_error', '此瀏覽器不支援選擇揚聲器。');
    try { await this.audio.setSinkId(deviceId); }
    catch (error) { throw new StageError('media_error', error instanceof Error ? error.message : '無法切換揚聲器。'); }
  }
  setInputDevice(deviceId: string): Promise<void> {
    const generation = this.mediaAbort;
    const task = this.mediaTask.catch(() => {}).then(async () => {
      if (generation !== this.mediaAbort) throw new StageError('disconnected', '音訊連線已中斷。');
      const pc = this.pc;
      const transceiver = this.transceiver;
      if (!this.mic || !pc || !transceiver || !this.me?.onStage) { this.inputDeviceId = deviceId; return; }
      const captureRevision = this.captureRevision;
      const stream = await this.acquireMic(deviceId, generation);
      let meter: MicTest | null = null;
      let stopped = false;
      let replacing = false;
      const dispose = () => {
        this.pendingMicReplacements.delete(stream);
        meter?.stop();
        meter = null;
        if (!stopped) { stopped = true; stream.getTracks().forEach((track) => { track.enabled = false; track.stop(); }); }
      };
      this.pendingMicReplacements.set(stream, dispose);
      try {
        if (captureRevision !== this.captureRevision) throw new StageError('disconnected', '麥克風要求已取消。');
        if (pc !== this.pc || !this.me?.onStage) return;
        const track = stream.getAudioTracks()[0];
        if (!track) throw new StageError('media_error', '所選裝置沒有音訊軌道。');
        const ended = () => track.readyState === 'ended';
        if (ended()) throw new StageError('media_error', '所選麥克風已中斷。');
        track.enabled = !this.me.muted;
        meter = this.roomMicMeterEnabled ? createMicMeter(stream) : null;
        if (stopped || pc !== this.pc || !this.me?.onStage || captureRevision !== this.captureRevision) return;
        if (ended()) throw new StageError('media_error', '所選麥克風已中斷。');
        replacing = true;
        await transceiver.sender.replaceTrack(track);
        if (stopped || pc !== this.pc || !this.me?.onStage || captureRevision !== this.captureRevision) return;
        if (ended()) throw new StageError('media_error', '所選麥克風已中斷。');
        track.enabled = !this.me.muted;
        this.unwatchRoomMic();
        this.micMeter?.stop();
        this.mic?.getTracks().forEach((oldTrack) => oldTrack.stop());
        this.mic = stream;
        this.micMeter = meter;
        // Ownership moved to the installed microphone before application callbacks run.
        this.pendingMicReplacements.delete(stream);
        meter = null;
        stopped = true;
        this.inputDeviceId = deviceId;
        this.micFailed = false;
        this.watchRoomMic(stream, pc);
        if (this.mic !== stream || pc !== this.pc) return;
        this.emit('micready', undefined);
      } catch (error) {
        // A browser may already have attached the candidate before replaceTrack settles.
        // Restore the latest surviving room track only after this transaction has settled.
        if (replacing && stream.getAudioTracks()[0]?.readyState === 'ended'
          && pc === this.pc && this.me?.onStage && captureRevision === this.captureRevision) this.syncMedia();
        throw error;
      } finally {
        this.pendingMicReplacements.delete(stream);
        if (this.mic !== stream) dispose();
      }
    });
    this.mediaTask = task.catch(() => {});
    return task;
  }
  /** Queue one explicit retry of failed or ended room capture; true means admitted, not recovered audio. */
  retryMicrophone(): boolean {
    if (this.currentStatus !== 'live' || this.socket?.readyState !== WebSocket.OPEN
      || !this.pc || this.pc.connectionState === 'closed' || !this.transceiver
      || !this.me?.onStage || this.mic || !this.micFailed) return false;
    // Reserve admission before scheduling so repeated calls cannot queue permission prompts.
    // syncMedia retains its existing generation/revision cancellation and event-based errors.
    this.micFailed = false;
    this.syncMedia();
    return true;
  }
  /**
   * Retry SDP negotiation on the current peer without recapturing the microphone or restarting ICE.
   * Requires a joined waiting/live snapshot and open control connection; rejects overlapping attempts.
   * Resolves after the whole negotiation loop has acknowledged offers, installed answers and drained
   * buffered ICE. This does not establish that ICE is connected or that audio is audible.
   */
  retryAudioConnection(): Promise<void> {
    const state = this.snapshot;
    if (!state?.roomId || !state.me.participantId) return Promise.reject(new StageError('not_joined', '尚未加入房間。'));
    if ((this.currentStatus !== 'waiting' && this.currentStatus !== 'live') || this.socket?.readyState !== WebSocket.OPEN) {
      return Promise.reject(new StageError('disconnected', '尚未連線至舞台。'));
    }
    const pc = this.pc;
    if (!pc || this.pcParticipantId !== state.me.participantId || pc.connectionState === 'closed'
      || pc.connectionState === 'failed' || pc.signalingState === 'closed') {
      return Promise.reject(new StageError('media_error', '目前沒有可重試的音訊連線。'));
    }
    if (this.negotiating) return Promise.reject(new StageError('conflict', '音訊協商進行中，請等待完成後再試。'));
    return this.beginNegotiation();
  }
  async startMicTest(options: MicTestOptions = {}): Promise<MicTest> {
    const signal = options.signal;
    if (signal?.aborted) throw abortReason(signal);
    const revision = this.testRevision;
    const request = new AbortController();
    const abort = () => request.abort(abortReason(signal!));
    signal?.addEventListener('abort', abort, { once: true });
    this.micTestRequests.add(request);
    let stream: MediaStream;
    try {
      stream = await abortableMicStream(navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(this.inputDeviceId) }), request.signal);
    } finally {
      signal?.removeEventListener('abort', abort);
      this.micTestRequests.delete(request);
    }
    const checkCancelled = () => {
      if (signal?.aborted) throw abortReason(signal);
      if (revision !== this.testRevision) throw new StageError('disconnected', '麥克風測試已取消。');
    };
    let track: MediaStreamTrack | undefined;
    const checkTrack = () => {
      if (track?.readyState === 'ended') throw new DOMException('麥克風測試音軌已中斷，請重新測試。', 'NotReadableError');
    };
    let meter: MicTest | undefined;
    try {
      checkCancelled();
      track = stream.getAudioTracks()[0]; checkTrack();
      meter = createMicMeter(stream);
      // Platform meter construction can synchronously retire this capture.
      checkCancelled(); checkTrack();
    } catch (error) { meter?.stop(); stream.getTracks().forEach((track) => track.stop()); throw error; }
    const ownedMeter = meter;
    let stopped = false;
    const test: MicTest = {
      get stopped() { return stopped; },
      level: ownedMeter.level,
      stop: () => {
        if (stopped) return;
        stopped = true;
        signal?.removeEventListener('abort', stopOnAbort);
        track?.removeEventListener('ended', stopOnEnded);
        ownedMeter.stop();
        stream.getTracks().forEach((track) => track.stop());
        this.micTests.delete(test);
      },
    };
    const stopOnAbort = () => test.stop();
    const stopOnEnded = () => test.stop();
    this.micTests.add(test);
    signal?.addEventListener('abort', stopOnAbort, { once: true });
    track?.addEventListener('ended', stopOnEnded, { once: true });
    try {
      checkCancelled(); checkTrack();
      this.emit('micready', undefined);
      checkCancelled();
      // A listener may call track.stop(), which does not dispatch ended.
      if (track?.readyState === 'ended') test.stop();
      return test;
    } catch (error) { test.stop(); throw error; }
  }
  /** One serialized room-microphone permission wait; preview tests have independent ownership. */
  private async acquireMic(deviceId: string, generation: AbortController): Promise<MediaStream> {
    if (generation.signal.aborted) throw abortReason(generation.signal);
    const request = new AbortController();
    const abort = () => request.abort(abortReason(generation.signal));
    generation.signal.addEventListener('abort', abort, { once: true });
    this.micRequest = request;
    try {
      return await abortableMicStream(navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(deviceId) }), request.signal);
    } finally {
      generation.signal.removeEventListener('abort', abort);
      if (this.micRequest === request) this.micRequest = undefined;
    }
  }
  private audioConstraints(deviceId: string): MediaTrackConstraints {
    return { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...this.options.micConstraints, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) };
  }
  on<K extends keyof StageEventMap>(type: K, listener: (event: CustomEvent<StageEventMap[K]>) => void, options?: StageClientEventOptions): () => void {
    const handler = listener as EventListener;
    // Keep native listener identity and false capture even with structurally wider options.
    this.addEventListener(type, handler, { once: options?.once, signal: options?.signal });
    return () => this.removeEventListener(type, handler);
  }
  private emit<K extends keyof StageEventMap>(type: K, detail: StageEventMap[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
  private setStatus(status: ClientStatus): void {
    if (this.currentStatus !== status) { this.currentStatus = status; this.emit('status', status); }
  }
  connect(): Promise<void> {
    if (this.connecting) return this.connecting;
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    if (socket) {
      const revision = this.sessionRevision;
      this.socketLost(socket);
      // Loss listeners can cancel this call or start a same-session replacement synchronously.
      if (this.sessionRevision !== revision) return Promise.reject(new StageError('disconnected', '連線已中斷。'));
      if (this.connecting) return this.connecting;
      if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    }
    this.intentional = false;
    if (this.ownsAudio && !this.audio.isConnected) document.body.append(this.audio);
    window.addEventListener('pagehide', this.onPageHide);
    const promise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.socket = ws;
      let ready = false;
      const timer = setTimeout(() => {
        clearHello();
        reject(new StageError('timeout', '連線逾時，請稍後再試。'));
        this.abandonSocket(ws);
      }, this.requestTimeoutMs);
      const wait = { cancel: () => {
        clearTimeout(timer);
        clearHello();
        reject(new StageError('disconnected', '連線已中斷。'));
      } };
      const clearHello = () => { if (this.helloWait === wait) this.helloWait = null; };
      this.helloWait = wait;
      ws.onmessage = (event) => {
        if (this.socket !== ws) return;
        this.lastHeardAt = performance.now();
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          if (message.type === 'hello') { this.limits = message.limits; ready = true; clearTimeout(timer); clearHello(); this.startKeepalive(ws); resolve(); }
          void this.receive(message).catch((error: unknown) => this.report(error));
        } catch { this.report(new StageError('bad_request', '收到無法解析的伺服器訊息。')); }
      };
      ws.onerror = () => { if (!ready) reject(new StageError('disconnected', '無法連線至舞台。')); };
      ws.onclose = () => {
        clearTimeout(timer);
        clearHello();
        if (!ready) reject(new StageError('disconnected', '連線已中斷。'));
        this.socketLost(ws);
      };
    });
    this.connecting = promise;
    void promise.finally(() => {
      if (this.connecting !== promise) return;
      this.connecting = null;
      // Constructor failures have no socket close event to release the window's reference.
      if (this.socket?.readyState !== WebSocket.OPEN) {
        window.removeEventListener('pagehide', this.onPageHide);
        if (!this.session && this.ownsAudio) this.audio.remove();
      }
    }).catch(() => {});
    return promise;
  }
  /**
   * The control connection is gone. Media is deliberately kept: the server holds the seat and the
   * PeerConnection for the grace period, so audio continues while we reconnect and resume. Media is
   * torn down only when the session itself ends (intentional disconnect, kick, room closed, resume refused).
   */
  private socketLost(ws: WebSocket): void {
    if (this.socket !== ws) return;
    this.socket = null;
    window.removeEventListener('pagehide', this.onPageHide);
    this.stopKeepalive();
    this.rejectPending();
    // Native SDP operations cannot be cancelled; settle callers now but retain their serialization.
    this.negotiationRun?.reject(new StageError('disconnected', '音訊協商已中斷。'));
    // An acknowledged offer may still be waiting for its answer; do not let it block resume.
    this.answerWait?.reject(new StageError('disconnected', '音訊協商已中斷。'));
    if (!this.intentional && this.session) this.scheduleReconnect();
    else { this.destroyMedia(); if (this.ownsAudio) this.audio.remove(); this.setStatus('disconnected'); }
  }
  private abandonSocket(ws: WebSocket): void {
    // A failed hello/resume must not wait for a close handshake on an unresponsive transport.
    // Clear the old promise before callbacks can synchronously start a replacement connection.
    if (this.socket === ws) this.connecting = null;
    this.socketLost(ws);
    try { ws.close(); } catch { /* already dead */ }
  }
  /**
   * Application-level liveness: a half-open TCP connection (network switch, sleep) would otherwise
   * look alive for minutes. Silence past the timeout counts as a drop; `close()` on a dead socket can
   * itself hang, so the socket is abandoned first and closed best-effort.
   */
  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive();
    this.lastHeardAt = performance.now();
    this.keepaliveTimer = setInterval(() => {
      if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) { this.stopKeepalive(); return; }
      const now = performance.now();
      if (now - this.lastHeardAt > KEEPALIVE_TIMEOUT_MS) {
        this.report(new StageError('timeout', '伺服器沒有回應，正在重新連線。'));
        ws.onclose = null;
        this.socketLost(ws);
        try { ws.close(); } catch { /* already dead */ }
        return;
      }
      // Ping shares the control bucket; leave already-reserved control/ICE sends in place.
      if (now < this.nextControlAt || now < this.lastSendAt) return;
      this.lastSendAt = now;
      this.nextControlAt = now + Math.ceil(2000 / this.limits.controlPerSecond);
      ws.send(JSON.stringify({ type: 'ping' }));
    }, KEEPALIVE_INTERVAL_MS);
  }
  private stopKeepalive(): void {
    clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = undefined;
  }
  async createRoom(options: { name: string; roomName?: string; codeRequired?: boolean; token?: string }): Promise<{ roomId: string; code?: string }> {
    const admissionError = this.controlCapacityError();
    if (admissionError) throw admissionError;
    // Keep the submitted primitive fields consistent through hello, pacing and the final ACK.
    options = { ...options };
    const acceptedBefore = this.acceptedName;
    const revision = this.sessionRevision;
    await this.connect();
    if (revision !== this.sessionRevision) throw new StageError('disconnected', '連線已中斷。');
    const capacityError = this.controlCapacityError();
    if (capacityError) throw capacityError;
    // An overlapping create must not erase a result already delivered to another caller.
    const previousCreated = this.created;
    await this.request('room:create', options);
    if (revision !== this.sessionRevision) throw new StageError('disconnected', '連線已中斷。');
    if (!this.created || this.created === previousCreated) throw new StageError('internal', '伺服器未回傳房間資訊。');
    const result = this.created as ServerMessageMap['room:created'];
    this.installSession({ roomId: result.roomId, code: result.code, name: options.name }, acceptedBefore);
    return result;
  }
  async join(options: { roomId: string; code?: string; name: string }): Promise<void> {
    const admissionError = this.controlCapacityError();
    if (admissionError) throw admissionError;
    options = { ...options };
    const acceptedBefore = this.acceptedName;
    const revision = this.sessionRevision;
    await this.connect();
    if (revision !== this.sessionRevision) throw new StageError('disconnected', '連線已中斷。');
    await this.request('join', options);
    if (revision !== this.sessionRevision) throw new StageError('disconnected', '連線已中斷。');
    this.installSession({ ...options }, acceptedBefore);
  }
  private installSession(session: JoinOptions, acceptedBefore: AcceptedName | undefined): void {
    // An explicit successful join/create may replace a dropped session before its retry fires.
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.refreshSessionCode(session, this.snapshot);
    // Initial state may be followed by a rename before this entry's ACK. Never read mutable
    // public snapshot names here, or carry an earlier entry's record into an ACK-only result.
    const accepted = this.acceptedName;
    if (accepted && accepted !== acceptedBefore && accepted.revision === this.sessionRevision
      && accepted.roomId === session.roomId) session.name = accepted.name;
    this.session = session;
  }
  private refreshSessionCode(session: JoinOptions, state: RoomStatePayload | null): void {
    // Only the controller receives the authoritative private code. Omitted fields must not erase it.
    if (state?.roomId === session.roomId && state.me.role === 'controller' && state.codeRequired && state.code) {
      session.code = state.code;
    }
  }
  raiseHand(): Promise<void> {
    if (this.handCooldownMs > 0) return Promise.reject(new StageError('rate_limited', `每次舉手需間隔 ${Math.ceil(this.limits.handRaiseIntervalMs / 1000)} 秒。`));
    const capacityError = this.controlCapacityError();
    if (capacityError) return Promise.reject(capacityError);
    // A request rejected before admission must not consume the hand interval.
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new StageError('disconnected', '尚未連線至舞台。'));
    this.lastHandAt = performance.now();
    return this.request('hand:raise', {});
  }
  /** Change only your own display name; the server sanitizes it and publishes authoritative state. */
  setName(name: string): Promise<void> { return this.request('participant:rename', { name }); }
  /** Update the room display name (controller only); the server snapshot is authoritative. */
  setRoomName(name: string): Promise<void> { return this.request('room:rename', { name }); }
  withdrawHand(): Promise<void> { return this.request('hand:withdraw', {}); }
  approve(id: string): Promise<void> { return this.request('stage:approve', { targetId: id }); }
  reject(id: string): Promise<void> { return this.request('stage:reject', { targetId: id }); }
  leaveStage(): Promise<void> { return this.request('stage:leave', {}); }
  /** Controller only: self-approve back onto the stage (server skips the raised-hand check for self). */
  returnToStage(): Promise<void> {
    if (!this.me || this.me.role !== 'controller') return Promise.reject(new StageError('forbidden', '僅主控可自行返回舞台。'));
    return this.approve(this.me.participantId);
  }
  transferControl(id: string): Promise<void> { return this.request('control:transfer', { targetId: id }); }
  mute(): Promise<void> { return this.request('mic:mute', {}); }
  unmute(): Promise<void> { return this.request('mic:unmute', {}); }
  forceMute(id: string): Promise<void> { return this.request('mic:force-mute', { targetId: id }); }
  forceUnmute(id: string): Promise<void> { return this.request('mic:force-unmute', { targetId: id }); }
  removeFromStage(id: string): Promise<void> { return this.request('stage:remove', { targetId: id }); }
  /** Controller only: remove someone from the room; they get a `kicked` event and are disconnected. */
  kick(id: string): Promise<void> { return this.request('participant:kick', { targetId: id }); }
  /** Controller only: trim someone's level in the mix by `gainDb` (±MAX_GAIN_DB; 0 resets). */
  setGain(id: string, gainDb: number): Promise<void> { return this.request('mic:gain', { targetId: id, gainDb }); }
  /** Controller only: issue a new room code (code-protected rooms); people already inside stay. */
  rotateCode(): Promise<void> { return this.request('room:rotate-code', {}); }
  closeRoom(): Promise<void> { return this.request('room:close', {}); }
  async disconnect(): Promise<void> {
    this.intentional = true;
    ++this.sessionRevision;
    this.acceptedName = undefined;
    this.connecting = null;
    // An explicit cancellation must not wait for a stalled transport's close handshake.
    this.helloWait?.cancel();
    ++this.testRevision;
    for (const request of this.micTestRequests) request.abort(new StageError('disconnected', '麥克風測試已取消。'));
    this.micTestRequests.clear();
    for (const test of this.micTests) test.stop();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.session = null;
    this.snapshot = null;
    this.lastHandAt = -Infinity;
    this.speakingIds = new Set();
    this.stopKeepalive();
    const socket = this.socket;
    this.socket = null;
    this.rejectPending();
    this.destroyMedia();
    if (this.ownsAudio) this.audio.remove();
    window.removeEventListener('pagehide', this.onPageHide);
    // Retire all old resources before close/status callbacks can reconnect this client.
    try { socket?.close(1000); } catch { /* local cleanup must not depend on the transport */ }
    this.setStatus('disconnected');
  }
  async unlockAudio(): Promise<void> { await this.audio.play(); }

  private controlCapacityError(): StageError | undefined {
    if (this.pendingControlRequests >= this.maxPendingControlRequests) return new StageError('queue_full', '待回覆控制請求已滿，請等待完成後再試。');
    return undefined;
  }
  private request<K extends Exclude<ClientMessageType, 'ping'>>(type: K, payload: Omit<ClientMessageMap[K], 'requestId'>, onSend?: () => void, internal = false): Promise<void> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new StageError('disconnected', '尚未連線至舞台。'));
    const control = !internal && type !== 'rtc:offer' && type !== 'rtc:ice';
    const capacityError = control ? this.controlCapacityError() : undefined;
    if (capacityError) return Promise.reject(capacityError);
    const requestId = crypto.randomUUID();
    const now = performance.now();
    const ice = type === 'rtc:ice';
    // The server's buckets refill at the advertised rate; pacing at half (control) / two thirds (ICE)
    // of it leaves headroom for clock skew and for frames the page sends outside this client.
    const sendAt = Math.max(now, this.lastSendAt, ice ? this.nextIceAt : this.nextControlAt);
    this.lastSendAt = sendAt;
    if (ice) this.nextIceAt = sendAt + Math.ceil(1500 / this.limits.icePerSecond);
    else this.nextControlAt = sendAt + Math.ceil(2000 / this.limits.controlPerSecond);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.finish(requestId, new StageError('timeout', '請求逾時，請重試。'));
      }, this.requestTimeoutMs + sendAt - now);
      const pending: Pending = { control, resolve, reject, timer };
      this.pending.set(requestId, pending);
      if (control) this.pendingControlRequests++;
      pending.sendTimer = setTimeout(() => {
        delete pending.sendTimer;
        if (!this.pending.has(requestId)) return;
        if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) {
          this.finish(requestId, new StageError('disconnected', '連線已中斷。'));
          return;
        }
        try { onSend?.(); ws.send(JSON.stringify({ type, ...payload, requestId })); }
        catch { this.finish(requestId, new StageError('disconnected', '無法送出請求，連線可能已中斷。')); }
      }, sendAt - now);
    });
  }
  private finish(id: string, error?: StageError): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    clearTimeout(pending.sendTimer);
    this.pending.delete(id);
    if (pending.control) this.pendingControlRequests--;
    if (error) pending.reject(error); else pending.resolve();
  }
  private rejectPending(): void {
    for (const id of this.pending.keys()) this.finish(id, new StageError('disconnected', '連線已中斷。'));
    this.nextControlAt = this.nextIceAt = this.lastSendAt = 0;
  }
  private report(error: unknown): void {
    this.emit('error', error instanceof StageError ? error : new StageError('media_error', error instanceof Error ? error.message : '音訊連線失敗。'));
  }
  private async receive(message: ServerMessage): Promise<void> {
    switch (message.type) {
      case 'ok': this.finish(message.requestId); break;
      case 'error': {
        const error = new StageError(message.code, message.message);
        if (message.requestId) this.finish(message.requestId, error);
        this.emit('error', error);
        break;
      }
      case 'room:created': this.created = { roomId: message.roomId, code: message.code }; this.emit('created', this.created); break;
      case 'room:state': {
        const { type: _, ...state } = message;
        const previousId = this.snapshot?.me.participantId;
        if (previousId !== state.me.participantId) this.lastHandAt = -Infinity;
        this.snapshot = state;
        // Capture primitives before status/state listeners can mutate the public snapshot.
        const accepted: AcceptedName = { roomId: state.roomId, participantId: state.me.participantId,
          revision: this.sessionRevision, name: decodeName(state.me.name) };
        this.acceptedName = accepted;
        if (this.session?.roomId === accepted.roomId) this.session.name = accepted.name;
        if (!state.me.onStage) { this.micFailed = false; this.stopRoomMic(); }
        if (this.session) {
          this.session.resumeToken = state.resumeToken;
          this.refreshSessionCode(this.session, state);
        }
        this.reconnectAttempt = 0;
        this.setStatus(state.status);
        // Application callbacks may disconnect, unmount the widget or install a newer snapshot.
        if (this.snapshot !== state) return;
        this.emit('state', state);
        if (this.snapshot !== state) return;
        const enabled = state.me.onStage && !state.me.muted;
        for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = enabled;
        for (const stream of this.pendingMicReplacements.keys()) {
          for (const track of stream.getAudioTracks()) track.enabled = enabled;
        }
        // First snapshot of a (new) identity → fresh PeerConnection. A resumed seat keeps the one that
        // survived the ws drop unless the network side died meanwhile.
        const pcState = this.pc?.connectionState;
        if (!this.pc || this.pcParticipantId !== state.me.participantId || pcState === 'failed' || pcState === 'closed') this.createMedia();
        this.syncMedia();
        break;
      }
      case 'rtc:config': this.iceServers = message.iceServers; break;
      case 'rtc:answer': {
        const pc = this.pc, answerWait = this.answerWait;
        if (!pc || !answerWait) break;
        const current = () => pc === this.pc && answerWait === this.answerWait;
        try {
          await pc.setRemoteDescription(message.payload);
          if (pc !== this.pc) break;
          // Preserve same-peer candidate draining even after a deadline; leaving this shared
          // buffer for a later answer would move old ICE failures into its negotiation.
          for (const candidate of this.remoteIce.splice(0)) {
            await pc.addIceCandidate(candidate ?? undefined);
            if (pc !== this.pc) return;
          }
          if (current()) answerWait.resolve();
        } catch (error) { if (current()) answerWait.reject(error instanceof Error ? error : new Error('無法套用音訊回應。')); }
        break;
      }
      case 'rtc:ice': {
        const pc = this.pc;
        if (!pc?.remoteDescription) this.remoteIce.push(message.payload);
        else {
          try { await pc.addIceCandidate(message.payload ?? undefined); }
          catch (error) { if (this.pc === pc) this.report(error); }
        }
        break;
      }
      // Either way the seat is gone: forget the session so the socket close does not trigger a rejoin.
      case 'room:closed': case 'kicked':
        await this.disconnect();
        if (message.type === 'kicked') this.emit('kicked', { roomId: message.roomId });
        else this.emit('closed', message.reason ? { roomId: message.roomId, reason: message.reason } : { roomId: message.roomId });
        break;
      case 'status': this.setStatus(message.state); break;
      case 'hand:raise': case 'hand:withdraw': this.emit('hand', { participantId: message.participantId, raised: message.type === 'hand:raise' }); break;
      case 'hand:rejected': {
        const state = this.snapshot;
        if (state?.roomId === message.roomId && state.me.participantId === message.participantId &&
            (this.currentStatus === 'waiting' || this.currentStatus === 'live') &&
            state.me.role === 'audience' && !state.me.onStage && !state.me.handRaised) {
          this.emit('handrejected', { roomId: message.roomId, participantId: message.participantId });
        }
        break;
      }
      case 'stage:invite': this.emit('invite', { participantId: message.participantId, byId: message.byId }); break;
      case 'stage:joined': this.emit('stagejoined', { participantId: message.participantId, role: message.role }); break;
      case 'stage:left': this.emit('stageleft', { participantId: message.participantId, role: message.role, reason: message.reason }); break;
      case 'control:transferred': this.emit('transferred', { fromId: message.fromId, toId: message.toId }); break;
      case 'mic:muted': case 'mic:unmuted': this.emit('mic', { participantId: message.participantId, muted: message.type === 'mic:muted' }); break;
      case 'role:update': this.emit('role', { participantId: message.participantId, role: message.role, reason: message.reason }); break;
      case 'speaking': this.speakingIds = new Set(message.participantIds); this.emit('speaking', { participantIds: message.participantIds }); break;
      case 'quality': this.emit('quality', { participants: message.participants }); break;
    }
  }
  private scheduleReconnect(): void {
    const session = this.session, revision = this.sessionRevision;
    if (!session || this.intentional || this.reconnectTimer !== undefined) return;
    const current = () => !this.intentional && this.session === session && this.sessionRevision === revision;
    this.setStatus('reconnecting');
    if (!current()) return;
    const config = this.reconnectConfig;
    const delay = Math.min(config.maxDelayMs, config.initialDelayMs * 2 ** Math.min(this.reconnectAttempt++, 20));
    const timer = setTimeout(() => {
      if (this.reconnectTimer !== timer) return;
      this.reconnectTimer = undefined;
      if (!current()) return;
      void (async () => {
        let attemptedSocket: WebSocket | null = null;
        try {
          const connecting = this.connect();
          attemptedSocket = this.socket;
          await connecting;
          if (!current()) return;
          // Recovery must not compete with the caller-controlled backlog.
          await this.request('join', { ...session, resumeToken: this.snapshot?.resumeToken }, undefined, true);
        } catch (error) {
          if (!current()) return;
          this.report(error);
          if (!current()) return;
          if (error instanceof StageError && ['unauthorized', 'not_found', 'room_full'].includes(error.code)) {
            await this.disconnect();
          } else if (!this.reconnectTimer && !this.intentional && this.session) {
            if (attemptedSocket) this.abandonSocket(attemptedSocket);
            if (!this.socket) this.scheduleReconnect();
          }
        }
      })();
    }, delay);
    this.reconnectTimer = timer;
  }
  private createMedia(): void {
    this.destroyMedia();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.pcParticipantId = this.me?.participantId ?? null;
    this.transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.onicecandidate = (event) => {
      if (this.pc !== pc) return;
      void this.request('rtc:ice', { payload: event.candidate?.toJSON() as IceCandidatePayload ?? null }).catch((error: unknown) => {
        if (this.pc === pc) this.report(error);
      });
    };
    pc.ontrack = (event) => {
      if (this.pc !== pc) return;
      this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void this.audio.play().catch(() => {
        if (this.pc === pc) this.emit('audioblocked', { message: '瀏覽器已阻擋自動播放，請點擊啟用音訊。' });
      });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      clearTimeout(this.iceRestartTimer);
      this.iceRestartTimer = undefined;
      // `failed`: the server discards its side too (a failed werift peer cannot be renegotiated), so
      // both ends start over. `disconnected`: usually a network change; an ICE restart on the same
      // connection recovers in a few hundred ms instead of waiting for the browser's `failed` verdict.
      if (pc.connectionState === 'failed') {
        if (this.socket?.readyState === WebSocket.OPEN && this.session) { this.createMedia(); this.syncMedia(); }
      } else if (pc.connectionState === 'disconnected') {
        this.iceRestartTimer = setTimeout(() => {
          this.iceRestartTimer = undefined;
          if (this.pc === pc && pc.connectionState === 'disconnected' && this.socket?.readyState === WebSocket.OPEN) { pc.restartIce(); this.negotiate(); }
        }, ICE_RESTART_AFTER_MS);
      }
    };
    // Wait for the personalised snapshot before choosing the publishing direction.
  }
  private unwatchRoomMic(): void {
    this.removeMicEndedListener?.();
    this.removeMicEndedListener = undefined;
  }
  private watchRoomMic(stream: MediaStream, pc: RTCPeerConnection): void {
    this.unwatchRoomMic();
    const track = stream.getAudioTracks()[0];
    if (!track) return;
    const revision = this.captureRevision;
    const ended = () => {
      if (this.mic !== stream || this.pc !== pc || this.captureRevision !== revision || !this.me?.onStage) return;
      this.unwatchRoomMic();
      const meter = this.micMeter;
      this.mic = null; this.micMeter = null; this.micFailed = true;
      // Natural loss retires only this stream, not an explicit replacement already in flight.
      stream.getTracks().forEach(current => { current.enabled = false; current.stop(); });
      meter?.stop();
      if (this.pc !== pc || this.captureRevision !== revision || !this.me?.onStage || this.mic) return;
      this.syncMedia();
      this.emit('micerror', { name: 'NotReadableError', message: '麥克風已中斷，請確認裝置與權限，必要時選擇其他麥克風，再手動重試。' });
    };
    track.addEventListener('ended', ended);
    this.removeMicEndedListener = () => track.removeEventListener('ended', ended);
    if (track.readyState === 'ended') ended();
  }
  private stopRoomMic(): void {
    this.unwatchRoomMic();
    ++this.captureRevision;
    this.micRequest?.abort(new StageError('disconnected', '麥克風要求已取消。'));
    this.micMeter?.stop();
    this.micMeter = null;
    this.mic?.getTracks().forEach((track) => { track.enabled = false; track.stop(); });
    this.mic = null;
    for (const dispose of this.pendingMicReplacements.values()) dispose();
  }
  private syncMedia(): void {
    if (!this.me?.onStage) this.stopRoomMic();
    const generation = this.mediaAbort;
    const revision = ++this.mediaRevision;
    this.mediaTask = this.mediaTask.catch(() => {}).then(async () => {
      const pc = this.pc;
      const transceiver = this.transceiver;
      const me = this.me;
      if (!pc || !transceiver || !me || revision !== this.mediaRevision) return;
      if (me.onStage && !this.mic && !this.micFailed) {
        const captureRevision = this.captureRevision;
        try {
          const stream = await this.acquireMic(this.inputDeviceId, generation);
          if (pc !== this.pc || !this.me?.onStage || captureRevision !== this.captureRevision) { stream.getTracks().forEach((track) => track.stop()); return; }
          this.mic = stream;
          try {
            if (stream.getAudioTracks()[0]?.readyState === 'ended') throw new StageError('media_error', '麥克風已中斷。');
            if (!this.roomMicMeterEnabled && !stream.getAudioTracks()[0]) throw new StageError('media_error', '麥克風沒有音訊軌道。');
            const meter = this.roomMicMeterEnabled ? createMicMeter(stream) : null;
            if (this.mic !== stream || pc !== this.pc || captureRevision !== this.captureRevision) { meter?.stop(); return; }
            this.micMeter = meter;
          }
          catch (error) { if (this.mic === stream) { this.mic = null; stream.getTracks().forEach((track) => track.stop()); } throw error; }
          this.watchRoomMic(stream, pc);
          if (this.mic !== stream || pc !== this.pc) return;
          this.emit('micready', undefined);
        } catch (error) {
          if (pc !== this.pc || !this.me?.onStage || captureRevision !== this.captureRevision || (error instanceof StageError && error.code === 'disconnected')) return;
          this.micFailed = true;
          const name = error instanceof Error ? error.name : 'UnknownError';
          const message = name === 'NotAllowedError' ? '麥克風權限遭拒，請在瀏覽器網站設定允許麥克風後重新上台。' : name === 'NotFoundError' ? '找不到麥克風，請連接音訊裝置後重新上台。' : '無法啟用麥克風，請確認 HTTPS、裝置及瀏覽器權限後重新上台。';
          this.emit('micerror', { name, message });
          // Receive audio even when publishing permission is unavailable.
        }
      }
      if (pc !== this.pc) return;
      const current = this.me;
      if (!current) return;
      if (!current.onStage) this.stopRoomMic();
      const track = this.mic?.getAudioTracks()[0] ?? null;
      if (track) track.enabled = !current.muted;
      const direction = current.onStage && track ? 'sendrecv' : 'recvonly';
      const changed = transceiver.direction !== direction || transceiver.sender.track !== track;
      await transceiver.sender.replaceTrack(track);
      if (pc !== this.pc || revision !== this.mediaRevision) return;
      transceiver.direction = direction;
      if (changed || !pc.localDescription || pc.signalingState !== 'stable') this.negotiate();
    }).catch((error: unknown) => { if (generation === this.mediaAbort) this.report(error); });
  }
  private negotiate(): void { void this.beginNegotiation(); }
  private beginNegotiation(): Promise<void> {
    this.negotiationDirty = true;
    if (this.negotiating) return this.negotiationRun?.promise ?? Promise.resolve();
    const pc = this.pc;
    if (!pc) return Promise.resolve();
    let resolve!: () => void, reject!: (error: unknown) => void;
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    // Automatic negotiation has no awaiting caller. Retain the original promise for explicit retries.
    void promise.catch(() => {});
    const run: NegotiationRun = { promise, resolve, reject };
    this.negotiationRun = run;
    this.negotiating = true;
    const current = () => this.pc === pc && this.negotiationRun === run;
    void (async () => {
      try {
        while (this.negotiationDirty && current()) {
          this.negotiationDirty = false;
          // Replace the pending offer without rollback: an initial rollback changes its MID,
          // while the server still holds the transceiver from the unanswered offer.
          if (!current()) return;
          const offer = await pc.createOffer();
          if (!current()) return;
          offer.sdp = opusMonoSdp(offer.sdp ?? '');
          await pc.setLocalDescription(offer);
          if (!current()) return;
          const answer = new Promise<void>((resolve, reject) => {
            this.answerWait = { resolve, reject };
          });
          const answerWait = this.answerWait;
          await Promise.all([answer, this.request('rtc:offer', { payload: { type: 'offer', sdp: pc.localDescription!.sdp } }, () => {
            if (!current() || !answerWait || this.answerWait !== answerWait) throw new StageError('disconnected', '音訊協商已取消。');
            // Pacing is not time spent waiting for an answer: start only when the offer is sent.
            this.answerTimer = setTimeout(() => answerWait.reject(new StageError('timeout', '音訊協商逾時。')), this.requestTimeoutMs);
          })]);
          if (!current()) return;
          clearTimeout(this.answerTimer);
          this.answerTimer = undefined;
          this.answerWait = null;
        }
        run.resolve();
      } catch (error) {
        run.reject(error);
        if (current()) this.report(error);
      }
      finally {
        if (current()) {
          clearTimeout(this.answerTimer);
          this.answerTimer = undefined;
          this.answerWait = null;
          this.negotiating = false;
          this.negotiationRun = null;
        }
      }
    })();
    return promise;
  }
  private destroyMedia(): void {
    this.negotiationRun?.reject(new StageError('disconnected', '音訊連線已中斷。'));
    this.negotiationRun = null;
    ++this.mediaRevision;
    this.mediaAbort.abort(new StageError('disconnected', '音訊連線已中斷。'));
    this.mediaAbort = new AbortController();
    // Old permission requests may never settle. Their late results are disposed independently;
    // a replacement peer must not inherit their serialized work queue.
    this.mediaTask = Promise.resolve();
    clearTimeout(this.iceRestartTimer);
    this.iceRestartTimer = undefined;
    this.pc?.close();
    this.pc = null;
    this.pcParticipantId = null;
    this.transceiver = null;
    this.stopRoomMic();
    this.micFailed = false;
    this.audio.pause();
    this.audio.srcObject = null;
    this.remoteIce = [];
    this.answerWait?.reject(new StageError('disconnected', '音訊連線已中斷。'));
    this.answerWait = null;
    clearTimeout(this.answerTimer);
    this.answerTimer = undefined;
    this.negotiating = this.negotiationDirty = false;
    this.previousStats.clear();
  }
  async getStats(): Promise<StageStats> {
    const result: StageStats = { inbound: null, outbound: null };
    const pc = this.pc;
    if (!pc) return result;
    const sequence = ++this.statsSequence;
    let stats: RTCStatsReport;
    try { stats = await pc.getStats(); }
    catch (error) {
      if (this.pc !== pc || sequence < this.completedStatsSequence) return result;
      throw error;
    }
    // A completed poll from a retired peer or an older overlapping call must not seed new deltas.
    if (this.pc !== pc || sequence < this.completedStatsSequence) return result;
    this.completedStatsSequence = sequence;
    let rtt: number | undefined;
    stats.forEach((entry) => { if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated) rtt = nonnegative(entry.currentRoundTripTime); });
    const active = new Set<string>();
    stats.forEach((entry) => {
      if (!['inbound-rtp', 'outbound-rtp'].includes(entry.type) || (entry.kind ?? entry.mediaType) !== 'audio') return;
      active.add(entry.id);
      const codec = stats.get(entry.codecId);
      const inbound = entry.type === 'inbound-rtp';
      const bytes = nonnegative(inbound ? entry.bytesReceived : entry.bytesSent);
      const timestamp = finite(entry.timestamp);
      const previous = this.previousStats.get(entry.id);
      const elapsed = timestamp !== undefined && previous ? timestamp - previous.timestamp : 0;
      const remote = entry.remoteId ? stats.get(entry.remoteId) : undefined;
      const summary: AudioStats = { mimeType: codec?.mimeType, clockRate: nonnegative(codec?.clockRate), channels: nonnegative(codec?.channels), packetsLost: finite(entry.packetsLost) ?? finite(remote?.packetsLost), jitter: nonnegative(entry.jitter) ?? nonnegative(remote?.jitter), rtt: nonnegative(remote?.roundTripTime) ?? rtt };
      const received = nonnegative(entry.packetsReceived), lost = finite(entry.packetsLost);
      const bufferDelay = nonnegative(entry.jitterBufferDelay), emitted = nonnegative(entry.jitterBufferEmittedCount);
      if (previous && elapsed > 0 && Number.isFinite(elapsed)) {
        if (bytes !== undefined && previous.bytes !== undefined && bytes >= previous.bytes) {
          const rate = (bytes - previous.bytes) * 8 / elapsed;
          if (Number.isFinite(rate)) summary.bitrateKbps = rate;
        }
        if (inbound && received !== undefined && lost !== undefined && previous.received !== undefined && previous.lost !== undefined && received >= previous.received) {
          const total = received - previous.received + lost - previous.lost;
          const loss = total > 0 ? 100 * Math.max(0, lost - previous.lost) / total : undefined;
          if (loss !== undefined && Number.isFinite(loss)) summary.lossPercent = loss;
        }
        if (inbound && bufferDelay !== undefined && emitted !== undefined && previous.bufferDelay !== undefined && previous.emitted !== undefined && bufferDelay >= previous.bufferDelay && emitted > previous.emitted) {
          const delay = 1000 * (bufferDelay - previous.bufferDelay) / (emitted - previous.emitted);
          if (Number.isFinite(delay)) summary.bufferMs = delay;
        }
      }
      const fraction = nonnegative(remote?.fractionLost);
      if (!inbound && fraction !== undefined && fraction <= 1) summary.lossPercent = 100 * fraction;
      if (timestamp !== undefined && (!previous || timestamp > previous.timestamp)) {
        this.previousStats.set(entry.id, { bytes, timestamp, received, lost, bufferDelay, emitted });
      }
      if (inbound) result.inbound = summary; else result.outbound = summary;
    });
    // SSRC/track changes can create new report IDs without replacing the PeerConnection.
    for (const id of this.previousStats.keys()) if (!active.has(id)) this.previousStats.delete(id);
    return result;
  }

}

function opusMonoSdp(sdp: string): string {
  const lines = sdp.split('\r\n');
  const payloads = lines.flatMap((line) => { const match = /^a=rtpmap:(\d+) opus\//i.exec(line); return match?.[1] ? [match[1]] : []; });
  for (const payload of payloads) {
    const prefix = `a=fmtp:${payload} `;
    const index = lines.findIndex((line) => line.startsWith(prefix));
    const retained = index < 0 ? [] : lines[index]!.slice(prefix.length).split(';').filter((parameter) => !/^(?:stereo|sprop-stereo|maxaveragebitrate|useinbandfec|cbr)\s*=/i.test(parameter.trim()));
    const line = prefix + [...retained, 'stereo=0', 'sprop-stereo=0', 'maxaveragebitrate=128000', 'useinbandfec=1'].join(';');
    if (index >= 0) lines[index] = line;
    else { const rtp = lines.findIndex((item) => item.startsWith(`a=rtpmap:${payload} `)); lines.splice(rtp + 1, 0, line); }
  }
  return lines.join('\r\n');
}
