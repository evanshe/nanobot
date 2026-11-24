import { object } from '../config/decoder.ts';
import type { ConfigObject, Json } from '../config/decoder.ts';
import type { SqlRead, SqlRow } from './sqlite.ts';
import { encodeJson, parseObject } from './records.ts';
export const HISTORY_KINDS = ['input', 'answer', 'answer_segment', 'reasoning', 'reasoning_segment', 'progress', 'tool_activity', 'file_activity', 'completion', 'fork_boundary', 'compaction', 'model_request', 'answer_fragment', 'reasoning_fragment'] as const;
export type HistoryKind = typeof HISTORY_KINDS[number];
export const MAX_HISTORY_FACT_BYTES = 8 * 1024 * 1024;
export function integer(row: SqlRow, key: string): number {
  const value = row[key]; if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new TypeError(`Invalid stored integer ${key}`); return value;
}
export function string(row: SqlRow, key: string): string {
  const value = row[key]; if (typeof value !== 'string') throw new TypeError(`Invalid stored string ${key}`); return value;
}
function sizeAdjustment(content: ConfigObject): number {
  const graph = content.context_graph;
  const values: (Json | undefined)[] = object(graph) && graph.kind === 'context_graph_parts' ? [graph.stage, graph.system, graph.reads] : [graph];
  if (object(content.context_snapshot)) values.push(content.context_snapshot.graph);
  let adjustment = 0;
  for (const value of values) if (typeof value === 'string' && value.startsWith('graph-columns-v1:')) {
    const text = value.slice('graph-columns-v1:'.length).split(':')[0];
    const size = /^\d+$/.test(text) ? Number(text) : -1;
    if (size >= 0 && size <= MAX_HISTORY_FACT_BYTES) adjustment += size - value.length - 2;
  }
  return adjustment;
}
export class HistoryFact {
  readonly kind: HistoryKind;
  readonly content: ConfigObject;
  readonly turnId: string | null;
  readonly phase: string | null;
  readonly sequence: number | null;
  readonly createdAtMs: number;
  constructor(kind: HistoryKind, content: ConfigObject = {}, options: { turnId?: string | null; phase?: string | null; sequence?: number | null; createdAtMs?: number } = {}) {
    this.kind = kind; this.content = content; this.turnId = options.turnId ?? null; this.phase = options.phase ?? null; this.sequence = options.sequence ?? null; this.createdAtMs = options.createdAtMs ?? 0;
  }
  encode(): string {
    // Inline graph JSON is also a supported Python storage form. Already
    // compressed Python graphs retain their logical replay-byte accounting.
    const payload: ConfigObject = { kind: this.kind, content: this.content, turn_id: this.turnId, phase: this.phase, sequence: this.sequence, created_at_ms: this.createdAtMs };
    let record = encodeJson(payload);
    const stored = Buffer.byteLength(record), adjustment = sizeAdjustment(this.content), logical = stored + adjustment;
    if (Math.max(stored, logical) > MAX_HISTORY_FACT_BYTES) throw new RangeError('history fact exceeds the 8 MiB storage limit');
    if (adjustment) { payload.uncompressed_bytes = logical; record = encodeJson(payload); if (Buffer.byteLength(record) > MAX_HISTORY_FACT_BYTES) throw new RangeError('history fact exceeds the 8 MiB storage limit'); }
    return record;
  }
  static decode(record: unknown): HistoryFact {
    const value = parseObject(record);
    if (typeof value.kind !== 'string' || !HISTORY_KINDS.some(kind => kind === value.kind) || !object(value.content)) throw new TypeError('Invalid stored history fact');
    if (value.turn_id !== null && typeof value.turn_id !== 'string' || value.phase !== null && typeof value.phase !== 'string' || value.sequence !== null && (typeof value.sequence !== 'number' || !Number.isInteger(value.sequence)) || typeof value.created_at_ms !== 'number' || !Number.isSafeInteger(value.created_at_ms)) throw new TypeError('Invalid stored history fact identity');
    // The membership check above owns the dynamic HistoryKind boundary.
    return new HistoryFact(value.kind as HistoryKind, value.content, { turnId: value.turn_id, phase: value.phase, sequence: value.sequence, createdAtMs: value.created_at_ms });
  }
}
export function historyRecordSize(record: string): number {
  const stored = Buffer.byteLength(record); if (!record.includes('"uncompressed_bytes":')) return stored;
  const size = parseObject(record).uncompressed_bytes;
  return typeof size === 'number' && Number.isInteger(size) && size >= 0 && size <= MAX_HISTORY_FACT_BYTES ? size : stored;
}
export type HistoryTurn = { ordinal: number; recordCount: number; byteCount: number; userCount: number };
export class HistoryReader {
  readonly key: string;
  readonly #snapshot: SqlRead;
  constructor(snapshot: SqlRead, key: string) { this.#snapshot = snapshot; this.key = key; }
  async revision(): Promise<readonly [string, number] | null> {
    const rows = await this.#snapshot.all('SELECT sessions.generation, coalesce(history_heads.revision,-1) AS revision FROM sessions LEFT JOIN history_heads ON history_heads.session_key=sessions.key WHERE sessions.key=?', [this.key]);
    return rows[0] ? [string(rows[0], 'generation'), integer(rows[0], 'revision')] : null;
  }
  async turnCount(): Promise<number> { return integer((await this.#snapshot.all('SELECT coalesce(max(ordinal)+1,0) AS count FROM history_turns WHERE session_key=?', [this.key]))[0], 'count'); }
  async turns(options: { before?: number; after?: number; reverse?: boolean } = {}): Promise<HistoryTurn[]> {
    const upper = options.before ?? await this.turnCount(), order = options.reverse ? 'DESC' : 'ASC';
    return (await this.#snapshot.all(`SELECT ordinal, record_count, byte_count, user_count FROM history_turns WHERE session_key=? AND ordinal>=? AND ordinal<? ORDER BY ordinal ${order}`, [this.key, options.after ?? 0, upper])).map(row => ({ ordinal: integer(row, 'ordinal'), recordCount: integer(row, 'record_count'), byteCount: integer(row, 'byte_count'), userCount: integer(row, 'user_count') }));
  }
  async readEntries(ordinal: number): Promise<[number, HistoryFact][]> {
    return (await this.#snapshot.all('SELECT position,record FROM history_entries WHERE session_key=? AND turn_ordinal=? ORDER BY position', [this.key, ordinal])).map(row => [integer(row, 'position'), HistoryFact.decode(row.record)]);
  }
  async allFacts(): Promise<HistoryFact[]> { return (await this.#snapshot.all('SELECT record FROM history_entries WHERE session_key=? ORDER BY turn_ordinal,position', [this.key])).map(row => HistoryFact.decode(row.record)); }
  async readEntryPage(ordinal: number, options: { start: number; end: number; reverse: boolean; maxRecords: number; maxBytes: number; allowOversized?: boolean }): Promise<{ entries: [number, HistoryFact][]; sourceBytes: number }> {
    const rows = await this.#snapshot.all(`SELECT position,max(length(CAST(record AS BLOB)),coalesce(json_extract(record,'$.uncompressed_bytes'),0)) AS size FROM history_entries WHERE session_key=? AND turn_ordinal=? AND position>=? AND position<? ORDER BY position ${options.reverse ? 'DESC' : 'ASC'} LIMIT ?`, [this.key, ordinal, options.start, options.end, options.maxRecords]);
    const positions: number[] = []; let used = 0;
    for (const row of rows) {
      const size = integer(row, 'size'); if (used + size > options.maxBytes && (positions.length || !options.allowOversized)) break;
      positions.push(integer(row, 'position')); used += size; if (used >= options.maxBytes) break;
    }
    if (!positions.length) return { entries: [], sourceBytes: 0 };
    const entries = await this.#snapshot.all('SELECT position,record FROM history_entries WHERE session_key=? AND turn_ordinal=? AND position>=? AND position<? ORDER BY position', [this.key, ordinal, Math.min(...positions), Math.max(...positions) + 1]);
    return { entries: entries.map(row => [integer(row, 'position'), HistoryFact.decode(row.record)]), sourceBytes: used };
  }
  async latestContextUsage(generation: string): Promise<readonly [number, number, boolean] | null> {
    const revision = await this.revision(); if (!revision || revision[0] !== generation) return null;
    const rows = await this.#snapshot.all("SELECT kind,json_extract(record,'$.content.phase') AS phase,coalesce(json_extract(record,'$.content.request_usage.context_tokens'),json_extract(record,'$.content.request_usage.prompt_tokens')) AS tokens,json_extract(record,'$.content.context_window_tokens') AS window,json_extract(record,'$.content.context_snapshot.estimated_tokens') AS estimate,json_extract(record,'$.content.context_snapshot.context_window_tokens') AS estimate_window FROM history_entries WHERE session_key=? AND kind IN ('model_request','compaction') ORDER BY turn_ordinal DESC,position DESC", [this.key]);
    const count = (value: unknown, positive = false): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= (positive ? 1 : 0);
    for (const row of rows) {
      if (row.kind === 'compaction' && row.phase === 'succeeded') return count(row.estimate) && count(row.estimate_window, true) ? [row.estimate, row.estimate_window, true] : null;
      if (count(row.tokens) && count(row.window, true)) return [row.tokens, row.window, false];
    }
    return null;
  }
  async openTailSequences(): Promise<Record<string, number>> {
    const ordinal = await this.turnCount() - 1;
    const last = (await this.#snapshot.all('SELECT kind FROM history_entries WHERE session_key=? AND turn_ordinal=? ORDER BY position DESC LIMIT 1', [this.key, ordinal]))[0];
    if (!last || last.kind === 'completion') return {};
    const rows = await this.#snapshot.all("SELECT json_extract(record,'$.turn_id') AS id,max(coalesce(json_extract(record,'$.sequence'),0)) AS sequence FROM history_entries WHERE session_key=? AND turn_ordinal=? GROUP BY id ORDER BY min(position)", [this.key, ordinal]);
    return Object.fromEntries(rows.filter(row => typeof row.id === 'string' && row.id).map(row => [string(row, 'id'), integer(row, 'sequence')]));
  }
  async userCountBefore(ordinal: number, position = 0): Promise<number> {
    const earlier = integer((await this.#snapshot.all('SELECT coalesce(sum(user_count),0) AS count FROM history_turns WHERE session_key=? AND ordinal<?', [this.key, ordinal]))[0], 'count');
    return position ? earlier + integer((await this.#snapshot.all("SELECT count(*) AS count FROM history_entries WHERE session_key=? AND turn_ordinal=? AND position<? AND kind='input'", [this.key, ordinal, position]))[0], 'count') : earlier;
  }
  async hasInput(inputId: string): Promise<boolean> { return (await this.#snapshot.all("SELECT 1 FROM history_entries WHERE session_key=? AND kind='input' AND json_extract(record,'$.content.input_id')=? LIMIT 1", [this.key, inputId])).length > 0; }
  async hasMissingInputReferences(ordinal: number): Promise<boolean> {
    return (await this.#snapshot.all("SELECT 1 FROM history_entries AS answer,json_each(answer.record,'$.content.response_input_ids') AS reference WHERE answer.session_key=? AND answer.turn_ordinal=? AND answer.kind IN ('answer','answer_segment','answer_fragment') AND reference.type='text' AND reference.value!='' AND NOT EXISTS(SELECT 1 FROM history_entries AS input WHERE input.session_key=answer.session_key AND input.kind='input' AND json_extract(input.record,'$.content.input_id')=reference.value) LIMIT 1", [this.key, ordinal])).length > 0;
  }
  async uniqueUserPosition(ordinal: number): Promise<number | null> {
    const rows = await this.#snapshot.all("SELECT position FROM history_entries WHERE session_key=? AND turn_ordinal=? AND kind='input' ORDER BY position LIMIT 2", [this.key, ordinal]);
    return rows.length === 1 ? integer(rows[0], 'position') : null;
  }
  async incompleteCompletionMarker(ordinal: number, position: number): Promise<boolean> {
    const row = (await this.#snapshot.all("SELECT json_type(record,'$.content.transcript_incomplete') AS marker FROM history_entries WHERE session_key=? AND turn_ordinal=? AND position=? AND kind='completion'", [this.key, ordinal, position]))[0]; return row?.marker === 'true';
  }
  async hasNavigationAnswer(ordinal: number): Promise<boolean> { return (await this.#snapshot.all("SELECT 1 FROM history_entries WHERE session_key=? AND turn_ordinal=? AND kind IN ('answer','answer_segment','answer_fragment') LIMIT 1", [this.key, ordinal])).length > 0; }
  async navigation(): Promise<[number, number, HistoryFact][]> {
    return (await this.#snapshot.all("SELECT turn_ordinal,position,record FROM history_entries WHERE session_key=? AND kind IN ('input','answer','answer_segment','answer_fragment','completion') ORDER BY turn_ordinal,position", [this.key])).map(row => [integer(row, 'turn_ordinal'), integer(row, 'position'), HistoryFact.decode(row.record)]);
  }
}
