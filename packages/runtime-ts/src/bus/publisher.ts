import type { MessageBus, ScheduledDispatch } from './index.ts';
import type { Completion, EventMap, InboundMessage, Metadata, RuntimeEventContext, RuntimeReference } from './events.ts';
import { addUsage } from './usage.ts';
import type { LLMUsage } from './usage.ts';
const turnKey = (sessionKey: string, runId: string | null) => JSON.stringify([sessionKey, runId]);
export class RuntimeEventPublisher<R = RuntimeReference> {
  readonly bus: MessageBus<R>;
  #latency = new Map<string, number>();
  #runtime = new Map<string, R>();
  #usage = new Map<string, LLMUsage>();
  #rounds = new Map<string, readonly LLMUsage[]>();
  constructor(bus: MessageBus<R>) { this.bus = bus; }
  #context(channel: string, chatId: string, sessionKey: string, metadata: Metadata | null,
           attributes: Metadata = {}, sessionGeneration: string | null = null): RuntimeEventContext {
    return { channel, chatId, sessionKey, metadata: { ...metadata }, attributes: { ...attributes }, sessionGeneration };
  }
  #fromMessage(message: InboundMessage, sessionKey: string, attributes?: Metadata): RuntimeEventContext {
    return this.#context(message.channel, message.chatId, sessionKey, message.metadata, attributes, message.sessionGeneration);
  }
  recordTurnRuntime(sessionKey: string, runtime: R, runId: string | null = null): void { this.#runtime.set(turnKey(sessionKey, runId), runtime); }
  recordTurnLatency(sessionKey: string, latencyMs: number | null, runId: string | null = null): void {
    if (latencyMs !== null) this.#latency.set(turnKey(sessionKey, runId), Math.trunc(latencyMs));
  }
  recordTurnUsage(sessionKey: string, rounds: readonly LLMUsage[], runId: string | null = null): void {
    if (!rounds.length) return;
    const key = turnKey(sessionKey, runId);
    this.#usage.set(key, rounds.slice(1).reduce(addUsage, rounds[0])); this.#rounds.set(key, [...rounds]);
  }
  clearTurn(sessionKey: string, runId: string | null = null): void {
    const key = turnKey(sessionKey, runId);
    this.#latency.delete(key); this.#runtime.delete(key); this.#usage.delete(key); this.#rounds.delete(key);
  }
  userInputAccepted(message: InboundMessage, sessionKey: string): Promise<void> {
    return this.bus.publish({ kind: 'user_input_accepted', context: this.#fromMessage(message, sessionKey), content: message.content } satisfies EventMap<R>['user_input_accepted']);
  }
  sessionTurnStarted(message: InboundMessage, sessionKey: string): Promise<void> {
    return this.bus.publish({ kind: 'session_turn_started', context: this.#fromMessage(message, sessionKey) } satisfies EventMap<R>['session_turn_started']);
  }
  turnRuntimeAdmitted(message: InboundMessage, sessionKey: string, runtime: R, runId: string | null = null): Promise<void> {
    this.recordTurnRuntime(sessionKey, runtime, runId);
    return this.bus.publish({ kind: 'turn_runtime_admitted', context: this.#fromMessage(message, sessionKey), runtime } satisfies EventMap<R>['turn_runtime_admitted']);
  }
  runStatusChanged(message: InboundMessage, sessionKey: string, status: string, startedAt: number | null = null): Promise<void> {
    return this.bus.publish({ kind: 'turn_run_status_changed', context: this.#fromMessage(message, sessionKey), status, startedAt } satisfies EventMap<R>['turn_run_status_changed']);
  }
  sessionTurnPersisted(message: InboundMessage, sessionKey: string, turnId: string, attributes?: Metadata): Promise<void> {
    return this.bus.publish({ kind: 'session_turn_persisted', context: this.#fromMessage(message, sessionKey, attributes), turnId, senderId: message.senderId } satisfies EventMap<R>['session_turn_persisted']);
  }
  turnCompleted(options: { channel: string; chatId: string; sessionKey: string; metadata: Metadata | null; runId?: string | null } & Pick<Completion, 'outcome' | 'failureKind' | 'failureErrorKind' | 'failureAttempts'>): Promise<void> {
    const key = turnKey(options.sessionKey, options.runId ?? null);
    const event: EventMap<R>['turn_completed'] = {
      kind: 'turn_completed', context: this.#context(options.channel, options.chatId, options.sessionKey, options.metadata),
      latencyMs: this.#latency.get(key) ?? null, runtime: this.#runtime.get(key) ?? null,
      usage: this.#usage.get(key) ?? null, roundUsages: this.#rounds.get(key) ?? [],
      outcome: options.outcome ?? 'completed', failureKind: options.failureKind ?? null,
      failureErrorKind: options.failureErrorKind ?? null, failureAttempts: options.failureAttempts ?? null,
    };
    this.clearTurn(options.sessionKey, options.runId);
    return this.bus.publish(event);
  }
  runtimeModelChanged(model: string, modelPreset: string | null): ScheduledDispatch {
    return this.bus.publishNowait({ kind: 'runtime_model_changed', model, modelPreset } satisfies EventMap<R>['runtime_model_changed']);
  }
}
