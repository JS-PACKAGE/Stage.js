import { StageClient, decodeName, type ConnectionQuality, type StageEventMap } from './index.ts';

/** Every StageClient event, re-dispatched from the element as `stage-<type>`. */
const EVENTS: (keyof StageEventMap)[] = [
  'state', 'status', 'created', 'closed', 'kicked', 'hand', 'handrejected', 'invite', 'stagejoined', 'stageleft',
  'transferred', 'mic', 'role', 'error', 'micerror', 'micready', 'audioblocked', 'speaking', 'quality',
];
const STATUS_LABELS = { waiting: '等待發言', live: '直播中', reconnecting: '重新連線中', disconnected: '未連線' };

const STYLE = `
:host { display: block; font: inherit; color: var(--stage-fg, inherit); }
[part=panel] { display: grid; gap: .5rem; padding: .75rem; border: 1px solid var(--stage-border, #8884); border-radius: var(--stage-radius, .5rem); background: var(--stage-bg, transparent); }
[part=status] { margin: 0; }
[part=quality] { margin: 0; font-size: .875em; }
[part=speaking] { margin: 0; font-size: .875em; }
[part=hand-rejection] { margin: 0; }
[part=error] { margin: 0; color: var(--stage-error, #dc2626); }
[part=actions] { display: flex; flex-wrap: wrap; gap: .5rem; }
[part=name] { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
[part=name][hidden] { display: none; }
[part=room-name] { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
[part=room-name][hidden] { display: none; }
[part=hands][hidden] { display: none; }
[part=hands] ul { display: grid; gap: .5rem; padding-left: 1.25rem; }
[part=hands] li { overflow-wrap: anywhere; }
[part=hands] button { margin-left: .5rem; }
[part=playback] { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
[part=playback][hidden] { display: none; }
[part=microphone] { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
[part=microphone][hidden] { display: none; }
[part=microphone] p { flex-basis: 100%; margin: 0; font-size: .875em; }
[part=microphone] select { font: inherit; max-width: 100%; }
input[type=range] { flex: 1; min-width: 5rem; max-width: 12rem; }
button { font: inherit; padding: .4rem .8rem; border-radius: var(--stage-radius, .5rem); border: 1px solid var(--stage-border, #8884); background: var(--stage-button-bg, #fff1); color: inherit; cursor: pointer; }
button[hidden] { display: none; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--stage-accent, #2563eb); border-color: transparent; color: var(--stage-accent-fg, #fff); }
`;

/**
 * `<stage-client url room code name>`: a self-contained stage widget with controller hand moderation over StageClient.
 *
 * Joins when it is in the document and has `room` and `name`; leaves when removed. Changing
 * `url`, `room`, `code` or `name` rejoins, except after the user explicitly leaves: the same
 * element then waits for its manual rejoin button, including across attribute edits/remounts.
 * `url` defaults to `/ws` on the origin the library was
 * loaded from. The underlying client is exposed as `.client` for anything the widget does not
 * offer. `playback-muted` / `.playbackMuted` and `playback-volume` / `.playbackVolume`
 * control local listening without rejoining,
 * and every client event is re-dispatched from the element as `stage-<type>` (bubbling,
 * composed) with the same `detail`. The inline name draft starts from each new seat's name;
 * later snapshots update its accepted-name display, not the draft or the `name` attribute.
 * The controller's room-name draft follows the same rule while control is retained.
 * A controller can explicitly approve or reject the snapshot's hand requests; the server owns admission.
 * The microphone picker is an explicit draft, never an indicator of the actual capture device.
 * Style through `::part(panel|status|quality|speaking|hand-rejection|actions|name|room-name|hands|playback|microphone)` and the
 * `--stage-*` custom properties.
 */
export class StageElement extends HTMLElement {
  static readonly observedAttributes = ['url', 'room', 'code', 'name', 'playback-muted', 'playback-volume'];
  private current: StageClient | null = null;
  private readonly status: HTMLParagraphElement;
  private readonly quality: HTMLParagraphElement;
  private qualityOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private qualityReport: Omit<ConnectionQuality, 'participantId'> | undefined;
  private readonly speaking: HTMLParagraphElement;
  private speakingOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private speakingReport: { ids: Set<string>; empty: boolean } | undefined;
  private readonly handRejection: HTMLParagraphElement;
  private handRejectionOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  /** Last failure (request rejected, mic denied…); stays until dismissed, the next action or join. */
  private readonly error: HTMLParagraphElement;
  private readonly errorDismiss: HTMLButtonElement;
  private readonly namePanel: HTMLDivElement;
  private readonly acceptedName: HTMLSpanElement;
  private readonly nameInput: HTMLInputElement;
  private readonly nameUpdate: HTMLButtonElement;
  private nameOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private nameAttempt: object | undefined;
  private readonly roomNamePanel: HTMLDivElement;
  private readonly acceptedRoomName: HTMLSpanElement;
  private readonly roomNameInput: HTMLInputElement;
  private readonly roomNameUpdate: HTMLButtonElement;
  private roomNameOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private roomNameAttempt: object | undefined;
  private readonly handQueuePanel: HTMLDetailsElement;
  private readonly handQueueSummary: HTMLElement;
  private readonly handQueueNotice: HTMLParagraphElement;
  private readonly handQueueList: HTMLUListElement;
  private handQueueOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private readonly handQueuePending = new Map<string, object>();
  private readonly handQueueRows = new Map<string, { node: HTMLLIElement; name: HTMLSpanElement; approve: HTMLButtonElement; reject: HTMLButtonElement }>();
  private handQueueOrder: string[] = [];
  private readonly unlock: HTMLButtonElement;
  private playbackOwner: { client: StageClient; roomId: string; participantId: string; notice: number } | undefined;
  private unlockAttempt: object | undefined;
  private readonly hand: HTMLButtonElement;
  private readonly mic: HTMLButtonElement;
  private readonly micRetry: HTMLButtonElement;
  private micFailure: { client: StageClient; roomId: string; participantId: string; errorRevision: number; pending: boolean } | undefined;
  private readonly microphonePanel: HTMLDivElement;
  private readonly microphoneSelect: HTMLSelectElement;
  private readonly microphoneRefresh: HTMLButtonElement;
  private readonly microphoneApply: HTMLButtonElement;
  private microphoneOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private microphoneTerminalClient: StageClient | undefined;
  private refreshAttempt: object | undefined;
  private inputDeviceAttempt: object | undefined;
  private errorRevision = 0;
  private readonly leaveStage: HTMLButtonElement;
  private readonly roomAction: HTMLButtonElement;
  private leftRoom = false;
  private roomExit: object | undefined;
  private readonly listen: HTMLButtonElement;
  private readonly playback: HTMLDivElement;
  private readonly volume: HTMLInputElement;
  private readonly volumeValue: HTMLSpanElement;
  private readonly retry: HTMLButtonElement;
  private readonly cancelJoin: HTMLButtonElement;
  private cancelInitial: (() => Promise<void> | void) | undefined;
  private retryAvailable = false;
  private readonly pendingActions = new Set<HTMLButtonElement>();
  private cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  private cooldownDue = 0;
  /** Bumped on every (re)join, so a superseded join cannot touch the widget. */
  private generation = 0;
  private joinPhase: 'connecting' | 'joining' | undefined;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const panel = document.createElement('div');
    panel.part.add('panel');
    this.status = document.createElement('p');
    this.status.part.add('status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.quality = document.createElement('p');
    this.quality.part.add('quality');
    this.quality.hidden = true;
    this.speaking = document.createElement('p');
    this.speaking.part.add('speaking');
    this.speaking.hidden = true;
    this.handRejection = document.createElement('p');
    this.handRejection.part.add('hand-rejection');
    this.handRejection.setAttribute('role', 'status');
    this.handRejection.setAttribute('aria-live', 'polite');
    this.handRejection.hidden = true;
    this.error = document.createElement('p');
    this.error.part.add('error');
    this.error.setAttribute('role', 'alert');
    this.errorDismiss = document.createElement('button');
    this.errorDismiss.type = 'button'; this.errorDismiss.part.add('error-dismiss');
    this.errorDismiss.textContent = '關閉錯誤訊息';
    this.errorDismiss.onclick = () => {
      if (!this.isConnected || this.errorDismiss.hidden || this.error.hidden) return;
      this.hideError();
    };
    this.hideError();
    this.namePanel = document.createElement('div');
    this.namePanel.part.add('name');
    this.acceptedName = document.createElement('span');
    const nameLabel = document.createElement('label');
    nameLabel.textContent = '顯示名稱';
    nameLabel.setAttribute('for', 'participant-name');
    this.nameInput = document.createElement('input');
    this.nameInput.id = 'participant-name'; this.nameInput.type = 'text';
    this.nameUpdate = document.createElement('button');
    this.nameUpdate.type = 'button'; this.nameUpdate.textContent = '更新名稱';
    this.nameUpdate.onclick = () => this.updateName();
    this.namePanel.append(this.acceptedName, nameLabel, this.nameInput, this.nameUpdate);
    this.roomNamePanel = document.createElement('div');
    this.roomNamePanel.part.add('room-name');
    this.acceptedRoomName = document.createElement('span');
    const roomNameLabel = document.createElement('label');
    roomNameLabel.textContent = '房間名稱';
    roomNameLabel.setAttribute('for', 'room-name');
    this.roomNameInput = document.createElement('input');
    this.roomNameInput.id = 'room-name'; this.roomNameInput.type = 'text';
    this.roomNameUpdate = document.createElement('button');
    this.roomNameUpdate.type = 'button'; this.roomNameUpdate.textContent = '更新房間名稱';
    this.roomNameUpdate.onclick = () => this.updateRoomName();
    this.roomNamePanel.append(this.acceptedRoomName, roomNameLabel, this.roomNameInput, this.roomNameUpdate);
    this.handQueuePanel = document.createElement('details');
    this.handQueuePanel.part.add('hands');
    this.handQueueSummary = document.createElement('summary');
    this.handQueueNotice = document.createElement('p');
    this.handQueueList = document.createElement('ul');
    this.handQueuePanel.append(this.handQueueSummary, this.handQueueNotice, this.handQueueList);
    const actions = document.createElement('div');
    actions.part.add('actions');
    this.unlock = document.createElement('button');
    this.unlock.type = 'button'; this.unlock.className = 'primary'; this.unlock.textContent = '啟用音訊';
    this.unlock.onclick = () => this.unlockPlayback();
    this.unlock.hidden = true;
    this.hand = this.button('舉手發言', () => (this.current?.me?.handRaised ? this.current.withdrawHand() : this.current?.raiseHand()), '', () => this.canUseHand());
    this.mic = this.button('靜音', () => (this.current?.me?.muted ? this.current.unmute() : this.current?.mute()), '', () => this.canUseMic());
    // Capture admission is synchronous; its completion belongs to later mic events.
    this.micRetry = document.createElement('button');
    this.micRetry.type = 'button';
    this.micRetry.setAttribute('aria-label', '重試麥克風');
    this.micRetry.onclick = () => this.retryMic();
    this.microphonePanel = document.createElement('div');
    this.microphonePanel.part.add('microphone');
    const microphoneLabel = document.createElement('label');
    microphoneLabel.textContent = '麥克風選擇（草稿）';
    microphoneLabel.setAttribute('for', 'microphone-device');
    this.microphoneSelect = document.createElement('select');
    this.microphoneSelect.id = 'microphone-device';
    this.microphoneSelect.setAttribute('aria-describedby', 'microphone-draft-notice');
    this.microphoneRefresh = document.createElement('button');
    this.microphoneRefresh.type = 'button'; this.microphoneRefresh.textContent = '重新整理麥克風清單';
    this.microphoneRefresh.onclick = () => this.refreshMicrophones();
    this.microphoneApply = document.createElement('button');
    this.microphoneApply.type = 'button'; this.microphoneApply.textContent = '送出麥克風選擇';
    this.microphoneApply.onclick = () => this.applyMicrophone();
    const microphoneNotice = document.createElement('p');
    microphoneNotice.id = 'microphone-draft-notice';
    microphoneNotice.textContent = '草稿不代表目前實際擷取裝置；麥克風失敗後需另按「重試麥克風」。重新整理清單不會開啟麥克風；預設選項沿用 SDK 設定。';
    this.microphonePanel.append(microphoneLabel, this.microphoneSelect, this.microphoneRefresh, this.microphoneApply, microphoneNotice);
    this.leaveStage = this.button('離開舞台', () => {
      const client = this.current, me = client?.me;
      if (!client || !me || !this.canUseStage()) return;
      return me.onStage ? client.leaveStage() : client.returnToStage();
    }, '', () => this.canUseStage());
    this.roomAction = document.createElement('button');
    this.roomAction.type = 'button';
    this.roomAction.onclick = () => this.changeRoomPresence();
    this.listen = this.button('靜音收聽', () => { this.playbackMuted = !this.playbackMuted; });
    this.listen.setAttribute('aria-label', '靜音收聽');
    this.playback = document.createElement('div');
    this.playback.part.add('playback');
    const volumeLabel = document.createElement('label');
    volumeLabel.textContent = '收聽音量';
    volumeLabel.setAttribute('for', 'playback-volume');
    this.volume = document.createElement('input');
    this.volume.id = 'playback-volume'; this.volume.type = 'range';
    this.volume.min = '0'; this.volume.max = '100'; this.volume.step = '1';
    this.volumeValue = document.createElement('span');
    this.volumeValue.setAttribute('aria-hidden', 'true');
    this.volume.oninput = () => {
      if (!this.isConnected || !this.current?.me || this.volume.disabled) return;
      const value = this.volume.value.trim() ? Number(this.volume.value) : NaN;
      if (Number.isFinite(value) && value >= 0 && value <= 100) this.playbackVolume = value / 100;
      this.renderVolume();
    };
    this.playback.append(volumeLabel, this.volume, this.volumeValue);
    this.retry = this.button('重試加入', () => { if (this.canRetry()) this.rejoin(); });
    this.cancelJoin = this.button('取消加入', () => this.cancelInitial?.());
    actions.append(this.unlock, this.listen, this.hand, this.mic, this.micRetry, this.leaveStage, this.roomAction, this.retry, this.cancelJoin);
    panel.append(this.status, this.quality, this.speaking, this.handRejection, this.error, this.errorDismiss, this.namePanel, this.roomNamePanel, this.handQueuePanel, actions, this.microphonePanel, this.playback);
    root.append(style, panel);
    this.render();
  }

  /** The SDK instance; null before initialization or after room/element teardown, not a joined-state indicator. */
  get client(): StageClient | null { return this.current; }

  /** Local listening preference; reflected as a boolean attribute and retained across rejoins. */
  get playbackMuted(): boolean { return this.hasAttribute('playback-muted'); }
  set playbackMuted(value: boolean) { this.toggleAttribute('playback-muted', Boolean(value)); }

  /** Reflected local volume in [0, 1]; missing or invalid markup uses the default full volume. */
  get playbackVolume(): number {
    const raw = this.getAttribute('playback-volume')?.trim();
    const volume = raw ? Number(raw) : 1;
    return Number.isFinite(volume) && volume >= 0 && volume <= 1 ? volume : 1;
  }
  set playbackVolume(value: number) {
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('收聽音量必須是 0 到 1 之間的有限數值。');
    this.setAttribute('playback-volume', String(value));
  }

  connectedCallback(): void { if (this.leftRoom) this.render(); else this.rejoin(); }
  disconnectedCallback(): void { ++this.generation; void this.leave(); }
  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next) return;
    if (name === 'playback-volume') { this.current?.setPlaybackVolume(this.playbackVolume); this.renderVolume(); return; }
    if (name === 'playback-muted') { this.current?.setPlaybackMuted(this.playbackMuted); this.render(); return; }
    if (this.isConnected) { if (this.leftRoom) this.render(); else this.rejoin(); }
  }

  private button(label: string, action: () => Promise<unknown> | void, className = '', allowed?: () => boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (className) b.className = className;
    b.onclick = () => {
      // Forwarded SDK events may run host callbacks before the old controls are repainted.
      if (b.disabled || this.pendingActions.has(b) || (allowed && !allowed())) return;
      const generation = this.generation;
      this.pendingActions.add(b);
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
      this.hideError();
      // Invoke synchronously to retain the clicked client's identity, but catch synchronous
      // failures too. A later render must not unlock the action before its promise settles.
      void (async () => {
        try { await action(); }
        catch (error) { if (generation === this.generation) this.show(error); }
        finally {
          if (generation === this.generation) {
            this.pendingActions.delete(b);
            b.removeAttribute('aria-busy');
            this.render();
          }
        }
      })();
    };
    return b;
  }

  private rejoin(): void {
    const generation = ++this.generation;
    this.leftRoom = false; this.roomExit = undefined;
    void this.leave().then(async () => {
      const room = this.getAttribute('room')?.trim(), name = this.getAttribute('name')?.trim();
      if (generation !== this.generation || !this.isConnected || !room || !name) { this.render(); return; }
      const client = new StageClient({ url: this.wsUrl() });
      client.setPlaybackMuted(this.playbackMuted);
      client.setPlaybackVolume(this.playbackVolume);
      this.current = client;
      this.joinPhase = 'connecting';
      let receivedState = false;
      let terminal = false;
      let cancelled = false;
      this.cancelInitial = () => {
        if (generation !== this.generation || this.current !== client || !this.isConnected
          || !this.joinPhase || receivedState || terminal || client.state || client.status === 'reconnecting') return;
        cancelled = true;
        this.hideCancel();
        this.joinPhase = undefined;
        this.retryAvailable = true;
        this.status.textContent = '已取消加入。';
        this.render();
        return client.disconnect();
      };
      for (const type of EVENTS) {
        client.on(type, ({ detail }) => {
          if (generation !== this.generation || this.current !== client) return;
          if (type === 'closed' || type === 'kicked') this.microphoneTerminalClient = client;
          else if (type === 'state') this.microphoneTerminalClient = undefined;
          // Revoke picker admission before any forwarded callback can click an old control.
          this.syncMicrophoneOwner();
          const micLifecycle = type === 'state' || type === 'status' || type === 'micerror' || type === 'micready'
            || type === 'closed' || type === 'kicked';
          if (micLifecycle) this.syncMicRetry();
          if (type === 'state' || type === 'status' || type === 'closed' || type === 'kicked' || type === 'audioblocked') this.syncPlaybackOwner();
          if (type === 'state' || type === 'status' || type === 'closed' || type === 'kicked') this.syncNameOwner();
          if (type === 'state' || type === 'status' || type === 'closed' || type === 'kicked') this.syncRoomNameOwner();
          if (type === 'state' || type === 'status' || type === 'closed' || type === 'kicked') this.syncHandQueue();
          const ownId = client.me?.participantId;
          if (type === 'closed' || type === 'kicked'
            || (type === 'status' && (detail === 'reconnecting' || detail === 'disconnected'))
            || (type === 'hand' && (detail as StageEventMap['hand']).raised && (detail as StageEventMap['hand']).participantId === ownId)
            || (type === 'stagejoined' && (detail as StageEventMap['stagejoined']).participantId === ownId)
            || (type === 'role' && (detail as StageEventMap['role']).role !== 'audience' && (detail as StageEventMap['role']).participantId === ownId)
            || (type === 'transferred' && (detail as StageEventMap['transferred']).toId === ownId)) this.retireHandRejection();
          else this.syncHandRejection(type === 'handrejected' ? detail as StageEventMap['handrejected'] : undefined);
          if (type === 'closed' || type === 'kicked' || type === 'micerror'
            || (type === 'status' && (detail === 'reconnecting' || detail === 'disconnected'))
            || (type === 'stageleft' && (detail as StageEventMap['stageleft']).participantId === client.state?.me.participantId)) this.retireQualityOwner();
          else if (type === 'quality') this.syncQualityOwner((detail as StageEventMap['quality']).participants);
          else if (type === 'state' || type === 'status') this.syncQualityOwner();
          if (type === 'closed' || type === 'kicked'
            || (type === 'status' && (detail === 'reconnecting' || detail === 'disconnected'))) this.retireSpeakingOwner();
          else if (type === 'speaking') this.syncSpeakingOwner({ participantIds: (detail as StageEventMap['speaking'] | null | undefined)?.participantIds });
          else if (type === 'state' || type === 'status') this.syncSpeakingOwner();
          // SDK status precedes state; a forwarded status listener may disconnect immediately.
          if (type === 'state' || client.state) { receivedState = true; this.hideRetry(); this.hideCancel(); }
          if (type === 'closed' || type === 'kicked') { terminal = true; this.micFailure = undefined; this.hideRetry(); this.hideCancel(); }
          if (type === 'state' || type === 'closed' || type === 'kicked'
            || (type === 'status' && detail === 'disconnected')) this.joinPhase = undefined;
          if (type === 'audioblocked' && this.playbackOwner) { this.playbackOwner.notice++; this.unlock.hidden = false; this.unlock.disabled = Boolean(this.unlockAttempt); }
          if (type === 'status' && detail === 'disconnected') {
            this.hideCancel();
            this.status.textContent = cancelled && !receivedState && !terminal ? '已取消加入。' : STATUS_LABELS.disconnected;
          }
          if (type === 'closed') this.status.textContent = (detail as StageEventMap['closed']).reason === 'shutdown'
            ? '伺服器維護或重新啟動，房間已關閉。' : '房間已關閉。';
          if (type === 'kicked') this.status.textContent = '你已被主控移出房間。';
          if (type === 'error' || type === 'micerror') this.show(detail);
          if (type === 'micerror' && client.state && client.me?.onStage) {
            this.micFailure = { client, roomId: client.state.roomId, participantId: client.me.participantId,
              errorRevision: this.errorRevision, pending: false };
          }
          if (type === 'micready' && this.micFailure?.client === client) {
            // micready is shared with preview and precedes sender installation.
            if (this.micFailure.errorRevision === this.errorRevision) this.hideError();
            this.micFailure = undefined;
          }
          // Revoke stale action admission before application event listeners can reenter.
          if (micLifecycle) this.syncMicRetry();
          this.dispatchEvent(new CustomEvent(`stage-${type}`, { detail, bubbles: true, composed: true }));
          // Application callbacks may retire this seat or mutate its exposed snapshot.
          this.syncMicrophoneOwner();
          this.syncHandRejection();
          if (type === 'state' || type === 'status' || type === 'mic' || type === 'closed' || type === 'kicked') this.render();
        });
      }
      this.hideError();
      this.render();
      try {
        await client.connect();
        if (generation !== this.generation || this.current !== client || !this.isConnected || cancelled) return;
        if (this.joinPhase === 'connecting') this.joinPhase = 'joining';
        this.render();
        const code = this.getAttribute('code')?.trim();
        await client.join({ roomId: room, name, ...(code ? { code } : {}) });
      } catch (error) {
        if (generation === this.generation && this.current === client && !cancelled) {
          // A terminal room event or an accepted snapshot must never become a fresh-join prompt.
          this.retryAvailable = !receivedState && !terminal && !client.state;
          this.show(error);
          this.render();
        }
      } finally {
        if (generation === this.generation && this.current === client) this.hideCancel();
        // A snapshot or terminal event can already have replaced the progress message.
        if (generation === this.generation && this.current === client && this.joinPhase) {
          this.joinPhase = undefined;
          if (!client.state) this.status.textContent = STATUS_LABELS[client.status];
          this.render();
        }
      }
    });
  }

  private changeRoomPresence(): void {
    if (!this.isConnected || this.roomExit) return;
    if (this.leftRoom) {
      if (this.getAttribute('room')?.trim() && this.getAttribute('name')?.trim()) this.rejoin();
      return;
    }
    if (!this.current?.state || !this.current.me) return;
    ++this.generation;
    const exit = {};
    this.leftRoom = true; this.roomExit = exit;
    this.hideError();
    // Retire the event lane before disconnect can synchronously invoke application callbacks.
    void this.leave().catch(error => {
      if (this.roomExit === exit) this.show(error);
    }).finally(() => {
      if (this.roomExit !== exit) return;
      this.roomExit = undefined; this.render();
    });
  }

  private async leave(): Promise<void> {
    this.joinPhase = undefined;
    this.micFailure = undefined;
    this.microphoneTerminalClient = undefined;
    this.retireMicrophoneOwner();
    this.retireNameOwner();
    this.retireRoomNameOwner();
    this.retireHandQueue();
    this.retireQualityOwner();
    this.retireSpeakingOwner();
    this.retireHandRejection();
    this.hideCancel();
    this.hideRetry();
    for (const button of this.pendingActions) button.removeAttribute('aria-busy');
    this.pendingActions.clear();
    clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined; this.cooldownDue = 0;
    const client = this.current;
    this.current = null;
    this.unlock.hidden = true;
    this.render();
    await client?.disconnect();
  }

  private retireQualityOwner(): void {
    this.qualityOwner = undefined; this.qualityReport = undefined;
    this.quality.textContent = ''; this.quality.hidden = true;
  }

  private retireSpeakingOwner(): void {
    this.speakingOwner = undefined; this.speakingReport = undefined;
    this.speaking.textContent = ''; this.speaking.hidden = true;
  }

  private retireHandRejection(): void {
    this.handRejectionOwner = undefined;
    this.handRejection.textContent = ''; this.handRejection.hidden = true;
  }

  private syncHandRejection(rejection?: StageEventMap['handrejected']): void {
    const client = this.current, state = client?.state, me = client?.me;
    if (!this.isConnected || !client || !state || me?.role !== 'audience' || me.onStage || me.handRaised
      || (client.status !== 'waiting' && client.status !== 'live')) {
      this.retireHandRejection(); return;
    }
    const owner = this.handRejectionOwner;
    if (owner && (owner.client !== client || owner.generation !== this.generation
      || owner.roomId !== state.roomId || owner.participantId !== me.participantId)) this.retireHandRejection();
    // Only a targeted rejection establishes the notice; snapshots and withdrawals cannot infer one.
    if (rejection?.roomId === state.roomId && rejection.participantId === me.participantId) {
      this.handRejectionOwner = { client, roomId: state.roomId, participantId: me.participantId, generation: this.generation };
    }
    this.handRejection.hidden = !this.handRejectionOwner;
    const text = this.handRejectionOwner ? '主控已婉拒這次舉手申請。' : '';
    if (this.handRejection.textContent !== text) this.handRejection.textContent = text;
  }

  /** A resumed SDK getter can retain the old report; only a new event establishes this owner's set. */
  private syncSpeakingOwner(report?: { participantIds: unknown }): void {
    const client = this.current, state = client?.state, me = state?.me;
    if (!this.isConnected || !client || !state || !me
      || (client.status !== 'waiting' && client.status !== 'live')) {
      this.retireSpeakingOwner(); return;
    }
    const owner = this.speakingOwner;
    if (!owner || owner.client !== client || owner.generation !== this.generation
      || owner.roomId !== state.roomId || owner.participantId !== me.participantId) {
      this.retireSpeakingOwner();
      this.speakingOwner = { client, roomId: state.roomId, participantId: me.participantId, generation: this.generation };
    }
    if (report) {
      const ids = Array.isArray(report.participantIds) ? [...report.participantIds] : undefined;
      // Copy before forwarding the mutable event; malformed synthetic reports are not evidence of silence.
      this.speakingReport = ids?.every(id => typeof id === 'string') ? { ids: new Set(ids), empty: !ids.length } : undefined;
    }
    const current = this.speakingReport;
    this.speaking.hidden = false;
    if (!current) { this.speaking.textContent = '發言偵測：等待伺服器回報。'; return; }
    if (current.empty) { this.speaking.textContent = '最近收到的發言回報：未偵測到發言。'; return; }
    const seen = new Set<string>(), names: string[] = [];
    for (const person of state.speakers) {
      if (!person.onStage || (person.role !== 'speaker' && person.role !== 'controller')
        || !current.ids.has(person.participantId) || seen.has(person.participantId)) continue;
      seen.add(person.participantId);
      // Control-socket grace can retain media, so connected is deliberately not an eligibility test.
      names.push(decodeName(person.name));
    }
    // A later stage entry must not revive an ID from an earlier, unmatched or removed seat.
    current.ids = seen;
    this.speaking.textContent = names.length ? `最近收到的發言回報：${names.join('、')}（${names.length} 人）。`
      : '最近收到的發言回報：沒有可對應的台上成員。';
  }

  /** Reports have no timestamp or media epoch; only a new event may supply this seat's values. */
  private syncQualityOwner(reports?: readonly ConnectionQuality[]): void {
    const client = this.current, state = client?.state, me = state?.me;
    if (!this.isConnected || !client || !state || !me?.onStage
      || client.status === 'reconnecting' || client.status === 'disconnected') {
      this.retireQualityOwner(); return;
    }
    const owner = this.qualityOwner;
    if (!owner || owner.client !== client || owner.generation !== this.generation
      || owner.roomId !== state.roomId || owner.participantId !== me.participantId) {
      this.retireQualityOwner();
      this.qualityOwner = { client, roomId: state.roomId, participantId: me.participantId, generation: this.generation };
    }
    if (reports !== undefined) {
      let report: ConnectionQuality | undefined;
      for (const candidate of reports) if (candidate.participantId === me.participantId) report = candidate;
      // The event remains public and mutable; retain only primitive values from its full replacement set.
      this.qualityReport = report ? {
        uplinkLossPercent: typeof report.uplinkLossPercent === 'number' ? report.uplinkLossPercent : undefined,
        downlinkLossPercent: typeof report.downlinkLossPercent === 'number' ? report.downlinkLossPercent : undefined,
        rttMs: typeof report.rttMs === 'number' ? report.rttMs : undefined,
      } : undefined;
    }
    const report = this.qualityReport;
    this.quality.hidden = !report;
    if (!report) { this.quality.textContent = ''; return; }
    const percent = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? `${value.toFixed(1)}%` : '—';
    const rtt = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${Math.round(value)} ms` : '—';
    this.quality.textContent = `你的連線品質（最近收到）：上行掉包 ${percent(report.uplinkLossPercent)} · 下行掉包 ${percent(report.downlinkLossPercent)} · RTT ${rtt(report.rttMs)}（非端到端音訊延遲）`;
  }

  private retireNameOwner(): void {
    this.nameOwner = undefined; this.nameAttempt = undefined;
    this.nameInput.value = ''; this.acceptedName.textContent = '';
    this.namePanel.hidden = true;
    this.nameInput.disabled = this.nameUpdate.disabled = true;
    this.nameUpdate.removeAttribute('aria-busy');
  }

  private syncNameOwner(): void {
    const client = this.current, state = client?.state, me = client?.me;
    if (!this.isConnected || !client || !state || !me || client.status === 'disconnected') {
      this.retireNameOwner(); return;
    }
    const owner = this.nameOwner;
    if (!owner || owner.client !== client || owner.generation !== this.generation
      || owner.roomId !== state.roomId || owner.participantId !== me.participantId) {
      this.retireNameOwner();
      this.nameOwner = { client, roomId: state.roomId, participantId: me.participantId, generation: this.generation };
      this.nameInput.value = decodeName(me.name);
    }
    // A same-seat snapshot (including resume) must not replace an unsent or rejected draft.
    this.acceptedName.textContent = `目前名稱：${decodeName(me.name)}`;
    this.namePanel.hidden = false; this.nameInput.disabled = false;
    this.nameUpdate.disabled = client.status === 'reconnecting' || Boolean(this.nameAttempt);
    this.nameUpdate.setAttribute('aria-busy', String(Boolean(this.nameAttempt)));
  }

  private updateName(): void {
    this.syncNameOwner();
    const owner = this.nameOwner;
    if (!owner || this.namePanel.hidden || this.nameUpdate.hidden || this.nameUpdate.disabled || this.nameAttempt) return;
    const raw = this.nameInput.value;
    // Reserve before invoking the public SDK: a synchronous state callback may click again.
    const attempt = this.nameAttempt = {};
    this.syncNameOwner(); this.hideError();
    const current = () => {
      if (this.nameOwner !== owner || this.nameAttempt !== attempt) return false;
      // The public client can retire a snapshot without another status transition.
      this.syncNameOwner();
      return this.nameOwner === owner && this.nameAttempt === attempt;
    };
    void (async () => {
      try { await owner.client.setName(raw); }
      catch (error) { if (current()) this.show(error); }
      finally {
        if (current()) {
          this.nameAttempt = undefined;
          this.syncNameOwner();
        }
      }
    })();
  }

  private retireHandQueue(): void {
    this.handQueueOwner = undefined; this.handQueuePending.clear();
    for (const row of this.handQueueRows.values()) {
      for (const control of [row.approve, row.reject]) { control.disabled = true; control.setAttribute('aria-busy', 'false'); }
    }
    if (this.handQueueRows.size) this.handQueueList.replaceChildren();
    this.handQueueRows.clear(); this.handQueueOrder = [];
    this.handQueuePanel.hidden = true; this.handQueuePanel.open = false;
    this.handQueueSummary.textContent = ''; this.handQueueNotice.textContent = '';
  }

  private syncHandQueue(): void {
    const client = this.current, state = client?.state, me = client?.me;
    if (!this.isConnected || !client || !state || me?.role !== 'controller' || client.status === 'disconnected') {
      this.retireHandQueue(); return;
    }
    const owner = this.handQueueOwner;
    if (!owner || owner.client !== client || owner.generation !== this.generation
      || owner.roomId !== state.roomId || owner.participantId !== me.participantId) {
      this.retireHandQueue();
      this.handQueueOwner = { client, roomId: state.roomId, participantId: me.participantId, generation: this.generation };
    }
    const seen = new Set<string>();
    const people = state.hands.filter(person => {
      if (seen.has(person.participantId) || person.role !== 'audience' || !person.handRaised || person.onStage) return false;
      seen.add(person.participantId); return true;
    });
    const reconnecting = client.status === 'reconnecting';
    this.handQueuePanel.hidden = false;
    this.handQueueSummary.textContent = `舉手申請（${people.length}）${reconnecting ? ' · 上次收到' : ''}`;
    this.handQueueNotice.textContent = reconnecting ? '重新連線中，暫時不能處理申請。'
      : people.length ? '請選擇要核准上台或婉拒的申請；是否可上台仍由伺服器決定。' : '目前沒有舉手申請。';
    for (const person of people) {
      const id = person.participantId;
      let row = this.handQueueRows.get(id);
      if (!row) {
        const node = document.createElement('li'), name = document.createElement('span');
        const approve = document.createElement('button'), reject = document.createElement('button');
        approve.type = reject.type = 'button'; approve.textContent = '核准上台'; reject.textContent = '婉拒';
        row = { node, name, approve, reject };
        const currentRow = row;
        approve.onclick = () => this.moderateHand(id, currentRow.node, true);
        reject.onclick = () => this.moderateHand(id, currentRow.node, false);
        node.append(name, approve, reject); this.handQueueRows.set(id, row);
      }
      const name = decodeName(person.name);
      row.name.textContent = `${name}${person.connected ? '' : '（暫時離線）'}`;
      row.approve.setAttribute('aria-label', `核准 ${name} 上台`);
      row.reject.setAttribute('aria-label', `婉拒 ${name} 的舉手申請`);
      const pending = this.handQueuePending.has(id);
      for (const control of [row.approve, row.reject]) {
        control.disabled = reconnecting || pending; control.setAttribute('aria-busy', String(pending));
      }
    }
    for (const [id, row] of this.handQueueRows) if (!seen.has(id)) {
      for (const control of [row.approve, row.reject]) { control.disabled = true; control.setAttribute('aria-busy', 'false'); }
      this.handQueueRows.delete(id);
    }
    const order = people.map(person => person.participantId);
    if (order.length !== this.handQueueOrder.length || order.some((id, index) => id !== this.handQueueOrder[index])) {
      this.handQueueList.replaceChildren(...order.map(id => this.handQueueRows.get(id)!.node));
      this.handQueueOrder = order;
    }
  }

  private moderateHand(id: string, node: HTMLLIElement, approve: boolean): void {
    this.syncHandQueue();
    const owner = this.handQueueOwner, row = this.handQueueRows.get(id);
    if (!owner || !row || row.node !== node || this.handQueuePanel.hidden
      || owner.client.status === 'reconnecting' || this.handQueuePending.has(id)) return;
    const attempt = {};
    this.handQueuePending.set(id, attempt); this.syncHandQueue(); this.hideError();
    const current = (): boolean => {
      if (this.handQueueOwner !== owner || this.handQueuePending.get(id) !== attempt) return false;
      this.syncHandQueue();
      return this.handQueueOwner === owner && this.handQueuePending.get(id) === attempt;
    };
    void (async () => {
      try { await (approve ? owner.client.approve(id) : owner.client.reject(id)); }
      catch (error) { if (current()) this.show(error); }
      finally { if (current()) { this.handQueuePending.delete(id); this.syncHandQueue(); } }
    })();
  }

  private retireRoomNameOwner(): void {
    this.roomNameOwner = undefined; this.roomNameAttempt = undefined;
    this.roomNameInput.value = ''; this.acceptedRoomName.textContent = '';
    this.roomNamePanel.hidden = true;
    this.roomNameInput.disabled = this.roomNameUpdate.disabled = true;
    this.roomNameUpdate.removeAttribute('aria-busy');
  }

  private syncRoomNameOwner(): void {
    const client = this.current, state = client?.state, me = client?.me;
    if (!this.isConnected || !client || !state || me?.role !== 'controller' || client.status === 'disconnected') {
      this.retireRoomNameOwner(); return;
    }
    const owner = this.roomNameOwner;
    if (!owner || owner.client !== client || owner.generation !== this.generation
      || owner.roomId !== state.roomId || owner.participantId !== me.participantId) {
      this.retireRoomNameOwner();
      this.roomNameOwner = { client, roomId: state.roomId, participantId: me.participantId, generation: this.generation };
      this.roomNameInput.value = decodeName(state.name);
    }
    // Same-controller snapshots and reconnects update the accepted value, never the draft.
    this.acceptedRoomName.textContent = `目前房間名稱：${decodeName(state.name)}`;
    this.roomNamePanel.hidden = false; this.roomNameInput.disabled = false;
    this.roomNameUpdate.disabled = client.status === 'reconnecting' || Boolean(this.roomNameAttempt);
    this.roomNameUpdate.setAttribute('aria-busy', String(Boolean(this.roomNameAttempt)));
  }

  private updateRoomName(): void {
    this.syncRoomNameOwner();
    const owner = this.roomNameOwner;
    if (!owner || this.roomNamePanel.hidden || this.roomNameUpdate.hidden || this.roomNameUpdate.disabled || this.roomNameAttempt) return;
    const raw = this.roomNameInput.value;
    // Reserve before public SDK callbacks can synchronously reenter the controller editor.
    const attempt = this.roomNameAttempt = {};
    this.syncRoomNameOwner(); this.hideError();
    const current = () => {
      if (this.roomNameOwner !== owner || this.roomNameAttempt !== attempt) return false;
      // Recheck control and seat identity even when no further lifecycle event was emitted.
      this.syncRoomNameOwner();
      return this.roomNameOwner === owner && this.roomNameAttempt === attempt;
    };
    void (async () => {
      try { await owner.client.setRoomName(raw); }
      catch (error) { if (current()) this.show(error); }
      finally {
        if (current()) {
          this.roomNameAttempt = undefined;
          this.syncRoomNameOwner();
        }
      }
    })();
  }

  /** Signaling reconnect retains the seat/audio; explicit disconnect retires both synchronously. */
  private syncPlaybackOwner(): void {
    const client = this.current, state = client?.state, me = client?.me;
    const owner = this.playbackOwner;
    if (this.isConnected && client && state && me && owner?.client === client
      && owner.roomId === state.roomId && owner.participantId === me.participantId) return;
    this.playbackOwner = this.isConnected && client && state && me
      ? { client, roomId: state.roomId, participantId: me.participantId, notice: 0 } : undefined;
    this.unlockAttempt = undefined;
    this.pendingActions.delete(this.unlock); this.unlock.removeAttribute('aria-busy');
    this.unlock.hidden = this.unlock.disabled = true;
  }

  private unlockPlayback(): void {
    this.syncPlaybackOwner();
    const owner = this.playbackOwner;
    if (!owner || this.unlock.hidden || this.unlock.disabled || this.unlockAttempt) return;
    const attempt = this.unlockAttempt = {};
    const notice = owner.notice;
    this.pendingActions.add(this.unlock); this.unlock.disabled = true;
    this.unlock.setAttribute('aria-busy', 'true'); this.hideError();
    const current = () => this.playbackOwner === owner && this.unlockAttempt === attempt;
    // Invoke before the first await so browser gesture admission remains synchronous.
    void (async () => {
      try {
        await owner.client.unlockAudio();
        if (current() && owner.notice === notice) this.unlock.hidden = true;
      } catch (error) { if (current()) this.show(error); }
      finally {
        if (current()) {
          this.unlockAttempt = undefined; this.pendingActions.delete(this.unlock);
          this.unlock.removeAttribute('aria-busy'); this.render();
        }
      }
    })();
  }

  private hideCancel(): void {
    this.cancelInitial = undefined;
    this.cancelJoin.hidden = true;
    this.cancelJoin.disabled = true;
  }

  private hideRetry(): void {
    this.retryAvailable = false;
    // Revoke native click admission before forwarding events that can synchronously invoke it.
    this.retry.hidden = true;
    this.retry.disabled = true;
  }

  private canRetry(): boolean {
    return this.isConnected && Boolean(this.current) && this.retryAvailable && !this.joinPhase
      && !this.current?.state && this.current?.status !== 'reconnecting';
  }

  private replaceMicrophoneOptions(inputs: readonly MediaDeviceInfo[], draft: string): void {
    const initial = document.createElement('option');
    initial.value = ''; initial.textContent = '預設（依 SDK 設定）';
    const options = [initial], seen = new Set<string>(['']);
    for (const device of inputs) {
      // Empty IDs cannot identify a choice. The empty draft always retains SDK default semantics.
      if (device.kind !== 'audioinput' || !device.deviceId || seen.has(device.deviceId)) continue;
      seen.add(device.deviceId);
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label.trim() ? device.label : `麥克風 ${options.length}`;
      options.push(option);
    }
    if (draft && !seen.has(draft)) {
      // Enumeration can omit a still-wanted device. Preserve the draft without exposing its ID.
      const unavailable = document.createElement('option');
      unavailable.value = draft; unavailable.textContent = '先前選擇（目前清單未提供）';
      unavailable.disabled = true; options.push(unavailable);
    }
    this.microphoneSelect.replaceChildren(...options);
    this.microphoneSelect.value = draft;
  }

  private retireMicrophoneOwner(): void {
    if (this.microphoneOwner || this.microphoneSelect.children.length !== 1 || this.microphoneSelect.value !== '') {
      this.replaceMicrophoneOptions([], '');
    }
    this.microphoneOwner = undefined;
    this.refreshAttempt = this.inputDeviceAttempt = undefined;
    this.microphonePanel.hidden = true;
    this.microphoneSelect.disabled = this.microphoneRefresh.disabled = this.microphoneApply.disabled = true;
    this.microphoneRefresh.removeAttribute('aria-busy'); this.microphoneApply.removeAttribute('aria-busy');
  }

  private syncMicrophoneOwner(): void {
    const client = this.current, state = client?.state, me = client?.me;
    const active = client?.status === 'waiting' || client?.status === 'live';
    if (!this.isConnected || !client || !state || !me || this.microphoneTerminalClient === client
      || (!active && client.status !== 'reconnecting')) {
      this.retireMicrophoneOwner(); return;
    }
    const owner = this.microphoneOwner;
    if (!owner || owner.client !== client || owner.generation !== this.generation
      || owner.roomId !== state.roomId || owner.participantId !== me.participantId) {
      this.retireMicrophoneOwner();
      // Reconnect may retain an existing owner, but cannot establish a different joined seat.
      if (!active) return;
      this.microphoneOwner = { client, roomId: state.roomId, participantId: me.participantId, generation: this.generation };
    }
    // Same-seat stage transitions never imply a new capture epoch or replace the unsent draft.
    this.microphonePanel.hidden = false;
    const blocked = !active || Boolean(this.refreshAttempt || this.inputDeviceAttempt);
    this.microphoneSelect.disabled = this.microphoneRefresh.disabled = this.microphoneApply.disabled = blocked;
    this.microphoneRefresh.setAttribute('aria-busy', String(Boolean(this.refreshAttempt)));
    this.microphoneApply.setAttribute('aria-busy', String(Boolean(this.inputDeviceAttempt)));
  }

  private refreshMicrophones(): void {
    this.syncMicrophoneOwner();
    const owner = this.microphoneOwner;
    if (!owner || this.microphonePanel.hidden || this.microphoneRefresh.hidden || this.microphoneRefresh.disabled
      || this.refreshAttempt || this.inputDeviceAttempt) return;
    // Reserve before the public SDK can synchronously emit or invoke application callbacks.
    const attempt = this.refreshAttempt = {};
    this.syncMicrophoneOwner(); this.hideError();
    const current = () => {
      if (this.microphoneOwner !== owner || this.refreshAttempt !== attempt) return false;
      this.syncMicrophoneOwner();
      return this.microphoneOwner === owner && this.refreshAttempt === attempt;
    };
    void (async () => {
      try {
        const devices = await owner.client.listAudioDevices();
        if (current()) this.replaceMicrophoneOptions(devices.inputs, this.microphoneSelect.value);
      } catch (error) { if (current()) this.show(error); }
      finally { if (current()) { this.refreshAttempt = undefined; this.syncMicrophoneOwner(); } }
    })();
  }

  private applyMicrophone(): void {
    this.syncMicrophoneOwner();
    const owner = this.microphoneOwner;
    if (!owner || this.microphonePanel.hidden || this.microphoneApply.hidden || this.microphoneApply.disabled
      || this.refreshAttempt || this.inputDeviceAttempt) return;
    const draft = this.microphoneSelect.value;
    const attempt = this.inputDeviceAttempt = {};
    this.syncMicrophoneOwner(); this.hideError();
    const current = () => {
      if (this.microphoneOwner !== owner || this.inputDeviceAttempt !== attempt) return false;
      this.syncMicrophoneOwner();
      return this.microphoneOwner === owner && this.inputDeviceAttempt === attempt;
    };
    void (async () => {
      try { await owner.client.setInputDevice(draft); }
      catch (error) { if (current()) this.show(error); }
      finally {
        if (current()) {
          // Fulfillment can be a stage-transition no-op. Neither it nor shared micready proves capture.
          this.inputDeviceAttempt = undefined; this.syncMicrophoneOwner();
        }
      }
    })();
  }

  private syncMicRetry(): void {
    const failure = this.micFailure, client = this.current, me = client?.me;
    if (failure && (failure.client !== client || failure.roomId !== client?.state?.roomId
      || failure.participantId !== me?.participantId || !me?.onStage)) this.micFailure = undefined;
    const current = this.micFailure;
    this.micRetry.hidden = !current;
    this.micRetry.disabled = !this.isConnected || !current || current.pending || client?.status !== 'live';
    this.micRetry.setAttribute('aria-busy', String(Boolean(current?.pending)));
    this.micRetry.textContent = current?.pending ? '正在要求麥克風…' : '重試麥克風';
  }

  private retryMic(): void {
    this.syncMicRetry();
    const failure = this.micFailure;
    if (this.micRetry.disabled || !failure) return;
    const errorRevision = this.errorRevision;
    const attempt = { ...failure, pending: true };
    this.micFailure = attempt; this.syncMicRetry();
    try {
      const admitted = failure.client.retryMicrophone();
      if (this.micFailure !== attempt) return;
      if (!admitted) this.micFailure = failure;
      else if (failure.errorRevision === this.errorRevision) this.hideError();
    } catch (error) {
      if (this.micFailure === attempt) {
        this.micFailure = failure;
        if (errorRevision === this.errorRevision) {
          this.show(error);
          this.micFailure = { ...failure, errorRevision: this.errorRevision };
        }
      }
    } finally { this.syncMicRetry(); }
  }

  private renderVolume(): void {
    const percent = Math.round(this.playbackVolume * 100);
    this.volume.value = String(percent);
    this.volume.setAttribute('aria-valuetext', `${percent}%`);
    this.volumeValue.textContent = `${percent}%`;
  }

  private canUseHand(): boolean {
    const client = this.current, me = client?.me;
    return this.isConnected && Boolean(me && !me.onStage && me.role !== 'controller'
      && client!.status !== 'reconnecting' && client!.status !== 'disconnected'
      && (me.handRaised || client!.handCooldownMs <= 0));
  }

  private canUseMic(): boolean {
    const client = this.current, me = client?.me;
    return this.isConnected && Boolean(me?.onStage && !me.forceMuted
      && client!.status !== 'reconnecting' && client!.status !== 'disconnected');
  }

  private canUseStage(): boolean {
    const client = this.current, me = client?.me;
    // Initial entry can retain a snapshot after socket loss before its join ACK.
    return this.isConnected && Boolean(me && (me.onStage || me.role === 'controller')
      && client!.status !== 'reconnecting' && client!.status !== 'disconnected');
  }

  private wsUrl(): string {
    const explicit = this.getAttribute('url');
    if (explicit) return explicit;
    // Resolved at runtime: the server that served this module also serves `/ws`.
    const ws = new URL(/* @vite-ignore */ '/ws', import.meta.url);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
    return ws.href;
  }

  private hideError(): void {
    this.error.hidden = true; this.errorDismiss.hidden = this.errorDismiss.disabled = true;
  }

  private show(error: unknown): void {
    this.errorRevision++;
    // StageError / Error, or a `micerror` detail ({name, message}).
    const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '操作失敗。';
    this.error.textContent = message;
    this.error.hidden = false; this.errorDismiss.hidden = this.errorDismiss.disabled = false;
  }

  /** Only a visible countdown needs clock-driven renders; other changes arrive as SDK events. */
  private scheduleCooldown(active: boolean, remaining: number): void {
    if (!active) {
      clearTimeout(this.cooldownTimer);
      this.cooldownTimer = undefined; this.cooldownDue = 0;
    } else {
      // A changed hello limit may move the next boundary earlier; never postpone an existing wake.
      const delay = Math.max(1, Math.ceil(remaining - (Math.ceil(remaining / 1000) - 1) * 1000));
      const due = performance.now() + delay;
      if (this.cooldownTimer !== undefined && this.cooldownDue <= due) return;
      clearTimeout(this.cooldownTimer);
      const timer = setTimeout(() => {
        if (this.cooldownTimer !== timer) return;
        this.cooldownTimer = undefined; this.cooldownDue = 0;
        this.render();
      }, delay);
      this.cooldownTimer = timer; this.cooldownDue = due;
    }
  }

  private render(): void {
    this.syncPlaybackOwner();
    this.syncMicRetry();
    this.syncMicrophoneOwner();
    this.syncNameOwner();
    this.syncRoomNameOwner();
    this.syncHandQueue();
    this.syncQualityOwner();
    this.syncSpeakingOwner();
    this.syncHandRejection();
    const client = this.current;
    const me = client?.me ?? null;
    const state = client?.state ?? null;
    if (state && me) {
      const handIndex = !me.onStage && me.role !== 'controller' && me.handRaised
        ? state.hands.findIndex(person => person.participantId === me.participantId) : -1;
      const raised = handIndex < 0 ? '已舉手'
        : `已舉手（${client!.status === 'reconnecting' ? '上次' : ''}佇列第 ${handIndex + 1} 位）`;
      const where = me.onStage ? (me.forceMuted ? '台上（主控已鎖定靜音）' : me.muted ? '台上（已靜音）' : '台上') : me.handRaised ? raised : '收聽中';
      this.status.textContent = `${decodeName(state.name)} · ${STATUS_LABELS[client!.status]} · ${where}`;
    } else if (this.joinPhase) {
      this.status.textContent = this.joinPhase === 'connecting' ? '連線中…' : '正在加入房間…';
    } else if (!client) {
      this.status.textContent = this.leftRoom ? '已離開房間。'
        : this.getAttribute('room') && this.getAttribute('name') ? '' : '請設定 room 與 name 屬性。';
    }
    this.roomAction.hidden = !me && !this.leftRoom;
    this.roomAction.textContent = this.leftRoom ? '重新加入' : '離開房間';
    this.roomAction.disabled = !this.isConnected || this.roomAction.hidden || Boolean(this.roomExit)
      || (this.leftRoom && (!this.getAttribute('room')?.trim() || !this.getAttribute('name')?.trim()));
    this.roomAction.setAttribute('aria-busy', String(Boolean(this.roomExit)));
    const reconnecting = client?.status === 'reconnecting';
    this.cancelJoin.hidden = !this.cancelInitial || !this.joinPhase || Boolean(state) || Boolean(reconnecting);
    this.cancelJoin.disabled = this.cancelJoin.hidden || this.pendingActions.has(this.cancelJoin);
    this.retry.hidden = !this.canRetry();
    this.retry.disabled = this.retry.hidden || this.pendingActions.has(this.retry);
    const audience = Boolean(me && !me.onStage && me.role !== 'controller');
    const remaining = client?.handCooldownMs ?? 0;
    const cooldown = Math.ceil(remaining / 1000);
    this.scheduleCooldown(audience && !me?.handRaised && remaining > 0, remaining);
    this.hand.hidden = !audience;
    this.listen.hidden = !me;
    this.listen.disabled = !client || this.pendingActions.has(this.listen);
    this.listen.textContent = this.playbackMuted ? '恢復收聽' : '靜音收聽';
    this.listen.setAttribute('aria-pressed', String(this.playbackMuted));
    this.playback.hidden = !me;
    this.volume.disabled = !client || !me;
    this.renderVolume();
    this.unlock.disabled = !this.playbackOwner || Boolean(this.unlockAttempt);
    this.hand.disabled = !this.canUseHand() || this.pendingActions.has(this.hand);
    this.hand.textContent = me?.handRaised ? '收回舉手' : cooldown > 0 ? `舉手發言（${cooldown} 秒）` : '舉手發言';
    this.mic.hidden = !me?.onStage;
    this.leaveStage.hidden = !me || (!me.onStage && me.role !== 'controller');
    this.mic.disabled = !this.canUseMic() || this.pendingActions.has(this.mic);
    this.mic.textContent = me?.forceMuted ? '麥克風已被主控靜音' : me?.muted ? '取消靜音' : '靜音';
    this.mic.setAttribute('aria-pressed', String(Boolean(me?.muted)));
    this.leaveStage.textContent = me?.onStage ? '離開舞台' : '返回舞台';
    this.leaveStage.disabled = !this.canUseStage() || this.pendingActions.has(this.leaveStage);
  }
}

/** Registers the element (default tag `stage-client`); a no-op when the tag is already defined. */
export function defineStageElement(tagName = 'stage-client'): void {
  if (customElements.get(tagName)) return;
  // A registry can use each constructor only once. Aliases inherit the complete widget
  // while the default registration keeps the exported StageElement constructor.
  customElements.define(tagName, tagName === 'stage-client' ? StageElement : class extends StageElement {});
}
