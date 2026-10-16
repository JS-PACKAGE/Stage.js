import type { StageClient as Client, StageEventMap, MicTest } from '../../packages/client/src/index.ts';
import type * as StageLibrary from '../../packages/client/src/index.ts';
import './styles.css';
function input(id: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`#${id}`)!;
}
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const roomOccupancy = document.querySelector<HTMLParagraphElement>('#room-occupancy')!;
const ownConnectionQuality = document.querySelector<HTMLParagraphElement>('#own-connection-quality')!;
const speakingSummary = document.querySelector<HTMLParagraphElement>('#speaking-summary')!;
const publicRosterPanel = document.querySelector<HTMLDetailsElement>('#public-roster')!;
const publicRosterSummary = document.querySelector<HTMLElement>('#public-roster-summary')!;
const publicRosterNotice = document.querySelector<HTMLParagraphElement>('#public-roster-notice')!;
const publicRosterList = document.querySelector<HTMLUListElement>('#public-roster-list')!;
const connectionStatsPanel = document.querySelector<HTMLDivElement>('#connection-stats-panel')!;
const connectionStatsUpdate = document.querySelector<HTMLButtonElement>('#connection-stats-update')!;
const connectionStatsText = document.querySelector<HTMLParagraphElement>('#connection-stats-text')!;
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
const micTestPanel = document.querySelector<HTMLDivElement>('#mic-test-panel')!;
const micTestStart = document.querySelector<HTMLButtonElement>('#mic-test-start')!;
const micTestCancel = document.querySelector<HTMLButtonElement>('#mic-test-cancel')!;
const micTestStop = document.querySelector<HTMLButtonElement>('#mic-test-stop')!;
const micTestMeter = document.querySelector<HTMLMeterElement>('#mic-test-meter')!;
const micTestStatus = document.querySelector<HTMLParagraphElement>('#mic-test-status')!;
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
interface OccupancyReport {
  client: Client; generation: number; roomId: string; participantId: string;
  room: number; stage: number; audience: number; maxAudience: number; maxSpeakers: number;
  controllerOnStage: boolean; stale: boolean;
}
let occupancyReport: OccupancyReport | undefined;
let occupancyRevision = 0;
let occupancyRetiredGeneration = -1;
// Retirement is pure: existing action authority must be reconciled before the new DOM surface runs.
function retireOccupancy(): void { occupancyReport = undefined; occupancyRevision++; }
function projectOccupancy(current: Client, generation: number, state: StageEventMap['state']): OccupancyReport | undefined {
  const roomId = state.roomId, participantId = state.me?.participantId, controllerId = state.controllerId;
  const audience = state.audienceCount, maxAudience = state.limits?.maxAudience, maxSpeakers = state.limits?.maxSpeakers;
  if (typeof roomId !== 'string' || !roomId.trim() || typeof participantId !== 'string' || !participantId.trim()
    || typeof controllerId !== 'string' || !controllerId.trim() || !Array.isArray(state.speakers)
    || !state.limits || typeof state.limits !== 'object' || Array.isArray(state.limits)
    || !Number.isSafeInteger(audience) || audience < 0 || !Number.isSafeInteger(maxAudience) || maxAudience <= 0
    || !Number.isSafeInteger(maxSpeakers) || maxSpeakers <= 0) return;
  const ids = new Set<string>();
  let controllerOnStage = false;
  for (const person of state.speakers) {
    if (!person || typeof person.participantId !== 'string' || !person.participantId.trim() || ids.has(person.participantId)
      || person.onStage !== true || (person.role !== 'speaker' && person.role !== 'controller')
      || (person.role === 'controller') !== (person.participantId === controllerId)) return;
    ids.add(person.participantId);
    if (person.participantId === controllerId) controllerOnStage = true;
  }
  const stage = ids.size - Number(controllerOnStage), room = audience + stage;
  if (!Number.isSafeInteger(room) || room > maxAudience || stage > maxSpeakers) return;
  return { client: current, generation, roomId, participantId, room, stage, audience, maxAudience, maxSpeakers,
    controllerOnStage, stale: false };
}
function reconcileOccupancy(): void {
  const report = occupancyReport, current = client;
  if (current?.status === 'disconnected') occupancyRetiredGeneration = entryGeneration;
  if (!report) return;
  if (current !== report.client || current !== controlsClient || report.generation !== entryGeneration
    || current.state?.roomId !== report.roomId || current.state.me?.participantId !== report.participantId
    || !['waiting', 'live', 'reconnecting'].includes(current.status)) { retireOccupancy(); return; }
  if (current.status === 'reconnecting' && !report.stale) { report.stale = true; occupancyRevision++; }
}
function renderOccupancy(): void {
  const revision = occupancyRevision, report = occupancyReport, current = client, controls = controlsClient;
  const generation = entryGeneration, connectionStatus = current?.status;
  const roomId = current?.state?.roomId, participantId = current?.state?.me?.participantId;
  const valid = (): boolean => {
    if (revision !== occupancyRevision || report !== occupancyReport || current !== client
      || controls !== controlsClient || generation !== entryGeneration) return false;
    if (connectionStatus === current?.status && roomId === current?.state?.roomId
      && participantId === current?.state?.me?.participantId) return true;
    // A setter can change public SDK identity/status without dispatching an event.
    // Retire both pending consents before any corrective DOM can restore their eligibility.
    reconcileOccupancy();
    if (pendingRoomClose && !eligibleRoomClose(roomCloseOwner)) pendingRoomClose.invalidated = true;
    invalidateTransfer(); syncRoomClose(); syncStageManagement();
    renderOccupancy(); return false;
  };
  if (!report) {
    if (!roomOccupancy.hidden) { roomOccupancy.hidden = true; if (!valid()) return; }
    if (roomOccupancy.textContent !== '') { roomOccupancy.textContent = ''; if (!valid()) return; }
    return;
  }
  if (report.client !== current || current !== controls || report.generation !== generation
    || report.roomId !== roomId || report.participantId !== participantId
    || !['waiting', 'live', 'reconnecting'].includes(connectionStatus!)) return;
  const freshness = connectionStatus === 'reconnecting' ? '重新連線中，上次快照' : report.stale ? '上次快照' : '最近快照';
  const text = `房間席位（${freshness}）：主控以外 ${report.room} / ${report.maxAudience} 人，其中台上 ${report.stage} / ${report.maxSpeakers} 人、觀眾 ${report.audience} 人；主控另計 1 人（${report.controllerOnStage ? '台上' : '台下'}）。含斷線保留席位。`;
  if (roomOccupancy.textContent !== text) { roomOccupancy.textContent = text; if (!valid()) return; }
  if (roomOccupancy.hidden) { roomOccupancy.hidden = false; if (!valid()) return; }
}
interface QualitySeat {
  client: Client; generation: number; roomId: string; participantId: string;
}
interface QualityReport {
  uplink: number | undefined; downlink: number | undefined; rtt: number | undefined;
}
let qualitySeat: QualitySeat | undefined;
let qualityReport: QualityReport | undefined;
let qualityRevision = 0;
// A receipt window is local presentation ownership, not a measurement timestamp or SDK stage epoch.
function retireQuality(): void { qualitySeat = undefined; qualityReport = undefined; qualityRevision++; }
function eligibleQualitySeat(current: Client): boolean {
  const state = current.state, me = state?.me;
  return current === client && current === controlsClient && occupancyRetiredGeneration !== entryGeneration
    && (current.status === 'waiting' || current.status === 'live')
    && typeof state?.roomId === 'string' && Boolean(state.roomId.trim())
    && typeof me?.participantId === 'string' && Boolean(me.participantId.trim())
    && me.onStage === true && (me.role === 'controller' || me.role === 'speaker');
}
function reconcileQuality(): void {
  const seat = qualitySeat;
  if (client === controlsClient && client?.status === 'disconnected') occupancyRetiredGeneration = entryGeneration;
  if (seat && (seat.generation !== entryGeneration || !eligibleQualitySeat(seat.client)
    || seat.client.state?.roomId !== seat.roomId || seat.client.state.me.participantId !== seat.participantId)) retireQuality();
}
function projectQuality(detail: unknown, participantId: string): QualityReport | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return;
  const participants: unknown = Reflect.get(detail, 'participants');
  if (!Array.isArray(participants)) return;
  let own: object | undefined;
  for (const item of participants) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || item.participantId !== participantId) continue;
    if (own) return; // Multiple own entries are an ambiguous full replacement.
    own = item;
  }
  if (!own) return;
  const loss = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= 100 ? value : undefined;
  const rtt: unknown = Reflect.get(own, 'rttMs');
  return { uplink: loss(Reflect.get(own, 'uplinkLossPercent')), downlink: loss(Reflect.get(own, 'downlinkLossPercent')),
    rtt: typeof rtt === 'number' && Number.isFinite(rtt) && rtt >= 0 ? rtt : undefined };
}
function renderQuality(): void {
  reconcileQuality();
  const revision = qualityRevision, seat = qualitySeat, report = qualityReport;
  const current = client, controls = controlsClient, generation = entryGeneration;
  const owns = (): boolean => revision === qualityRevision && seat === qualitySeat && report === qualityReport
    && current === client && controls === controlsClient && generation === entryGeneration;
  const valid = (): boolean => {
    // A nested receipt may win before the same setter silently changes its SDK eligibility.
    if (!owns()) { renderQuality(); return false; }
    reconcileQuality();
    // Both consents are invalidated before any corrective DOM can restore public SDK eligibility.
    const closeInvalid = Boolean(pendingRoomClose && !pendingRoomClose.invalidated
      && (!roomCloseOwner || pendingRoomClose.revision !== roomCloseOwner.revision || !eligibleRoomClose(roomCloseOwner)));
    const transferInvalid = Boolean(pendingTransfer && !pendingTransfer.invalidated
      && (!stageManagementOwner || pendingTransfer.revision !== stageManagementOwner.revision
        || !eligibleTransfer(stageManagementOwner, pendingTransfer.id, pendingTransfer.row)));
    if (closeInvalid) pendingRoomClose!.invalidated = true;
    if (transferInvalid) pendingTransfer!.invalidated = true;
    if (!owns() || closeInvalid || transferInvalid) {
      syncRoomClose(); syncStageManagement();
      renderQuality(); return false;
    }
    return true;
  };
  if (!valid()) return;
  if (!seat || !report) {
    if (!ownConnectionQuality.hidden) { ownConnectionQuality.hidden = true; if (!valid()) return; }
    if (ownConnectionQuality.textContent !== '') { ownConnectionQuality.textContent = ''; if (!valid()) return; }
    return;
  }
  const percent = (value: number | undefined): string => value === undefined ? '—' : `${value.toFixed(1)}%`;
  const text = `你的連線品質（最近收到）：上行掉包 ${percent(report.uplink)} · 下行掉包 ${percent(report.downlink)} · RTT ${report.rtt === undefined ? '—' : `${Math.round(report.rtt)} ms`}（非端到端音訊延遲）`;
  if (ownConnectionQuality.textContent !== text) { ownConnectionQuality.textContent = text; if (!valid()) return; }
  if (ownConnectionQuality.hidden) { ownConnectionQuality.hidden = false; if (!valid()) return; }
}
interface SpeakingSeat {
  client: Client; generation: number; roomId: string; participantId: string;
}
interface SpeakingReport { ids: Set<string>; rawEmpty: boolean }
let speakingSeat: SpeakingSeat | undefined;
let speakingRoster = new Map<string, string>();
let speakingSuppressed = new Set<string>();
let speakingReport: SpeakingReport | undefined;
let speakingRevision = 0;
function retireSpeaking(): void {
  speakingSeat = undefined; speakingRoster = new Map(); speakingSuppressed = new Set();
  speakingReport = undefined; speakingRevision++;
}
function speakingIdentity(current: Client, generation: number): SpeakingSeat | undefined {
  const state = current.state, roomId = state?.roomId, participantId = state?.me?.participantId;
  if (current !== client || current !== controlsClient || generation !== entryGeneration
    || occupancyRetiredGeneration === generation || (current.status !== 'waiting' && current.status !== 'live')
    || typeof roomId !== 'string' || !roomId.trim() || typeof participantId !== 'string' || !participantId.trim()) return;
  return { client: current, generation, roomId, participantId };
}
function reconcileSpeaking(): void {
  if (client === controlsClient && client?.status === 'disconnected') occupancyRetiredGeneration = entryGeneration;
  const seat = speakingSeat;
  if (!seat) return;
  let identity: SpeakingSeat | undefined;
  try { identity = speakingIdentity(seat.client, seat.generation); } catch { /* Invalid public identity retires its reader. */ }
  if (seat === speakingSeat && (!identity || identity.roomId !== seat.roomId || identity.participantId !== seat.participantId)) retireSpeaking();
}
// Invalidate both consents before a summary setter can restore an observed loss of authority.
// Ordinary reports need no control rendering, and unrelated target loss must leave Close intact.
function reconcileSpeakingConsents(): void {
  const close = pendingRoomClose, closeOwner = roomCloseOwner;
  if (close && !close.invalidated) {
    try {
      if (!closeOwner || close.revision !== closeOwner.revision || !eligibleRoomClose(closeOwner)) close.invalidated = true;
    } catch { close.invalidated = true; }
  }
  const transfer = pendingTransfer, transferOwner = stageManagementOwner;
  if (transfer && !transfer.invalidated) {
    try {
      if (!transferOwner || transfer.revision !== transferOwner.revision
        || !eligibleTransfer(transferOwner, transfer.id, transfer.row)) transfer.invalidated = true;
    } catch { transfer.invalidated = true; }
  }
}
function projectSpeakingRoster(state: StageEventMap['state']): Map<string, string> | undefined {
  const speakers: unknown = state.speakers;
  if (!Array.isArray(speakers) || !decodeRoomName) return;
  const roster = new Map<string, string>();
  for (const person of speakers) {
    if (!person || typeof person !== 'object' || Array.isArray(person)) continue;
    const id: unknown = person.participantId;
    if (typeof id !== 'string' || !id.trim() || roster.has(id) || person.onStage !== true) continue;
    const role: unknown = person.role;
    if (role !== 'speaker' && role !== 'controller') continue;
    const name: unknown = person.name;
    if (typeof name === 'string') roster.set(id, decodeRoomName(name));
  }
  return roster;
}
function receiveSpeakingState(current: Client, generation: number, detail: StageEventMap['state'], unseen: boolean): boolean {
  reconcileSpeaking();
  if (!unseen || detail !== current.state) return true;
  const revision = speakingRevision, seat = speakingSeat;
  let identity: SpeakingSeat | undefined, roster: Map<string, string> | undefined;
  try {
    identity = speakingIdentity(current, generation);
    if (identity) roster = projectSpeakingRoster(detail);
  } catch { /* Copy the complete projection before replacing history or releasing delta suppression. */ }
  let live: SpeakingSeat | undefined, matches = false;
  try {
    live = speakingIdentity(current, generation);
    matches = Boolean(identity && live && detail === current.state
      && live.roomId === identity.roomId && live.participantId === identity.participantId);
  } catch { /* An unreadable identity cannot admit a reader. */ }
  reconcileSpeaking(); reconcileSpeakingConsents();
  if (revision !== speakingRevision || seat !== speakingSeat || current !== client || generation !== entryGeneration
    || !matches || !identity) return false;
  speakingSeat = seat ?? identity;
  speakingRoster = roster ?? new Map();
  if (roster) {
    speakingSuppressed = new Set();
    if (speakingReport) speakingReport = { rawEmpty: speakingReport.rawEmpty,
      ids: new Set([...speakingReport.ids].filter(id => roster.has(id))) };
  } else speakingReport = undefined;
  speakingRevision++;
  return roster !== undefined;
}
function projectSpeakingReport(detail: unknown): SpeakingReport | undefined {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return;
  const participantIds: unknown = Reflect.get(detail, 'participantIds');
  if (!Array.isArray(participantIds)) return;
  const ids = new Set<string>(), rawEmpty = participantIds.length === 0;
  for (const id of participantIds) {
    if (typeof id !== 'string') return;
    if (speakingRoster.has(id) && !speakingSuppressed.has(id)) ids.add(id);
  }
  return { ids, rawEmpty };
}
function pruneSpeaking(current: Client, generation: number, id: string): boolean {
  reconcileSpeaking();
  if (!speakingSeat || speakingSeat.client !== current || speakingSeat.generation !== generation
    || typeof id !== 'string' || !id.trim() || !speakingRoster.has(id)) return false;
  speakingSuppressed.add(id);
  speakingReport?.ids.delete(id);
  speakingRevision++;
  return true;
}
function renderSpeaking(): void {
  reconcileSpeaking(); reconcileSpeakingConsents();
  const revision = speakingRevision, seat = speakingSeat, report = speakingReport;
  const current = client, controls = controlsClient, generation = entryGeneration;
  const valid = (): boolean => {
    // Reconcile the winner even if a nested receipt already superseded this render.
    reconcileSpeaking(); reconcileSpeakingConsents();
    if (revision !== speakingRevision || seat !== speakingSeat || report !== speakingReport
      || current !== client || controls !== controlsClient || generation !== entryGeneration) {
      renderSpeaking(); return false;
    }
    return true;
  };
  if (!valid()) return;
  if (!seat) {
    if (!speakingSummary.hidden) { speakingSummary.hidden = true; if (!valid()) return; }
    if (speakingSummary.textContent !== '') { speakingSummary.textContent = ''; if (!valid()) return; }
    return;
  }
  const names = report ? [...speakingRoster].filter(([id]) => report.ids.has(id)).map(([, name]) => name) : [];
  const text = !report ? '發言偵測：等待伺服器回報。'
    : report.rawEmpty ? '最近收到的發言回報：未偵測到發言。'
    : names.length ? `最近收到的發言回報：${names.join('、')}（${names.length} 人）。`
    : '最近收到的發言回報：沒有可對應的台上成員。';
  if (speakingSummary.textContent !== text) { speakingSummary.textContent = text; if (!valid()) return; }
  if (speakingSummary.hidden) { speakingSummary.hidden = false; if (!valid()) return; }
}
interface PublicRosterPerson {
  id: string; name: string; role: 'controller' | 'speaker'; muted: boolean; forceMuted: boolean; connected: boolean;
}
interface PublicRosterOwner {
  client: Client; generation: number; roomId: string; participantId: string;
  people: PublicRosterPerson[]; stale: boolean; awaitingState: boolean; reconnecting: boolean;
}
let publicRosterOwner: PublicRosterOwner | undefined;
let publicRosterEventRevision = 0, publicRosterRetirementRevision = 0;
let publicRosterCollapse = true;
const publicRosterRows = new Map<string, HTMLLIElement>();
// Retirement is pure; the existing Close/Transfer fences run before this surface touches DOM.
function retirePublicRoster(): void {
  publicRosterOwner = undefined; publicRosterCollapse = true;
  publicRosterRetirementRevision++;
}
function publicRosterMounted(): boolean {
  return document.querySelector('#public-roster') === publicRosterPanel
    && document.querySelector('#public-roster-summary') === publicRosterSummary
    && document.querySelector('#public-roster-notice') === publicRosterNotice
    && document.querySelector('#public-roster-list') === publicRosterList
    && publicRosterPanel.contains(publicRosterSummary) && publicRosterPanel.contains(publicRosterNotice)
    && publicRosterPanel.contains(publicRosterList);
}
function observePublicRoster(current: Client, generation: number, expected?: PublicRosterOwner) {
  const event = publicRosterEventRevision, retirement = publicRosterRetirementRevision;
  const close = pendingRoomClose, closeOwner = roomCloseOwner, transfer = pendingTransfer, transferOwner = stageManagementOwner;
  const stable = (): boolean => event === publicRosterEventRevision && retirement === publicRosterRetirementRevision
    && current === client && current === controlsClient && generation === entryGeneration;
  const invalidate = (lost: (owner: { client: Client; generation: number; roomId: string; participantId: string }) => boolean): void => {
    if (close && close === pendingRoomClose && closeOwner === roomCloseOwner && (!closeOwner || lost(closeOwner))) close.invalidated = true;
    if (transfer && transfer === pendingTransfer && transferOwner === stageManagementOwner && (!transferOwner || lost(transferOwner))) transfer.invalidated = true;
  };
  const lose = (): undefined => { if (stable()) retirePublicRoster(); return undefined; };
  try {
    // Check both original consents before any new public projection or mount getter.
    reconcileSpeakingConsents();
    if (!stable()) return;
    const state = current.state, status = current.status;
    invalidate(owner => owner.client !== current || owner.generation !== generation || (status !== 'waiting' && status !== 'live'));
    if (!stable()) return;
    if (occupancyRetiredGeneration === generation || !['waiting', 'live', 'reconnecting'].includes(status)) return lose();
    const roomId: unknown = state?.roomId;
    invalidate(owner => owner.roomId !== roomId);
    if (!stable()) return;
    if (typeof roomId !== 'string' || !roomId.trim() || (expected && roomId !== expected.roomId)) return lose();
    const participantId: unknown = state?.me?.participantId;
    invalidate(owner => owner.participantId !== participantId);
    if (!stable()) return;
    if (typeof participantId !== 'string' || !participantId.trim() || (expected && participantId !== expected.participantId)) return lose();
    const mounted = publicRosterMounted();
    if (!stable()) return;
    if (!mounted) return lose();
    reconcileSpeakingConsents();
    if (!stable()) return;
    return { state, status, roomId, participantId };
  } catch { invalidate(() => true); return lose(); }
}
function reconcilePublicRoster(): void {
  for (;;) {
    const owner = publicRosterOwner;
    if (!owner) return;
    if (owner.client !== client || owner.client !== controlsClient || owner.generation !== entryGeneration) { retirePublicRoster(); return; }
    const event = publicRosterEventRevision, retirement = publicRosterRetirementRevision;
    const identity = observePublicRoster(owner.client, owner.generation, owner);
    if (event !== publicRosterEventRevision || retirement !== publicRosterRetirementRevision || owner !== publicRosterOwner) continue;
    if (!identity) return;
    owner.reconnecting = identity.status === 'reconnecting';
    if (owner.reconnecting) owner.stale = true;
    return;
  }
}
function projectPublicRoster(state: StageEventMap['state']): PublicRosterPerson[] | undefined {
  const speakers: unknown = state.speakers, controllerId: unknown = state.controllerId, limits = state.limits;
  const limit: unknown = limits?.maxSpeakers;
  if (!Array.isArray(speakers) || !limits || typeof limits !== 'object' || Array.isArray(limits)
    || typeof controllerId !== 'string' || !controllerId.trim() || !decodeRoomName
    || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) return;
  const ids = new Set<string>(), people: PublicRosterPerson[] = [];
  let controllers = 0, others = 0;
  for (const person of speakers) {
    if (!person || typeof person !== 'object' || Array.isArray(person)) return;
    const id: unknown = person.participantId, name: unknown = person.name, role: unknown = person.role;
    const onStage: unknown = person.onStage, muted: unknown = person.muted, forceMuted: unknown = person.forceMuted, connected: unknown = person.connected;
    if (typeof id !== 'string' || !id.trim() || ids.has(id) || typeof name !== 'string' || onStage !== true
      || (role !== 'controller' && role !== 'speaker') || (role === 'controller') !== (id === controllerId)
      || typeof muted !== 'boolean' || typeof forceMuted !== 'boolean' || typeof connected !== 'boolean' || (forceMuted && !muted)) return;
    ids.add(id);
    if (role === 'controller') controllers++; else others++;
    if (controllers > 1 || others > limit) return;
    people.push({ id, name: decodeRoomName(name), role, muted, forceMuted, connected });
  }
  return people;
}
function receivePublicRoster(current: Client, generation: number, detail: StageEventMap['state'], unseen: boolean,
  event: number, entryRetirement: number): void {
  let retirement = entryRetirement;
  const stable = (): boolean => event === publicRosterEventRevision && retirement === publicRosterRetirementRevision
    && current === client && current === controlsClient && generation === entryGeneration;
  if (!stable() || !unseen) { renderPublicRoster(); return; }
  // Keep the callback-entry retirement token across earlier surfaces and all projection getters.
  const identity = observePublicRoster(current, generation);
  if (!stable() || !identity || identity.state !== detail || identity.status === 'reconnecting') { renderPublicRoster(); return; }
  const previous = publicRosterOwner;
  if (previous && (previous.roomId !== identity.roomId || previous.participantId !== identity.participantId)) {
    // Only this explicit, validated new-seat reset may advance the admission retirement token.
    retirePublicRoster(); retirement++;
    renderPublicRoster();
    if (!stable()) return;
  }
  const owner: PublicRosterOwner = { client: current, generation, roomId: identity.roomId, participantId: identity.participantId,
    people: [], stale: false, awaitingState: false, reconnecting: false };
  let people: PublicRosterPerson[] | undefined;
  try { people = projectPublicRoster(detail); } catch { /* A partial projection never replaces an accepted snapshot. */ }
  if (!stable()) { renderPublicRoster(); return; }
  const checked = observePublicRoster(current, generation, owner);
  if (!stable()) { renderPublicRoster(); return; }
  if (!checked || checked.state !== detail || checked.status === 'reconnecting') { retirePublicRoster(); renderPublicRoster(); return; }
  if (!people) retirePublicRoster();
  else { owner.people = people; publicRosterOwner = owner; }
  renderPublicRoster();
}
function renderPublicRoster(): void {
  for (;;) {
    reconcileSpeakingConsents(); reconcilePublicRoster();
    const owner = publicRosterOwner, event = publicRosterEventRevision, retirement = publicRosterRetirementRevision;
    const stable = (): boolean => owner === publicRosterOwner && event === publicRosterEventRevision && retirement === publicRosterRetirementRevision;
    const hidden = !owner;
    if (hidden && !publicRosterPanel.hidden) { publicRosterPanel.hidden = true; continue; }
    if (publicRosterCollapse && publicRosterPanel.open) { publicRosterPanel.open = false; continue; }
    if (!stable()) continue;
    publicRosterCollapse = false;
    const summary = owner ? `台上成員快照（${owner.people.length}）` : '台上成員快照';
    const freshness = owner?.reconnecting ? '重新連線中，上次快照。' : (owner?.stale || owner?.awaitingState) ? '上次快照。' : '最近收到的快照。';
    const notice = owner ? `${freshness}${owner.awaitingState ? '成員狀態變更，等待伺服器快照。' : ''}${owner.people.length ? '' : '目前沒有台上成員。'}含斷線保留席位；不代表目前發言中或可聽見聲音。` : '';
    if (publicRosterSummary.textContent !== summary) { publicRosterSummary.textContent = summary; continue; }
    if (publicRosterNotice.textContent !== notice) { publicRosterNotice.textContent = notice; continue; }
    if (!stable()) continue;
    const ids = new Set(owner?.people.map(person => person.id));
    for (const id of publicRosterRows.keys()) if (!ids.has(id)) publicRosterRows.delete(id);
    let changed = false;
    for (const person of owner?.people ?? []) {
      let row = publicRosterRows.get(person.id);
      if (!row) {
        row = document.createElement('li');
        if (!stable()) { changed = true; break; }
        publicRosterRows.set(person.id, row);
      }
      const text = `${person.name} · ${person.role === 'controller' ? '主控' : '發言者'} · ${person.muted ? '已靜音' : '未靜音'} · ${person.forceMuted ? '靜音已鎖定' : '靜音未鎖定'} · ${person.connected ? '控制連線已連接' : '控制連線中斷（保留席位）'}`;
      if (row.textContent !== text) { row.textContent = text; changed = true; break; }
      if (!stable()) { changed = true; break; }
    }
    if (changed || !stable()) continue;
    const rows = owner?.people.map(person => publicRosterRows.get(person.id)!) ?? [];
    const children = Array.from(publicRosterList.children);
    if (!stable()) continue;
    if (children.length !== rows.length || children.some((node, index) => node !== rows[index])) { publicRosterList.replaceChildren(...rows); continue; }
    if (publicRosterPanel.hidden !== hidden) { publicRosterPanel.hidden = hidden; continue; }
    if (stable()) return;
  }
}
interface ConnectionStatsBinding { client: Client; generation: number }
interface ConnectionStatsOwner extends ConnectionStatsBinding { roomId: string; participantId: string }
interface ConnectionStatsReport {
  inbound: { loss: number | undefined; rtt: number | undefined; buffer: number | undefined } | null;
  outbound: { loss: number | undefined; rtt: number | undefined } | null;
}
let connectionStatsBinding: ConnectionStatsBinding | undefined;
let connectionStatsOwner: ConnectionStatsOwner | undefined;
let connectionStatsAttempt: object | undefined;
let connectionStatsReport: ConnectionStatsReport | undefined;
let connectionStatsFailed = false;
let connectionStatsTeardown = false;
let connectionStatsRevision = 0;
function retireConnectionStats(): void {
  connectionStatsOwner = undefined; connectionStatsAttempt = undefined;
  connectionStatsReport = undefined; connectionStatsFailed = false; connectionStatsRevision++;
}
// Pure departure fence: legacy Close/Transfer teardown must run before any new surface setter.
function retireConnectionStatsBinding(): void {
  connectionStatsBinding = undefined; connectionStatsTeardown = true; retireConnectionStats();
}
function connectionStatsMounted(): boolean {
  return document.querySelector('#connection-stats-panel') === connectionStatsPanel
    && document.querySelector('#connection-stats-update') === connectionStatsUpdate
    && document.querySelector('#connection-stats-text') === connectionStatsText
    && connectionStatsPanel.contains(connectionStatsUpdate) && connectionStatsPanel.contains(connectionStatsText);
}
function reconcileConnectionStats(): void {
  for (;;) {
    const binding = connectionStatsBinding, owner = connectionStatsOwner, revision = connectionStatsRevision;
    const current = client, controls = controlsClient, generation = entryGeneration;
    const closeAttempt = pendingRoomClose, closeAuthority = roomCloseOwner;
    const transferAttempt = pendingTransfer, transferAuthority = stageManagementOwner;
    const stable = (): boolean => binding === connectionStatsBinding && owner === connectionStatsOwner
      && revision === connectionStatsRevision && current === client && controls === controlsClient && generation === entryGeneration;
    // Observed authority loss is sticky before any next public getter can restore it.
    // Exact captured tokens cannot invalidate a genuinely newer nested consent.
    const invalidateObserved = (lost: (authority: ConnectionStatsOwner) => boolean): void => {
      if (closeAttempt && pendingRoomClose === closeAttempt && roomCloseOwner === closeAuthority
        && (!closeAuthority || lost(closeAuthority))) closeAttempt.invalidated = true;
      if (transferAttempt && pendingTransfer === transferAttempt && stageManagementOwner === transferAuthority
        && (!transferAuthority || lost(transferAuthority))) transferAttempt.invalidated = true;
    };
    const observe = () => {
      const state = current?.state ?? null, status = current?.status ?? 'disconnected';
      invalidateObserved(authority => authority.client !== current || current !== controls || authority.generation !== generation
        || (status !== 'waiting' && status !== 'live'));
      if (stable() && current && status === 'disconnected' && binding?.client === current) {
        connectionStatsBinding = undefined; retireConnectionStats();
      } else if (stable() && owner && status !== 'waiting' && status !== 'live') retireConnectionStats();
      const room: unknown = state?.roomId;
      invalidateObserved(authority => authority.roomId !== room);
      if (stable() && owner && owner.roomId !== room) retireConnectionStats();
      const participant: unknown = state?.me?.participantId;
      invalidateObserved(authority => authority.participantId !== participant);
      if (stable() && owner && owner.participantId !== participant) retireConnectionStats();
      return { state, status, room, participant };
    };
    try {
      const identity = observe();
      if (!stable()) continue;
      const { room, participant, status } = identity;
      const eligible = Boolean(binding && binding.client === current && binding.generation === generation && current === controls
        && typeof room === 'string' && room.trim() && typeof participant === 'string' && participant.trim()
        && (status === 'waiting' || status === 'live') && connectionStatsMounted());
      if (!stable()) continue;
      if (owner && (!eligible || owner.client !== current || owner.generation !== generation)) { retireConnectionStats(); continue; }
      // Role/connected/target eligibility belongs to the existing pure consent check.
      reconcileSpeakingConsents();
      if (!stable()) continue;
      const checked = observe();
      if (!stable() || identity.state !== checked.state || status !== checked.status
        || room !== checked.room || participant !== checked.participant) continue;
      if (eligible && !connectionStatsMounted()) continue;
      if (!stable()) continue;
      if (eligible && !owner) {
        connectionStatsOwner = { client: current!, generation, roomId: room as string, participantId: participant as string };
        connectionStatsRevision++;
      }
      return;
    } catch {
      invalidateObserved(() => true);
      if (!stable()) continue;
      if (owner) { retireConnectionStats(); continue; }
      return;
    }
  }
}
function connectionStatsMessage(): string {
  const report = connectionStatsReport;
  if (!report) return connectionStatsFailed ? '無法讀取連線統計，請稍後手動再試。' : '尚未手動讀取連線統計。';
  const loss = (value: number | undefined): string => value === undefined ? '—' : value.toFixed(1);
  const ms = (value: number | undefined): string => value === undefined ? '—' : String(Math.round(value));
  const inbound = report.inbound, outbound = report.outbound;
  const receive = inbound ? `接收掉包 ${loss(inbound.loss)}% · 接收 RTT ${ms(inbound.rtt)} ms · 接收緩衝 ${ms(inbound.buffer)} ms` : '接收：暫無統計';
  const send = outbound ? `傳送掉包 ${loss(outbound.loss)}% · 傳送 RTT ${ms(outbound.rtt)} ms` : '傳送：暫無統計';
  return `上次手動讀取（SDK 取樣區間）：${receive}；${send}。RTT 不是端到端音訊延遲；不保證資料即時或目前可聽。`
    + (connectionStatsFailed ? '本次讀取失敗，仍顯示上次手動讀取結果。' : '');
}
function syncConnectionStats(): void {
  for (;;) {
    if (connectionStatsTeardown) return;
    reconcileConnectionStats();
    if (connectionStatsTeardown) return;
    const revision = connectionStatsRevision, owner = connectionStatsOwner, attempt = connectionStatsAttempt;
    const hidden = !owner, busy = Boolean(attempt), disabled = hidden || busy;
    const text = hidden ? '' : connectionStatsMessage();
    // Reconcile after every changed setter, even when an old setter completes after a nested render.
    if (hidden && !connectionStatsPanel.hidden) { connectionStatsPanel.hidden = true; continue; }
    if (connectionStatsText.textContent !== text) { connectionStatsText.textContent = text; continue; }
    if (connectionStatsUpdate.disabled !== disabled) { connectionStatsUpdate.disabled = disabled; continue; }
    if (connectionStatsUpdate.getAttribute('aria-busy') !== String(busy)) {
      connectionStatsUpdate.setAttribute('aria-busy', String(busy)); continue;
    }
    const label = busy ? '讀取中…' : '更新我的連線統計';
    if (connectionStatsUpdate.textContent !== label) { connectionStatsUpdate.textContent = label; continue; }
    if (connectionStatsPanel.hidden !== hidden) { connectionStatsPanel.hidden = hidden; continue; }
    reconcileConnectionStats();
    if (revision === connectionStatsRevision && owner === connectionStatsOwner && attempt === connectionStatsAttempt) return;
  }
}
function finishConnectionStatsTeardown(generation: number): void {
  if (generation !== entryGeneration) return;
  connectionStatsTeardown = false; syncConnectionStats();
}
function projectConnectionStats(raw: unknown, current: () => boolean): ConnectionStatsReport | undefined {
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
  if (!current()) return;
  let receive: ConnectionStatsReport['inbound'] = null;
  if (inbound) {
    const loss = numeric(inbound.lossPercent, 100); if (!current()) return;
    const rtt = numeric(inbound.rtt, Infinity, 1000); if (!current()) return;
    const buffer = numeric(inbound.bufferMs); if (!current()) return;
    receive = { loss, rtt, buffer };
  }
  const outbound = direction('outbound');
  if (!current()) return;
  let send: ConnectionStatsReport['outbound'] = null;
  if (outbound) {
    const loss = numeric(outbound.lossPercent, 100); if (!current()) return;
    const rtt = numeric(outbound.rtt, Infinity, 1000); if (!current()) return;
    send = { loss, rtt };
  }
  return { inbound: receive, outbound: send };
}
function refreshConnectionStats(): void {
  if (connectionStatsTeardown || connectionStatsUpdate.disabled || connectionStatsUpdate.hidden || connectionStatsPanel.hidden
    || !connectionStatsMounted()) return;
  syncConnectionStats();
  const owner = connectionStatsOwner;
  if (!owner || connectionStatsAttempt || connectionStatsTeardown) return;
  // Reserve before the public method getter, invocation, or busy setters can reenter.
  const attempt = connectionStatsAttempt = {};
  connectionStatsFailed = false; connectionStatsRevision++;
  const current = (): boolean => {
    syncConnectionStats();
    return connectionStatsOwner === owner && connectionStatsAttempt === attempt && !connectionStatsTeardown;
  };
  void (async () => {
    try {
      if (!current()) return;
      const read = owner.client.getStats;
      if (!current()) return;
      if (typeof read !== 'function') throw new Error();
      const pending = read.call(owner.client);
      const active = current();
      // Consume retired native work: a retained peer can still advance the SDK's shared delta baseline.
      const raw: unknown = await pending;
      if (!current() || !active) return;
      const report = projectConnectionStats(raw, current);
      if (!current() || !report) return;
      connectionStatsReport = report; connectionStatsRevision++;
    } catch { if (current()) { connectionStatsFailed = true; connectionStatsRevision++; } }
    finally {
      if (connectionStatsOwner === owner && connectionStatsAttempt === attempt) {
        connectionStatsAttempt = undefined; connectionStatsRevision++;
      }
      syncConnectionStats();
    }
  })();
}
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
  retirePublicRoster();
  retireMicTestBinding();
  retireConnectionStatsBinding();
  controlsClient = undefined; roomCloseFence = undefined; retireRoomClose(); retireHandRejection(); retireHandQueue(); retireStageManagement();
  pendingHand = undefined; pendingMic = undefined; pendingStage = undefined;
  micRetryParticipant = undefined; pendingMicRetry = undefined;
  pendingRename = undefined; syncRename(); retireRoomName(); retireMicrophone(); retireAudioRetry(); retireOutput(); syncMicTest();
}
/** Retire initial-join feedback before user or terminal callbacks can start another entry. */
function retireEntry(): number {
  retireConnectionStatsBinding();
  const generation = ++entryGeneration; retireMicTestBinding(); retireOccupancy(); retireQuality(); retireSpeaking(); retirePublicRoster();
  hideCancel();
  submit.disabled = false; submit.setAttribute('aria-busy', 'false');
  return generation;
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
interface MicTestOwner { client: Client; generation: number; roomId: string; participantId: string; message: string }
interface MicTestAttempt {
  owner: MicTestOwner; controller: AbortController; test?: MicTest; timer?: ReturnType<typeof setTimeout>; level: number;
}
let micTestBinding: { client: Client; generation: number } | undefined;
let micTestOwner: MicTestOwner | undefined;
let micTestAttempt: MicTestAttempt | undefined;
// Abort settles the SDK request before native permission resolves; reserve until that settlement.
let micTestPending: MicTestAttempt | undefined;
let micTestFence: { client: Client; generation: number; roomId: string; participantId: string } | undefined;
let micTestPageHidden = false;
let micTestRevision = 0;
function stopMicTestAttempt(): void {
  const attempt = micTestAttempt;
  micTestAttempt = undefined; micTestRevision++;
  if (!attempt) return;
  if (attempt.timer !== undefined) { clearTimeout(attempt.timer); attempt.timer = undefined; }
  // Retire result authority before SDK cleanup can synchronously invoke application callbacks.
  try { attempt.controller.abort(); } catch { /* Cleanup still owns the returned handle below. */ }
  try { attempt.test?.stop(); } catch { /* A faulty host implementation must not restore ownership. */ }
}
function retireMicTest(): void {
  micTestOwner = undefined; micTestRevision++; stopMicTestAttempt();
}
function retireMicTestBinding(): void {
  micTestBinding = undefined; retireMicTest();
}
function micTestMounted(): boolean {
  return document.querySelector('#mic-test-panel') === micTestPanel
    && [micTestStart, micTestCancel, micTestStop, micTestMeter, micTestStatus].every(node => micTestPanel.contains(node))
    && document.querySelector('#mic-test-start') === micTestStart && document.querySelector('#mic-test-cancel') === micTestCancel
    && document.querySelector('#mic-test-stop') === micTestStop && document.querySelector('#mic-test-meter') === micTestMeter
    && document.querySelector('#mic-test-status') === micTestStatus;
}
function reconcileMicTest(): void {
  for (;;) {
    const current = client, controls = controlsClient, generation = entryGeneration;
    const binding = micTestBinding, owner = micTestOwner, attempt = micTestAttempt, revision = micTestRevision;
    const close = pendingRoomClose, closeOwner = roomCloseOwner, transfer = pendingTransfer, transferOwner = stageManagementOwner;
    const stable = (): boolean => current === client && controls === controlsClient && generation === entryGeneration
      && binding === micTestBinding && owner === micTestOwner && attempt === micTestAttempt && revision === micTestRevision;
    const invalidate = (lost: (seat: ConnectionStatsOwner) => boolean): void => {
      if (close && pendingRoomClose === close && roomCloseOwner === closeOwner && (!closeOwner || lost(closeOwner))) close.invalidated = true;
      if (transfer && pendingTransfer === transfer && stageManagementOwner === transferOwner && (!transferOwner || lost(transferOwner))) transfer.invalidated = true;
    };
    try {
      const state = current?.state, status = current?.status;
      invalidate(seat => seat.client !== current || current !== controls || seat.generation !== generation
        || (status !== 'waiting' && status !== 'live'));
      if (stable() && binding?.client === current && status === 'disconnected') { retireMicTestBinding(); continue; }
      if (stable() && owner && status !== 'waiting' && status !== 'live') { retireMicTest(); continue; }
      const room: unknown = state?.roomId;
      invalidate(seat => seat.roomId !== room);
      if (stable() && owner && owner.roomId !== room) { retireMicTest(); continue; }
      const participant: unknown = state?.me?.participantId;
      invalidate(seat => seat.participantId !== participant);
      if (stable() && owner && owner.participantId !== participant) { retireMicTest(); continue; }
      const offstage = state?.me?.onStage === false;
      if (!stable()) continue;
      const fenced = micTestFence?.client === current && micTestFence.generation === generation
        && micTestFence.roomId === room && micTestFence.participantId === participant;
      const eligible = current && binding?.client === current && binding.generation === generation
        && current === controls && occupancyRetiredGeneration !== generation
        && (status === 'waiting' || status === 'live') && offstage && !fenced
        && typeof room === 'string' && room.trim() && typeof participant === 'string' && participant.trim()
        && !document.hidden && !micTestPageHidden && micTestMounted();
      if (!stable()) continue;
      if (owner && (!eligible || owner.client !== current || owner.generation !== generation)) { retireMicTest(); continue; }
      reconcileSpeakingConsents();
      if (!stable()) continue;
      if (current?.state !== state || current?.status !== status || state?.roomId !== room
        || state?.me?.participantId !== participant || (state?.me?.onStage === false) !== offstage) continue;
      if (!stable()) continue;
      if (eligible && !owner) {
        micTestOwner = { client: current, generation, roomId: room as string, participantId: participant as string,
          message: '尚未測試麥克風。' }; micTestRevision++;
      }
      return;
    } catch {
      invalidate(() => true);
      if (!stable()) continue;
      if (owner) { retireMicTest(); continue; }
      return;
    }
  }
}
function syncMicTest(): void {
  for (;;) {
    reconcileMicTest();
    const binding = micTestBinding, owner = micTestOwner, attempt = micTestAttempt, revision = micTestRevision;
    const hidden = !owner, active = Boolean(attempt?.test), pending = Boolean(attempt && !attempt.test);
    const busy = Boolean(micTestPending), disabled = hidden || Boolean(attempt) || busy || pendingMicrophone?.kind === 'apply';
    const text = hidden ? '' : pending ? '正在要求麥克風權限…' : active ? '正在測試音量；這不是回放，也不代表已上台。' : owner.message;
    const level = !hidden && active ? attempt!.level : 0;
    if (hidden && !micTestPanel.hidden) { micTestPanel.hidden = true; continue; }
    if (micTestStatus.textContent !== text) { micTestStatus.textContent = text; continue; }
    if (micTestMeter.value !== level) { micTestMeter.value = level; continue; }
    if (micTestStart.disabled !== disabled) { micTestStart.disabled = disabled; continue; }
    if (micTestStart.getAttribute('aria-busy') !== String(busy)) { micTestStart.setAttribute('aria-busy', String(busy)); continue; }
    if (micTestCancel.hidden !== !pending) { micTestCancel.hidden = !pending; continue; }
    if (micTestCancel.disabled !== !pending) { micTestCancel.disabled = !pending; continue; }
    if (micTestStop.hidden !== !active) { micTestStop.hidden = !active; continue; }
    if (micTestStop.disabled !== !active) { micTestStop.disabled = !active; continue; }
    if (micTestPanel.hidden !== hidden) { micTestPanel.hidden = hidden; continue; }
    reconcileMicTest();
    if (binding === micTestBinding && owner === micTestOwner && attempt === micTestAttempt && revision === micTestRevision) return;
  }
}
function ownsMicTest(attempt: MicTestAttempt): boolean {
  reconcileMicTest();
  return micTestOwner === attempt.owner && micTestAttempt === attempt;
}
function sampleMicTest(attempt: MicTestAttempt): void {
  if (!ownsMicTest(attempt) || !attempt.test) { syncMicTest(); return; }
  const test = attempt.test;
  try {
    const stopped = test.stopped;
    if (!ownsMicTest(attempt)) { syncMicTest(); return; }
    if (stopped) { attempt.owner.message = '麥克風測試已結束。'; stopMicTestAttempt(); syncMicTest(); return; }
    const level = test.level();
    if (!ownsMicTest(attempt)) { syncMicTest(); return; }
    const ended = test.stopped;
    if (!ownsMicTest(attempt)) { syncMicTest(); return; }
    if (ended) { attempt.owner.message = '麥克風測試已結束。'; stopMicTestAttempt(); syncMicTest(); return; }
    attempt.level = typeof level === 'number' && Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
    micTestRevision++; syncMicTest();
    if (ownsMicTest(attempt)) attempt.timer = setTimeout(() => {
      attempt.timer = undefined; sampleMicTest(attempt);
    }, 100);
    else syncMicTest();
  } catch {
    if (ownsMicTest(attempt)) { attempt.owner.message = '無法讀取麥克風音量，請手動再試。'; stopMicTestAttempt(); }
    syncMicTest();
  }
}
function startMicTest(): void {
  if (micTestPanel.hidden || micTestStart.hidden || micTestStart.disabled || !micTestMounted()) return;
  syncMicTest();
  const owner = micTestOwner;
  if (!owner || micTestAttempt || micTestPending || pendingMicrophone?.kind === 'apply') return;
  const attempt: MicTestAttempt = { owner, controller: new AbortController(), level: 0 };
  micTestAttempt = micTestPending = attempt; micTestRevision++;
  void (async () => {
    try {
      syncMicTest();
      if (!ownsMicTest(attempt)) return;
      const start = owner.client.startMicTest;
      if (!ownsMicTest(attempt)) return;
      const test = await start.call(owner.client, { signal: attempt.controller.signal });
      if (!ownsMicTest(attempt)) { test.stop(); return; }
      attempt.test = test; micTestRevision++; sampleMicTest(attempt);
    } catch {
      if (ownsMicTest(attempt)) { owner.message = '無法開始麥克風測試，請檢查權限或裝置後手動再試。'; stopMicTestAttempt(); }
    } finally {
      if (micTestPending === attempt) { micTestPending = undefined; micTestRevision++; }
      syncMicTest();
    }
  })();
}
function cancelMicTest(active: boolean): void {
  const button = active ? micTestStop : micTestCancel;
  if (micTestPanel.hidden || button.hidden || button.disabled || !micTestMounted()) return;
  reconcileMicTest();
  const attempt = micTestAttempt;
  if (!attempt || Boolean(attempt.test) !== active) { syncMicTest(); return; }
  attempt.owner.message = active ? '已停止麥克風測試。' : '已取消麥克風測試；若權限視窗仍顯示，稍後取得的音軌會立即釋放。';
  stopMicTestAttempt(); syncMicTest();
}
function fenceMicTest(current: Client, generation: number, participantId: string): void {
  const state = current.state;
  if (current !== client || current !== controlsClient || generation !== entryGeneration || state?.me?.participantId !== participantId) return;
  micTestFence = { client: current, generation, roomId: state.roomId, participantId };
  retireMicTest(); syncMicTest();
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
  retireConnectionStatsBinding();
  event.preventDefault();
  const previous = client, generation = ++entryGeneration;
  retireMicTestBinding();
  retireOccupancy(); retireQuality(); retireSpeaking(); retirePublicRoster();
  clearError();
  const hostValue = input('host').value, pathValue = input('ws-path').value;
  const joinOptions = { roomId: input('room').value.trim(), code: input('code').value.trim() || undefined, name: input('name').value.trim() };
  retirePlayback(); scheduleHandCooldown(0);
  const feedback = feedbackRevision;
  let progress = true, receivedState = false, cancelledEntry = false;
  const occupancyReceipts = new WeakSet<object>();
  const qualityReceipts = new WeakSet<object>();
  const speakingReceipts = new WeakSet<object>();
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
    renderOccupancy();
    if (cancelled === entryGeneration) renderQuality();
    if (cancelled === entryGeneration) renderSpeaking();
    if (cancelled === entryGeneration) renderPublicRoster();
    finishConnectionStatsTeardown(cancelled);
    if (cancelled !== entryGeneration) return;
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
      renderOccupancy();
      if (generation === entryGeneration) renderQuality();
      if (generation === entryGeneration) renderSpeaking();
      if (generation === entryGeneration) renderPublicRoster();
      finishConnectionStatsTeardown(generation);
      if (generation !== entryGeneration) return;
      await previous?.disconnect();
      if (generation !== entryGeneration) return;
      const host = new URL(hostValue);
      if (!['https:', 'http:'].includes(host.protocol)) throw new Error('請輸入 HTTP 或 HTTPS 主機網址。');
      const ws = signalingUrl(host, pathValue);
      const moduleUrl = new URL('/lib/stage-client.js', host).href;
      showProgress('載入舞台元件中…');
      // The host is selected by this page's visitor, not known at build time.
      const library: typeof StageLibrary = await import(/* @vite-ignore */ moduleUrl);
      if (generation !== entryGeneration) return;
      // Stage capture stays meter-free; the separate explicit preview owns its own meter.
      client = new library.StageClient({ url: ws.href, audioElement: audio, enableMicMeter: false });
      const current = client; controlsClient = current; entryClient = current; decodeRoomName = library.decodeName;
      connectionStatsBinding = { client: current, generation }; connectionStatsTeardown = false;
      micTestBinding = { client: current, generation };
      maxGainDb = typeof library.MAX_GAIN_DB === 'number' && Number.isFinite(library.MAX_GAIN_DB) && library.MAX_GAIN_DB > 0
        ? library.MAX_GAIN_DB : undefined;
      syncUnlock();
      client.on('state', ({ detail }: CustomEvent<StageEventMap['state']>) => {
        // Record rejected receipts too: their mutable objects cannot later become a new admission.
        const unseen = detail && typeof detail === 'object' && !occupancyReceipts.has(detail);
        if (detail && typeof detail === 'object') occupancyReceipts.add(detail);
        if (client !== current || cancelledEntry || generation !== entryGeneration || occupancyRetiredGeneration === generation || controlsClient !== current) return;
        const rosterEvent = ++publicRosterEventRevision, rosterRetirement = publicRosterRetirementRevision;
        if (detail === current.state && unseen) micTestFence = undefined;
        reconcileMicTest();
        // SDK installs state before status; only its actual, previously unseen state receipt is fresh.
        const speakingStateValid = receiveSpeakingState(current, generation, detail, Boolean(unseen));
        if (!speakingStateValid) renderSpeaking();
        // Public projection getters may have replaced this entry before legacy reconciliation.
        if (client !== current || controlsClient !== current || generation !== entryGeneration || cancelledEntry) return;
        reconcileQuality();
        if (detail === current.state && unseen && eligibleQualitySeat(current) && !qualitySeat) {
          qualitySeat = { client: current, generation, roomId: detail.roomId, participantId: detail.me.participantId };
          qualityRevision++;
        }
        reconcileOccupancy();
        if (detail === current.state && unseen
          && (current.status === 'waiting' || current.status === 'live')) {
          occupancyReport = projectOccupancy(current, generation, detail); occupancyRevision++;
        }
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
        syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName(); syncHandQueue(); syncStageManagement(); syncRoomClose(); syncMicrophone(); syncAudioRetry(); syncOutput(); syncMicTest();
        if (renderingEntry === entryGeneration && client === current && controlsClient === current) {
          leave.disabled = false; renderOccupancy();
          if (renderingEntry === entryGeneration && client === current && controlsClient === current) renderQuality();
          if (renderingEntry === entryGeneration && client === current && controlsClient === current) renderSpeaking();
          if (renderingEntry === entryGeneration && client === current && controlsClient === current) syncConnectionStats();
          receivePublicRoster(current, generation, detail, Boolean(unseen), rosterEvent, rosterRetirement);
        }
      });
      client.on('quality', ({ detail }) => {
        const unseen = !detail || typeof detail !== 'object' || !qualityReceipts.has(detail);
        if (detail && typeof detail === 'object') qualityReceipts.add(detail);
        if (client !== current || cancelledEntry || generation !== entryGeneration || controlsClient !== current) return;
        reconcileQuality();
        const seat = qualitySeat, revision = qualityRevision;
        if (unseen && seat) {
          let projection: QualityReport | undefined;
          try { projection = projectQuality(detail, seat.participantId); } catch { /* Malformed public events fail closed. */ }
          if (revision !== qualityRevision || seat !== qualitySeat || client !== current || generation !== entryGeneration) { renderQuality(); return; }
          reconcileQuality();
          if (seat === qualitySeat) { qualityReport = projection; qualityRevision++; }
        }
        renderQuality(); renderPublicRoster();
      });
      client.on('speaking', ({ detail }) => {
        const unseen = !detail || typeof detail !== 'object' || !speakingReceipts.has(detail);
        if (detail && typeof detail === 'object') speakingReceipts.add(detail);
        if (client !== current || cancelledEntry || generation !== entryGeneration || controlsClient !== current) return;
        reconcileSpeaking();
        const seat = speakingSeat, revision = speakingRevision;
        if (unseen && seat) {
          let projection: SpeakingReport | undefined;
          try { projection = projectSpeakingReport(detail); } catch { /* Malformed reports mean unknown activity, not silence. */ }
          reconcileSpeaking(); reconcileSpeakingConsents();
          if (revision !== speakingRevision || seat !== speakingSeat || current !== client || generation !== entryGeneration) { renderSpeaking(); return; }
          speakingReport = projection; speakingRevision++;
        }
        renderSpeaking(); renderPublicRoster();
      });
      const retireOwnHandRejection = (participantId: string): void => {
        if (client === current && controlsClient === current && !cancelledEntry && generation === entryGeneration
          && participantId === current.me?.participantId) retireHandRejection();
      };
      client.on('hand', ({ detail }) => { if (detail.raised) retireOwnHandRejection(detail.participantId); });
      client.on('invite', ({ detail }) => fenceMicTest(current, generation, detail.participantId));
      client.on('stagejoined', ({ detail }) => { fenceMicTest(current, generation, detail.participantId); retireOwnHandRejection(detail.participantId); });
      client.on('role', ({ detail }) => { if (detail.role !== 'audience') retireOwnHandRejection(detail.participantId); });
      client.on('transferred', ({ detail }) => retireOwnHandRejection(detail.toId));
      const ownsTransferEvents = (): boolean => client === current && controlsClient === current
        && !cancelledEntry && generation === entryGeneration && stageManagementOwner?.client === current;
      client.on('role', ({ detail }) => {
        const speakingPruned = detail.role === 'audience' && pruneSpeaking(current, generation, detail.participantId);
        const closeFenced = detail.role !== 'controller' && fenceRoomClose(current, generation, detail.participantId);
        const transferFenced = ownsTransferEvents() && ((detail.participantId === stageManagementOwner!.participantId && detail.role !== 'controller')
          || (stageManagementRows.has(detail.participantId) && detail.role !== 'speaker'));
        // Both confirmations lose authority before either control can synchronously reenter from render.
        if (transferFenced) fenceTransfer(false);
        const ownDeparture = client === current && controlsClient === current && !cancelledEntry && generation === entryGeneration
          && detail.participantId === current.me?.participantId && detail.role === 'audience';
        if (ownDeparture) retireQuality();
        if (closeFenced) syncRoomClose();
        if (transferFenced) syncStageManagement();
        if (ownDeparture && client === current && generation === entryGeneration) renderQuality();
        if (speakingPruned && client === current && generation === entryGeneration) renderSpeaking();
      });
      client.on('transferred', ({ detail }) => {
        const closeFenced = fenceRoomClose(current, generation, detail.fromId);
        const transferFenced = ownsTransferEvents() && detail.fromId === stageManagementOwner!.participantId;
        if (transferFenced) fenceTransfer(false);
        if (closeFenced) syncRoomClose();
        if (transferFenced) syncStageManagement();
      });
      client.on('stageleft', ({ detail }) => {
        const speakingPruned = pruneSpeaking(current, generation, detail.participantId);
        const ownDeparture = client === current && controlsClient === current && !cancelledEntry && generation === entryGeneration
          && detail.participantId === current.me?.participantId;
        if (ownDeparture) retireQuality();
        const transferFenced = ownsTransferEvents() && stageManagementRows.has(detail.participantId);
        if (transferFenced) fenceTransfer(false);
        if (transferFenced) syncStageManagement();
        if (ownDeparture && client === current && generation === entryGeneration) renderQuality();
        if (speakingPruned && client === current && generation === entryGeneration) renderSpeaking();
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
        if (client !== current || cancelledEntry || generation !== entryGeneration) return;
        publicRosterEventRevision++;
        if (detail === 'reconnecting' && publicRosterOwner) { publicRosterOwner.stale = true; publicRosterOwner.reconnecting = true; }
        if (detail === 'disconnected') retireMicTestBinding();
        else if (detail === 'reconnecting') retireMicTest();
        if (detail === 'disconnected') retireConnectionStatsBinding();
        else if (detail === 'reconnecting') retireConnectionStats();
        if (detail === 'disconnected') { occupancyRetiredGeneration = generation; retireOccupancy(); retireQuality(); retireSpeaking(); retirePublicRoster(); }
        else {
          reconcileOccupancy();
          if (detail === 'reconnecting') { retireQuality(); retireSpeaking(); }
          else { reconcileQuality(); reconcileSpeaking(); }
        }
        const renderingEntry = entryGeneration;
        syncRoomClose();
        if (renderingEntry !== entryGeneration || client !== current) return;
        if (current.state) { receivedState = true; if (generation === entryGeneration) hideCancel(); }
        if (detail === 'reconnecting') { retireHandRejection(); progress = false; status.textContent = '重新連線中'; hand.disabled = true; }
        else if (detail === 'disconnected') { progress = false; retirePlayback(); retireControls(); status.textContent = '未連線'; hand.disabled = leave.disabled = true; }
        syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName(); syncHandQueue(); syncStageManagement(); syncRoomClose(); syncMicrophone(); syncAudioRetry(); syncOutput(); syncMicTest();
        if (renderingEntry === entryGeneration && client === current) renderOccupancy();
        if (renderingEntry === entryGeneration && client === current) renderQuality();
        if (renderingEntry === entryGeneration && client === current) renderSpeaking();
        if (renderingEntry === entryGeneration && client === current) renderPublicRoster();
        if (renderingEntry === entryGeneration && client === current) finishConnectionStatsTeardown(renderingEntry);
      });
      // Original role/stage Close/Transfer fences above run before this passive notification reader.
      for (const type of ['role', 'stagejoined', 'stageleft', 'transferred', 'mic'] as const) current.on(type, () => {
        if (client !== current || controlsClient !== current || cancelledEntry || generation !== entryGeneration) return;
        publicRosterEventRevision++;
        if (publicRosterOwner) publicRosterOwner.awaitingState = true;
        renderPublicRoster();
      });
      client.on('error', ({ detail }) => { if (client !== current || cancelledEntry || generation !== entryGeneration) return; progress = false; report(detail); });
      client.on('audioblocked', () => { if (cancelledEntry) return; progress = false; status.textContent = '請點擊啟用音訊。'; });
      client.on('closed', ({ detail }) => {
        if (client !== current || cancelledEntry || generation !== entryGeneration) return;
        const retired = retireEntry();
        clearError(); retirePlayback(); retireControls(); syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName();
        renderOccupancy();
        if (retired === entryGeneration && client === current) renderQuality();
        if (retired === entryGeneration && client === current) renderSpeaking();
        if (retired === entryGeneration && client === current) renderPublicRoster();
        if (retired === entryGeneration && client === current) finishConnectionStatsTeardown(retired);
        if (retired !== entryGeneration || client !== current) return;
        status.textContent = detail.reason === 'shutdown' ? '伺服器維護或重新啟動，房間已關閉。' : '房間已關閉。'; hand.disabled = leave.disabled = true;
      });
      client.on('kicked', () => {
        if (client !== current || cancelledEntry || generation !== entryGeneration) return;
        const retired = retireEntry();
        clearError(); retirePlayback(); retireControls(); syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName();
        renderOccupancy();
        if (retired === entryGeneration && client === current) renderQuality();
        if (retired === entryGeneration && client === current) renderSpeaking();
        if (retired === entryGeneration && client === current) renderPublicRoster();
        if (retired === entryGeneration && client === current) finishConnectionStatsTeardown(retired);
        if (retired !== entryGeneration || client !== current) return;
        status.textContent = '你已被主控移出房間。'; hand.disabled = leave.disabled = true;
      });
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
    finally { if (ownsMicrophoneAttempt(owner, attempt)) { pendingMicrophone = undefined; syncMicrophone(); syncMicTest(); } }
  })();
};
microphoneApply.onclick = () => {
  syncMicrophone();
  const owner = microphoneOwner;
  if (!owner || microphonePanel.hidden || microphoneApply.hidden || microphoneApply.disabled || pendingMicrophone) return;
  const draft = owner.draft, attempt = pendingMicrophone = { kind: 'apply' };
  stopMicTestAttempt(); syncMicrophone(); syncMicTest();
  void (async () => {
    try { if (ownsMicrophoneAttempt(owner, attempt)) await owner.client.setInputDevice(draft); }
    catch (error) { reportMicrophoneError(owner, attempt, error); }
    finally {
      // Fulfillment can be a cancelled stage-transition no-op; micready is not this operation's completion.
      if (ownsMicrophoneAttempt(owner, attempt)) { pendingMicrophone = undefined; syncMicrophone(); syncMicTest(); }
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
  const current = client, generation = retireEntry();
  clearError();
  retirePlayback(); scheduleHandCooldown(0);
  retireControls(); hand.setAttribute('aria-busy', 'false'); syncHand(); syncMic(); syncStage(); syncMicRetry();
  renderOccupancy();
  if (generation === entryGeneration && client === current) renderQuality();
  if (generation === entryGeneration && client === current) renderSpeaking();
  if (generation === entryGeneration && client === current) renderPublicRoster();
  if (generation === entryGeneration && client === current) finishConnectionStatsTeardown(generation);
  if (generation !== entryGeneration || client !== current) return;
  void current?.disconnect().then(() => {
    if (generation !== entryGeneration || client !== current) return;
    status.textContent = '已離開。'; hand.disabled = leave.disabled = true;
  });
};
replaceOutputOptions([]);
syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName(); syncHandQueue(); syncStageManagement(); syncRoomClose(); syncMicrophone(); syncAudioRetry(); syncOutput(); syncMicTest(); syncUnlock();

connectionStatsUpdate.onclick = refreshConnectionStats;
syncConnectionStats();

micTestStart.onclick = startMicTest;
micTestCancel.onclick = () => cancelMicTest(false);
micTestStop.onclick = () => cancelMicTest(true);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) retireMicTest();
  syncMicTest();
});
window.addEventListener('pagehide', () => { micTestPageHidden = true; retireMicTest(); syncMicTest(); });
window.addEventListener('pageshow', () => { micTestPageHidden = false; syncMicTest(); });
syncMicTest();
