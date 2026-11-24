import { createHash, randomUUID } from 'node:crypto';
import { InboundMessage, EventSink, MessageBus, RuntimeEventPublisher, RuntimeBusyError } from '../bus/index.ts';
import type { AgentEvent, EventMap, OutboundMessage, Metadata, LLMUsage } from '../bus/index.ts';
import { object } from '../config/decoder.ts';
import type { ConfigObject } from '../config/decoder.ts';
import { newSession, SessionConflictError, localTimestamp } from '../session/records.ts';
import type { SessionRecord, SessionPolicy } from '../session/records.ts';
import { SessionState } from '../session/state.ts';
import { cloneRecoveryInbound, restoreRuntimeCheckpoint, restorePendingInterruption, discardRuntimeCheckpoint, runtimeCheckpointIsWellFormed, pendingFollowups } from '../session/recovery.ts';
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
export class AgentLoopCancellation extends Error {
  readonly preserveCheckpoint: boolean;
  constructor(message: string, preserveCheckpoint: boolean) { super(message); this.name = 'AbortError'; this.preserveCheckpoint = preserveCheckpoint; }
}
const CONTINUATION = 'Continue the interrupted request from the saved conversation context. Do not repeat completed work or mention the restart unless it affects the answer.';
function recoveryFingerprint(session: SessionRecord): string { return createHash('sha256').update(JSON.stringify({ generation: session.generation, messages: session.messages, metadata: session.metadata })).digest('hex'); }
export type AgentRecoveryCandidate = { recoveryId: string; canContinue: boolean; key: string; generation: string; phase: string | null; checkpointValid: boolean; pendingInput: boolean; pendingFollowups: number; unfinishedDisplayTurn: boolean; requiresConfirmation: boolean };
export class AgentLoop {
  readonly #options: AgentLoopOptions; readonly #publisher: RuntimeEventPublisher<AgentRuntime>;
  readonly #deliveries = new Set<Promise<void>>(); #intake: AbortController | null = null;
  readonly #tails = new Map<string, Promise<unknown>>(); readonly #pending = new Set<Promise<unknown>>();
  readonly #tickets = new Map<string, { id: string; fingerprint: string }>(); readonly #activeResume = new Map<string, AbortController>();
  readonly #jobs = new Map<string, Set<{ controller: AbortController; task: Promise<unknown> }>>(); readonly #controlling = new Set<string>(); #closed = false;
  constructor(options: AgentLoopOptions) { this.#options = { ...options }; this.#publisher = new RuntimeEventPublisher(options.bus); }
  #serial<T>(key: string, operation: (controller: AbortController) => Promise<T>, signal?: AbortSignal, accept?: () => Promise<unknown>): Promise<T> {
    if (this.#closed) return Promise.reject(new Error('Agent loop is closed'));
    if (this.#controlling.has(key)) return Promise.reject(new RuntimeBusyError('Session control is active'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    const release = this.#options.bus.admission.activity(), previous = this.#tails.get(key) ?? Promise.resolve(), controller = new AbortController();
    const abort = () => controller.abort(signal!.reason); signal?.addEventListener('abort', abort, { once: true });
    const jobs = this.#jobs.get(key) ?? new Set<{ controller: AbortController; task: Promise<unknown> }>(); this.#jobs.set(key, jobs);
    const accepted = accept ? Promise.resolve().then(accept) : Promise.resolve(); void accepted.catch(() => {});
    const task = previous.catch(() => {}).then(async () => { await accepted; controller.signal.throwIfAborted(); return operation(controller); }).finally(() => {
      signal?.removeEventListener('abort', abort); release(); this.#pending.delete(task); jobs.delete(job); if (!jobs.size) this.#jobs.delete(key); if (this.#tails.get(key) === task) this.#tails.delete(key);
    });
    const job = { controller, task }; jobs.add(job); this.#tails.set(key, task); this.#pending.add(task); void task.catch(() => {}); return task;
  }
  async drain(): Promise<void> { while (this.#pending.size || this.#deliveries.size) await Promise.allSettled([...this.#pending, ...this.#deliveries]); }
  async run(options: { signal?: AbortSignal; onTurnError?: (error: unknown, message: InboundMessage) => void | Promise<void> } = {}): Promise<void> {
    if (this.#closed) throw new Error('Agent loop is closed');
    if (this.#intake) throw new RuntimeBusyError('Agent loop intake is already running');
    const controller = new AbortController(), abort = () => controller.abort(options.signal!.reason); this.#intake = controller;
    options.signal?.addEventListener('abort', abort, { once: true }); if (options.signal?.aborted) abort();
    try {
      while (!controller.signal.aborted) {
        let claim;
        try { claim = await this.#options.bus.consumeInbound(controller.signal); }
        catch (error) { if (controller.signal.aborted) break; throw error; }
        // The bus claim remains owned through final outbound enqueue, including
        // all microtasks between dequeue, turn admission and completion.
        const message = claim.message;
        const delivery = this.processMessage(message).then(async result => { if (result) await this.#options.bus.publishOutbound(result); }).catch(async error => {
          if (options.onTurnError) await options.onTurnError(error, message);
          else if (!(error instanceof Error && error.name === 'AbortError')) console.error('Agent turn failed', error);
        }).finally(() => { claim.release(); this.#deliveries.delete(delivery); });
        this.#deliveries.add(delivery); void delivery.catch(() => {});
      }
    } finally { options.signal?.removeEventListener('abort', abort); this.#intake = null; await this.drain(); }
  }
  async close(options: { cancel?: boolean; preserveInflight?: boolean } = {}): Promise<void> {
    this.#closed = true; this.#intake?.abort(new AgentLoopCancellation('Agent loop intake closed', true));
    if (options.cancel !== false) for (const jobs of this.#jobs.values()) for (const job of jobs) job.controller.abort(new AgentLoopCancellation('Agent loop shutdown', options.preserveInflight !== false));
    await this.drain();
  }
  async stopSession(key: string): Promise<number> {
    if (this.#closed) throw new Error('Agent loop is closed');
    if (this.#controlling.has(key)) throw new RuntimeBusyError('Session control is active');
    const release = this.#options.bus.admission.activity(); this.#controlling.add(key);
    try {
      const jobs = [...this.#jobs.get(key) ?? []]; for (const job of jobs) job.controller.abort(new AgentLoopCancellation('Session stopped', false));
      const before = await this.#options.state.read(key), ids = before ? pendingFollowups(before).map(message => message.metadata._recovery_followup_id).filter((id): id is string => typeof id === 'string') : [];
      await Promise.allSettled(jobs.map(job => job.task));
      const current = await this.#options.state.readHeader(key);
      if (ids.length && current && current.generation === before?.generation) await this.#options.state.acknowledgeFollowups(key, ids);
      return jobs.length;
    } finally { this.#controlling.delete(key); release(); }
  }
  restoreSession(key: string, options: { expectedGeneration?: string; signal?: AbortSignal } = {}): Promise<boolean> {
    return this.#serial(key, async controller => {
      const session = await this.#options.state.read(key); controller.signal.throwIfAborted(); if (!session) return false;
      if (options.expectedGeneration !== undefined && session.generation !== options.expectedGeneration) throw new SessionConflictError('Recovery belongs to a replaced session');
      const checkpoint = session.metadata.runtime_checkpoint;
      let changed = false;
      if (object(checkpoint) && !runtimeCheckpointIsWellFormed(checkpoint)) changed = discardRuntimeCheckpoint(session);
      else changed = restoreRuntimeCheckpoint(session);
      changed = restorePendingInterruption(session) || changed;
      if (changed) await this.#options.state.restoreInterruption(session);
      return changed;
    }, options.signal);
  }
  async scanRecovery(prefix = ''): Promise<AgentRecoveryCandidate[]> {
    if (this.#closed) throw new Error('Agent loop is closed');
    const candidates = await this.#options.state.recoveryCandidates(prefix), result: AgentRecoveryCandidate[] = [];
    for (const [key, unfinished] of candidates) {
      if (this.#tails.has(key)) continue;
      const candidate = await this.#serial(key, async () => {
        const session = await this.#options.state.read(key); if (!session) return null;
        const checkpoint = session.metadata.runtime_checkpoint, pending = Boolean(session.metadata.pending_user_turn);
        if (!object(checkpoint) && !pending && !unfinished) return null;
        const recoveryId = randomUUID(); this.#tickets.set(key, { id: recoveryId, fingerprint: recoveryFingerprint(session) });
        return { recoveryId, canContinue: object(checkpoint) ? runtimeCheckpointIsWellFormed(checkpoint) && checkpoint.phase !== 'final_response' : pending, key, generation: session.generation, phase: object(checkpoint) && typeof checkpoint.phase === 'string' ? checkpoint.phase : null, checkpointValid: object(checkpoint) && runtimeCheckpointIsWellFormed(checkpoint), pendingInput: pending, pendingFollowups: pendingFollowups(session).length, unfinishedDisplayTurn: unfinished, requiresConfirmation: !(object(checkpoint) && checkpoint.phase === 'final_response' && runtimeCheckpointIsWellFormed(checkpoint)) };
      }); if (candidate) result.push(candidate);
    }
    return result;
  }
  resumeSession(key: string, options: { recoveryId: string; confirmed: boolean; expectedGeneration: string; channel?: string; chatId?: string; signal?: AbortSignal }): Promise<OutboundMessage<AgentRuntime> | null> {
    if (options.confirmed !== true) return Promise.reject(new Error('Recovery continuation requires explicit confirmation'));
    return this.#serial(key, async controller => {
      const session = await this.#options.state.read(key), ticket = this.#tickets.get(key);
      if (!session || session.generation !== options.expectedGeneration) throw new SessionConflictError('Recovery belongs to a replaced session');
      if (!ticket || ticket.id !== options.recoveryId || ticket.fingerprint !== recoveryFingerprint(session)) throw new SessionConflictError('Recovery confirmation is stale or already consumed');
      const checkpoint = session.metadata.runtime_checkpoint;
      if (object(checkpoint) ? !runtimeCheckpointIsWellFormed(checkpoint) || checkpoint.phase === 'final_response' : !session.metadata.pending_user_turn) throw new Error('Recovery cannot continue this checkpoint');
      this.#tickets.delete(key); this.#activeResume.set(key, controller);
      try {
        return await this.#turn(new InboundMessage({ channel: options.channel ?? 'cli', chatId: options.chatId ?? 'direct', senderId: 'system', content: CONTINUATION, sessionKeyOverride: key, sessionGeneration: session.generation }), { signal: controller.signal, resume: true, publishAcceptance: false, publishCompletion: false });
      } finally { this.#activeResume.delete(key); }
    }, options.signal);
  }
  processDirect(content: string, options: DirectTurnOptions & { sessionKey?: string; channel?: string; chatId?: string; senderId?: string; media?: string[]; metadata?: Metadata } = {}): Promise<OutboundMessage<AgentRuntime> | null> {
    if (options.channel === 'system') return Promise.reject(new Error("channel 'system' is reserved for internal messages"));
    return this.processMessage(new InboundMessage({ channel: options.channel ?? 'cli', chatId: options.chatId ?? 'direct', senderId: options.senderId ?? 'user', content, media: options.media, metadata: options.metadata, sessionKeyOverride: options.sessionKey ?? 'cli:direct' }), { ...options, publishCompletion: options.publishCompletion ?? false, publishAcceptance: options.publishAcceptance ?? false });
  }
  processMessage(input: InboundMessage, options: DirectTurnOptions = {}): Promise<OutboundMessage<AgentRuntime> | null> {
    const message = cloneRecoveryInbound(input), captured = { ...options }, key = message.sessionKey;
    this.#activeResume.get(key)?.abort(new AgentLoopCancellation('Recovery superseded by new input', false));
    return this.#serial(key, controller => this.#turn(message, { ...captured, signal: controller.signal }), options.signal, options.ephemeral ? undefined : async () => { const id = await this.#options.state.queueFollowup(key, message); if (id) message.metadata._recovery_followup_id = id; });
  }
  async #turn(message: InboundMessage, options: DirectTurnOptions & { resume?: boolean }): Promise<OutboundMessage<AgentRuntime> | null> {
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
      if (restoreRuntimeCheckpoint(draft) || (!options.resume && restorePendingInterruption(draft))) await state.restoreInterruption(draft);
      const runtime = Object.freeze({ ...await this.#options.runtimeForSession(structuredClone(draft), message) }); signal.throwIfAborted();
      const baseTools = this.#options.tools, disabled = new Set(draft.policy.disabledTools);
      const tools: AgentTools = { definitions: structuredClone(baseTools.definitions.filter(item => object(item.function) && !disabled.has(String(item.function.name)))), validate: baseTools.validate.bind(baseTools), execute: baseTools.execute.bind(baseTools), concurrencySafe: baseTools.concurrencySafe?.bind(baseTools) };
      const project = options.projectWorkspace ?? await this.#options.resolveProject?.(message, structuredClone(draft)) ?? context.workspace;
      const contextOptions: ContextOptions = { projectWorkspace: project, channel: message.channel, includeMemory: !ephemeral, hasCron: !ephemeral && tools.definitions.some(item => object(item.function) && item.function.name === 'cron') };
      const history = await sessionModelHistory(draft, { dataDirectory, signal }), previousCount = draft.messages.length;
      const blocks = await this.#options.runtimeContext?.(message, structuredClone(draft)) ?? [];
      const transcript = await context.buildTranscript({ history, currentMessage: message.content, currentRole: message.isUserInput ? 'user' : 'system', media: message.media, runtimeContextBlocks: blocks, inputMetadata: options.resume ? undefined : inputMetadata(message), sessionSummary: object(draft.metadata._last_summary) && typeof draft.metadata._last_summary.text === 'string' ? { text: draft.metadata._last_summary.text, last_active: typeof draft.metadata._last_summary.last_active === 'string' ? draft.metadata._last_summary.last_active : draft.updatedAt } : null }, contextOptions);
      signal.throwIfAborted();
      const current = transcript.at(-1)!, early = !options.resume && Boolean(message.content.trim() || message.media.length || blocks.length);
      if (typeof message.metadata._recovery_followup_id === 'string') current._recovery_followup_id = message.metadata._recovery_followup_id;
      if (options.resume) { current._hidden_history = { kind: 'internal_continuation' }; draft.metadata.pending_user_turn = true; }
      if (early) { await persistAgentMessages(draft, [current], { dataDirectory }); draft.metadata.pending_user_turn = true; }
      if (!options.resume) draft.metadata.request_origin = { message_id: typeof message.metadata.message_id === 'string' ? message.metadata.message_id : null, turn_id: turnId };
      await state.prepareInput(draft); signal.throwIfAborted();
      if (options.publishAcceptance !== false) await this.#publisher.userInputAccepted(message, key);
      await this.#publisher.sessionTurnStarted(message, key); await this.#publisher.turnRuntimeAdmitted(message, key, runtime, turnId); await this.#publisher.runStatusChanged(message, key, 'running', Date.now() / 1000);
      const events = new EventSink(async (event, eventSignal) => { eventSignal?.throwIfAborted(); if (routable(event, message, options.enableStreaming === true)) await bus.publishEvent(event, message.channel, message.chatId, message.metadata); });
      const runnerEvents = events;
      const checkpoint = async (payload: AgentCheckpoint) => {
        const preceding = newSession('checkpoint'); preceding.policy = draft.policy;
        await persistAgentMessages(preceding, payload.preceding_messages.filter(row => !(object(row._hidden_history) && row._hidden_history.kind === 'internal_continuation')), { dataDirectory, storeImages: !ephemeral });
        const record: ConfigObject = { phase: payload.phase, iteration: payload.iteration, model: payload.model, assistant_message: payload.assistant_message, completed_tool_results: payload.completed_tool_results, pending_tool_calls: payload.pending_tool_calls, preceding_messages: preceding.messages, consumed_followup_ids: [...preceding.consumedFollowupIds] };
        if (Object.hasOwn(payload, 'provider_state')) { record.provider_state_checkpoint_version = 'v1'; draft.providerState = null; }
        await state.checkpointView(draft, record);
      };
      const model = new RetryingAgentModel(runtime.model, { ...this.#options.retry, events: runnerEvents });
      const result = await new AgentRunner().run({ initialMessages: transcript, model, modelName: runtime.modelName, tools, maxIterations: this.#options.maxIterations ?? 40, maxToolResultChars: this.#options.maxToolResultChars ?? 65536, maxTokens: runtime.maxTokens, temperature: runtime.temperature, reasoningEffort: runtime.reasoningEffort, contextWindowTokens: runtime.contextWindowTokens, sessionKey: key, events: runnerEvents, onCheckpoint: checkpoint, acceptedHistoryBoundary: 1 + history.length, activeSummary: object(draft.metadata._last_summary) && typeof draft.metadata._last_summary.text === 'string' ? draft.metadata._last_summary.text : null, consolidateHistory: this.#options.consolidateHistory, buildSummaryTranscript: async summary => [{ role: 'system', content: await context.buildSystemPrompt(contextOptions, { text: summary, last_active: localTimestamp() }) }] }, signal);
      const latency = Math.max(0, Math.trunc(performance.now() - started)), skip = options.resume ? transcript.length : transcript.length - (early ? 0 : 1);
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
    } catch (error) {
      if (signal.aborted && signal.reason instanceof AgentLoopCancellation && !signal.reason.preserveCheckpoint) {
        const current = await state.read(draft.key);
        if (current && current.generation === draft.generation) { restoreRuntimeCheckpoint(current); await state.finishTurn(current); }
      }
      if (options.publishCompletion !== false) await this.#publisher.turnCompleted({ channel: message.channel, chatId: message.chatId, sessionKey: key, metadata: message.metadata, runId: turnId, outcome: signal.aborted ? 'cancelled' : 'failed', failureKind: signal.aborted ? null : 'internal' });
      throw error;
    } finally { this.#publisher.clearTurn(key, turnId); await this.#publisher.runStatusChanged(message, key, 'idle'); if (temporaryKey) await state.discard(temporaryKey); }
  }
}
