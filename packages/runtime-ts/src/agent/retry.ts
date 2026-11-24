import { setTimeout as wait } from 'node:timers/promises';
import { NO_EVENTS } from '../bus/index.ts';
import type { EventSink } from '../bus/index.ts';
import type { ChatCallbacks, ChatRequest, ChatResponse } from '../provider/chat.ts';
import { chatFailure, ChatTransportError, isTransientChatResponse } from '../provider/errors.ts';
import type { AgentModel } from './runner.ts';

export function agentErrorKind(response: ChatResponse): string {
  const kind = response.error_kind ?? '', content = (response.content ?? '').toLowerCase();
  if (kind === 'unsupported_image') return kind;
  const billingTokens = ['insufficient_quota', 'quota_exceeded', 'quota_exhausted', 'billing_hard_limit_reached', 'insufficient_balance', 'insufficient_credits', 'credit_balance_too_low', 'billing_not_active', 'payment_required'];
  const billingText = ['insufficient_quota', 'insufficient quota', 'quota exceeded', 'quota exhausted', 'billing hard limit', 'billing_hard_limit_reached', 'billing not active', 'insufficient balance', 'insufficient_balance', 'insufficient credits', 'insufficient_credits', 'credit balance too low', 'payment required', 'out of credits', 'out of quota', 'exceeded your current quota'];
  if (response.error_status_code === 402 || [response.error_type, response.error_code].some(value => value && billingTokens.includes(value.trim().toLowerCase())) || billingText.some(marker => content.includes(marker))) return 'billing';
  if (['authentication', 'oauth_auth_required'].includes(kind) || response.error_status_code === 401) return 'authentication';
  if (['connection', 'timeout', 'image_request_rejected'].includes(kind)) return kind;
  if (response.error_status_code === 429) return 'rate_limit';
  if ((response.error_status_code ?? 0) >= 500) return 'server';
  return 'unknown';
}
export type AgentRetryOptions = {
  mode?: 'standard' | 'persistent'; events?: EventSink;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>; random?: () => number;
  onStreamRecover?: () => Promise<void>;
};
// Owns physical retry attempts inside one runner-visible logical model request.
export class RetryingAgentModel implements AgentModel {
  readonly #model: AgentModel; readonly #options: AgentRetryOptions;
  constructor(model: AgentModel, options: AgentRetryOptions = {}) { this.#model = model; this.#options = { ...options }; }
  async chatStream(request: ChatRequest, callbacks: ChatCallbacks = {}, signal = new AbortController().signal): Promise<ChatResponse> {
    const events = this.#options.events ?? NO_EVENTS, persistent = this.#options.mode === 'persistent', maxAttempts = persistent ? null : 4;
    const sleep = this.#options.sleep ?? (async (milliseconds, abort) => { await wait(milliseconds, undefined, { signal: abort }); });
    let attempt = 1, streamed = false, suppressed = false, lastError: string | null = null, identical = 0;
    const status = async (state: 'waiting' | 'recovered' | 'cleared' | 'exhausted', response: ChatResponse, nextRetryAt?: number) => events.emit({ kind: 'retry_status', state, attempt, maxAttempts, errorKind: agentErrorKind(response), nextRetryAt }, signal);
    const call = async (): Promise<ChatResponse> => {
      signal.throwIfAborted();
      try {
        const response = await this.#model.chatStream(structuredClone(request), suppressed ? {} : {
          ...(callbacks.onContentDelta ? { onContentDelta: async (text: string) => { if (text) streamed = true; await callbacks.onContentDelta!(text, signal); } } : {}),
          onThinkingDelta: callbacks.onThinkingDelta, onToolCallDelta: callbacks.onToolCallDelta,
        }, signal);
        signal.throwIfAborted(); return response;
      } catch (error) {
        signal.throwIfAborted(); if (error instanceof Error && error.name === 'AbortError') throw error;
        const name = error instanceof Error ? error.name.toLowerCase() : '', kind = name.includes('timeout') ? 'timeout' : /connect|network|transport|protocol/.test(name) || error instanceof TypeError && /fetch failed|terminated/.test(error.message) ? 'connection' : null;
        return chatFailure(kind ? new ChatTransportError(String(error), { kind, shouldRetry: true }) : error);
      }
    };
    let response = await call();
    while (response.finish_reason === 'error') {
      signal.throwIfAborted();
      if (streamed) {
        if (response.error_kind === 'timeout') {
          if (this.#options.onStreamRecover) { await this.#options.onStreamRecover(); streamed = false; }
          else { suppressed = true; streamed = false; }
        } else { if (attempt > 1) await status('cleared', response); return response; }
      }
      const key = response.content?.trim().toLowerCase() || null;
      identical = key && key === lastError ? identical + 1 : key ? 1 : 0; lastError = key;
      if (!isTransientChatResponse(response)) { if (attempt > 1) await status('cleared', response); return response; }
      if (persistent ? identical >= 10 : attempt >= 4) { await events.emit({ kind: 'retry_wait', content: persistent ? `Persistent retry stopped after ${identical} identical errors.` : `Model request failed after ${attempt} attempts, giving up.` }, signal); await status('exhausted', response); return response; }
      const retry = response.error_retry_after_s && response.error_retry_after_s > 0 ? response.error_retry_after_s : response.retry_after && response.retry_after > 0 ? response.retry_after : null;
      const base = [1, 2, 4][Math.min(attempt - 1, 2)], random = this.#options.random?.() ?? Math.random();
      let delay = retry ? retry + 1 : base / 2 + random * base / 2; if (persistent) delay = Math.min(delay, 60);
      const deadline = Date.now() + delay * 1000; let remaining = delay;
      while (remaining > 0) {
        await events.emit({ kind: 'retry_wait', content: `Model request failed, ${persistent ? 'persistent retry' : 'retry'} in ${Math.max(1, Math.round(remaining))}s (attempt ${attempt}).` }, signal);
        await status('waiting', response, deadline); const chunk = Math.min(remaining, 30); await sleep(chunk * 1000, signal); signal.throwIfAborted(); remaining -= chunk;
      }
      attempt++; response = await call();
      if (response.finish_reason !== 'error') { await status('recovered', response); return response; }
    }
    return response;
  }
}
