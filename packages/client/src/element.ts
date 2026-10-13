import { StageClient, decodeName, type StageEventMap } from './index.ts';

/** Every StageClient event, re-dispatched from the element as `stage-<type>`. */
const EVENTS: (keyof StageEventMap)[] = [
  'state', 'status', 'created', 'closed', 'kicked', 'hand', 'invite', 'stagejoined', 'stageleft',
  'transferred', 'mic', 'role', 'error', 'micerror', 'micready', 'audioblocked', 'speaking', 'quality',
];
const STATUS_LABELS = { waiting: '等待發言', live: '直播中', reconnecting: '重新連線中', disconnected: '未連線' };

const STYLE = `
:host { display: block; font: inherit; color: var(--stage-fg, inherit); }
[part=panel] { display: grid; gap: .5rem; padding: .75rem; border: 1px solid var(--stage-border, #8884); border-radius: var(--stage-radius, .5rem); background: var(--stage-bg, transparent); }
[part=status] { margin: 0; }
[part=error] { margin: 0; color: var(--stage-error, #dc2626); }
[part=actions] { display: flex; flex-wrap: wrap; gap: .5rem; }
[part=playback] { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
[part=playback][hidden] { display: none; }
input[type=range] { flex: 1; min-width: 5rem; max-width: 12rem; }
button { font: inherit; padding: .4rem .8rem; border-radius: var(--stage-radius, .5rem); border: 1px solid var(--stage-border, #8884); background: var(--stage-button-bg, #fff1); color: inherit; cursor: pointer; }
button[hidden] { display: none; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--stage-accent, #2563eb); border-color: transparent; color: var(--stage-accent-fg, #fff); }
`;

/**
 * `<stage-client url room code name>`: a self-contained listener / speaker widget over StageClient.
 *
 * Joins when it is in the document and has `room` and `name`; leaves when removed. Changing
 * `url`, `room`, `code` or `name` rejoins, except after the user explicitly leaves: the same
 * element then waits for its manual rejoin button, including across attribute edits/remounts.
 * `url` defaults to `/ws` on the origin the library was
 * loaded from. The underlying client is exposed as `.client` for anything the widget does not
 * offer. `playback-muted` / `.playbackMuted` and `playback-volume` / `.playbackVolume`
 * control local listening without rejoining,
 * and every client event is re-dispatched from the element as `stage-<type>` (bubbling,
 * composed) with the same `detail`. Style through `::part(panel|status|actions|playback)` and the
 * `--stage-*` custom properties.
 */
export class StageElement extends HTMLElement {
  static readonly observedAttributes = ['url', 'room', 'code', 'name', 'playback-muted', 'playback-volume'];
  private current: StageClient | null = null;
  private readonly status: HTMLParagraphElement;
  /** Last failure (request rejected, mic denied…); stays until the next action or join. */
  private readonly error: HTMLParagraphElement;
  private readonly unlock: HTMLButtonElement;
  private readonly hand: HTMLButtonElement;
  private readonly mic: HTMLButtonElement;
  private readonly micRetry: HTMLButtonElement;
  private micFailure: { client: StageClient; roomId: string; participantId: string; errorRevision: number; pending: boolean } | undefined;
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
    this.error = document.createElement('p');
    this.error.part.add('error');
    this.error.setAttribute('role', 'alert');
    this.error.hidden = true;
    const actions = document.createElement('div');
    actions.part.add('actions');
    this.unlock = this.button('啟用音訊', async () => {
      const client = this.current;
      await client?.unlockAudio();
      if (this.current === client) this.unlock.hidden = true;
    }, 'primary');
    this.unlock.hidden = true;
    this.hand = this.button('舉手發言', () => (this.current?.me?.handRaised ? this.current.withdrawHand() : this.current?.raiseHand()));
    this.mic = this.button('靜音', () => (this.current?.me?.muted ? this.current.unmute() : this.current?.mute()));
    // Capture admission is synchronous; its completion belongs to later mic events.
    this.micRetry = document.createElement('button');
    this.micRetry.type = 'button';
    this.micRetry.setAttribute('aria-label', '重試麥克風');
    this.micRetry.onclick = () => this.retryMic();
    this.leaveStage = this.button('離開舞台', () => {
      const client = this.current, me = client?.me;
      // Forwarded events can reenter before render updates the old button's visibility.
      if (!this.isConnected || !client || !me || client.status === 'reconnecting'
        || (!me.onStage && me.role !== 'controller')) return;
      return me.onStage ? client.leaveStage() : client.returnToStage();
    });
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
    panel.append(this.status, this.error, actions, this.playback);
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

  private button(label: string, action: () => Promise<unknown> | void, className = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (className) b.className = className;
    b.onclick = () => {
      if (b.disabled || this.pendingActions.has(b)) return;
      const generation = this.generation;
      this.pendingActions.add(b);
      b.disabled = true;
      b.setAttribute('aria-busy', 'true');
      this.error.hidden = true;
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
          const micLifecycle = type === 'state' || type === 'status' || type === 'micerror' || type === 'micready'
            || type === 'closed' || type === 'kicked';
          if (micLifecycle) this.syncMicRetry();
          // SDK status precedes state; a forwarded status listener may disconnect immediately.
          if (type === 'state' || client.state) { receivedState = true; this.hideRetry(); this.hideCancel(); }
          if (type === 'closed' || type === 'kicked') { terminal = true; this.micFailure = undefined; this.hideRetry(); this.hideCancel(); }
          if (type === 'state' || type === 'closed' || type === 'kicked'
            || (type === 'status' && detail === 'disconnected')) this.joinPhase = undefined;
          if (type === 'audioblocked') this.unlock.hidden = false;
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
            if (this.micFailure.errorRevision === this.errorRevision) this.error.hidden = true;
            this.micFailure = undefined;
          }
          // Revoke stale action admission before application event listeners can reenter.
          if (micLifecycle) this.syncMicRetry();
          this.dispatchEvent(new CustomEvent(`stage-${type}`, { detail, bubbles: true, composed: true }));
          if (type === 'state' || type === 'status' || type === 'mic' || type === 'closed' || type === 'kicked') this.render();
        });
      }
      this.error.hidden = true;
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
    this.error.hidden = true;
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
      else if (failure.errorRevision === this.errorRevision) this.error.hidden = true;
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

  private wsUrl(): string {
    const explicit = this.getAttribute('url');
    if (explicit) return explicit;
    // Resolved at runtime: the server that served this module also serves `/ws`.
    const ws = new URL(/* @vite-ignore */ '/ws', import.meta.url);
    ws.protocol = ws.protocol === 'https:' ? 'wss:' : 'ws:';
    return ws.href;
  }

  private show(error: unknown): void {
    this.errorRevision++;
    // StageError / Error, or a `micerror` detail ({name, message}).
    const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '操作失敗。';
    this.error.textContent = message;
    this.error.hidden = false;
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
    this.syncMicRetry();
    const client = this.current;
    const me = client?.me ?? null;
    const state = client?.state ?? null;
    if (state && me) {
      const handIndex = !me.onStage && me.role !== 'controller' && me.handRaised
        ? state.hands.findIndex(person => person.participantId === me.participantId) : -1;
      const raised = handIndex < 0 ? '已舉手'
        : `已舉手（${client!.status === 'reconnecting' ? '上次' : ''}佇列第 ${handIndex + 1} 位）`;
      const where = me.onStage ? (me.muted ? '台上（已靜音）' : '台上') : me.handRaised ? raised : '收聽中';
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
    this.unlock.disabled = this.pendingActions.has(this.unlock);
    this.hand.disabled = reconnecting || this.pendingActions.has(this.hand) || !me || (!me.handRaised && cooldown > 0);
    this.hand.textContent = me?.handRaised ? '收回舉手' : cooldown > 0 ? `舉手發言（${cooldown} 秒）` : '舉手發言';
    this.mic.hidden = !me?.onStage;
    this.leaveStage.hidden = !me || (!me.onStage && me.role !== 'controller');
    this.mic.disabled = reconnecting || this.pendingActions.has(this.mic) || Boolean(me?.forceMuted);
    this.mic.textContent = me?.muted ? '取消靜音' : '靜音';
    this.mic.setAttribute('aria-pressed', String(Boolean(me?.muted)));
    this.leaveStage.textContent = me?.onStage ? '離開舞台' : '返回舞台';
    this.leaveStage.disabled = this.leaveStage.hidden || reconnecting || this.pendingActions.has(this.leaveStage);
  }
}

/** Registers the element (default tag `stage-client`); a no-op when the tag is already defined. */
export function defineStageElement(tagName = 'stage-client'): void {
  if (customElements.get(tagName)) return;
  // A registry can use each constructor only once. Aliases inherit the complete widget
  // while the default registration keeps the exported StageElement constructor.
  customElements.define(tagName, tagName === 'stage-client' ? StageElement : class extends StageElement {});
}
