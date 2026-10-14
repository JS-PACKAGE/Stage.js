import type { StageClient as Client, StageEventMap } from '../../packages/client/src/index.ts';
import type * as StageLibrary from '../../packages/client/src/index.ts';
import './styles.css';
function input(id: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`#${id}`)!;
}
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const join = document.querySelector<HTMLFormElement>('#join')!;
const submit = join.querySelector<HTMLButtonElement>('button')!;
submit.setAttribute('aria-busy', 'false');
const hand = document.querySelector<HTMLButtonElement>('#hand')!;
const leave = document.querySelector<HTMLButtonElement>('#leave')!;
const cancelJoin = document.querySelector<HTMLButtonElement>('#cancel-join')!;
const mic = document.querySelector<HTMLButtonElement>('#mic')!;
const rename = document.querySelector<HTMLButtonElement>('#rename')!;
const stage = document.querySelector<HTMLButtonElement>('#stage')!;
const micRetry = document.querySelector<HTMLButtonElement>('#mic-retry')!;
const audio = document.querySelector<HTMLAudioElement>('#audio')!;
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
let micRetryParticipant: string | undefined;
let pendingMicRetry: { client: Client } | undefined;
let playbackGeneration = 0;
let entryGeneration = 0;
let feedbackRevision = 0;
let cancelEntry: (() => void) | undefined;
function hideCancel(): void {
  cancelEntry = undefined; cancelJoin.hidden = cancelJoin.disabled = true;
}
function retireControls(): void {
  pendingHand = undefined; pendingMic = undefined; pendingStage = undefined;
  controlsClient = undefined; micRetryParticipant = undefined; pendingMicRetry = undefined;
  pendingRename = undefined; syncRename();
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
  const me = client?.me;
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
function report(error: unknown): void {
  feedbackRevision++;
  status.textContent = error instanceof Error ? error.message : '操作失敗。';
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
  const hostValue = input('host').value, pathValue = input('ws-path').value;
  const joinOptions = { roomId: input('room').value.trim(), code: input('code').value.trim() || undefined, name: input('name').value.trim() };
  playbackGeneration++; scheduleHandCooldown(0);
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
    playbackGeneration++; scheduleHandCooldown(0); retireControls();
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
      const current = client; controlsClient = current; entryClient = current;
      client.on('state', ({ detail }: CustomEvent<StageEventMap['state']>) => {
        if (client !== current || cancelledEntry) return;
        receivedState = true;
        if (generation === entryGeneration) hideCancel();
        progress = false;
        status.textContent = `${library.decodeName(detail.name)} · ${library.decodeName(detail.me.name)} · ${detail.me.onStage ? '已上台' : '收聽中'}`;
        syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename();
        leave.disabled = false;
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
        if (detail === 'reconnecting') { progress = false; status.textContent = '重新連線中'; hand.disabled = true; }
        else if (detail === 'disconnected') { progress = false; playbackGeneration++; retireControls(); status.textContent = '未連線'; hand.disabled = leave.disabled = true; }
        syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename();
      });
      client.on('error', ({ detail }) => { if (cancelledEntry) return; progress = false; report(detail); });
      client.on('audioblocked', () => { if (cancelledEntry) return; progress = false; status.textContent = '請點擊啟用音訊。'; });
      client.on('closed', () => { if (client !== current || cancelledEntry || generation !== entryGeneration) return; retireEntry(); playbackGeneration++; retireControls(); syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); status.textContent = '房間已關閉。'; hand.disabled = leave.disabled = true; });
      client.on('kicked', () => { if (client !== current || cancelledEntry || generation !== entryGeneration) return; retireEntry(); playbackGeneration++; retireControls(); syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename(); status.textContent = '你已被主控移出房間。'; hand.disabled = leave.disabled = true; });
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
document.querySelector<HTMLButtonElement>('#unlock')!.onclick = () => {
  const current = client, generation = playbackGeneration;
  // Keep play inside the user gesture; only its later feedback is lifecycle-scoped.
  void (current ? current.unlockAudio() : audio.play()).catch(error => {
    if (generation === playbackGeneration && client === current) report(error);
  });
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
  playbackGeneration++; scheduleHandCooldown(0);
  retireControls(); hand.setAttribute('aria-busy', 'false'); syncMic(); syncStage(); syncMicRetry();
  void current?.disconnect().then(() => {
    if (generation !== entryGeneration || client !== current) return;
    status.textContent = '已離開。'; hand.disabled = leave.disabled = true;
  });
};
syncHand(); syncMic(); syncStage(); syncMicRetry(); syncRename();
