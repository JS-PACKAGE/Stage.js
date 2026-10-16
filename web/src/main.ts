import { MAX_GAIN_DB, StageClient, decodeName } from '../../packages/client/src/index.ts';
import type { ConnectionQuality, MicTest, ParticipantView, RoomStatePayload } from '../../packages/client/src/index.ts';
import './styles.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
const params = new URLSearchParams(location.search);
function signalingSettings(value: string): { url: string; path: string; error?: string } {
  const fallback = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`;
  try {
    const path = value.trim() || '/ws';
    if (!path.startsWith('/') || path.startsWith('//') || /[\p{Cc}\\?#]/u.test(value) || /\s/u.test(path)
      || path.split('/').some(segment => /^\.{1,2}$/.test(segment.replace(/%2e/gi, '.')))) throw new Error();
    const url = new URL(path, location.origin);
    if (url.origin !== location.origin || url.search || url.hash) throw new Error();
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return { url: url.href, path: url.pathname };
  } catch {
    // Keep the page usable, but block entry below; this safe placeholder is never a fallback connection.
    return { url: fallback, path: '/ws', error: 'WebSocket 路徑無效，請修正網址中的 wsPath（例如 /ws）後重新載入。' };
  }
}
const signaling = signalingSettings(params.get('wsPath') ?? '/ws');
const client = new StageClient({ url: signaling.url });
const PLAYBACK_STORAGE_KEY = 'stage-playback';
function restorePlaybackPreferences(): void {
  try {
    const raw = localStorage.getItem(PLAYBACK_STORAGE_KEY);
    if (!raw || raw.length > 128) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const prefs = parsed as Record<string, unknown>;
    if (prefs.version !== 1 || typeof prefs.volume !== 'number' || !Number.isFinite(prefs.volume)
      || prefs.volume < 0 || prefs.volume > 1 || typeof prefs.muted !== 'boolean') return;
    client.setPlaybackVolume(prefs.volume);
    client.setPlaybackMuted(prefs.muted);
  } catch { /* Unavailable or invalid storage must not prevent listening. */ }
}
function savePlaybackPreferences(): void {
  try {
    localStorage.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify({ version: 1, volume: client.playbackVolume, muted: client.playbackMuted }));
  } catch { /* Local controls still apply when storage is blocked or full. */ }
}
restorePlaybackPreferences();
const statusLabels = { waiting: '等待發言', live: '直播中', reconnecting: '重新連線中', disconnected: '未連線' };
const roleLabels = { controller: '主控', speaker: '發言者', audience: '觀眾' };
let busy = false;
let landingEntry: { operation: 'create' | 'join'; revision: number; cancelled: boolean; entered: boolean } | undefined;
let landingRevision = 0;
let audioBlocked = false;
let pendingAudioUnlock: symbol | undefined;
let micNotice = '';
let micRetryAvailable = false, micRetryPending = false;
let micRetryButton: HTMLButtonElement | undefined;
const STAGE_PERMISSION_NOTICE = '主控已邀請你上台，請允許麥克風權限。';
let invitation = '';
let stagePermissionOwner: { roomId: string; participantId: string; generation: number } | undefined;
let createdRoom: { roomId: string; code?: string } | null = null;
let renderedRoomSignature: string | undefined;
let renderedAudienceHeading: HTMLHeadingElement | undefined;
let renderedSpeakingSignature: string | undefined;
let renderedQualitySignature: string | undefined;
const renderedGainInputs: { input: HTMLInputElement; value: string }[] = [];
let cooldownButton: HTMLButtonElement | null = null;
/** Only the installed room view is retained; action state is still recomputed on every sync. */
let renderedRoomActions: (HTMLButtonElement | HTMLInputElement)[] = [];
let renderedReturnStage: HTMLButtonElement | null = null;
let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
let cooldownDue = 0;
let roomActionIdentity = '';
let roomActionGeneration = 0;
let inviteCopySequence = 0;
const pendingRoomActions = new Map<string, symbol>();
/** Latest server report per publisher; loss at or above this is flagged in the stage list. */
const POOR_LOSS_PERCENT = 5;
let quality = new Map<string, ConnectionQuality>();
/** Current rendered rows only; one participant can appear in both audience and hand lists. */
const personRows = new Map<string, HTMLElement[]>();
let speakingIds = new Set<string>();
/** Own connection, refreshed from `getStats()`; kept across re-renders of the room view. */
const connectionLine = element('p', 'muted connection');
const audioRetryNotice = element('p', 'muted');
audioRetryNotice.id = 'audio-retry-status'; audioRetryNotice.hidden = true;
audioRetryNotice.setAttribute('role', 'status');
const ownHandPosition = element('p', 'muted own-hand-position');
ownHandPosition.hidden = true; ownHandPosition.setAttribute('role', 'status');
const handRejectionNotice = element('p', 'banner hand-rejected');
handRejectionNotice.hidden = true; handRejectionNotice.setAttribute('role', 'status');
let handRejectionOwner: { roomId: string; participantId: string; generation: number } | undefined;
let handRejectionRoomActive = false;
function retireHandRejection(): void {
  handRejectionOwner = undefined;
  if (!handRejectionNotice.hidden) handRejectionNotice.hidden = true;
  if (handRejectionNotice.textContent) handRejectionNotice.textContent = '';
}
function eligibleHandRejection(): boolean {
  const me = client.state?.me;
  return Boolean(handRejectionRoomActive && me?.role === 'audience' && !me.onStage && !me.handRaised
    && client.status !== 'reconnecting' && client.status !== 'disconnected');
}
function syncHandRejection(): void {
  const owner = handRejectionOwner, state = client.state;
  if (!eligibleHandRejection() || (owner && (owner.generation !== roomActionGeneration
    || state?.roomId !== owner.roomId || state.me.participantId !== owner.participantId))) {
    retireHandRejection(); return;
  }
  if (!owner) return;
  const message = '主控已婉拒這次舉手申請。';
  if (handRejectionNotice.textContent !== message) handRejectionNotice.textContent = message;
  if (handRejectionOwner === owner && handRejectionNotice.hidden) handRejectionNotice.hidden = false;
}
let connectionPollSequence = 0;
let connectionResultWatermark = 0;
const header = element('header', 'topbar');
const brand = element('h1', '', 'Stage.js 音訊舞台');
const status = element('span', 'badge', statusLabels.disconnected);
const theme = element('select');
theme.setAttribute('aria-label', '色彩主題');
for (const [value, label] of [['system', '跟隨系統'], ['light', '淺色'], ['dark', '深色']]) {
  const option = element('option', '', label);
  option.value = value!;
  theme.append(option);
}
let savedTheme = 'system';
try { savedTheme = localStorage.getItem('stage-theme') ?? 'system'; } catch { /* Storage may be disabled in embedded browsers. */ }
if (!['light', 'dark', 'system'].includes(savedTheme)) savedTheme = 'system';
theme.value = savedTheme;
document.documentElement.dataset.theme = savedTheme;
theme.onchange = () => {
  document.documentElement.dataset.theme = theme.value;
  try { localStorage.setItem('stage-theme', theme.value); } catch { /* Theme still applies without storage. */ }
};
header.append(brand, status, theme);
const notices = element('div', 'notices');
notices.setAttribute('aria-live', 'polite');
const errorBox = element('p', 'banner error');
errorBox.hidden = true;
errorBox.setAttribute('role', 'alert');
const audienceFilter = element('section', 'panel audience-filter');
audienceFilter.hidden = true;
const audienceSearch = element('input');
audienceSearch.type = 'search'; audienceSearch.id = 'audience-search';
audienceSearch.autocomplete = 'off';
const audienceSearchLabel = element('label', '', '篩選觀眾名稱');
audienceSearchLabel.setAttribute('for', audienceSearch.id);
const audienceFilterCount = element('p', 'muted');
audienceFilterCount.setAttribute('role', 'status');
const audienceFilterClear = element('button', '', '清除篩選');
audienceFilterClear.type = 'button';
audienceFilter.append(audienceSearchLabel, audienceSearch, audienceFilterClear, audienceFilterCount);
let audienceFilterIdentity = '';
const audienceFilterRows: { row: HTMLLIElement; name: string }[] = [];
audienceSearch.oninput = () => { if (canFilterAudience()) applyAudienceFilter(); };
audienceFilterClear.onclick = () => {
  if (!canFilterAudience()) return;
  audienceSearch.value = ''; applyAudienceFilter();
};
const content = element('main');
app.append(header, notices, errorBox, audienceFilter, content);
const stageQuality = element('details', 'panel stage-quality');
stageQuality.id = 'stage-quality'; stageQuality.hidden = true;
const stageQualitySummary = element('summary', '', '舞台連線品質');
const stageQualityStatus = element('p', 'muted stage-quality-status');
const stageQualityList = element('ul', 'stage-quality-list');
stageQuality.append(stageQualitySummary, stageQualityStatus, stageQualityList);
app.append(stageQuality);
let stageQualityIdentity = '';
let stageQualitySuppressedState: RoomStatePayload | undefined;
let stageQualityRevision = 0;
let stageQualityReconnecting = false;
let stageQualityReports = new Map<string, ConnectionQuality>();
const stageQualityRows = new Map<string, HTMLLIElement>();
let stageQualityOrder: string[] = [];
function qualityDetailsUpdate(): () => boolean {
  const revision = ++stageQualityRevision, state = client.state, generation = roomActionGeneration;
  return () => revision === stageQualityRevision && state === client.state && generation === roomActionGeneration;
}
function clearQualityDetailsReports(): void {
  stageQualityReports.clear(); stageQualityRows.clear(); stageQualityOrder = [];
  stageQualityList.replaceChildren();
}
function resetQualityDetails(current = qualityDetailsUpdate()): boolean {
  stageQualityIdentity = ''; stageQualityReconnecting = false;
  stageQualityReports.clear(); stageQualityRows.clear(); stageQualityOrder = [];
  stageQuality.hidden = true;
  if (!current()) return false;
  stageQuality.removeAttribute('open');
  if (!current()) return false;
  stageQualityStatus.textContent = '';
  if (!current()) return false;
  stageQualityList.replaceChildren();
  return current();
}
function suppressQualityDetails(): void {
  const state = client.state;
  if (!state || stageQualitySuppressedState === state) return;
  // Role/stage deltas precede their snapshot; reserve loss before any observable reset.
  stageQualitySuppressedState = state;
  resetQualityDetails();
}
/** Reports have no timestamp or room epoch; accept them only in the current eligible view. */
function syncQualityDetails(reports?: readonly ConnectionQuality[]): void {
  const state = client.state, me = state?.me, current = qualityDetailsUpdate();
  if (stageQualitySuppressedState || !state || !me || (me.role !== 'controller' && !me.onStage)) {
    resetQualityDetails(current); return;
  }
  const identity = JSON.stringify([state.roomId, me.participantId]);
  if (identity !== stageQualityIdentity) {
    if (!resetQualityDetails(current)) return;
    stageQualityIdentity = identity;
  }
  stageQuality.hidden = false;
  if (!current()) return;
  const reconnecting = client.status === 'reconnecting', clearReports = reconnecting && !stageQualityReconnecting;
  stageQualityReconnecting = reconnecting;
  if (clearReports) { clearQualityDetailsReports(); if (!current()) return; }
  const speakers = state.speakers.filter(person => person.onStage);
  const ids = new Set(speakers.map(person => person.participantId));
  if (reports !== undefined && !reconnecting) {
    // Copy primitive fields rather than retaining mutable event objects; each report replaces the last.
    stageQualityReports = new Map(reports.filter(report => ids.has(report.participantId)).map(report => [report.participantId, {
      participantId: report.participantId, uplinkLossPercent: report.uplinkLossPercent,
      downlinkLossPercent: report.downlinkLossPercent, rttMs: report.rttMs,
    }]));
  }
  for (const id of stageQualityReports.keys()) if (!ids.has(id)) stageQualityReports.delete(id);
  const percent = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? `${value.toFixed(1)}%` : '—';
  const rtt = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${Math.round(value)} ms` : '—';
  const order: string[] = [];
  for (const person of speakers) {
    const report = stageQualityReports.get(person.participantId);
    if (!report) continue;
    order.push(person.participantId);
    let row = stageQualityRows.get(person.participantId);
    if (!row) { row = element('li'); row.dataset.participantId = person.participantId; stageQualityRows.set(person.participantId, row); }
    const text = `${decodeName(person.name)}：上行掉包 ${percent(report.uplinkLossPercent)} · 下行掉包 ${percent(report.downlinkLossPercent)} · RTT ${rtt(report.rttMs)}`;
    if (row.textContent !== text) row.textContent = text;
    if (!current()) return;
  }
  for (const id of stageQualityRows.keys()) if (!order.includes(id)) stageQualityRows.delete(id);
  if (order.length !== stageQualityOrder.length || order.some((id, index) => id !== stageQualityOrder[index])) {
    stageQualityOrder = order;
    stageQualityList.replaceChildren(...order.map(id => stageQualityRows.get(id)!));
    if (!current()) return;
  }
  stageQualityStatus.textContent = order.length
    ? '最近收到的伺服器回報；RTT 不是端到端音訊延遲。'
    : `${reconnecting ? '重新連線中；' : ''}尚未收到目前發言者的品質回報。`;
}

const settings = element('section', 'panel audio-settings');
settings.append(element('h2', '', '音訊設定'));
const micSelect = element('select');
micSelect.id = 'microphone-device';
const speakerSelect = element('select');
speakerSelect.id = 'speaker-device';
for (const [label, select] of [['麥克風', micSelect], ['揚聲器', speakerSelect]] as const) {
  const wrapper = element('label', 'field', label);
  wrapper.append(select);
  settings.append(wrapper);
}
speakerSelect.disabled = !client.outputDeviceSupported;
if (!client.outputDeviceSupported) settings.append(element('p', 'muted', '此瀏覽器不支援選擇揚聲器，將使用系統預設輸出。'));
const playbackLabel = element('label', 'field', '收聽音量');
const playbackVolume = element('input');
playbackVolume.id = 'playback-volume';
playbackVolume.type = 'range';
playbackVolume.min = '0'; playbackVolume.max = '100'; playbackVolume.step = '1';
playbackVolume.value = String(Math.round(client.playbackVolume * 100));
const playbackValue = element('output', '', `${playbackVolume.value}%`);
playbackValue.htmlFor.value = playbackVolume.id;
playbackVolume.oninput = () => {
  client.setPlaybackVolume(Number(playbackVolume.value) / 100);
  playbackValue.value = `${Math.round(client.playbackVolume * 100)}%`;
  savePlaybackPreferences();
};
playbackLabel.append(playbackVolume, playbackValue);
const playbackMute = button(client.playbackMuted ? '恢復收聽' : '靜音收聽', async () => {
  client.setPlaybackMuted(!client.playbackMuted);
  playbackMute.textContent = client.playbackMuted ? '恢復收聽' : '靜音收聽';
  playbackMute.setAttribute('aria-pressed', String(client.playbackMuted));
  savePlaybackPreferences();
});
playbackMute.id = 'playback-mute';
playbackMute.setAttribute('aria-label', '靜音收聽');
playbackMute.setAttribute('aria-pressed', String(client.playbackMuted));
settings.append(playbackLabel, playbackMute, element('p', 'muted', '僅調整你聽到的聲音，不影響麥克風或其他人。'));
let micTest: MicTest | null = null;
let testingBusy = false;
let micSettingsGeneration = 0;
let previewCapture: AbortController | undefined;
let selectedInput = '';
let selectedOutput = '';
let deviceRefreshSequence = 0;
const testButton = button('測試麥克風', async () => {
  if (testingBusy || client.me?.onStage) return;
  const generation = micSettingsGeneration;
  testingBusy = true;
  micSelect.disabled = true; syncMeter();
  try {
    if (micTest) { micTest.stop(); micTest = null; }
    else {
      const preview = await capturePreview();
      if (!preview) return;
      if (generation !== micSettingsGeneration) { preview.stop(); return; }
      micTest = preview;
    }
    testButton.textContent = micTest ? '停止測試' : '測試麥克風';
    testButton.setAttribute('aria-pressed', String(Boolean(micTest)));
  } catch (error) { if (generation === micSettingsGeneration) throw error; }
  finally { if (generation === micSettingsGeneration) { testingBusy = false; micSelect.disabled = false; syncMeter(); } }
});
testButton.id = 'mic-test';
testButton.setAttribute('aria-pressed', 'false');
const cancelTestButton = element('button', '', '取消麥克風測試');
cancelTestButton.id = 'mic-test-cancel'; cancelTestButton.type = 'button';
cancelTestButton.onclick = () => {
  if (!previewCapture || client.me?.onStage) return;
  cancelPreviewCapture(); syncMeter();
};
const levelLabel = element('label', 'mic-level-label', '麥克風音量');
const level = element('meter', 'mic-level');
level.id = 'mic-level';
level.min = 0; level.max = 1; level.value = 0;
levelLabel.append(level);
settings.append(testButton, cancelTestButton, levelLabel);
app.append(settings);
micSelect.onchange = () => {
  if (testingBusy) return;
  const generation = micSettingsGeneration;
  const deviceId = micSelect.value;
  micSelect.disabled = true;
  testingBusy = true; syncMeter();
  void run(async () => {
    try {
      await client.setInputDevice(deviceId);
      if (generation !== micSettingsGeneration) return;
      selectedInput = deviceId;
      syncMeter();
      if (micTest) {
        micTest.stop(); micTest = null;
        testButton.textContent = '測試麥克風'; testButton.setAttribute('aria-pressed', 'false');
        const preview = await capturePreview();
        if (!preview) return;
        if (generation !== micSettingsGeneration) { preview.stop(); return; }
        micTest = preview;
        testButton.textContent = '停止測試'; testButton.setAttribute('aria-pressed', 'true');
      }
    } catch (error) { if (generation === micSettingsGeneration) throw error; }
  }).finally(() => {
    if (generation !== micSettingsGeneration) return;
    testingBusy = false; micSelect.disabled = false; restoreDeviceSelection(micSelect, selectedInput); syncMeter();
  });
};
speakerSelect.onchange = () => {
  const deviceId = speakerSelect.value;
  speakerSelect.disabled = true;
  void run(async () => { await client.setOutputDevice(deviceId); selectedOutput = deviceId; })
    .finally(() => { speakerSelect.disabled = false; restoreDeviceSelection(speakerSelect, selectedOutput); });
};
function restoreDeviceSelection(select: HTMLSelectElement, chosen: string): void {
  for (const option of Array.from(select.options)) {
    if (option.dataset.unlisted === 'true') option.remove();
  }
  if (chosen && !Array.from(select.options).some(option => option.value === chosen)) {
    const option = element('option', '', '已選擇的裝置（目前未列出）');
    option.value = chosen; option.disabled = true; option.dataset.unlisted = 'true';
    select.append(option);
  }
  select.value = chosen;
}
async function refreshDevices(): Promise<void> {
  const sequence = ++deviceRefreshSequence;
  const devices = await client.listAudioDevices();
  if (sequence !== deviceRefreshSequence) return;
  for (const [select, list, chosen] of [[micSelect, devices.inputs, selectedInput], [speakerSelect, devices.outputs, selectedOutput]] as const) {
    const defaultOption = element('option', '', '系統預設');
    defaultOption.value = '';
    select.replaceChildren(defaultOption);
    for (const [index, device] of list.entries()) {
      const option = element('option', '', device.label || `音訊裝置 ${index + 1}`);
      option.value = device.deviceId;
      select.append(option);
    }
    restoreDeviceSelection(select, chosen);
  }
}
client.on('micready', () => {
  const owner = stagePermissionOwner, state = client.state;
  // micready confirms capture, not sender installation; only retire this seat's permission prompt.
  if (owner && state?.me.onStage && owner.generation === roomActionGeneration
    && owner.roomId === state.roomId && owner.participantId === state.me.participantId) {
    if (invitation === STAGE_PERMISSION_NOTICE) invitation = '';
    stagePermissionOwner = undefined;
  }
  micRetryAvailable = micRetryPending = false; micNotice = ''; renderNotices(); void refreshDevices().catch(() => {});
});
navigator.mediaDevices?.addEventListener('devicechange', () => { void refreshDevices().catch(() => {}); });
void refreshDevices().catch(() => {});
// Reserve public snapshot ownership before existing UI callbacks can reenter the SDK.
client.on('state', prepareOccupancyState);
client.on('status', prepareOccupancyStatus);
client.on('closed', retireOccupancy);
client.on('kicked', retireOccupancy);
/** Muted room microphones have a known zero level; only previews or unmuted stage mics need polling. */
let meterTimer: ReturnType<typeof setInterval> | undefined;
/** Only preview capture is abortable here, never setInputDevice or the room microphone. */
function cancelPreviewCapture(): void {
  const capture = previewCapture;
  previewCapture = undefined;
  cancelTestButton.hidden = cancelTestButton.disabled = true;
  capture?.abort();
}
async function capturePreview(): Promise<MicTest | null> {
  const capture = new AbortController();
  previewCapture = capture; syncMeter();
  try {
    const preview = await client.startMicTest({ signal: capture.signal });
    if (capture.signal.aborted) { preview.stop(); return null; }
    return preview;
  } catch (error) {
    if (!capture.signal.aborted) throw error;
    return null;
  } finally {
    if (previewCapture === capture) { previewCapture = undefined; syncMeter(); }
  }
}
/** Leave/rejoin releases the UI immediately; late previews still dispose only their own stream. */
function resetMicSettings(): void {
  micSettingsGeneration++;
  cancelPreviewCapture();
  micTest?.stop(); micTest = null; testingBusy = false;
  micSelect.disabled = false; restoreDeviceSelection(micSelect, selectedInput);
  testButton.textContent = '測試麥克風'; testButton.setAttribute('aria-pressed', 'false');
  syncMeter();
}
function syncMeter(): void {
  if (client.me?.onStage && previewCapture) cancelPreviewCapture();
  cancelTestButton.hidden = cancelTestButton.disabled = !previewCapture;
  if (micTest && (client.me?.onStage || micTest.stopped === true)) {
    micTest.stop(); micTest = null;
    testButton.textContent = '測試麥克風'; testButton.setAttribute('aria-pressed', 'false');
  }
  testButton.disabled = testingBusy || Boolean(client.me?.onStage);
  // Lifecycle cleanup above must still run while the page is hidden.
  const metering = !document.hidden && (Boolean(micTest) || Boolean(client.me?.onStage && !client.me.muted));
  if (metering && meterTimer === undefined) {
    const timer = setInterval(() => {
      // A canceled callback may already be queued, including across hide/show.
      if (meterTimer !== timer || document.hidden) return;
      if (micTest?.stopped === true) { syncMeter(); return; }
      level.value = client.me?.onStage ? client.micLevel : micTest?.level() ?? 0;
    }, 50);
    meterTimer = timer;
  } else if (!metering && meterTimer !== undefined) {
    clearInterval(meterTimer); meterTimer = undefined; level.value = 0;
  }
}
client.on('state', syncMeter);
client.on('status', syncMeter);

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(label: string, action: () => Promise<unknown>, className = '', generation?: number): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.onclick = () => { void run(action, node, generation); };
  return node;
}
async function run(action: () => Promise<unknown>, target?: HTMLButtonElement, generation?: number, reportError: () => boolean = () => true, formatError?: (error: unknown) => string): Promise<void> {
  if (target) target.disabled = true;
  errorBox.hidden = true;
  try { await action(); }
  catch (error) {
    if (reportError() && (generation === undefined || generation === roomActionGeneration)) showError(formatError ? formatError(error) : error instanceof Error ? error.message : '操作失敗，請稍後再試。');
  }
  finally { if (target?.isConnected) target.disabled = false; updateCooldown(); syncMeter(); }
}
/** Room controls retain their pending state when snapshots replace their DOM nodes. */
function resetRoomActions(identity: string): number {
  if (roomActionIdentity === identity) return roomActionGeneration;
  roomActionIdentity = identity; const generation = ++roomActionGeneration; pendingRoomActions.clear();
  audioRetryNotice.hidden = true; audioRetryNotice.textContent = '';
  handRejectionRoomActive = identity !== ''; retireHandRejection();
  pendingAudioUnlock = undefined;
  micRetryAvailable = micRetryPending = false; micNotice = '';
  // Retire the previous seat's history only after its actions and polls have lost ownership.
  if (generation !== roomActionGeneration) return generation;
  connectionLine.textContent = '';
  if (generation === roomActionGeneration) connectionLine.classList.toggle('error', false);
  return generation;
}
function roomButton(key: string, label: string, action: () => Promise<unknown>, className = '', canAct?: () => boolean): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button'; node.dataset.roomAction = key;
  const generation = roomActionGeneration;
  node.onclick = () => {
    if (node.disabled || client.status === 'disconnected' || client.status === 'reconnecting'
      || generation !== roomActionGeneration || pendingRoomActions.has(key) || (canAct && !canAct())) return;
    const token = Symbol(key); pendingRoomActions.set(key, token);
    updateCooldown(); errorBox.hidden = true;
    void (async () => {
      try {
        const result = action();
        // raiseHand starts its local cooldown synchronously, before the ACK arrives.
        if (generation === roomActionGeneration) updateCooldown();
        await result;
      }
      catch (error) {
        if (generation === roomActionGeneration) showError(error instanceof Error ? error.message : '操作失敗，請稍後再試。');
      } finally {
        if (generation === roomActionGeneration && pendingRoomActions.get(key) === token) {
          pendingRoomActions.delete(key); updateCooldown(); syncMeter();
        }
      }
    })();
  };
  return node;
}
function syncRoomActions(): void {
  for (const node of renderedRoomActions) {
    const key = node.dataset.roomAction!;
    const pending = pendingRoomActions.has(key);
    node.setAttribute('aria-busy', String(pending));
    node.disabled = pending || client.status === 'reconnecting' || client.status === 'disconnected'
      || node.dataset.policyDisabled === 'true'
      || (key === 'hand' && !client.me?.handRaised && client.handCooldownMs > 0);
  }
}
/** Both entry forms share one request lock, including after the landing view is replaced. */
function syncLandingActions(): void {
  for (const node of content.querySelectorAll<HTMLButtonElement>('[data-landing-submit]')) {
    node.disabled = busy;
    node.setAttribute('aria-busy', String(busy));
  }
  const cancel = content.querySelector<HTMLButtonElement>('[data-landing-cancel]');
  if (cancel) {
    cancel.hidden = cancel.disabled = !canCancelLanding();
  }
  const progress = content.querySelector<HTMLParagraphElement>('[data-landing-progress]');
  if (progress) {
    const pending = canCancelLanding() && landingEntry?.revision === landingRevision;
    progress.hidden = !pending;
    progress.textContent = pending ? landingEntry!.operation === 'create' ? '正在建立房間…' : '正在加入房間…' : '';
  }
}
function canCancelLanding(): boolean {
  return busy && Boolean(landingEntry && !landingEntry.cancelled && !landingEntry.entered) && !client.state;
}
function runLanding(operation: 'create' | 'join', action: (isCancelled: () => boolean) => Promise<unknown>): void {
  if (busy) return;
  if (signaling.error) { showError(signaling.error); return; }
  const revision = landingRevision;
  const entry = { operation, revision, cancelled: false, entered: false };
  retireOccupancy();
  landingEntry = entry; busy = true; syncLandingActions(); renderOccupancy();
  void run(() => action(() => entry.cancelled), undefined, undefined, () => !entry.cancelled, error => {
    const message = error instanceof Error ? error.message : '操作失敗，請稍後再試。';
    if (landingEntry !== entry || entry.entered || client.state || revision !== landingRevision
      || !(error instanceof Error) || !('code' in error)) return message;
    if (operation === 'join' && error.code === 'unauthorized') {
      return `${message}（unauthorized）\n請確認房間 ID 與代碼，或向主控索取最新邀請連結。`;
    }
    if (error.code !== 'bad_request') return message;
    const guidance = operation === 'create'
      ? '請檢查名稱、房間名稱及建立資料是否符合伺服器規則，或試著縮短名稱後重試。'
      : '請檢查房間 ID、名稱及代碼是否符合伺服器規則，必要時向主控確認後重試。';
    return `${message}（bad_request）\n${guidance}`;
  }).finally(() => {
    if (landingEntry !== entry) return;
    landingEntry = undefined; busy = false; syncLandingActions();
  });
}
function showError(message: string): void { errorBox.textContent = message; errorBox.hidden = false; }
// Name limits follow normalized code points; room-code limits are also deployment-specific.
// Only fields with a fixed client contract receive an authored HTML maxlength.
function field(form: HTMLFormElement, label: string, name: string, value = '', required = true, maxLength?: number): HTMLInputElement {
  const wrapper = element('label', 'field', label);
  const input = element('input');
  input.name = name;
  input.value = value;
  input.required = required;
  if (maxLength !== undefined) input.maxLength = maxLength;
  input.setAttribute('autocomplete', name === 'name' ? 'nickname' : 'off');
  wrapper.append(input);
  form.append(wrapper);
  return input;
}
function landing(): void {
  retireOccupancy();
  // Drop ownership before any reset can synchronously deliver another speaking callback.
  resetSpeaking();
  handRejectionRoomActive = false; retireHandRejection();
  stopRoomTimers();
  stageQualitySuppressedState = undefined; resetQualityDetails();
  stagePermissionOwner = undefined;
  landingRevision += 1;
  ownHandPosition.hidden = true; ownHandPosition.textContent = '';
  resetAudienceFilter();
  renderedRoomSignature = renderedSpeakingSignature = renderedQualitySignature = undefined; renderedGainInputs.length = 0;
  renderedAudienceHeading = undefined;
  resetMicSettings();
  resetRoomActions('');
  cooldownButton = null; renderedReturnStage = null; renderedRoomActions = []; scheduleCooldown(0);
  brand.textContent = 'Stage.js 音訊舞台';
  const intro = element('section', 'intro');
  intro.append(element('h2', '', '一起聊，所有人都能聽見。'), element('p', '', '建立音訊舞台，邀請朋友發言；觀眾可舉手，經主控核准後上台。'));
  const grid = element('div', 'landing-grid');
  const create = element('form', 'panel');
  create.append(element('h2', '', '建立房間'));
  const createName = field(create, '你的名稱', 'name');
  const roomName = field(create, '房間名稱', 'roomName', '', false);
  const codeLabel = element('label', 'check');
  const codeRequired = element('input');
  codeRequired.type = 'checkbox'; codeRequired.checked = true;
  codeLabel.append(codeRequired, document.createTextNode('需要房間代碼才能加入'));
  const createToken = field(create, '建立權杖（伺服器有設定時才需要）', 'token', '', false, 256);
  createToken.type = 'password';
  const createSubmit = element('button', 'primary', '建立並進入');
  createSubmit.type = 'submit'; createSubmit.dataset.landingSubmit = 'true';
  create.append(codeLabel, createSubmit);
  create.onsubmit = (event) => {
    event.preventDefault();
    runLanding('create', async (isCancelled) => {
      micNotice = invitation = '';
      const result = await client.createRoom({ name: createName.value.trim(), roomName: roomName.value.trim() || undefined, codeRequired: codeRequired.checked, token: createToken.value || undefined });
      if (isCancelled()) return;
      createdRoom = result;
      if (client.state) renderRoom(client.state);
    });
  };
  const join = element('form', 'panel');
  join.append(element('h2', '', '加入房間'));
  const roomId = field(join, '房間 ID', 'roomId', params.get('room') ?? '', true, 128);
  const code = field(join, '房間代碼（未設定時可留空）', 'code', params.get('code') ?? '', false);
  const joinName = field(join, '你的名稱', 'name');
  const joinSubmit = element('button', 'primary', '加入收聽');
  joinSubmit.type = 'submit'; joinSubmit.dataset.landingSubmit = 'true';
  join.append(joinSubmit);
  join.onsubmit = (event) => {
    event.preventDefault();
    runLanding('join', async () => {
      createdRoom = null; micNotice = invitation = '';
      await client.join({ roomId: roomId.value.trim(), code: code.value.trim() || undefined, name: joinName.value.trim() });
    });
  };
  grid.append(create, join);
  const cancel = element('button', '', '取消連線');
  cancel.id = 'landing-cancel'; cancel.type = 'button'; cancel.dataset.landingCancel = 'true';
  cancel.onclick = () => {
    if (!cancel.isConnected || !canCancelLanding()) return;
    retireOccupancy();
    landingEntry!.cancelled = true;
    syncLandingActions(); renderOccupancy();
    void run(() => client.disconnect());
  };
  const progress = element('p', 'muted');
  progress.id = 'landing-progress'; progress.dataset.landingProgress = 'true';
  progress.setAttribute('role', 'status'); progress.setAttribute('aria-live', 'polite');
  content.replaceChildren(intro, grid, progress, cancel);
  syncLandingActions(); renderNotices(); renderOccupancy();
}
function syncMicRetry(): void {
  if (!micRetryButton) return;
  micRetryButton.disabled = micRetryPending || !client.me?.onStage || client.status !== 'live';
  micRetryButton.setAttribute('aria-busy', String(micRetryPending));
}
let renderedNoticeSignature: string | undefined;
// Only room renders reuse controls; direct events and pending settlement retain their redraws.
function renderNotices(reuseUnchanged = false): void {
  const signature = JSON.stringify([roomActionGeneration, audioBlocked, Boolean(pendingAudioUnlock),
    micNotice, Boolean(client.me?.onStage), client.status, micRetryAvailable, micRetryPending, invitation]);
  if (reuseUnchanged && signature === renderedNoticeSignature) { syncMicRetry(); return; }
  renderedNoticeSignature = undefined;
  micRetryButton = undefined;
  notices.replaceChildren();
  if (audioBlocked) {
    const generation = roomActionGeneration;
    const banner = element('div', 'banner');
    const unlock = element('button', 'primary', '點擊啟用音訊');
    unlock.type = 'button'; unlock.disabled = Boolean(pendingAudioUnlock);
    unlock.setAttribute('aria-busy', String(Boolean(pendingAudioUnlock)));
    unlock.onclick = () => {
      if (!unlock.isConnected || generation !== roomActionGeneration || !client.state || !audioBlocked || pendingAudioUnlock) return;
      const token = Symbol('audio-unlock'); pendingAudioUnlock = token;
      unlock.disabled = true; unlock.setAttribute('aria-busy', 'true');
      void run(async () => {
        try {
          // Invoke synchronously in this gesture; notice redraws must not admit another play.
          await client.unlockAudio();
          if (generation === roomActionGeneration && pendingAudioUnlock === token) audioBlocked = false;
        } finally {
          if (generation === roomActionGeneration && pendingAudioUnlock === token) {
            pendingAudioUnlock = undefined; renderNotices();
          }
        }
      }, unlock, generation);
    };
    banner.append(element('span', '', '自動播放遭阻擋。'), unlock);
    notices.append(banner);
  }
  if (micNotice) {
    const banner = element('div', 'banner');
    banner.append(element('span', '', micNotice));
    if (client.me?.onStage && (micRetryAvailable || micRetryPending)) {
      const generation = roomActionGeneration;
      const retry = element('button', 'primary', '重試麥克風');
      retry.id = 'mic-retry'; retry.type = 'button'; micRetryButton = retry;
      retry.onclick = () => {
        if (!retry.isConnected || retry.disabled || generation !== roomActionGeneration
          || micRetryPending || !micRetryAvailable || !client.me?.onStage || client.status !== 'live') return;
        const previous = micNotice;
        micRetryPending = true; micNotice = '已要求重試麥克風，等待擷取結果。'; renderNotices();
        try {
          if (!client.retryMicrophone() && generation === roomActionGeneration) {
            micRetryPending = false; micNotice = previous; renderNotices();
          }
        } catch (error) {
          if (generation !== roomActionGeneration) return;
          micRetryPending = false; micNotice = previous; renderNotices();
          showError(error instanceof Error ? error.message : '無法要求重試麥克風。');
        }
      };
      banner.append(retry); syncMicRetry();
    }
    notices.append(banner);
  }
  if (invitation) notices.append(element('p', 'banner', invitation));
  renderedNoticeSignature = signature;
}
function resetAudienceFilter(): void {
  audienceFilterIdentity = ''; audienceSearch.value = '';
  audienceFilterRows.length = 0;
  audienceFilter.hidden = true; audienceSearch.disabled = audienceFilterClear.disabled = true;
  audienceFilterCount.textContent = '';
}
function canFilterAudience(): boolean {
  const state = client.state;
  return Boolean(state?.me.role === 'controller' && state.audience
    && audienceFilterIdentity === JSON.stringify([state.roomId, state.me.participantId]));
}
function applyAudienceFilter(): void {
  const query = audienceSearch.value.trim().normalize('NFC').toLowerCase();
  let visible = 0;
  for (const { row, name } of audienceFilterRows) {
    const matches = name.includes(query);
    if (row.hidden !== !matches) row.hidden = !matches;
    if (matches) visible++;
  }
  audienceFilterClear.disabled = audienceSearch.value.length === 0;
  const count = query && visible === 0 && audienceFilterRows.length > 0
    ? `沒有符合名稱的觀眾（0／${audienceFilterRows.length}）`
    : `顯示 ${visible}／${audienceFilterRows.length} 位觀眾`;
  if (audienceFilterCount.textContent !== count) audienceFilterCount.textContent = count;
}
function syncAudienceFilter(state: RoomStatePayload): void {
  if (state.me.role !== 'controller' || !state.audience) { resetAudienceFilter(); return; }
  const identity = JSON.stringify([state.roomId, state.me.participantId]);
  if (audienceFilterIdentity !== identity) audienceSearch.value = '';
  audienceFilterIdentity = identity;
  audienceFilter.hidden = false; audienceSearch.disabled = false;
  applyAudienceFilter();
}
const roomOccupancy = element('p', 'muted room-occupancy');
roomOccupancy.id = 'room-occupancy'; roomOccupancy.hidden = true;
interface OccupancyReport {
  roomId: string; participantId: string;
  room: number; stage: number; audience: number; maxAudience: number; maxSpeakers: number;
  controllerOnStage: boolean; stale: boolean;
}
let occupancyReport: OccupancyReport | undefined;
let occupancyRevision = 0;
let occupancyPainting = false;
const occupancyReceipts = new WeakSet<object>();
// Logical retirement is separate from painting so existing action ownership changes run first.
function retireOccupancy(): void { occupancyRevision++; occupancyReport = undefined; }
function projectOccupancy(state: RoomStatePayload): OccupancyReport | undefined {
  const roomId = state.roomId, participantId = state.me?.participantId, controllerId = state.controllerId;
  const limits = state.limits, audience = state.audienceCount;
  const maxAudience = limits?.maxAudience, maxSpeakers = limits?.maxSpeakers, speakers = state.speakers;
  if (typeof roomId !== 'string' || !roomId.trim() || typeof participantId !== 'string' || !participantId.trim()
    || typeof controllerId !== 'string' || !controllerId.trim() || !Array.isArray(speakers)
    || !limits || typeof limits !== 'object' || Array.isArray(limits)
    || !Number.isSafeInteger(audience) || audience < 0 || !Number.isSafeInteger(maxAudience) || maxAudience <= 0
    || !Number.isSafeInteger(maxSpeakers) || maxSpeakers <= 0) return;
  const ids = new Set<string>();
  let controllerOnStage = false;
  for (const person of speakers) {
    if (!person || typeof person.participantId !== 'string' || !person.participantId.trim() || ids.has(person.participantId)
      || person.onStage !== true || (person.role !== 'speaker' && person.role !== 'controller')
      || (person.role === 'controller') !== (person.participantId === controllerId)) return;
    ids.add(person.participantId);
    if (person.participantId === controllerId) controllerOnStage = true;
  }
  const stage = ids.size - Number(controllerOnStage), room = audience + stage;
  if (!Number.isSafeInteger(room) || room > maxAudience || stage > maxSpeakers) return;
  return { roomId, participantId, room, stage, audience, maxAudience, maxSpeakers, controllerOnStage, stale: false };
}
function reconcileOccupancy(): void {
  const report = occupancyReport;
  if (!report) return;
  if (report.roomId !== client.state?.roomId || report.participantId !== client.state?.me?.participantId
    || !['waiting', 'live', 'reconnecting'].includes(client.status)) { retireOccupancy(); return; }
  if (client.status === 'reconnecting' && !report.stale) { report.stale = true; occupancyRevision++; }
}
function prepareOccupancyState({ detail }: { detail: RoomStatePayload }): void {
  const revision = ++occupancyRevision;
  const object = detail && typeof detail === 'object', unseen = object && !occupancyReceipts.has(detail);
  if (object) occupancyReceipts.add(detail);
  if (!unseen || detail !== client.state || (client.status !== 'waiting' && client.status !== 'live')) {
    reconcileOccupancy(); return;
  }
  const report = projectOccupancy(detail);
  // Public getters can synchronously replace this receipt or retire the room.
  if (revision !== occupancyRevision || detail !== client.state
    || (client.status !== 'waiting' && client.status !== 'live')) return;
  occupancyReport = report;
}
function prepareOccupancyStatus(): void { occupancyRevision++; reconcileOccupancy(); }
function renderOccupancy(): void {
  if (occupancyPainting) return;
  occupancyPainting = true;
  try {
    // Nested callbacks reserve their output first; drain finite changes without trusting a paint cache.
    for (;;) {
      reconcileOccupancy();
      // A predecessor UI setter may emit status before the new state reaches renderRoom.
      // Retire old-room commands before this independent paragraph exposes the new seat.
      const identity = client.state ? JSON.stringify([client.state.roomId, client.state.me.participantId]) : '';
      if (identity !== roomActionIdentity) { resetRoomActions(identity); continue; }
      const revision = occupancyRevision, report = occupancyReport, connectionStatus = client.status;
      const roomId = client.state?.roomId, participantId = client.state?.me?.participantId;
      const current = (): boolean => {
        if (connectionStatus !== client.status || roomId !== client.state?.roomId
          || participantId !== client.state?.me?.participantId) {
          // A host setter can alter public ownership without an SDK event. Fence old actions first.
          reconcileOccupancy();
          resetRoomActions(client.state ? JSON.stringify([client.state.roomId, client.state.me.participantId]) : '');
          syncRoomActions();
          return false;
        }
        return revision === occupancyRevision && report === occupancyReport;
      };
      const freshness = connectionStatus === 'reconnecting' ? '重新連線中，上次快照' : report?.stale ? '上次快照' : '最近快照';
      const text = report ? `房間席位（${freshness}）：主控以外 ${report.room} / ${report.maxAudience} 人，其中台上 ${report.stage} / ${report.maxSpeakers} 人、觀眾 ${report.audience} 人；主控另計 1 人（${report.controllerOnStage ? '台上' : '台下'}）。含斷線保留席位。` : '';
      if (!report && !roomOccupancy.hidden) { roomOccupancy.hidden = true; if (!current()) continue; }
      if (roomOccupancy.textContent !== text) { roomOccupancy.textContent = text; if (!current()) continue; }
      if (report && roomOccupancy.hidden) { roomOccupancy.hidden = false; if (!current()) continue; }
      if (current()) return;
    }
  } finally { occupancyPainting = false; }
}
let speakingDirtyIds = new Set<string>();
let speakingRowsRevision = 0;
let speakingPaintRevision: number | undefined;
let speakingRevision = 0;
let speakingIdentity = '';
let speakingState: RoomStatePayload | undefined;
let speakingRetired = false;
let speakingReconnectState: RoomStatePayload | null = null;
function resetSpeaking(): void {
  speakingRevision++; speakingIdentity = ''; speakingState = undefined;
  speakingRetired = false; speakingReconnectState = null;
  speakingRowsRevision++; personRows.clear(); speakingIds = new Set(); speakingDirtyIds = new Set();
}
/** The SDK retains its last report across socket loss; that is not a current activity indication. */
function retireSpeaking(): void {
  speakingRevision++;
  speakingRetired = true; speakingReconnectState = client.state; speakingState = undefined;
  updateSpeaking(new Set());
}
function acceptSpeakingState(state: RoomStatePayload): void {
  if (state !== client.state) return;
  const identity = JSON.stringify([state.roomId, state.me.participantId]);
  if (client.status === 'reconnecting' || client.status === 'disconnected') {
    speakingIdentity = identity; speakingRetired = true; speakingState = undefined; return;
  }
  if (identity !== speakingIdentity) {
    speakingIdentity = identity; speakingRetired = false; speakingReconnectState = null;
  }
  // Status is emitted before state on resume. Neither status alone nor a pre-loss replay admits reports.
  speakingState = state !== speakingReconnectState ? state : undefined;
}
function updateSpeaking(ids: Set<string>): void {
  const previous = speakingIds, revision = speakingRowsRevision, dirty = speakingDirtyIds;
  speakingIds = ids; renderedSpeakingSignature = JSON.stringify([...ids]);
  for (const id of previous) if (!ids.has(id)) dirty.add(id);
  for (const id of ids) if (!previous.has(id)) dirty.add(id);
  if (speakingPaintRevision === revision) return;
  speakingPaintRevision = revision;
  try {
    // Nested receipts reserve their desired set first. Drain only dirty IDs until finite callbacks settle.
    while (dirty.size && speakingRowsRevision === revision) {
      const id = dirty.values().next().value!; dirty.delete(id);
      for (const row of personRows.get(id) ?? []) {
        if (speakingRowsRevision !== revision) return;
        const active = speakingIds.has(id);
        if (row.classList.contains('speaking') !== active) row.classList.toggle('speaking', active);
        if (speakingRowsRevision !== revision) return;
        // A before-write callback can return into an older toggle after reserving a newer report.
        if (row.classList.contains('speaking') !== speakingIds.has(id)) dirty.add(id);
      }
    }
  } finally {
    if (speakingPaintRevision === revision) speakingPaintRevision = undefined;
  }
}
function effectiveRoomCode(state: RoomStatePayload): string | undefined {
  return state.code ?? (createdRoom?.roomId === state.roomId ? createdRoom.code : undefined);
}
function invitationUrl(state: RoomStatePayload, roomCode = effectiveRoomCode(state)): URL {
  const link = new URL(location.origin);
  link.pathname = location.pathname;
  link.searchParams.set('room', state.roomId);
  if (signaling.path !== '/ws') link.searchParams.set('wsPath', signaling.path);
  if (state.codeRequired && roomCode) link.searchParams.set('code', roomCode);
  return link;
}
function renderRoom(state: RoomStatePayload): void {
  const generation = resetRoomActions(JSON.stringify([state.roomId, state.me.participantId]));
  if (generation !== roomActionGeneration) return;
  const qualityState = client.state;
  syncQualityDetails();
  if (generation !== roomActionGeneration || qualityState !== client.state) return;
  if (!state.me.onStage) {
    if (micRetryPending) micNotice = '';
    micRetryAvailable = micRetryPending = false;
  }
  const roomCode = effectiveRoomCode(state);
  // Separate already-applied overlays from structural state; dirty sliders still reset to server state.
  const { audienceCount, ...roomStructure } = state;
  const audienceTitle = `觀眾 · ${audienceCount} 人`;
  const signature = JSON.stringify([roomStructure, roomCode, client.status]);
  const currentSpeaking = new Set(speakingRetired ? speakingIds : client.speaking);
  const speakingSignature = JSON.stringify([...currentSpeaking]);
  const qualitySignature = JSON.stringify([...quality]);
  if (signature === renderedRoomSignature && speakingSignature === renderedSpeakingSignature
    && qualitySignature === renderedQualitySignature && !renderedGainInputs.some(({ input, value }) => input.value !== value)) {
    status.textContent = statusLabels[client.status];
    if (renderedAudienceHeading && renderedAudienceHeading.textContent !== audienceTitle) renderedAudienceHeading.textContent = audienceTitle;
    syncAudienceFilter(state); updateCooldown(); renderNotices(true); return;
  }
  renderedGainInputs.length = 0; audienceFilterRows.length = 0;
  speakingRevision++; speakingRowsRevision++; personRows.clear(); speakingDirtyIds = new Set(); speakingIds = currentSpeaking;
  brand.textContent = decodeName(state.name);
  status.textContent = statusLabels[client.status];
  cooldownButton = null;
  const controller = state.me.role === 'controller';
  const summary = element('section', 'panel room-summary');
  summary.append(element('h2', '', '房間資訊'), element('p', '', `房間 ID：${state.roomId}`));
  if (controller) {
    summary.append(element('p', '', state.codeRequired ? `房間代碼：${roomCode ?? '未提供'}` : '不需要房間代碼'));
    const titleRoomId = state.roomId, titleParticipantId = state.me.participantId;
    const canRenameRoom = () => generation === roomActionGeneration && client.status !== 'reconnecting'
      && client.state?.roomId === titleRoomId && client.me?.participantId === titleParticipantId
      && client.me.role === 'controller';
    const renameRoom = roomButton('room-rename', '修改房間名稱', async () => {
      const name = window.prompt('輸入新的房間名稱', decodeName(client.state!.name));
      if (name === null || !canRenameRoom()) return;
      await client.setRoomName(name);
    }, '', () => renameRoom.isConnected && canRenameRoom());
    summary.append(renameRoom);
    const link = invitationUrl(state, roomCode);
    const inviteLink = element('input', 'invite-link');
    inviteLink.value = link.href; inviteLink.readOnly = true;
    inviteLink.setAttribute('aria-label', '邀請連結');
    const copy = element('button', '', '複製邀請連結');
    copy.type = 'button';
    const canCopy = (requireIdle = false): boolean => {
      try {
        if (requireIdle && copy.disabled) return false;
        const current = client.state;
        if (!current || current.roomId !== titleRoomId || current.me.participantId !== titleParticipantId
          || current.me.role !== 'controller' || invitationUrl(current).href !== link.href) return false;
        return copy.isConnected && inviteLink.isConnected && copy.parentNode === inviteLink.parentNode
          && content.querySelector<HTMLInputElement>('.invite-link') === inviteLink && inviteLink.value === link.href
          && current === client.state && generation === roomActionGeneration && (!requireIdle || !copy.disabled);
      } catch { return false; }
    };
    const copyInvitation = async () => {
      // A host callback during run's DOM writes may have retired the admitted resource.
      if (!canCopy()) return;
      const sequence = ++inviteCopySequence;
      let copied = false;
      try { await navigator.clipboard.writeText(link.href); copied = true; }
      catch { /* The current link can still be selected for manual copying. */ }
      // Snapshots can replace this button/input while an earlier write is pending.
      const currentLink = content.querySelector<HTMLInputElement>('.invite-link');
      if (generation !== roomActionGeneration || sequence !== inviteCopySequence
        || !currentLink?.isConnected || currentLink.value !== link.href) return;
      if (copied) invitation = '已複製邀請連結，請只分享給受邀者。';
      else { currentLink.focus(); currentLink.select(); invitation = '請長按或使用複製快捷鍵複製已選取的連結。'; }
      renderNotices();
    };
    copy.onclick = () => {
      // SDK snapshots are installed before the sample's state listener replaces the old nodes.
      if (!canCopy(true)) return;
      void run(copyInvitation, copy);
    };
    summary.append(inviteLink, copy);
    if (state.codeRequired) summary.append(roomButton('rotate-code', '更換房間代碼', async () => {
      if (!window.confirm('更換後舊代碼與舊邀請連結立即失效，已在房內的人不受影響。確定更換？')) return;
      await client.rotateCode();
      if (generation !== roomActionGeneration) return;
      invitation = '已更換房間代碼，請重新分享邀請連結。'; renderNotices();
    }));
  }
  const controls = element('section', 'panel');
  controls.append(element('h2', '', `你好，${decodeName(state.me.name)}`), element('p', '', `${roleLabels[state.me.role]}${state.me.forceMuted ? ' · 主控已鎖定靜音' : ''}`), connectionLine, ownHandPosition, handRejectionNotice);
  const actions = element('div', 'actions');
  const ownRoomId = state.roomId, ownParticipantId = state.me.participantId;
  const canRetryAudio = () => generation === roomActionGeneration && client.state?.roomId === ownRoomId
    && client.me?.participantId === ownParticipantId && (client.status === 'waiting' || client.status === 'live');
  const audioRetry = roomButton('audio-retry', '重試音訊連線', async () => {
    audioRetryNotice.textContent = '正在重新協商音訊連線…'; audioRetryNotice.hidden = false;
    try {
      await client.retryAudioConnection();
      if (canRetryAudio()) audioRetryNotice.textContent = '音訊連線協商已完成。';
    } catch (error) {
      if (generation === roomActionGeneration) { audioRetryNotice.hidden = true; audioRetryNotice.textContent = ''; }
      throw error;
    }
  }, '', () => audioRetry.isConnected && canRetryAudio());
  audioRetry.id = 'audio-retry';
  controls.append(audioRetry, audioRetryNotice);
  const canRename = () => generation === roomActionGeneration && client.status !== 'reconnecting'
    && client.state?.roomId === ownRoomId && client.me?.participantId === ownParticipantId;
  const rename = roomButton('rename', '修改我的名稱', async () => {
    const name = window.prompt('輸入新的顯示名稱', decodeName(client.me!.name));
    // A dialog may outlive a snapshot, reconnect or room exit. Same-seat redraws are harmless.
    if (name === null || !canRename()) return;
    await client.setName(name);
  }, '', () => rename.isConnected && canRename());
  actions.append(rename);
  if (state.me.onStage) {
    const muted = state.me.muted;
    const mute = roomButton('mute', muted ? '取消靜音' : '靜音', () => muted ? client.unmute() : client.mute());
    mute.dataset.policyDisabled = String(state.me.forceMuted);
    actions.append(mute, roomButton('stage', '離開舞台', () => client.leaveStage()));
  } else if (controller) {
    // An off-stage controller keeps control and returns by self-approval; raising a hand is audience-only.
    const returnButton = roomButton('stage', '返回舞台', () => client.returnToStage(), 'primary');
    returnButton.dataset.returnStage = 'true';
    actions.append(returnButton);
  } else if (state.me.handRaised) {
    actions.append(roomButton('hand', '收回舉手', () => client.withdrawHand()));
  } else {
    cooldownButton = roomButton('hand', '舉手發言', () => client.raiseHand(), 'primary');
    actions.append(cooldownButton);
  }
  actions.append(button('離開房間', async () => {
    retireOccupancy();
    handRejectionRoomActive = false; retireHandRejection();
    // Leaving after a pre-ACK snapshot also retires that entry's local feedback.
    if (landingEntry) landingEntry.cancelled = true;
    micTest?.stop(); micTest = null;
    testButton.textContent = '測試麥克風'; testButton.setAttribute('aria-pressed', 'false');
    const disconnect = client.disconnect(); renderOccupancy();
    await disconnect; createdRoom = null; micNotice = invitation = ''; landing();
  }));
  if (controller) actions.append(roomButton('close', '關閉房間', async () => {
    if (window.confirm('確定關閉房間並讓所有人離場？')) await client.closeRoom();
  }, 'danger'));
  controls.append(actions);
  const grid = element('div', 'stage-grid');
  // The cap counts speakers other than the controller, whose seat is extra.
  const capped = state.speakers.filter((p) => p.participantId !== state.controllerId).length;
  const speakers = panelList(`舞台 · 發言者 ${capped}/${state.limits.maxSpeakers}`, state.speakers, controller, 'speaker');
  const hands = panelList(`舉手佇列 · ${state.hands.length}`, state.hands, controller, 'hand');
  grid.append(speakers, hands);
  const audience = element('section', 'panel');
  const audienceHeading = element('h2', '', audienceTitle);
  audience.append(audienceHeading);
  if (controller && state.audience) {
    const list = element('ul', 'people');
    for (const person of state.audience) list.append(personRow(person, true, 'audience'));
    if (state.audience.length === 0) audience.append(element('p', 'muted', '目前沒有觀眾。'));
    audience.append(list);
  } else audience.append(element('p', 'muted', '觀眾名單僅提供給主控。'));
  grid.append(audience);
  const top = element('div', 'landing-grid'); top.append(summary, controls);
  content.replaceChildren(top, grid);
  renderedRoomActions = Array.from(content.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-room-action]'));
  renderedReturnStage = content.querySelector<HTMLButtonElement>('[data-return-stage]');
  renderedAudienceHeading = audienceHeading;
  renderedRoomSignature = signature; renderedSpeakingSignature = speakingSignature; renderedQualitySignature = qualitySignature;
  syncAudienceFilter(state); updateCooldown(); renderNotices(true);
}
function panelList(title: string, people: ParticipantView[], controller: boolean, kind: 'speaker' | 'hand'): HTMLElement {
  const panel = element('section', 'panel');
  panel.append(element('h2', '', title));
  if (!people.length) panel.append(element('p', 'muted', kind === 'speaker' ? '舞台目前無人，等待下一位發言者。' : '目前沒有舉手。'));
  const list = element('ul', 'people');
  for (const person of people) list.append(personRow(person, controller, kind));
  panel.append(list);
  return panel;
}
function personRow(person: ParticipantView, controller: boolean, kind: 'speaker' | 'hand' | 'audience'): HTMLLIElement {
  const row = element('li', 'person');
  row.dataset.participantId = person.participantId;
  if (kind === 'audience') audienceFilterRows.push({ row, name: decodeName(person.name).normalize('NFC').toLowerCase() });
  const rows = personRows.get(person.participantId);
  if (rows) rows.push(row); else personRows.set(person.participantId, [row]);
  row.classList.toggle('speaking', speakingIds.has(person.participantId));
  const identity = element('div', 'identity');
  identity.append(element('strong', '', decodeName(person.name)), element('span', 'badge', roleLabels[person.role]));
  if (!person.connected) identity.append(element('span', 'badge', '連線中斷'));
  if (person.muted) identity.append(element('span', 'badge', person.forceMuted ? '強制靜音' : '已靜音'));
  if (person.gainDb) identity.append(element('span', 'badge', `音量 ${person.gainDb > 0 ? '+' : ''}${person.gainDb} dB`));
  if (person.participantId === client.me?.participantId) identity.append(element('span', 'badge', '我'));
  row.append(identity);
  applyQuality(row);
  // The controller manages others; its own mic/stage use the personal controls above.
  if (controller && person.participantId !== client.me?.participantId) {
    const id = person.participantId, forceMuted = person.forceMuted, name = decodeName(person.name);
    const canManageAudience = () => kind !== 'audience' || Boolean(row.isConnected && !row.hidden
      && client.status !== 'reconnecting' && client.me?.role === 'controller'
      && client.state?.audience?.some((p) => p.participantId === id));
    const actions = element('div', 'actions');
    if (kind === 'hand') actions.append(roomButton(`stage:${id}`, '核准上台', () => client.approve(id), 'primary'), roomButton(`stage:${id}`, '婉拒', () => client.reject(id)));
    if (kind === 'speaker') actions.append(gainSlider(person), roomButton(`force-mute:${id}`, forceMuted ? '解除強制靜音' : '強制靜音', () => forceMuted ? client.forceUnmute(id) : client.forceMute(id)), roomButton(`stage:${id}`, '移出舞台', () => client.removeFromStage(id)));
    actions.append(roomButton('transfer', '移交控制權', async () => {
      if (window.confirm(`確定將控制權移交給 ${name}？`) && canManageAudience()) await client.transferControl(id);
    }, '', canManageAudience), roomButton(`kick:${id}`, '踢出房間', async () => {
      if (window.confirm(`確定將 ${name} 踢出房間？若要防止對方再進來，請接著更換房間代碼。`) && canManageAudience()) await client.kick(id);
    }, 'danger', canManageAudience));
    row.append(actions);
  }
  return row;
}
/** Controller's per-speaker level trim; sends on release (`change`) so dragging is one request. */
function gainSlider(person: ParticipantView): HTMLLabelElement {
  const id = person.participantId;
  const label = element('label', 'gain', '音量');
  const slider = element('input');
  slider.type = 'range';
  slider.dataset.roomAction = `gain:${id}`;
  slider.min = String(-MAX_GAIN_DB); slider.max = String(MAX_GAIN_DB); slider.step = '1';
  slider.value = String(person.gainDb);
  renderedGainInputs.push({ input: slider, value: slider.value });
  slider.title = `${person.gainDb} dB`;
  slider.onchange = () => {
    if (slider.disabled || client.status === 'reconnecting' || client.status === 'disconnected') return;
    void run(() => client.setGain(id, Number(slider.value)), undefined, roomActionGeneration);
  };
  label.append(slider);
  return label;
}
/** Adds, updates or removes the connection warning badge of one stage row. */
function applyQuality(row: HTMLElement): void {
  const q = quality.get(row.dataset.participantId!);
  const worst = Math.max(q?.uplinkLossPercent ?? 0, q?.downlinkLossPercent ?? 0);
  let badge = row.querySelector<HTMLElement>('.badge.quality');
  if (!q || worst < POOR_LOSS_PERCENT) { badge?.remove(); return; }
  if (!badge) { badge = element('span', 'badge quality'); row.querySelector('.identity')!.append(badge); }
  badge.textContent = `連線不穩 ${worst.toFixed(0)}%`;
  badge.title = `上行掉包 ${q.uplinkLossPercent ?? '—'}%、下行掉包 ${q.downlinkLossPercent ?? '—'}%${q.rttMs !== undefined ? `、RTT ${q.rttMs} ms` : ''}`;
}
function updateCooldown(): void {
  syncHandRejection(); syncHandPosition();
  const remainingMs = client.handCooldownMs;
  const remaining = Math.ceil(remainingMs / 1000);
  if (cooldownButton?.isConnected) {
    cooldownButton.disabled = remaining > 0 || client.status === 'reconnecting';
    cooldownButton.textContent = remaining > 0 ? `舉手發言（${remaining} 秒）` : '舉手發言';
  }
  const returnButton = renderedReturnStage;
  if (returnButton) returnButton.disabled = client.status === 'reconnecting';
  syncRoomActions();
  scheduleCooldown(cooldownButton?.isConnected ? remainingMs : 0);
}
function syncHandPosition(): void {
  const state = client.state, me = state?.me;
  const visible = Boolean(me?.handRaised && !me.onStage && me.role !== 'controller');
  let text = '';
  if (visible) {
    const position = state!.hands.findIndex(person => person.participantId === me!.participantId);
    const reconnecting = client.status === 'reconnecting';
    text = position >= 0
      ? `${reconnecting ? '上次' : '你的'}舉手位置：佇列第 ${position + 1} 位。`
      : reconnecting ? '上次狀態：已舉手，等待主控邀請。' : '你已舉手，等待主控邀請。';
  }
  if (ownHandPosition.hidden !== !visible) ownHandPosition.hidden = !visible;
  if (ownHandPosition.textContent !== text) ownHandPosition.textContent = text;
}
/** Only a visible countdown needs clock-driven updates; state/status/action changes update directly. */
function scheduleCooldown(remaining: number): void {
  if (remaining <= 0) {
    clearTimeout(cooldownTimer); cooldownTimer = undefined; cooldownDue = 0;
  } else {
    const delay = Math.max(1, Math.ceil(remaining - (Math.ceil(remaining / 1000) - 1) * 1000));
    const due = performance.now() + delay;
    if (cooldownTimer !== undefined && cooldownDue <= due) return;
    clearTimeout(cooldownTimer);
    const timer = setTimeout(() => {
      if (cooldownTimer !== timer) return;
      cooldownTimer = undefined; cooldownDue = 0; updateCooldown();
    }, delay);
    cooldownTimer = timer; cooldownDue = due;
  }
}
client.on('state', ({ detail }) => {
  acceptSpeakingState(detail);
  // Only a new current snapshot resolves early loss; status/report sync still sees the old seat.
  if (detail === client.state && detail !== stageQualitySuppressedState) stageQualitySuppressedState = undefined;
  if (landingEntry) landingEntry.entered = true;
  try { renderRoom(detail); } finally { renderOccupancy(); }
});
client.on('status', ({ detail }) => {
  if (detail === 'disconnected' && !client.state) resetSpeaking();
  else if (detail === 'reconnecting' || detail === 'disconnected') retireSpeaking();
  if (detail === 'reconnecting' || detail === 'disconnected') {
    retireHandRejection(); audioRetryNotice.hidden = true; audioRetryNotice.textContent = '';
  }
  if (landingEntry && client.state) landingEntry.entered = true;
  status.textContent = statusLabels[detail];
  if (detail === 'disconnected' && !client.state) {
    micTest?.stop(); micTest = null;
    testButton.textContent = '測試麥克風'; testButton.setAttribute('aria-pressed', 'false');
    createdRoom = null; micNotice = invitation = ''; audioBlocked = false;
    quality.clear();
    syncMeter(); landing();
  }
  updateCooldown(); syncMicRetry(); syncQualityDetails();
});
client.on('hand', ({ detail }) => { if (detail.raised && detail.participantId === client.me?.participantId) retireHandRejection(); });
client.on('stagejoined', ({ detail }) => { if (detail.participantId === client.me?.participantId) retireHandRejection(); });
client.on('role', ({ detail }) => {
  if (detail.participantId !== client.me?.participantId) return;
  if (detail.role === 'audience') suppressQualityDetails();
  else retireHandRejection();
});
client.on('transferred', ({ detail }) => {
  const me = client.me;
  if (detail.fromId === me?.participantId && !me.onStage) suppressQualityDetails();
  if (detail.toId === client.me?.participantId) retireHandRejection();
});
client.on('handrejected', ({ detail }) => {
  // Events carry no raise identifier; copy the current-seat ownership before observable work.
  const generation = roomActionGeneration;
  if (!detail || typeof detail !== 'object') return;
  const roomId = detail.roomId, participantId = detail.participantId;
  const state = client.state;
  if (generation !== roomActionGeneration || !eligibleHandRejection()
    || state?.roomId !== roomId || state.me.participantId !== participantId) return;
  handRejectionOwner = { roomId, participantId, generation };
  syncHandRejection();
});
client.on('created', ({ detail }) => { createdRoom = detail; });
client.on('closed', ({ detail }) => { if (landingEntry) landingEntry.entered = true; createdRoom = null; micNotice = ''; invitation = detail.reason === 'shutdown' ? '伺服器維護或重新啟動，房間已關閉；請稍後重新建立或加入。' : '房間已關閉，歡迎建立或加入其他舞台。'; audioBlocked = false; landing(); });
client.on('kicked', () => { if (landingEntry) landingEntry.entered = true; createdRoom = null; micNotice = ''; invitation = '你已被主控移出房間。'; audioBlocked = false; landing(); });
client.on('invite', ({ detail }) => {
  const state = client.state;
  if (state && detail.participantId === state.me.participantId) {
    stagePermissionOwner = { roomId: state.roomId, participantId: state.me.participantId, generation: roomActionGeneration };
    invitation = STAGE_PERMISSION_NOTICE; renderNotices();
  }
});
client.on('stageleft', ({ detail }) => {
  if (detail.participantId === client.me?.participantId && detail.role !== 'controller') suppressQualityDetails();
  if (detail.participantId === client.me?.participantId) { stagePermissionOwner = undefined; invitation = detail.reason === 'removed' ? '主控已將你移出舞台，你仍可收聽。' : ''; renderNotices(); }
});
client.on('micerror', ({ detail }) => { micRetryPending = false; micRetryAvailable = Boolean(client.me?.onStage); micNotice = `${detail.message}（${detail.name}）`; renderNotices(); });
client.on('audioblocked', () => { audioBlocked = true; renderNotices(); });
client.on('error', ({ detail }) => showError(detail.message));
// Toggle in place: a full re-render every few hundred ms would reset focus and scroll.
client.on('speaking', ({ detail }) => {
  const revision = ++speakingRevision;
  const ids = new Set(detail.participantIds);
  if (revision !== speakingRevision || !speakingIdentity || speakingState !== client.state
    || client.status === 'reconnecting' || client.status === 'disconnected') return;
  speakingRetired = false; speakingReconnectState = null;
  updateSpeaking(ids);
});
client.on('quality', ({ detail }) => {
  syncQualityDetails(detail.participants);
  const previous = quality;
  quality = new Map(detail.participants.map((q) => [q.participantId, q]));
  // Omitted IDs still need their old warnings removed, including duplicate rows.
  for (const id of new Set([...previous.keys(), ...quality.keys()])) {
    for (const row of personRows.get(id) ?? []) applyQuality(row);
  }
  renderedQualitySignature = JSON.stringify([...quality]);
});
function refreshConnectionLine(): void {
  if (!client.state || document.hidden) return;
  const generation = roomActionGeneration, sequence = ++connectionPollSequence;
  void client.getStats().then(({ inbound, outbound }) => {
    // A newer pending poll must not starve completed samples; older completions cannot replace newer results.
    if (!client.state || document.hidden || generation !== roomActionGeneration || sequence <= connectionResultWatermark) return;
    connectionResultWatermark = sequence;
    const milliseconds = (value: number | undefined, scale = 1): string => {
      if (value === undefined) return '—';
      const ms = value * scale;
      return Number.isFinite(ms) ? String(Math.round(ms)) : '—';
    };
    const receive = inbound
      ? `接收掉包 ${inbound.lossPercent?.toFixed(1) ?? '—'}% · 接收 RTT ${milliseconds(inbound.rtt, 1000)} ms · 接收緩衝 ${milliseconds(inbound.bufferMs)} ms`
      : '接收：暫無統計';
    const send = outbound
      ? `傳送掉包 ${outbound.lossPercent?.toFixed(1) ?? '—'}% · 傳送 RTT ${milliseconds(outbound.rtt, 1000)} ms`
      : '傳送：暫無統計';
    connectionLine.textContent = inbound || outbound
      ? `你的連線（上次完成讀取；SDK 取樣區間）：${receive}；${send}。RTT 不是端到端音訊延遲；不保證資料即時或目前可聽。`
      : '';
    connectionLine.classList.toggle('error', Math.max(inbound?.lossPercent ?? 0, outbound?.lossPercent ?? 0) >= POOR_LOSS_PERCENT);
  }, () => {});
}
/** Connection stats matter only for visible room diagnostics; cooldown scheduling is independent. */
let roomTimers: ReturnType<typeof setInterval>[] = [];
function syncRoomTimers(): void {
  const polling = client.state !== null && !document.hidden;
  if (polling && !roomTimers.length) {
    const timer = setInterval(() => {
      if (roomTimers[0] !== timer) return;
      refreshConnectionLine();
    }, 2000);
    roomTimers = [timer];
  } else if (!polling) stopRoomTimers();
}
function stopRoomTimers(): void {
  roomTimers.forEach(clearInterval); roomTimers = [];
  connectionResultWatermark = ++connectionPollSequence; connectionLine.textContent = '';
  connectionLine.classList.toggle('error', false);
}
client.on('state', syncRoomTimers);
client.on('status', syncRoomTimers);
client.on('status', renderOccupancy);
client.on('closed', renderOccupancy);
client.on('kicked', renderOccupancy);
// Page-lifetime listener, like the client/device listeners; landing previews also use it.
document.addEventListener('visibilitychange', () => {
  connectionResultWatermark = ++connectionPollSequence; // Retire pending UI results without resetting SDK delta baselines.
  syncMeter(); syncRoomTimers();
  // A resumed SDK sample can span the hidden interval since the last completed stats sample.
  if (!document.hidden) refreshConnectionLine();
});
// Keep this passive paragraph outside the retained room tree and existing live notices.
app.append(roomOccupancy, content, stageQuality, settings);
landing();
if (signaling.error) showError(signaling.error);
