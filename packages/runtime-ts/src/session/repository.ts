import { object } from '../config/decoder.ts';
import type { ConfigObject } from '../config/decoder.ts';
import { SqliteDriver } from './sqlite.ts';
import type { SqlRead, SqlWrite } from './sqlite.ts';
import { HistoryFact, HistoryReader, historyRecordSize, integer, string } from './history.ts';
import type { HistoryKind } from './history.ts';
import { DEFAULT_SESSION_POLICY, SessionConflictError, encodeJson, hiddenHistory, localTimestamp, messagePreview, metadataTitle, parseObject, providerState } from './records.ts';
import type { SessionRecord } from './records.ts';
export type SessionInfo = { key: string; createdAt: string; updatedAt: string; title: string; preview: string; path: string };
export type EncodedFact = { kind: HistoryKind; record: string; createdAtMs: number; preview: string };
export function encodeFacts(facts: readonly HistoryFact[], skipInvalid = false): { encoded: EncodedFact[]; errors: string[] } {
  const encoded: EncodedFact[] = [], errors: string[] = [];
  for (const fact of facts) {
    try {
      const record = fact.encode(), content = parseObject(record).content;
      const preview = ['input', 'answer', 'answer_segment'].includes(fact.kind) && object(content) ? messagePreview({ content: content.text ?? '' }) : '';
      encoded.push({ kind: fact.kind, record, createdAtMs: fact.createdAtMs, preview });
    } catch (error) { if (!skipInvalid || !(error instanceof Error)) throw error; errors.push(error.message); }
  }
  return { encoded, errors };
}
export class SessionRepository {
  readonly driver: SqliteDriver;
  constructor(driver: SqliteDriver) { this.driver = driver; }
  async metadataFrom(snapshot: SqlRead, key: string, raw: unknown): Promise<ConfigObject> {
    const metadata = parseObject(raw);
    const checkpoint = (await snapshot.all('SELECT record FROM checkpoints WHERE session_key=?', [key]))[0];
    if (checkpoint) metadata.runtime_checkpoint = parseObject(checkpoint.record);
    const inputs = await snapshot.all("SELECT record FROM pending_inputs WHERE session_key=? AND kind='pending_user_followups' ORDER BY position", [key]);
    if (inputs.length) metadata.pending_user_followups = inputs.map(row => parseObject(row.record));
    return metadata;
  }
  async loadFrom(snapshot: SqlRead, key: string, history = true): Promise<SessionRecord | null> {
    const row = (await snapshot.all('SELECT * FROM sessions WHERE key=?', [key]))[0]; if (!row) return null;
    const messages = history ? (await snapshot.all('SELECT record FROM messages WHERE session_key=? ORDER BY position', [key])).map(row => parseObject(row.record)) : [];
    const offset = integer(row, 'last_archived');
    return { key, createdAt: string(row, 'created_at'), updatedAt: string(row, 'updated_at'), metadata: await this.metadataFrom(snapshot, key, row.metadata), messages,
      providerState: row.provider_state === null ? null : providerState(parseObject(row.provider_state)), lastArchived: !history || offset >= 0 && offset <= messages.length ? offset : 0,
      revision: integer(row, 'revision'), generation: string(row, 'generation'), persisted: true, policy: DEFAULT_SESSION_POLICY, consumedFollowupIds: [] };
  }
  read(key: string, signal?: AbortSignal): Promise<SessionRecord | null> { return this.driver.read(snapshot => this.loadFrom(snapshot, key), signal); }
  async saveTo(transaction: SqlWrite, session: SessionRecord, messageStart = 0): Promise<void> {
    if (!Number.isInteger(messageStart) || messageStart < 0 || messageStart > session.messages.length) throw new RangeError('invalid message suffix boundary');
    const records = session.messages.slice(messageStart).map(encodeJson);
    const provider = session.providerState ? encodeJson(session.providerState) : null;
    let preview = '', fallback = '', scannedChars = 0;
    for (const message of session.messages.slice(0, 200)) {
      scannedChars += [...encodeJson(message)].length + 1; if (scannedChars > 1_000_000) break;
      if (hiddenHistory(message)) continue;
      const text = messagePreview(message);
      if (message.role === 'user' && text) { preview = text; break; }
      if (message.role === 'assistant' && !fallback) fallback = text;
    }
    preview ||= fallback;
    const lastVisible = [...session.messages].reverse().find(message => message.timestamp && !hiddenHistory(message) && ['user', 'assistant'].includes(String(message.role)))?.timestamp ?? null;
    if (lastVisible !== null && typeof lastVisible !== 'string') throw new TypeError('Invalid visible message timestamp');
    const current = (await transaction.all('SELECT revision,generation FROM sessions WHERE key=?', [session.key]))[0];
    if (!current) {
      if (session.persisted) throw new SessionConflictError('session was deleted');
      if (messageStart) throw new RangeError('a new session must include its full history');
      await transaction.run("INSERT INTO sessions (key,created_at,updated_at,metadata,provider_state,last_archived,revision,generation,title,preview,visible_updated_at) VALUES (?,?,?,'{}',NULL,0,0,?,'','',NULL)", [session.key, session.createdAt, session.updatedAt, session.generation]);
    } else if (current.revision !== session.revision || current.generation !== session.generation) throw new SessionConflictError('session history changed');
    await transaction.run('UPDATE sessions SET updated_at=?,provider_state=?,last_archived=?,revision=revision+1,preview=?,visible_updated_at=? WHERE key=?', [session.updatedAt, provider, session.lastArchived, preview, lastVisible, session.key]);
    for (const [index, record] of records.entries()) await transaction.run('INSERT INTO messages (session_key,position,record) VALUES (?,?,?) ON CONFLICT(session_key,position) DO UPDATE SET record=excluded.record WHERE messages.record!=excluded.record', [session.key, messageStart + index, record]);
    await transaction.run('DELETE FROM messages WHERE session_key=? AND position>=?', [session.key, session.messages.length]);
    await this.writeMetadataTo(transaction, session.key, session.metadata, false);
    session.revision++; session.persisted = true;
  }
  async save(session: SessionRecord, messageStart = 0, signal?: AbortSignal): Promise<void> {
    const frozen = structuredClone(session);
    await this.driver.write(transaction => this.saveTo(transaction, frozen, messageStart), signal);
    session.revision = frozen.revision; session.persisted = frozen.persisted;
  }
  async writeMetadataTo(transaction: SqlWrite, key: string, values: ConfigObject, bumpRevision = true): Promise<void> {
    const metadata = { ...values }, checkpoint = metadata.runtime_checkpoint; delete metadata.runtime_checkpoint;
    if (checkpoint == null) await transaction.run('DELETE FROM checkpoints WHERE session_key=?', [key]);
    else await transaction.run('INSERT INTO checkpoints (session_key,record) VALUES (?,?) ON CONFLICT(session_key) DO UPDATE SET record=excluded.record', [key, encodeJson(checkpoint)]);
    const inputs = metadata.pending_user_followups ?? []; delete metadata.pending_user_followups;
    if (!Array.isArray(inputs)) throw new TypeError('pending_user_followups must be a list');
    await transaction.run("DELETE FROM pending_inputs WHERE session_key=? AND kind='pending_user_followups'", [key]);
    for (const [position, record] of inputs.entries()) await transaction.run("INSERT INTO pending_inputs (session_key,kind,position,record) VALUES (?,'pending_user_followups',?,?)", [key, position, encodeJson(record)]);
    await transaction.run('UPDATE sessions SET metadata=?,title=?,revision=revision+? WHERE key=?', [encodeJson(metadata), metadataTitle(metadata), Number(bumpRevision), key]);
  }
  async deleteFrom(transaction: SqlWrite, key: string, preserveArchive = false): Promise<boolean> {
    const archived = preserveArchive ? 0 : (await transaction.run('DELETE FROM session_archives WHERE key=?', [key])).changes;
    return (await transaction.run('DELETE FROM sessions WHERE key=?', [key])).changes > 0 || archived > 0;
  }
  async listFrom(snapshot: SqlRead): Promise<SessionInfo[]> {
    return (await snapshot.all('SELECT key,created_at,updated_at,title,preview FROM sessions ORDER BY updated_at DESC')).map(row => ({ key: string(row, 'key'), createdAt: string(row, 'created_at'), updatedAt: string(row, 'updated_at'), title: string(row, 'title'), preview: string(row, 'preview'), path: this.driver.path }));
  }
  async listMetadataFrom(snapshot: SqlRead): Promise<{ key: string; metadata: ConfigObject }[]> { return (await snapshot.all('SELECT key,metadata FROM sessions ORDER BY key')).map(row => ({ key: string(row, 'key'), metadata: parseObject(row.metadata) })); }
  async appendHistoryTo(transaction: SqlWrite, key: string, encoded: readonly EncodedFact[], expectedGeneration: string | null): Promise<void> {
    const session = (await transaction.all('SELECT generation FROM sessions WHERE key=?', [key]))[0];
    if (!session || expectedGeneration !== null && session.generation !== expectedGeneration) throw new SessionConflictError('history belongs to a deleted or replaced session');
    await transaction.run('INSERT OR IGNORE INTO history_heads (session_key) VALUES (?)', [key]);
    const tail = (await transaction.all('SELECT ordinal,record_count,completed FROM history_turns WHERE session_key=? ORDER BY ordinal DESC LIMIT 1', [key]))[0];
    let ordinal = tail ? integer(tail, 'ordinal') : 0, position = tail ? integer(tail, 'record_count') : 0, completed = !!tail?.completed, appended = false;
    for (const { kind, record, createdAtMs, preview } of encoded) {
      if (kind === 'input' && (await transaction.all("SELECT 1 FROM history_entries WHERE session_key=? AND kind='input' AND json_extract(record,'$.content.input_id')=json_extract(?,'$.content.input_id') LIMIT 1", [key, record])).length) continue;
      appended = true; if (completed) { ordinal++; position = 0; }
      if (!position) await transaction.run('INSERT INTO history_turns VALUES (?,?,0,0,0,0)', [key, ordinal]);
      await transaction.run('INSERT INTO history_entries VALUES (?,?,?,?,?)', [key, ordinal, position, kind, record]);
      completed = kind === 'completion';
      await transaction.run('UPDATE history_turns SET record_count=record_count+1,byte_count=byte_count+?,user_count=user_count+?,completed=? WHERE session_key=? AND ordinal=?', [historyRecordSize(record), Number(kind === 'input'), Number(completed), key, ordinal]); position++;
      if (preview) { const field = kind === 'input' ? 'user_preview' : 'preview'; await transaction.run(`UPDATE history_heads SET ${field}=? WHERE session_key=? AND ${field}=''`, [preview, key]); }
      await transaction.run('UPDATE history_heads SET updated_at_ms=max(updated_at_ms,?) WHERE session_key=?', [createdAtMs, key]);
    }
    if (appended) await transaction.run('UPDATE history_heads SET revision=revision+1 WHERE session_key=?', [key]);
  }
  async copyHistoryPrefixTo(transaction: SqlWrite, sourceKey: string, target: SessionRecord, beforeInput: number): Promise<boolean> {
    const reader = new HistoryReader(transaction, sourceKey), revision = await reader.revision();
    if (!revision || revision[1] < 0) return false;
    const copied: HistoryFact[] = []; let inputs = 0, boundary = false;
    for (const fact of await reader.allFacts()) {
      if (fact.kind === 'fork_boundary') continue;
      if (fact.kind === 'input') { if (inputs === beforeInput) { boundary = true; break; } inputs++; }
      copied.push(fact);
    }
    if (!boundary && inputs !== beforeInput) return false;
    copied.push(new HistoryFact('fork_boundary', {}, { createdAtMs: Date.parse(target.createdAt) }));
    await this.appendHistoryTo(transaction, target.key, encodeFacts(copied).encoded, target.generation); return true;
  }
  async archivedKeysFrom(snapshot: SqlRead): Promise<string[]> { return (await snapshot.all('SELECT key FROM session_archives ORDER BY key')).map(row => string(row, 'key')); }
  async setArchivedKeysTo(transaction: SqlWrite, keys: readonly string[]): Promise<string[]> {
    const existing = new Set(await this.archivedKeysFrom(transaction));
    const present = new Set((await transaction.all('SELECT key FROM sessions WHERE key IN (SELECT value FROM json_each(?))', [encodeJson(keys)])).map(row => string(row, 'key')));
    const target = new Set(keys.filter(key => existing.has(key) || present.has(key)));
    for (const key of existing) if (!target.has(key)) await transaction.run('DELETE FROM session_archives WHERE key=?', [key]);
    for (const key of target) if (!existing.has(key)) await transaction.run('INSERT INTO session_archives VALUES (?,?)', [key, localTimestamp()]);
    return [...target].sort();
  }
}
