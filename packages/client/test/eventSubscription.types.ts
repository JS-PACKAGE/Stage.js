import { StageClient, type ClientStatus, type StageClientEventOptions, type StageEventMap } from '../src/index.ts';

declare const client: StageClient;
declare const signal: AbortSignal;
const target: EventTarget = client;
const oldOn: <K extends keyof StageEventMap>(type: K, listener: (event: CustomEvent<StageEventMap[K]>) => void) => () => void = client.on;
const stop: () => void = client.on('hand', event => {
  const id: string = event.detail.participantId;
  const raised: boolean = event.detail.raised;
  // @ts-expect-error Hand events do not contain room state.
  const room: string = event.detail.roomId;
  void id; void raised; void room;
}, { once: true, signal });
client.on('status', event => {
  const status: ClientStatus = event.detail;
  // @ts-expect-error Status detail is a status string, not a number.
  const invalid: number = event.detail;
  void status; void invalid;
}, { signal });
client.on('micready', event => {
  const absent: undefined = event.detail;
  // @ts-expect-error This event has no detail object.
  const invalid: { message: string } = event.detail;
  void absent; void invalid;
}, { once: true });
const options: StageClientEventOptions = { once: false, signal };
const wider = { once: true, signal, capture: true, passive: true };
client.on('hand', () => {}, options);
client.on('hand', () => {}, wider);
client.on('hand', () => {}, {});
client.on('hand', () => {}, undefined);
client.on('hand', () => {});
function subscribe<K extends keyof StageEventMap>(type: K, listener: (event: CustomEvent<StageEventMap[K]>) => void): () => void {
  return client.on(type, listener, options);
}
const typed = (event: CustomEvent<StageEventMap['hand']>): void => { void event.detail.participantId; };
client.on('hand', typed, { once: true });
client.addEventListener('hand', typed as EventListener, { once: true, signal });
// @ts-expect-error Unknown event names are rejected.
client.on('unknown-event', () => {});
// @ts-expect-error A hand listener cannot handle status detail.
client.on('status', typed, options);
// @ts-expect-error once must be boolean.
client.on('hand', () => {}, { once: 'true' });
// @ts-expect-error signal must be an AbortSignal, not its controller.
client.on('hand', () => {}, { signal: new AbortController() });
// @ts-expect-error capture is not exposed by the convenience helper.
client.on('hand', () => {}, { capture: true });
// @ts-expect-error passive is not exposed by the convenience helper.
client.on('hand', () => {}, { passive: true });
// @ts-expect-error Unrelated options must not silently become part of the public API.
client.on('hand', () => {}, { once: true, unrelated: true });
// @ts-expect-error The native boolean capture shortcut is not supported.
client.on('hand', () => {}, true);
// @ts-expect-error Null is not an options object.
client.on('hand', () => {}, null);
void target; void oldOn; void stop; void subscribe;
