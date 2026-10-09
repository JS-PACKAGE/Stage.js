import { StageClient, decodeName } from '../../packages/client/src/index.ts';
import type { ParticipantView, RoomStatePayload } from '../../packages/client/src/index.ts';
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
  const createSubmit = element('button', 'primary', '建立並進入');
  createSubmit.type = 'submit';
  create.append(codeLabel, createSubmit);
  create.onsubmit = (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    void run(async () => {
      micNotice = invitation = '';
      createdRoom = await client.createRoom({ name: createName.value.trim(), roomName: roomName.value.trim() || undefined, codeRequired: codeRequired.checked });
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
  }
  const controls = element('section', 'panel');
  controls.append(element('h2', '', `你好，${decodeName(state.me.name)}`), element('p', '', `${roleLabels[state.me.role]}${state.me.forceMuted ? ' · 主控已鎖定靜音' : ''}`));
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
    await client.disconnect(); createdRoom = null; micNotice = invitation = ''; landing();
  }));
  if (controller) actions.append(button('關閉房間', async () => {
    if (window.confirm('確定關閉房間並讓所有人離場？')) await client.closeRoom();
  }, 'danger'));
  controls.append(actions);
  const grid = element('div', 'stage-grid');
  const speakers = panelList(`舞台 · ${state.speakers.length}/${state.limits.maxSpeakers}`, state.speakers, controller, 'speaker');
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
  if (person.muted) identity.append(element('span', 'badge', person.forceMuted ? '強制靜音' : '已靜音'));
  if (person.participantId === client.me?.participantId) identity.append(element('span', 'badge', '我'));
  row.append(identity);
  // The controller manages others; its own mic/stage use the personal controls above.
  if (controller && person.participantId !== client.me?.participantId) {
    const id = person.participantId;
    const actions = element('div', 'actions');
    if (kind === 'hand') actions.append(button('核准上台', () => client.approve(id), 'primary'), button('婉拒', () => client.reject(id)));
    if (kind === 'speaker') actions.append(button(person.forceMuted ? '解除強制靜音' : '強制靜音', () => person.forceMuted ? client.forceUnmute(id) : client.forceMute(id)), button('移出舞台', () => client.removeFromStage(id)));
    actions.append(button('移交控制權', async () => {
      if (window.confirm(`確定將控制權移交給 ${decodeName(person.name)}？`)) await client.transferControl(id);
    }));
    row.append(actions);
  }
  return row;
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
client.on('state', ({ detail }) => renderRoom(detail));
client.on('status', ({ detail }) => { status.textContent = statusLabels[detail]; updateCooldown(); });
client.on('created', ({ detail }) => { createdRoom = detail; });
client.on('closed', () => { createdRoom = null; micNotice = ''; invitation = '房間已關閉，歡迎建立或加入其他舞台。'; audioBlocked = false; landing(); });
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
setInterval(updateCooldown, 250);
landing();
