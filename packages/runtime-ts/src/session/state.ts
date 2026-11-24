import type { InboundMessage } from '../bus/events.ts';
import { cloneRecoveryInbound, isSessionMessageInput, recordPendingFollowup, acknowledgePendingFollowups } from './recovery.ts';
import { object } from '../config/decoder.ts';
import type { ConfigObject, Json } from '../config/decoder.ts';
import { HistoryFact, HistoryReader } from './history.ts';
import { SessionRepository, encodeFacts } from './repository.ts';
import type { SessionInfo } from './repository.ts';
import type { SqlRead, SqlWrite } from './sqlite.ts';
import { DEFAULT_SESSION_POLICY, SessionConflictError, encodeJson, equal, hiddenHistory, localTimestamp, newSession, publicHistoryMessage } from './records.ts';
import type { SessionPolicy, SessionRecord } from './records.ts';
export class SessionOperationQueueFullError extends Error {
  constructor(capacity: number) { super(`session operation queue is full: capacity=${capacity}`); this.name = 'SessionOperationQueueFullError'; }
}
function changedStart(before: readonly ConfigObject[], after: readonly ConfigObject[]): number {
  let index = 0; while (index < before.length && index < after.length && equal(before[index], after[index])) index++; return index;
}
const missing = Symbol('missing metadata value');
function ownValue(value: ConfigObject, key: string): Json | typeof missing { return Object.hasOwn(value, key) ? value[key] : missing; }
function put(value: ConfigObject, key: string, item: Json): void { Object.defineProperty(value, key, { value: item, writable: true, configurable: true, enumerable: true }); }
export class SessionState {
  readonly #repository: SessionRepository;
  readonly #capacity: number;
  readonly #generationExclusions: ReadonlySet<string>;
  #admitted = 0;
  #keyTails = new Map<string, Promise<unknown>>();
  #globalTail: Promise<unknown> | null = null;
  #pending = new Set<Promise<unknown>>();
  #baselines = new WeakMap<SessionRecord, SessionRecord>();
  #snapshots = new Map<string, SessionRecord>();
  #transients = new Map<string, SessionRecord>();
  #policies = new Map<string, SessionPolicy>();
  #retired = new Set<string>();
  #closed = false;
  #closing: Promise<void> | null = null;
  constructor(repository: SessionRepository, options: { capacity?: number; generationExclusions?: readonly string[] } = {}) {
    this.#repository = repository; this.#capacity = options.capacity ?? 64;
    if (!Number.isInteger(this.#capacity) || this.#capacity < 1) throw new RangeError('session operation capacity must be positive');
    this.#generationExclusions = new Set(options.generationExclusions);
  }
  get pendingOperations(): number { return this.#admitted; }
  #submit<T>(keys: readonly string[] | null, operation: () => Promise<T>, options: { signal?: AbortSignal; barrier?: boolean } = {}): Promise<T> {
    if (this.#closed) throw new Error('session state is closed');
    options.signal?.throwIfAborted();
    if (this.#admitted >= this.#capacity) throw new SessionOperationQueueFullError(this.#capacity);
    this.#admitted++;
    const labels = [...new Set(keys ?? [])].sort(), predecessors = new Set<Promise<unknown>>();
    if (keys === null && options.barrier !== false) for (const task of this.#pending) predecessors.add(task);
    else for (const key of labels) { const tail = this.#keyTails.get(key); if (tail) predecessors.add(tail); }
    if (keys !== null && this.#globalTail) predecessors.add(this.#globalTail);
    let task!: Promise<T>;
    task = (async () => {
      // Even an empty predecessor set defers work until the task is registered.
      await Promise.allSettled(predecessors);
      try { return await operation(); }
      finally {
        this.#admitted--; this.#pending.delete(task);
        for (const key of labels) if (this.#keyTails.get(key) === task) this.#keyTails.delete(key);
        if (this.#globalTail === task) this.#globalTail = null;
      }
    })();
    this.#pending.add(task);
    if (keys === null && options.barrier !== false) this.#globalTail = task;
    else for (const key of labels) this.#keyTails.set(key, task);
    // Accepted writes drain to completion before cancellation reaches the caller.
    const result = task.then(value => { options.signal?.throwIfAborted(); return value; });
    void result.catch(() => {});
    return result;
  }
  async #load(snapshot: SqlRead, key: string, history = true): Promise<SessionRecord | null> {
    const transient = this.#transients.get(key);
    const value = transient ? structuredClone(transient) : await this.#repository.loadFrom(snapshot, key, history);
    if (value) value.policy = this.#policies.get(key) ?? value.policy;
    if (value && !history && !transient) value.messages = [];
    return value;
  }
  async #save(transaction: SqlWrite, value: SessionRecord, start = 0): Promise<void> {
    if (value.policy.persist) await this.#repository.saveTo(transaction, value, start);
    else { value.persisted = false; value.revision++; }
  }
  #publish(value: SessionRecord): void {
    const snapshot = structuredClone(value); this.#snapshots.set(value.key, snapshot);
    if (this.#snapshots.size > 128) this.#snapshots.delete(this.#snapshots.keys().next().value!);
    if (!value.policy.persist) this.#transients.set(value.key, snapshot);
  }
  #publishHeader(value: SessionRecord): void {
    const cached = this.#snapshots.get(value.key);
    if (cached && cached.revision + 1 === value.revision && cached.generation === value.generation) this.#publish({ ...value, messages: cached.messages });
    else this.#snapshots.delete(value.key);
  }
  #draft(value: SessionRecord): SessionRecord {
    const draft = structuredClone(value); draft.consumedFollowupIds = [];
    this.#baselines.set(draft, structuredClone(value)); return draft;
  }
  peek(key: string): SessionRecord | null { const value = this.#snapshots.get(key); return value ? structuredClone(value) : null; }
  read(key: string, signal?: AbortSignal): Promise<SessionRecord | null> {
    return this.#submit([key], async () => {
      const value = await this.#repository.driver.read(snapshot => this.#load(snapshot, key), signal);
      if (!value) return null; this.#publish(value); return this.#draft(value);
    }, { signal });
  }
  readHeader(key: string, signal?: AbortSignal): Promise<SessionRecord | null> {
    return this.#submit([key], () => this.#repository.driver.read(async snapshot => { const value = await this.#load(snapshot, key, false); if (value) { value.messages = []; value.providerState = null; } return value; }, signal), { signal });
  }
  get(key: string, signal?: AbortSignal): Promise<SessionRecord> {
    return this.#submit([key], async () => {
      let value = await this.#repository.driver.read(snapshot => this.#load(snapshot, key));
      if (!value) value = await this.#repository.driver.write(async transaction => {
        const existing = await this.#load(transaction, key); if (existing) return existing;
        const created = newSession(key); created.policy = this.#policies.get(key) ?? DEFAULT_SESSION_POLICY;
        await this.#save(transaction, created); return created;
      });
      this.#retired.delete(key); this.#publish(value); return this.#draft(value);
    }, { signal });
  }
  setPolicy(key: string, policy: SessionPolicy, signal?: AbortSignal): Promise<void> {
    const frozen = structuredClone(policy);
    return this.#submit([key], async () => {
      if (!frozen.persist) throw new Error('use registerTransient for non-persistent sessions');
      const current = await this.#repository.driver.read(snapshot => this.#load(snapshot, key));
      if (!current || !current.persisted || !current.policy.persist) throw new Error('policy requires an existing durable session');
      this.#policies.set(key, frozen); current.policy = frozen; this.#publish(current);
    }, { signal });
  }
  registerTransient(value: SessionRecord, policy: SessionPolicy, signal?: AbortSignal): Promise<SessionRecord> {
    const frozen = structuredClone(value); frozen.policy = structuredClone(policy); frozen.persisted = false;
    if (policy.persist) throw new Error('Transient sessions require persist=false');
    return this.#submit([value.key], async () => { this.#retired.delete(value.key); this.#policies.set(value.key, frozen.policy); this.#publish(frozen); return this.#draft(frozen); }, { signal });
  }
  #commitDraft(draft: SessionRecord, signal?: AbortSignal): Promise<void> {
    const baseline = this.#baselines.get(draft); if (!baseline) throw new Error('session changes require an owner-issued draft');
    if (draft.key !== baseline.key) throw new SessionConflictError('session key changed');
    const frozen = structuredClone(draft);
    return this.#submit([draft.key], async () => {
      const committed = await this.#repository.driver.write(async transaction => {
        const current = await this.#load(transaction, baseline.key);
        if (!current) throw new SessionConflictError('session was deleted');
        if (current.generation !== baseline.generation) throw new SessionConflictError('session was reset');
        const beforeMessages = current.messages;
        for (const key of new Set([...Object.keys(baseline.metadata), ...Object.keys(frozen.metadata)])) {
          if (key === 'pending_user_followups') continue;
          const before = ownValue(baseline.metadata, key), after = ownValue(frozen.metadata, key); if (equal(before, after)) continue;
          const existing = ownValue(current.metadata, key);
          if (!equal(existing, before) && !equal(existing, after)) throw new SessionConflictError(`turn metadata changed: ${key}`);
          if (after === missing) delete current.metadata[key]; else put(current.metadata, key, structuredClone(after));
        }
        if (!equal(frozen.messages, baseline.messages)) {
          if (equal(current.messages, baseline.messages)) current.messages = structuredClone(frozen.messages);
          else if (equal(frozen.messages.slice(0, baseline.messages.length), baseline.messages) && equal(current.messages.slice(0, baseline.messages.length), baseline.messages)) current.messages = [...current.messages, ...structuredClone(frozen.messages.slice(baseline.messages.length))];
          else throw new SessionConflictError('session history changed');
        }
        for (const field of ['lastArchived', 'providerState'] as const) {
          if (equal(baseline[field], frozen[field])) continue;
          if (!equal(current[field], baseline[field]) && !equal(current[field], frozen[field])) throw new SessionConflictError(`session ${field} changed`);
          if (field === 'lastArchived') current.lastArchived = frozen.lastArchived; else current.providerState = structuredClone(frozen.providerState);
        }
        if (frozen.consumedFollowupIds.length && Array.isArray(current.metadata.pending_user_followups)) {
          const consumed = new Set(frozen.consumedFollowupIds);
          const pending = current.metadata.pending_user_followups.filter(object).filter(item => typeof item.id !== 'string' || !consumed.has(item.id));
          if (pending.length) current.metadata.pending_user_followups = pending; else delete current.metadata.pending_user_followups;
        }
        current.policy = frozen.policy;
        const currentTime = Date.parse(current.updatedAt), draftTime = Date.parse(frozen.updatedAt);
        if (draftTime > currentTime || draftTime === currentTime && frozen.updatedAt > current.updatedAt) current.updatedAt = frozen.updatedAt;
        await this.#save(transaction, current, changedStart(beforeMessages, current.messages)); return current;
      });
      this.#publish(committed); Object.assign(draft, this.#draft(committed)); this.#baselines.set(draft, structuredClone(committed));
    }, { signal });
  }
  prepareInput(draft: SessionRecord, signal?: AbortSignal): Promise<void> { return this.#commitDraft(draft, signal); }
  finishTurn(draft: SessionRecord, signal?: AbortSignal): Promise<void> {
    delete draft.metadata.pending_user_turn; delete draft.metadata.runtime_checkpoint;
    return this.#commitDraft(draft, signal);
  }
  restoreInterruption(draft: SessionRecord, signal?: AbortSignal): Promise<void> { return this.#commitDraft(draft, signal); }
  checkpointView(draft: SessionRecord, payload: ConfigObject, signal?: AbortSignal): Promise<void> {
    const baseline = this.#baselines.get(draft), request = structuredClone(payload), provider = structuredClone(draft.providerState);
    if (!baseline) throw new SessionConflictError('checkpoint requires an owner-issued accepted input');
    return this.#submit([draft.key], async () => {
      const committed = await this.#repository.driver.write(async transaction => {
        const current = await this.#load(transaction, draft.key, false);
        if (!current) throw new SessionConflictError('checkpoint requires accepted input');
        if (current.generation !== baseline.generation) throw new SessionConflictError('checkpoint belongs to a replaced session');
        current.metadata.runtime_checkpoint = request; current.providerState = provider;
        if (current.policy.persist) {
          await this.#repository.writeMetadataTo(transaction, current.key, current.metadata); current.revision++;
          await transaction.run('UPDATE sessions SET provider_state=? WHERE key=?', [provider ? encodeJson(provider) : null, current.key]);
        } else await this.#save(transaction, current);
        return current;
      });
      if (committed.policy.persist) this.#publishHeader(committed); else this.#publish(committed);
      draft.metadata.runtime_checkpoint = structuredClone(request);
      this.#baselines.set(draft, { ...baseline, metadata: { ...baseline.metadata, runtime_checkpoint: structuredClone(request) }, providerState: structuredClone(committed.providerState) });
    }, { signal });
  }
  queueFollowup(key: string, message: InboundMessage, signal?: AbortSignal): Promise<string | null> {
    if (message.channel !== 'websocket' && !isSessionMessageInput(message)) return Promise.resolve(null);
    const payload = cloneRecoveryInbound(message);
    return this.#submit([key], async () => {
      const committed = await this.#repository.driver.write(async transaction => {
        let current = await this.#load(transaction, key, false);
        if (!current) {
          if (this.#retired.has(key) || payload.requireExistingSession || payload.sessionGeneration !== null) throw new SessionConflictError('follow-up requires an existing session');
          current = newSession(key); current.policy = this.#policies.get(key) ?? DEFAULT_SESSION_POLICY;
        }
        if (payload.sessionGeneration !== null && current.generation !== payload.sessionGeneration) throw new SessionConflictError('follow-up belongs to a replaced session');
        const id = recordPendingFollowup(current, payload), headerOnly = current.policy.persist && current.persisted;
        if (headerOnly) { await this.#repository.writeMetadataTo(transaction, key, current.metadata); await transaction.run('UPDATE sessions SET updated_at=? WHERE key=?', [current.updatedAt, key]); current.revision++; }
        else await this.#save(transaction, current);
        return { current, id, headerOnly };
      });
      if (committed.headerOnly) this.#publishHeader(committed.current); else this.#publish(committed.current);
      return committed.id;
    }, { signal });
  }
  acknowledgeFollowups(key: string, ids: readonly string[], signal?: AbortSignal): Promise<void> {
    const frozen = [...ids]; return this.mutateMetadata(key, metadata => acknowledgePendingFollowups({ metadata }, frozen), { signal }).then(() => {});
  }
  commitSummary(source: SessionRecord, summary: string, archiveEnd: number, signal?: AbortSignal): Promise<void> {
    const prefix = structuredClone(source.messages.slice(0, archiveEnd)), generation = source.generation, lastActive = source.updatedAt;
    return this.#submit([source.key], async () => {
      const committed = await this.#repository.driver.write(async transaction => {
        const current = await this.#load(transaction, source.key);
        if (!current || current.generation !== generation || !equal(current.messages.slice(0, archiveEnd), prefix)) throw new SessionConflictError('summarized history was replaced');
        const before = current.messages; current.messages = [...before.slice(0, archiveEnd), { role: 'user', content: 'Continue the active task from the working-memory checkpoint above.', _hidden_history: true, timestamp: localTimestamp() }, ...before.slice(archiveEnd)];
        current.metadata._last_summary = { text: summary, last_active: lastActive }; current.lastArchived = archiveEnd; current.providerState = null;
        await this.#save(transaction, current, changedStart(before, current.messages)); return current;
      }); this.#publish(committed);
    }, { signal });
  }
  readMetadata(key: string, signal?: AbortSignal): Promise<ConfigObject | null> { return this.readHeader(key, signal).then(header => header?.metadata ?? null); }
  recoveryCandidates(prefix: string, signal?: AbortSignal): Promise<[string, boolean][]> {
    return this.#submit(null, () => this.#repository.driver.read(snapshot => this.#repository.recoveryCandidatesFrom(snapshot, prefix), signal), { signal });
  }
  mutateMetadata<T>(key: string, change: (metadata: ConfigObject) => T, options: { createIfMissing?: boolean; expectedGeneration?: string; signal?: AbortSignal } = {}): Promise<readonly [T, ConfigObject]> {
    return this.#submit([key], async () => {
      const committed = await this.#repository.driver.write(async transaction => {
        const loaded = await this.#load(transaction, key, false);
        if (!loaded && (!options.createIfMissing || this.#retired.has(key))) throw new SessionConflictError('session does not exist');
        const current = loaded ?? newSession(key); current.policy = this.#policies.get(key) ?? current.policy;
        if (options.expectedGeneration !== undefined && current.generation !== options.expectedGeneration) throw new SessionConflictError('metadata command belongs to a replaced session');
        const result = structuredClone(change(current.metadata)); current.metadata = structuredClone(current.metadata);
        const headerOnly = current.policy.persist && current.persisted;
        if (headerOnly) { await this.#repository.writeMetadataTo(transaction, key, current.metadata); current.revision++; }
        else await this.#save(transaction, current);
        return { current, result, headerOnly };
      });
      const { current, result, headerOnly } = committed;
      if (headerOnly) {
        this.#publishHeader(current);
      } else this.#publish(current);
      return [result, structuredClone(current.metadata)];
    }, { signal: options.signal });
  }
  updateMetadata(key: string, updates: ConfigObject, options: { remove?: readonly string[]; createIfMissing?: boolean; expectedGeneration?: string; signal?: AbortSignal } = {}): Promise<void> {
    const frozen = structuredClone(updates), removed = [...options.remove ?? []];
    if ([...Object.keys(frozen), ...removed].some(key => ['pending_user_turn', 'runtime_checkpoint', 'pending_user_followups'].includes(key))) throw new Error('turn state must be changed through turn operations');
    return this.mutateMetadata(key, metadata => { for (const name of removed) delete metadata[name]; for (const [name, value] of Object.entries(frozen)) put(metadata, name, value); }, options).then(() => {});
  }
  appendHistory(key: string, facts: readonly HistoryFact[], expectedGeneration: string | null, options: { skipInvalid?: boolean; signal?: AbortSignal } = {}): Promise<string[]> {
    const { encoded, errors } = encodeFacts(facts, options.skipInvalid);
    if (!encoded.length && errors.length) return Promise.resolve(errors);
    return this.#submit([key], async () => { await this.#repository.driver.write(transaction => this.#repository.appendHistoryTo(transaction, key, encoded, expectedGeneration)); return errors; }, { signal: options.signal });
  }
  projectHistory<T>(key: string, project: (reader: HistoryReader) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#submit([key], () => this.#repository.driver.read(snapshot => project(new HistoryReader(snapshot, key)), signal), { signal });
  }
  snapshot<T>(project: (snapshot: SqlRead) => Promise<T>, signal?: AbortSignal): Promise<T> {
    return this.#submit(null, () => this.#repository.driver.read(project, signal), { signal, barrier: false });
  }
  listSessions(signal?: AbortSignal): Promise<SessionInfo[]> {
    return this.#submit(null, () => this.#repository.driver.read(snapshot => this.#repository.listFrom(snapshot), signal), { signal, barrier: false });
  }
  discard(key: string, signal?: AbortSignal): Promise<void> {
    return this.#submit([key], async () => { this.#transients.delete(key); this.#snapshots.delete(key); this.#policies.delete(key); this.#retired.add(key); }, { signal });
  }
  reset(key: string, signal?: AbortSignal): Promise<void> {
    return this.#submit([key], async () => {
      const committed = await this.#repository.driver.write(async transaction => {
        const old = await this.#load(transaction, key, false), current = newSession(key);
        if (old) { current.policy = old.policy; current.metadata = structuredClone(old.metadata); }
        for (const name of ['pending_user_turn', 'runtime_checkpoint', 'pending_user_followups', 'webui_recovery', '_last_summary', '_stopped_at_iteration_limit', ...this.#generationExclusions]) delete current.metadata[name];
        if (current.policy.persist) await this.#repository.deleteFrom(transaction, key, true);
        await this.#save(transaction, current); return current;
      }); this.#retired.delete(key); this.#publish(committed);
    }, { signal });
  }
  delete(key: string, options: { expectedGeneration?: string; signal?: AbortSignal } = {}): Promise<boolean> {
    return this.#submit(null, async () => {
      const result = await this.#repository.driver.write(async transaction => {
        const source = await this.#load(transaction, key, false);
        if (options.expectedGeneration !== undefined && (!source || source.generation !== options.expectedGeneration)) throw new SessionConflictError('delete belongs to a replaced session');
        const rows = await this.#repository.listMetadataFrom(transaction);
        for (const transient of this.#transients.values()) rows.push({ key: transient.key, metadata: transient.metadata });
        const removed = new Set<string>(), pending = [key]; let deleted = false;
        while (pending.length) {
          const next = pending.pop()!; if (removed.has(next)) continue; removed.add(next);
          for (const row of rows) if (row.metadata.parent_session_key === next) pending.push(row.key);
          deleted = await this.#repository.deleteFrom(transaction, next) || deleted;
        }
        return { deleted, removed };
      });
      for (const removed of result.removed) { this.#transients.delete(removed); this.#snapshots.delete(removed); this.#policies.delete(removed); this.#retired.add(removed); }
      return result.deleted;
    }, { signal: options.signal });
  }
  fork(sourceKey: string, targetKey: string, beforeUserIndex: number, options: { title?: string; historyProjection?: (target: SessionRecord) => readonly HistoryFact[]; signal?: AbortSignal } = {}): Promise<SessionRecord | null> {
    return this.#submit([sourceKey, targetKey], async () => {
      const target = await this.#repository.driver.write(async transaction => {
        const source = await this.#load(transaction, sourceKey); if (!source || beforeUserIndex < 0) return null;
        const copied: ConfigObject[] = []; let user = 0;
        for (const message of source.messages) { if (message.role === 'user' && !hiddenHistory(message)) { if (user === beforeUserIndex) break; user++; } copied.push(publicHistoryMessage(message)); }
        if (user !== beforeUserIndex) return null;
        const current = newSession(targetKey); current.messages = copied; current.metadata = structuredClone(source.metadata);
        for (const name of ['_stopped_at_iteration_limit', 'parent_session_key', 'session_type', 'pending_user_turn', 'pending_user_followups', 'runtime_checkpoint', 'session_handle', 'webui_recovery', 'title', 'title_user_edited', ...this.#generationExclusions]) delete current.metadata[name];
        current.lastArchived = Math.min(source.lastArchived, copied.length);
        if (source.lastArchived > copied.length) { delete current.metadata._last_summary; current.lastArchived = 0; }
        if (options.title) current.metadata.title = options.title;
        await this.#save(transaction, current);
        if (!await this.#repository.copyHistoryPrefixTo(transaction, sourceKey, current, beforeUserIndex) && options.historyProjection) {
          const facts = [...options.historyProjection(current), new HistoryFact('fork_boundary', {}, { createdAtMs: Date.parse(current.createdAt) })];
          await this.#repository.appendHistoryTo(transaction, current.key, encodeFacts(facts).encoded, current.generation);
        }
        return current;
      }); if (!target) return null; this.#retired.delete(targetKey); this.#publish(target); return this.#draft(target);
    }, { signal: options.signal });
  }
  setArchivedKeys(keys: readonly string[], signal?: AbortSignal): Promise<string[]> {
    const frozen = [...keys]; return this.#submit(null, () => this.#repository.driver.write(transaction => this.#repository.setArchivedKeysTo(transaction, frozen)), { signal });
  }
  archivedKeys(signal?: AbortSignal): Promise<string[]> {
    return this.#submit(null, () => this.#repository.driver.read(snapshot => this.#repository.archivedKeysFrom(snapshot), signal), { signal });
  }
  close(): Promise<void> {
    if (!this.#closing) { this.#closed = true; this.#closing = (async () => { await Promise.allSettled([...this.#pending]); await this.#repository.driver.close(); })(); }
    return this.#closing;
  }
}
