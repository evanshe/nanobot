import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { AsyncQueue, EventSink, InboundMessage, MessageBus, NO_EVENTS, RuntimeAdmission, RuntimeBusyError, RuntimeEventPublisher, RuntimeMaintenanceError, deliveryFromContext, outboundMessageForEvent, reportedUsage } from '@nanobot/runtime';
import type { AgentEvent, EventMap, RuntimeEvent } from '@nanobot/runtime';
const fixture = JSON.parse(await readFile(new URL('./fixtures/bus-events.json', import.meta.url), 'utf8'));
const model: EventMap['runtime_model_changed'] = fixture.model;
const progress: EventMap['progress'] = fixture.progress;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('shared scenario: slow local subscriber does not block routed delivery', async () => {
  const bus = new MessageBus(); const entered = gate(), release = gate();
  bus.on('runtime_model_changed', async () => { entered.resolve(); await release.promise; });
  let complete = false;
  const dispatch = bus.publish(model).then(() => { complete = true; });
  await entered.promise;
  await bus.publishEvent(progress, fixture.route.channel, fixture.route.chatId);
  const message = await bus.consumeOutbound();
  assert.equal(message.chatId, fixture.route.chatId); assert.equal(message.content, progress.content);
  assert.equal(complete, false); assert.equal(message.event, progress);
  release.resolve(); await dispatch;
});
test('awaited handlers preserve registration order; unsubscribe affects a captured snapshot', async () => {
  const bus = new MessageBus(); const entered = gate(), release = gate(); const seen: string[] = [];
  bus.subscribe(async () => { entered.resolve(); await release.promise; seen.push('first'); });
  let disconnect = () => {};
  bus.subscribe(() => { disconnect(); });
  disconnect = bus.subscribe(() => { seen.push('disconnected'); });
  bus.subscribe(() => { seen.push('last'); });
  const dispatch = bus.publish(model); await entered.promise;
  assert.deepEqual(seen, []); release.resolve(); await dispatch;
  disconnect(); assert.deepEqual(seen, ['first', 'last']);
});
test('sync subscribers do not introduce suspension, handler failures are isolated', async () => {
  const seen: string[] = [], errors: unknown[] = [];
  const bus = new MessageBus({ onError: error => { errors.push(error); } });
  bus.subscribe(() => { seen.push('first'); throw new Error('handler failure'); });
  bus.subscribe(() => { seen.push('last'); });
  const dispatch = bus.publish(model);
  assert.deepEqual(seen, ['first', 'last']); await dispatch; assert.equal(errors.length, 1);
});
test('typed filters include subclass events and retain catch-all subscriptions', async () => {
  const bus = new MessageBus(); const seen: string[] = [];
  bus.on('progress', event => { seen.push(event.content); });
  bus.on('runtime_model_changed', event => { seen.push(event.model); });
  bus.subscribe(event => { seen.push(event.kind); });
  await bus.publish({ kind: 'file_edit', content: 'edited' } satisfies EventMap['file_edit']);
  await bus.publish(model);
  assert.deepEqual(seen, ['edited', 'file_edit', 'model', 'runtime_model_changed']);
});
test('cancellation reaches cooperative subscriber waits and skips subsequent handlers', async () => {
  const bus = new MessageBus(); const waiting = new AsyncQueue<void>(); const entered = gate(); const seen: string[] = [];
  bus.subscribe(async (_, signal) => { entered.resolve(); await waiting.get(signal); seen.push('first'); });
  bus.subscribe(() => { seen.push('second'); });
  const task = bus.publishNowait(model); await entered.promise; task.cancel();
  await assert.rejects(task.promise, { name: 'AbortError' });
  await bus.drain(); assert.deepEqual(seen, []); assert.equal(bus.hasPendingEvents, false);
});
test('cancellation retains ownership until a non-cooperative subscriber actually settles', async () => {
  const bus = new MessageBus(); const entered = gate(), release = gate();
  bus.subscribe(async () => { entered.resolve(); await release.promise; });
  const task = bus.publishNowait(model); await entered.promise; task.cancel();
  assert.equal(bus.hasPendingEvents, true);
  let drained = false; const draining = bus.drain().then(() => { drained = true; });
  await turn(); assert.equal(drained, false);
  release.resolve(); await assert.rejects(task.promise, { name: 'AbortError' }); await draining;
});
test('scheduled dispatch defers handlers, retains tasks and drains spawned dispatches', async () => {
  const bus = new MessageBus(); const entered = gate(), release = gate(); const seen: string[] = [];
  bus.on('runtime_model_changed', async event => {
    entered.resolve(); await release.promise; seen.push(event.model);
    if (event.model === 'model') bus.publishNowait({ kind: 'runtime_model_changed', model: 'followup', modelPreset: null });
  });
  const task = bus.publishNowait(model); assert.deepEqual(seen, []); assert.equal(bus.hasPendingEvents, true);
  await entered.promise; const draining = bus.drain(); release.resolve(); await draining; await task.promise;
  assert.deepEqual(seen, ['model', 'followup']); assert.equal(bus.hasPendingEvents, false); await bus.drain();
});
test('separate publications may interleave; no global event FIFO is introduced', async () => {
  const bus = new MessageBus(); const first = gate(), second = gate(); const seen: string[] = [];
  bus.on('runtime_model_changed', async event => { await (event.model === 'model' ? first : second).promise; seen.push(event.model); });
  const a = bus.publishNowait(model), b = bus.publishNowait({ ...model, model: 'second' });
  second.resolve(); await b.promise; assert.deepEqual(seen, ['second']); first.resolve(); await a.promise;
});
test('inbound/outbound FIFOs, recorder identity, event metadata copy and admission closure', async () => {
  const bus = new MessageBus(); const incoming = new InboundMessage(fixture.inbound);
  const recorded: string[] = []; bus.outboundRecorder = msg => { recorded.push(msg.content); };
  await bus.publishInbound(incoming); assert.equal(bus.inboundSize, 1);
  const resume = bus.admission.pauseBeforeStart();
  await assert.rejects(bus.publishInbound(new InboundMessage(fixture.inbound)), RuntimeMaintenanceError);
  await assert.rejects(bus.consumeInbound(), RuntimeMaintenanceError); assert.equal(bus.inboundSize, 1);
  resume();
  const claim = await bus.consumeInbound(); assert.equal(claim.message, incoming); claim.release();
  const metadata = { locale: 'en', trace: 'one' };
  await bus.publishEvent(progress, 'cli', 'one', metadata); metadata.trace = 'changed';
  await bus.publishEvent({ ...progress, content: 'two' }, 'cli', 'one');
  assert.equal(bus.outboundSize, 2); assert.deepEqual(recorded, ['working', 'two']);
  assert.equal((await bus.consumeOutbound()).metadata.trace, 'one'); assert.equal((await bus.consumeOutbound()).content, 'two');
  await bus.publishInbound(incoming); const next = await bus.consumeInbound(); assert.equal(next.message, incoming); next.release();
});
test('queue cancellation before or after wakeup never consumes accepted messages', async () => {
  const queue = new AsyncQueue<string>(); const controller = new AbortController();
  const cancelled = queue.get(controller.signal); queue.putNowait('kept'); controller.abort();
  await assert.rejects(cancelled, { name: 'AbortError' }); assert.equal(queue.size, 1); assert.equal(await queue.get(), 'kept');
  const pending = new AbortController(); const a = queue.get(pending.signal); const b = queue.get();
  pending.abort(); queue.putNowait('next'); await assert.rejects(a, { name: 'AbortError' }); assert.equal(await b, 'next');
});
test('admission busy refusal is synchronous; activity includes awaited cleanup', async () => {
  const admission = new RuntimeAdmission(); const entered = gate(), release = gate();
  const work = admission.withActivity(async () => { entered.resolve(); await release.promise; });
  await entered.promise; assert.throws(() => admission.pauseIfIdle(() => false), RuntimeBusyError); assert.equal(admission.paused, false);
  release.resolve(); await work;
  let pending = true; const remove = admission.registerPendingWork(() => pending);
  assert.throws(() => admission.pauseIfIdle(() => false), RuntimeBusyError); pending = false;
  const resume = admission.pauseIfIdle(() => false); assert.throws(() => admission.activity(), RuntimeMaintenanceError);
  resume(); resume(); remove(); remove();
  await assert.rejects(admission.withActivity(async () => { throw new Error('work failed'); }), /work failed/);
  const afterFailure = admission.pauseIfIdle(() => false); afterFailure();
});
test('maintenance wakeup, cancelled scheduler waits and exception cleanup', async () => {
  const admission = new RuntimeAdmission(); const resume = admission.pauseBeforeStart();
  const cancelled = new AbortController(); const a = admission.waitUntilOpen(cancelled.signal); const b = admission.waitUntilOpen();
  cancelled.abort(); await assert.rejects(a, { name: 'AbortError' }); resume(); await b;
  await assert.rejects(admission.withPausedIfIdle(() => false, () => { throw new Error('activation failed'); }), /activation failed/);
  assert.equal(admission.paused, false);
  assert.throws(() => admission.pauseIfIdle(() => true), RuntimeBusyError);
});
test('runtime publisher context copy, runtime identity and one-time completion metadata', async () => {
  const bus = new MessageBus(); const publisher = new RuntimeEventPublisher(bus); const seen: AgentEvent[] = [];
  bus.subscribe(event => { seen.push(event); });
  const incoming = new InboundMessage(fixture.inbound); const runtime = { runtimeId: 'runtime' };
  await publisher.sessionTurnStarted(incoming, incoming.sessionKey);
  await publisher.runStatusChanged(incoming, incoming.sessionKey, 'running', 12.5);
  await publisher.turnRuntimeAdmitted(incoming, incoming.sessionKey, runtime, 'run-1');
  publisher.recordTurnLatency(incoming.sessionKey, 123, 'run-1');
  const rounds = [reportedUsage(40, 2), reportedUsage(60, 3)]; publisher.recordTurnUsage(incoming.sessionKey, rounds, 'run-1');
  await publisher.sessionTurnPersisted(incoming, incoming.sessionKey, 'turn-1', { tenant: 'acme' });
  const completion = { channel: incoming.channel, chatId: incoming.chatId, sessionKey: incoming.sessionKey, metadata: { source: 'test' }, runId: 'run-1' };
  await publisher.turnCompleted({ ...completion, outcome: 'failed', failureKind: 'model', failureErrorKind: 'billing' });
  await publisher.turnCompleted(completion);
  const events = seen as RuntimeEvent[];
  assert.equal(events[0].kind, 'session_turn_started');
  if (events[0].kind !== 'session_turn_started' || events[2].kind !== 'turn_runtime_admitted' || events[3].kind !== 'session_turn_persisted' || events[4].kind !== 'turn_completed' || events[5].kind !== 'turn_completed') throw new Error('Unexpected event order');
  assert.deepEqual(events[0].context.metadata, incoming.metadata); assert.notEqual(events[0].context.metadata, incoming.metadata);
  assert.equal(events[0].context.sessionGeneration, 'generation-1'); assert.equal(events[2].runtime, runtime);
  assert.deepEqual(events[3].context.attributes, { tenant: 'acme' }); assert.equal(events[3].senderId, 'user');
  assert.equal(events[4].runtime, runtime); assert.equal(events[4].latencyMs, 123); assert.equal(events[4].usage?.totalTokens, 105);
  assert.equal(events[4].usage?.contextTokens, 60); assert.deepEqual(events[4].roundUsages, rounds);
  assert.equal(events[4].failureErrorKind, 'billing'); assert.equal(events[5].runtime, null); assert.equal(events[5].usage, null); assert.equal(events[5].latencyMs, null);
});
test('publisher isolates run keys and clears aborted turn metadata', async () => {
  const bus = new MessageBus(); const publisher = new RuntimeEventPublisher(bus); const seen: EventMap['turn_completed'][] = [];
  bus.on('turn_completed', event => { seen.push(event); });
  publisher.recordTurnLatency('cli:direct', 1, 'one'); publisher.recordTurnLatency('cli:direct', 2, 'two');
  publisher.clearTurn('cli:direct', 'one');
  await publisher.turnCompleted({ channel: 'cli', chatId: 'direct', sessionKey: 'cli:direct', metadata: null, runId: 'one' });
  await publisher.turnCompleted({ channel: 'cli', chatId: 'direct', sessionKey: 'cli:direct', metadata: null, runId: 'two' });
  assert.equal(seen[0].latencyMs, null); assert.equal(seen[1].latencyMs, 2);
});
test('event sink is best effort, preserves cancellation and reports consumer interest', async () => {
  assert.equal(NO_EVENTS.accepts('progress'), false); await NO_EVENTS.emit(progress);
  const errors: unknown[] = [];
  const sink = new EventSink(async () => { throw new Error('observer failed'); }, kind => kind === 'progress', error => { errors.push(error); });
  assert.equal(sink.accepts('progress'), true); assert.equal(sink.accepts('turn_end'), false); await sink.emit(progress); assert.equal(errors.length, 1);
  const controller = new AbortController(); controller.abort(); await assert.rejects(sink.emit(progress, controller.signal), { name: 'AbortError' });
  assert.equal(errors.length, 1);
});
test('delivery identity and inbound role/session derivation match Python', () => {
  assert.equal(deliveryFromContext({}, null, null), null);
  assert.throws(() => deliveryFromContext({ _delivery_run_id: 'run' }, null, null), /source session/);
  assert.deepEqual(deliveryFromContext({ _delivery_run_id: 'run' }, 'cli:direct', 'generation'), { runId: 'run', sessionKey: 'cli:direct', sessionGeneration: 'generation' });
  const system = new InboundMessage({ channel: 'system', chatId: 'cron', senderId: 'cron', content: 'tick' });
  assert.equal(system.isUserInput, false); system.inputRole = 'user'; assert.equal(system.isUserInput, true);
  system.sessionKeyOverride = 'cli:direct'; assert.equal(system.sessionKey, 'cli:direct');
});
test('shared client-event compaction phases retain localized text fallback without wire projection', async () => {
  const frames = JSON.parse(await readFile(new URL('../../client-events/fixtures.json', import.meta.url), 'utf8'));
  for (const frame of frames) {
    if (frame.event !== 'context_compaction') continue;
    const event: EventMap['context_compaction'] = { kind: 'context_compaction', compactionId: frame.compaction_id, phase: frame.phase, reason: frame.reason };
    const message = outboundMessageForEvent(event, 'cli', frame.chat_id, { locale: 'en' });
    assert.equal(message.event, event); assert.ok(message.content.length > 0);
  }
  const event: EventMap['context_compaction'] = { kind: 'context_compaction', compactionId: 'c', phase: 'succeeded' };
  assert.equal(outboundMessageForEvent(event, 'cli', 'chat', { locale: 'en' }).content, 'Context compacted.');
  assert.notEqual(outboundMessageForEvent(event, 'cli', 'chat', { locale: 'zh_TW.UTF-8' }).content, 'Context compacted.');
});
test('normal inbound consume atomically claims work before maintenance can observe an empty queue', async () => {
  const bus = new MessageBus(); const message = new InboundMessage(fixture.inbound);
  await bus.publishInbound(message);
  assert.throws(() => bus.admission.pauseIfIdle(() => false), RuntimeBusyError);
  const consuming = bus.consumeInbound();
  assert.equal(bus.inboundSize, 0);
  // The caller has not resumed from await; the dequeue already owns activity.
  assert.throws(() => bus.admission.pauseIfIdle(() => false), RuntimeBusyError);
  const claim = await consuming; assert.equal(claim.message, message);
  assert.throws(() => bus.admission.pauseIfIdle(() => false), RuntimeBusyError);
  claim.release(); claim.release();
  bus.admission.pauseIfIdle(() => false)();
  await bus.publishInbound(message);
  const failing = bus.withInbound(async accepted => { assert.equal(accepted, message); throw new Error('dispatch failed'); });
  assert.throws(() => bus.admission.pauseIfIdle(() => false), RuntimeBusyError);
  await assert.rejects(failing, /dispatch failed/);
  bus.admission.pauseIfIdle(() => false)();
});
test('synchronous inbound handoff precedes await and a rejected handoff retains the queued message', async () => {
  const bus = new MessageBus(), message = new InboundMessage(fixture.inbound); await bus.publishInbound(message);
  let handed = false;
  const failed = bus.consumeInbound(undefined, claim => { assert.equal(claim.message, message); handed = true; throw new Error('handoff rejected'); });
  assert.equal(handed, true); assert.equal(bus.inboundSize, 1); await assert.rejects(failed, /handoff rejected/);
  const claimed = bus.consumeInbound(undefined, claim => { assert.equal(claim.message, message); assert.throws(() => bus.admission.pauseIfIdle(() => false), RuntimeBusyError); return undefined; });
  assert.equal(bus.inboundSize, 0); (await claimed).release(); bus.admission.pauseIfIdle(() => false)();
});
