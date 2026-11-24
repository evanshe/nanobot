import { AsyncQueue } from './queue.ts';
import { RuntimeAdmission } from './admission.ts';
import { isEventKind } from './events.ts';
import type { AgentEvent, EventForKind, EventMap, InboundMessage, Metadata, OutboundMessage, RuntimeReference } from './events.ts';
import { outboundMessageForEvent } from './outbound.ts';
export * from './events.ts';
export * from './admission.ts';
export * from './queue.ts';
export * from './outbound.ts';
export * from './usage.ts';
export * from './publisher.ts';
export type EventHandler<E extends AgentEvent = AgentEvent> = (event: E, signal: AbortSignal) => void | Promise<void>;
export type ScheduledDispatch = { readonly promise: Promise<void>; cancel(reason?: unknown): void };
type Entry = { active: boolean; handle: EventHandler };
export class MessageBus<R = RuntimeReference> {
  readonly admission: RuntimeAdmission;
  readonly inbound = new AsyncQueue<InboundMessage>();
  readonly outbound = new AsyncQueue<OutboundMessage>();
  #handlers: Entry[] = [];
  #pending = new Set<Promise<void>>();
  #onError: (error: unknown, event: AgentEvent) => void;
  outboundRecorder: ((message: OutboundMessage) => void) | null = null;
  constructor(options: { admission?: RuntimeAdmission; onError?: (error: unknown, event: AgentEvent) => void } = {}) {
    this.admission = options.admission ?? new RuntimeAdmission();
    this.#onError = options.onError ?? ((error, event) => console.error(`Event handler failed for ${event.kind}`, error));
  }
  get inboundSize(): number { return this.inbound.size; }
  get outboundSize(): number { return this.outbound.size; }
  get hasPendingEvents(): boolean { return this.#pending.size > 0; }
  async publishInbound(message: InboundMessage): Promise<void> {
    this.admission.check(); this.inbound.putNowait(message); // No suspension between admission and enqueue.
  }
  consumeInbound(signal?: AbortSignal): Promise<InboundMessage> { return this.inbound.get(signal); }
  async publishOutbound(message: OutboundMessage): Promise<void> {
    this.outboundRecorder?.(message); this.outbound.putNowait(message);
  }
  consumeOutbound(signal?: AbortSignal): Promise<OutboundMessage> { return this.outbound.get(signal); }
  async publishEvent<E extends AgentEvent>(event: E, channel: string, chatId: string, metadata?: Metadata): Promise<void> {
    await this.publishOutbound(outboundMessageForEvent(event, channel, chatId, metadata));
  }
  subscribe(handler: EventHandler): () => void {
    const entry: Entry = { active: true, handle: handler };
    this.#handlers.push(entry);
    return () => {
      if (!entry.active) return;
      entry.active = false; this.#handlers.splice(this.#handlers.indexOf(entry), 1);
    };
  }
  on<K extends keyof EventMap<R>>(kind: K, handler: EventHandler<EventForKind<K, R>>): () => void {
    return this.subscribe((event, signal) => { if (isEventKind<K, R>(event, kind)) return handler(event, signal); });
  }
  async publish<E extends AgentEvent>(event: E, signal: AbortSignal = new AbortController().signal): Promise<void> {
    signal.throwIfAborted();
    for (const entry of [...this.#handlers]) {
      if (!entry.active) continue;
      try { const result = entry.handle(event, signal); if (result !== undefined) await result; }
      catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        this.#onError(error, event);
      }
      signal.throwIfAborted();
    }
  }
  publishNowait<E extends AgentEvent>(event: E): ScheduledDispatch {
    const controller = new AbortController();
    // Python create_task also defers the first subscriber until the next loop turn.
    const promise = Promise.resolve().then(() => this.publish(event, controller.signal));
    this.#pending.add(promise);
    const settled = () => { this.#pending.delete(promise); };
    void promise.then(settled, settled); // Retain failures for the task caller without unhandled rejection.
    return { promise, cancel: reason => controller.abort(reason) };
  }
  async drain(): Promise<void> {
    while (this.#pending.size) {
      const pending = [...this.#pending];
      await Promise.allSettled(pending);
      for (const task of pending) this.#pending.delete(task);
    }
  }
}
export class EventSink {
  readonly #publish: ((event: AgentEvent, signal?: AbortSignal) => Promise<void>) | null;
  readonly #accepts: ((kind: string) => boolean) | null;
  readonly #onError: (error: unknown, event: AgentEvent) => void;
  constructor(publish: ((event: AgentEvent, signal?: AbortSignal) => Promise<void>) | null = null,
              accepts: ((kind: string) => boolean) | null = null,
              onError: (error: unknown, event: AgentEvent) => void = (error, event) => console.error(`Failed to publish ${event.kind}`, error)) {
    this.#publish = publish; this.#accepts = accepts; this.#onError = onError;
  }
  accepts(kind: string): boolean { return this.#publish !== null && (this.#accepts === null || this.#accepts(kind)); }
  async emit<E extends AgentEvent>(event: E, signal?: AbortSignal): Promise<void> {
    if (!this.#publish) return;
    signal?.throwIfAborted();
    try { await this.#publish(event, signal); }
    catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      this.#onError(error, event);
    }
    signal?.throwIfAborted();
  }
}
export const NO_EVENTS = new EventSink();
