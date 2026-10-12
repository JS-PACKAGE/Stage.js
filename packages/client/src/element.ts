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
button { font: inherit; padding: .4rem .8rem; border-radius: var(--stage-radius, .5rem); border: 1px solid var(--stage-border, #8884); background: var(--stage-button-bg, #fff1); color: inherit; cursor: pointer; }
button[hidden] { display: none; }
button:disabled { opacity: .5; cursor: default; }
button.primary { background: var(--stage-accent, #2563eb); border-color: transparent; color: var(--stage-accent-fg, #fff); }
`;

/**
 * `<stage-client url room code name>`: a self-contained listener / speaker widget over StageClient.
 *
 * Joins when it is in the document and has `room` and `name`; leaves when removed. Changing
 * `url`, `room`, `code` or `name` rejoins. `url` defaults to `/ws` on the origin the library was
 * loaded from. The underlying client is exposed as `.client` for anything the widget does not
 * offer. `playback-muted` / `.playbackMuted` controls local listening without rejoining,
 * and every client event is re-dispatched from the element as `stage-<type>` (bubbling,
 * composed) with the same `detail`. Style through `::part(panel|status|actions)` and the
 * `--stage-*` custom properties.
 */
export class StageElement extends HTMLElement {
  static readonly observedAttributes = ['url', 'room', 'code', 'name', 'playback-muted'];
  private current: StageClient | null = null;
  private readonly status: HTMLParagraphElement;
  /** Last failure (request rejected, mic denied…); stays until the next action or join. */
  private readonly error: HTMLParagraphElement;
  private readonly unlock: HTMLButtonElement;
  private readonly hand: HTMLButtonElement;
  private readonly mic: HTMLButtonElement;
  private readonly leaveStage: HTMLButtonElement;
  private readonly listen: HTMLButtonElement;
  private readonly pendingActions = new Set<HTMLButtonElement>();
  private cooldownTimer: ReturnType<typeof setInterval> | undefined;
  /** Bumped on every (re)join, so a superseded join cannot touch the widget. */
  private generation = 0;

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
    this.leaveStage = this.button('離開舞台', () => this.current?.leaveStage());
    this.listen = this.button('靜音收聽', () => { this.playbackMuted = !this.playbackMuted; });
    this.listen.setAttribute('aria-label', '靜音收聽');
    actions.append(this.unlock, this.listen, this.hand, this.mic, this.leaveStage);
    panel.append(this.status, this.error, actions);
    root.append(style, panel);
    this.render();
  }

  /** The StageClient behind the widget; null while not joined. */
  get client(): StageClient | null { return this.current; }

  /** Local listening preference; reflected as a boolean attribute and retained across rejoins. */
  get playbackMuted(): boolean { return this.hasAttribute('playback-muted'); }
  set playbackMuted(value: boolean) { this.toggleAttribute('playback-muted', Boolean(value)); }

  connectedCallback(): void { this.rejoin(); }
  disconnectedCallback(): void { ++this.generation; void this.leave(); }
  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next) return;
    if (name === 'playback-muted') { this.current?.setPlaybackMuted(this.playbackMuted); this.render(); return; }
    if (this.isConnected) this.rejoin();
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
    void this.leave().then(async () => {
      const room = this.getAttribute('room')?.trim(), name = this.getAttribute('name')?.trim();
      if (generation !== this.generation || !this.isConnected || !room || !name) { this.render(); return; }
      const client = new StageClient({ url: this.wsUrl() });
      client.setPlaybackMuted(this.playbackMuted);
      this.current = client;
      for (const type of EVENTS) {
        client.on(type, ({ detail }) => {
          if (generation !== this.generation || this.current !== client) return;
          if (type === 'audioblocked') this.unlock.hidden = false;
          if (type === 'closed' || type === 'kicked') this.status.textContent = type === 'kicked' ? '你已被主控移出房間。' : '房間已關閉。';
          if (type === 'error' || type === 'micerror') this.show(detail);
          this.dispatchEvent(new CustomEvent(`stage-${type}`, { detail, bubbles: true, composed: true }));
          if (type === 'state' || type === 'status' || type === 'mic' || type === 'closed' || type === 'kicked') this.render();
        });
      }
      this.cooldownTimer = setInterval(() => this.render(), 1000);
      this.error.hidden = true;
      this.render();
      try {
        await client.connect();
        if (generation !== this.generation || this.current !== client || !this.isConnected) return;
        const code = this.getAttribute('code')?.trim();
        await client.join({ roomId: room, name, ...(code ? { code } : {}) });
      } catch (error) {
        if (generation === this.generation) this.show(error);
      }
    });
  }

  private async leave(): Promise<void> {
    for (const button of this.pendingActions) button.removeAttribute('aria-busy');
    this.pendingActions.clear();
    clearInterval(this.cooldownTimer);
    this.cooldownTimer = undefined;
    const client = this.current;
    this.current = null;
    this.unlock.hidden = true;
    this.render();
    await client?.disconnect();
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
    // StageError / Error, or a `micerror` detail ({name, message}).
    const message = typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' ? error.message : '操作失敗。';
    this.error.textContent = message;
    this.error.hidden = false;
  }

  private render(): void {
    const client = this.current;
    const me = client?.me ?? null;
    const state = client?.state ?? null;
    if (state && me) {
      const where = me.onStage ? (me.muted ? '台上（已靜音）' : '台上') : me.handRaised ? '已舉手' : '收聽中';
      this.status.textContent = `${decodeName(state.name)} · ${STATUS_LABELS[client!.status]} · ${where}`;
    } else if (!client) {
      this.status.textContent = this.getAttribute('room') && this.getAttribute('name') ? '' : '請設定 room 與 name 屬性。';
    }
    const audience = Boolean(me && !me.onStage && me.role !== 'controller');
    const cooldown = Math.ceil((client?.handCooldownMs ?? 0) / 1000);
    this.hand.hidden = !audience;
    this.listen.hidden = !me;
    this.listen.disabled = !client || this.pendingActions.has(this.listen);
    this.listen.textContent = this.playbackMuted ? '恢復收聽' : '靜音收聽';
    this.listen.setAttribute('aria-pressed', String(this.playbackMuted));
    this.unlock.disabled = this.pendingActions.has(this.unlock);
    this.hand.disabled = this.pendingActions.has(this.hand) || !me || (!me.handRaised && cooldown > 0);
    this.hand.textContent = me?.handRaised ? '收回舉手' : cooldown > 0 ? `舉手發言（${cooldown} 秒）` : '舉手發言';
    this.mic.hidden = this.leaveStage.hidden = !me?.onStage;
    this.mic.disabled = this.pendingActions.has(this.mic) || Boolean(me?.forceMuted);
    this.mic.textContent = me?.muted ? '取消靜音' : '靜音';
    this.mic.setAttribute('aria-pressed', String(Boolean(me?.muted)));
    this.leaveStage.disabled = this.pendingActions.has(this.leaveStage);
  }
}

/** Registers the element (default tag `stage-client`); a no-op when the tag is already defined. */
export function defineStageElement(tagName = 'stage-client'): void {
  if (!customElements.get(tagName)) customElements.define(tagName, StageElement);
}
