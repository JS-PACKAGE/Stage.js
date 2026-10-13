import type { StageClient as Client, StageEventMap } from '../../packages/client/src/index.ts';
import type * as StageLibrary from '../../packages/client/src/index.ts';
import './styles.css';
function input(id: string): HTMLInputElement {
  return document.querySelector<HTMLInputElement>(`#${id}`)!;
}
const status = document.querySelector<HTMLParagraphElement>('#status')!;
const join = document.querySelector<HTMLFormElement>('#join')!;
const submit = join.querySelector<HTMLButtonElement>('button')!;
const hand = document.querySelector<HTMLButtonElement>('#hand')!;
const leave = document.querySelector<HTMLButtonElement>('#leave')!;
const audio = document.querySelector<HTMLAudioElement>('#audio')!;
const params = new URLSearchParams(location.search);
input('host').value = params.get('host') ?? location.origin;
input('room').value = params.get('room') ?? '';
input('code').value = params.get('code') ?? '';
let client: Client | null = null;
let pendingHand: { client: Client } | undefined;
let playbackGeneration = 0;
let entryGeneration = 0;
/** Retire initial-join feedback before user or terminal callbacks can start another entry. */
function retireEntry(): number { submit.disabled = false; return ++entryGeneration; }
let handTimer: ReturnType<typeof setTimeout> | undefined;
let handTimerDue = 0;
function syncHand(): void {
  const me = client?.me;
  const pending = Boolean(pendingHand && pendingHand.client === client);
  const remaining = me && !me.onStage ? client!.handCooldownMs : 0;
  const seconds = Math.ceil(remaining / 1000);
  hand.disabled = !me || me.onStage || client?.status === 'reconnecting' || pending || (!me.handRaised && seconds > 0);
  hand.setAttribute('aria-busy', String(pending));
  hand.textContent = me?.handRaised ? '收回舉手' : seconds ? `舉手發言（${seconds} 秒）` : '舉手發言';
  scheduleHandCooldown(me && !me.handRaised ? remaining : 0);
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
function report(error: unknown): void { status.textContent = error instanceof Error ? error.message : '操作失敗。'; }
join.onsubmit = (event) => {
  event.preventDefault();
  playbackGeneration++; scheduleHandCooldown(0);
  const generation = ++entryGeneration;
  submit.disabled = true;
  void (async () => {
    try {
      pendingHand = undefined;
      hand.setAttribute('aria-busy', 'false');
      hand.disabled = leave.disabled = true;
      await client?.disconnect();
      if (generation !== entryGeneration) return;
      const host = new URL(input('host').value);
      if (!['https:', 'http:'].includes(host.protocol)) throw new Error('請輸入 HTTP 或 HTTPS 主機網址。');
      const moduleUrl = new URL('/lib/stage-client.js', host).href;
      // The host is selected by this page's visitor, not known at build time.
      const library: typeof StageLibrary = await import(/* @vite-ignore */ moduleUrl);
      if (generation !== entryGeneration) return;
      const ws = new URL('/ws', host); ws.protocol = host.protocol === 'https:' ? 'wss:' : 'ws:';
      client = new library.StageClient({ url: ws.href, audioElement: audio });
      const current = client;
      client.on('state', ({ detail }: CustomEvent<StageEventMap['state']>) => {
        if (client !== current) return;
        status.textContent = `${library.decodeName(detail.name)} · ${library.decodeName(detail.me.name)} · ${detail.me.onStage ? '已上台' : '收聽中'}`;
        syncHand();
        leave.disabled = false;
      });
      client.on('micerror', ({ detail }) => { status.textContent = `${detail.message}（${detail.name}）`; });
      client.on('status', ({ detail }) => {
        if (client !== current) return;
        if (detail === 'reconnecting') { status.textContent = '重新連線中'; hand.disabled = true; }
        else if (detail === 'disconnected') { playbackGeneration++; pendingHand = undefined; status.textContent = '未連線'; hand.disabled = leave.disabled = true; }
        syncHand();
      });
      client.on('error', ({ detail }) => report(detail));
      client.on('audioblocked', () => { status.textContent = '請點擊啟用音訊。'; });
      client.on('closed', () => { if (client !== current) return; retireEntry(); playbackGeneration++; pendingHand = undefined; syncHand(); status.textContent = '房間已關閉。'; hand.disabled = leave.disabled = true; });
      client.on('kicked', () => { if (client !== current) return; retireEntry(); playbackGeneration++; pendingHand = undefined; syncHand(); status.textContent = '你已被主控移出房間。'; hand.disabled = leave.disabled = true; });
      await current.connect();
      if (generation !== entryGeneration) return;
      await current.join({ roomId: input('room').value.trim(), code: input('code').value.trim() || undefined, name: input('name').value.trim() });
    } catch (error) { if (generation === entryGeneration) report(error); }
    finally { if (generation === entryGeneration) submit.disabled = false; }
  })();
};
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
leave.onclick = () => {
  const generation = retireEntry(), current = client;
  playbackGeneration++; scheduleHandCooldown(0);
  pendingHand = undefined; hand.setAttribute('aria-busy', 'false');
  void current?.disconnect().then(() => {
    if (generation !== entryGeneration || client !== current) return;
    status.textContent = '已離開。'; hand.disabled = leave.disabled = true;
  });
};
syncHand();
