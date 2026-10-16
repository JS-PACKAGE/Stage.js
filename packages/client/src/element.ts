import { StageClient, decodeName, MAX_GAIN_DB, type ConnectionQuality, type StageEventMap } from './index.ts';

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
.room-occupancy { margin: 0; overflow-wrap: anywhere; }
[part=quality] { margin: 0; font-size: .875em; }
[part=connection-stats][hidden] { display: none; }
[part=connection-stats] p { margin: .5rem 0 0; font-size: .875em; overflow-wrap: anywhere; }
[part=speaking] { margin: 0; font-size: .875em; }
[part=hand-rejection] { margin: 0; }
[part=audio-recovery] { margin: 0; font-size: .875em; }
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
[part=stage-management][hidden] { display: none; }
[part=stage-management] ul { display: grid; gap: .5rem; padding-left: 1.25rem; }
[part=stage-management] li { overflow-wrap: anywhere; }
[part=stage-management] button { margin-left: .5rem; }
[part=stage-management] label { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .5rem; margin-left: .5rem; }
[part=stage-management] input { font: inherit; width: 6rem; max-width: 100%; }
[part=playback] { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
[part=playback][hidden] { display: none; }
[part=microphone] { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
[part=microphone][hidden] { display: none; }
[part=microphone] p { flex-basis: 100%; margin: 0; font-size: .875em; }
[part=microphone] select { font: inherit; max-width: 100%; }
[part=output-device] { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; }
[part=output-device][hidden] { display: none; }
[part=output-device] p { flex-basis: 100%; margin: 0; font-size: .875em; }
[part=output-device] select { font: inherit; max-width: 100%; }
input[type=range] { flex: 1; min-width: 5rem; max-width: 12rem; }
button { font: inherit; padding: .4rem .8rem; border-radius: var(--stage-radius, .5rem); border: 1px solid var(--stage-border, #8884); background: var(--stage-button-bg, #fff1); color: inherit; cursor: pointer; }
button[hidden] { display: none; }
button:disabled { opacity: .5; cursor: default; }
button.danger { color: var(--stage-error, #dc2626); border-color: currentColor; }
button.primary { background: var(--stage-accent, #2563eb); border-color: transparent; color: var(--stage-accent-fg, #fff); }
`;

/**
 * `<stage-client url room code name>`: a self-contained stage widget with controller hand and stage moderation over StageClient.
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
 * Controllers can lock/unlock other speakers' mute, explicitly apply a room-mix gain draft, remove them from the stage, or confirm a connected speaker's control handoff.
 * The microphone picker is an explicit draft, never an indicator of the actual capture device.
 * The output picker is also a draft; explicit refresh and submission never imply audible playback.
 * Style through `::part(panel|status|quality|connection-stats|speaking|hand-rejection|audio-recovery|audio-retry|actions|name|room-name|hands|stage-management|playback|microphone|output-device)` and the
 * `--stage-*` custom properties.
 */
export class StageElement extends HTMLElement {
  static readonly observedAttributes = ['url', 'room', 'code', 'name', 'playback-muted', 'playback-volume'];
  private current: StageClient | null = null;
  private readonly status: HTMLParagraphElement;
  private readonly occupancy: HTMLParagraphElement;
  private occupancyOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private occupancyReport: { room: number; stage: number; audience: number; maxAudience: number; maxSpeakers: number; controllerOnStage: boolean; last: boolean } | undefined;
  // Weak identities fence re-emission of retired public snapshots without retaining their private data.
  private readonly occupancySnapshots = new WeakSet<object>();
  private occupancyRevision = 0;
  private readonly quality: HTMLParagraphElement;
  private qualityOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private qualityReport: Omit<ConnectionQuality, 'participantId'> | undefined;
  private readonly qualitySnapshots = new WeakSet<object>();
  private readonly qualityReceipts = new WeakSet<object>();
  private qualityEventRevision = 0;
  private qualityRevision = 0;
  // Extra callback reconciliation repaints only changed projection; original paint triggers stay unconditional.
  private qualityPaintedRevision = -1;
  private qualityClearFirst = true;
  private readonly connectionStatsPanel: HTMLDivElement;
  private readonly connectionStatsUpdate: HTMLButtonElement;
  private readonly connectionStatsText: HTMLParagraphElement;
  private connectionStatsOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private connectionStatsTerminalClient: StageClient | undefined;
  private connectionStatsAttempt: object | undefined;
  private connectionStatsReport: { inbound: { loss: number | undefined; rtt: number | undefined; buffer: number | undefined } | null;
    outbound: { loss: number | undefined; rtt: number | undefined } | null } | undefined;
  private connectionStatsFailed = false;
  private connectionStatsLeaving = false;
  private readonly speaking: HTMLParagraphElement;
  private speakingOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private speakingReport: { ids: Set<string>; empty: boolean } | undefined;
  private readonly speakingSnapshots = new WeakSet<object>();
  private readonly speakingReceipts = new WeakSet<object>();
  private readonly speakingSuppressed = new Set<string>();
  private speakingEventRevision = 0;
  private speakingRevision = 0;
  private speakingPainted = { hidden: true, text: '' };
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
  private readonly stageManagementPanel: HTMLDetailsElement;
  private readonly stageManagementSummary: HTMLElement;
  private readonly stageManagementNotice: HTMLParagraphElement;
  private readonly stageManagementList: HTMLUListElement;
  private stageManagementOwner: { client: StageClient; roomId: string; participantId: string; generation: number; transferRevision: number; transferAwaitingState: boolean } | undefined;
  private stageManagementTerminalClient: StageClient | undefined;
  private readonly stageManagementPending = new Map<string, object>();
  private stageTransferAttempt: { id: string; node: HTMLLIElement; revision: number; invalid: boolean } | undefined;
  private readonly stageManagementRows = new Map<string, { node: HTMLLIElement; name: HTMLSpanElement; mute: HTMLButtonElement; remove: HTMLButtonElement; transfer: HTMLButtonElement; gainAccepted: HTMLSpanElement; gainLabel: HTMLSpanElement; gainInput: HTMLInputElement; gainApply: HTMLButtonElement }>();
  private stageManagementOrder: string[] = [];
  private readonly unlock: HTMLButtonElement;
  private playbackOwner: { client: StageClient; roomId: string; participantId: string; notice: number } | undefined;
  private unlockAttempt: object | undefined;
  private readonly hand: HTMLButtonElement;
  private readonly mic: HTMLButtonElement;
  private readonly micRetry: HTMLButtonElement;
  private readonly audioRetry: HTMLButtonElement;
  private readonly audioRecovery: HTMLParagraphElement;
  private audioRecoveryOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private audioRecoveryTerminalClient: StageClient | undefined;
  private audioRecoveryAttempt: object | undefined;
  private audioRecoveryComplete = false;
  private micFailure: { client: StageClient; roomId: string; participantId: string; errorRevision: number; pending: boolean } | undefined;
  private readonly microphonePanel: HTMLDivElement;
  private readonly microphoneSelect: HTMLSelectElement;
  private readonly microphoneRefresh: HTMLButtonElement;
  private readonly microphoneApply: HTMLButtonElement;
  private microphoneOwner: { client: StageClient; roomId: string; participantId: string; generation: number } | undefined;
  private microphoneTerminalClient: StageClient | undefined;
  private refreshAttempt: object | undefined;
  private inputDeviceAttempt: object | undefined;
  private readonly outputDevicePanel: HTMLDivElement;
  private readonly outputDeviceSelect: HTMLSelectElement;
  private readonly outputDeviceRefresh: HTMLButtonElement;
  private readonly outputDeviceApply: HTMLButtonElement;
  private readonly outputDeviceUnsupported: HTMLParagraphElement;
  private outputDeviceOwner: { client: StageClient; generation: number; draft: string } | undefined;
  private outputDeviceTerminalClient: StageClient | undefined;
  private outputDeviceAttempt: { kind: 'refresh' | 'apply' } | undefined;
  private errorRevision = 0;
  private readonly leaveStage: HTMLButtonElement;
  private readonly roomAction: HTMLButtonElement;
  private readonly roomClose: HTMLButtonElement;
  private readonly roomCloseNotice: HTMLParagraphElement;
  private readonly roomActions: HTMLDivElement;
  private readonly widgetRoot: ShadowRoot;
  private roomCloseOwner: { client: StageClient; roomId: string; participantId: string; generation: number; revision: number } | undefined;
  private roomCloseAuthority: { client: StageClient; roomId: string; participantId: string; generation: number; revision: number; awaitingState: boolean } | undefined;
  private roomCloseTerminalClient: StageClient | undefined;
  private roomCloseAttempt: { owner: NonNullable<StageElement['roomCloseOwner']>; revision: number; invalid: boolean; errorRevision: number } | undefined;
  private roomCloseRenderRevision = 0;
  // Dialog scopes outlive retired owners, but never the synchronous admission stack.
  private roomCloseDialog: object | undefined;
  private readonly stageTransferDialogs = new Set<object>();
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
    const root = this.widgetRoot = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const panel = document.createElement('div');
    panel.part.add('panel');
    this.status = document.createElement('p');
    this.status.part.add('status');
    this.status.setAttribute('role', 'status');
    this.status.setAttribute('aria-live', 'polite');
    this.occupancy = document.createElement('p');
    this.occupancy.className = 'room-occupancy';
    this.occupancy.hidden = true;
    this.quality = document.createElement('p');
    this.quality.part.add('quality');
    this.quality.hidden = true;
    this.connectionStatsPanel = document.createElement('div');
    this.connectionStatsPanel.part.add('connection-stats');
    this.connectionStatsPanel.hidden = true;
    this.connectionStatsUpdate = document.createElement('button');
    this.connectionStatsUpdate.type = 'button';
    this.connectionStatsUpdate.textContent = '更新我的連線統計';
    this.connectionStatsUpdate.onclick = () => this.refreshConnectionStats();
    this.connectionStatsText = document.createElement('p');
    this.connectionStatsPanel.append(this.connectionStatsUpdate, this.connectionStatsText);
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
    this.stageManagementPanel = document.createElement('details');
    this.stageManagementPanel.part.add('stage-management');
    this.stageManagementSummary = document.createElement('summary');
    this.stageManagementNotice = document.createElement('p');
    this.stageManagementList = document.createElement('ul');
    this.stageManagementPanel.append(this.stageManagementSummary, this.stageManagementNotice, this.stageManagementList);
    const actions = this.roomActions = document.createElement('div');
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
    this.audioRetry = document.createElement('button');
    this.audioRetry.type = 'button'; this.audioRetry.part.add('audio-retry');
    this.audioRetry.textContent = '重試音訊連線';
    this.audioRetry.setAttribute('aria-describedby', 'audio-recovery');
    this.audioRetry.onclick = () => this.retryAudio();
    this.audioRecovery = document.createElement('p');
    this.audioRecovery.id = 'audio-recovery'; this.audioRecovery.part.add('audio-recovery');
    this.audioRecovery.setAttribute('role', 'status');
    this.audioRecovery.setAttribute('aria-live', 'polite');
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
    this.outputDevicePanel = document.createElement('div');
    this.outputDevicePanel.part.add('output-device');
    const outputDeviceLabel = document.createElement('label');
    outputDeviceLabel.textContent = '輸出裝置選擇（草稿）';
    outputDeviceLabel.setAttribute('for', 'output-device');
    this.outputDeviceSelect = document.createElement('select');
    this.outputDeviceSelect.id = 'output-device';
    this.outputDeviceSelect.setAttribute('aria-describedby', 'output-device-draft-notice output-device-unsupported');
    this.outputDeviceSelect.onchange = () => {
      const owner = this.outputDeviceOwner, draft = this.outputDeviceSelect.value;
      this.syncOutputDeviceOwner();
      if (!owner || this.outputDeviceOwner !== owner || this.outputDevicePanel.hidden
        || this.outputDeviceSelect.disabled || this.outputDeviceAttempt) return;
      owner.draft = draft; this.outputDeviceSelect.value = draft;
    };
    this.outputDeviceRefresh = document.createElement('button');
    this.outputDeviceRefresh.type = 'button'; this.outputDeviceRefresh.textContent = '重新整理輸出裝置清單';
    this.outputDeviceRefresh.onclick = () => this.refreshOutputDevices();
    this.outputDeviceApply = document.createElement('button');
    this.outputDeviceApply.type = 'button'; this.outputDeviceApply.textContent = '送出輸出裝置選擇';
    this.outputDeviceApply.onclick = () => this.applyOutputDevice();
    const outputDeviceNotice = document.createElement('p');
    outputDeviceNotice.id = 'output-device-draft-notice';
    outputDeviceNotice.textContent = '草稿不代表目前實際輸出裝置；送出不保證已聽到聲音。「系統預設」會要求使用系統預設輸出；重新整理清單不會開啟麥克風或播放音訊。';
    this.outputDeviceUnsupported = document.createElement('p');
    this.outputDeviceUnsupported.id = 'output-device-unsupported';
    this.outputDeviceUnsupported.textContent = '此瀏覽器不支援選擇輸出裝置。';
    this.outputDevicePanel.append(outputDeviceLabel, this.outputDeviceSelect, this.outputDeviceRefresh,
      this.outputDeviceApply, outputDeviceNotice, this.outputDeviceUnsupported);
    this.leaveStage = this.button('離開舞台', () => {
      const client = this.current, me = client?.me;
      if (!client || !me || !this.canUseStage()) return;
      return me.onStage ? client.leaveStage() : client.returnToStage();
    }, '', () => this.canUseStage());
    this.roomAction = document.createElement('button');
    this.roomAction.type = 'button';
    this.roomAction.onclick = () => this.changeRoomPresence();
    this.roomClose = document.createElement('button');
    this.roomClose.type = 'button'; this.roomClose.className = 'danger'; this.roomClose.textContent = '關閉房間';
    this.roomClose.hidden = this.roomClose.disabled = true;
    this.roomClose.setAttribute('aria-busy', 'false');
    this.roomClose.setAttribute('aria-describedby', 'room-close-notice');
    this.roomClose.onclick = () => this.closeRoom();
    this.roomCloseNotice = document.createElement('p');
    this.roomCloseNotice.id = 'room-close-notice'; this.roomCloseNotice.hidden = true;
    this.roomCloseNotice.textContent = '關閉房間會讓所有人離場，且無法再加入此房間。離開房間只會讓你離場，房間可能保留並由其他人接任主控。';
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
    actions.append(this.unlock, this.listen, this.hand, this.mic, this.micRetry, this.audioRetry, this.leaveStage, this.roomAction, this.roomClose, this.retry, this.cancelJoin);
    panel.append(this.status, this.occupancy, this.quality, this.connectionStatsPanel, this.speaking, this.handRejection, this.error, this.errorDismiss, this.namePanel, this.roomNamePanel, this.handQueuePanel, this.stageManagementPanel, actions, this.roomCloseNotice, this.audioRecovery, this.microphonePanel, this.outputDevicePanel, this.playback);
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
          const speakingEvent = this.rememberSpeakingEvent(type, detail);
          const qualityEvent = this.rememberQualityEvent(type, detail);
          // Retire the manual read before public authority getters can admit a genuine new entry.
          if (type === 'closed' || type === 'kicked') this.connectionStatsTerminalClient = client;
          else if (type === 'state') this.connectionStatsTerminalClient = undefined;
          if (type === 'closed' || type === 'kicked'
            || (type === 'status' && (detail === 'reconnecting' || detail === 'disconnected'))) this.retireConnectionStats();
          if (type === 'closed' || type === 'kicked') this.stageManagementTerminalClient = client;
          else if (type === 'state') this.stageManagementTerminalClient = undefined;
          // Own-role deltas precede their snapshot. Fence both dialogs before any DOM setter can reenter.
          this.noteRoomCloseEvent(type, detail);
          this.noteStageTransferEvent(type, detail);
          this.reconcileRoomClose();
          this.noteQualityEvent(client, generation, type, detail, qualityEvent);
          this.noteSpeakingEvent(client, generation, type, detail, speakingEvent);
          if (type === 'closed' || type === 'kicked') this.microphoneTerminalClient = client;
          else if (type === 'state') this.microphoneTerminalClient = undefined;
          if (type === 'closed' || type === 'kicked') this.outputDeviceTerminalClient = client;
          else if (type === 'state') this.outputDeviceTerminalClient = undefined;
          if (type === 'closed' || type === 'kicked' || (type === 'status' && detail === 'disconnected')) this.audioRecoveryTerminalClient = client;
          else if (type === 'state') this.audioRecoveryTerminalClient = undefined;
          this.syncOccupancy(type === 'state' ? detail as StageEventMap['state'] : undefined,
            type === 'closed' || type === 'kicked' || (type === 'status' && detail === 'disconnected'));
          this.syncAudioRecovery();
          // Revoke picker admission before any forwarded callback can click an old control.
          this.syncMicrophoneOwner();
          this.syncOutputDeviceOwner();
          const micLifecycle = type === 'state' || type === 'status' || type === 'micerror' || type === 'micready'
            || type === 'closed' || type === 'kicked';
          if (micLifecycle) this.syncMicRetry();
          if (type === 'state' || type === 'status' || type === 'closed' || type === 'kicked' || type === 'audioblocked') this.syncPlaybackOwner();
          if (type === 'state' || type === 'status' || type === 'closed' || type === 'kicked') this.syncNameOwner();
          if (type === 'state' || type === 'status' || type === 'closed' || type === 'kicked') this.syncRoomNameOwner();
          if (type === 'state' || type === 'status' || type === 'closed' || type === 'kicked') this.syncHandQueue();
          this.syncStageManagement();
          this.syncRoomClose();
          const ownId = client.me?.participantId;
          if (type === 'closed' || type === 'kicked'
            || (type === 'status' && (detail === 'reconnecting' || detail === 'disconnected'))
            || (type === 'hand' && (detail as StageEventMap['hand']).raised && (detail as StageEventMap['hand']).participantId === ownId)
            || (type === 'stagejoined' && (detail as StageEventMap['stagejoined']).participantId === ownId)
            || (type === 'role' && (detail as StageEventMap['role']).role !== 'audience' && (detail as StageEventMap['role']).participantId === ownId)
            || (type === 'transferred' && (detail as StageEventMap['transferred']).toId === ownId)) this.retireHandRejection();
          else this.syncHandRejection(type === 'handrejected' ? detail as StageEventMap['handrejected'] : undefined);
          this.syncQualityOwner(type === 'quality' || type === 'state' || type === 'status' || type === 'closed'
            || type === 'kicked' || type === 'micerror'
            || (type === 'stageleft' && (detail as StageEventMap['stageleft']).participantId === ownId));
          this.syncSpeakingOwner(type === 'speaking' || type === 'state' || type === 'status'
            || type === 'closed' || type === 'kicked');
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
          this.syncOccupancy();
          this.syncQualityOwner(false);
          this.syncSpeakingOwner(false);
          this.syncConnectionStats();
          this.dispatchEvent(new CustomEvent(`stage-${type}`, { detail, bubbles: true, composed: true }));
          this.syncOccupancy();
          this.syncQualityOwner(false);
          this.syncSpeakingOwner(false);
          this.syncConnectionStats();
          // Application callbacks may retire this seat or mutate its exposed snapshot.
          this.syncMicrophoneOwner();
          this.syncOutputDeviceOwner();
          this.syncStageManagement();
          this.syncRoomClose();
          this.syncHandRejection();
          this.syncAudioRecovery();
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
    this.retireConnectionStats();
    this.retireOccupancy();
    this.retireQualityOwner();
    this.retireSpeakingOwner();
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
    this.connectionStatsLeaving = true;
    this.retireConnectionStats();
    this.retireOccupancy();
    this.retireQualityOwner();
    this.retireSpeakingOwner();
    this.retireRoomClose();
    this.roomCloseAuthority = undefined; this.roomCloseTerminalClient = undefined;
    this.joinPhase = undefined;
    this.micFailure = undefined;
    this.microphoneTerminalClient = undefined;
    this.retireMicrophoneOwner();
    this.outputDeviceTerminalClient = undefined;
    this.retireOutputDeviceOwner();
    this.retireNameOwner();
    this.retireRoomNameOwner();
    this.retireHandQueue();
    this.stageManagementTerminalClient = undefined;
    this.retireStageManagement();
    this.audioRecoveryTerminalClient = undefined;
    this.retireAudioRecovery();
    this.retireHandRejection();
    this.hideCancel();
    this.hideRetry();
    for (const button of this.pendingActions) button.removeAttribute('aria-busy');
    this.pendingActions.clear();
    clearTimeout(this.cooldownTimer);
    this.cooldownTimer = undefined; this.cooldownDue = 0;
    const client = this.current;
    this.current = null;
    this.connectionStatsLeaving = false;
    this.connectionStatsTerminalClient = undefined;
    this.unlock.hidden = true;
    this.render();
    await client?.disconnect();
  }

  private retireOccupancy(): void {
    ++this.occupancyRevision;
    this.occupancyOwner = undefined; this.occupancyReport = undefined;
  }

  /** Counts come only from new authoritative states, never status or membership deltas. */
  private syncOccupancy(snapshot?: StageEventMap['state'], terminal = false): void {
    const revision = ++this.occupancyRevision;
    const client = this.current, state = client?.state, me = state?.me;
    const owner = this.occupancyOwner;
    const sameOwner = owner && owner.client === client && owner.generation === this.generation
      && owner.roomId === state?.roomId && owner.participantId === me?.participantId;
    const active = client?.status === 'waiting' || client?.status === 'live';
    const joined = this.isConnected && client && state && typeof state.roomId === 'string' && state.roomId.trim()
      && typeof me?.participantId === 'string' && me.participantId.trim();
    if (terminal || !joined || (!active && client.status !== 'reconnecting') || !sameOwner) {
      this.occupancyOwner = undefined; this.occupancyReport = undefined;
    }
    const unseen = snapshot && !this.occupancySnapshots.has(snapshot);
    if (snapshot) this.occupancySnapshots.add(snapshot);
    if (!terminal && joined && active && snapshot === state && unseen) {
      this.occupancyOwner = undefined; this.occupancyReport = undefined;
      const limits = state.limits, audience = state.audienceCount;
      const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
      if (limits && typeof limits === 'object' && !Array.isArray(limits) && count(limits.maxAudience) && limits.maxAudience > 0
        && count(limits.maxSpeakers) && limits.maxSpeakers > 0 && count(audience)
        && typeof state.controllerId === 'string' && state.controllerId.trim() && Array.isArray(state.speakers)) {
        const seen = new Set<string>();
        let controllerOnStage = false, valid = true;
        for (const person of state.speakers) {
          if (!person || typeof person.participantId !== 'string' || !person.participantId.trim()
            || seen.has(person.participantId) || person.onStage !== true
            || (person.role !== 'controller' && person.role !== 'speaker')
            || (person.participantId === state.controllerId) !== (person.role === 'controller')) { valid = false; break; }
          seen.add(person.participantId);
          if (person.role === 'controller') controllerOnStage = true;
        }
        const stage = state.speakers.length - Number(controllerOnStage), room = audience + stage;
        if (valid && count(stage) && count(room) && stage <= limits.maxSpeakers && room <= limits.maxAudience) {
          this.occupancyOwner = { client, roomId: state.roomId, participantId: me.participantId, generation: this.generation };
          this.occupancyReport = { room, stage, audience, maxAudience: limits.maxAudience,
            maxSpeakers: limits.maxSpeakers, controllerOnStage, last: false };
        }
      }
    }
    const report = this.occupancyReport;
    if (report && client?.status === 'reconnecting') report.last = true;
    const status = client?.status;
    const current = (): boolean => {
      if (revision !== this.occupancyRevision) return false;
      const accepted = this.occupancyOwner;
      if (report && (!accepted || !this.isConnected || this.current !== accepted.client
        || this.generation !== accepted.generation || accepted.client.state?.roomId !== accepted.roomId
        || accepted.client.me?.participantId !== accepted.participantId || accepted.client.status !== status)) {
        this.syncOccupancy(); return false;
      }
      return true;
    };
    const text = report ? `房間席位（${report.last ? client?.status === 'reconnecting' ? '重新連線中，上次快照' : '上次快照' : '最近快照'}）：主控以外 ${report.room} / ${report.maxAudience} 人，其中台上 ${report.stage} / ${report.maxSpeakers} 人、觀眾 ${report.audience} 人；主控另計 1 人（${report.controllerOnStage ? '台上' : '台下'}）。含斷線保留席位。` : '';
    if (!report && !this.occupancy.hidden) this.occupancy.hidden = true;
    // A host setter can synchronously retire or replace the seat while this paragraph is painted.
    if (!current()) return;
    if (this.occupancy.textContent !== text) this.occupancy.textContent = text;
    if (!current()) return;
    if (report && this.occupancy.hidden) this.occupancy.hidden = false;
    current();
  }

  private retireRoomClose(): void {
    if (this.roomCloseAttempt) this.roomCloseAttempt.invalid = true;
    this.roomCloseOwner = undefined; this.roomCloseAttempt = undefined;
  }

  private noteRoomCloseEvent(type: keyof StageEventMap, detail: StageEventMap[keyof StageEventMap]): void {
    const client = this.current, authority = this.roomCloseAuthority;
    if (type === 'closed' || type === 'kicked' || (type === 'status' && detail === 'disconnected')) {
      this.roomCloseTerminalClient = client ?? undefined; this.retireRoomClose(); return;
    }
    if (type === 'state') {
      this.roomCloseTerminalClient = undefined;
      if (this.roomCloseAuthority) this.roomCloseAuthority.awaitingState = false;
    }
    const role = type === 'role' ? detail as StageEventMap['role'] : undefined;
    const transfer = type === 'transferred' ? detail as StageEventMap['transferred'] : undefined;
    // Both dialogs consume known loss using copied IDs before either helper reads public getters.
    if (authority && authority.client === client && authority.generation === this.generation
      && ((role && role.participantId === authority.participantId && role.role !== 'controller')
        || (transfer && transfer.fromId === authority.participantId && transfer.toId !== authority.participantId))) {
      this.roomCloseAuthority = { ...authority, revision: authority.revision + 1, awaitingState: true };
      this.retireRoomClose();
    }
    if (type === 'status' && detail === 'reconnecting' && this.roomCloseAttempt) this.roomCloseAttempt.invalid = true;
  }

  private roomCloseMounted(): boolean {
    return this.isConnected && this.roomClose.isConnected && this.widgetRoot.contains(this.roomActions)
      && this.roomActions.contains(this.roomClose);
  }

  private canCloseRoom(): boolean {
    const owner = this.roomCloseOwner, client = owner?.client;
    return Boolean(owner && client && this.current === client && this.generation === owner.generation
      && client.state?.roomId === owner.roomId && client.me?.participantId === owner.participantId
      && client.me?.role === 'controller' && client.me.connected === true
      && (client.status === 'waiting' || client.status === 'live') && this.roomCloseTerminalClient !== client
      && !this.roomCloseAuthority?.awaitingState && this.roomCloseAuthority?.revision === owner.revision
      && typeof client.closeRoom === 'function' && typeof window.confirm === 'function' && this.roomCloseMounted());
  }

  private reconcileRoomClose(): void {
    const client = this.current, state = client?.state, me = client?.me;
    const active = client?.status === 'waiting' || client?.status === 'live';
    const authority = this.roomCloseAuthority;
    if (authority && (authority.client !== client || authority.generation !== this.generation
      || authority.roomId !== state?.roomId || authority.participantId !== me?.participantId)) this.roomCloseAuthority = undefined;
    if (!this.isConnected || !client || !state || me?.role !== 'controller' || this.roomCloseTerminalClient === client
      || (!active && client.status !== 'reconnecting') || typeof client.closeRoom !== 'function' || this.roomCloseAuthority?.awaitingState) {
      this.retireRoomClose();
    } else {
      const owner = this.roomCloseOwner;
      if (!owner || owner.client !== client || owner.generation !== this.generation
        || owner.roomId !== state.roomId || owner.participantId !== me.participantId) {
        this.retireRoomClose();
        // Reconnect can retain a controller tenure, but cannot establish consent for a new one.
        if (active && me.connected) {
          this.roomCloseAuthority ??= { client, roomId: state.roomId, participantId: me.participantId,
            generation: this.generation, revision: 0, awaitingState: false };
          this.roomCloseOwner = { client, roomId: state.roomId, participantId: me.participantId,
            generation: this.generation, revision: this.roomCloseAuthority.revision };
        }
      }
    }
    if (this.roomCloseAttempt && !this.canCloseRoom()) this.roomCloseAttempt.invalid = true;
  }

  private syncRoomClose(): void {
    this.reconcileRoomClose();
    const owner = this.roomCloseOwner, attempt = this.roomCloseAttempt, revision = ++this.roomCloseRenderRevision;
    const allowed = this.canCloseRoom(), hidden = !owner, disabled = !allowed || Boolean(attempt), busy = String(Boolean(attempt));
    const current = (): boolean => {
      if (revision !== this.roomCloseRenderRevision) return false;
      // A host setter can change the exposed snapshot or detach a control without rendering.
      this.reconcileRoomClose();
      if (this.roomCloseOwner !== owner || this.roomCloseAttempt !== attempt || this.canCloseRoom() !== allowed) {
        this.syncRoomClose(); return false;
      }
      return true;
    };
    if (this.roomClose.hidden !== hidden) this.roomClose.hidden = hidden;
    if (!current()) return;
    if (this.roomClose.disabled !== disabled) this.roomClose.disabled = disabled;
    if (!current()) return;
    if (this.roomClose.getAttribute('aria-busy') !== busy) this.roomClose.setAttribute('aria-busy', busy);
    if (!current()) return;
    if (this.roomCloseNotice.hidden !== hidden) this.roomCloseNotice.hidden = hidden;
    current();
  }

  private closeRoom(): void {
    if (this.roomCloseDialog || this.stageTransferDialogs.size) return;
    const dialog = this.roomCloseDialog = {};
    let owner: StageElement['roomCloseOwner'], attempt: StageElement['roomCloseAttempt'];
    const owns = (): boolean => Boolean(owner && attempt && this.roomCloseOwner === owner && this.roomCloseAttempt === attempt);
    const eligible = (): boolean => owns() && !attempt!.invalid && attempt!.revision === owner!.revision && this.canCloseRoom();
    const releaseDialog = (): void => { if (this.roomCloseDialog === dialog) this.roomCloseDialog = undefined; };
    void (async () => {
      try {
        this.reconcileRoomClose(); owner = this.roomCloseOwner;
        if (!owner || this.roomCloseAttempt || !this.canCloseRoom()) { this.syncRoomClose(); return; }
        attempt = this.roomCloseAttempt = { owner, revision: owner.revision, invalid: false, errorRevision: this.errorRevision };
        this.syncRoomClose();
        if (!eligible()) return;
        if (!window.confirm('確定關閉此房間並讓所有人離場？關閉後無法再加入此房間。')) return;
        this.syncRoomClose();
        if (!eligible()) return;
        const result = owner.client.closeRoom();
        releaseDialog();
        // ACK is not terminal truth: only the SDK's closed/kicked lifecycle changes room presence.
        await result;
      } catch (error) {
        if (owns()) {
          try { this.syncRoomClose(); } catch { /* A failed DOM write can be reconciled on the next action. */ }
          if (eligible() && this.errorRevision === attempt!.errorRevision) this.show(error);
        }
      } finally {
        releaseDialog();
        if (owns()) {
          this.roomCloseAttempt = undefined;
          try { this.syncRoomClose(); } catch { /* Release the exact token even if a host setter throws. */ }
        }
      }
    })();
  }

  private retireConnectionStats(): void {
    this.connectionStatsOwner = undefined; this.connectionStatsAttempt = undefined;
    this.connectionStatsReport = undefined; this.connectionStatsFailed = false;
  }

  private connectionStatsMounted(): boolean {
    return this.isConnected && this.connectionStatsPanel.isConnected && this.connectionStatsUpdate.isConnected
      && this.connectionStatsText.isConnected && this.widgetRoot.contains(this.connectionStatsPanel)
      && this.connectionStatsPanel.contains(this.connectionStatsUpdate) && this.connectionStatsPanel.contains(this.connectionStatsText);
  }

  private connectionStatsIdentityReader() {
    const stats = this.connectionStatsOwner;
    const close = this.roomCloseAttempt, closeOwner = close?.owner;
    const transfer = this.stageTransferAttempt, transferOwner = this.stageManagementOwner;
    const observe = (field: string, value: unknown): void => {
      const lost = (owner: NonNullable<StageElement['connectionStatsOwner']>): boolean =>
        owner.client !== this.current || owner.generation !== this.generation || field === 'unreadable'
        || ((field === 'state' || field === 'me') && !value)
        || (field === 'status' && value !== 'waiting' && value !== 'live')
        || (field === 'roomId' && value !== owner.roomId) || (field === 'participantId' && value !== owner.participantId);
      // Consume each observation before another public getter can restore identity or admit a new dialog.
      if (close && (!closeOwner || lost(closeOwner))) close.invalid = true;
      if (transfer && (!transferOwner || lost(transferOwner))) transfer.invalid = true;
      if (stats && this.connectionStatsOwner === stats && lost(stats)) this.retireConnectionStats();
    };
    return <T>(field: 'state' | 'me' | 'status' | 'roomId' | 'participantId', get: () => T): T => {
      let value: T;
      try { value = get(); }
      catch (error) { observe('unreadable', undefined); throw error; }
      observe(field, value); return value;
    };
  }

  /** Manual readership needs a current seat, not a publisher, microphone, or new passive report. */
  private reconcileConnectionStats(): void {
    for (;;) {
      const owner = this.connectionStatsOwner, client = this.current, generation = this.generation;
      const read = this.connectionStatsIdentityReader();
      const state = read('state', () => client?.state), me = read('me', () => client?.me), status = read('status', () => client?.status);
      const roomId = read('roomId', () => state?.roomId), participantId = read('participantId', () => me?.participantId);
      if (owner !== this.connectionStatsOwner || client !== this.current || generation !== this.generation
        || state !== read('state', () => client?.state) || status !== read('status', () => client?.status)
        || roomId !== read('roomId', () => read('state', () => client?.state)?.roomId)
        || participantId !== read('participantId', () => read('me', () => client?.me)?.participantId)) continue;
      const eligible = Boolean(client && state && me && typeof roomId === 'string' && typeof participantId === 'string'
        && (status === 'waiting' || status === 'live') && this.connectionStatsTerminalClient !== client
        && !this.connectionStatsLeaving && !this.leftRoom && !this.roomExit && this.connectionStatsMounted());
      const lost = Boolean(owner && (!eligible || owner.client !== client || owner.generation !== generation
        || owner.roomId !== roomId || owner.participantId !== participantId));
      if (lost) this.retireConnectionStats();
      const retained = this.connectionStatsOwner;
      this.reconcileRoomClose();
      const transfer = this.stageTransferAttempt;
      if (transfer && !this.canTransferStage(transfer.id, transfer.node)) transfer.invalid = true;
      if (retained !== this.connectionStatsOwner || client !== this.current || generation !== this.generation
        || state !== read('state', () => client?.state) || status !== read('status', () => client?.status)
        || roomId !== read('roomId', () => read('state', () => client?.state)?.roomId)
        || participantId !== read('participantId', () => read('me', () => client?.me)?.participantId)
        || eligible !== Boolean(client && state && me
          && typeof roomId === 'string' && typeof participantId === 'string'
          && (status === 'waiting' || status === 'live') && this.connectionStatsTerminalClient !== client
          && !this.connectionStatsLeaving && !this.leftRoom && !this.roomExit && this.connectionStatsMounted())) continue;
      if (eligible && !retained) this.connectionStatsOwner = { client: client!, generation, roomId: roomId!, participantId: participantId! };
      return;
    }
  }

  private connectionStatsMessage(): string {
    const report = this.connectionStatsReport;
    if (!report) return this.connectionStatsFailed ? '無法讀取連線統計，請稍後手動再試。' : '尚未手動讀取連線統計。';
    const loss = (value: number | undefined): string => value === undefined ? '—' : value.toFixed(1);
    const ms = (value: number | undefined): string => value === undefined ? '—' : String(Math.round(value));
    const inbound = report.inbound, outbound = report.outbound;
    const receive = inbound ? `接收掉包 ${loss(inbound.loss)}% · 接收 RTT ${ms(inbound.rtt)} ms · 接收緩衝 ${ms(inbound.buffer)} ms` : '接收：暫無統計';
    const send = outbound ? `傳送掉包 ${loss(outbound.loss)}% · 傳送 RTT ${ms(outbound.rtt)} ms` : '傳送：暫無統計';
    return `上次手動讀取（SDK 取樣區間）：${receive}；${send}。RTT 不是端到端音訊延遲；不保證資料即時或目前可聽。`
      + (this.connectionStatsFailed ? '本次讀取失敗，仍顯示上次手動讀取結果。' : '');
  }

  private syncConnectionStats(): void {
    for (;;) {
      // Existing leave teardown has earlier host callbacks; defer new DOM until its current=null fence.
      if (this.current && (this.connectionStatsLeaving || this.leftRoom || this.roomExit)) {
        this.retireConnectionStats(); return;
      }
      this.reconcileConnectionStats();
      const owner = this.connectionStatsOwner, attempt = this.connectionStatsAttempt;
      const report = this.connectionStatsReport, failed = this.connectionStatsFailed;
      const hidden = !owner, busy = Boolean(attempt), disabled = hidden || busy;
      const text = hidden ? '' : this.connectionStatsMessage();
      // Reproject after every changed setter, including a stale outer setter that overwrites a nested winner.
      if (hidden && !this.connectionStatsPanel.hidden) { this.connectionStatsPanel.hidden = true; continue; }
      if (this.connectionStatsText.textContent !== text) { this.connectionStatsText.textContent = text; continue; }
      if (this.connectionStatsUpdate.disabled !== disabled) { this.connectionStatsUpdate.disabled = disabled; continue; }
      if (this.connectionStatsUpdate.getAttribute('aria-busy') !== String(busy)) {
        this.connectionStatsUpdate.setAttribute('aria-busy', String(busy)); continue;
      }
      const label = busy ? '讀取中…' : '更新我的連線統計';
      if (this.connectionStatsUpdate.textContent !== label) { this.connectionStatsUpdate.textContent = label; continue; }
      if (this.connectionStatsPanel.hidden !== hidden) { this.connectionStatsPanel.hidden = hidden; continue; }
      this.reconcileConnectionStats();
      if (owner === this.connectionStatsOwner && attempt === this.connectionStatsAttempt
        && report === this.connectionStatsReport && failed === this.connectionStatsFailed) return;
    }
  }

  private projectConnectionStats(raw: unknown, current: () => boolean): StageElement['connectionStatsReport'] {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error();
    const direction = (key: 'inbound' | 'outbound') => {
      const value: unknown = (raw as Record<string, unknown>)[key];
      if (!current()) return undefined;
      if (value === null || value === undefined) return null;
      if (typeof value !== 'object' || Array.isArray(value)) throw new Error();
      return value as Record<string, unknown>;
    };
    const numeric = (value: unknown, max = Infinity, factor = 1): number | undefined => {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > max) return undefined;
      const converted = value * factor;
      return Number.isFinite(converted) ? converted : undefined;
    };
    const inbound = direction('inbound');
    if (!current()) return undefined;
    let receive: NonNullable<StageElement['connectionStatsReport']>['inbound'] = null;
    if (inbound) {
      const loss = numeric(inbound.lossPercent, 100); if (!current()) return undefined;
      const rtt = numeric(inbound.rtt, Infinity, 1000); if (!current()) return undefined;
      const buffer = numeric(inbound.bufferMs); if (!current()) return undefined;
      receive = { loss, rtt, buffer };
    }
    const outbound = direction('outbound');
    if (!current()) return undefined;
    let send: NonNullable<StageElement['connectionStatsReport']>['outbound'] = null;
    if (outbound) {
      const loss = numeric(outbound.lossPercent, 100); if (!current()) return undefined;
      const rtt = numeric(outbound.rtt, Infinity, 1000); if (!current()) return undefined;
      send = { loss, rtt };
    }
    return { inbound: receive, outbound: send };
  }

  private refreshConnectionStats(): void {
    if (this.connectionStatsLeaving || this.leftRoom || this.roomExit) return;
    if (this.connectionStatsUpdate.disabled || this.connectionStatsUpdate.hidden || this.connectionStatsPanel.hidden
      || !this.connectionStatsMounted()) return;
    this.syncConnectionStats();
    const owner = this.connectionStatsOwner;
    if (!owner || this.connectionStatsAttempt) return;
    // Reserve before any getStats lookup or DOM callback can invoke the retained handler again.
    const attempt = this.connectionStatsAttempt = {};
    this.connectionStatsFailed = false;
    const current = (): boolean => {
      this.syncConnectionStats();
      return this.connectionStatsOwner === owner && this.connectionStatsAttempt === attempt;
    };
    void (async () => {
      try {
        if (!current()) return;
        const read = owner.client.getStats;
        if (!current()) return;
        if (typeof read !== 'function') throw new Error();
        const pending = read.call(owner.client);
        const active = current();
        // Consume even a retired native promise; UI retirement does not cancel SDK sampling or its deltas.
        const raw: unknown = await pending;
        if (!current() || !active) return;
        const report = this.projectConnectionStats(raw, current);
        if (!current() || !report) return;
        this.connectionStatsReport = report;
      } catch {
        if (current()) this.connectionStatsFailed = true;
      } finally {
        if (this.connectionStatsOwner === owner && this.connectionStatsAttempt === attempt) this.connectionStatsAttempt = undefined;
        this.syncConnectionStats();
      }
    })();
  }

  private retireQualityOwner(): void {
    ++this.qualityRevision;
    this.qualityOwner = undefined; this.qualityReport = undefined; this.qualityClearFirst = true;
  }

  private retireSpeakingOwner(): void {
    ++this.speakingRevision;
    this.speakingOwner = undefined; this.speakingReport = undefined;
    this.speakingSuppressed.clear();
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

  private rememberSpeakingEvent(type: keyof StageEventMap, detail: StageEventMap[keyof StageEventMap]): { revision: number; unseen: boolean } {
    const revision = ++this.speakingEventRevision;
    const identities = type === 'state' ? this.speakingSnapshots : type === 'speaking' ? this.speakingReceipts : undefined;
    const object = detail !== null && (typeof detail === 'object' || typeof detail === 'function');
    const unseen = !object || !identities?.has(detail as object);
    // Reserve even rejected envelopes before public getters can reenter. Primitive malformed reports stay unknown.
    if (identities && object) identities.add(detail as object);
    if (type === 'closed' || type === 'kicked'
      || (type === 'status' && (detail === 'reconnecting' || detail === 'disconnected'))) this.retireSpeakingOwner();
    else if (type === 'stageleft' || (type === 'role' && (detail as StageEventMap['role']).role === 'audience')) {
      const id = (detail as StageEventMap['stageleft']).participantId;
      if (revision === this.speakingEventRevision && typeof id === 'string') {
        this.speakingSuppressed.add(id);
        this.speakingReport?.ids.delete(id);
        ++this.speakingRevision;
      }
    }
    return { revision, unseen };
  }

  /** Room-wide readership survives own-stage loss; only connection and entry identity bind its tenure. */
  private reconcileSpeakingOwner(): void {
    for (;;) {
      const owner = this.speakingOwner;
      if (!owner) return;
      const revision = this.speakingRevision, client = owner.client;
      const state = client.state, status = client.status;
      const roomId = state?.roomId, participantId = state?.me?.participantId;
      const currentState = client.state, currentStatus = client.status;
      if (owner !== this.speakingOwner || revision !== this.speakingRevision) continue;
      if (state !== currentState || status !== currentStatus) continue;
      if (this.isConnected && this.current === client && this.generation === owner.generation
        && roomId === owner.roomId && participantId === owner.participantId
        && (status === 'waiting' || status === 'live')) return;
      this.retireSpeakingOwner();
      // A corrective paint must not allow its setters to restore either pending dialog's consent.
      this.noteRoomCloseEvent('status', currentStatus);
      this.noteStageTransferEvent('status', currentStatus);
      this.reconcileRoomClose();
    }
  }

  private noteSpeakingEvent(client: StageClient, generation: number, type: keyof StageEventMap,
    detail: StageEventMap[keyof StageEventMap], event: { revision: number; unseen: boolean }): void {
    this.reconcileSpeakingOwner();
    if (event.revision !== this.speakingEventRevision || this.current !== client || this.generation !== generation) return;
    if (type === 'state' && event.unseen) {
      const state = client.state, status = client.status;
      const roomId = state?.roomId, participantId = state?.me?.participantId;
      const eligible = state && state === detail && this.isConnected && participantId !== undefined
        && (status === 'waiting' || status === 'live') && state === client.state && status === client.status;
      this.reconcileSpeakingOwner();
      if (eligible && event.revision === this.speakingEventRevision && this.current === client && this.generation === generation) {
        if (!this.speakingOwner) this.speakingOwner = { client, roomId: roomId!, participantId, generation };
        // Releasing suppression never repopulates the already-pruned historical report.
        this.speakingSuppressed.clear();
        ++this.speakingRevision;
      }
    }
    this.reconcileSpeakingOwner();
    const owner = this.speakingOwner;
    if (type !== 'speaking' || !event.unseen || !owner || event.revision !== this.speakingEventRevision) return;
    const raw = (detail as StageEventMap['speaking'] | null | undefined)?.participantIds;
    const ids: unknown[] | undefined = Array.isArray(raw) ? [...raw] : undefined;
    const report = ids?.every((id): id is string => typeof id === 'string')
      ? { ids: new Set(ids.filter(id => !this.speakingSuppressed.has(id))), empty: ids.length === 0 } : undefined;
    this.reconcileSpeakingOwner();
    if (owner !== this.speakingOwner || event.revision !== this.speakingEventRevision) return;
    this.speakingReport = report; ++this.speakingRevision;
  }

  private speakingProjection(): { hidden: boolean; text: string; revision: number } {
    for (;;) {
      this.reconcileSpeakingOwner();
      const owner = this.speakingOwner, report = this.speakingReport, revision = this.speakingRevision;
      const client = this.current, generation = this.generation, state = client?.state, status = client?.status;
      // SDK status can precede the first receipt for a new identity. This placeholder admits no report.
      const placeholder = !owner && state?.me && !this.speakingSnapshots.has(state) && this.isConnected
        && (status === 'waiting' || status === 'live');
      const hidden = !owner && !placeholder;
      let text = hidden ? '' : '發言偵測：等待伺服器回報。';
      let seen: Set<string> | undefined;
      if (owner && report) {
        if (report.empty) text = '最近收到的發言回報：未偵測到發言。';
        else {
          seen = new Set<string>(); const names: string[] = [];
          for (const person of state?.speakers ?? []) {
            const id = person.participantId, onStage = person.onStage, role = person.role;
            if (!onStage || (role !== 'speaker' && role !== 'controller') || !report.ids.has(id)
              || this.speakingSuppressed.has(id) || seen.has(id)) continue;
            seen.add(id);
            // Read the live public roster on every original render, including disconnected grace seats.
            names.push(decodeName(person.name));
          }
          text = names.length ? `最近收到的發言回報：${names.join('、')}（${names.length} 人）。`
            : '最近收到的發言回報：沒有可對應的台上成員。';
        }
      }
      const sameSnapshot = state === client?.state && status === client?.status;
      // Always reconcile the live winner, even after a getter completed a newer nested report.
      this.reconcileSpeakingOwner();
      if (revision !== this.speakingRevision || owner !== this.speakingOwner || client !== this.current
        || generation !== this.generation || !sameSnapshot) continue;
      if (seen && report) report.ids = seen;
      return { hidden, text, revision };
    }
  }

  /** New events supply activity; rendering only maps and permanently prunes that copied report. */
  private syncSpeakingOwner(force = true): void {
    const projection = this.speakingProjection();
    if (!force && projection.hidden === this.speakingPainted.hidden && projection.text === this.speakingPainted.text) return;
    const current = (): boolean => {
      const next = this.speakingProjection();
      if (next.revision !== projection.revision || next.hidden !== projection.hidden || next.text !== projection.text) {
        // A host setter may finish its old write after a nested painter; its cached paint is no longer proof.
        this.syncSpeakingOwner(); return false;
      }
      return true;
    };
    // Keep ordinary unconditional replacement and its hidden-then-text order, including host descendant repair.
    if (projection.hidden) {
      this.speaking.textContent = projection.text;
      if (!current()) return;
      this.speaking.hidden = true;
    } else {
      this.speaking.hidden = false;
      if (!current()) return;
      this.speaking.textContent = projection.text;
    }
    if (current()) this.speakingPainted = projection;
  }

  /** Retirement is pure: a corrective DOM write must never precede the dialog authority fences. */
  private reconcileQualityOwner(): void {
    for (;;) {
      const owner = this.qualityOwner;
      if (!owner) return;
      const revision = this.qualityRevision, client = owner.client;
      const status = client.status, state = client.state;
      // Public getters can finish nested work before returning. Recheck the live owner, not just this painter.
      const currentState = client.state, currentStatus = client.status;
      if (owner !== this.qualityOwner || revision !== this.qualityRevision) continue;
      if (state !== currentState || status !== currentStatus) continue;
      if (this.isConnected && this.current === client && this.generation === owner.generation
        && state?.roomId === owner.roomId && state.me.participantId === owner.participantId
        && state.me.onStage && (status === 'waiting' || status === 'live')) return;
      this.retireQualityOwner();
      this.noteRoomCloseEvent('status', currentStatus);
      this.noteStageTransferEvent('status', currentStatus);
      this.reconcileRoomClose();
      // Either authority getter may have admitted a newer entry; reconcile that entry too.
    }
  }

  private rememberQualityEvent(type: keyof StageEventMap, detail: StageEventMap[keyof StageEventMap]): { revision: number; unseen: boolean } {
    const revision = ++this.qualityEventRevision;
    const identities = type === 'state' ? this.qualitySnapshots : type === 'quality' ? this.qualityReceipts : undefined;
    const unseen = Boolean(identities && detail && !identities.has(detail as object));
    // Consume before any public getter: even rejected or superseded receipts cannot gain authority on replay.
    if (identities && detail) identities.add(detail as object);
    const ownId = this.qualityOwner?.participantId;
    // Known loss must precede even authority getters: a nested report alone cannot outrun retirement.
    if (type === 'closed' || type === 'kicked'
      || (type === 'status' && (detail === 'reconnecting' || detail === 'disconnected'))
      || (ownId !== undefined && type === 'stageleft' && (detail as StageEventMap['stageleft']).participantId === ownId)
      || (ownId !== undefined && type === 'role' && (detail as StageEventMap['role']).participantId === ownId
        && (detail as StageEventMap['role']).role === 'audience')) this.retireQualityOwner();
    else if (type === 'micerror') {
      ++this.qualityRevision; this.qualityReport = undefined; this.qualityClearFirst = true;
    }
    return { revision, unseen };
  }

  private noteQualityEvent(client: StageClient, generation: number, type: keyof StageEventMap,
    detail: StageEventMap[keyof StageEventMap], event: { revision: number; unseen: boolean }): void {
    if (event.revision !== this.qualityEventRevision || this.current !== client || this.generation !== generation) return;
    const snapshot = type === 'state' ? detail as StageEventMap['state'] : undefined;
    const receipt = type === 'quality' ? detail as StageEventMap['quality'] : undefined;
    this.reconcileQualityOwner();
    const state = client.state;
    if (event.revision !== this.qualityEventRevision || this.current !== client || this.generation !== generation) return;
    if (snapshot && event.unseen && snapshot === state && this.isConnected && state.me.onStage
      && (client.status === 'waiting' || client.status === 'live')
      && snapshot === client.state && this.current === client && this.generation === generation
      && event.revision === this.qualityEventRevision) {
      if (!this.qualityOwner) {
        this.qualityOwner = { client, roomId: state.roomId, participantId: state.me.participantId, generation };
        ++this.qualityRevision; this.qualityClearFirst = false;
      }
    }
    this.reconcileQualityOwner();
    const owner = this.qualityOwner;
    if (!receipt || !event.unseen || !owner || event.revision !== this.qualityEventRevision) return;
    let report: ConnectionQuality | undefined;
    for (const candidate of receipt.participants) if (candidate.participantId === owner.participantId) report = candidate;
    // Preserve the last whole own item, and copy only its primitives before forwarding the raw detail.
    const up = report?.uplinkLossPercent, down = report?.downlinkLossPercent, rtt = report?.rttMs;
    const copied = report ? {
      uplinkLossPercent: typeof up === 'number' ? up : undefined,
      downlinkLossPercent: typeof down === 'number' ? down : undefined,
      rttMs: typeof rtt === 'number' ? rtt : undefined,
    } : undefined;
    this.reconcileQualityOwner();
    if (owner !== this.qualityOwner || event.revision !== this.qualityEventRevision) return;
    ++this.qualityRevision; this.qualityReport = copied; this.qualityClearFirst = false;
  }

  /** Reports have no timestamp or media epoch; only a new admitted receipt supplies values. */
  private syncQualityOwner(force = true): void {
    this.reconcileQualityOwner();
    if (!force && this.qualityPaintedRevision === this.qualityRevision) return;
    const revision = this.qualityRevision, report = this.qualityReport;
    const current = (): boolean => {
      const before = this.qualityRevision;
      // Even a superseded painter must observe silent ownership loss after nested newer work.
      this.reconcileQualityOwner();
      if (before !== this.qualityRevision) { this.syncQualityOwner(); return false; }
      return revision === this.qualityRevision;
    };
    const percent = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? `${value.toFixed(1)}%` : '—';
    const rtt = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${Math.round(value)} ms` : '—';
    const text = report ? `你的連線品質（最近收到）：上行掉包 ${percent(report.uplinkLossPercent)} · 下行掉包 ${percent(report.downlinkLossPercent)} · RTT ${rtt(report.rttMs)}（非端到端音訊延遲）` : '';
    // Keep unconditional text replacement, including repair of same-text host-added descendants.
    if (this.qualityClearFirst) {
      this.quality.textContent = text;
      if (!current()) return;
      this.quality.hidden = !report;
    } else {
      this.quality.hidden = !report;
      if (!current()) return;
      this.quality.textContent = text;
    }
    if (current()) {
      this.qualityPaintedRevision = revision;
      if (this.qualityOwner) this.qualityClearFirst = false;
    }
  }

  private retireNameOwner(): void {
    this.nameOwner = undefined; this.nameAttempt = undefined;
    this.nameInput.value = ''; this.acceptedName.textContent = '';
    if (!this.namePanel.hidden) this.namePanel.hidden = true;
    if (!this.nameUpdate.disabled) this.nameUpdate.disabled = true;
    if (!this.nameInput.disabled) this.nameInput.disabled = true;
    if (this.nameUpdate.hasAttribute('aria-busy')) this.nameUpdate.removeAttribute('aria-busy');
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
    if (this.namePanel.hidden) this.namePanel.hidden = false;
    if (this.nameInput.disabled) this.nameInput.disabled = false;
    const disabled = client.status === 'reconnecting' || Boolean(this.nameAttempt);
    if (this.nameUpdate.disabled !== disabled) this.nameUpdate.disabled = disabled;
    const busy = String(Boolean(this.nameAttempt));
    if (this.nameUpdate.getAttribute('aria-busy') !== busy) this.nameUpdate.setAttribute('aria-busy', busy);
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
      const label = `${name}${person.connected ? '' : '（暫時離線）'}`;
      if (row.name.textContent !== label) row.name.textContent = label;
      const approveLabel = `核准 ${name} 上台`, rejectLabel = `婉拒 ${name} 的舉手申請`;
      if (row.approve.getAttribute('aria-label') !== approveLabel) row.approve.setAttribute('aria-label', approveLabel);
      if (row.reject.getAttribute('aria-label') !== rejectLabel) row.reject.setAttribute('aria-label', rejectLabel);
      const pending = this.handQueuePending.has(id);
      for (const control of [row.approve, row.reject]) {
        const disabled = reconnecting || pending, busy = String(pending);
        if (control.disabled !== disabled) control.disabled = disabled;
        if (control.getAttribute('aria-busy') !== busy) control.setAttribute('aria-busy', busy);
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

  private retireStageManagement(): void {
    this.stageManagementOwner = undefined; this.stageManagementPending.clear(); this.stageTransferAttempt = undefined;
    for (const row of this.stageManagementRows.values()) {
      for (const control of [row.mute, row.remove, row.transfer, row.gainInput, row.gainApply]) { control.disabled = true; control.setAttribute('aria-busy', 'false'); }
    }
    if (this.stageManagementRows.size) this.stageManagementList.replaceChildren();
    this.stageManagementRows.clear(); this.stageManagementOrder = [];
    this.stageManagementPanel.hidden = true; this.stageManagementPanel.open = false;
    this.stageManagementSummary.textContent = ''; this.stageManagementNotice.textContent = '';
  }

  private syncStageManagement(): void {
    const client = this.current, state = client?.state, me = client?.me;
    const active = client?.status === 'waiting' || client?.status === 'live';
    if (!this.isConnected || !client || !state || me?.role !== 'controller' || this.stageManagementTerminalClient === client
      || (!active && client.status !== 'reconnecting')) {
      this.retireStageManagement(); return;
    }
    const owner = this.stageManagementOwner;
    if (!owner || owner.client !== client || owner.generation !== this.generation
      || owner.roomId !== state.roomId || owner.participantId !== me.participantId) {
      this.retireStageManagement();
      // Reconnecting retains an existing controller tenure, never establishes a different one.
      if (!active) return;
      this.stageManagementOwner = { client, roomId: state.roomId, participantId: me.participantId, generation: this.generation, transferRevision: 0, transferAwaitingState: false };
    }
    const seen = new Set<string>();
    const people = (state.speakers ?? []).filter(person => {
      if (!person.participantId || seen.has(person.participantId) || person.participantId === me.participantId
        || person.role !== 'speaker' || !person.onStage) return false;
      seen.add(person.participantId); return true;
    });
    const reconnecting = client.status === 'reconnecting';
    this.stageManagementPanel.hidden = false;
    this.stageManagementSummary.textContent = `舞台管理（${people.length}）${reconnecting ? ' · 上次收到' : ''}`;
    this.stageManagementNotice.textContent = `${reconnecting ? '重新連線中，暫時不能管理舞台。'
      : people.length ? '僅管理其他台上發言者。' : '目前沒有其他台上發言者。'}解除靜音鎖定會保留對方自行靜音設定；移下台後仍留在房間。移交控制權後會失去主控權限，但保留目前台位並留在房間。混音增益調整該講者在房間混音中的音量，0 會重設手動增益；不改變本機播放音量或麥克風硬體增益，也不會解除靜音，可能影響稍後音訊或下次上台。伺服器仍可能接受在尚未得知對方下台時送出的增益。`;
    for (const person of people) {
      const id = person.participantId;
      let row = this.stageManagementRows.get(id);
      if (!row) {
        const node = document.createElement('li'), name = document.createElement('span');
        const mute = document.createElement('button'), remove = document.createElement('button'), transfer = document.createElement('button');
        mute.type = remove.type = transfer.type = 'button'; remove.textContent = '移下台'; transfer.textContent = '移交控制權';
        const gainAccepted = document.createElement('span'), gainLabel = document.createElement('span');
        const label = document.createElement('label'), gainInput = document.createElement('input'), gainApply = document.createElement('button');
        gainInput.type = 'number'; gainInput.min = String(-MAX_GAIN_DB); gainInput.max = String(MAX_GAIN_DB); gainInput.step = '0.1';
        gainInput.value = String(person.gainDb);
        gainApply.type = 'button'; gainApply.textContent = '套用混音增益';
        label.append(gainLabel, gainInput);
        row = { node, name, mute, remove, transfer, gainAccepted, gainLabel, gainInput, gainApply };
        const currentRow = row;
        mute.onclick = () => this.moderateStage(id, currentRow.node, false);
        remove.onclick = () => this.moderateStage(id, currentRow.node, true);
        transfer.onclick = () => this.transferStageControl(id, currentRow.node);
        gainInput.oninput = gainInput.onchange = () => this.syncStageManagement();
        gainApply.onclick = () => this.applyStageGain(id, currentRow.node);
        node.append(name, mute, remove, transfer, gainAccepted, label, gainApply); this.stageManagementRows.set(id, row);
      }
      const name = decodeName(person.name);
      const label = `${name} · ${person.muted ? '已靜音' : '未靜音'}${person.forceMuted ? ' · 已鎖定靜音' : ''}${person.connected ? '' : ' · 暫時離線（席位保留中）'}`;
      if (row.name.textContent !== label) row.name.textContent = label;
      const muteText = person.forceMuted ? '解除靜音鎖定' : '鎖定靜音';
      if (row.mute.textContent !== muteText) row.mute.textContent = muteText;
      const muteLabel = person.forceMuted ? `解除 ${name} 的靜音鎖定` : `鎖定 ${name} 靜音`;
      const removeLabel = `將 ${name} 移下台`, transferLabel = `將控制權移交給 ${name}`;
      if (row.mute.getAttribute('aria-label') !== muteLabel) row.mute.setAttribute('aria-label', muteLabel);
      if (row.remove.getAttribute('aria-label') !== removeLabel) row.remove.setAttribute('aria-label', removeLabel);
      if (row.transfer.getAttribute('aria-label') !== transferLabel) row.transfer.setAttribute('aria-label', transferLabel);
      const accepted = `目前混音增益：${person.gainDb > 0 ? '+' : ''}${person.gainDb} dB${reconnecting ? '（上次收到）' : ''}`;
      const gainLabel = `${name} 的混音增益草稿（dB），範圍 -${MAX_GAIN_DB} 至 +${MAX_GAIN_DB}，步進 0.1`;
      const gainApplyLabel = `套用 ${name} 的混音增益`;
      if (row.gainAccepted.textContent !== accepted) row.gainAccepted.textContent = accepted;
      if (row.gainLabel.textContent !== gainLabel) row.gainLabel.textContent = gainLabel;
      if (row.gainApply.getAttribute('aria-label') !== gainApplyLabel) row.gainApply.setAttribute('aria-label', gainApplyLabel);
      const pending = this.stageManagementPending.has(id);
      const gainDisabled = reconnecting || !me.connected || pending || Boolean(this.stageTransferAttempt) || typeof client.setGain !== 'function';
      for (const control of [row.gainInput, row.gainApply]) {
        const disabled = gainDisabled || (control === row.gainApply && this.stageGainDraft(row.gainInput) === undefined), busy = String(pending);
        if (control.disabled !== disabled) control.disabled = disabled;
        if (control.getAttribute('aria-busy') !== busy) control.setAttribute('aria-busy', busy);
      }
      // A retained offline seat can still be moderated; the server decides whether it remains valid.
      for (const control of [row.mute, row.remove]) {
        const disabled = reconnecting || pending || Boolean(this.stageTransferAttempt), busy = String(pending);
        if (control.disabled !== disabled) control.disabled = disabled;
        if (control.getAttribute('aria-busy') !== busy) control.setAttribute('aria-busy', busy);
      }
      const hidden = typeof client.transferControl !== 'function';
      if (row.transfer.hidden !== hidden) row.transfer.hidden = hidden;
      const disabled = Boolean(this.stageTransferAttempt) || !this.canTransferStage(id, row.node);
      if (row.transfer.disabled !== disabled) row.transfer.disabled = disabled;
      const busy = String(Boolean(this.stageTransferAttempt));
      if (row.transfer.getAttribute('aria-busy') !== busy) row.transfer.setAttribute('aria-busy', busy);
    }
    for (const [id, row] of this.stageManagementRows) if (!seen.has(id)) {
      for (const control of [row.mute, row.remove, row.transfer, row.gainInput, row.gainApply]) { control.disabled = true; control.setAttribute('aria-busy', 'false'); }
      this.stageManagementRows.delete(id);
      // Keep an admitted operation reserved until settlement, even if this ID returns on stage.
    }
    const order = people.map(person => person.participantId);
    if (order.length !== this.stageManagementOrder.length || order.some((id, index) => id !== this.stageManagementOrder[index])) {
      this.stageManagementList.replaceChildren(...order.map(id => this.stageManagementRows.get(id)!.node));
      this.stageManagementOrder = order;
    }
    // Observed ineligibility cannot be undone by a nested callback restoring the old snapshot.
    const attempt = this.stageTransferAttempt;
    if (attempt && !this.canTransferStage(attempt.id, attempt.node)) attempt.invalid = true;
  }

  private moderateStage(id: string, node: HTMLLIElement, remove: boolean): void {
    this.syncStageManagement();
    const owner = this.stageManagementOwner, row = this.stageManagementRows.get(id);
    if (!owner || !row || row.node !== node || this.stageManagementPanel.hidden
      || (owner.client.status !== 'waiting' && owner.client.status !== 'live') || this.stageManagementPending.has(id) || this.stageTransferAttempt) return;
    const target = owner.client.state?.speakers.find(person => person.participantId === id && person.role === 'speaker' && person.onStage);
    if (!target) return;
    // Resolve the branch from the authoritative snapshot, not the label of a retained button.
    const forceMuted = target.forceMuted;
    const attempt = {};
    this.stageManagementPending.set(id, attempt); this.syncStageManagement(); this.hideError();
    const current = (): boolean => {
      if (this.stageManagementOwner !== owner || this.stageManagementPending.get(id) !== attempt) return false;
      this.syncStageManagement();
      return this.stageManagementOwner === owner && this.stageManagementPending.get(id) === attempt;
    };
    void (async () => {
      try { await (remove ? owner.client.removeFromStage(id) : forceMuted ? owner.client.forceUnmute(id) : owner.client.forceMute(id)); }
      catch (error) { if (current() && this.stageManagementRows.get(id)?.node === node) this.show(error); }
      finally { if (current()) { this.stageManagementPending.delete(id); this.syncStageManagement(); } }
    })();
  }

  private stageGainDraft(input: HTMLInputElement): number | undefined {
    const draft = input.value.trim();
    // Number('') is zero and Number('0x10') is hexadecimal, neither is a decimal draft.
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(draft)) return undefined;
    const gain = Number(draft);
    return Number.isFinite(gain) && Math.abs(gain) <= MAX_GAIN_DB ? gain : undefined;
  }

  private applyStageGain(id: string, node: HTMLLIElement): void {
    this.syncStageManagement();
    const owner = this.stageManagementOwner, row = this.stageManagementRows.get(id);
    if (!owner || !row || row.node !== node) return;
    const mounted = (): boolean => node.isConnected && this.stageManagementRows.get(id) === row && this.stageManagementList.contains(node)
      && node.contains(row.gainInput) && node.contains(row.gainApply);
    const current = (): boolean => this.stageManagementOwner === owner && this.current === owner.client
      && this.generation === owner.generation && this.isConnected && !this.stageManagementPanel.hidden
      && owner.client.state?.roomId === owner.roomId && owner.client.me?.participantId === owner.participantId
      && owner.client.me?.role === 'controller' && this.stageManagementTerminalClient !== owner.client;
    const eligible = (): boolean => current() && mounted() && (owner.client.status === 'waiting' || owner.client.status === 'live')
      && owner.client.me?.connected === true && !this.stageTransferAttempt && typeof owner.client.setGain === 'function'
      && Boolean(owner.client.state?.speakers.find(person => person.participantId === id && person.role === 'speaker' && person.onStage));
    const gain = this.stageGainDraft(row.gainInput);
    if (!eligible() || this.stageManagementPending.has(id) || gain === undefined) return;
    const attempt = {};
    this.stageManagementPending.set(id, attempt);
    const owns = (): boolean => this.stageManagementOwner === owner && this.stageManagementPending.get(id) === attempt;
    void (async () => {
      try {
        this.syncStageManagement();
        // Rendering disabled controls can synchronously reenter host code and retire this row or owner.
        if (!owns() || !eligible()) return;
        await owner.client.setGain(id, gain);
      } catch (error) {
        if (owns()) {
          try { this.syncStageManagement(); } catch { /* A failed DOM write remains retryable on the next reconciliation. */ }
          if (owns() && current() && mounted()) this.show(error);
        }
      } finally {
        // Release by token identity before rendering, even if a host DOM setter throws again.
        if (owns()) {
          this.stageManagementPending.delete(id);
          try { this.syncStageManagement(); }
          catch (error) { if (current() && mounted()) this.show(error); }
        }
      }
    })();
  }

  private noteStageTransferEvent(type: keyof StageEventMap, detail: StageEventMap[keyof StageEventMap]): void {
    const owner = this.stageManagementOwner;
    if (!owner) return;
    if ((type === 'closed' || type === 'kicked' || (type === 'status' && (detail === 'reconnecting' || detail === 'disconnected')))
      && this.stageTransferAttempt) this.stageTransferAttempt.invalid = true;
    const role = type === 'role' ? detail as StageEventMap['role'] : undefined;
    const left = type === 'stageleft' ? detail as StageEventMap['stageleft'] : undefined;
    const transferred = type === 'transferred' ? detail as StageEventMap['transferred'] : undefined;
    const managed = (id: string): boolean => this.stageManagementRows.has(id) || this.stageTransferAttempt?.id === id;
    if ((role && (role.participantId === owner.participantId ? role.role !== 'controller' : role.role !== 'speaker' && managed(role.participantId)))
      || (left && managed(left.participantId))
      || (transferred && transferred.fromId === owner.participantId && transferred.toId !== owner.participantId)) {
      // These SDK notifications precede their snapshot; fence handoffs without inventing role state.
      owner.transferRevision++; owner.transferAwaitingState = true;
      if (this.stageTransferAttempt) this.stageTransferAttempt.invalid = true;
    }
    const client = this.current, state = client?.state, me = client?.me;
    if (owner !== this.stageManagementOwner) return;
    const sameController = owner.client === client && owner.generation === this.generation
      && state?.roomId === owner.roomId && me?.participantId === owner.participantId
      && me.role === 'controller' && me.connected === true;
    // A replacement snapshot can emit status before state; observe its own-seat loss before DOM sync.
    if (!sameController) {
      owner.transferRevision++; owner.transferAwaitingState = true;
      if (this.stageTransferAttempt) this.stageTransferAttempt.invalid = true;
    }
    if (type === 'state') { owner.transferAwaitingState = !sameController; return; }
  }

  private canTransferStage(id: string, node: HTMLLIElement): boolean {
    const owner = this.stageManagementOwner, client = owner?.client;
    return Boolean(owner && client && !owner.transferAwaitingState && this.stageManagementPending.size === 0
      && !this.stageManagementPanel.hidden && this.stageManagementRows.get(id)?.node === node
      && (client.status === 'waiting' || client.status === 'live') && client.me?.connected === true
      && typeof client.transferControl === 'function' && typeof window.confirm === 'function'
      && id !== owner.participantId && client.state?.speakers.find(person => person.participantId === id
        && person.role === 'speaker' && person.onStage)?.connected === true);
  }

  private transferStageControl(id: string, node: HTMLLIElement): void {
    const dialog = {};
    this.stageTransferDialogs.add(dialog);
    const releaseDialog = (): void => { this.stageTransferDialogs.delete(dialog); };
    try {
      // Reconcile even when a close dialog excludes this admission.
      this.syncStageManagement();
      const owner = this.stageManagementOwner;
      if (this.roomCloseDialog || !owner || this.stageTransferAttempt || !this.canTransferStage(id, node)) { releaseDialog(); return; }
      const attempt = { id, node, revision: owner.transferRevision, invalid: false };
      this.stageTransferAttempt = attempt; this.syncStageManagement();
      const current = (): boolean => {
        if (this.stageManagementOwner !== owner || this.stageTransferAttempt !== attempt) return false;
        this.syncStageManagement();
        return this.stageManagementOwner === owner && this.stageTransferAttempt === attempt;
      };
      const eligible = (): boolean => current() && !attempt.invalid && owner.transferRevision === attempt.revision && this.canTransferStage(id, node);
      void (async () => {
        try {
          if (!eligible()) return;
          const target = owner.client.state!.speakers.find(person => person.participantId === id && person.role === 'speaker' && person.onStage)!;
          if (!window.confirm(`確定將控制權移交給 ${decodeName(target.name)}？你將失去主控權限，但保留目前台位並留在房間。`) || !eligible()) return;
          this.hideError();
          const result = owner.client.transferControl(id);
          releaseDialog();
          await result;
        } catch (error) {
          if (current() && !attempt.invalid && this.stageManagementRows.get(id)?.node === node) this.show(error);
        } finally {
          releaseDialog();
          if (current()) { this.stageTransferAttempt = undefined; this.syncStageManagement(); }
        }
      })();
    } catch (error) { releaseDialog(); throw error; }
  }

  private retireRoomNameOwner(): void {
    this.roomNameOwner = undefined; this.roomNameAttempt = undefined;
    this.roomNameInput.value = ''; this.acceptedRoomName.textContent = '';
    if (!this.roomNamePanel.hidden) this.roomNamePanel.hidden = true;
    if (!this.roomNameUpdate.disabled) this.roomNameUpdate.disabled = true;
    if (!this.roomNameInput.disabled) this.roomNameInput.disabled = true;
    if (this.roomNameUpdate.hasAttribute('aria-busy')) this.roomNameUpdate.removeAttribute('aria-busy');
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
    if (this.roomNamePanel.hidden) this.roomNamePanel.hidden = false;
    if (this.roomNameInput.disabled) this.roomNameInput.disabled = false;
    const disabled = client.status === 'reconnecting' || Boolean(this.roomNameAttempt);
    if (this.roomNameUpdate.disabled !== disabled) this.roomNameUpdate.disabled = disabled;
    const busy = String(Boolean(this.roomNameAttempt));
    if (this.roomNameUpdate.getAttribute('aria-busy') !== busy) this.roomNameUpdate.setAttribute('aria-busy', busy);
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

  private retireAudioRecovery(): void {
    this.audioRecoveryOwner = undefined; this.audioRecoveryAttempt = undefined;
    this.audioRecoveryComplete = false;
    this.audioRetry.hidden = this.audioRetry.disabled = true;
    this.audioRetry.setAttribute('aria-busy', 'false');
    this.audioRecovery.hidden = true; this.audioRecovery.textContent = '';
  }

  private syncAudioRecovery(): void {
    const client = this.current, state = client?.state, me = client?.me;
    const active = client?.status === 'waiting' || client?.status === 'live';
    // A pre-ACK socket loss can leave a snapshot behind. Only a later state event reopens this lane.
    if (client?.status === 'disconnected') this.audioRecoveryTerminalClient = client;
    if (!this.isConnected || !client || !state?.roomId || !me?.participantId || this.audioRecoveryTerminalClient === client
      || (!active && client.status !== 'reconnecting')) {
      this.retireAudioRecovery(); return;
    }
    const owner = this.audioRecoveryOwner;
    if (!owner || owner.client !== client || owner.generation !== this.generation
      || owner.roomId !== state.roomId || owner.participantId !== me.participantId) {
      this.retireAudioRecovery();
      if (!active) return;
      this.audioRecoveryOwner = { client, roomId: state.roomId, participantId: me.participantId, generation: this.generation };
    }
    if (!active) this.audioRecoveryComplete = false;
    const pending = Boolean(this.audioRecoveryAttempt);
    this.audioRetry.hidden = false; this.audioRetry.disabled = !active || pending;
    this.audioRetry.setAttribute('aria-busy', String(pending));
    const text = !active ? '' : pending ? '正在重新協商音訊連線…' : this.audioRecoveryComplete ? '音訊連線協商已完成。' : '';
    this.audioRecovery.hidden = !text;
    if (this.audioRecovery.textContent !== text) this.audioRecovery.textContent = text;
  }

  private retryAudio(): void {
    this.syncAudioRecovery();
    const owner = this.audioRecoveryOwner;
    if (!owner || this.audioRetry.hidden || this.audioRetry.disabled || this.audioRecoveryAttempt
      || (owner.client.status !== 'waiting' && owner.client.status !== 'live')) return;
    // The public method may synchronously emit, throw or reenter through a host callback.
    const attempt = this.audioRecoveryAttempt = {};
    this.audioRecoveryComplete = false;
    this.syncAudioRecovery(); this.hideError();
    const current = () => {
      if (this.audioRecoveryOwner !== owner || this.audioRecoveryAttempt !== attempt) return false;
      this.syncAudioRecovery();
      return this.audioRecoveryOwner === owner && this.audioRecoveryAttempt === attempt;
    };
    void (async () => {
      try {
        await owner.client.retryAudioConnection();
        if (current() && (owner.client.status === 'waiting' || owner.client.status === 'live')) this.audioRecoveryComplete = true;
      } catch (error) {
        if (current() && (owner.client.status === 'waiting' || owner.client.status === 'live')) this.show(error);
      } finally {
        if (current()) { this.audioRecoveryAttempt = undefined; this.syncAudioRecovery(); }
      }
    })();
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

  private replaceOutputDeviceOptions(outputs: readonly MediaDeviceInfo[], draft: string): void {
    const initial = document.createElement('option');
    initial.value = ''; initial.textContent = '系統預設';
    const options = [initial], seen = new Set<string>(['']);
    for (const device of outputs) {
      if (device.kind !== 'audiooutput' || !device.deviceId || seen.has(device.deviceId)) continue;
      seen.add(device.deviceId);
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.textContent = device.label.trim() ? device.label : `輸出裝置 ${options.length}`;
      options.push(option);
    }
    if (draft && !seen.has(draft)) {
      const unavailable = document.createElement('option');
      unavailable.value = draft; unavailable.textContent = '先前選擇（目前清單未提供）';
      unavailable.disabled = true; options.push(unavailable);
    }
    this.outputDeviceSelect.replaceChildren(...options);
    this.outputDeviceSelect.value = draft;
  }

  private retireOutputDeviceOwner(): void {
    if (this.outputDeviceOwner || this.outputDeviceSelect.children.length !== 1 || this.outputDeviceSelect.value !== '') {
      this.replaceOutputDeviceOptions([], '');
    }
    this.outputDeviceOwner = undefined; this.outputDeviceAttempt = undefined;
    this.outputDevicePanel.hidden = this.outputDeviceUnsupported.hidden = true;
    this.outputDeviceSelect.disabled = this.outputDeviceRefresh.disabled = this.outputDeviceApply.disabled = true;
    this.outputDeviceRefresh.removeAttribute('aria-busy'); this.outputDeviceApply.removeAttribute('aria-busy');
  }

  private syncOutputDeviceOwner(): void {
    const client = this.current, state = client?.state, me = client?.me;
    const active = client?.status === 'waiting' || client?.status === 'live';
    const owner = this.outputDeviceOwner;
    if (!this.isConnected || !client || (owner && (owner.client !== client || owner.generation !== this.generation))) {
      this.retireOutputDeviceOwner();
    }
    if (!this.isConnected || !client) return;
    const joined = Boolean(state?.roomId && me?.participantId) && this.outputDeviceTerminalClient !== client;
    if (!this.outputDeviceOwner && joined && active) {
      this.outputDeviceOwner = { client, generation: this.generation, draft: '' };
    }
    // setSinkId targets this client's persistent audio and cannot be cancelled by losing a seat.
    // Keep its draft, list and reservation until settlement or an actual client/generation replacement.
    this.outputDevicePanel.hidden = !this.outputDeviceOwner || !joined || (!active && client.status !== 'reconnecting');
    const supported = client.outputDeviceSupported;
    this.outputDeviceUnsupported.hidden = supported;
    const blocked = this.outputDevicePanel.hidden || !active || !supported || Boolean(this.outputDeviceAttempt);
    this.outputDeviceSelect.disabled = this.outputDeviceRefresh.disabled = this.outputDeviceApply.disabled = blocked;
    this.outputDeviceRefresh.setAttribute('aria-busy', String(this.outputDeviceAttempt?.kind === 'refresh'));
    this.outputDeviceApply.setAttribute('aria-busy', String(this.outputDeviceAttempt?.kind === 'apply'));
    this.outputDeviceSelect.value = this.outputDeviceOwner?.draft ?? '';
  }

  private refreshOutputDevices(): void {
    this.syncOutputDeviceOwner();
    const owner = this.outputDeviceOwner;
    if (!owner || this.outputDevicePanel.hidden || this.outputDeviceRefresh.hidden || this.outputDeviceRefresh.disabled
      || this.outputDeviceAttempt) return;
    const attempt = this.outputDeviceAttempt = { kind: 'refresh' as const };
    this.syncOutputDeviceOwner(); this.hideError();
    const current = (): boolean => {
      if (this.outputDeviceOwner !== owner || this.outputDeviceAttempt !== attempt) return false;
      this.syncOutputDeviceOwner();
      return this.outputDeviceOwner === owner && this.outputDeviceAttempt === attempt;
    };
    void (async () => {
      try {
        const devices = await owner.client.listAudioDevices();
        if (current()) this.replaceOutputDeviceOptions(devices.outputs, owner.draft);
      } catch (error) {
        if (current() && !this.outputDevicePanel.hidden
          && (owner.client.status === 'waiting' || owner.client.status === 'live')) this.show(error);
      } finally {
        if (current()) { this.outputDeviceAttempt = undefined; this.syncOutputDeviceOwner(); }
      }
    })();
  }

  private applyOutputDevice(): void {
    this.syncOutputDeviceOwner();
    const owner = this.outputDeviceOwner;
    if (!owner || this.outputDevicePanel.hidden || this.outputDeviceApply.hidden || this.outputDeviceApply.disabled
      || this.outputDeviceAttempt) return;
    const draft = owner.draft;
    const attempt = this.outputDeviceAttempt = { kind: 'apply' as const };
    this.syncOutputDeviceOwner(); this.hideError();
    const current = (): boolean => {
      if (this.outputDeviceOwner !== owner || this.outputDeviceAttempt !== attempt) return false;
      this.syncOutputDeviceOwner();
      return this.outputDeviceOwner === owner && this.outputDeviceAttempt === attempt;
    };
    void (async () => {
      try { await owner.client.setOutputDevice(draft); }
      catch (error) {
        if (current() && !this.outputDevicePanel.hidden
          && (owner.client.status === 'waiting' || owner.client.status === 'live')) this.show(error);
      } finally {
        // Browser fulfillment is not evidence of playback or an authoritative hardware selection.
        if (current()) { this.outputDeviceAttempt = undefined; this.syncOutputDeviceOwner(); }
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
    const valueText = `${percent}%`;
    if (this.volume.getAttribute('aria-valuetext') !== valueText) this.volume.setAttribute('aria-valuetext', valueText);
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
    this.syncOccupancy();
    this.syncAudioRecovery();
    this.syncPlaybackOwner();
    this.syncMicRetry();
    this.syncMicrophoneOwner();
    this.syncOutputDeviceOwner();
    this.syncNameOwner();
    this.syncRoomNameOwner();
    this.syncHandQueue();
    this.syncStageManagement();
    this.syncRoomClose();
    this.syncQualityOwner();
    this.syncSpeakingOwner();
    this.syncConnectionStats();
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
    const pressed = String(this.playbackMuted);
    if (this.listen.getAttribute('aria-pressed') !== pressed) this.listen.setAttribute('aria-pressed', pressed);
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
