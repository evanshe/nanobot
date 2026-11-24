// Canonical usage carried by typed events. Provider decoding remains in batch 2B.
export type LLMUsage = Readonly<{
  inputTokens: number; outputTokens: number; totalTokens: number;
  cacheReadTokens: number | null; cacheWriteTokens: number | null;
  reportedTokens: number; estimatedTokens: number; generationMs: number;
  measuredOutputTokens: number; ttftMs: number; timedRequests: number;
  contextTokens: number | null; requestCount: number;
}>;
export function reportedUsage(inputTokens: number, outputTokens: number, totalTokens?: number): LLMUsage {
  for (const value of [inputTokens, outputTokens, ...(totalTokens === undefined ? [] : [totalTokens])]) if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Token counts must be non-negative integers');
  const total = Math.max(inputTokens + outputTokens, totalTokens ?? 0);
  return Object.freeze({ inputTokens, outputTokens, totalTokens: total, cacheReadTokens: null, cacheWriteTokens: null,
    reportedTokens: total, estimatedTokens: 0, generationMs: 0, measuredOutputTokens: 0, ttftMs: 0,
    timedRequests: 0, contextTokens: inputTokens, requestCount: 1 });
}
export function addUsage(left: LLMUsage, right: LLMUsage): LLMUsage {
  const cache = (a: number | null, b: number | null) => a === null || b === null ? null : a + b;
  return Object.freeze({
    inputTokens: left.inputTokens + right.inputTokens, outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens, cacheReadTokens: cache(left.cacheReadTokens, right.cacheReadTokens),
    cacheWriteTokens: cache(left.cacheWriteTokens, right.cacheWriteTokens), reportedTokens: left.reportedTokens + right.reportedTokens,
    estimatedTokens: left.estimatedTokens + right.estimatedTokens, generationMs: left.generationMs + right.generationMs,
    measuredOutputTokens: left.measuredOutputTokens + right.measuredOutputTokens, ttftMs: left.ttftMs + right.ttftMs,
    timedRequests: left.timedRequests + right.timedRequests, contextTokens: right.contextTokens ?? left.contextTokens,
    requestCount: left.requestCount + right.requestCount,
  });
}
