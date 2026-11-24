import { randomUUID } from 'node:crypto';
import { InboundMessage, EventSink, MessageBus, RuntimeEventPublisher } from '../bus/index.ts';
import type { AgentEvent, EventMap, OutboundMessage, Metadata, LLMUsage } from '../bus/index.ts';
import { object } from '../config/decoder.ts';
import type { ConfigObject } from '../config/decoder.ts';
import { newSession, SessionConflictError, localTimestamp } from '../session/records.ts';
import type { SessionRecord, SessionPolicy } from '../session/records.ts';
import { SessionState } from '../session/state.ts';
import { cloneRecoveryInbound, restoreRuntimeCheckpoint, restorePendingInterruption } from '../session/recovery.ts';
import { ContextBuilder } from './context.ts';
import type { ContextOptions, RuntimeContextBlock } from './context.ts';
import { AgentRunner } from './runner.ts';
import type { AgentModel, AgentTools, AgentCheckpoint, AgentRunSpec } from './runner.ts';
import { RetryingAgentModel } from './retry.ts';
import type { AgentRetryOptions } from './retry.ts';
import { sessionModelHistory } from './history.ts';
import { persistAgentMessages } from './persistence.ts';
export type AgentRuntime = Readonly<{ runtimeId: string; modelName: string; model: AgentModel; maxTokens: number; temperature: number; contextWindowTokens: number; reasoningEffort?: string; modelPreset?: string | null }>;
export type DirectTurnOptions = { ephemeral?: boolean; projectWorkspace?: string; signal?: AbortSignal; policy?: SessionPolicy; enableStreaming?: boolean; publishCompletion?: boolean; publishAcceptance?: boolean };
export type AgentLoopOptions = {
  bus: MessageBus<AgentRuntime>; state: SessionState; context: ContextBuilder; dataDirectory: string; tools: AgentTools;
  runtimeForSession: (session: SessionRecord, message: InboundMessage) => Promise<AgentRuntime>;
  maxIterations?: number; maxToolResultChars?: number; retry?: AgentRetryOptions;
  resolveProject?: (message: InboundMessage, session: SessionRecord) => Promise<string>;
  runtimeContext?: (message: InboundMessage, session: SessionRecord) => Promise<readonly RuntimeContextBlock[]>;
  consolidateHistory?: AgentRunSpec['consolidateHistory'];
};
function usageRecord(value: LLMUsage): ConfigObject {
  return { input_tokens: value.inputTokens, output_tokens: value.outputTokens, total_tokens: value.totalTokens, cache_read_tokens: value.cacheReadTokens, cache_write_tokens: value.cacheWriteTokens, reported_tokens: value.reportedTokens, estimated_tokens: value.estimatedTokens, source: value.reportedTokens && value.estimatedTokens ? 'mixed' : value.estimatedTokens ? 'estimated' : 'reported', generation_ms: value.generationMs, measured_output_tokens: value.measuredOutputTokens, ttft_ms: value.ttftMs, timed_requests: value.timedRequests, context_tokens: value.contextTokens, request_count: value.requestCount };
}
function inputMetadata(message: InboundMessage): ConfigObject {
  const publicId = message.metadata.webui_turn_id;
  const result: ConfigObject = { timestamp: message.timestamp.toISOString(), input_id: typeof publicId === 'string' && publicId ? `user:${publicId}` : null };
  if (typeof publicId === 'string' && publicId) result.webui_turn_id = publicId;
  if (message.media.length) result.media = [...message.media];
  if (Array.isArray(message.metadata.local_media_paths)) result.local_media_paths = structuredClone(message.metadata.local_media_paths);
  return result;
}
type RoutedOperationEvent = EventMap['stream_delta' | 'stream_end' | 'model_request' | 'recovery_state' | 'response_source' | 'retry_status' | 'progress' | 'file_edit' | 'context_compaction' | 'retry_wait'];
function routable(event: AgentEvent, message: InboundMessage, streaming: boolean): event is RoutedOperationEvent {
  if (['stream_delta', 'stream_end'].includes(event.kind)) return streaming;
  if (['model_request', 'recovery_state', 'response_source', 'retry_status'].includes(event.kind)) return message.channel === 'websocket';
  return ['progress', 'file_edit', 'context_compaction', 'retry_wait'].includes(event.kind);
}
export class AgentLoop {
  readonly #options: AgentLoopOptions; readonly #publisher: RuntimeEventPublisher<AgentRuntime>;
  readonly #tails = new Map<string, Promise<unknown>>(); readonly #pending = new Set<Promise<unknown>>(); #closed = false;
  constructor(options: AgentLoopOptions) { this.#options = { ...options }; this.#publisher = new RuntimeEventPublisher(options.bus); }
  #serial<T>(key: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Agent loop is closed')); signal?.throwIfAborted();
    const release = this.#options.bus.admission.activity(), previous = this.#tails.get(key) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(() => { signal?.throwIfAborted(); return operation(); }).finally(() => {
      release(); this.#pending.delete(task); if (this.#tails.get(key) === task) this.#tails.delete(key);
    });
    this.#tails.set(key, task); this.#pending.add(task); void task.catch(() => {}); return task;
  }
  async drain(): Promise<void> { while (this.#pending.size) await Promise.allSettled([...this.#pending]); }
  async close(): Promise<void> { this.#closed = true; await this.drain(); }
  processDirect(content: string, options: DirectTurnOptions & { sessionKey?: string; channel?: string; chatId?: string; senderId?: string; media?: string[]; metadata?: Metadata } = {}): Promise<OutboundMessage<AgentRuntime> | null> {
    if (options.channel === 'system') return Promise.reject(new Error("channel 'system' is reserved for internal messages"));
    return this.processMessage(new InboundMessage({ channel: options.channel ?? 'cli', chatId: options.chatId ?? 'direct', senderId: options.senderId ?? 'user', content, media: options.media, metadata: options.metadata, sessionKeyOverride: options.sessionKey ?? 'cli:direct' }), { ...options, publishCompletion: options.publishCompletion ?? false, publishAcceptance: options.publishAcceptance ?? false });
  }
  processMessage(input: InboundMessage, options: DirectTurnOptions = {}): Promise<OutboundMessage<AgentRuntime> | null> {
    const message = cloneRecoveryInbound(input), captured = { ...options }, key = message.sessionKey;
    return this.#serial(key, () => this.#turn(message, captured), options.signal);
  }
  async #turn(message: InboundMessage, options: DirectTurnOptions): Promise<OutboundMessage<AgentRuntime> | null> {
    const { state, bus, context, dataDirectory } = this.#options, key = message.sessionKey, turnId = randomUUID().replaceAll('-', ''), started = performance.now(), signal = options.signal ?? new AbortController().signal;
    let draft: SessionRecord, temporaryKey: string | null = null;
    if (options.ephemeral) {
      temporaryKey = `temporary:${randomUUID()}`;
      draft = await state.registerTransient(newSession(temporaryKey), options.policy ?? { persist: false, logContent: false, disabledTools: [] });
    } else {
      const existing = await state.read(key);
      if (!existing && (message.requireExistingSession || message.sessionGeneration !== null)) return null;
      draft = existing ?? await state.get(key);
      if (message.sessionGeneration !== null && message.sessionGeneration !== draft.generation) return null;
    }
    message.sessionGeneration = draft.generation;
    const ephemeral = !draft.policy.persist;
    try {
      signal.throwIfAborted();
      if (restoreRuntimeCheckpoint(draft) || restorePendingInterruption(draft)) await state.restoreInterruption(draft);
      const runtime = Object.freeze({ ...await this.#options.runtimeForSession(structuredClone(draft), message) });
      const baseTools = this.#options.tools, disabled = new Set(draft.policy.disabledTools);
      const tools: AgentTools = { definitions: structuredClone(baseTools.definitions.filter(item => object(item.function) && !disabled.has(String(item.function.name)))), validate: baseTools.validate.bind(baseTools), execute: baseTools.execute.bind(baseTools), concurrencySafe: baseTools.concurrencySafe?.bind(baseTools) };
      const project = options.projectWorkspace ?? await this.#options.resolveProject?.(message, structuredClone(draft)) ?? context.workspace;
      const contextOptions: ContextOptions = { projectWorkspace: project, channel: message.channel, includeMemory: !ephemeral, hasCron: !ephemeral && tools.definitions.some(item => object(item.function) && item.function.name === 'cron') };
      const history = await sessionModelHistory(draft, { dataDirectory, signal }), previousCount = draft.messages.length;
      const blocks = await this.#options.runtimeContext?.(message, structuredClone(draft)) ?? [];
      const transcript = await context.buildTranscript({ history, currentMessage: message.content, currentRole: message.isUserInput ? 'user' : 'system', media: message.media, runtimeContextBlocks: blocks, inputMetadata: inputMetadata(message), sessionSummary: object(draft.metadata._last_summary) && typeof draft.metadata._last_summary.text === 'string' ? { text: draft.metadata._last_summary.text, last_active: typeof draft.metadata._last_summary.last_active === 'string' ? draft.metadata._last_summary.last_active : draft.updatedAt } : null }, contextOptions);
      const current = transcript.at(-1)!, early = Boolean(message.content.trim() || message.media.length || blocks.length);
      if (early) { await persistAgentMessages(draft, [current], { dataDirectory }); draft.metadata.pending_user_turn = true; }
      draft.metadata.request_origin = { message_id: typeof message.metadata.message_id === 'string' ? message.metadata.message_id : null, turn_id: turnId };
      await state.prepareInput(draft); signal.throwIfAborted();
      if (options.publishAcceptance !== false) await this.#publisher.userInputAccepted(message, key);
      await this.#publisher.sessionTurnStarted(message, key); await this.#publisher.turnRuntimeAdmitted(message, key, runtime, turnId); await this.#publisher.runStatusChanged(message, key, 'running', Date.now() / 1000);
      const events = new EventSink(async (event, eventSignal) => { eventSignal?.throwIfAborted(); if (routable(event, message, options.enableStreaming === true)) await bus.publishEvent(event, message.channel, message.chatId, message.metadata); });
      const runnerEvents = events;
      const checkpoint = async (payload: AgentCheckpoint) => {
        const preceding = newSession('checkpoint'); preceding.policy = draft.policy;
        await persistAgentMessages(preceding, payload.preceding_messages, { dataDirectory, storeImages: !ephemeral });
        const record: ConfigObject = { phase: payload.phase, iteration: payload.iteration, model: payload.model, assistant_message: payload.assistant_message, completed_tool_results: payload.completed_tool_results, pending_tool_calls: payload.pending_tool_calls, preceding_messages: preceding.messages, consumed_followup_ids: [...preceding.consumedFollowupIds] };
        if (Object.hasOwn(payload, 'provider_state')) { record.provider_state_checkpoint_version = 'v1'; draft.providerState = null; }
        await state.checkpointView(draft, record);
      };
      const model = new RetryingAgentModel(runtime.model, { ...this.#options.retry, events: runnerEvents });
      const result = await new AgentRunner().run({ initialMessages: transcript, model, modelName: runtime.modelName, tools, maxIterations: this.#options.maxIterations ?? 40, maxToolResultChars: this.#options.maxToolResultChars ?? 65536, maxTokens: runtime.maxTokens, temperature: runtime.temperature, reasoningEffort: runtime.reasoningEffort, contextWindowTokens: runtime.contextWindowTokens, sessionKey: key, events: runnerEvents, onCheckpoint: checkpoint, acceptedHistoryBoundary: 1 + history.length, activeSummary: object(draft.metadata._last_summary) && typeof draft.metadata._last_summary.text === 'string' ? draft.metadata._last_summary.text : null, consolidateHistory: this.#options.consolidateHistory, buildSummaryTranscript: async summary => [{ role: 'system', content: await context.buildSystemPrompt(contextOptions, { text: summary, last_active: localTimestamp() }) }] }, signal);
      const latency = Math.max(0, Math.trunc(performance.now() - started)), skip = transcript.length - (early ? 0 : 1);
      const boundaries = await persistAgentMessages(draft, result.messages.slice(skip), { dataDirectory, latencyMs: latency, storeImages: !ephemeral });
      if (!ephemeral && result.usage) draft.metadata._last_usage = usageRecord(result.usage);
      if (!ephemeral) { if (result.stop_reason === 'max_iterations') draft.metadata._stopped_at_iteration_limit = true; else delete draft.metadata._stopped_at_iteration_limit; }
      await state.finishTurn(draft);
      if (!ephemeral && result.summary_checkpoint) {
        const boundary = result.summary_checkpoint.transcript_boundary, archiveEnd = boundary === skip - 1 ? previousCount : boundary >= skip && boundary - skip < boundaries.length ? boundaries[boundary - skip] : null;
        if (archiveEnd !== null) await state.commitSummary(draft, result.summary_checkpoint.summary, archiveEnd);
      }
      this.#publisher.recordTurnLatency(key, latency, turnId); this.#publisher.recordTurnUsage(key, result.round_usages, turnId);
      if (!ephemeral) await this.#publisher.sessionTurnPersisted(message, key, turnId);
      if (options.publishCompletion !== false) await this.#publisher.turnCompleted({ channel: message.channel, chatId: message.chatId, sessionKey: key, metadata: message.metadata, runId: turnId, outcome: result.stop_reason === 'error' ? 'failed' : 'completed', failureKind: result.stop_reason === 'error' ? 'model' : null });
      return { channel: message.channel, chatId: message.chatId, content: result.final_content ?? '', metadata: { ...message.metadata, latency_ms: latency } };
    } finally { this.#publisher.clearTurn(key, turnId); await this.#publisher.runStatusChanged(message, key, 'idle'); if (temporaryKey) await state.discard(temporaryKey); }
  }
}
