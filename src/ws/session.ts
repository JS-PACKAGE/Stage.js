import { randomBytes } from 'node:crypto';
import type { WebSocket } from 'ws';
import type { ServerMessage } from '../../shared/protocol.ts';
import type { Session } from './hub.ts';

/** A slow reader must not retain an unbounded queue of snapshots and signaling messages. */
export class WsSession implements Session {
  readonly id = randomBytes(6).toString('base64url');
  readonly ws: WebSocket;
  alive = true;
  /** Per-connection ordering: a message is handled only after the previous one settled. */
  chain: Promise<void> = Promise.resolve();
  private readonly maxSendBufferBytes: number;
  private readonly onBackpressure: (bufferedBytes: number, messageBytes: number) => void;
  private overloaded = false;
  constructor(ws: WebSocket, maxSendBufferBytes: number, onBackpressure: (bufferedBytes: number, messageBytes: number) => void) {
    this.ws = ws;
    this.maxSendBufferBytes = maxSendBufferBytes;
    this.onBackpressure = onBackpressure;
  }
  send(msg: ServerMessage, encoded?: string): void {
    if (this.overloaded || this.ws.readyState !== this.ws.OPEN) return;
    const data = encoded ?? JSON.stringify(msg);
    const messageBytes = Buffer.byteLength(data);
    const bufferedBytes = this.ws.bufferedAmount;
    // Server frames are unmasked; account for their 2/4/10-byte framing as well as UTF-8.
    const frameBytes = messageBytes + (messageBytes < 126 ? 2 : messageBytes < 65536 ? 4 : 10);
    if (bufferedBytes + frameBytes > this.maxSendBufferBytes) {
      this.overloaded = true;
      // A close frame would wait behind the stalled queue. Terminate instead: abnormal closure
      // preserves the participant's seat/media for the normal reconnect grace period.
      this.ws.terminate();
      this.onBackpressure(bufferedBytes, messageBytes);
      return;
    }
    this.ws.send(data);
  }
  close(code: number, reason: string): void {
    this.ws.close(code, reason);
  }
}
