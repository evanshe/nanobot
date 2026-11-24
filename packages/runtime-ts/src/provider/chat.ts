import { randomUUID } from 'node:crypto';
import { object } from '../config/decoder.ts';
import type { ConfigObject, Json } from '../config/decoder.ts';

export type ChatRequest = {
  messages: readonly ConfigObject[]; model?: string; max_tokens?: number; temperature?: number;
  reasoning_effort?: string; tools?: readonly ConfigObject[]; tool_choice?: string | ConfigObject;
};
export type ChatResponse = { content: string | null; reasoning_content: string | null; finish_reason: string };
export type ChatCallbacks = { onContentDelta?: (text: string) => void | Promise<void>; onThinkingDelta?: (text: string) => void | Promise<void> };
export type ChatProviderOptions = {
  apiBase: string; apiKey?: string; defaultModel?: string; extraHeaders?: Record<string, string>;
  extraBody?: ConfigObject; extraQuery?: Record<string, string>;
};
function scrub(value: Json): Json {
  if (typeof value === 'string') return value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, '');
  if (Array.isArray(value)) return value.map(scrub);
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item)]));
  return value;
}
const allowed = new Set(['role', 'content', 'tool_calls', 'tool_call_id', 'name', 'reasoning_content', 'extra_content']);
function messagesForWire(messages: readonly ConfigObject[]): ConfigObject[] {
  const cleaned = messages.map(raw => {
    const msg: ConfigObject = Object.fromEntries(Object.entries(raw).filter(([key]) => allowed.has(key)));
    let content = msg.content;
    if (content === '') content = msg.role === 'assistant' && msg.tool_calls ? null : '(empty)';
    else if (Array.isArray(content)) {
      const blocks = content.filter(block => !object(block) || !['text', 'input_text', 'output_text'].includes(String(block.type)) || Boolean(block.text)).map(block => object(block) ? Object.fromEntries(Object.entries(block).filter(([key]) => key !== '_meta')) : block);
      if (blocks.length !== content.length || content.some(block => object(block) && '_meta' in block)) content = blocks.length ? blocks : msg.role === 'assistant' && msg.tool_calls ? null : '(empty)';
    } else if (object(content)) content = [content];
    if (content !== undefined) msg.content = content;
    if (msg.role === 'assistant' && !('content' in msg)) msg.content = null;
    return scrub(msg) as ConfigObject;
  });
  const merged: ConfigObject[] = [];
  const blocks = (content: Json): Json[] => typeof content === 'string' ? content ? [{ type: 'text', text: content }] : [] : Array.isArray(content) ? content : [];
  for (const msg of cleaned) {
    const previous = merged.at(-1), role = msg.role;
    if (previous && previous.role === role && (role === 'user' || role === 'assistant')) {
      if (role === 'assistant' && msg.tool_calls) { merged[merged.length - 1] = msg; continue; }
      if (role === 'assistant' && previous.tool_calls) continue;
      const a = previous.content || '', b = msg.content || '';
      if (typeof a === 'string' && typeof b === 'string') previous.content = `${a}\n\n${b}`.trim();
      else merged[merged.length - 1] = role === 'user' ? { ...msg, content: [...blocks(a), ...blocks(b)] } : msg;
    } else merged.push(msg);
  }
  let last: ConfigObject | undefined;
  while (merged.at(-1)?.role === 'assistant') last = merged.pop();
  if (!merged.length && last) merged.push({ role: 'user', content: last.content || '(empty)' });
  return merged;
}
export function chatText(value: Json | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(block => typeof block === 'string' ? block : object(block) && block.type !== 'thinking' && typeof block.text === 'string' ? block.text : '').join('') || null;
  return String(value);
}
function thinking(value: Json | undefined): string | null {
  return Array.isArray(value) ? value.filter(object).filter(block => block.type === 'thinking').map(block => chatText(block.thinking) ?? '').join('') || null : null;
}
function mergeBody(base: ConfigObject, extra: ConfigObject): ConfigObject {
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(extra)) out[key] = key === 'tools' && Array.isArray(out[key]) && Array.isArray(value) ? [...out[key], ...value] : object(out[key]) && object(value) ? mergeBody(out[key], value) : structuredClone(value);
  return out;
}
export class OpenAIChatProvider {
  readonly #options: ChatProviderOptions;
  readonly #affinity = randomUUID().replaceAll('-', '');
  constructor(options: ChatProviderOptions) { this.#options = structuredClone(options); }
  #body(request: ChatRequest): ConfigObject {
    const model = request.model || this.#options.defaultModel || 'gpt-4o', lower = model.toLowerCase(), slug = lower.split('/').at(-1)!;
    const body: ConfigObject = { model, messages: messagesForWire(request.messages) };
    if (!['gpt-5', 'o1', 'o3', 'o4'].some(token => lower.includes(token)) && (!lower.includes('gpt-6') || request.reasoning_effort?.toLowerCase() === 'none')) body.temperature = request.temperature ?? 0.7;
    const completion = slug.includes('gpt-5') || /^(?:o1|o3|o4)(?:$|[-.])/.test(slug);
    body[completion ? 'max_completion_tokens' : 'max_tokens'] = Math.max(1, request.max_tokens ?? 4096);
    if (request.reasoning_effort && request.reasoning_effort.toLowerCase() !== 'none') body.reasoning_effort = request.reasoning_effort;
    if (request.tools?.length) { body.tools = structuredClone([...request.tools]); body.tool_choice = request.tool_choice || 'auto'; }
    return mergeBody(body, this.#options.extraBody ?? {});
  }
  async #request(request: ChatRequest, stream: boolean, signal?: AbortSignal): Promise<Response> {
    const url = new URL(`${this.#options.apiBase.replace(/\/$/, '')}/chat/completions`);
    for (const [key, value] of Object.entries(this.#options.extraQuery ?? {})) url.searchParams.set(key, value);
    const body = this.#body(request); if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${this.#options.apiKey || 'no-key'}`, 'x-session-affinity': this.#affinity, ...this.#options.extraHeaders }, body: JSON.stringify(body), signal });
    if (!response.ok) { const body = await response.text(); throw new Error(`HTTP ${response.status}: ${body}`); }
    return response;
  }
  async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    const response = await this.#request(request, false, signal), payload: unknown = await response.json();
    if (!object(payload)) throw new TypeError('Chat response must be an object');
    const choices = Array.isArray(payload.choices) ? payload.choices.filter(object) : [], first = choices[0], message = first && object(first.message) ? first.message : {};
    return { content: chatText(message.content), reasoning_content: chatText(message.reasoning_content ?? message.reasoning), finish_reason: typeof first?.finish_reason === 'string' ? first.finish_reason : 'stop' };
  }
  async chatStream(request: ChatRequest, callbacks: ChatCallbacks = {}, signal?: AbortSignal): Promise<ChatResponse> {
    const response = await this.#request(request, true, signal);
    if (!response.body) throw new Error('Chat stream has no body');
    let content = '', reasoning = '', finish = 'stop', completed = false;
    for await (const payload of sseJson(response.body)) {
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
      if (!object(choice)) continue;
      if (choice.finish_reason) { finish = String(choice.finish_reason); completed = true; }
      const delta = object(choice.delta) ? choice.delta : {};
      const text = chatText(delta.content), thought = chatText(delta.reasoning_content ?? delta.reasoning) || thinking(delta.content);
      if (text) { await callbacks.onContentDelta?.(text); content += text; }
      if (thought) { await callbacks.onThinkingDelta?.(thought); reasoning += thought; }
    }
    if (!completed) throw new Error('Model stream ended before a finish reason was received');
    return { content: content || null, reasoning_content: reasoning || null, finish_reason: finish };
  }
}
async function* sseJson(body: ReadableStream<Uint8Array>): AsyncGenerator<ConfigObject> {
  const reader = body.getReader(), decoder = new TextDecoder(); let buffer = '', lines: string[] = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); buffer += decoder.decode(value, { stream: !done });
      let newline: number;
      while ((newline = buffer.search(/[\r\n]/)) >= 0) {
        if (buffer[newline] === '\r' && newline === buffer.length - 1 && !done) break;
        const line = buffer.slice(0, newline), width = buffer[newline] === '\r' && buffer[newline + 1] === '\n' ? 2 : 1; buffer = buffer.slice(newline + width);
        if (line.startsWith('data:')) lines.push(line.slice(5).replace(/^ /, ''));
        if (line !== '' || !lines.length) continue;
        const data = lines.join('\n'); lines = [];
        if (data === '[DONE]') return;
        const parsed: unknown = JSON.parse(data); if (!object(parsed)) throw new TypeError('SSE payload must be an object');
        if (object(parsed.error)) throw new Error(String(parsed.error.message ?? 'Provider stream error'));
        yield parsed;
      }
      if (done) break;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
