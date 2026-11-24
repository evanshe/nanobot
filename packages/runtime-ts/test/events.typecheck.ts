// This file is compiled only; no invalid event is executed at runtime.
import { EventSink, MessageBus, extensionEvent } from '@nanobot/runtime';
import type { AgentEvent, EventMap } from '@nanobot/runtime';
const bus = new MessageBus();
const sink = new EventSink((event, signal) => bus.publish(event, signal));
// @ts-expect-error A known kind must carry its required payload.
void bus.publish({ kind: 'progress' });
// @ts-expect-error Known payloads cannot evade checks through scheduled delivery.
void bus.publishNowait({ kind: 'progress', content: 42 });
// @ts-expect-error Routed delivery has the same known-event contract.
void bus.publishEvent({ kind: 'runtime_model_changed', model: 'x' }, 'cli', 'chat');
// @ts-expect-error EventSink cannot accept an incomplete known event.
void sink.emit({ kind: 'progress' });
// @ts-expect-error Extensions cannot collide with known kind names.
extensionEvent('progress', {});
// @ts-expect-error Unnamespaced arbitrary kinds are not an escape hatch.
void bus.publish({ kind: 'observer', payload: {} });
// @ts-expect-error A widened string kind is not a validated forwarding type.
void bus.publish({ kind: 'progress' as string, content: 'text' });
const extension = extensionEvent('extension:observer', { detail: 'valid' });
void bus.publish(extension); void sink.emit(extension);
const progress: EventMap['progress'] = { kind: 'progress', content: 'valid' };
void bus.publish(progress); void sink.emit(progress);
function forward(event: AgentEvent): Promise<void> { return bus.publish(event); }
bus.subscribe(forward);
const typedRuntime = new MessageBus<{ model: string }>();
typedRuntime.on('turn_runtime_admitted', event => { event.runtime.model.toUpperCase(); });
void typedRuntime.publish({ kind: 'turn_runtime_admitted', runtime: { model: 'm' }, context: { channel: 'cli', chatId: 'chat', sessionKey: 'cli:chat', metadata: {}, attributes: {}, sessionGeneration: null } });
// Handoff must register ownership synchronously; an async hook is not accepted.
// @ts-expect-error asynchronous handoff cannot establish synchronous ownership
bus.consumeInbound(undefined, async () => {});
