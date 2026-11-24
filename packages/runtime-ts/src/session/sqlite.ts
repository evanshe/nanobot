import sqlite3 from 'sqlite3';
import { chmod, lstat } from 'node:fs/promises';
import migrations from './schema.json' with { type: 'json' };

export type SqlValue = null | string | number | Uint8Array;
export type SqlRow = Record<string, SqlValue>;
export type SqlRunResult = Readonly<{ changes: number; lastId: number }>;
export type SqlRead = { all(sql: string, parameters?: readonly SqlValue[]): Promise<SqlRow[]> };
export type SqlWrite = SqlRead & {
  run(sql: string, parameters?: readonly SqlValue[]): Promise<SqlRunResult>;
  exec(sql: string): Promise<void>;
};
function rowsAtBoundary(rows: unknown[]): SqlRow[] {
  return rows.map(row => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid SQLite row');
    const result: SqlRow = Object.create(null);
    for (const [key, value] of Object.entries(row)) {
      if (value !== null && typeof value !== 'string' && typeof value !== 'number' && !(value instanceof Uint8Array)) throw new Error(`Invalid SQLite column ${key}`);
      result[key] = value;
    }
    return result;
  });
}
function parametersAtBoundary(parameters: readonly SqlValue[]): (null | string | number | Buffer)[] {
  return parameters.map(value => value instanceof Uint8Array ? Buffer.from(value.buffer, value.byteOffset, value.byteLength) : value);
}
function all(database: sqlite3.Database, sql: string, parameters: readonly SqlValue[] = []): Promise<SqlRow[]> {
  return new Promise((resolve, reject) => database.all(sql, parametersAtBoundary(parameters), (error: Error | null, rows: unknown[]) => {
    if (error) { reject(error); return; }
    try { resolve(rowsAtBoundary(rows)); } catch (error) { reject(error); }
  }));
}
function run(database: sqlite3.Database, sql: string, parameters: readonly SqlValue[] = []): Promise<SqlRunResult> {
  return new Promise((resolve, reject) => database.run(sql, parametersAtBoundary(parameters), function (this: sqlite3.RunResult, error: Error | null) {
    if (error) reject(error); else resolve({ changes: this.changes, lastId: this.lastID });
  }));
}
function exec(database: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => database.exec(sql, error => error ? reject(error) : resolve()));
}
function closeNative(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
}
async function rejectSymlink(path: string): Promise<void> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error('session database must not be a symlink'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function openNative(path: string, readonly: boolean, busyTimeoutMs: number): Promise<sqlite3.Database> {
  await rejectSymlink(path);
  const database = await new Promise<sqlite3.Database>((resolve, reject) => {
    const instance = new sqlite3.Database(path, (readonly ? sqlite3.OPEN_READONLY : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE) | sqlite3.OPEN_FULLMUTEX,
      error => error ? reject(error) : resolve(instance));
  });
  try {
    database.configure('busyTimeout', busyTimeoutMs);
    await exec(database, 'PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL');
    return database;
  } catch (error) { await closeNative(database); throw error; }
}
export class SqliteDriver {
  readonly path: string;
  readonly #database: sqlite3.Database;
  readonly #busyTimeoutMs: number;
  #tail: Promise<void> = Promise.resolve();
  #pending = new Set<Promise<unknown>>();
  #closing: Promise<void> | null = null;
  #closed = false;
  private constructor(path: string, database: sqlite3.Database, busyTimeoutMs: number) {
    this.path = path; this.#database = database; this.#busyTimeoutMs = busyTimeoutMs;
  }
  static async open(path: string, options: { busyTimeoutMs?: number } = {}): Promise<SqliteDriver> {
    const timeout = options.busyTimeoutMs ?? 5000;
    if (!Number.isInteger(timeout) || timeout < 0) throw new RangeError('Invalid SQLite busy timeout');
    return new SqliteDriver(path, await openNative(path, false, timeout), timeout);
  }
  get pendingOperations(): number { return this.#pending.size; }
  #admit<T>(operation: Promise<T>): Promise<T> {
    this.#pending.add(operation);
    const finished = () => { this.#pending.delete(operation); };
    void operation.then(finished, finished);
    return operation;
  }
  #checkOpen(): void { if (this.#closed) throw new Error('session database is closing or closed'); }
  write<T>(operation: (transaction: SqlWrite) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.#checkOpen(); signal?.throwIfAborted();
    const accepted = this.#tail.then(async () => {
      await rejectSymlink(this.path);
      let active = true;
      const ensureActive = () => { if (!active) throw new Error('SQLite transaction has settled'); };
      const transaction: SqlWrite = {
        all: (sql, parameters) => { ensureActive(); return all(this.#database, sql, parameters); },
        run: (sql, parameters) => { ensureActive(); return run(this.#database, sql, parameters); },
        exec: sql => { ensureActive(); return exec(this.#database, sql); },
      };
      await exec(this.#database, 'BEGIN IMMEDIATE');
      try {
        const result = await operation(transaction); await exec(this.#database, 'COMMIT'); return result;
      } catch (error) {
        try { await exec(this.#database, 'ROLLBACK'); } catch { /* Preserve the operation failure. */ }
        throw error;
      } finally { active = false; }
    });
    this.#tail = accepted.then(() => {}, () => {});
    // Accepted mutations are never interrupted: cancellation is observed after settlement.
    return this.#admit(accepted.then(result => { signal?.throwIfAborted(); return result; }));
  }
  read<T>(operation: (snapshot: SqlRead) => Promise<T>, signal?: AbortSignal): Promise<T> {
    this.#checkOpen(); signal?.throwIfAborted();
    const accepted = (async () => {
      const database = await openNative(this.path, true, this.#busyTimeoutMs);
      let interruptTimer: ReturnType<typeof setInterval> | undefined;
      let active = true;
      const interrupt = () => {
        database.interrupt();
        // An abort can precede the native worker starting sqlite3_step. Repeat
        // until its callback settles so that race cannot leave a long read running.
        interruptTimer ??= setInterval(() => database.interrupt(), 2);
        interruptTimer.unref();
      };
      const stopInterrupt = () => { signal?.removeEventListener('abort', interrupt); if (interruptTimer) clearInterval(interruptTimer); };
      signal?.addEventListener('abort', interrupt, { once: true });
      try {
        signal?.throwIfAborted(); await exec(database, 'BEGIN');
        const result = await operation({ all: (sql, parameters) => {
          if (!active) throw new Error('SQLite snapshot has settled');
          signal?.throwIfAborted(); return all(database, sql, parameters);
        } });
        signal?.throwIfAborted(); await exec(database, 'COMMIT'); return result;
      } catch (error) {
        stopInterrupt();
        try { await exec(database, 'ROLLBACK'); } catch { /* Interrupt may already have rolled back. */ }
        if (signal?.aborted) throw signal.reason;
        throw error;
      } finally { active = false; stopInterrupt(); await closeNative(database); }
    })();
    return this.#admit(accepted);
  }
  initializeSchema(afterUpgrade?: (transaction: SqlWrite) => Promise<void>): Promise<void> {
    this.#checkOpen();
    const accepted = this.#tail.then(async () => {
      await rejectSymlink(this.path);
      // Reject future schema versions before enabling persistent WAL settings.
      const version = (await all(this.#database, 'PRAGMA user_version'))[0].user_version;
      if (typeof version !== 'number' || version < 0 || version > migrations.length) throw new Error(`unsupported session database schema: ${version}`);
      await all(this.#database, "SELECT json_extract('{}', '$'), json_type('{}')");
      await all(this.#database, 'PRAGMA journal_mode=WAL');
      await chmod(this.path, 0o600);
      await exec(this.#database, 'BEGIN IMMEDIATE');
      let active = true;
      const check = () => { if (!active) throw new Error('SQLite initialization has settled'); };
      const transaction: SqlWrite = {
        all: (sql, parameters) => { check(); return all(this.#database, sql, parameters); },
        run: (sql, parameters) => { check(); return run(this.#database, sql, parameters); },
        exec: sql => { check(); return exec(this.#database, sql); },
      };
      try {
        const current = (await all(this.#database, 'PRAGMA user_version'))[0].user_version;
        if (typeof current !== 'number' || current < 0 || current > migrations.length) throw new Error(`unsupported session database schema: ${current}`);
        for (const migration of migrations.slice(current)) {
          for (const sql of migration.statements) await exec(this.#database, sql);
          await exec(this.#database, `PRAGMA user_version=${migration.version}`);
        }
        if (afterUpgrade) await afterUpgrade(transaction);
        await exec(this.#database, 'COMMIT');
      } catch (error) {
        try { await exec(this.#database, 'ROLLBACK'); } catch { /* Preserve the migration failure. */ }
        throw error;
      } finally { active = false; }
      // The session owner imports JSONL before setting its one-time marker.
    });
    this.#tail = accepted.then(() => {}, () => {});
    return this.#admit(accepted);
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true;
      this.#closing = (async () => { await Promise.allSettled([...this.#pending]); await closeNative(this.#database); })();
    }
    return this.#closing;
  }
}
