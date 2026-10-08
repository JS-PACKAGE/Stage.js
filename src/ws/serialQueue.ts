/**
 * Single-file command queue (AGENTS.md §S6). Each room owns one: every state
 * change and signaling step for that room runs to completion before the next
 * starts, so handover / stage transitions can never interleave across an await.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    // Keep the chain alive regardless of task failure; the caller handles the rejection.
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
