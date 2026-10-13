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
  url: string;
  /** Connection hello, request acknowledgement and SDP answer deadline; default 15000 ms. */
  requestTimeoutMs?: number;
  /** Optional cap on queued/unacknowledged caller controls; RTC and automatic resume are excluded. */
  maxPendingControlRequests?: number;
  /** Finite delays in 0–2147483647 ms; values are captured when the client is constructed. */
  reconnect?: { initialDelayMs: number; maxDelayMs: number };
  audioElement?: HTMLAudioElement;
  micConstraints?: MediaTrackConstraints;
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
export interface MicTest { level(): number; stop(): void }
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
export interface StageEventMap {
  state: RoomStatePayload;
  status: ClientStatus;
  created: ServerMessageMap['room:created'];
  closed: ServerMessageMap['room:closed'];
  /** The controller removed you from the room; you are disconnected and will not rejoin on your own. */
  kicked: ServerMessageMap['kicked'];
  hand: { participantId: string; raised: boolean };
  invite: ServerMessageMap['stage:invite'];
  stagejoined: ServerMessageMap['stage:joined'];
  stageleft: ServerMessageMap['stage:left'];
  transferred: ServerMessageMap['control:transferred'];
  mic: { participantId: string; muted: boolean };
  role: ServerMessageMap['role:update'];
  error: StageError;
  micerror: { name: string; message: string };
  micready: undefined;
  audioblocked: { message: string };
  /** Full set of participants currently audible in the mix; fired only when it changes. */
  speaking: { participantIds: string[] };
  /** Connection quality of everyone publishing (controller and on-stage participants only). */
  quality: ServerMessageMap['quality'];
}
interface StatsCounters { timestamp: number; bytes?: number; received?: number; lost?: number; bufferDelay?: number; emitted?: number }
const finite = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const nonnegative = (value: unknown): number | undefined => { const n = finite(value); return n !== undefined && n >= 0 ? n : undefined; };

interface Pending { control: boolean; resolve: () => void; reject: (error: StageError) => void; timer: ReturnType<typeof setTimeout>; sendTimer?: ReturnType<typeof setTimeout> }
type JoinOptions = { roomId: string; code?: string; name: string; resumeToken?: string };
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
  private inputDeviceId = '';
  private micMeter: MicTest | null = null;
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
    // Retain the validated values, not a caller-owned object that could invalidate future timers.
    this.reconnectConfig = { initialDelayMs, maxDelayMs };
    this.maxPendingControlRequests = capacity ?? Infinity;
    this.requestTimeoutMs = timeout;
    this.options = options;
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
  /** RMS amplitude in [0, 1]; zero when not publishing or muted. */
  get micLevel(): number { return this.mic?.getAudioTracks()[0]?.enabled ? this.micMeter?.level() ?? 0 : 0; }
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
      try {
        if (captureRevision !== this.captureRevision) throw new StageError('disconnected', '麥克風要求已取消。');
        if (pc !== this.pc || !this.me?.onStage) return;
        const track = stream.getAudioTracks()[0];
        if (!track) throw new StageError('media_error', '所選裝置沒有音訊軌道。');
        track.enabled = !this.me.muted;
        meter = createMicMeter(stream);
        await transceiver.sender.replaceTrack(track);
        if (pc !== this.pc || !this.me?.onStage || captureRevision !== this.captureRevision) return;
        track.enabled = !this.me.muted;
        this.micMeter?.stop();
        this.mic?.getTracks().forEach((oldTrack) => oldTrack.stop());
        this.mic = stream;
        this.micMeter = meter;
        this.inputDeviceId = deviceId;
        this.emit('micready', undefined);
      } finally {
        if (this.mic !== stream) { meter?.stop(); stream.getTracks().forEach((track) => track.stop()); }
      }
    });
    this.mediaTask = task.catch(() => {});
    return task;
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
    let meter: MicTest;
    try {
      checkCancelled();
      meter = createMicMeter(stream);
    } catch (error) { stream.getTracks().forEach((track) => track.stop()); throw error; }
    let stopped = false;
    const test: MicTest = {
      level: meter.level,
      stop: () => {
        if (stopped) return;
        stopped = true;
        signal?.removeEventListener('abort', stopOnAbort);
        meter.stop();
        stream.getTracks().forEach((track) => track.stop());
        this.micTests.delete(test);
      },
    };
    const stopOnAbort = () => test.stop();
    this.micTests.add(test);
    signal?.addEventListener('abort', stopOnAbort, { once: true });
    try {
      checkCancelled();
      this.emit('micready', undefined);
      checkCancelled();
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
  on<K extends keyof StageEventMap>(type: K, listener: (event: CustomEvent<StageEventMap[K]>) => void): () => void {
    const handler = listener as EventListener;
    this.addEventListener(type, handler);
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
    if (this.socket?.readyState === WebSocket.OPEN) return Promise.resolve();
    this.intentional = false;
    if (this.ownsAudio && !this.audio.isConnected) document.body.append(this.audio);
    window.addEventListener('pagehide', this.onPageHide);
    const promise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.options.url);
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
      if (performance.now() - this.lastHeardAt > KEEPALIVE_TIMEOUT_MS) {
        this.report(new StageError('timeout', '伺服器沒有回應，正在重新連線。'));
        ws.onclose = null;
        this.socketLost(ws);
        try { ws.close(); } catch { /* already dead */ }
        return;
      }
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
    this.installSession({ roomId: result.roomId, code: result.code, name: options.name });
    return result;
  }
  async join(options: { roomId: string; code?: string; name: string }): Promise<void> {
    const admissionError = this.controlCapacityError();
    if (admissionError) throw admissionError;
    const revision = this.sessionRevision;
    await this.connect();
    if (revision !== this.sessionRevision) throw new StageError('disconnected', '連線已中斷。');
    await this.request('join', options);
    if (revision !== this.sessionRevision) throw new StageError('disconnected', '連線已中斷。');
    this.installSession({ ...options });
  }
  private installSession(session: JoinOptions): void {
    // An explicit successful join/create may replace a dropped session before its retry fires.
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.refreshSessionCode(session, this.snapshot);
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
        if (!state.me.onStage) this.micFailed = false;
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
        for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !state.me.muted;
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
  private syncMedia(): void {
    if (!this.me?.onStage) {
      ++this.captureRevision;
      this.micRequest?.abort(new StageError('disconnected', '已離開舞台，麥克風要求已取消。'));
    }
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
          try { this.micMeter = createMicMeter(stream); }
          catch (error) { this.mic = null; stream.getTracks().forEach((track) => track.stop()); throw error; }
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
      if (!current.onStage) { this.micMeter?.stop(); this.micMeter = null; this.mic?.getTracks().forEach((track) => track.stop()); this.mic = null; }
      const track = this.mic?.getAudioTracks()[0] ?? null;
      if (track) track.enabled = !current.muted;
      const direction = current.onStage && track ? 'sendrecv' : 'recvonly';
      const changed = transceiver.direction !== direction || transceiver.sender.track !== track;
      await transceiver.sender.replaceTrack(track);
      if (pc !== this.pc) return;
      transceiver.direction = direction;
      if (changed || !pc.localDescription || pc.signalingState !== 'stable') this.negotiate();
    }).catch((error: unknown) => { if (generation === this.mediaAbort) this.report(error); });
  }
  private negotiate(): void {
    this.negotiationDirty = true;
    if (this.negotiating) return;
    const pc = this.pc;
    if (!pc) return;
    this.negotiating = true;
    void (async () => {
      try {
        while (this.negotiationDirty && this.pc === pc) {
          this.negotiationDirty = false;
          // Replace the pending offer without rollback: an initial rollback changes its MID,
          // while the server still holds the transceiver from the unanswered offer.
          if (this.pc !== pc) return;
          const offer = await pc.createOffer();
          if (this.pc !== pc) return;
          offer.sdp = opusMonoSdp(offer.sdp ?? '');
          await pc.setLocalDescription(offer);
          if (this.pc !== pc) return;
          const answer = new Promise<void>((resolve, reject) => {
            this.answerWait = { resolve, reject };
          });
          const answerWait = this.answerWait;
          await Promise.all([answer, this.request('rtc:offer', { payload: { type: 'offer', sdp: pc.localDescription!.sdp } }, () => {
            if (this.pc !== pc || !answerWait || this.answerWait !== answerWait) throw new StageError('disconnected', '音訊協商已取消。');
            // Pacing is not time spent waiting for an answer: start only when the offer is sent.
            this.answerTimer = setTimeout(() => answerWait.reject(new StageError('timeout', '音訊協商逾時。')), this.requestTimeoutMs);
          })]);
          if (this.pc !== pc) return;
          clearTimeout(this.answerTimer);
          this.answerTimer = undefined;
          this.answerWait = null;
        }
      } catch (error) { if (this.pc === pc) this.report(error); }
      finally {
        if (this.pc === pc) {
          clearTimeout(this.answerTimer);
          this.answerTimer = undefined;
          this.answerWait = null;
          this.negotiating = false;
        }
      }
    })();
  }
  private destroyMedia(): void {
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
    this.micMeter?.stop();
    this.micMeter = null;
    this.mic?.getTracks().forEach((track) => track.stop());
    this.mic = null;
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
