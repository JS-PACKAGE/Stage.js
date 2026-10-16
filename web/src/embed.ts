import type { StageClient as Client, StageEventMap } from '../../packages/client/src/index.ts';
import type * as StageLibrary from '../../packages/client/src/index.ts';
import './styles.css';
function input(id: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`#${id}`)!;
}
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const errorNotice = document.querySelector<HTMLDivElement>('#error-notice')!;
const lastError = document.querySelector<HTMLParagraphElement>('#last-error')!;
const handRejectionNotice = document.querySelector<HTMLParagraphElement>('#hand-rejected')!;
const errorDismiss = document.querySelector<HTMLButtonElement>('#error-dismiss')!;
const join = document.querySelector<HTMLFormElement>('#join')!;
const submit = join.querySelector<HTMLButtonElement>('button')!;
submit.setAttribute('aria-busy', 'false');
const hand = document.querySelector<HTMLButtonElement>('#hand')!;
const leave = document.querySelector<HTMLButtonElement>('#leave')!;
const closeRoom = document.querySelector<HTMLButtonElement>('#close-room')!;
const cancelJoin = document.querySelector<HTMLButtonElement>('#cancel-join')!;
const mic = document.querySelector<HTMLButtonElement>('#mic')!;
const rename = document.querySelector<HTMLButtonElement>('#rename')!;
const handQueuePanel = document.querySelector<HTMLDetailsElement>('#hand-queue')!;
const handQueueSummary = document.querySelector<HTMLElement>('#hand-queue-summary')!;
const handQueueNotice = document.querySelector<HTMLParagraphElement>('#hand-queue-notice')!;
const handQueueList = document.querySelector<HTMLUListElement>('#hand-queue-list')!;
const stageManagementPanel = document.querySelector<HTMLDetailsElement>('#stage-management')!;
const stageManagementSummary = document.querySelector<HTMLElement>('#stage-management-summary')!;
const stageManagementNotice = document.querySelector<HTMLParagraphElement>('#stage-management-notice')!;
const stageManagementList = document.querySelector<HTMLUListElement>('#stage-management-list')!;
const roomNamePanel = document.querySelector<HTMLDivElement>('#room-name-panel')!;
const roomNameCurrent = document.querySelector<HTMLParagraphElement>('#room-name-current')!;
const roomNameDraft = input('room-name-draft');
const roomNameUpdate = document.querySelector<HTMLButtonElement>('#room-name-update')!;
const stage = document.querySelector<HTMLButtonElement>('#stage')!;
const micRetry = document.querySelector<HTMLButtonElement>('#mic-retry')!;
const audioRetry = document.querySelector<HTMLButtonElement>('#audio-retry')!;
const audioRetryStatus = document.querySelector<HTMLParagraphElement>('#audio-retry-status')!;
const microphonePanel = document.querySelector<HTMLDivElement>('#microphone-panel')!;
const microphoneSelect = document.querySelector<HTMLSelectElement>('#microphone-device')!;
const microphoneRefresh = document.querySelector<HTMLButtonElement>('#microphone-refresh')!;
const microphoneApply = document.querySelector<HTMLButtonElement>('#microphone-apply')!;
const outputPanel = document.querySelector<HTMLDivElement>('#output-panel')!;
const outputSelect = document.querySelector<HTMLSelectElement>('#output-device')!;
const outputRefresh = document.querySelector<HTMLButtonElement>('#output-refresh')!;
const outputApply = document.querySelector<HTMLButtonElement>('#output-apply')!;
const outputSupport = document.querySelector<HTMLParagraphElement>('#output-support')!;
const audio = document.querySelector<HTMLAudioElement>('#audio')!;
const unlock = document.querySelector<HTMLButtonElement>('#unlock')!;
const params = new URLSearchParams(location.search);
input('host').value = params.get('host') ?? location.origin;
input('ws-path').value = params.get('wsPath') ?? '/ws';
input('room').value = params.get('room') ?? '';
input('code').value = params.get('code') ?? '';
let client: Client | null = null;
let pendingHand: { client: Client } | undefined;
let pendingMic: { client: Client } | undefined;
let pendingStage: { client: Client } | undefined;
let controlsClient: Client | undefined;
let pendingRename: { client: Client; roomId: string; participantId: string; generation: number } | undefined;
let roomNameOwner: { client: Client; roomId: string; participantId: string; generation: number } | undefined;
let roomNameAttempt: object | undefined;
interface HandQueueRow {
  node: HTMLLIElement; name: HTMLSpanElement; approve: HTMLButtonElement; reject: HTMLButtonElement;
}
let handQueueOwner: { client: Client; roomId: string; participantId: string; generation: number } | undefined;
const handQueueRows = new Map<string, HandQueueRow>();
const handQueuePending = new Map<string, object>();
let handQueueOrder: string[] = [];
interface StageManagementRow {
  node: HTMLLIElement; name: HTMLSpanElement; mute: HTMLButtonElement; remove: HTMLButtonElement; transfer: HTMLButtonElement;
  gainCurrent: HTMLSpanElement; gainLabel: HTMLSpanElement; gainDraft: HTMLInputElement; gainApply: HTMLButtonElement; gainNotice: HTMLSpanElement;
}
let stageManagementOwner: {
  client: Client; roomId: string; participantId: string; generation: number; revision: number; transferFenced: boolean;
} | undefined;
let roomConfirmation: object | undefined;
let roomCloseOwner: {
  client: Client; roomId: string; participantId: string; generation: number; revision: number; fenced: boolean;
} | undefined;
let roomCloseFence: { client: Client; roomId: string; participantId: string; generation: number } | undefined;
let pendingRoomClose: { revision: number; invalidated: boolean } | undefined;
let roomCloseRenderRevision = 0;
let pendingTransfer: { id: string; row: StageManagementRow; revision: number; invalidated: boolean } | undefined;
const stageManagementRows = new Map<string, StageManagementRow>();
const stageManagementPending = new Map<string, object>();
let stageManagementOrder: string[] = [];
let decodeRoomName: typeof StageLibrary.decodeName | undefined;
let maxGainDb: number | undefined;
let micRetryParticipant: string | undefined;
let pendingMicRetry: { client: Client } | undefined;
let microphoneOwner: {
  client: Client; roomId: string; participantId: string; generation: number;
  draft: string; choices: Set<string>;
} | undefined;
let pendingMicrophone: { kind: 'refresh' | 'apply' } | undefined;
let audioRetryOwner: { client: Client; roomId: string; participantId: string; generation: number } | undefined;
let pendingAudioRetry: object | undefined;
// Every embed client shares one page audio element; native sink work cannot be cancelled by leaving.
let outputDraft = '';
let outputChoices = new Set(['']);
let pendingOutput: { kind: 'refresh' | 'apply' } | undefined;
let outputOwner: { client: Client; roomId: string; participantId: string; generation: number } | undefined;
let playbackGeneration = 0;
let pendingUnlock: { client: Client | null; generation: number } | undefined;
let entryGeneration = 0;
let feedbackRevision = 0;
let handRejectionOwner: { client: Client; roomId: string; participantId: string; generation: number } | undefined;
function retireHandRejection(): void {
  handRejectionOwner = undefined;
  if (!handRejectionNotice.hidden) handRejectionNotice.hidden = true;
  if (handRejectionNotice.textContent) handRejectionNotice.textContent = '';
}
function eligibleHandRejection(current: Client | null): boolean {
  const me = current?.state?.me;
  return Boolean(current && current === controlsClient && me?.role === 'audience' && !me.onStage && !me.handRaised
    && current.status !== 'reconnecting' && current.status !== 'disconnected');
}
function syncHandRejection(): void {
  const owner = handRejectionOwner, state = client?.state;
  if (!eligibleHandRejection(client) || (owner && (owner.client !== client || owner.generation !== entryGeneration
    || state?.roomId !== owner.roomId || state.me.participantId !== owner.participantId))) {
    retireHandRejection(); return;
  }
  if (!owner) return;
  const message = '主控已婉拒這次舉手申請。';
  if (handRejectionNotice.textContent !== message) handRejectionNotice.textContent = message;
  if (handRejectionOwner === owner && handRejectionNotice.hidden) handRejectionNotice.hidden = false;
}
let cancelEntry: (() => void) | undefined;
function hideCancel(): void {
  cancelEntry = undefined; cancelJoin.hidden = cancelJoin.disabled = true;
}
function retireControls(): void {
  controlsClient = undefined; roomCloseFence = undefined; retireRoomClose(); retireHandRejection(); retireHandQueue(); retireStageManagement();
  pendingHand = undefined; pendingMic = undefined; pendingStage = undefined;
  micRetryParticipant = undefined; pendingMicRetry = undefined;
  pendingRename = undefined; syncRename(); retireRoomName(); retireMicrophone(); retireAudioRetry(); retireOutput();
}
/** Retire initial-join feedback before user or terminal callbacks can start another entry. */
function retireEntry(): number {
  hideCancel();
  submit.disabled = false; submit.setAttribute('aria-busy', 'false');
  return ++entryGeneration;
}
let handTimer: ReturnType<typeof setTimeout> | undefined;
let handTimerDue = 0;
function syncHand(): void {
  syncHandRejection();
  const me = client === controlsClient ? client?.me : undefined;
  const audience = Boolean(me && !me.onStage && me.role !== 'controller');
  const pending = Boolean(pendingHand && pendingHand.client === client);
  const remaining = audience ? client!.handCooldownMs : 0;
  const seconds = Math.ceil(remaining / 1000);
  hand.disabled = !audience || client?.status === 'reconnecting' || pending || (!me?.handRaised && seconds > 0);
  hand.setAttribute('aria-busy', String(pending));
  const position = audience && me?.handRaised
    ? client?.state?.hands.findIndex(person => person.participantId === me.participantId) ?? -1 : -1;
  const withdraw = position < 0 ? '收回舉手'
    : `收回舉手（${client?.status === 'reconnecting' ? '上次' : ''}佇列第 ${position + 1} 位）`;
  hand.textContent = me?.handRaised ? withdraw : seconds ? `舉手發言（${seconds} 秒）` : '舉手發言';
  scheduleHandCooldown(me && !me.handRaised ? remaining : 0);
}
function ownsRename(operation: NonNullable<typeof pendingRename>): boolean {
  const state = client?.state;
  return client === operation.client && controlsClient === operation.client && operation.generation === entryGeneration
    && state?.roomId === operation.roomId && state.me.participantId === operation.participantId;
}
function syncRename(): void {
  if (pendingRename && !ownsRename(pendingRename)) pendingRename = undefined;
  const state = client === controlsClient ? client?.state : undefined;
  rename.hidden = !state?.me;
  rename.disabled = rename.hidden || client?.status === 'reconnecting' || Boolean(pendingRename);
  rename.setAttribute('aria-busy', String(Boolean(pendingRename)));
}
function retireRoomName(): void {
  roomNameOwner = undefined; roomNameAttempt = undefined;
  roomNameDraft.value = ''; roomNameCurrent.textContent = '';
  roomNamePanel.hidden = true; roomNameDraft.disabled = roomNameUpdate.disabled = true;
  roomNameUpdate.setAttribute('aria-busy', 'false');
}
function syncRoomName(): void {
  const current = client, state = current?.state;
  if (!current || current !== controlsClient || !state || state.me.role !== 'controller'
    || current.status === 'disconnected' || !decodeRoomName) { retireRoomName(); return; }
  const owner = roomNameOwner;
  if (!owner || owner.client !== current || owner.generation !== entryGeneration
    || owner.roomId !== state.roomId || owner.participantId !== state.me.participantId) {
    retireRoomName();
    roomNameOwner = { client: current, roomId: state.roomId, participantId: state.me.participantId, generation: entryGeneration };
    roomNameDraft.value = decodeRoomName(state.name);
  }
  // Authoritative updates change the accepted title without overwriting a same-controller draft.
  roomNameCurrent.textContent = `目前房間名稱：${decodeRoomName(state.name)}`;
  roomNamePanel.hidden = false; roomNameDraft.disabled = false;
  roomNameUpdate.disabled = current.status === 'reconnecting' || Boolean(roomNameAttempt);
  roomNameUpdate.setAttribute('aria-busy', String(Boolean(roomNameAttempt)));
}
function retireHandQueue(): void {
  handQueueOwner = undefined; handQueuePending.clear();
  for (const row of handQueueRows.values()) {
    for (const button of [row.approve, row.reject]) { button.disabled = true; button.setAttribute('aria-busy', 'false'); }
  }
  if (handQueueRows.size) handQueueList.replaceChildren();
  handQueueRows.clear(); handQueueOrder = [];
  handQueuePanel.hidden = true; handQueuePanel.open = false;
  handQueueSummary.textContent = ''; handQueueNotice.textContent = '';
}
function syncHandQueue(): void {
  const current = client, state = current?.state;
  const active = current?.status === 'waiting' || current?.status === 'live';
  if (!current || current !== controlsClient || !state || state.me.role !== 'controller' || !decodeRoomName
    || (!active && current.status !== 'reconnecting')) { retireHandQueue(); return; }
  const owner = handQueueOwner;
  if (!owner || owner.client !== current || owner.generation !== entryGeneration
    || owner.roomId !== state.roomId || owner.participantId !== state.me.participantId) {
    retireHandQueue();
    // Reconnect may retain an owned controller seat, but cannot establish a new tenure.
    if (!active) return;
    handQueueOwner = { client: current, roomId: state.roomId, participantId: state.me.participantId, generation: entryGeneration };
  }
  const seen = new Set<string>();
  const people = state.hands.filter(person => {
    if (!person.participantId || person.participantId === state.me.participantId || seen.has(person.participantId)
      || person.role !== 'audience' || !person.handRaised || person.onStage) return false;
    seen.add(person.participantId); return true;
  });
  const supported = typeof current.approve === 'function' && typeof current.reject === 'function';
  handQueuePanel.hidden = false;
  handQueueSummary.textContent = `舉手申請（${people.length}）${active ? '' : ' · 上次收到'}`;
  handQueueNotice.textContent = !active ? '重新連線中，暫時不能處理申請。'
    : !supported ? '此 SDK 的部分申請處理功能無法使用。'
    : people.length ? '請選擇要核准上台或婉拒的申請；是否可上台仍由伺服器決定。' : '目前沒有舉手申請。';
  for (const person of people) {
    const id = person.participantId;
    let row = handQueueRows.get(id);
    if (!row) {
      const node = document.createElement('li'), name = document.createElement('span'), actions = document.createElement('div');
      const approve = document.createElement('button'), reject = document.createElement('button');
      node.className = 'person'; name.className = 'identity'; actions.className = 'actions';
      approve.type = reject.type = 'button'; approve.textContent = '核准上台'; reject.textContent = '婉拒';
      row = { node, name, approve, reject };
      const original = row;
      approve.onclick = () => moderateHand(id, original, 'approve');
      reject.onclick = () => moderateHand(id, original, 'reject');
      actions.append(approve, reject); node.append(name, actions); handQueueRows.set(id, row);
    }
    const name = decodeRoomName(person.name), label = `${name}${person.connected ? '' : '（暫時離線）'}`;
    if (row.name.textContent !== label) row.name.textContent = label;
    const labels = { approve: `核准 ${name} 上台`, reject: `婉拒 ${name} 的舉手申請` };
    for (const kind of ['approve', 'reject'] as const) {
      const button = row[kind], pending = handQueuePending.has(id);
      if (button.getAttribute('aria-label') !== labels[kind]) button.setAttribute('aria-label', labels[kind]);
      const disabled = !active || pending || typeof current[kind] !== 'function', busy = String(pending);
      if (button.disabled !== disabled) button.disabled = disabled;
      if (button.getAttribute('aria-busy') !== busy) button.setAttribute('aria-busy', busy);
    }
  }
  for (const [id, row] of handQueueRows) if (!seen.has(id)) {
    for (const button of [row.approve, row.reject]) { button.disabled = true; button.setAttribute('aria-busy', 'false'); }
    handQueueRows.delete(id);
  }
  const order = people.map(person => person.participantId);
  if (order.length !== handQueueOrder.length || order.some((id, index) => id !== handQueueOrder[index])) {
    handQueueList.replaceChildren(...order.map(id => handQueueRows.get(id)!.node)); handQueueOrder = order;
  }
}
function currentHandRow(id: string, row: HandQueueRow, kind: 'approve' | 'reject'): boolean {
  return handQueueRows.get(id) === row && row.node.parentElement === handQueueList
    && row.node.contains(row[kind]) && !handQueuePanel.hidden;
}
function moderateHand(id: string, row: HandQueueRow, kind: 'approve' | 'reject'): void {
  syncHandQueue();
  const owner = handQueueOwner;
  if (!owner || !currentHandRow(id, row, kind) || handQueuePending.has(id)
    || (owner.client.status !== 'waiting' && owner.client.status !== 'live')
    || typeof owner.client[kind] !== 'function') return;
  // A target may disappear in state before its ACK, so pending belongs to the tenure, not its row.
  const attempt = {};
  handQueuePending.set(id, attempt); syncHandQueue();
  const current = (): boolean => {
    if (handQueueOwner !== owner || handQueuePending.get(id) !== attempt) return false;
    syncHandQueue();
    return handQueueOwner === owner && handQueuePending.get(id) === attempt;
  };
  const eligible = (): boolean => current() && currentHandRow(id, row, kind)
    && (owner.client.status === 'waiting' || owner.client.status === 'live');
  void (async () => {
    try {
      if (!eligible() || typeof owner.client[kind] !== 'function') return;
      await owner.client[kind](id);
    } catch (error) {
      // Promise-specific feedback requires the original row; global SDK errors retain their existing policy.
      if (eligible()) report(error);
    } finally {
      if (current()) { handQueuePending.delete(id); syncHandQueue(); }
    }
  })();
}
function retireStageManagement(): void {
  stageManagementOwner = undefined; stageManagementPending.clear(); pendingTransfer = undefined;
  for (const row of stageManagementRows.values()) {
    for (const button of [row.mute, row.remove, row.transfer, row.gainDraft, row.gainApply]) { button.disabled = true; button.setAttribute('aria-busy', 'false'); }
  }
  if (stageManagementRows.size) stageManagementList.replaceChildren();
  stageManagementRows.clear(); stageManagementOrder = [];
  stageManagementPanel.hidden = true; stageManagementPanel.open = false;
  stageManagementSummary.textContent = ''; stageManagementNotice.textContent = '';
}
function syncStageManagement(): void {
  const current = client, state = current?.state;
  const active = current?.status === 'waiting' || current?.status === 'live';
  if (!current || current !== controlsClient || !state || state.me.role !== 'controller' || !decodeRoomName
    || (!active && current.status !== 'reconnecting')) { retireStageManagement(); return; }
  const owner = stageManagementOwner;
  if (!owner || owner.client !== current || owner.generation !== entryGeneration
    || owner.roomId !== state.roomId || owner.participantId !== state.me.participantId) {
    retireStageManagement();
    // Reconnect can preserve an observed controller tenure, but cannot establish a new one.
    if (!active) return;
    stageManagementOwner = { client: current, roomId: state.roomId, participantId: state.me.participantId,
      generation: entryGeneration, revision: 0, transferFenced: false };
  }
  const seen = new Set<string>();
  const people = state.speakers.filter(person => {
    if (!person.participantId || person.participantId === state.me.participantId || seen.has(person.participantId)
      || person.role !== 'speaker' || !person.onStage) return false;
    seen.add(person.participantId); return true;
  });
  invalidateTransfer();
  stageManagementPanel.hidden = false;
  stageManagementSummary.textContent = `舞台管理（${people.length}）${active ? '' : ' · 上次收到'}`;
  stageManagementNotice.textContent = `${active ? (people.length ? '' : '目前沒有其他台上發言者。') : '重新連線中，暫時不能管理舞台。'}解除靜音鎖定會保留對方自行靜音設定；移下台後仍留在房間。移交控制權須確認，完成後你會失去主控權限，但保留目前台位並留在房間。`;
  for (const person of people) {
    const id = person.participantId;
    let row = stageManagementRows.get(id);
    if (!row) {
      const node = document.createElement('li'), name = document.createElement('span'), actions = document.createElement('div');
      const mute = document.createElement('button'), remove = document.createElement('button'), transfer = document.createElement('button');
      node.className = 'person'; name.className = 'identity'; actions.className = 'actions';
      mute.type = remove.type = transfer.type = 'button'; remove.textContent = '移下台'; transfer.textContent = '移交控制權';
      const gain = document.createElement('div'), gainCurrent = document.createElement('span'), gainField = document.createElement('label');
      const gainLabel = document.createElement('span'), gainDraft = document.createElement('input');
      const gainApply = document.createElement('button'), gainNotice = document.createElement('span');
      gainCurrent.className = 'identity'; gainField.className = 'field'; gainNotice.className = 'identity';
      gainDraft.type = 'number'; gainDraft.step = '0.1'; gainDraft.value = String(person.gainDb);
      gainApply.type = 'button'; gainApply.textContent = '套用混音增益';
      row = { node, name, mute, remove, transfer, gainCurrent, gainLabel, gainDraft, gainApply, gainNotice };
      const original = row;
      mute.onclick = () => moderateStage(id, original, 'mute');
      remove.onclick = () => moderateStage(id, original, 'remove');
      transfer.onclick = () => transferStageControl(id, original);
      gainDraft.oninput = gainDraft.onchange = () => syncStageManagement();
      gainApply.onclick = () => applyStageGain(id, original);
      gainField.append(gainLabel, gainDraft); gain.append(gainCurrent, gainField, gainNotice, gainApply);
      actions.append(mute, remove, transfer); node.append(name, actions, gain); stageManagementRows.set(id, row);
    }
    const name = decodeRoomName(person.name);
    const label = `${name} · ${person.muted ? '已靜音' : '未靜音'} · ${person.forceMuted ? '靜音已鎖定' : '靜音未鎖定'}${person.connected ? '' : ' · 暫時離線（保留席位）'}`;
    if (row.name.textContent !== label) row.name.textContent = label;
    const gainSupported = maxGainDb !== undefined && typeof current.setGain === 'function';
    const accepted = `目前混音增益：${person.gainDb > 0 ? '+' : ''}${person.gainDb} dB${active ? '' : '（上次收到）'}`;
    if (row.gainCurrent.textContent !== accepted) row.gainCurrent.textContent = accepted;
    const gainLabel = `${name} 的混音增益草稿（dB）${gainSupported ? `，範圍 -${maxGainDb} 至 +${maxGainDb}，步進 0.1` : ''}`;
    if (row.gainLabel.textContent !== gainLabel) row.gainLabel.textContent = gainLabel;
    if (maxGainDb !== undefined) {
      const min = String(-maxGainDb), max = String(maxGainDb);
      if (row.gainDraft.min !== min) row.gainDraft.min = min;
      if (row.gainDraft.max !== max) row.gainDraft.max = max;
    }
    const gainNotice = gainSupported
      ? '調整這位發言者在房間混音中的音量；0 表示不手動增減。可能在後續音訊或返回舞台時生效，不會解除麥克風靜音。'
      : '此 SDK 不支援混音增益調整；其他舞台操作仍可使用。';
    if (row.gainNotice.textContent !== gainNotice) row.gainNotice.textContent = gainNotice;
    const gainBusy = String(stageManagementPending.has(id));
    const gainDisabled = !active || !state.me.connected || !gainSupported || stageManagementPending.has(id) || Boolean(pendingTransfer);
    if (row.gainDraft.disabled !== gainDisabled) row.gainDraft.disabled = gainDisabled;
    const applyDisabled = row.gainDraft.disabled || stageGainDraft(row) === undefined;
    if (row.gainApply.disabled !== applyDisabled) row.gainApply.disabled = applyDisabled;
    if (row.gainDraft.getAttribute('aria-busy') !== gainBusy) row.gainDraft.setAttribute('aria-busy', gainBusy);
    if (row.gainApply.getAttribute('aria-busy') !== gainBusy) row.gainApply.setAttribute('aria-busy', gainBusy);
    const gainApplyLabel = `套用 ${name} 的混音增益`;
    if (row.gainApply.getAttribute('aria-label') !== gainApplyLabel) row.gainApply.setAttribute('aria-label', gainApplyLabel);
    const muteLabel = person.forceMuted ? '解除靜音鎖定' : '鎖定靜音';
    if (row.mute.textContent !== muteLabel) row.mute.textContent = muteLabel;
    const labels = { mute: `${muteLabel}：${name}`, remove: `將 ${name} 移下台` };
    for (const kind of ['mute', 'remove'] as const) {
      const button = row[kind], pending = stageManagementPending.has(id);
      const method = kind === 'remove' ? 'removeFromStage' : person.forceMuted ? 'forceUnmute' : 'forceMute';
      if (button.getAttribute('aria-label') !== labels[kind]) button.setAttribute('aria-label', labels[kind]);
      const disabled = !active || pending || Boolean(pendingTransfer) || typeof current[method] !== 'function', busy = String(pending);
      if (button.disabled !== disabled) button.disabled = disabled;
      if (button.getAttribute('aria-busy') !== busy) button.setAttribute('aria-busy', busy);
    }
    const transferLabel = `將控制權移交給 ${name}`;
    if (row.transfer.getAttribute('aria-label') !== transferLabel) row.transfer.setAttribute('aria-label', transferLabel);
    const transferHidden = typeof current.transferControl !== 'function';
    if (row.transfer.hidden !== transferHidden) row.transfer.hidden = transferHidden;
    const transferDisabled = Boolean(pendingTransfer) || stageManagementPending.size > 0
      || !eligibleTransfer(stageManagementOwner, id, row);
    if (row.transfer.disabled !== transferDisabled) row.transfer.disabled = transferDisabled;
    const transferBusy = String(pendingTransfer?.id === id);
    if (row.transfer.getAttribute('aria-busy') !== transferBusy) row.transfer.setAttribute('aria-busy', transferBusy);
  }
  for (const [id, row] of stageManagementRows) if (!seen.has(id)) {
    for (const button of [row.mute, row.remove, row.transfer, row.gainDraft, row.gainApply]) { button.disabled = true; button.setAttribute('aria-busy', 'false'); }
    stageManagementRows.delete(id);
  }
  const order = people.map(person => person.participantId);
  if (order.length !== stageManagementOrder.length || order.some((id, index) => id !== stageManagementOrder[index])) {
    stageManagementList.replaceChildren(...order.map(id => stageManagementRows.get(id)!.node)); stageManagementOrder = order;
  }
  invalidateTransfer();
  // New keyed rows only become eligible after insertion into the list.
  for (const [id, row] of stageManagementRows) {
    const disabled = Boolean(pendingTransfer) || stageManagementPending.size > 0 || !eligibleTransfer(stageManagementOwner, id, row);
    if (row.transfer.disabled !== disabled) row.transfer.disabled = disabled;
  }
}
function currentStageRow(id: string, row: StageManagementRow, kind: 'mute' | 'remove' | 'transfer' | 'gainApply'): boolean {
  return stageManagementRows.get(id) === row && row.node.parentElement === stageManagementList
    && row.node.contains(row[kind]) && !stageManagementPanel.hidden;
}
function moderateStage(id: string, row: StageManagementRow, kind: 'mute' | 'remove'): void {
  syncStageManagement();
  const owner = stageManagementOwner;
  if (!owner || !currentStageRow(id, row, kind) || stageManagementPending.has(id) || pendingTransfer
    || (owner.client.status !== 'waiting' && owner.client.status !== 'live')) return;
  const person = owner.client.state?.speakers.find(person => person.participantId === id && person.role === 'speaker' && person.onStage);
  if (!person || id === owner.participantId) return;
  const method = kind === 'remove' ? 'removeFromStage' : person.forceMuted ? 'forceUnmute' : 'forceMute';
  if (typeof owner.client[method] !== 'function') return;
  // State may remove and re-add the same ID before ACK; the token outlives its original row.
  const attempt = {};
  stageManagementPending.set(id, attempt); syncStageManagement();
  const current = (): boolean => {
    if (stageManagementOwner !== owner || stageManagementPending.get(id) !== attempt) return false;
    syncStageManagement();
    return stageManagementOwner === owner && stageManagementPending.get(id) === attempt;
  };
  const eligible = (): boolean => current() && currentStageRow(id, row, kind)
    && (owner.client.status === 'waiting' || owner.client.status === 'live');
  void (async () => {
    try {
      if (!eligible() || typeof owner.client[method] !== 'function') return;
      await owner.client[method](id);
    } catch (error) {
      // Original-row feedback is isolated; SDK global wire errors keep their existing policy.
      if (eligible()) report(error);
    } finally {
      if (current()) { stageManagementPending.delete(id); syncStageManagement(); }
    }
  })();
}
function stageGainDraft(row: StageManagementRow): number | undefined {
  const text = row.gainDraft.value.trim();
  // Native number fields can be blank or mid-edit; never coerce those drafts to zero or clamp them.
  if (maxGainDb === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return;
  const value = Number(text);
  return Number.isFinite(value) && Math.abs(value) <= maxGainDb ? value : undefined;
}
function applyStageGain(id: string, row: StageManagementRow): void {
  syncStageManagement();
  const owner = stageManagementOwner, value = stageGainDraft(row);
  if (!owner || value === undefined) return;
  const eligible = (): boolean => stageManagementOwner === owner
    && currentStageRow(id, row, 'gainApply') && row.node.contains(row.gainDraft)
    && owner.client.state?.me.connected === true
    && (owner.client.status === 'waiting' || owner.client.status === 'live')
    && typeof owner.client.setGain === 'function' && stageGainDraft(row) !== undefined;
  if (!eligible() || pendingTransfer || stageManagementPending.has(id)) return;
  // Share the same target token with moderation, including when its row disappears before ACK.
  const attempt = {};
  stageManagementPending.set(id, attempt); syncStageManagement();
  const current = (): boolean => {
    if (stageManagementOwner !== owner || stageManagementPending.get(id) !== attempt) return false;
    syncStageManagement();
    return stageManagementOwner === owner && stageManagementPending.get(id) === attempt;
  };
  void (async () => {
    try {
      if (!current() || !eligible()) return;
      await owner.client.setGain(id, value);
    } catch (error) {
      if (current() && eligible()) report(error);
    } finally {
      // ACK never writes either accepted gain or draft; only snapshots own accepted state.
      if (current()) { stageManagementPending.delete(id); syncStageManagement(); }
    }
  })();
}
function transferPerson(current: Client, id: string) {
  // Match the first valid speaker used by the keyed roster, including its connectivity and name.
  return current.state?.speakers.find(person => person.participantId === id && person.role === 'speaker' && person.onStage);
}
function eligibleTransfer(owner: typeof stageManagementOwner, id: string, row: StageManagementRow): boolean {
  if (!owner) return false;
  const current = owner.client, state = current.state;
  return stageManagementOwner === owner && client === current && controlsClient === current
    && owner.generation === entryGeneration && state?.roomId === owner.roomId
    && state.me.participantId === owner.participantId && state.me.role === 'controller' && state.me.connected === true
    && (current.status === 'waiting' || current.status === 'live') && !owner.transferFenced
    && typeof current.transferControl === 'function' && typeof globalThis.confirm === 'function'
    && id !== owner.participantId && currentStageRow(id, row, 'transfer')
    && transferPerson(current, id)?.connected === true;
}
function invalidateTransfer(): void {
  const attempt = pendingTransfer, owner = stageManagementOwner;
  // An observed invalid state cannot be undone by a later snapshot while confirmation is open.
  if (attempt && (!owner || attempt.revision !== owner.revision || !eligibleTransfer(owner, attempt.id, attempt.row)))
    attempt.invalidated = true;
}
function fenceTransfer(render = true): void {
  const owner = stageManagementOwner;
  if (!owner) return;
  owner.revision++; owner.transferFenced = true;
  if (pendingTransfer) pendingTransfer.invalidated = true;
  // Notification deltas are not authoritative state for existing moderation controls.
  if (render) syncStageManagement();
}
function transferStageControl(id: string, row: StageManagementRow): void {
  if (roomConfirmation) { syncStageManagement(); return; }
  const admission = {};
  roomConfirmation = admission;
  try {
    // Keep the existing pre-admission reconciliation without allowing nested dialogs from render.
    syncStageManagement();
    const owner = stageManagementOwner;
    if (!owner || pendingTransfer || stageManagementPending.size || !eligibleTransfer(owner, id, row)) return;
    const attempt = pendingTransfer = { id, row, revision: owner.revision, invalidated: false };
    roomConfirmation = attempt;
    const current = (): boolean => {
      if (stageManagementOwner !== owner || pendingTransfer !== attempt) return false;
      syncStageManagement();
      return stageManagementOwner === owner && pendingTransfer === attempt;
    };
    const eligible = (): boolean => current() && !attempt.invalidated && attempt.revision === owner.revision
      && eligibleTransfer(owner, id, row);
    void (async () => {
      try {
        // Reserve the entire stage list before the synchronous dialog or SDK can reenter.
        if (!eligible()) return;
        const person = transferPerson(owner.client, id)!;
        if (!globalThis.confirm(`確定將控制權移交給 ${decodeRoomName!(person.name)}？你將失去主控權限，但保留目前台位並留在房間。`)
          || !eligible()) return;
        roomConfirmation = undefined;
        await owner.client.transferControl(id);
      } catch (error) {
        if (eligible()) report(error);
      } finally {
        if (roomConfirmation === attempt) roomConfirmation = undefined;
        // Settlement releases only this tenure and exact token, even if its row disappeared.
        if (current()) { pendingTransfer = undefined; syncStageManagement(); }
      }
    })();
  } finally { if (roomConfirmation === admission) roomConfirmation = undefined; }
}
function eligibleRoomClose(owner: typeof roomCloseOwner): boolean {
  if (!owner || roomCloseOwner !== owner) return false;
  const current = owner.client, state = current.state;
  return client === current && controlsClient === current && owner.generation === entryGeneration
    && state?.roomId === owner.roomId && state.me.participantId === owner.participantId
    && state.me.role === 'controller' && state.me.connected === true && !owner.fenced
    && (current.status === 'waiting' || current.status === 'live')
    && typeof current.closeRoom === 'function' && typeof globalThis.confirm === 'function';
}
function renderRoomClose(): void {
  const revision = ++roomCloseRenderRevision;
  const hidden = !roomCloseOwner;
  if (closeRoom.hidden !== hidden) closeRoom.hidden = hidden;
  if (revision !== roomCloseRenderRevision) return;
  const disabled = !eligibleRoomClose(roomCloseOwner) || Boolean(pendingRoomClose);
  if (closeRoom.disabled !== disabled) closeRoom.disabled = disabled;
  if (revision !== roomCloseRenderRevision) return;
  const busy = String(Boolean(pendingRoomClose));
  if (closeRoom.getAttribute('aria-busy') !== busy) closeRoom.setAttribute('aria-busy', busy);
}
function retireRoomClose(): void {
  roomCloseOwner = undefined; pendingRoomClose = undefined; renderRoomClose();
}
function syncRoomClose(): void {
  const current = client, state = current?.state;
  const active = current?.status === 'waiting' || current?.status === 'live';
  if (!current || current !== controlsClient || !state || state.me.role !== 'controller' || !state.me.connected
    || typeof current.closeRoom !== 'function' || (!active && current.status !== 'reconnecting')) {
    retireRoomClose(); return;
  }
  let owner = roomCloseOwner;
  if (!owner || owner.client !== current || owner.generation !== entryGeneration
    || owner.roomId !== state.roomId || owner.participantId !== state.me.participantId) {
    roomCloseOwner = undefined; pendingRoomClose = undefined;
    if (!active) { renderRoomClose(); return; }
    const fenced = roomCloseFence?.client === current && roomCloseFence.generation === entryGeneration
      && roomCloseFence.roomId === state.roomId && roomCloseFence.participantId === state.me.participantId;
    owner = roomCloseOwner = { client: current, roomId: state.roomId, participantId: state.me.participantId,
      generation: entryGeneration, revision: 0, fenced };
  }
  // Restoring eligibility cannot revive consent that was invalid at an observed boundary.
  if (pendingRoomClose && (pendingRoomClose.revision !== owner.revision || !eligibleRoomClose(owner)))
    pendingRoomClose.invalidated = true;
  renderRoomClose();
}
function fenceRoomClose(current: Client, generation: number, participantId: string): boolean {
  const state = current.state;
  if (client !== current || controlsClient !== current || generation !== entryGeneration
    || !state || state.me.participantId !== participantId) return false;
  // Keep notification authority even while a missing SDK capability has retired the UI owner.
  roomCloseFence = { client: current, roomId: state.roomId, participantId, generation };
  if (roomCloseOwner?.client === current) {
    roomCloseOwner.revision++; roomCloseOwner.fenced = true;
    if (pendingRoomClose) pendingRoomClose.invalidated = true;
  }
  return true;
}
closeRoom.onclick = () => {
  if (roomConfirmation || pendingRoomClose) { if (pendingRoomClose) syncRoomClose(); return; }
  const owner = roomCloseOwner;
  if (!owner || !eligibleRoomClose(owner)) { syncRoomClose(); return; }
  const feedback = feedbackRevision;
  const attempt = pendingRoomClose = { revision: owner.revision, invalidated: false };
  roomConfirmation = attempt;
  const current = (): boolean => roomCloseOwner === owner && pendingRoomClose === attempt;
  const eligible = (): boolean => current() && !attempt.invalidated && attempt.revision === owner.revision
    && eligibleRoomClose(owner);
  void (async () => {
    try {
      // Reserve before any render, synchronous dialog or public SDK callback can reenter.
      syncRoomClose();
      if (!eligible()) return;
      const accepted = globalThis.confirm('確定關閉此房間並讓所有人離場？關閉後無法再加入此房間。');
      syncRoomClose();
      if (!accepted || !eligible()) return;
      roomConfirmation = undefined;
      await owner.client.closeRoom();
    } catch (error) {
      // Terminal events and newer feedback own their message, even when a close ACK rejects late.
      if (eligible() && feedback === feedbackRevision) report(error);
    } finally {
      if (roomConfirmation === attempt) roomConfirmation = undefined;
      if (current()) { pendingRoomClose = undefined; syncRoomClose(); }
    }
  })();
};
function syncMic(): void {
  const me = client === controlsClient ? client?.me : undefined;
  const pending = Boolean(pendingMic && pendingMic.client === client);
  mic.hidden = !me?.onStage;
  mic.disabled = !me?.onStage || client?.status === 'reconnecting' || Boolean(me?.forceMuted) || pending;
  mic.setAttribute('aria-busy', String(pending));
  mic.setAttribute('aria-pressed', String(Boolean(me?.muted)));
  mic.textContent = me?.forceMuted ? '麥克風已被主控靜音' : me?.muted ? '取消麥克風靜音' : '靜音麥克風';
}
function syncStage(): void {
  const me = client === controlsClient ? client?.me : undefined;
  const eligible = Boolean(me && (me.onStage || me.role === 'controller'));
  const pending = Boolean(pendingStage && pendingStage.client === client);
  stage.hidden = !eligible;
  stage.disabled = !eligible || client?.status === 'reconnecting' || pending;
  stage.setAttribute('aria-busy', String(pending));
  stage.textContent = me && !me.onStage && me.role === 'controller' ? '返回舞台' : '離開舞台';
}
function syncMicRetry(): void {
  const me = client === controlsClient ? client?.me : undefined;
  if (!me?.onStage || me.participantId !== micRetryParticipant) {
    micRetryParticipant = undefined; pendingMicRetry = undefined;
  }
  micRetry.hidden = !micRetryParticipant;
  const pending = Boolean(pendingMicRetry && pendingMicRetry.client === client);
  micRetry.disabled = micRetry.hidden || client?.status !== 'live' || pending;
  micRetry.setAttribute('aria-busy', String(pending));
}
function replaceMicrophoneOptions(inputs: readonly MediaDeviceInfo[], draft: string): Set<string> {
  const initial = document.createElement('option');
  initial.value = ''; initial.textContent = '預設（依 SDK 設定）';
  const options = [initial], choices = new Set<string>(['']);
  for (const device of inputs) {
    // Empty IDs retain SDK default semantics and cannot identify another choice.
    if (device.kind !== 'audioinput' || !device.deviceId || choices.has(device.deviceId)) continue;
    choices.add(device.deviceId);
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label.trim() ? device.label : `麥克風 ${options.length}`;
    options.push(option);
  }
  if (draft && !choices.has(draft)) {
    const unavailable = document.createElement('option');
    unavailable.value = draft; unavailable.textContent = '先前選擇（目前清單未提供）';
    unavailable.disabled = true; options.push(unavailable);
  }
  microphoneSelect.replaceChildren(...options); microphoneSelect.value = draft;
  return choices;
}
function retireMicrophone(): void {
  microphoneOwner = undefined; pendingMicrophone = undefined;
  replaceMicrophoneOptions([], '');
  microphonePanel.hidden = true;
  microphoneSelect.disabled = microphoneRefresh.disabled = microphoneApply.disabled = true;
  microphoneRefresh.setAttribute('aria-busy', 'false'); microphoneApply.setAttribute('aria-busy', 'false');
}
function syncMicrophone(): void {
  const current = client, state = current?.state;
  const active = current?.status === 'waiting' || current?.status === 'live';
  if (!current || current !== controlsClient || !state || (!active && current.status !== 'reconnecting')) {
    retireMicrophone(); return;
  }
  const owner = microphoneOwner;
  if (!owner || owner.client !== current || owner.generation !== entryGeneration
    || owner.roomId !== state.roomId || owner.participantId !== state.me.participantId) {
    retireMicrophone();
    // Reconnect can retain the same seat, but cannot establish ownership of a different one.
    if (!active) return;
    microphoneOwner = { client: current, roomId: state.roomId, participantId: state.me.participantId,
      generation: entryGeneration, draft: '', choices: new Set(['']) };
  }
  // A same-seat stage change neither commits a draft nor retires an SDK media operation.
  microphonePanel.hidden = false; microphoneSelect.value = microphoneOwner!.draft;
  microphoneSelect.disabled = microphoneRefresh.disabled = microphoneApply.disabled = !active || Boolean(pendingMicrophone);
  microphoneRefresh.setAttribute('aria-busy', String(pendingMicrophone?.kind === 'refresh'));
  microphoneApply.setAttribute('aria-busy', String(pendingMicrophone?.kind === 'apply'));
}
function ownsMicrophoneAttempt(owner: NonNullable<typeof microphoneOwner>, attempt: NonNullable<typeof pendingMicrophone>): boolean {
  if (microphoneOwner !== owner || pendingMicrophone !== attempt) return false;
  syncMicrophone();
  return microphoneOwner === owner && pendingMicrophone === attempt;
}
function reportMicrophoneError(owner: NonNullable<typeof microphoneOwner>, attempt: NonNullable<typeof pendingMicrophone>, error: unknown): void {
  if (ownsMicrophoneAttempt(owner, attempt) && !microphonePanel.hidden
    && (owner.client.status === 'waiting' || owner.client.status === 'live')) report(error);
}
function replaceOutputOptions(outputs: readonly MediaDeviceInfo[]): void {
  const initial = document.createElement('option');
  initial.value = ''; initial.textContent = '系統預設';
  const options = [initial], choices = new Set<string>(['']);
  for (const device of outputs) {
    if (device.kind !== 'audiooutput' || !device.deviceId || choices.has(device.deviceId)) continue;
    choices.add(device.deviceId);
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label.trim() ? device.label : `揚聲器 ${options.length}`;
    options.push(option);
  }
  if (outputDraft && !choices.has(outputDraft)) {
    const missing = document.createElement('option');
    missing.value = outputDraft; missing.textContent = '先前選擇（目前清單未提供）';
    missing.disabled = true; options.push(missing);
  }
  outputChoices = choices;
  outputSelect.replaceChildren(...options); outputSelect.value = outputDraft;
}
function retireOutput(): void {
  outputOwner = undefined;
  outputPanel.hidden = true;
  outputSelect.disabled = outputRefresh.disabled = outputApply.disabled = true;
  outputRefresh.setAttribute('aria-busy', String(pendingOutput?.kind === 'refresh'));
  outputApply.setAttribute('aria-busy', String(pendingOutput?.kind === 'apply'));
}
function syncOutput(): void {
  const current = client, state = current?.state;
  const active = current?.status === 'waiting' || current?.status === 'live';
  if (!current || current !== controlsClient || !state?.roomId || !state.me.participantId
    || (!active && current.status !== 'reconnecting')) { retireOutput(); return; }
  const owner = outputOwner;
  if (!owner || owner.client !== current || owner.generation !== entryGeneration
    || owner.roomId !== state.roomId || owner.participantId !== state.me.participantId) {
    retireOutput();
    if (!active) return;
    outputOwner = { client: current, roomId: state.roomId, participantId: state.me.participantId, generation: entryGeneration };
  }
  const supported = typeof current.listAudioDevices === 'function' && typeof current.setOutputDevice === 'function'
    && current.outputDeviceSupported === true;
  outputPanel.hidden = false; outputSupport.hidden = supported;
  outputSupport.textContent = supported ? '' : '此瀏覽器或 SDK 不支援選擇輸出裝置，請使用系統音訊設定。';
  outputSelect.value = outputDraft;
  outputSelect.disabled = outputRefresh.disabled = !active || !supported || Boolean(pendingOutput);
  outputApply.disabled = outputRefresh.disabled || !outputChoices.has(outputDraft);
  outputRefresh.setAttribute('aria-busy', String(pendingOutput?.kind === 'refresh'));
  outputApply.setAttribute('aria-busy', String(pendingOutput?.kind === 'apply'));
}
function ownsOutputAttempt(owner: NonNullable<typeof outputOwner>, attempt: NonNullable<typeof pendingOutput>): boolean {
  syncOutput();
  return outputOwner === owner && pendingOutput === attempt
    && (owner.client.status === 'waiting' || owner.client.status === 'live');
}
function clearAudioRetryStatus(): void {
  audioRetryStatus.hidden = true; audioRetryStatus.textContent = '';
}
function retireAudioRetry(): void {
  audioRetryOwner = undefined; pendingAudioRetry = undefined;
  audioRetry.hidden = audioRetry.disabled = true;
  audioRetry.setAttribute('aria-busy', 'false'); clearAudioRetryStatus();
}
function syncAudioRetry(): void {
  const current = client, state = current?.state;
  const active = current?.status === 'waiting' || current?.status === 'live';
  if (!current || current !== controlsClient || !state?.roomId || !state.me.participantId || typeof current.retryAudioConnection !== 'function'
    || (!active && current.status !== 'reconnecting')) { retireAudioRetry(); return; }
  const owner = audioRetryOwner;
  if (!owner || owner.client !== current || owner.generation !== entryGeneration
    || owner.roomId !== state.roomId || owner.participantId !== state.me.participantId) {
    retireAudioRetry();
    // Reconnect may retain an owned seat, but cannot establish ownership of another seat.
    if (!active) return;
    audioRetryOwner = { client: current, roomId: state.roomId, participantId: state.me.participantId, generation: entryGeneration };
  }
  audioRetry.hidden = false;
  audioRetry.disabled = !active || Boolean(pendingAudioRetry);
  audioRetry.setAttribute('aria-busy', String(Boolean(pendingAudioRetry)));
  if (!active) clearAudioRetryStatus();
}
function ownsAudioRetry(owner: NonNullable<typeof audioRetryOwner>, attempt: object): boolean {
  if (audioRetryOwner !== owner || pendingAudioRetry !== attempt) return false;
  syncAudioRetry();
  return audioRetryOwner === owner && pendingAudioRetry === attempt;
}
function canReportAudioRetry(owner: NonNullable<typeof audioRetryOwner>, attempt: object): boolean {
  return ownsAudioRetry(owner, attempt) && (owner.client.status === 'waiting' || owner.client.status === 'live');
}
/** Only a visible countdown needs a clock; state and action events handle other changes. */
function scheduleHandCooldown(remaining: number): void {
  if (remaining <= 0) {
    clearTimeout(handTimer); handTimer = undefined; handTimerDue = 0;
  } else {
    const delay = Math.max(1, Math.ceil(remaining - (Math.ceil(remaining / 1000) - 1) * 1000));
    const due = performance.now() + delay;
    if (handTimer !== undefined && handTimerDue <= due) return;
    clearTimeout(handTimer);
    const timer = setTimeout(() => {
      if (handTimer !== timer) return;
      handTimer = undefined; handTimerDue = 0; syncHand();
    }, delay);
    handTimer = timer; handTimerDue = due;
  }
}
function syncUnlock(): void {
  if (pendingUnlock && (pendingUnlock.client !== client || pendingUnlock.generation !== playbackGeneration)) pendingUnlock = undefined;
  unlock.disabled = Boolean(pendingUnlock);
  unlock.setAttribute('aria-busy', String(Boolean(pendingUnlock)));
}
function retirePlayback(): void {
  playbackGeneration++; syncUnlock();
}
function clearError(): void {
  errorNotice.hidden = true; lastError.textContent = '';
}
errorDismiss.onclick = () => clearError();
function report(error: unknown): void {
  feedbackRevision++;
  const message = error instanceof Error ? error.message : '操作失敗。';
  status.textContent = message;
  // A later status can replace transient feedback without erasing the last operation failure.
  lastError.textContent = `最近錯誤：${message}`; errorNotice.hidden = false;
}
function signalingUrl(host: URL, value: string): URL {
  const path = value.trim() || '/ws';
  if (!path.startsWith('/') || path.startsWith('//') || /[\p{Cc}\\?#]/u.test(value) || /\s/u.test(path)
    || path.split('/').some(segment => /^\.{1,2}$/.test(segment.replace(/%2e/gi, '.')))) {
    throw new Error('請輸入有效的同主機 WebSocket 路徑（例如 /ws）。');
  }
  const url = new URL(path, host);
  if (url.origin !== host.origin || url.search || url.hash) throw new Error('WebSocket 路徑必須使用相同主機。');
  url.protocol = host.protocol === 'https:' ? 'wss:' : 'ws:';
  return url;
}
join.onsubmit = (event) => {
  event.preventDefault();
  clearError();
  const hostValue = input('host').value, pathValue = input('ws-path').value;
  const joinOptions = { roomId: input('room').value.trim(), code: input('code').value.trim() || undefined, name: input('name').value.trim() };
  retirePlayback(); scheduleHandCooldown(0);
  const generation = ++entryGeneration, feedback = feedbackRevision;
  let progress = true, receivedState = false, cancelledEntry = false;
  let entryClient: Client | undefined;
  const showProgress = (message: string): void => {
    if (generation === entryGeneration && feedback === feedbackRevision && progress) status.textContent = message;
  };
  submit.disabled = true; submit.setAttribute('aria-busy', 'true');
  cancelEntry = () => {
    if (generation !== entryGeneration || receivedState || entryClient?.state) return;
    cancelledEntry = true;
    const cancelled = retireEntry();
    clearError();
    retirePlayback(); scheduleHandCooldown(0); retireControls();
    hand.disabled = leave.disabled = true; hand.setAttribute('aria-busy', 'false');
    syncMic(); syncStage(); syncMicRetry();
    try {
      const stopping = entryClient?.disconnect();
      if (cancelled === entryGeneration) status.textContent = '已取消連線。';
      void stopping?.catch(error => { if (cancelled === entryGeneration) report(error); });
    } catch (error) { if (cancelled === entryGeneration) report(error); }
  };
  cancelJoin.hidden = cancelJoin.disabled = false;
  void (async () => {
    try {
      retireControls();
      mic.hidden = mic.disabled = true; mic.setAttribute('aria-busy', 'false');
      stage.hidden = stage.disabled = true; stage.setAttribute('aria-busy', 'false'); syncMicRetry();
      hand.setAttribute('aria-busy', 'false');
      hand.disabled = leave.disabled = true;
      await client?.disconnect();
      if (generation !== entryGeneration) return;
      const host = new URL(hostValue);
      if (!['https:', 'http:'].includes(host.protocol)) throw new Error('請輸入 HTTP 或 HTTPS 主機網址。');
      const ws = signalingUrl(host, pathValue);
      const moduleUrl = new URL('/lib/stage-client.js', host).href;
      showProgress('載入舞台元件中…');
      // The host is selected by this page's visitor, not known at build time.
      const library: typeof StageLibrary = await import(/* @vite-ignore */ moduleUrl);
      if (generation !== entryGeneration) return;
      // This compact UI has no room-level meter; explicit preview APIs remain available.
      client = new library.StageClient({ url: ws.href, audioElement: audio, enableMicMeter: false });
      const current = client; controlsClient = current; entryClient = current; decodeRoomName = library.decodeName;
      maxGainDb = typeof library.MAX_GAIN_DB === 'number' && Number.isFinite(library.MAX_GAIN_DB) && library.MAX_GAIN_DB > 0
        ? library.MAX_GAIN_DB : undefined;
      syncUnlock();
      client.on('state', ({ detail }: CustomEvent<StageEventMap['state']>) => {
        if (client !== current || cancelledEntry) return;
        if (generation === entryGeneration && controlsClient === current && stageManagementOwner?.client === current)
          stageManagementOwner.transferFenced = false;
        if (generation === entryGeneration && controlsClient === current) {
          roomCloseFence = undefined;
          if (roomCloseOwner?.client === current) roomCloseOwner.fenced = false;
        }
        const renderingEntry = entryGeneration;
        syncRoomClose();
        if (renderingEntry !== entryGeneration || client !== current || controlsClient !== current) return;
        receivedState = true;
        if (generation === entryGeneration) hideCancel();
        progress = false;
        status.textContent = `${library.decodeName(detail.name)} · ${library.decodeName(detail.me.name)} · ${detail.me.onStage ? '已上台' : '收聽中'}`;
        syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName(); syncHandQueue(); syncStageManagement(); syncRoomClose(); syncMicrophone(); syncAudioRetry(); syncOutput();
        if (renderingEntry === entryGeneration && client === current && controlsClient === current) leave.disabled = false;
      });
      const retireOwnHandRejection = (participantId: string): void => {
        if (client === current && controlsClient === current && !cancelledEntry && generation === entryGeneration
          && participantId === current.me?.participantId) retireHandRejection();
      };
      client.on('hand', ({ detail }) => { if (detail.raised) retireOwnHandRejection(detail.participantId); });
      client.on('stagejoined', ({ detail }) => retireOwnHandRejection(detail.participantId));
      client.on('role', ({ detail }) => { if (detail.role !== 'audience') retireOwnHandRejection(detail.participantId); });
      client.on('transferred', ({ detail }) => retireOwnHandRejection(detail.toId));
      const ownsTransferEvents = (): boolean => client === current && controlsClient === current
        && !cancelledEntry && generation === entryGeneration && stageManagementOwner?.client === current;
      client.on('role', ({ detail }) => {
        const closeFenced = detail.role !== 'controller' && fenceRoomClose(current, generation, detail.participantId);
        const transferFenced = ownsTransferEvents() && ((detail.participantId === stageManagementOwner!.participantId && detail.role !== 'controller')
          || (stageManagementRows.has(detail.participantId) && detail.role !== 'speaker'));
        // Both confirmations lose authority before either control can synchronously reenter from render.
        if (transferFenced) fenceTransfer(false);
        if (closeFenced) syncRoomClose();
        if (transferFenced) syncStageManagement();
      });
      client.on('transferred', ({ detail }) => {
        const closeFenced = fenceRoomClose(current, generation, detail.fromId);
        const transferFenced = ownsTransferEvents() && detail.fromId === stageManagementOwner!.participantId;
        if (transferFenced) fenceTransfer(false);
        if (closeFenced) syncRoomClose();
        if (transferFenced) syncStageManagement();
      });
      client.on('stageleft', ({ detail }) => {
        if (ownsTransferEvents() && stageManagementRows.has(detail.participantId)) fenceTransfer();
      });
      client.on('handrejected', ({ detail }) => {
        // No per-raise identity is provided; feedback belongs only to the current eligible seat.
        if (!detail || typeof detail !== 'object') return;
        const roomId = detail.roomId, participantId = detail.participantId;
        const state = current.state;
        if (client !== current || cancelledEntry || generation !== entryGeneration
          || !eligibleHandRejection(current) || state?.roomId !== roomId || state.me.participantId !== participantId) return;
        handRejectionOwner = { client: current, roomId, participantId, generation };
        syncHandRejection();
      });
      client.on('micerror', ({ detail }) => {
        if (client !== current || controlsClient !== current || cancelledEntry) return;
        progress = false; pendingMicRetry = undefined;
        micRetryParticipant = current.me?.onStage ? current.me.participantId : undefined;
        status.textContent = `${detail.message}（${detail.name}）`; syncMicRetry();
      });
      client.on('micready', () => {
        if (client !== current || controlsClient !== current || cancelledEntry) return;
        const retrying = micRetryParticipant !== undefined;
        micRetryParticipant = undefined; pendingMicRetry = undefined; syncMicRetry();
        if (retrying) { progress = false; status.textContent = '已取得麥克風。'; }
      });
      client.on('status', ({ detail }) => {
        if (client !== current || cancelledEntry) return;
        const renderingEntry = entryGeneration;
        syncRoomClose();
        if (renderingEntry !== entryGeneration || client !== current) return;
        if (current.state) { receivedState = true; if (generation === entryGeneration) hideCancel(); }
        if (detail === 'reconnecting') { retireHandRejection(); progress = false; status.textContent = '重新連線中'; hand.disabled = true; }
        else if (detail === 'disconnected') { progress = false; retirePlayback(); retireControls(); status.textContent = '未連線'; hand.disabled = leave.disabled = true; }
        syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName(); syncHandQueue(); syncStageManagement(); syncRoomClose(); syncMicrophone(); syncAudioRetry(); syncOutput();
      });
      client.on('error', ({ detail }) => { if (client !== current || cancelledEntry || generation !== entryGeneration) return; progress = false; report(detail); });
      client.on('audioblocked', () => { if (cancelledEntry) return; progress = false; status.textContent = '請點擊啟用音訊。'; });
      client.on('closed', ({ detail }) => { if (client !== current || cancelledEntry || generation !== entryGeneration) return; retireEntry(); clearError(); retirePlayback(); retireControls(); syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName(); status.textContent = detail.reason === 'shutdown' ? '伺服器維護或重新啟動，房間已關閉。' : '房間已關閉。'; hand.disabled = leave.disabled = true; });
      client.on('kicked', () => { if (client !== current || cancelledEntry || generation !== entryGeneration) return; retireEntry(); clearError(); retirePlayback(); retireControls(); syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName(); status.textContent = '你已被主控移出房間。'; hand.disabled = leave.disabled = true; });
      showProgress('連線中…');
      await current.connect();
      if (generation !== entryGeneration) return;
      showProgress('加入房間中…');
      await current.join(joinOptions);
      showProgress('加入請求已完成，尚未收到房間狀態。');
    } catch (error) { if (generation === entryGeneration) report(error); }
    finally {
      if (generation === entryGeneration) { hideCancel(); submit.disabled = false; submit.setAttribute('aria-busy', 'false'); }
    }
  })();
};
cancelJoin.onclick = () => cancelEntry?.();
unlock.onclick = () => {
  syncUnlock();
  if (pendingUnlock) return;
  const operation = { client, generation: playbackGeneration };
  pendingUnlock = operation; syncUnlock();
  // Invoke before the first await to preserve the user gesture, including pre-entry playback.
  void (async () => {
    try { await (operation.client ? operation.client.unlockAudio() : audio.play()); }
    catch (error) {
      if (pendingUnlock === operation && operation.generation === playbackGeneration && client === operation.client) report(error);
    } finally {
      if (pendingUnlock === operation) { pendingUnlock = undefined; syncUnlock(); }
    }
  })();
};
hand.onclick = () => {
  syncHand();
  if (!client || hand.disabled) return;
  const operation = { client };
  pendingHand = operation; syncHand();
  void (async () => {
    try {
      const request = operation.client.me?.handRaised ? operation.client.withdrawHand() : operation.client.raiseHand();
      // raiseHand reserves its cooldown synchronously, before its ACK settles.
      syncHand();
      await request;
    }
    catch (error) { if (pendingHand === operation && client === operation.client) report(error); }
    finally {
      if (pendingHand === operation && client === operation.client) { pendingHand = undefined; syncHand(); }
    }
  })();
};
rename.onclick = () => {
  syncRename();
  const current = client, state = current?.state;
  if (!current || !state || rename.hidden || rename.disabled) return;
  const name = input('name').value;
  const operation = { client: current, roomId: state.roomId, participantId: state.me.participantId, generation: entryGeneration };
  pendingRename = operation; syncRename();
  void (async () => {
    try { await current.setName(name); }
    catch (error) { if (pendingRename === operation && ownsRename(operation)) report(error); }
    finally {
      if (pendingRename === operation) { pendingRename = undefined; syncRename(); }
    }
  })();
};
mic.onclick = () => {
  syncMic();
  if (!client || mic.disabled || mic.hidden) return;
  const operation = { client };
  pendingMic = operation; syncMic();
  void (async () => {
    try { await (operation.client.me?.muted ? operation.client.unmute() : operation.client.mute()); }
    catch (error) { if (pendingMic === operation && client === operation.client) report(error); }
    finally {
      if (pendingMic === operation && client === operation.client) { pendingMic = undefined; syncMic(); }
    }
  })();
};
stage.onclick = () => {
  syncStage();
  if (!client || stage.disabled || stage.hidden) return;
  const operation = { client };
  pendingStage = operation; syncStage();
  void (async () => {
    try { await (operation.client.me?.onStage ? operation.client.leaveStage() : operation.client.returnToStage()); }
    catch (error) { if (pendingStage === operation && client === operation.client) report(error); }
    finally {
      if (pendingStage === operation && client === operation.client) { pendingStage = undefined; syncStage(); }
    }
  })();
};
roomNameUpdate.onclick = () => {
  syncRoomName();
  const owner = roomNameOwner;
  if (!owner || roomNamePanel.hidden || roomNameUpdate.disabled || roomNameAttempt) return;
  const name = roomNameDraft.value;
  const attempt = roomNameAttempt = {};
  syncRoomName();
  const current = (): boolean => {
    if (roomNameOwner !== owner || roomNameAttempt !== attempt) return false;
    syncRoomName();
    return roomNameOwner === owner && roomNameAttempt === attempt;
  };
  void (async () => {
    try { await owner.client.setRoomName(name); }
    catch (error) { if (current()) report(error); }
    finally { if (current()) { roomNameAttempt = undefined; syncRoomName(); } }
  })();
};
microphoneSelect.onchange = () => {
  const owner = microphoneOwner, draft = microphoneSelect.value;
  syncMicrophone();
  if (!owner || microphoneOwner !== owner || microphonePanel.hidden || microphoneSelect.disabled
    || pendingMicrophone || !owner.choices.has(draft)) return;
  owner.draft = draft; microphoneSelect.value = draft;
};
microphoneRefresh.onclick = () => {
  syncMicrophone();
  const owner = microphoneOwner;
  if (!owner || microphonePanel.hidden || microphoneRefresh.hidden || microphoneRefresh.disabled || pendingMicrophone) return;
  const draft = owner.draft, attempt = pendingMicrophone = { kind: 'refresh' };
  // Reserve before the public SDK can synchronously call application listeners.
  syncMicrophone();
  void (async () => {
    try {
      const devices = await owner.client.listAudioDevices();
      if (ownsMicrophoneAttempt(owner, attempt)) owner.choices = replaceMicrophoneOptions(devices.inputs, draft);
    } catch (error) { reportMicrophoneError(owner, attempt, error); }
    finally { if (ownsMicrophoneAttempt(owner, attempt)) { pendingMicrophone = undefined; syncMicrophone(); } }
  })();
};
microphoneApply.onclick = () => {
  syncMicrophone();
  const owner = microphoneOwner;
  if (!owner || microphonePanel.hidden || microphoneApply.hidden || microphoneApply.disabled || pendingMicrophone) return;
  const draft = owner.draft, attempt = pendingMicrophone = { kind: 'apply' };
  syncMicrophone();
  void (async () => {
    try { await owner.client.setInputDevice(draft); }
    catch (error) { reportMicrophoneError(owner, attempt, error); }
    finally {
      // Fulfillment can be a cancelled stage-transition no-op; micready is not this operation's completion.
      if (ownsMicrophoneAttempt(owner, attempt)) { pendingMicrophone = undefined; syncMicrophone(); }
    }
  })();
};
outputSelect.onchange = () => {
  const draft = outputSelect.value;
  syncOutput();
  if (!outputOwner || outputPanel.hidden || outputSelect.disabled || pendingOutput || !outputChoices.has(draft)) return;
  outputDraft = draft; syncOutput();
};
function selectOutput(kind: 'refresh' | 'apply'): void {
  syncOutput();
  const owner = outputOwner;
  const button = kind === 'refresh' ? outputRefresh : outputApply;
  if (!owner || outputPanel.hidden || button.hidden || button.disabled || pendingOutput) return;
  const draft = outputDraft, feedback = feedbackRevision, attempt = pendingOutput = { kind };
  syncOutput();
  void (async () => {
    try {
      if (kind === 'refresh') {
        const devices = await owner.client.listAudioDevices();
        if (ownsOutputAttempt(owner, attempt)) replaceOutputOptions(devices.outputs);
      } else await owner.client.setOutputDevice(draft);
    } catch (error) {
      if (ownsOutputAttempt(owner, attempt) && feedback === feedbackRevision) report(error);
    } finally {
      // Retiring a seat only retires feedback, never the unresolved shared-audio operation.
      if (pendingOutput === attempt) { pendingOutput = undefined; syncOutput(); }
    }
  })();
}
outputRefresh.onclick = () => selectOutput('refresh');
outputApply.onclick = () => selectOutput('apply');
audioRetry.onclick = () => {
  syncAudioRetry();
  const owner = audioRetryOwner;
  if (!owner || audioRetry.hidden || audioRetry.disabled || pendingAudioRetry) return;
  // Reserve before the public SDK can synchronously dispatch another application callback.
  const attempt = pendingAudioRetry = {};
  audioRetryStatus.textContent = '正在重新協商音訊連線…'; audioRetryStatus.hidden = false;
  syncAudioRetry();
  void (async () => {
    try {
      await owner.client.retryAudioConnection();
      if (canReportAudioRetry(owner, attempt)) {
        audioRetryStatus.textContent = '音訊連線協商已完成。'; audioRetryStatus.hidden = false;
      }
    } catch (error) { if (canReportAudioRetry(owner, attempt)) { clearAudioRetryStatus(); report(error); } }
    finally { if (ownsAudioRetry(owner, attempt)) { pendingAudioRetry = undefined; syncAudioRetry(); } }
  })();
};
micRetry.onclick = () => {
  syncMicRetry();
  if (!client || micRetry.disabled || micRetry.hidden) return;
  const current = client;
  const operation = { client: current };
  pendingMicRetry = operation; syncMicRetry();
  try {
    const accepted = current.retryMicrophone();
    if (client !== current || controlsClient !== current || pendingMicRetry !== operation) return;
    if (!accepted) { pendingMicRetry = undefined; syncMicRetry(); }
    else status.textContent = '重新取得麥克風中…';
  } catch (error) {
    if (client === current && controlsClient === current && pendingMicRetry === operation) { pendingMicRetry = undefined; syncMicRetry(); report(error); }
  }
};
leave.onclick = () => {
  const generation = retireEntry(), current = client;
  clearError();
  retirePlayback(); scheduleHandCooldown(0);
  retireControls(); hand.setAttribute('aria-busy', 'false'); syncMic(); syncStage(); syncMicRetry();
  void current?.disconnect().then(() => {
    if (generation !== entryGeneration || client !== current) return;
    status.textContent = '已離開。'; hand.disabled = leave.disabled = true;
  });
};
replaceOutputOptions([]);
syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName(); syncHandQueue(); syncStageManagement(); syncRoomClose(); syncMicrophone(); syncAudioRetry(); syncOutput(); syncUnlock();
