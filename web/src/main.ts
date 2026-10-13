import { MAX_GAIN_DB, StageClient, decodeName } from '../../packages/client/src/index.ts';
import type { ConnectionQuality, MicTest, ParticipantView, RoomStatePayload } from '../../packages/client/src/index.ts';
import './styles.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
const client = new StageClient({ url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws` });
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
const params = new URLSearchParams(location.search);
let busy = false;
let landingEntry: { cancelled: boolean; entered: boolean } | undefined;
let audioBlocked = false;
let micNotice = '';
let micRetryAvailable = false, micRetryPending = false;
let micRetryButton: HTMLButtonElement | undefined;
let invitation = '';
let createdRoom: { roomId: string; code?: string } | null = null;
let renderedRoomSignature: string | undefined;
const renderedGainInputs: { input: HTMLInputElement; value: string }[] = [];
let cooldownButton: HTMLButtonElement | null = null;
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
let connectionPollSequence = 0;
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
client.on('micready', () => { micRetryAvailable = micRetryPending = false; micNotice = ''; renderNotices(); void refreshDevices().catch(() => {}); });
navigator.mediaDevices?.addEventListener('devicechange', () => { void refreshDevices().catch(() => {}); });
void refreshDevices().catch(() => {});
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
  if (client.me?.onStage && micTest) {
    micTest.stop(); micTest = null;
    testButton.textContent = '測試麥克風'; testButton.setAttribute('aria-pressed', 'false');
  }
  testButton.disabled = testingBusy || Boolean(client.me?.onStage);
  const metering = Boolean(micTest) || Boolean(client.me?.onStage && !client.me.muted);
  if (metering && meterTimer === undefined) {
    meterTimer = setInterval(() => { level.value = client.me?.onStage ? client.micLevel : micTest?.level() ?? 0; }, 50);
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
async function run(action: () => Promise<unknown>, target?: HTMLButtonElement, generation?: number, reportError: () => boolean = () => true): Promise<void> {
  if (target) target.disabled = true;
  errorBox.hidden = true;
  try { await action(); }
  catch (error) {
    if (reportError() && (generation === undefined || generation === roomActionGeneration)) showError(error instanceof Error ? error.message : '操作失敗，請稍後再試。');
  }
  finally { if (target?.isConnected) target.disabled = false; updateCooldown(); syncMeter(); }
}
/** Room controls retain their pending state when snapshots replace their DOM nodes. */
function resetRoomActions(identity: string): void {
  if (roomActionIdentity === identity) return;
  roomActionIdentity = identity; roomActionGeneration++; pendingRoomActions.clear();
  micRetryAvailable = micRetryPending = false; micNotice = '';
}
function roomButton(key: string, label: string, action: () => Promise<unknown>, className = '', canAct?: () => boolean): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button'; node.dataset.roomAction = key;
  const generation = roomActionGeneration;
  node.onclick = () => {
    if (node.disabled || generation !== roomActionGeneration || pendingRoomActions.has(key) || (canAct && !canAct())) return;
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
  for (const node of content.querySelectorAll<HTMLButtonElement | HTMLInputElement>('[data-room-action]')) {
    const key = node.dataset.roomAction!;
    const pending = pendingRoomActions.has(key);
    node.setAttribute('aria-busy', String(pending));
    node.disabled = pending || client.status === 'reconnecting' || node.dataset.policyDisabled === 'true'
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
}
function canCancelLanding(): boolean {
  return busy && Boolean(landingEntry && !landingEntry.cancelled && !landingEntry.entered) && !client.state;
}
function runLanding(action: (isCancelled: () => boolean) => Promise<unknown>): void {
  if (busy) return;
  const entry = { cancelled: false, entered: false };
  landingEntry = entry; busy = true; syncLandingActions();
  void run(() => action(() => entry.cancelled), undefined, undefined, () => !entry.cancelled).finally(() => {
    if (landingEntry !== entry) return;
    landingEntry = undefined; busy = false; syncLandingActions();
  });
}
function showError(message: string): void { errorBox.textContent = message; errorBox.hidden = false; }
function field(form: HTMLFormElement, label: string, name: string, value = '', required = true, maxLength = 32): HTMLInputElement {
  const wrapper = element('label', 'field', label);
  const input = element('input');
  input.name = name;
  input.value = value;
  input.required = required;
  input.maxLength = maxLength;
  input.setAttribute('autocomplete', name === 'name' ? 'nickname' : 'off');
  wrapper.append(input);
  form.append(wrapper);
  return input;
}
function landing(): void {
  resetAudienceFilter();
  renderedRoomSignature = undefined; renderedGainInputs.length = 0;
  personRows.clear(); speakingIds.clear();
  resetMicSettings();
  resetRoomActions('');
  cooldownButton = null; scheduleCooldown(0);
  brand.textContent = 'Stage.js 音訊舞台';
  const intro = element('section', 'intro');
  intro.append(element('h2', '', '一起聊，所有人都能聽見。'), element('p', '', '建立音訊舞台，邀請朋友發言；觀眾可舉手，經主控核准後上台。'));
  const grid = element('div', 'landing-grid');
  const create = element('form', 'panel');
  create.append(element('h2', '', '建立房間'));
  const createName = field(create, '你的名稱', 'name');
  const roomName = field(create, '房間名稱', 'roomName', '', false, 64);
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
    runLanding(async (isCancelled) => {
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
  const code = field(join, '房間代碼（未設定時可留空）', 'code', params.get('code') ?? '', false, 16);
  const joinName = field(join, '你的名稱', 'name');
  const joinSubmit = element('button', 'primary', '加入收聽');
  joinSubmit.type = 'submit'; joinSubmit.dataset.landingSubmit = 'true';
  join.append(joinSubmit);
  join.onsubmit = (event) => {
    event.preventDefault();
    runLanding(async () => {
      createdRoom = null; micNotice = invitation = '';
      await client.join({ roomId: roomId.value.trim(), code: code.value.trim() || undefined, name: joinName.value.trim() });
    });
  };
  grid.append(create, join);
  const cancel = element('button', '', '取消連線');
  cancel.id = 'landing-cancel'; cancel.type = 'button'; cancel.dataset.landingCancel = 'true';
  cancel.onclick = () => {
    if (!cancel.isConnected || !canCancelLanding()) return;
    landingEntry!.cancelled = true;
    syncLandingActions();
    void run(() => client.disconnect());
  };
  content.replaceChildren(intro, grid, cancel);
  syncLandingActions(); renderNotices();
}
function syncMicRetry(): void {
  if (!micRetryButton) return;
  micRetryButton.disabled = micRetryPending || !client.me?.onStage || client.status !== 'live';
  micRetryButton.setAttribute('aria-busy', String(micRetryPending));
}
function renderNotices(): void {
  micRetryButton = undefined;
  notices.replaceChildren();
  if (audioBlocked) {
    const generation = roomActionGeneration;
    const banner = element('div', 'banner');
    banner.append(element('span', '', '自動播放遭阻擋。'), button('點擊啟用音訊', async () => {
      await client.unlockAudio();
      if (generation === roomActionGeneration) { audioBlocked = false; renderNotices(); }
    }, 'primary', generation));
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
function renderRoom(state: RoomStatePayload): void {
  resetRoomActions(JSON.stringify([state.roomId, state.me.participantId]));
  if (!state.me.onStage) {
    if (micRetryPending) micNotice = '';
    micRetryAvailable = micRetryPending = false;
  }
  const roomCode = state.code ?? (createdRoom?.roomId === state.roomId ? createdRoom.code : undefined);
  // Keep only this room's latest render key; dirty sliders still reset to authoritative state.
  const signature = JSON.stringify([state, roomCode, [...client.speaking], [...quality], client.status]);
  if (signature === renderedRoomSignature && !renderedGainInputs.some(({ input, value }) => input.value !== value)) {
    status.textContent = statusLabels[client.status];
    syncAudienceFilter(state); updateCooldown(); renderNotices(); return;
  }
  renderedGainInputs.length = 0; audienceFilterRows.length = 0;
  personRows.clear(); speakingIds = new Set(client.speaking);
  const generation = roomActionGeneration;
  brand.textContent = decodeName(state.name);
  status.textContent = statusLabels[client.status];
  cooldownButton = null;
  const controller = state.me.role === 'controller';
  const summary = element('section', 'panel room-summary');
  summary.append(element('h2', '', '房間資訊'), element('p', '', `房間 ID：${state.roomId}`));
  if (controller) {
    summary.append(element('p', '', state.codeRequired ? `房間代碼：${roomCode ?? '未提供'}` : '不需要房間代碼'));
    const link = new URL(location.pathname, location.origin);
    link.searchParams.set('room', state.roomId);
    if (state.codeRequired && roomCode) link.searchParams.set('code', roomCode);
    const inviteLink = element('input', 'invite-link');
    inviteLink.value = link.href; inviteLink.readOnly = true;
    inviteLink.setAttribute('aria-label', '邀請連結');
    const copy = button('複製邀請連結', async () => {
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
    });
    summary.append(inviteLink, copy);
    if (state.codeRequired) summary.append(roomButton('rotate-code', '更換房間代碼', async () => {
      if (!window.confirm('更換後舊代碼與舊邀請連結立即失效，已在房內的人不受影響。確定更換？')) return;
      await client.rotateCode();
      if (generation !== roomActionGeneration) return;
      invitation = '已更換房間代碼，請重新分享邀請連結。'; renderNotices();
    }));
  }
  const controls = element('section', 'panel');
  controls.append(element('h2', '', `你好，${decodeName(state.me.name)}`), element('p', '', `${roleLabels[state.me.role]}${state.me.forceMuted ? ' · 主控已鎖定靜音' : ''}`), connectionLine);
  const actions = element('div', 'actions');
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
    // Leaving after a pre-ACK snapshot also retires that entry's local feedback.
    if (landingEntry) landingEntry.cancelled = true;
    micTest?.stop(); micTest = null;
    testButton.textContent = '測試麥克風'; testButton.setAttribute('aria-pressed', 'false');
    await client.disconnect(); createdRoom = null; micNotice = invitation = ''; landing();
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
  audience.append(element('h2', '', `觀眾 · ${state.audienceCount}/${state.limits.maxAudience}`));
  if (controller && state.audience) {
    const list = element('ul', 'people');
    for (const person of state.audience) list.append(personRow(person, true, 'audience'));
    if (state.audience.length === 0) audience.append(element('p', 'muted', '目前沒有觀眾。'));
    audience.append(list);
  } else audience.append(element('p', 'muted', '觀眾名單僅提供給主控。'));
  grid.append(audience);
  const top = element('div', 'landing-grid'); top.append(summary, controls);
  content.replaceChildren(top, grid);
  renderedRoomSignature = signature;
  syncAudienceFilter(state); updateCooldown(); renderNotices();
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
  row.classList.toggle('speaking', client.speaking.has(person.participantId));
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
    if (slider.disabled || client.status === 'reconnecting') return;
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
  const remainingMs = client.handCooldownMs;
  const remaining = Math.ceil(remainingMs / 1000);
  if (cooldownButton?.isConnected) {
    cooldownButton.disabled = remaining > 0 || client.status === 'reconnecting';
    cooldownButton.textContent = remaining > 0 ? `舉手發言（${remaining} 秒）` : '舉手發言';
  }
  const returnButton = content.querySelector<HTMLButtonElement>('[data-return-stage]');
  if (returnButton) returnButton.disabled = client.status === 'reconnecting';
  syncRoomActions();
  scheduleCooldown(cooldownButton?.isConnected ? remainingMs : 0);
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
client.on('state', ({ detail }) => { if (landingEntry) landingEntry.entered = true; renderRoom(detail); });
client.on('status', ({ detail }) => {
  if (landingEntry && client.state) landingEntry.entered = true;
  status.textContent = statusLabels[detail];
  if (detail === 'disconnected' && !client.state) {
    micTest?.stop(); micTest = null;
    testButton.textContent = '測試麥克風'; testButton.setAttribute('aria-pressed', 'false');
    createdRoom = null; micNotice = invitation = ''; audioBlocked = false;
    quality.clear();
    syncMeter(); landing();
  }
  updateCooldown(); syncMicRetry();
});
client.on('created', ({ detail }) => { createdRoom = detail; });
client.on('closed', ({ detail }) => { if (landingEntry) landingEntry.entered = true; createdRoom = null; micNotice = ''; invitation = detail.reason === 'shutdown' ? '伺服器維護或重新啟動，房間已關閉；請稍後重新建立或加入。' : '房間已關閉，歡迎建立或加入其他舞台。'; audioBlocked = false; landing(); });
client.on('kicked', () => { if (landingEntry) landingEntry.entered = true; createdRoom = null; micNotice = ''; invitation = '你已被主控移出房間。'; audioBlocked = false; landing(); });
client.on('invite', ({ detail }) => {
  if (detail.participantId === client.me?.participantId) { invitation = '主控已邀請你上台，請允許麥克風權限。'; renderNotices(); }
});
client.on('stageleft', ({ detail }) => {
  if (detail.participantId === client.me?.participantId) { invitation = detail.reason === 'removed' ? '主控已將你移出舞台，你仍可收聽。' : ''; renderNotices(); }
});
client.on('micerror', ({ detail }) => { micRetryPending = false; micRetryAvailable = Boolean(client.me?.onStage); micNotice = `${detail.message}（${detail.name}）`; renderNotices(); });
client.on('audioblocked', () => { audioBlocked = true; renderNotices(); });
client.on('error', ({ detail }) => showError(detail.message));
// Toggle in place: a full re-render every few hundred ms would reset focus and scroll.
client.on('speaking', ({ detail }) => {
  const ids = new Set(detail.participantIds);
  for (const id of speakingIds) {
    if (!ids.has(id)) for (const row of personRows.get(id) ?? []) row.classList.toggle('speaking', false);
  }
  for (const id of ids) {
    if (!speakingIds.has(id)) for (const row of personRows.get(id) ?? []) row.classList.toggle('speaking', true);
  }
  speakingIds = ids;
});
client.on('quality', ({ detail }) => {
  const previous = quality;
  quality = new Map(detail.participants.map((q) => [q.participantId, q]));
  // Omitted IDs still need their old warnings removed, including duplicate rows.
  for (const id of new Set([...previous.keys(), ...quality.keys()])) {
    for (const row of personRows.get(id) ?? []) applyQuality(row);
  }
});
function refreshConnectionLine(): void {
  if (!client.state) return;
  const generation = roomActionGeneration, sequence = ++connectionPollSequence;
  void client.getStats().then(({ inbound, outbound }) => {
    // SDK polls can settle out of order; an obsolete empty result must not erase a newer display.
    if (generation !== roomActionGeneration || sequence !== connectionPollSequence) return;
    const parts: string[] = [];
    if (inbound?.lossPercent !== undefined) parts.push(`收聽掉包 ${inbound.lossPercent.toFixed(1)}%`);
    if (outbound?.lossPercent !== undefined) parts.push(`發言掉包 ${outbound.lossPercent.toFixed(1)}%`);
    const rtt = inbound?.rtt ?? outbound?.rtt;
    if (rtt !== undefined) parts.push(`延遲 ${Math.round(rtt * 1000)} ms`);
    if (inbound?.bufferMs !== undefined) parts.push(`緩衝 ${Math.round(inbound.bufferMs)} ms`);
    connectionLine.textContent = parts.length ? `你的連線：${parts.join(' · ')}` : '';
    connectionLine.classList.toggle('error', Math.max(inbound?.lossPercent ?? 0, outbound?.lossPercent ?? 0) >= POOR_LOSS_PERCENT);
  }, () => {});
}
/** Connection stats matter only inside a room; the separate cooldown timeout runs only while visible. */
let roomTimers: ReturnType<typeof setInterval>[] = [];
function syncRoomTimers(): void {
  const inRoom = client.state !== null;
  if (inRoom && !roomTimers.length) roomTimers = [setInterval(refreshConnectionLine, 2000)];
  else if (!inRoom && roomTimers.length) { roomTimers.forEach(clearInterval); roomTimers = []; connectionLine.textContent = ''; }
}
client.on('state', syncRoomTimers);
client.on('status', syncRoomTimers);
landing();
