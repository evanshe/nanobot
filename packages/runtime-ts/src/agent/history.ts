import { createHash } from 'node:crypto';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { object } from '../config/decoder.ts';
import type { ConfigObject, Json } from '../config/decoder.ts';
import { hiddenHistory, publicHistoryMessage } from '../session/records.ts';
import type { SessionRecord } from '../session/records.ts';
import { atomicPrivateWrite } from '../session/files.ts';
import { pythonJson, SUMMARY_CONTINUATION } from './requests.ts';
import { stripPythonWhitespace } from './skills.ts';
export async function persistUserImages(content: readonly Json[], dataDirectory: string): Promise<Json[]> {
  const result: Json[] = [];
  for (const value of content) {
    const url = object(value) && object(value.image_url) ? value.image_url.url : null;
    if (!object(value) || value.type !== 'image_url' || typeof url !== 'string' || !url.startsWith('data:image/')) { result.push(structuredClone(value)); continue; }
    if (/[^\x00-\x7f]/.test(url)) throw new TypeError('Inline image data must be ASCII');
    const id = createHash('sha256').update(url, 'ascii').digest('hex'), directory = join(dataDirectory, 'session-images'), path = join(directory, id);
    let exists = false; try { exists = (await stat(path)).isFile(); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (!exists) { await mkdir(directory, { recursive: true, mode: 0o700 }); await atomicPrivateWrite(path, url); }
    result.push({ type: 'image_attachment', id });
  }
  return result;
}
export async function replayUserImages(content: readonly Json[], dataDirectory: string, signal?: AbortSignal): Promise<Json[]> {
  const result: Json[] = [];
  for (const value of content) {
    signal?.throwIfAborted();
    if (object(value) && value.type === 'image_attachment') {
      let url: string | null = null;
      if (typeof value.id === 'string' && /^[0-9a-f]{64}$/.test(value.id)) try {
        const raw = await readFile(join(dataDirectory, 'session-images', value.id), { signal });
        if (raw.subarray(0, 11).toString() === 'data:image/' && !raw.some(byte => byte > 127) && createHash('sha256').update(raw).digest('hex') === value.id) url = raw.toString('ascii');
      } catch (error) { signal?.throwIfAborted(); if (!(error instanceof Error && 'code' in error)) throw error; }
      result.push(url === null ? { type: 'text', text: '[Previous image unavailable]' } : { type: 'image_url', image_url: { url }, _meta: { replayed_user_image: true } });
    } else if (object(value) && value.type === 'image_url') result.push({ ...structuredClone(value), _meta: { replayed_user_image: true } });
    else result.push(structuredClone(value));
  }
  return result;
}
function legalStart(messages: readonly ConfigObject[]): number {
  const declared = new Set<string>(); let start = 0;
  for (const [index, message] of messages.entries()) {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) { for (const call of message.tool_calls) if (object(call) && call.id) declared.add(String(call.id)); }
    else if (message.role === 'tool' && message.tool_call_id && !declared.has(String(message.tool_call_id))) { start = index + 1; declared.clear(); }
  }
  return start;
}
export function estimateAgentMessageBytes(message: ConfigObject): number {
  const parts: string[] = [], content = message.content;
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) for (const block of content) {
    if (object(block) && block.type === 'text') { if (typeof block.text === 'string' && block.text) parts.push(block.text); }
    else parts.push(pythonJson(block));
  } else if (content !== null && content !== undefined) parts.push(pythonJson(content));
  for (const key of ['name', 'tool_call_id']) if (typeof message[key] === 'string' && message[key]) parts.push(message[key]);
  if (message.tool_calls) parts.push(pythonJson(message.tool_calls));
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) parts.push(message.reasoning_content);
  return Math.max(4, Buffer.byteLength(parts.join('\n')) + 4);
}
export type AgentHistoryOptions = { dataDirectory: string; maxMessages?: number; maxTokens?: number; extendToUser?: boolean; includeRuntimeContext?: boolean; view?: 'model' | 'text' | 'public'; estimateMessageTokens?: (message: ConfigObject) => number; signal?: AbortSignal };
export async function sessionModelHistory(session: SessionRecord, options: AgentHistoryOptions): Promise<ConfigObject[]> {
  const replayable = session.messages.slice(session.lastArchived), max = options.maxMessages ?? 0; let start = max > 0 ? Math.max(0, replayable.length - max) : 0;
  if (max > 0 && options.extendToUser && replayable.length > max && !replayable.slice(start).some(message => message.role === 'user')) {
    for (let index = start - 1; index >= 0; index--) if (replayable[index].role === 'user') { start = index > 0 && replayable[index - 1]._channel_delivery ? index - 1 : index; break; }
  }
  let sliced = replayable.slice(start);
  const firstUser = sliced.findIndex(message => message.role === 'user'); if (firstUser >= 0) sliced = sliced.slice(firstUser > 0 && sliced[firstUser - 1]._channel_delivery ? firstUser - 1 : firstUser);
  sliced = sliced.slice(legalStart(sliced));
  const view = options.includeRuntimeContext === false ? 'public' : options.view ?? 'model', includeContext = view !== 'public', result: ConfigObject[] = [];
  for (const source of sliced) {
    if (source._command || hiddenHistory(source) && source.content === SUMMARY_CONTINUATION) continue;
    const hasContext = object(source._runtime_context), message = includeContext ? source : publicHistoryMessage(source); let content = message.content ?? '';
    if (message.role === 'user' && view !== 'model' && Array.isArray(content)) content = content.map(block => object(block) && ['image_url', 'image_attachment'].includes(String(block.type)) ? { type: 'text', text: '[image]' } : block);
    if (includeContext && !hasContext && message.role === 'user' && Array.isArray(message.cli_apps) && message.cli_apps.length && typeof content === 'string') {
      const lines = message.cli_apps.slice(0, 8).filter(object).map(item => {
        const name = stripPythonWhitespace(String(item.name || '')).toLowerCase(), entry = stripPythonWhitespace(String(item.entry_point || 'unknown')) || 'unknown';
        return name ? `[CLI App Attachment: @${name}; tool=run_cli_app; entry_point=${entry}; skill=skills/cli-app-${name}/SKILL.md]` : '';
      }).filter(Boolean); if (lines.length) content = content ? `${content}\n${lines.join('\n')}` : lines.join('\n');
    }
    if (message.role === 'assistant' && typeof content === 'string' && !stripPythonWhitespace(content) && !['tool_calls', 'reasoning_content', 'thinking_blocks'].some(key => Object.hasOwn(message, key))) continue;
    const entry: ConfigObject = { role: message.role, content: structuredClone(content) };
    if (includeContext && Object.hasOwn(message, 'input_id') && !hiddenHistory(message)) entry._meta = { input_id: message.input_id };
    if (includeContext && object(message._hidden_history) && message._hidden_history.kind === 'internal_continuation') entry._hidden_history = { kind: 'internal_continuation' };
    for (const key of ['tool_calls', 'tool_call_id', 'name', 'reasoning_content', 'thinking_blocks']) if (Object.hasOwn(message, key)) entry[key] = structuredClone(message[key]);
    result.push(entry);
  }
  let selected = result;
  if ((options.maxTokens ?? 0) > 0 && selected.length) {
    const kept: ConfigObject[] = []; let used = 0;
    for (const message of [...selected].reverse()) { const tokens = (options.estimateMessageTokens ?? estimateAgentMessageBytes)(message); if (kept.length && used + tokens > options.maxTokens!) break; kept.unshift(message); used += tokens; }
    const first = kept.findIndex(message => message.role === 'user');
    if (first >= 0) selected = kept.slice(first);
    else { let recovered = -1; for (let index = result.length - 1; index >= 0; index--) if (result[index].role === 'user') { recovered = index; break; } selected = recovered >= 0 ? result.slice(recovered) : kept; }
    selected = selected.slice(legalStart(selected));
  }
  if (view === 'model') for (const entry of selected) if (entry.role === 'user' && Array.isArray(entry.content)) entry.content = await replayUserImages(entry.content, options.dataDirectory, options.signal);
  return selected;
}
