import { jsonrepair } from 'jsonrepair';
import { randomBytes } from 'node:crypto';
import { object } from '../config/decoder.ts';
import type { ConfigObject, Json } from '../config/decoder.ts';
export type ChatToolCall = { id: string; name: string; arguments: Json; extra_content: ConfigObject | null; provider_specific_fields: ConfigObject | null; function_provider_specific_fields: ConfigObject | null };
export type ChatToolDelta = { index: number; call_id: string; name: string; arguments_delta: string };
export type ChatUsage = {
  input_tokens: number; output_tokens: number; total_tokens: number; cache_read_tokens: number | null; cache_write_tokens: number | null;
  reported_tokens: number; estimated_tokens: number; source: 'reported'; generation_ms: number; measured_output_tokens: number;
  ttft_ms: number; timed_requests: number; context_tokens: number; request_count: number;
};
export function parseChatToolArguments(value: Json | undefined): Json {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'string') return structuredClone(value);
  if (!value.trim()) return {};
  try { const parsed: Json = JSON.parse(value); return parsed === null ? value : parsed; } catch { return value; }
}
function pythonJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  if (object(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(', ')}}`;
  return JSON.stringify(value);
}
export function replayChatArguments(value: Json | undefined): string {
  if (object(value)) return pythonJson(value);
  if (typeof value !== 'string' || !value.trim()) return '{}';
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { try { parsed = JSON.parse(jsonrepair(value)); } catch { return '{}'; } }
  return object(parsed) ? pythonJson(parsed) : '{}';
}
function presentInt(value: Json | undefined): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') return null;
  const number = typeof value === 'number' ? Math.trunc(value) : typeof value === 'string' && /^[+-]?\d+$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isSafeInteger(number) ? number : null;
}
export function chatUsage(payload: ConfigObject): ChatUsage | null {
  if (!object(payload.usage)) return null;
  const usage = payload.usage, details = object(usage.prompt_tokens_details) ? usage.prompt_tokens_details : {};
  const input = presentInt(usage.prompt_tokens) ?? 0, output = presentInt(usage.completion_tokens) ?? 0;
  const total = Math.max(input + output, presentInt(usage.total_tokens) ?? 0);
  const read = presentInt(details.cached_tokens) ?? presentInt(usage.cached_tokens) ?? presentInt(usage.prompt_cache_hit_tokens), write = presentInt(details.cache_write_tokens);
  if ([input, output, total, read, write].some(value => value !== null && value < 0) || (read ?? 0) + (write ?? 0) > input) throw new RangeError('Invalid provider token usage');
  return { input_tokens: input, output_tokens: output, total_tokens: total, cache_read_tokens: read, cache_write_tokens: write, reported_tokens: total, estimated_tokens: 0, source: 'reported', generation_ms: 0, measured_output_tokens: 0, ttft_ms: 0, timed_requests: 0, context_tokens: input, request_count: 1 };
}
const id = () => [...randomBytes(9)].map(byte => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[byte % 62]).join('');
const extras = (value: ConfigObject, excluded: readonly string[]): ConfigObject | null => {
  const result = Object.fromEntries(Object.entries(value).filter(([key, item]) => !excluded.includes(key) && item !== null)); return Object.keys(result).length ? result : null;
};
export class ChatToolAccumulator {
  readonly #calls = new Map<number, { id: string; name: string; arguments: string; extra_content: ConfigObject | null; provider_specific_fields: ConfigObject | null; function_provider_specific_fields: ConfigObject | null }>();
  add(value: ConfigObject, index: number): void {
    const call = this.#calls.get(index) ?? { id: '', name: '', arguments: '', extra_content: null, provider_specific_fields: null, function_provider_specific_fields: null };
    if (value.id) call.id = String(value.id);
    if (object(value.function)) {
      const fn = value.function; if (fn.name) call.name = String(fn.name); if (fn.arguments) call.arguments += String(fn.arguments);
      call.function_provider_specific_fields = extras(fn, ['name', 'arguments']) ?? call.function_provider_specific_fields;
    }
    if (object(value.extra_content) && Object.keys(value.extra_content).length) call.extra_content = value.extra_content;
    call.provider_specific_fields = extras(value, ['id', 'type', 'index', 'function', 'extra_content']) ?? call.provider_specific_fields;
    this.#calls.set(index, call);
  }
  finish(): ChatToolCall[] {
    const used = new Set<string>();
    return [...this.#calls.values()].map(call => { let identifier = call.id; while (!identifier || used.has(identifier)) identifier = id(); used.add(identifier); return { ...call, id: identifier, arguments: parseChatToolArguments(call.arguments) }; });
  }
}
export function parseChatToolCalls(values: Json[]): ChatToolCall[] {
  const used = new Set<string>(); return values.filter(object).map(value => {
    const fn = object(value.function) ? value.function : {}; let identifier = value.id ? String(value.id) : '';
    while (!identifier || used.has(identifier)) identifier = id(); used.add(identifier);
    return { id: identifier, name: String(fn.name ?? ''), arguments: parseChatToolArguments(fn.arguments), extra_content: object(value.extra_content) && Object.keys(value.extra_content).length ? value.extra_content : null, provider_specific_fields: extras(value, ['id', 'type', 'index', 'function', 'extra_content']), function_provider_specific_fields: extras(fn, ['name', 'arguments']) };
  });
}
