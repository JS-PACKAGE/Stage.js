/** A bounded per-connection backlog; stopping drops waiting payloads but lets the active work settle. */
export class MessageQueue<T> {
  private readonly items: { value: T; bytes: number }[] = [];
  private bytes = 0;
  private stopped = false;
  private running: Promise<void> | undefined;
  constructor(
    maxMessages: number,
    maxBytes: number,
    handle: (value: T) => Promise<void>,
    onError: (error: unknown) => void,
  ) {
    this.maxMessages = maxMessages;
    this.maxBytes = maxBytes;
    this.handle = handle;
    this.onError = onError;
  }
  private readonly maxMessages: number;
  private readonly maxBytes: number;
  private readonly handle: (value: T) => Promise<void>;
  private readonly onError: (error: unknown) => void;
  get pendingMessages(): number { return this.items.length; }
  get pendingBytes(): number { return this.bytes; }
  enqueue(value: T, bytes: number): boolean {
    if (this.stopped) return false;
    if (this.running && (this.items.length >= this.maxMessages || this.bytes + bytes > this.maxBytes)) return false;
    this.items.push({ value, bytes });
    this.bytes += bytes;
    if (!this.running) this.start();
    return true;
  }
  stop(): Promise<void> {
    this.stopped = true;
    this.items.length = 0;
    this.bytes = 0;
    return this.running ?? Promise.resolve();
  }
  private start(): void {
    this.running = this.drain().catch(error => {
      void this.stop();
      this.onError(error);
    }).finally(() => {
      this.running = undefined;
      // A new arrival can fall between drain finishing and this promise settling.
      if (!this.stopped && this.items.length) this.start();
    });
  }
  private async drain(): Promise<void> {
    while (!this.stopped && this.items.length) {
      const item = this.items.shift()!;
      this.bytes -= item.bytes;
      await this.handle(item.value);
    }
  }
}
