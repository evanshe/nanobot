import { object } from '../config/decoder.ts';
import type { ConfigObject } from '../config/decoder.ts';
import type { ChatResponse } from './chat.ts';
export type ChatErrorMetadata = {
  error_status_code: number | null; error_kind: string | null; error_type: string | null; error_code: string | null;
  error_retry_after_s: number | null; error_should_retry: boolean | null; retry_after: number | null;
};
export class ChatTransportError extends Error {
  readonly status: number | null; readonly headers: Headers; readonly payload: ConfigObject | null;
  readonly kind: string | null; readonly shouldRetry: boolean | null;
  constructor(message: string, options: { status?: number; headers?: Headers; payload?: ConfigObject; kind?: string; shouldRetry?: boolean } = {}) {
    super(message); this.status = options.status ?? null; this.headers = options.headers ?? new Headers(); this.payload = options.payload ?? null;
    this.kind = options.kind ?? null; this.shouldRetry = options.shouldRetry ?? null;
  }
}
export function retryAfter(headers: Headers): number | null {
  const ms = Number(headers.get('retry-after-ms')); if (ms > 0 && Number.isFinite(ms)) return ms / 1000;
  const raw = headers.get('retry-after'); if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw.trim())) { const seconds = Number(raw); return Math.max(0.1, seconds); }
  const date = Date.parse(raw); return Number.isFinite(date) ? Math.max(0.1, (date - Date.now()) / 1000) : null;
}
function retryAfterText(text: string): number | null {
  const lower = text.toLowerCase();
  const patterns = [/retry after\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)?/, /try again in\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)/, /wait\s+(\d+(?:\.\d+)?)\s*(ms|milliseconds|s|sec|secs|seconds|m|min|minutes)\s*before retry/, /retry[_-]?after["'\s:=]+(\d+(?:\.\d+)?)/];
  for (const [index, pattern] of patterns.entries()) {
    if (index === 1) {
      const compound = /try again in\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)(?![a-z])/.exec(lower);
      if (compound) return Math.max(0.1, [...compound[1].matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)].reduce((sum, part) => sum + Number(part[1]) * ({ ms: 0.001, h: 3600, m: 60, s: 1 }[part[2]] ?? 1), 0));
    }
    const match = pattern.exec(lower); if (match) return Math.max(0.1, Number(match[1]) * (['ms', 'milliseconds'].includes(match[2]) ? 0.001 : ['m', 'min', 'minutes'].includes(match[2]) ? 60 : 1));
  }
  return null;
}
export function chatFailure(error: unknown): ChatResponse {
  const typed = error instanceof ChatTransportError ? error : null;
  const detail = error instanceof Error ? error.message : String(error);
  const payload = typed?.payload, nested = payload && object(payload.error) ? payload.error : {};
  const token = (value: unknown): string | null => value === undefined || value === null ? null : String(value).trim().toLowerCase() || null;
  const retry = typed ? retryAfter(typed.headers) : null, header = typed?.headers.get('x-should-retry')?.trim().toLowerCase();
  return { content: `Error calling LLM: ${detail}`, reasoning_content: null, tool_calls: [], usage: null, finish_reason: 'error',
    error_status_code: typed?.status ?? null, error_kind: typed?.kind ?? null, error_type: token(nested.type || payload?.type), error_code: token(nested.code || payload?.code),
    error_retry_after_s: retry, error_should_retry: typed?.shouldRetry ?? (header === 'true' ? true : header === 'false' ? false : null), retry_after: retry ?? retryAfterText(detail) };
}
// LLMProvider.is_transient_response ordering: explicit policy, status, kind, legacy text.
export function isTransientChatResponse(response: ChatResponse): boolean {
  if (response.error_should_retry !== null && response.error_should_retry !== undefined) return response.error_should_retry;
  const content = (response.content ?? '').toLowerCase(), status = response.error_status_code;
  if (status === 429) {
    const tokens = ['insufficient_quota', 'quota_exceeded', 'quota_exhausted', 'billing_hard_limit_reached', 'insufficient_balance', 'insufficient_credits', 'credit_balance_too_low', 'billing_not_active', 'payment_required'];
    if ([response.error_type, response.error_code].some(value => value && tokens.includes(value.trim().toLowerCase()))) return false;
    if (['insufficient_quota', 'insufficient quota', 'quota exceeded', 'quota exhausted', 'billing hard limit', 'billing_hard_limit_reached', 'billing not active', 'insufficient balance', 'insufficient_balance', 'insufficient credits', 'insufficient_credits', 'credit balance too low', 'payment required', 'out of credits', 'out of quota', 'exceeded your current quota'].some(marker => content.includes(marker))) return false;
    return true;
  }
  if (status !== null && status !== undefined && ([408, 409].includes(status) || status >= 500)) return true;
  if (['timeout', 'connection'].includes(response.error_kind ?? '')) return true;
  return ['429', 'rate limit', '500', '502', '503', '504', 'overloaded', 'timeout', 'timed out', 'connection', 'server error', 'server_error', 'temporarily unavailable', '速率限制', '访问量过大'].some(marker => content.includes(marker));
}
export function resolveChatIdleTimeoutMs(raw = process.env.NANOBOT_STREAM_IDLE_TIMEOUT_S): number {
  if (!raw?.trim()) return 90_000; const seconds = Number(raw);
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 3600) * 1000 : 90_000;
}
