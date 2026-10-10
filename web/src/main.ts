import { MAX_GAIN_DB, REACTIONS, StageClient, decodeName } from '../../packages/client/src/index.ts';
import type { ChatMessage, ConnectionQuality, MicTest, ParticipantView, RoomStatePayload } from '../../packages/client/src/index.ts';
import './styles.css';

const app = document.querySelector<HTMLDivElement>('#app')!;
const client = new StageClient({ url: `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws` });
const statusLabels = { waiting: '等待發言', live: '直播中', reconnecting: '重新連線中', disconnected: '未連線' };
const roleLabels = { controller: '主控', speaker: '發言者', audience: '觀眾' };
const params = new URLSearchParams(location.search);
let busy = false;
let audioBlocked = false;
let micNotice = '';
let invitation = '';
let createdRoom: { roomId: string; code?: string } | null = null;
let cooldownButton: HTMLButtonElement | null = null;
/** Latest server report per publisher; loss at or above this is flagged in the stage list. */
const POOR_LOSS_PERCENT = 5;
let quality = new Map<string, ConnectionQuality>();
/** Own connection, refreshed from `getStats()`; kept across re-renders of the room view. */
const connectionLine = element('p', 'muted connection');
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
const content = element('main');
app.append(header, notices, errorBox, content);
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
let micTest: MicTest | null = null;
let testingBusy = false;
let selectedInput = '';
let selectedOutput = '';
const testButton = button('測試麥克風', async () => {
  testingBusy = true;
  micSelect.disabled = true;
  try {
    if (micTest) { micTest.stop(); micTest = null; }
    else micTest = await client.startMicTest();
    testButton.textContent = micTest ? '停止測試' : '測試麥克風';
    testButton.setAttribute('aria-pressed', String(Boolean(micTest)));
  } finally { testingBusy = false; micSelect.disabled = false; syncMeter(); }
});
testButton.id = 'mic-test';
testButton.setAttribute('aria-pressed', 'false');
const levelLabel = element('label', 'mic-level-label', '麥克風音量');
const level = element('meter', 'mic-level');
level.id = 'mic-level';
level.min = 0; level.max = 1; level.value = 0;
levelLabel.append(level);
settings.append(testButton, levelLabel);
app.append(settings);
micSelect.onchange = () => {
  const deviceId = micSelect.value;
  micSelect.disabled = true;
  testingBusy = true;
  void run(async () => {
    await client.setInputDevice(deviceId);
    selectedInput = deviceId;
    if (micTest) {
      micTest.stop(); micTest = null;
      testButton.textContent = '測試麥克風'; testButton.setAttribute('aria-pressed', 'false');
      micTest = await client.startMicTest();
      testButton.textContent = '停止測試'; testButton.setAttribute('aria-pressed', 'true');
    }
  }).finally(() => { testingBusy = false; micSelect.disabled = false; micSelect.value = selectedInput; });
};
speakerSelect.onchange = () => {
  const deviceId = speakerSelect.value;
  speakerSelect.disabled = true;
  void run(async () => { await client.setOutputDevice(deviceId); selectedOutput = deviceId; })
    .finally(() => { speakerSelect.disabled = false; speakerSelect.value = selectedOutput; });
};
async function refreshDevices(): Promise<void> {
  const devices = await client.listAudioDevices();
  for (const [select, list, chosen] of [[micSelect, devices.inputs, selectedInput], [speakerSelect, devices.outputs, selectedOutput]] as const) {
    const defaultOption = element('option', '', '系統預設');
    defaultOption.value = '';
    select.replaceChildren(defaultOption);
    for (const [index, device] of list.entries()) {
      const option = element('option', '', device.label || `音訊裝置 ${index + 1}`);
      option.value = device.deviceId;
      select.append(option);
    }
    select.value = chosen;
  }
}
client.on('micready', () => { void refreshDevices().catch(() => {}); });
navigator.mediaDevices?.addEventListener('devicechange', () => { void refreshDevices().catch(() => {}); });
void refreshDevices().catch(() => {});
/** The level meter polls only while there is something to meter: a mic test or an on-stage mic. */
let meterTimer: ReturnType<typeof setInterval> | undefined;
function syncMeter(): void {
  if (client.me?.onStage && micTest) {
    micTest.stop(); micTest = null;
    testButton.textContent = '測試麥克風'; testButton.setAttribute('aria-pressed', 'false');
  }
  testButton.disabled = testingBusy || Boolean(client.me?.onStage);
  const metering = Boolean(micTest) || Boolean(client.me?.onStage);
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
function button(label: string, action: () => Promise<unknown>, className = ''): HTMLButtonElement {
  const node = element('button', className, label);
  node.type = 'button';
  node.onclick = () => { void run(action, node); };
  return node;
}
async function run(action: () => Promise<unknown>, target?: HTMLButtonElement): Promise<void> {
  if (target) target.disabled = true;
  errorBox.hidden = true;
  try { await action(); }
  catch (error) { showError(error instanceof Error ? error.message : '操作失敗，請稍後再試。'); }
  finally { if (target?.isConnected) target.disabled = false; updateCooldown(); }
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
  chatList.replaceChildren();
  cooldownButton = null;
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
  createSubmit.type = 'submit';
  create.append(codeLabel, createSubmit);
  create.onsubmit = (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    void run(async () => {
      micNotice = invitation = '';
      createdRoom = await client.createRoom({ name: createName.value.trim(), roomName: roomName.value.trim() || undefined, codeRequired: codeRequired.checked, token: createToken.value || undefined });
      if (client.state) renderRoom(client.state);
    }, createSubmit).finally(() => { busy = false; });
  };
  const join = element('form', 'panel');
  join.append(element('h2', '', '加入房間'));
  const roomId = field(join, '房間 ID', 'roomId', params.get('room') ?? '', true, 128);
  const code = field(join, '房間代碼（未設定時可留空）', 'code', params.get('code') ?? '', false, 16);
  const joinName = field(join, '你的名稱', 'name');
  const joinSubmit = element('button', 'primary', '加入收聽');
  joinSubmit.type = 'submit';
  join.append(joinSubmit);
  join.onsubmit = (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    void run(async () => {
      createdRoom = null; micNotice = invitation = '';
      await client.join({ roomId: roomId.value.trim(), code: code.value.trim() || undefined, name: joinName.value.trim() });
    }, joinSubmit).finally(() => { busy = false; });
  };
  grid.append(create, join);
  content.replaceChildren(intro, grid);
  renderNotices();
}
function renderNotices(): void {
  notices.replaceChildren();
  if (audioBlocked) {
    const banner = element('div', 'banner');
    banner.append(element('span', '', '自動播放遭阻擋。'), button('點擊啟用音訊', async () => {
      await client.unlockAudio(); audioBlocked = false; renderNotices();
    }, 'primary'));
    notices.append(banner);
  }
  if (micNotice) notices.append(element('p', 'banner', micNotice));
  if (invitation) notices.append(element('p', 'banner', invitation));
}
function renderRoom(state: RoomStatePayload): void {
  brand.textContent = decodeName(state.name);
  status.textContent = statusLabels[client.status];
  cooldownButton = null;
  const controller = state.me.role === 'controller';
  const summary = element('section', 'panel room-summary');
  summary.append(element('h2', '', '房間資訊'), element('p', '', `房間 ID：${state.roomId}`));
  if (state.recording) summary.append(element('p', 'badge recording', '● 錄音中：此房間的混音正在被錄下'));
  const roomCode = state.code ?? (createdRoom?.roomId === state.roomId ? createdRoom.code : undefined);
  if (controller) {
    summary.append(element('p', '', state.codeRequired ? `房間代碼：${roomCode ?? '未提供'}` : '不需要房間代碼'));
    const link = new URL(location.pathname, location.origin);
    link.searchParams.set('room', state.roomId);
    if (state.codeRequired && roomCode) link.searchParams.set('code', roomCode);
    const inviteLink = element('input', 'invite-link');
    inviteLink.value = link.href; inviteLink.readOnly = true;
    inviteLink.setAttribute('aria-label', '邀請連結');
    const copy = button('複製邀請連結', async () => {
      try { await navigator.clipboard.writeText(link.href); invitation = '已複製邀請連結，請只分享給受邀者。'; }
      catch { inviteLink.focus(); inviteLink.select(); invitation = '請長按或使用複製快捷鍵複製已選取的連結。'; }
      renderNotices();
    });
    summary.append(inviteLink, copy);
    if (state.codeRequired) summary.append(button('更換房間代碼', async () => {
      if (!window.confirm('更換後舊代碼與舊邀請連結立即失效，已在房內的人不受影響。確定更換？')) return;
      await client.rotateCode();
      invitation = '已更換房間代碼，請重新分享邀請連結。'; renderNotices();
    }));
    if (state.recordingAvailable) summary.append(state.recording
      ? button('停止錄音', () => client.stopRecording(), 'danger')
      : button('開始錄音', async () => {
        if (window.confirm('錄音會把所有人聽到的混音存到伺服器，房內每個人都會看到「錄音中」。確定開始？')) await client.startRecording();
      }));
  }
  const controls = element('section', 'panel');
  controls.append(element('h2', '', `你好，${decodeName(state.me.name)}`), element('p', '', `${roleLabels[state.me.role]}${state.me.forceMuted ? ' · 主控已鎖定靜音' : ''}`), connectionLine);
  const actions = element('div', 'actions');
  if (state.me.onStage) {
    const mute = button(state.me.muted ? '取消靜音' : '靜音', () => state.me.muted ? client.unmute() : client.mute());
    mute.disabled = state.me.forceMuted;
    actions.append(mute, button('離開舞台', () => client.leaveStage()));
  } else if (controller) {
    // An off-stage controller keeps control and returns by self-approval; raising a hand is audience-only.
    const returnButton = button('返回舞台', () => client.returnToStage(), 'primary');
    returnButton.dataset.returnStage = 'true';
    actions.append(returnButton);
  } else if (state.me.handRaised) {
    actions.append(button('收回舉手', () => client.withdrawHand()));
  } else {
    cooldownButton = button('舉手發言', () => client.raiseHand(), 'primary');
    actions.append(cooldownButton);
  }
  actions.append(button('離開房間', async () => {
    micTest?.stop(); micTest = null;
    testButton.textContent = '測試麥克風'; testButton.setAttribute('aria-pressed', 'false');
    await client.disconnect(); createdRoom = null; micNotice = invitation = ''; landing();
  }));
  if (controller) actions.append(button('關閉房間', async () => {
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
  grid.append(audience, chatPanel);
  const top = element('div', 'landing-grid'); top.append(summary, controls);
  content.replaceChildren(top, grid);
  updateCooldown(); renderNotices();
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
    const id = person.participantId;
    const actions = element('div', 'actions');
    if (kind === 'hand') actions.append(button('核准上台', () => client.approve(id), 'primary'), button('婉拒', () => client.reject(id)));
    if (kind === 'speaker') actions.append(gainSlider(person), button(person.forceMuted ? '解除強制靜音' : '強制靜音', () => person.forceMuted ? client.forceUnmute(id) : client.forceMute(id)), button('移出舞台', () => client.removeFromStage(id)));
    actions.append(button('移交控制權', async () => {
      if (window.confirm(`確定將控制權移交給 ${decodeName(person.name)}？`)) await client.transferControl(id);
    }), button('踢出房間', async () => {
      if (window.confirm(`確定將 ${decodeName(person.name)} 踢出房間？若要防止對方再進來，請接著更換房間代碼。`)) await client.kick(id);
    }, 'danger'));
    row.append(actions);
  }
  return row;
}
/** Controller's per-speaker level trim; sends on release (`change`) so dragging is one request. */
function gainSlider(person: ParticipantView): HTMLLabelElement {
  const label = element('label', 'gain', '音量');
  const slider = element('input');
  slider.type = 'range';
  slider.min = String(-MAX_GAIN_DB); slider.max = String(MAX_GAIN_DB); slider.step = '1';
  slider.value = String(person.gainDb);
  slider.title = `${person.gainDb} dB`;
  slider.onchange = () => { void run(() => client.setGain(person.participantId, Number(slider.value))); };
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
  const remaining = Math.ceil(client.handCooldownMs / 1000);
  if (cooldownButton?.isConnected) {
    cooldownButton.disabled = remaining > 0 || client.status === 'reconnecting';
    cooldownButton.textContent = remaining > 0 ? `舉手發言（${remaining} 秒）` : '舉手發言';
  }
  const returnButton = content.querySelector<HTMLButtonElement>('[data-return-stage]');
  if (returnButton) returnButton.disabled = client.status === 'reconnecting';
}
/** Chat lives outside `renderRoom` so a state update keeps the draft, the focus and the scroll position. */
const chatPanel = element('section', 'panel chat');
const chatList = element('ol', 'chat-log');
chatList.setAttribute('aria-live', 'polite');
const reactionFeed = element('div', 'reaction-feed');
reactionFeed.setAttribute('aria-hidden', 'true');
const reactionBar = element('div', 'actions reactions');
for (const emoji of REACTIONS) {
  const react = button(emoji, () => client.react(emoji));
  react.setAttribute('aria-label', `送出反應 ${emoji}`);
  reactionBar.append(react);
}
const chatForm = element('form', 'chat-form');
const chatInput = element('textarea');
chatInput.rows = 2; chatInput.placeholder = '輸入訊息，Enter 送出，Shift+Enter 換行';
chatInput.setAttribute('aria-label', '聊天訊息');
chatForm.append(chatInput, element('button', 'primary', '送出'));
chatForm.onsubmit = (event) => {
  event.preventDefault();
  const text = chatInput.value.trim();
  if (!text) return;
  void run(async () => { await client.sendChat(text); chatInput.value = ''; }, chatForm.querySelector('button')!);
};
chatInput.onkeydown = (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); chatForm.requestSubmit(); }
};
chatPanel.append(element('h2', '', '聊天'), reactionFeed, chatList, reactionBar, chatForm);
function chatItem(message: ChatMessage): HTMLLIElement {
  const item = element('li');
  const time = new Date(message.sentAt).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
  item.append(element('strong', '', decodeName(message.name)), element('time', 'muted', time), element('p', '', decodeName(message.text)));
  if (message.participantId === client.me?.participantId) item.classList.add('mine');
  return item;
}
function appendChat(messages: readonly ChatMessage[], replace: boolean): void {
  const atBottom = chatList.scrollHeight - chatList.scrollTop - chatList.clientHeight < 40;
  if (replace) chatList.replaceChildren();
  for (const message of messages) chatList.append(chatItem(message));
  while (chatList.childElementCount > 200) chatList.firstElementChild!.remove();
  if (atBottom || replace) chatList.scrollTop = chatList.scrollHeight;
}
client.on('chat', ({ detail }) => appendChat([detail], false));
client.on('chathistory', ({ detail }) => appendChat(detail.messages, true));
client.on('reaction', ({ detail }) => {
  const bubble = element('span', 'reaction', `${detail.emoji} ${decodeName(detail.name)}`);
  reactionFeed.append(bubble);
  while (reactionFeed.childElementCount > 12) reactionFeed.firstElementChild!.remove();
  setTimeout(() => bubble.remove(), 3000);
});
client.on('state', ({ detail }) => renderRoom(detail));
client.on('status', ({ detail }) => { status.textContent = statusLabels[detail]; updateCooldown(); });
client.on('created', ({ detail }) => { createdRoom = detail; });
client.on('closed', ({ detail }) => { createdRoom = null; micNotice = ''; invitation = detail.reason === 'shutdown' ? '伺服器維護或重新啟動，房間已關閉；請稍後重新建立或加入。' : '房間已關閉，歡迎建立或加入其他舞台。'; audioBlocked = false; landing(); });
client.on('kicked', () => { createdRoom = null; micNotice = ''; invitation = '你已被主控移出房間。'; audioBlocked = false; landing(); });
client.on('invite', ({ detail }) => {
  if (detail.participantId === client.me?.participantId) { invitation = '主控已邀請你上台，請允許麥克風權限。'; renderNotices(); }
});
client.on('stageleft', ({ detail }) => {
  if (detail.participantId === client.me?.participantId) { invitation = detail.reason === 'removed' ? '主控已將你移出舞台，你仍可收聽。' : ''; renderNotices(); }
});
client.on('micerror', ({ detail }) => { micNotice = `${detail.message}（${detail.name}）`; renderNotices(); });
client.on('audioblocked', () => { audioBlocked = true; renderNotices(); });
client.on('error', ({ detail }) => showError(detail.message));
// Toggle in place: a full re-render every few hundred ms would reset focus and scroll.
client.on('speaking', ({ detail }) => {
  const ids = new Set(detail.participantIds);
  for (const row of content.querySelectorAll<HTMLElement>('.person[data-participant-id]')) row.classList.toggle('speaking', ids.has(row.dataset.participantId!));
});
client.on('quality', ({ detail }) => {
  quality = new Map(detail.participants.map((q) => [q.participantId, q]));
  for (const row of content.querySelectorAll<HTMLElement>('.person[data-participant-id]')) applyQuality(row);
});
function refreshConnectionLine(): void {
  void client.getStats().then(({ inbound, outbound }) => {
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
/** Stats and the hand cooldown matter only inside a room; nothing polls on the landing page. */
let roomTimers: ReturnType<typeof setInterval>[] = [];
function syncRoomTimers(): void {
  const inRoom = client.state !== null;
  if (inRoom && !roomTimers.length) roomTimers = [setInterval(refreshConnectionLine, 2000), setInterval(updateCooldown, 250)];
  else if (!inRoom && roomTimers.length) { roomTimers.forEach(clearInterval); roomTimers = []; connectionLine.textContent = ''; }
}
client.on('state', syncRoomTimers);
client.on('status', syncRoomTimers);
landing();
