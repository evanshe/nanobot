export class RuntimeMaintenanceError extends Error {
  constructor() { super('nanobot is preparing an update. Try again after maintenance finishes.'); this.name = 'RuntimeMaintenanceError'; }
}
export class RuntimeBusyError extends Error {
  constructor(message = 'nanobot has pending work. Finish active tasks and retry the update.') { super(message); this.name = 'RuntimeBusyError'; }
}
// In-process coordination only; this is not a cross-process profile writer lock.
export class RuntimeAdmission {
  #paused = false;
  #active = 0;
  #pendingChecks = new Set<() => boolean>();
  #waiting = new Set<() => void>();
  get paused(): boolean { return this.#paused; }
  check(): void { if (this.#paused) throw new RuntimeMaintenanceError(); }
  async waitUntilOpen(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    while (this.#paused) {
      await new Promise<void>((resolve, reject) => {
        const remove = () => { this.#waiting.delete(wake); signal?.removeEventListener('abort', abort); };
        const wake = () => { remove(); resolve(); };
        const abort = () => { remove(); reject(signal!.reason); };
        this.#waiting.add(wake);
        signal?.addEventListener('abort', abort, { once: true });
      });
      signal?.throwIfAborted();
    }
  }
  registerPendingWork(check: () => boolean): () => void {
    this.check();
    // Duplicate registrations are separate owners, matching Python's list.
    const entry = () => check();
    this.#pendingChecks.add(entry);
    return () => { this.#pendingChecks.delete(entry); };
  }
  activity(): () => void {
    this.check(); this.#active++;
    let active = true;
    return () => { if (active) { active = false; this.#active--; } };
  }
  async withActivity<T>(operation: () => Promise<T> | T): Promise<T> {
    const release = this.activity();
    try { return await operation(); } finally { release(); }
  }
  pauseIfIdle(hasPendingWork: () => boolean): () => void {
    this.check();
    if (this.#active || hasPendingWork() || [...this.#pendingChecks].some(check => check())) throw new RuntimeBusyError();
    return this.pauseBeforeStart();
  }
  pauseBeforeStart(): () => void {
    this.check();
    if (this.#active) throw new RuntimeBusyError('Runtime work has already started');
    this.#paused = true;
    let paused = true;
    return () => {
      if (!paused) return;
      paused = false; this.#paused = false;
      for (const wake of [...this.#waiting]) wake();
    };
  }
  async withPausedIfIdle<T>(hasPendingWork: () => boolean, operation: () => Promise<T> | T): Promise<T> {
    const resume = this.pauseIfIdle(hasPendingWork);
    try { return await operation(); } finally { resume(); }
  }
}
