import type { ChatMessage, ClientMessageMap, ClientMessageType, ErrorCode, IceCandidatePayload, ParticipantView, RateLimits, Reaction, RoomStatePayload, ServerMessage, ServerMessageMap } from '../../../shared/protocol.ts';
export type { ParticipantView, RoomStatePayload, Role, StageStatus, ErrorCode, IceServerConfig, ConnectionQuality, ChatMessage, Reaction } from '../../../shared/protocol.ts';
export { MAX_GAIN_DB, REACTIONS } from '../../../shared/protocol.ts';

export function decodeName(value: string): string {
  const entities: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };
  return value.replace(/&(?:amp|lt|gt|quot|#39);/g, (entity) => entities[entity]!);
}

export class StageError extends Error {
  readonly code: ErrorCode | 'timeout' | 'disconnected' | 'media_error';
  constructor(code: StageError['code'], message: string) {
    super(message);
    this.name = 'StageError';
    this.code = code;
  }
}
/** 繁中 text for server error codes; the server only sends fixed generic English (AGENTS.md §S8), so clients localize by `code`. */
export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  bad_request: '請求格式錯誤。',
  unknown_type: '不支援的操作。',
  not_joined: '尚未加入房間。',
  already_joined: '已在房間中。',
  unauthorized: '無法加入房間，請確認房間 ID 與代碼。',
  forbidden: '沒有權限執行此操作。',
  not_found: '找不到對象。',
  conflict: '目前狀態無法執行此操作。',
  room_full: '房間已滿。',
  stage_full: '舞台已滿。',
  rate_limited: '操作過於頻繁，請稍後再試。',
  internal: '伺服器發生錯誤。',
};
export interface StageClientOptions {
  url: string;
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
  /** One new chat message (text and name are HTML-escaped: render with textContent after `decodeName`). */
  chat: ChatMessage;
  /** Recent chat replayed on join or rejoin; replaces `chatMessages`. */
  chathistory: { messages: ChatMessage[] };
  reaction: ServerMessageMap['reaction'];
}
interface Pending { resolve: () => void; reject: (error: StageError) => void; timer: ReturnType<typeof setTimeout> }
type JoinOptions = { roomId: string; code?: string; name: string; resumeToken?: string };
const REQUEST_TIMEOUT = 15000;
/** Until the server's `hello` says otherwise: the config.example.yaml defaults. */
const DEFAULT_LIMITS: RateLimits = { controlPerSecond: 20, icePerSecond: 30, handRaiseIntervalMs: 10000, chatIntervalMs: 1000, reactionIntervalMs: 250 };
/** Client-side cap on kept chat messages; the server's own history is usually shorter. */
const MAX_CHAT_MESSAGES = 200;
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
  private connecting: Promise<void> | null = null;
  private pending = new Map<string, Pending>();
  private snapshot: RoomStatePayload | null = null;
  private currentStatus: ClientStatus = 'disconnected';
  private session: JoinOptions | null = null;
  private created: ServerMessageMap['room:created'] | null = null;
  private intentional = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private pc: RTCPeerConnection | null = null;
  private transceiver: RTCRtpTransceiver | null = null;
  private mic: MediaStream | null = null;
  private micFailed = false;
  private inputDeviceId = '';
  private micMeter: MicTest | null = null;
  private micTests = new Set<MicTest>();
  private testRevision = 0;
  private remoteIce: (IceCandidatePayload | null)[] = [];
  private mediaRevision = 0;
  private mediaTask: Promise<void> = Promise.resolve();
  private negotiationDirty = false;
  private negotiating = false;
  private answerWait: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | undefined;
  private limits: RateLimits = DEFAULT_LIMITS;
  private lastHandAt = -Infinity;
  private lastChatAt = -Infinity;
  private lastReactionAt = -Infinity;
  private chatLog: ChatMessage[] = [];
  private nextControlAt = 0;
  private nextIceAt = 0;
  /** Latest scheduled send of any kind: the server processes frames in arrival order, so ICE must never overtake its offer. */
  private lastSendAt = 0;
  private previousStats = new Map<string, { bytes: number; timestamp: number; received: number; lost: number; bufferDelay: number; emitted: number }>();
  private speakingIds: ReadonlySet<string> = new Set();
  private keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  private lastHeardAt = 0;
  private iceServers: RTCIceServer[] = [];
  private iceRestartTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: StageClientOptions) {
    super();
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
  /** Chat messages since joining (plus replayed history), oldest first. */
  get chatMessages(): readonly ChatMessage[] { return this.chatLog; }
  get handCooldownMs(): number { return Math.max(0, this.limits.handRaiseIntervalMs - (Date.now() - this.lastHandAt)); }
  /** Limits the connected server enforces per connection (from `hello`; defaults before connecting). */
  get rateLimits(): RateLimits { return this.limits; }
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
    const task = this.mediaTask.catch(() => {}).then(async () => {
      const pc = this.pc;
      const transceiver = this.transceiver;
      if (!this.mic || !pc || !transceiver || !this.me?.onStage) { this.inputDeviceId = deviceId; return; }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(deviceId) });
      let meter: MicTest | null = null;
      try {
        if (pc !== this.pc || !this.me?.onStage) return;
        const track = stream.getAudioTracks()[0];
        if (!track) throw new StageError('media_error', '所選裝置沒有音訊軌道。');
        track.enabled = !this.me.muted;
        meter = createMicMeter(stream);
        await transceiver.sender.replaceTrack(track);
        if (pc !== this.pc || !this.me?.onStage) return;
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
  async startMicTest(): Promise<MicTest> {
    const revision = this.testRevision;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(this.inputDeviceId) });
    let meter: MicTest;
    try {
      if (revision !== this.testRevision) throw new StageError('disconnected', '麥克風測試已取消。');
      meter = createMicMeter(stream);
    } catch (error) { stream.getTracks().forEach((track) => track.stop()); throw error; }
    const test: MicTest = {
      level: meter.level,
      stop: () => {
        meter.stop();
        stream.getTracks().forEach((track) => track.stop());
        this.micTests.delete(test);
      },
    };
    this.micTests.add(test);
    this.emit('micready', undefined);
    return test;
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
      const timer = setTimeout(() => { reject(new StageError('timeout', '連線逾時，請稍後再試。')); ws.close(); }, REQUEST_TIMEOUT);
      ws.onmessage = (event) => {
        if (this.socket !== ws) return;
        this.lastHeardAt = Date.now();
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          if (message.type === 'hello') { this.limits = message.limits; ready = true; clearTimeout(timer); this.startKeepalive(ws); resolve(); }
          void this.receive(message).catch((error: unknown) => this.report(error));
        } catch { this.report(new StageError('bad_request', '收到無法解析的伺服器訊息。')); }
      };
      ws.onerror = () => { if (!ready) reject(new StageError('disconnected', '無法連線至舞台。')); };
      ws.onclose = () => {
        clearTimeout(timer);
        if (!ready) reject(new StageError('disconnected', '連線已中斷。'));
        this.socketLost(ws);
      };
    });
    this.connecting = promise;
    void promise.finally(() => { if (this.connecting === promise) this.connecting = null; }).catch(() => {});
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
    this.stopKeepalive();
    this.rejectPending();
    if (!this.intentional && this.session) this.scheduleReconnect();
    else { this.destroyMedia(); this.setStatus('disconnected'); }
  }
  /**
   * Application-level liveness: a half-open TCP connection (network switch, sleep) would otherwise
   * look alive for minutes. Silence past the timeout counts as a drop; `close()` on a dead socket can
   * itself hang, so the socket is abandoned first and closed best-effort.
   */
  private startKeepalive(ws: WebSocket): void {
    this.stopKeepalive();
    this.lastHeardAt = Date.now();
    this.keepaliveTimer = setInterval(() => {
      if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) { this.stopKeepalive(); return; }
      if (Date.now() - this.lastHeardAt > KEEPALIVE_TIMEOUT_MS) {
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
    await this.connect();
    this.created = null;
    await this.request('room:create', options);
    if (!this.created) throw new StageError('internal', '伺服器未回傳房間資訊。');
    const result = this.created as ServerMessageMap['room:created'];
    this.session = { roomId: result.roomId, code: result.code, name: options.name };
    return result;
  }
  async join(options: { roomId: string; code?: string; name: string }): Promise<void> {
    await this.connect();
    await this.request('join', options);
    this.session = { ...options };
  }
  raiseHand(): Promise<void> {
    if (this.handCooldownMs > 0) return Promise.reject(new StageError('rate_limited', `每次舉手需間隔 ${Math.ceil(this.limits.handRaiseIntervalMs / 1000)} 秒。`));
    this.lastHandAt = Date.now();
    return this.request('hand:raise', {});
  }
  /** Send a chat message (≤ `limits.chatMaxLength` characters on the server; paced by `rateLimits.chatIntervalMs`). */
  sendChat(text: string): Promise<void> {
    if (Date.now() - this.lastChatAt < this.limits.chatIntervalMs) return Promise.reject(new StageError('rate_limited', '訊息傳送過快，請稍候。'));
    this.lastChatAt = Date.now();
    return this.request('chat:send', { text });
  }
  /** Send an emoji reaction from `REACTIONS`; paced by `rateLimits.reactionIntervalMs`. */
  react(emoji: Reaction): Promise<void> {
    if (Date.now() - this.lastReactionAt < this.limits.reactionIntervalMs) return Promise.reject(new StageError('rate_limited', '反應送出過快，請稍候。'));
    this.lastReactionAt = Date.now();
    return this.request('reaction', { emoji });
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
  /** Controller only, when `state.recordingAvailable`: record the room's mix on the server (`state.recording` turns true for everyone). */
  startRecording(): Promise<void> { return this.request('recording:start', {}); }
  stopRecording(): Promise<void> { return this.request('recording:stop', {}); }
  closeRoom(): Promise<void> { return this.request('room:close', {}); }
  async disconnect(): Promise<void> {
    this.intentional = true;
    ++this.testRevision;
    for (const test of this.micTests) test.stop();
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.session = null;
    this.snapshot = null;
    this.speakingIds = new Set();
    this.chatLog = [];
    this.stopKeepalive();
    this.socket?.close(1000);
    this.socket = null;
    this.rejectPending();
    this.destroyMedia();
    this.setStatus('disconnected');
    if (this.ownsAudio) this.audio.remove();
    window.removeEventListener('pagehide', this.onPageHide);
  }
  async unlockAudio(): Promise<void> { await this.audio.play(); }

  private request<K extends Exclude<ClientMessageType, 'ping'>>(type: K, payload: Omit<ClientMessageMap[K], 'requestId'>): Promise<void> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new StageError('disconnected', '尚未連線至舞台。'));
    const requestId = crypto.randomUUID();
    const now = Date.now();
    const ice = type === 'rtc:ice';
    // The server's buckets refill at the advertised rate; pacing at half (control) / two thirds (ICE)
    // of it leaves headroom for clock skew and for frames the page sends outside this client.
    const sendAt = Math.max(now, this.lastSendAt, ice ? this.nextIceAt : this.nextControlAt);
    this.lastSendAt = sendAt;
    if (ice) this.nextIceAt = sendAt + Math.ceil(1500 / this.limits.icePerSecond);
    else this.nextControlAt = sendAt + Math.ceil(2000 / this.limits.controlPerSecond);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new StageError('timeout', '請求逾時，請重試。'));
      }, REQUEST_TIMEOUT + sendAt - now);
      this.pending.set(requestId, { resolve, reject, timer });
      setTimeout(() => {
        if (!this.pending.has(requestId)) return;
        if (this.socket !== ws || ws.readyState !== WebSocket.OPEN) {
          this.finish(requestId, new StageError('disconnected', '連線已中斷。'));
          return;
        }
        ws.send(JSON.stringify({ type, ...payload, requestId }));
      }, sendAt - now);
    });
  }
  private finish(id: string, error?: StageError): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
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
        const error = new StageError(message.code, ERROR_MESSAGES[message.code] ?? message.message);
        if (message.requestId) this.finish(message.requestId, error);
        this.emit('error', error);
        break;
      }
      case 'room:created': this.created = { roomId: message.roomId, code: message.code }; this.emit('created', this.created); break;
      case 'room:state': {
        const { type: _, ...state } = message;
        const previousId = this.snapshot?.me.participantId;
        this.snapshot = state;
        if (this.session) this.session.resumeToken = state.resumeToken;
        this.reconnectAttempt = 0;
        this.setStatus(state.status);
        this.emit('state', state);
        for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !state.me.muted;
        // First snapshot of a (new) identity → fresh PeerConnection. A resumed seat keeps the one that
        // survived the ws drop unless the network side died meanwhile.
        const pcState = this.pc?.connectionState;
        if (!this.pc || previousId !== state.me.participantId || pcState === 'failed' || pcState === 'closed') this.createMedia();
        this.syncMedia();
        break;
      }
      case 'rtc:config': this.iceServers = message.iceServers; break;
      case 'rtc:answer': {
        const pc = this.pc;
        if (!pc || !this.answerWait) break;
        try {
          await pc.setRemoteDescription(message.payload);
          if (pc !== this.pc) break;
          for (const candidate of this.remoteIce.splice(0)) await pc.addIceCandidate(candidate ?? undefined);
          this.answerWait?.resolve();
        } catch (error) { if (pc === this.pc) this.answerWait?.reject(error instanceof Error ? error : new Error('無法套用音訊回應。')); }
        break;
      }
      case 'rtc:ice':
        if (!this.pc?.remoteDescription) this.remoteIce.push(message.payload);
        else await this.pc.addIceCandidate(message.payload ?? undefined);
        break;
      // Either way the seat is gone: forget the session so the socket close does not trigger a rejoin.
      case 'room:closed': case 'kicked':
        this.session = null;
        this.snapshot = null;
        this.speakingIds = new Set();
        this.chatLog = [];
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.destroyMedia();
        this.setStatus('disconnected');
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
      case 'chat': {
        const { type: _type, ...chat } = message;
        this.chatLog.push(chat);
        if (this.chatLog.length > MAX_CHAT_MESSAGES) this.chatLog.shift();
        this.emit('chat', chat);
        break;
      }
      case 'chat:history': this.chatLog = message.messages.slice(-MAX_CHAT_MESSAGES); this.emit('chathistory', { messages: this.chatLog }); break;
      case 'reaction': this.emit('reaction', { participantId: message.participantId, name: message.name, emoji: message.emoji }); break;
    }
  }
  private scheduleReconnect(): void {
    this.setStatus('reconnecting');
    const config = this.options.reconnect ?? { initialDelayMs: 500, maxDelayMs: 15000 };
    const delay = Math.min(config.maxDelayMs, config.initialDelayMs * 2 ** Math.min(this.reconnectAttempt++, 20));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      const session = this.session;
      if (!session || this.intentional) return;
      void (async () => {
        try {
          await this.connect();
          if (this.intentional || this.session !== session) return;
          await this.request('join', { ...session, resumeToken: this.snapshot?.resumeToken });
        } catch (error) {
          this.report(error);
          if (error instanceof StageError && ['unauthorized', 'not_found', 'room_full'].includes(error.code)) {
            await this.disconnect();
          } else if (!this.reconnectTimer && !this.intentional && this.session) {
            this.socket?.close();
            if (!this.socket) this.scheduleReconnect();
          }
        }
      })();
    }, delay);
  }
  private createMedia(): void {
    this.destroyMedia();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.transceiver = pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.onicecandidate = (event) => {
      if (this.pc !== pc) return;
      void this.request('rtc:ice', { payload: event.candidate?.toJSON() as IceCandidatePayload ?? null }).catch((error: unknown) => this.report(error));
    };
    pc.ontrack = (event) => {
      if (this.pc !== pc) return;
      this.audio.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      void this.audio.play().catch(() => this.emit('audioblocked', { message: '瀏覽器已阻擋自動播放，請點擊啟用音訊。' }));
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
    const revision = ++this.mediaRevision;
    this.mediaTask = this.mediaTask.catch(() => {}).then(async () => {
      const pc = this.pc;
      const transceiver = this.transceiver;
      const me = this.me;
      if (!pc || !transceiver || !me || revision !== this.mediaRevision) return;
      if (!me.onStage) this.micFailed = false;
      if (me.onStage && !this.mic && !this.micFailed) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: this.audioConstraints(this.inputDeviceId) });
          if (pc !== this.pc || !this.me?.onStage) { stream.getTracks().forEach((track) => track.stop()); return; }
          this.mic = stream;
          try { this.micMeter = createMicMeter(stream); }
          catch (error) { this.mic = null; stream.getTracks().forEach((track) => track.stop()); throw error; }
          this.emit('micready', undefined);
        } catch (error) {
          if (pc !== this.pc) return;
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
    }).catch((error: unknown) => this.report(error));
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
          // An offer whose answer never arrived (ws dropped mid-negotiation) must be rolled back first.
          if (pc.signalingState === 'have-local-offer') await pc.setLocalDescription({ type: 'rollback' });
          if (this.pc !== pc) return;
          const offer = await pc.createOffer();
          if (this.pc !== pc) return;
          offer.sdp = opusMonoSdp(offer.sdp ?? '');
          await pc.setLocalDescription(offer);
          if (this.pc !== pc) return;
          const answer = new Promise<void>((resolve, reject) => {
            this.answerWait = { resolve, reject };
            this.answerTimer = setTimeout(() => reject(new StageError('timeout', '音訊協商逾時。')), REQUEST_TIMEOUT);
          });
          await Promise.all([answer, this.request('rtc:offer', { payload: { type: 'offer', sdp: pc.localDescription!.sdp } })]);
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
    clearTimeout(this.iceRestartTimer);
    this.iceRestartTimer = undefined;
    this.pc?.close();
    this.pc = null;
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
    if (!this.pc) return result;
    const stats = await this.pc.getStats();
    let rtt: number | undefined;
    stats.forEach((entry) => { if (entry.type === 'candidate-pair' && entry.state === 'succeeded' && entry.nominated) rtt = entry.currentRoundTripTime; });
    stats.forEach((entry) => {
      if (!['inbound-rtp', 'outbound-rtp'].includes(entry.type) || (entry.kind ?? entry.mediaType) !== 'audio') return;
      const codec = stats.get(entry.codecId);
      const inbound = entry.type === 'inbound-rtp';
      const bytes = Number(inbound ? entry.bytesReceived : entry.bytesSent);
      const previous = this.previousStats.get(entry.id);
      const elapsed = previous ? entry.timestamp - previous.timestamp : 0;
      const remote = entry.remoteId ? stats.get(entry.remoteId) : undefined;
      const summary: AudioStats = { mimeType: codec?.mimeType, clockRate: codec?.clockRate, channels: codec?.channels, packetsLost: entry.packetsLost ?? remote?.packetsLost, jitter: entry.jitter ?? remote?.jitter, rtt: remote?.roundTripTime ?? rtt };
      if (previous && elapsed > 0) summary.bitrateKbps = Math.max(0, (bytes - previous.bytes) * 8 / elapsed);
      const received = Number(entry.packetsReceived ?? 0), lost = Number(entry.packetsLost ?? 0);
      if (inbound && previous && received + lost > previous.received + previous.lost) summary.lossPercent = 100 * Math.max(0, lost - previous.lost) / (received + lost - previous.received - previous.lost);
      if (!inbound && typeof remote?.fractionLost === 'number') summary.lossPercent = 100 * remote.fractionLost;
      const bufferDelay = Number(entry.jitterBufferDelay ?? 0), emitted = Number(entry.jitterBufferEmittedCount ?? 0);
      if (inbound && previous && emitted > previous.emitted) summary.bufferMs = 1000 * (bufferDelay - previous.bufferDelay) / (emitted - previous.emitted);
      this.previousStats.set(entry.id, { bytes, timestamp: entry.timestamp, received, lost, bufferDelay, emitted });
      if (inbound) result.inbound = summary; else result.outbound = summary;
    });
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
