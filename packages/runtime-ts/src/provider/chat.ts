import { isLocalChatEndpoint } from './endpoint.ts';
import { ChatTransportError, chatFailure, resolveChatIdleTimeoutMs } from './errors.ts';
import type { ChatErrorMetadata } from './errors.ts';
import { ChatToolAccumulator, chatUsage, parseChatToolCalls, replayChatArguments } from './values.ts';
import type { ChatToolCall, ChatToolDelta, ChatUsage } from './values.ts';
import { randomUUID } from 'node:crypto';
import { object } from '../config/decoder.ts';
import type { ConfigObject, Json } from '../config/decoder.ts';

export type ChatRequest = {
  messages: readonly ConfigObject[]; model?: string; max_tokens?: number; temperature?: number;
  reasoning_effort?: string; tools?: readonly ConfigObject[]; tool_choice?: string | ConfigObject;
};
export type ChatResponse = Partial<ChatErrorMetadata> & { content: string | null; reasoning_content: string | null; finish_reason: string; tool_calls: ChatToolCall[]; usage: ChatUsage | null };
export type ChatCallbacks = { onContentDelta?: (text: string, signal: AbortSignal) => void | Promise<void>; onThinkingDelta?: (text: string, signal: AbortSignal) => void | Promise<void>; onToolCallDelta?: (delta: ChatToolDelta, signal: AbortSignal) => void | Promise<void> };
export type ChatProviderOptions = {
  apiBase: string; apiKey?: string; defaultModel?: string; extraHeaders?: Record<string, string>;
  extraBody?: ConfigObject; extraQuery?: Record<string, string>; idleTimeoutMs?: number; requestTimeoutMs?: number;
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
  if (merged.length && last && !merged.some(msg => msg.role === 'user' || msg.role === 'tool')) merged.push({ ...last, role: 'user' });
  const first = merged.findIndex(msg => msg.role !== 'system');
  if (first >= 0 && merged[first].role === 'assistant' && !merged[first].tool_calls) merged.splice(first, 0, { role: 'user', content: '(conversation continued)' });
  const pending = new Map<string, string[]>();
  for (const message of merged) {
    if (Array.isArray(message.tool_calls)) {
      const used = new Set<string>();
      message.tool_calls = message.tool_calls.map(raw => {
        if (!object(raw)) return raw;
        const call = { ...raw }; let identifier = typeof call.id === 'string' ? call.id : '';
        while (!identifier || used.has(identifier)) identifier = randomUUID().replaceAll('-', '').slice(0, 9);
        used.add(identifier); call.id = identifier;
        if (typeof raw.id === 'string' && raw.id) pending.set(raw.id, [...pending.get(raw.id) ?? [], identifier]);
        if (object(call.function)) call.function = { ...call.function, arguments: replayChatArguments(call.function.arguments) };
        return call;
      });
    }
    if (typeof message.tool_call_id === 'string') {
      const queue = pending.get(message.tool_call_id); if (queue?.length) message.tool_call_id = queue.shift()!;
    }
  }
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
  readonly #controllers = new Set<AbortController>();
  readonly #pending = new Set<Promise<unknown>>();
  #closed = false;
  constructor(options: ChatProviderOptions) {
    for (const value of [options.idleTimeoutMs, options.requestTimeoutMs]) if (value !== undefined && (!Number.isFinite(value) || value <= 0)) throw new RangeError('Provider timeouts must be positive finite milliseconds');
    this.#options = structuredClone(options);
  }
  #track<T>(task: Promise<T>): Promise<T> {
    this.#pending.add(task); void task.finally(() => this.#pending.delete(task)).catch(() => {}); return task;
  }
  async #step<T>(task: Promise<T>, controller: AbortController, timeoutMs = 0): Promise<T> {
    const signal = controller.signal; if (signal.aborted) { void task.catch(() => {}); signal.throwIfAborted(); }
    let timer: ReturnType<typeof setTimeout> | undefined, abort!: () => void;
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true });
      if (timeoutMs) timer = setTimeout(() => controller.abort(new ChatTransportError('Model stream/request stalled', { kind: 'timeout' })), timeoutMs);
    });
    try { return await Promise.race([task, interrupted]); } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
  }
  #operate(task: (controller: AbortController) => Promise<ChatResponse>, signal?: AbortSignal): Promise<ChatResponse> {
    if (this.#closed) return Promise.reject(new Error('Chat provider is closed'));
    const controller = new AbortController();
    const abort = () => controller.abort(signal!.reason); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
    this.#controllers.add(controller);
    return this.#track((async () => {
      try { controller.signal.throwIfAborted(); return await task(controller); }
      catch (error) {
        if (signal?.aborted) throw signal.reason;
        if (this.#closed) throw controller.signal.reason;
        if (controller.signal.reason instanceof ChatTransportError) return chatFailure(controller.signal.reason);
        return chatFailure(error instanceof TypeError && /fetch failed|terminated/.test(error.message) ? new ChatTransportError(error.message, { kind: 'connection' }) : error);
      } finally { signal?.removeEventListener('abort', abort); this.#controllers.delete(controller); controller.abort(); }
    })());
  }
  async #emit<T>(callback: ((value: T, signal: AbortSignal) => void | Promise<void>) | undefined, value: T, controller: AbortController): Promise<void> {
    if (!callback) return;
    try { await this.#step(this.#track(Promise.resolve().then(() => callback(value, controller.signal))), controller); }
    catch (error) { if (controller.signal.aborted) throw controller.signal.reason; throw new ChatTransportError(error instanceof Error ? error.message : String(error), { kind: 'callback', shouldRetry: false }); }
  }
  async close(): Promise<void> {
    this.#closed = true; for (const controller of this.#controllers) controller.abort(new DOMException('Chat provider closed', 'AbortError'));
    await Promise.allSettled([...this.#pending]);
  }
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
    const headers = new Headers({ 'content-type': 'application/json', authorization: `Bearer ${this.#options.apiKey || 'no-key'}`, 'x-session-affinity': this.#affinity });
    for (const [name, value] of Object.entries(this.#options.extraHeaders ?? {})) headers.set(name, value);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal, redirect: isLocalChatEndpoint(this.#options.apiBase) ? 'manual' : 'follow' });
    if (!response.ok) {
      const body = await response.text(); let payload: unknown; try { payload = JSON.parse(body); } catch { payload = null; }
      throw new ChatTransportError(`HTTP ${response.status}: ${body.slice(0, 500)}`, { status: response.status, headers: response.headers, ...(object(payload) ? { payload } : {}) });
    }
    return response;
  }
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
    return this.#operate(controller => this.#chat(request, controller), signal);
  }
  async #chat(request: ChatRequest, controller: AbortController): Promise<ChatResponse> {
    const timeout = this.#options.requestTimeoutMs ?? (() => { const value = Number(process.env.NANOBOT_OPENAI_COMPAT_TIMEOUT_S); return Number.isFinite(value) && value > 0 ? value * 1000 : 120_000; })();
    const response = await this.#step(this.#request(request, false, controller.signal), controller, timeout), payload: unknown = await this.#step(response.json(), controller, timeout);
    if (!object(payload)) throw new TypeError('Chat response must be an object');
    const choices = Array.isArray(payload.choices) ? payload.choices.filter(object) : [], first = choices[0], message = first && object(first.message) ? first.message : {};
    if (!choices.length) {
      const text = chatText(payload.content || payload.output_text);
      if (text !== null) return { content: text, reasoning_content: chatText(payload.reasoning_content), finish_reason: String(payload.finish_reason || 'stop'), tool_calls: [], usage: chatUsage(payload) };
      const failure = chatFailure(new ChatTransportError('API returned empty choices', { kind: 'empty' })); failure.content = 'Error: API returned empty choices.'; return failure;
    }
    let content = chatText(message.content), reason = chatText(message.reasoning_content ?? message.reasoning), finish = typeof first?.finish_reason === 'string' ? first.finish_reason : 'stop';
    const calls: Json[] = [];
    for (const choice of choices) {
      const msg = object(choice.message) ? choice.message : {};
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) { calls.push(...msg.tool_calls); if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'stop') finish = choice.finish_reason; }
      content ||= chatText(msg.content); reason ??= chatText(msg.reasoning_content);
    }
    return { content, reasoning_content: reason, finish_reason: finish, tool_calls: parseChatToolCalls(calls), usage: chatUsage(payload) };
  }
  chatStream(request: ChatRequest, callbacks: ChatCallbacks = {}, signal?: AbortSignal): Promise<ChatResponse> {
    return this.#operate(controller => this.#stream(request, callbacks, controller), signal);
  }
  async #stream(request: ChatRequest, callbacks: ChatCallbacks, controller: AbortController): Promise<ChatResponse> {
    const idle = this.#options.idleTimeoutMs ?? resolveChatIdleTimeoutMs();
    const response = await this.#step(this.#request(request, true, controller.signal), controller, idle);
    if (!response.body) throw new Error('Chat stream has no body');
    let content = '', reasoning = '', finish = 'stop', completed = false, usage: ChatUsage | null = null;
    const tools = new ChatToolAccumulator();
    const iterator = sseJson(response.body); let parseError: unknown, primaryError: unknown;
    try { while (true) {
      const next = await this.#step(iterator.next(), controller, idle); if (next.done) break; const payload = next.value;
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
      if (!object(choice)) { if (!parseError) try { usage = chatUsage(payload) ?? usage; const text = chatText(payload.content || payload.output_text); if (text) content += text; } catch (error) { parseError = error; } continue; }
      if (choice.finish_reason) { finish = String(choice.finish_reason); completed = true; }
      const delta = object(choice.delta) ? choice.delta : {};
      const text = chatText(delta.content), thought = chatText(delta.reasoning_content ?? delta.reasoning) || thinking(delta.content);
      if (text) { await this.#emit(callbacks.onContentDelta, text, controller); content += text; }
      if (thought) { await this.#emit(callbacks.onThinkingDelta, thought, controller); reasoning += thought; }
      for (const [hint, call] of (Array.isArray(delta.tool_calls) ? delta.tool_calls : []).entries()) {
        if (!object(call)) continue; const fn = object(call.function) ? call.function : {}, index = typeof call.index === 'number' ? call.index : hint;
        await this.#emit(callbacks.onToolCallDelta, { index, call_id: String(call.id || ''), name: String(fn.name || ''), arguments_delta: String(fn.arguments || '') }, controller); if (!parseError) try { tools.add(call, index); } catch (error) { parseError = error; }
      }
      if (object(delta.function_call)) {
        const fn = delta.function_call;
        await this.#emit(callbacks.onToolCallDelta, { index: 0, call_id: '', name: String(fn.name || ''), arguments_delta: String(fn.arguments || '') }, controller); if (!parseError) try { tools.add({ function: fn }, 0); } catch (error) { parseError = error; }
      }
      if (!parseError) try { usage = chatUsage(payload) ?? usage; } catch (error) { parseError = error; }
    } } catch (error) { primaryError = error; throw error; } finally {
      try { await iterator.return(undefined); } catch (error) { if (!primaryError) throw new ChatTransportError(String(error), { kind: 'cleanup', shouldRetry: false }); }
    }
    if (!completed) throw new ChatTransportError('Model stream ended before a finish reason was received', { kind: 'connection' });
    if (parseError) throw parseError;
    return { content: content || null, reasoning_content: reasoning || null, finish_reason: finish, tool_calls: tools.finish(), usage };
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
        const error = parsed.error;
        // The SDK checks Python truthiness, so empty dicts/lists are not errors.
        const hasError = Array.isArray(error) ? error.length > 0 : object(error) ? Object.keys(error).length > 0 : Boolean(error);
        if (hasError) {
          const message = object(error) && typeof error.message === 'string' && error.message ? error.message : 'An error occurred during streaming';
          let payload: unknown = error; if (typeof error === 'string') try { payload = JSON.parse(error); } catch { /* Plain error text has no structured metadata. */ }
          throw new ChatTransportError(`${message}: ${typeof error === 'string' ? error : JSON.stringify(error)}`, object(payload) ? { payload } : {});
        }
        yield parsed;
      }
      if (done) break;
    }
  } finally { try { await reader.cancel(); } finally { reader.releaseLock(); } }
}
