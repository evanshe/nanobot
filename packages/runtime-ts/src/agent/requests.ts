import { object } from '../config/decoder.ts';
import type { ConfigObject, Json } from '../config/decoder.ts';
import { equal, hiddenHistory } from '../session/records.ts';
import { stripPythonWhitespace } from './skills.ts';
export const SUMMARY_CONTINUATION = 'Continue the active task from the working-memory checkpoint above.';
export class ContextWindowExceededError extends Error {
  readonly estimatedTokens: number; readonly inputBudget: number; readonly source: string;
  constructor(estimated: number, budget: number, sessionKey = 'default', source = 'heuristic') {
    super(`Model input exceeds the local context budget for ${sessionKey}: ${estimated}/${budget} via ${source}`);
    this.name = 'ContextWindowExceededError'; this.estimatedTokens = estimated; this.inputBudget = budget; this.source = source;
  }
}
export function pythonJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  if (object(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(', ')}}`;
  return JSON.stringify(value);
}
export function estimateAgentMessageBytes(message: ConfigObject): number {
  const parts: string[] = [], content = message.content;
  if (typeof content === 'string') parts.push(content);
  else if (Array.isArray(content)) for (const block of content) {
    if (object(block) && block.type === 'text') { if (typeof block.text === 'string' && block.text) parts.push(block.text); }
    else parts.push(pythonJson(block));
  } else if (content !== null && content !== undefined) parts.push(pythonJson(content));
  for (const key of ['name', 'tool_call_id']) if (typeof message[key] === 'string' && message[key]) parts.push(message[key]);
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) parts.push(pythonJson(message.tool_calls));
  if (typeof message.reasoning_content === 'string' && message.reasoning_content) parts.push(message.reasoning_content);
  return Math.max(4, Buffer.byteLength(parts.join('\n'), 'utf8') + 4);
}
export function estimateAgentPromptBytes(messages: readonly ConfigObject[], tools: readonly ConfigObject[] = []): number {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') parts.push(msg.content);
    else if (Array.isArray(msg.content)) for (const block of msg.content) if (object(block) && block.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text);
    if (msg.tool_calls) parts.push(pythonJson(msg.tool_calls));
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) parts.push(msg.reasoning_content);
    for (const key of ['name', 'tool_call_id']) if (typeof msg[key] === 'string' && msg[key]) parts.push(msg[key]);
  }
  const text = parts.join('\n'), payload = text + (tools.length ? `${text ? '\n' : ''}${pythonJson([...tools])}` : '');
  return Buffer.byteLength(payload, 'utf8') + messages.length * 4;
}
export function normalizeAgentToolResult(name: string, content: Json, limit: number): Json {
  const textBlocks = Array.isArray(content) && content.every(block => object(block) && block.type === 'text' && typeof block.text === 'string') ? content.filter(object).map(block => block.text).join('\n') : null;
  if (content === null || typeof content === 'string' && !stripPythonWhitespace(content) || Array.isArray(content) && (!content.length || textBlocks !== null && !stripPythonWhitespace(textBlocks))) return `(${name} completed with no output)`;
  if (name === 'read_file') return structuredClone(content);
  const truncate = (text: string) => limit > 0 && [...text].length > limit ? `${[...text].slice(0, limit).join('')}\n... (truncated)` : text;
  if (typeof content === 'string') return truncate(content);
  if (Array.isArray(content) && content.every(block => object(block) && typeof block.type === 'string' && (block.type !== 'text' || typeof block.text === 'string'))) return content.filter(object).map(block => block.type === 'text' ? { ...block, text: truncate(String(block.text)) } : structuredClone(block));
  return structuredClone(content);
}
function mergeContent(left: Json | undefined, right: Json | undefined): Json {
  if (typeof left === 'string' && typeof right === 'string') return left ? `${left}\n\n${right}` : right;
  const text = (value: Json) => value === true ? 'True' : value === false ? 'False' : typeof value === 'string' ? value : pythonJson(value);
  const blocks = (value: Json | undefined): Json[] => value === null || value === undefined ? [] : Array.isArray(value) ? value.map(item => object(item) ? item : { type: 'text', text: text(item) }) : [{ type: 'text', text: text(value) }];
  return [...blocks(left), ...blocks(right)];
}
function detach(message: ConfigObject): { content: Json | undefined; sources: string[]; blocks: ConfigObject[] } | null {
  const meta = object(message._meta) ? message._meta : {}, marker = meta.runtime_context;
  if (!object(marker)) return { content: message.content, sources: [], blocks: [] };
  if (marker.version !== 1) return null;
  const sources = Array.isArray(marker.sources) ? marker.sources.filter((value): value is string => typeof value === 'string' && Boolean(value)) : [], content = message.content;
  if (typeof content === 'string' && typeof marker.suffix === 'string' && marker.suffix) {
    if (content === marker.suffix) return { content: '', sources, blocks: [{ type: 'text', text: marker.suffix }] };
    if (content.endsWith(`\n\n${marker.suffix}`)) return { content: content.slice(0, -(marker.suffix.length + 2)), sources, blocks: [{ type: 'text', text: marker.suffix }] };
  }
  if (Array.isArray(content) && Array.isArray(marker.blocks) && marker.blocks.length && equal(content.slice(-marker.blocks.length), marker.blocks)) return { content: content.slice(0, -marker.blocks.length), sources, blocks: marker.blocks.filter(object) };
  return null;
}
function mergeUsers(messages: ConfigObject[]): ConfigObject[] {
  const prepared: ConfigObject[] = [], boundary = (value: ConfigObject) => object(value._meta) && value._meta.provider_state_boundary === true;
  for (const message of messages) {
    const last = prepared.at(-1);
    if (!last || message.role !== 'user' || last.role !== 'user' || hiddenHistory(message) || hiddenHistory(last) || boundary(message) || boundary(last) || message.content === SUMMARY_CONTINUATION || last.content === SUMMARY_CONTINUATION) { prepared.push(message); continue; }
    const a = detach(last), b = detach(message);
    if (!a || !b) { last.content = mergeContent(last.content, message.content); continue; }
    const content = mergeContent(a.content, b.content), blocks = [...a.blocks, ...b.blocks];
    if (!blocks.length) { last.content = content; continue; }
    let merged: Json, marker: ConfigObject;
    if (typeof content === 'string' && blocks.every(block => block.type === 'text' && typeof block.text === 'string')) {
      const suffix = blocks.map(block => block.text).join('\n\n'); merged = content ? `${content}\n\n${suffix}` : suffix; marker = { version: 1, sources: [...a.sources, ...b.sources], suffix };
    } else { merged = [...(Array.isArray(content) ? content : content === null ? [] : [{ type: 'text', text: String(content) }]), ...blocks]; marker = { version: 1, sources: [...a.sources, ...b.sources], blocks }; }
    const rightMeta = object(message._meta) ? message._meta : {}, leftMeta = object(last._meta) ? last._meta : {};
    last.content = merged; last._meta = { ...rightMeta, ...leftMeta, runtime_context: marker };
  }
  return prepared;
}
export function prepareAgentMessages(raw: readonly ConfigObject[], maxToolResultChars: number): ConfigObject[] {
  let messages = structuredClone([...raw]).filter(message => !(message.role === 'assistant' && typeof message.content === 'string' && stripPythonWhitespace(message.content) === '[Previous assistant message omitted.]' && (!message.tool_calls || Array.isArray(message.tool_calls) && !message.tool_calls.length)));
  messages = messages.filter(message => {
    if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return true;
    const kept = message.tool_calls.filter(call => object(call) && object(call.function) && typeof call.function.name === 'string' && Boolean(call.function.name));
    if (kept.length === message.tool_calls.length) return true;
    if (kept.length) message.tool_calls = kept; else delete message.tool_calls;
    return Boolean(kept.length || message.content);
  });
  const declared = new Set<string>(), fulfilled = new Set<string>();
  messages = messages.filter(message => {
    if (message.role === 'assistant' && Array.isArray(message.tool_calls)) for (const call of message.tool_calls) if (object(call) && call.id) declared.add(String(call.id));
    if (message.role !== 'tool') return true;
    const id = message.tool_call_id ? String(message.tool_call_id) : ''; if (!id || !declared.has(id) || fulfilled.has(id)) return false; fulfilled.add(id); return true;
  });
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]; if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) if (object(call) && call.id && !fulfilled.has(String(call.id))) {
      let at = index + 1; while (messages[at]?.role === 'tool') at++;
      messages.splice(at, 0, { role: 'tool', tool_call_id: String(call.id), name: object(call.function) ? String(call.function.name ?? '') : '', content: '[Tool result unavailable — call was interrupted or lost]' });
    }
  }
  for (const [index, message] of messages.entries()) if (message.role === 'tool') message.content = normalizeAgentToolResult(String(message.name || 'tool'), message.content ?? null, maxToolResultChars);
  return mergeUsers(messages);
}
