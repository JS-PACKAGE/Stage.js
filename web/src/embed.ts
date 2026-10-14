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
const cancelJoin = document.querySelector<HTMLButtonElement>('#cancel-join')!;
const mic = document.querySelector<HTMLButtonElement>('#mic')!;
const rename = document.querySelector<HTMLButtonElement>('#rename')!;
const roomNamePanel = document.querySelector<HTMLDivElement>('#room-name-panel')!;
const roomNameCurrent = document.querySelector<HTMLParagraphElement>('#room-name-current')!;
const roomNameDraft = input('room-name-draft');
const roomNameUpdate = document.querySelector<HTMLButtonElement>('#room-name-update')!;
const stage = document.querySelector<HTMLButtonElement>('#stage')!;
const micRetry = document.querySelector<HTMLButtonElement>('#mic-retry')!;
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
let decodeRoomName: typeof StageLibrary.decodeName | undefined;
let micRetryParticipant: string | undefined;
let pendingMicRetry: { client: Client } | undefined;
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
  controlsClient = undefined; retireHandRejection();
  pendingHand = undefined; pendingMic = undefined; pendingStage = undefined;
  micRetryParticipant = undefined; pendingMicRetry = undefined;
  pendingRename = undefined; syncRename(); retireRoomName();
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
      const current = client; controlsClient = current; entryClient = current; decodeRoomName = library.decodeName; syncUnlock();
      client.on('state', ({ detail }: CustomEvent<StageEventMap['state']>) => {
        if (client !== current || cancelledEntry) return;
        receivedState = true;
        if (generation === entryGeneration) hideCancel();
        progress = false;
        status.textContent = `${library.decodeName(detail.name)} · ${library.decodeName(detail.me.name)} · ${detail.me.onStage ? '已上台' : '收聽中'}`;
        syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName();
        leave.disabled = false;
      });
      const retireOwnHandRejection = (participantId: string): void => {
        if (client === current && controlsClient === current && !cancelledEntry && generation === entryGeneration
          && participantId === current.me?.participantId) retireHandRejection();
      };
      client.on('hand', ({ detail }) => { if (detail.raised) retireOwnHandRejection(detail.participantId); });
      client.on('stagejoined', ({ detail }) => retireOwnHandRejection(detail.participantId));
      client.on('role', ({ detail }) => { if (detail.role !== 'audience') retireOwnHandRejection(detail.participantId); });
      client.on('transferred', ({ detail }) => retireOwnHandRejection(detail.toId));
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
        if (current.state) { receivedState = true; if (generation === entryGeneration) hideCancel(); }
        if (detail === 'reconnecting') { retireHandRejection(); progress = false; status.textContent = '重新連線中'; hand.disabled = true; }
        else if (detail === 'disconnected') { progress = false; retirePlayback(); retireControls(); status.textContent = '未連線'; hand.disabled = leave.disabled = true; }
        syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName();
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
syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); syncRoomName(); syncUnlock();
