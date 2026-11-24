// Unbounded, event-loop-local FIFO; waking a consumer does not reserve an item.
// Cancellation between wakeup and resumption therefore cannot lose that item.
export class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: { wake: () => void }[] = [];
  get size(): number { return this.#items.length; }
  putNowait(item: T): void { this.#items.push(item); this.#wakeNext(); }
  #wakeNext(): void { this.#waiters.shift()?.wake(); }
  async get(signal?: AbortSignal): Promise<T> {
    try {
      signal?.throwIfAborted();
      while (!this.#items.length) {
        await new Promise<void>((resolve, reject) => {
          const remove = () => {
            const index = this.#waiters.indexOf(waiter);
            if (index >= 0) this.#waiters.splice(index, 1);
            signal?.removeEventListener('abort', abort);
          };
          const abort = () => { remove(); reject(signal!.reason); };
          const waiter = { wake: () => { remove(); resolve(); } };
          this.#waiters.push(waiter);
          signal?.addEventListener('abort', abort, { once: true });
        });
        signal?.throwIfAborted();
      }
      return this.#items.shift()!;
    } catch (error) {
      if (this.#items.length) this.#wakeNext();
      throw error;
    }
  }
}
