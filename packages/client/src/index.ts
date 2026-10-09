import type { ClientMessageMap, ClientMessageType, ErrorCode, IceCandidatePayload, ParticipantView, RoomStatePayload, ServerMessage, ServerMessageMap } from '../../../shared/protocol.ts';
export type { ParticipantView, RoomStatePayload, Role, StageStatus, ErrorCode, IceServerConfig } from '../../../shared/protocol.ts';

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
}
export interface StageStats { inbound: AudioStats | null; outbound: AudioStats | null }
export interface StageEventMap {
  state: RoomStatePayload;
  status: ClientStatus;
  created: ServerMessageMap['room:created'];
  closed: ServerMessageMap['room:closed'];
  hand: { participantId: string; raised: boolean };
  invite: ServerMessageMap['stage:invite'];
  stagejoined: ServerMessageMap['stage:joined'];
  stageleft: ServerMessageMap['stage:left'];
  transferred: ServerMessageMap['control:transferred'];
  mic: { participantId: string; muted: boolean };
  role: ServerMessageMap['role:update'];
  error: StageError;
  micerror: { name: string; message: string };
  audioblocked: { message: string };
  /** Full set of participants currently audible in the mix; fired only when it changes. */
  speaking: { participantIds: string[] };
}
interface Pending { resolve: () => void; reject: (error: StageError) => void; timer: ReturnType<typeof setTimeout> }
type JoinOptions = { roomId: string; code?: string; name: string; resumeToken?: string };
const REQUEST_TIMEOUT = 15000;

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
  private remoteIce: (IceCandidatePayload | null)[] = [];
  private mediaRevision = 0;
  private mediaTask: Promise<void> = Promise.resolve();
  private negotiationDirty = false;
  private negotiating = false;
  private answerWait: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private answerTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHandAt = -Infinity;
  private nextControlAt = 0;
  private nextIceAt = 0;
  /** Latest scheduled send of any kind: the server processes frames in arrival order, so ICE must never overtake its offer. */
  private lastSendAt = 0;
  private previousStats = new Map<string, { bytes: number; timestamp: number }>();
  private speakingIds: ReadonlySet<string> = new Set();

  constructor(options: StageClientOptions) {
    super();
    this.options = options;
    this.ownsAudio = !options.audioElement;
    this.audio = options.audioElement ?? document.createElement('audio');
    this.audio.autoplay = true;
    if (this.ownsAudio) { this.audio.hidden = true; document.body.append(this.audio); }
  }
  get state(): RoomStatePayload | null { return this.snapshot; }
  get status(): ClientStatus { return this.currentStatus; }
  get me(): ParticipantView | null { return this.snapshot?.me ?? null; }
  /** Participants currently audible in the mix (server voice activity). */
  get speaking(): ReadonlySet<string> { return this.speakingIds; }
  get handCooldownMs(): number { return Math.max(0, 10000 - (Date.now() - this.lastHandAt)); }
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
    const promise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.options.url);
      this.socket = ws;
      let ready = false;
      const timer = setTimeout(() => { reject(new StageError('timeout', '連線逾時，請稍後再試。')); ws.close(); }, REQUEST_TIMEOUT);
      ws.onmessage = (event) => {
        if (this.socket !== ws) return;
        try {
          const message = JSON.parse(String(event.data)) as ServerMessage;
          if (message.type === 'hello') { ready = true; clearTimeout(timer); resolve(); }
          void this.receive(message).catch((error: unknown) => this.report(error));
        } catch { this.report(new StageError('bad_request', '收到無法解析的伺服器訊息。')); }
      };
      ws.onerror = () => { if (!ready) reject(new StageError('disconnected', '無法連線至舞台。')); };
      ws.onclose = () => {
        clearTimeout(timer);
        if (!ready) reject(new StageError('disconnected', '連線已中斷。'));
        if (this.socket !== ws) return;
        this.socket = null;
        this.rejectPending();
        this.destroyMedia();
        if (!this.intentional && this.session) this.scheduleReconnect();
        else this.setStatus('disconnected');
      };
    });
    this.connecting = promise;
    void promise.finally(() => { if (this.connecting === promise) this.connecting = null; }).catch(() => {});
    return promise;
  }
  async createRoom(options: { name: string; roomName?: string; codeRequired?: boolean }): Promise<{ roomId: string; code?: string }> {
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
    if (this.handCooldownMs > 0) return Promise.reject(new StageError('rate_limited', '每次舉手需間隔 10 秒。'));
    this.lastHandAt = Date.now();
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
  closeRoom(): Promise<void> { return this.request('room:close', {}); }
  async disconnect(): Promise<void> {
    this.intentional = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.session = null;
    this.snapshot = null;
    this.speakingIds = new Set();
    this.socket?.close(1000);
    this.socket = null;
    this.rejectPending();
    this.destroyMedia();
    this.setStatus('disconnected');
    if (this.ownsAudio) this.audio.remove();
  }
  async unlockAudio(): Promise<void> { await this.audio.play(); }

  private request<K extends Exclude<ClientMessageType, 'ping'>>(type: K, payload: Omit<ClientMessageMap[K], 'requestId'>): Promise<void> {
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new StageError('disconnected', '尚未連線至舞台。'));
    const requestId = crypto.randomUUID();
    const now = Date.now();
    const ice = type === 'rtc:ice';
    const sendAt = Math.max(now, this.lastSendAt, ice ? this.nextIceAt : this.nextControlAt);
    this.lastSendAt = sendAt;
    if (ice) this.nextIceAt = sendAt + 50;
    else this.nextControlAt = sendAt + 100;
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
        const error = new StageError(message.code, message.message);
        if (message.requestId) this.finish(message.requestId, error);
        this.emit('error', error);
        break;
      }
      case 'room:created': this.created = { roomId: message.roomId, code: message.code }; this.emit('created', this.created); break;
      case 'room:state': {
        const { type: _, ...state } = message;
        this.snapshot = state;
        if (this.session) this.session.resumeToken = state.resumeToken;
        this.reconnectAttempt = 0;
        this.setStatus(state.status);
        this.emit('state', state);
        for (const track of this.mic?.getAudioTracks() ?? []) track.enabled = !state.me.muted;
        this.syncMedia();
        break;
      }
      case 'rtc:config': this.createMedia(message.iceServers); break;
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
      case 'room:closed':
        this.session = null;
        this.snapshot = null;
        this.speakingIds = new Set();
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.destroyMedia();
        this.setStatus('disconnected');
        this.emit('closed', { roomId: message.roomId });
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
  private createMedia(iceServers: RTCIceServer[]): void {
    this.destroyMedia();
    const pc = new RTCPeerConnection({ iceServers });
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
      if (this.pc === pc && pc.connectionState === 'failed') {
        pc.restartIce();
        this.negotiate();
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
          const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, sampleRate: 48000, echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...this.options.micConstraints } });
          if (pc !== this.pc || !this.me?.onStage) { stream.getTracks().forEach((track) => track.stop()); return; }
          this.mic = stream;
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
      if (!current.onStage) { this.mic?.getTracks().forEach((track) => track.stop()); this.mic = null; }
      const track = this.mic?.getAudioTracks()[0] ?? null;
      if (track) track.enabled = !current.muted;
      const direction = current.onStage && track ? 'sendrecv' : 'recvonly';
      const changed = transceiver.direction !== direction || transceiver.sender.track !== track;
      await transceiver.sender.replaceTrack(track);
      if (pc !== this.pc) return;
      transceiver.direction = direction;
      if (changed || !pc.localDescription) this.negotiate();
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
    this.pc?.close();
    this.pc = null;
    this.transceiver = null;
    this.mic?.getTracks().forEach((track) => track.stop());
    this.mic = null;
    this.micFailed = false;
    this.mediaTask = Promise.resolve();
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
      this.previousStats.set(entry.id, { bytes, timestamp: entry.timestamp });
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
