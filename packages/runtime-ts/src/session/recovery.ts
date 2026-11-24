import { randomUUID } from 'node:crypto';
import { InboundMessage } from '../bus/events.ts';
import { object } from '../config/decoder.ts';
import type { ConfigObject, Json } from '../config/decoder.ts';
import { encodeJson, equal, localTimestamp } from './records.ts';
import type { SessionRecord } from './records.ts';
export const UNCERTAIN_TOOL_PHASES: ReadonlySet<string> = new Set(['awaiting_tools']);
export const KNOWN_CHECKPOINT_PHASES: ReadonlySet<string> = new Set(['model_input', 'final_response', 'tools_completed', 'awaiting_tools', 'error']);
const receivedTimes = new WeakMap<InboundMessage, { epoch: number; iso: string }>();
const truthy = (value: Json | undefined) => Array.isArray(value) ? value.length > 0 : object(value) ? Object.keys(value).length > 0 : !!value;
function timestamp(message: InboundMessage): string {
  const saved = receivedTimes.get(message); if (saved && saved.epoch === message.timestamp.getTime()) return saved.iso;
  const offset = -message.timestamp.getTimezoneOffset(), sign = offset < 0 ? '-' : '+', absolute = Math.abs(offset);
  return `${localTimestamp(message.timestamp)}${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}
function envelope(metadata: ConfigObject): ConfigObject | null {
  const raw = metadata._session_message; if (!object(raw)) return null;
  const { message_id, created_at_ms, expect_reply, source_handle, source_session_key, target_session_key } = raw;
  if (typeof message_id !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(message_id) || typeof created_at_ms !== 'number' || !Number.isInteger(created_at_ms) || created_at_ms < 0 || typeof expect_reply !== 'boolean' || typeof source_handle !== 'string' || !/^[a-z]{4,16}$/.test(source_handle.trim().replace(/^@/, '').toLowerCase()) || typeof source_session_key !== 'string' || !source_session_key.trim() || source_session_key.trim().length > 512 || typeof target_session_key !== 'string' || !target_session_key.trim() || target_session_key.trim().length > 512) return null;
  return { message_id, created_at_ms, expect_reply, source_handle: source_handle.trim().replace(/^@/, '').toLowerCase(), source_session_key: source_session_key.trim(), target_session_key: target_session_key.trim() };
}
export function isSessionMessageInput(message: InboundMessage): boolean {
  return message.channel === 'system' && message.isUserInput && envelope(message.metadata)?.target_session_key === message.sessionKey;
}
export function cloneRecoveryInbound(message: InboundMessage): InboundMessage {
  const copy = new InboundMessage(structuredClone(message)), saved = receivedTimes.get(message);
  if (saved) receivedTimes.set(copy, saved); return copy;
}
function followups(session: Pick<SessionRecord, 'metadata'>): ConfigObject[] {
  const raw = session.metadata.pending_user_followups; return Array.isArray(raw) ? raw.filter(object) : [];
}
export function recordPendingFollowup(session: SessionRecord, message: InboundMessage): string | null {
  if (message.channel !== 'websocket' && !isSessionMessageInput(message)) return null;
  let metadata: ConfigObject;
  try { const raw: unknown = JSON.parse(encodeJson(message.metadata)); if (!object(raw)) return null; metadata = raw; } catch { return null; }
  const existing = metadata._recovery_followup_id; delete metadata._recovery_followup_id;
  const id = typeof existing === 'string' && existing ? existing : randomUUID().replaceAll('-', '');
  const records = followups(session); if (records.some(record => record.id === id)) return id;
  records.push({ id, sender_id: message.senderId, chat_id: message.chatId, content: message.content, timestamp: timestamp(message), media: [...message.media], metadata });
  session.metadata.pending_user_followups = records; session.updatedAt = localTimestamp(); return id;
}
export function pendingFollowups(session: SessionRecord): InboundMessage[] {
  const messages: InboundMessage[] = [];
  for (const record of followups(session)) {
    const { id, sender_id, chat_id, content, metadata } = record;
    if (typeof id !== 'string' || !id || typeof sender_id !== 'string' || !sender_id || typeof chat_id !== 'string' || !chat_id || typeof content !== 'string' || !object(metadata)) continue;
    const time = typeof record.timestamp === 'string' ? new Date(record.timestamp) : new Date(); if (!Number.isFinite(time.getTime())) throw new Error('Invalid persisted follow-up timestamp');
    const isInput = envelope(metadata)?.target_session_key === session.key;
    const message = new InboundMessage({ channel: isInput ? 'system' : 'websocket', inputRole: isInput ? 'user' : null, senderId: sender_id, chatId: chat_id, content, timestamp: time,
      media: Array.isArray(record.media) ? record.media.filter((value): value is string => typeof value === 'string') : [], metadata: { ...metadata, _recovery_followup_id: id }, sessionKeyOverride: session.key, requireExistingSession: true });
    if (typeof record.timestamp === 'string') receivedTimes.set(message, { epoch: time.getTime(), iso: record.timestamp }); messages.push(message);
  }
  return messages;
}
export function acknowledgePendingFollowups(session: Pick<SessionRecord, 'metadata'>, ids: readonly string[]): void {
  if (!ids.length) return; const consumed = new Set(ids), remaining = followups(session).filter(row => typeof row.id !== 'string' || !consumed.has(row.id));
  if (remaining.length) session.metadata.pending_user_followups = remaining; else delete session.metadata.pending_user_followups;
}
export function requestOriginFromMetadata(metadata: ConfigObject): { message_id: string | null; turn_id: string } | null {
  const value = metadata.request_origin;
  if (!object(value) || value.message_id != null && typeof value.message_id !== 'string' || typeof value.turn_id !== 'string' || !value.turn_id) return null;
  return { message_id: typeof value.message_id === 'string' ? value.message_id : null, turn_id: value.turn_id };
}
function toolIds(value: Json | undefined, results = false): string[] | null {
  if (!Array.isArray(value)) return null; const ids: string[] = [];
  for (const row of value) {
    if (!object(row)) return null; const id = row[results ? 'tool_call_id' : 'id'];
    if (typeof id !== 'string' || !id || (results ? row.role !== 'tool' : !object(row.function) || typeof row.function.name !== 'string' || !row.function.name)) return null;
    ids.push(id);
  }
  return new Set(ids).size === ids.length ? ids : null;
}
function completePrefix(value: Json): boolean {
  if (!Array.isArray(value)) return false; const pending = new Set<string>();
  for (const row of value) {
    if (!object(row)) return false;
    if (row.role === 'tool') { if (typeof row.tool_call_id !== 'string' || !pending.delete(row.tool_call_id)) return false; }
    else if (row.role === 'user' || row.role === 'assistant') {
      if (pending.size) return false;
      if (row.role === 'assistant' && row.tool_calls != null) { const ids = toolIds(row.tool_calls); if (!ids) return false; for (const id of ids) pending.add(id); }
    } else return false;
  }
  return pending.size === 0;
}
export function runtimeCheckpointIsWellFormed(checkpoint: ConfigObject): boolean {
  if (!completePrefix(Object.hasOwn(checkpoint, 'preceding_messages') ? checkpoint.preceding_messages : [])) return false;
  if (checkpoint.phase === 'model_input') return checkpoint.provider_state_checkpoint_version === 'v1' && checkpoint.assistant_message == null && equal(checkpoint.completed_tool_results, []) && equal(checkpoint.pending_tool_calls, []);
  const assistant = checkpoint.assistant_message; if (!object(assistant) || assistant.role !== 'assistant') return false;
  const completed = toolIds(checkpoint.completed_tool_results, true), pending = toolIds(checkpoint.pending_tool_calls), calls = assistant.tool_calls == null ? [] : toolIds(assistant.tool_calls);
  if (!completed || !pending || !calls) return false;
  if (checkpoint.phase === 'final_response') return typeof assistant.content === 'string' && /[^\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(assistant.content) && !calls.length && !completed.length && !pending.length;
  const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));
  if (checkpoint.phase === 'awaiting_tools') return calls.length > 0 && !completed.length && sameIds(calls, pending);
  if (checkpoint.phase === 'tools_completed') return calls.length > 0 && !pending.length && sameIds(calls, completed);
  return false;
}
export function persistedMessage(message: ConfigObject): ConfigObject {
  const entry = { ...message }, metadata = entry._meta; delete entry._meta; if (!object(metadata)) return entry;
  if (entry.role === 'user') {
    if (Object.hasOwn(metadata, 'input_id')) entry.input_id = metadata.input_id;
    for (const key of ['timestamp', 'webui_turn_id']) if (typeof metadata[key] === 'string' && metadata[key]) entry[key] = metadata[key];
    for (const key of ['media', 'local_media_paths']) { const value = metadata[key]; if (Array.isArray(value)) entry[key] = value.filter((item): item is string => typeof item === 'string'); }
    if (object(metadata.session_message)) entry.session_message = metadata.session_message;
    if (object(metadata.runtime_context)) entry._runtime_context = metadata.runtime_context;
  } else if (entry.role === 'assistant' && Object.hasOwn(metadata, 'response_input_ids')) entry.response_input_ids = metadata.response_input_ids;
  return entry;
}
function messageKey(message: ConfigObject): Json[] { return ['role', 'content', 'tool_call_id', 'name', 'tool_calls', 'reasoning_content', 'thinking_blocks'].map(key => message[key] ?? null); }
export function restoreRuntimeCheckpoint(session: SessionRecord): boolean {
  const checkpoint = session.metadata.runtime_checkpoint; if (!object(checkpoint)) return false;
  const assistant = checkpoint.assistant_message, completed = Array.isArray(checkpoint.completed_tool_results) ? checkpoint.completed_tool_results : [], pending = Array.isArray(checkpoint.pending_tool_calls) ? checkpoint.pending_tool_calls : [];
  const rows: ConfigObject[] = Array.isArray(checkpoint.preceding_messages) ? checkpoint.preceding_messages.filter(object).map(row => ({ ...row })) : [];
  const timed = (row: ConfigObject): ConfigObject => Object.hasOwn(row, 'timestamp') ? { ...row } : { ...row, timestamp: localTimestamp() };
  if (object(assistant) && assistant.role === 'assistant') rows.push(timed(assistant));
  for (const row of completed) if (object(row) && row.role === 'tool') rows.push(timed(row));
  for (const call of pending) if (object(call) && typeof call.id === 'string' && call.id) rows.push({ role: 'tool', tool_call_id: call.id, name: object(call.function) && typeof call.function.name === 'string' && call.function.name ? call.function.name : 'tool', content: "Error: Task interrupted; this tool's outcome is unknown. Check its effects before retrying.", timestamp: localTimestamp(), _recovery_interrupted: true });
  const restored = rows.map(persistedMessage); let overlap = 0;
  if (!Object.hasOwn(checkpoint, 'preceding_messages')) for (let size = Math.min(session.messages.length, restored.length); size > 0; size--) {
    if (session.messages.slice(-size).every((message, index) => equal(messageKey(message), messageKey(restored[index])))) { overlap = size; break; }
  }
  session.messages.push(...structuredClone(restored.slice(overlap)));
  if (Array.isArray(checkpoint.consumed_followup_ids)) session.consumedFollowupIds = [...new Set([...session.consumedFollowupIds, ...checkpoint.consumed_followup_ids.filter((id): id is string => typeof id === 'string')])];
  const synchronized = checkpoint.provider_state_checkpoint_version === 'v1', isAssistant = object(assistant) && assistant.role === 'assistant';
  const exactFinal = checkpoint.phase === 'final_response' && isAssistant && !truthy(checkpoint.completed_tool_results) && !truthy(checkpoint.pending_tool_calls);
  const exactTools = checkpoint.phase === 'tools_completed' && isAssistant && !truthy(checkpoint.pending_tool_calls);
  if (!(synchronized && (exactFinal || exactTools || checkpoint.phase === 'model_input' && runtimeCheckpointIsWellFormed(checkpoint)))) session.providerState = null;
  delete session.metadata.pending_user_turn; delete session.metadata.runtime_checkpoint; session.updatedAt = localTimestamp(); return true;
}
export function discardRuntimeCheckpoint(session: SessionRecord): boolean {
  if (!Object.hasOwn(session.metadata, 'runtime_checkpoint')) return false;
  delete session.metadata.runtime_checkpoint; session.providerState = null; session.updatedAt = localTimestamp(); return true;
}
export function restorePendingInterruption(session: SessionRecord, superseded = false): boolean {
  if (!truthy(session.metadata.pending_user_turn)) return false;
  if (session.messages.at(-1)?.role === 'user') { session.messages.push({ role: 'assistant', content: superseded ? 'Task recovery was superseded by a newer message.' : 'Error: Task interrupted before a response was generated.', timestamp: localTimestamp(), _recovery_interrupted: true }); session.providerState = null; session.updatedAt = localTimestamp(); }
  delete session.metadata.pending_user_turn; return true;
}
export function appendRecoveryInterruption(session: SessionRecord, superseded = false): void {
  if (session.messages.at(-1)?._recovery_interrupted === true) return;
  session.messages.push({ role: 'assistant', content: superseded ? 'Task recovery was superseded by a newer message.' : 'Error: Task recovery was interrupted before completion.', timestamp: localTimestamp(), _recovery_interrupted: true }); session.providerState = null; session.updatedAt = localTimestamp();
}
export function recoveryStateFromMetadata(metadata: ConfigObject | null): ConfigObject | null {
  const state = metadata?.webui_recovery;
  if (!object(state) || typeof state.status !== 'string' || !['resuming', 'awaiting_user', 'recovered', 'failed'].includes(state.status) || typeof state.recovery_id !== 'string') return null;
  const result: ConfigObject = { status: state.status, recovery_id: state.recovery_id };
  if (typeof state.reason === 'string' && state.reason) result.reason = state.reason;
  if (typeof state.attempts === 'boolean' || typeof state.attempts === 'number' && Number.isInteger(state.attempts) && state.attempts >= 0) result.attempts = state.attempts;
  if (typeof state.can_continue === 'boolean') result.can_continue = state.can_continue;
  if (typeof state.failure_error_kind === 'string' && ['authentication', 'billing', 'connection', 'timeout', 'rate_limit', 'server', 'unknown', 'unsupported_image', 'image_request_rejected'].includes(state.failure_error_kind)) result.failure_error_kind = state.failure_error_kind;
  if (state.reply_preserved === true) result.reply_preserved = true; return result;
}
