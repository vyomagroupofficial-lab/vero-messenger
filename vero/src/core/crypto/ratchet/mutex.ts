/**
 * Per-key async mutex. Ratchet state is read-modify-write: two concurrent
 * operations on the same remote device's session (e.g. a realtime delivery
 * and a history fetch of the same message, or a send racing a receive) must
 * never interleave, or a message key could be reused or a state update lost.
 */

export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      // Last one out cleans up so the map doesn't grow without bound.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}
