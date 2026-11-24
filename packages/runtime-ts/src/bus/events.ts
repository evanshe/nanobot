import type { Json } from '../config/decoder.ts';
import type { LLMUsage } from './usage.ts';
export interface AgentEvent { readonly kind: string }
export type Metadata = Record<string, Json>;
export type RuntimeEventContext = Readonly<{
  channel: string; chatId: string; sessionKey: string;
  metadata: Metadata; attributes: Metadata; sessionGeneration: string | null;
}>;
// The model runtime owner supplies its own concrete type through the publisher generic.
export type RuntimeReference = Readonly<{ runtimeId: string }>;
export type ResponseSource = Readonly<{ provider: string; model: string; preset: string; fallback?: boolean }>;
export type Completion = Readonly<{
  latencyMs?: number | null; usage?: LLMUsage | null; roundUsages?: readonly LLMUsage[];
  outcome?: string; failureKind?: string | null; failureErrorKind?: string | null;
  failureAttempts?: number | null;
}>;
export type Progress = Readonly<{
  content: string; toolHint?: boolean; reasoning?: boolean; reasoningDelta?: boolean; reasoningEnd?: boolean;
  streamId?: string | null; toolEvents?: Metadata[] | null; fileEditEvents?: Metadata[] | null;
}>;
export type CommandPart = Readonly<{ key: string; values: Record<string, string | number>; prefix?: string }> | Readonly<{ text: string }>;
type EventPayloads<R> = {
  model_request: { requestId: string; runId: string; sequence: number; phase: 'started' | 'completed' | 'failed' | 'cancelled'; usage?: LLMUsage | null; roundUsages?: readonly LLMUsage[]; contextWindowTokens?: number | null; requestUsage?: LLMUsage | null; responseInputIds?: readonly string[] };
  response_inputs: { inputIds: readonly string[] };
  response_source: { source: ResponseSource | null; content?: string | null };
  context_compaction: { compactionId: string; phase: 'started' | 'succeeded' | 'failed' | 'cancelled'; notify?: boolean; reason?: 'idle' | 'context_pressure' | 'manual' | 'provider_native' | null };
  retry_wait: { content: string };
  retry_status: { state: 'waiting' | 'recovered' | 'cleared' | 'exhausted'; attempt: number; maxAttempts: number | null; errorKind: string; nextRetryAt?: number | null };
  recovery_state: { status: string; recoveryId: string; reason?: string | null; attempts?: number; canContinue?: boolean | null; failureErrorKind?: string | null; replyPreserved?: boolean | null };
  progress: Progress;
  file_edit: Progress;
  stream_delta: { content: string; streamId?: string | null };
  stream_end: { content: string; streamId?: string | null; resuming?: boolean; mergeNext?: boolean };
  streamed_response: Record<never, never>;
  side_channel_reply: { notificationId?: string | null };
  command_result: { command: string; parts: readonly CommandPart[]; notificationId?: string | null };
  turn_end: Completion & { contextWindowTokens?: number | null; goalState?: Metadata | null; failureMessage?: string | null };
  goal_status: { status: string; startedAt?: number | null };
  goal_state_sync: { goalState: Metadata };
  session_updated: { scope?: string | null };
  user_input: { content: string; createdAtMs: number; inputId: string; provenance: Metadata };
  runtime_model_updated: { model: string | null; modelPreset?: string | null };
  turn_model_updated: { model: string; modelPreset?: string | null; contextWindowTokens?: number | null; fallback?: boolean; reauthProvider?: string | null };
  session_turn_started: { context: RuntimeEventContext };
  user_input_accepted: { context: RuntimeEventContext; content: string };
  turn_runtime_admitted: { context: RuntimeEventContext; runtime: R };
  turn_run_status_changed: { context: RuntimeEventContext; status: string; startedAt?: number | null };
  turn_completed: Completion & { context: RuntimeEventContext; runtime?: R | null };
  session_turn_persisted: { context: RuntimeEventContext; turnId: string; senderId: string };
  goal_state_changed: { context: RuntimeEventContext; sessionMetadata?: Metadata };
  subagent_task_changed: { context: RuntimeEventContext; taskId: string };
  runtime_model_changed: { model: string; modelPreset: string | null };
};
export type EventMap<R = RuntimeReference> = { [K in keyof EventPayloads<R>]: Readonly<{ kind: K } & EventPayloads<R>[K]> };
export type RuntimeEvent<R = RuntimeReference> = EventMap<R>[keyof EventMap<R>];
export type EventForKind<K extends keyof EventMap<R>, R = RuntimeReference> = K extends 'progress' ? EventMap<R>['progress'] | EventMap<R>['file_edit'] : K extends 'side_channel_reply' ? EventMap<R>['side_channel_reply'] | EventMap<R>['command_result'] : EventMap<R>[K];
export function isEventKind<K extends keyof EventMap<R>, R = RuntimeReference>(event: AgentEvent, kind: K): event is EventForKind<K, R> {
  return event.kind === kind || (kind === 'progress' && event.kind === 'file_edit') || (kind === 'side_channel_reply' && event.kind === 'command_result');
}
export type DeliveryRequest = Readonly<{ runId: string; sessionKey: string; sessionGeneration: string | null }>;
export function deliveryFromContext(metadata: Metadata, sessionKey: string | null, generation: string | null): DeliveryRequest | null {
  const runId = metadata._delivery_run_id;
  if (typeof runId !== 'string' || !runId) return null;
  if (!sessionKey) throw new Error('Scheduled delivery requires a source session');
  return { runId, sessionKey, sessionGeneration: generation };
}
export type InboundOptions = {
  channel: string; senderId: string; chatId: string; content: string;
  timestamp?: Date; media?: string[]; metadata?: Metadata; sessionKeyOverride?: string | null;
  requireExistingSession?: boolean; inputRole?: 'user' | 'system' | null; sessionGeneration?: string | null;
};
export class InboundMessage {
  channel: string; senderId: string; chatId: string; content: string; timestamp: Date;
  media: string[]; metadata: Metadata; sessionKeyOverride: string | null; requireExistingSession: boolean;
  inputRole: 'user' | 'system' | null; sessionGeneration: string | null;
  constructor(options: InboundOptions) {
    this.channel = options.channel; this.senderId = options.senderId; this.chatId = options.chatId; this.content = options.content;
    this.timestamp = options.timestamp ?? new Date(); this.media = options.media ?? []; this.metadata = options.metadata ?? {};
    this.sessionKeyOverride = options.sessionKeyOverride ?? null; this.requireExistingSession = options.requireExistingSession ?? false;
    this.inputRole = options.inputRole ?? null; this.sessionGeneration = options.sessionGeneration ?? null;
  }
  get sessionKey(): string { return this.sessionKeyOverride || `${this.channel}:${this.chatId}`; }
  get isUserInput(): boolean { return this.inputRole !== null ? this.inputRole === 'user' : this.channel !== 'system'; }
}
export type OutboundMessage = {
  channel: string; chatId: string; content: string; replyTo?: string | null; media?: string[];
  metadata: Metadata; buttons?: string[][]; event?: AgentEvent | null;
  delivery?: DeliveryRequest | null; deliveryId?: string | null;
};
