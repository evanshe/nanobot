import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AgentRunner, EventSink, ContextWindowExceededError, estimateAgentPromptBytes } from '@nanobot/runtime';
import type { AgentRunSpec, AgentTools, AgentCheckpoint, ChatRequest, ChatResponse, ChatToolCall, ConfigObject, AgentEvent } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const definition: ConfigObject = { type: 'function', function: { name: 'echo', description: 'Return synthetic fixture output.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } };
const call = (id = 'call'): ChatToolCall => ({ id, name: 'echo', arguments: { value: 'synthetic' }, extra_content: null, provider_specific_fields: null, function_provider_specific_fields: null });
const frame = (content: string | null, tool_calls: ChatToolCall[] = [], finish_reason = 'stop'): ChatResponse => ({ content, tool_calls, finish_reason, reasoning_content: null, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cache_read_tokens: null, cache_write_tokens: null, reported_tokens: 2, estimated_tokens: 0, source: 'reported', generation_ms: 0, measured_output_tokens: 0, ttft_ms: 0, timed_requests: 0, context_tokens: 1, request_count: 1 } });
async function oracle(input: object): Promise<unknown> {
  const child = spawn(join(root, '.venv/bin/python'), [fileURLToPath(new URL('./agent-runner-reference.py', import.meta.url))], { cwd: root, env: { ...process.env, PYTHONPATH: root } });
  let stdout = '', stderr = ''; child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; }); child.stdin.end(JSON.stringify(input));
  const [status] = await once(child, 'close'); assert.equal(status, 0, stderr); return JSON.parse(stdout);
}
function setup(responses: ChatResponse[], overrides: Partial<AgentRunSpec> = {}) {
  const requests: ChatRequest[] = [], checkpoints: AgentCheckpoint[] = [], executed: ConfigObject[] = [], events: AgentEvent[] = []; let index = 0;
  const tools: AgentTools = { definitions: [definition], validate: (_name, args) => typeof args.value === 'string' ? [] : ['value must be a string'], execute: async (_name, args) => { executed.push(args); return { content: 'synthetic output', status: 'ok' }; } };
  const spec: AgentRunSpec = { initialMessages: [{ role: 'user', content: 'synthetic input' }], modelName: 'synthetic-model', tools, maxIterations: 3, maxToolResultChars: 64, maxTokens: 32, contextWindowTokens: 100_000, onCheckpoint: async value => { checkpoints.push(value); }, events: new EventSink(async event => { events.push(event); }), model: { chatStream: async request => { requests.push(structuredClone(request)); return structuredClone(responses[Math.min(index++, responses.length - 1)]); } }, ...overrides };
  return { spec, requests, checkpoints, executed, events };
}
function comparable(requests: ChatRequest[]) {
  return requests.map(request => ({ messages: request.messages, tools: request.tools ?? null, model: request.model, max_tokens: request.max_tokens, temperature: request.temperature, reasoning_effort: request.reasoning_effort ?? null }));
}
for (const [name, responses, overrides] of [
  ['tool result and final answer', [frame('working', [call()]), frame('done')], {}],
  ['budget exhausted no-tools finalization', [frame('working', [call()]), frame('incomplete next step')], { maxIterations: 1 }],
  ['budget fallback rejects finalizer tool calls', [frame('working', [call()])], { maxIterations: 1 }],
  ['blank replies recover with no-tools prompt', [frame(null), frame(null), frame('recovered')], {}],
  ['policy terminal blocks tool execution', [frame('cannot', [call()], 'refusal')], {}],
  ['checkpoints retain earlier tool rounds', [frame(null, [call('first')]), frame(null, [call('second')]), frame('done')], {}],
] as const) {
  test(`runner Python parity: ${name}`, { timeout: 15_000 }, async () => {
    const state = setup([...responses], overrides), actual = await new AgentRunner().run(state.spec);
    const reference = await oracle({ responses, max_iterations: overrides.maxIterations });
    assert.deepEqual({ final_content: actual.final_content, messages: actual.messages, stop_reason: actual.stop_reason, error: actual.error, tools_used: actual.tools_used, tool_events: actual.tool_events, requests: comparable(state.requests), checkpoints: state.checkpoints, executed: state.executed, usage: actual.usage ? { input_tokens: actual.usage.inputTokens, output_tokens: actual.usage.outputTokens, total_tokens: actual.usage.totalTokens, request_count: actual.usage.requestCount } : null }, reference);
    const phases = state.events.filter(event => event.kind === 'model_request').map(event => event.phase); assert.deepEqual(phases, state.requests.flatMap(() => ['started', 'completed']));
  });
}
test('context budget fails before model work and retains already settled tool results', async () => {
  const state = setup([frame(null, [call()])], { contextWindowTokens: 1100 });
  assert.equal(estimateAgentPromptBytes([{ role: 'user', content: '🙂' }]), 8);
  state.spec.initialMessages = [{ role: 'system', content: 'x'.repeat(1000) }, { role: 'user', content: 'synthetic' }];
  await assert.rejects(new AgentRunner().run(state.spec), ContextWindowExceededError); assert.equal(state.requests.length, 0); assert.equal(state.executed.length, 0);
  const reference = await oracle({ responses: [frame('never')], messages: state.spec.initialMessages, context_window_tokens: 1100 });
  assert.deepEqual(reference, { exception: 'ContextWindowExceededError', requests: [], executed: [] });
});
test('runner owns a cancellation-suppressing model until settled and never starts its tools', async () => {
  const controller = new AbortController(), state = setup([frame('never')]);
  let started!: () => void, release!: () => void; const reached = new Promise<void>(resolve => { started = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  state.spec.model = { chatStream: async () => { started(); await held; return frame(null, [call()]); } };
  let settled = false; const pending = new AgentRunner().run(state.spec, controller.signal).finally(() => { settled = true; });
  await reached; controller.abort(new DOMException('synthetic model cancellation', 'AbortError')); await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  release(); await assert.rejects(pending, /synthetic model cancellation/); assert.equal(state.executed.length, 0);
  assert.deepEqual(state.events.filter(event => event.kind === 'model_request').map(event => event.phase), ['started', 'cancelled']);
});
test('cancelled tool batches checkpoint actual settled results and explicit unknown outcomes before releasing ownership', async () => {
  const controller = new AbortController(), state = setup([frame(null, [call('first'), call('second')])]); let count = 0, started!: () => void;
  const reached = new Promise<void>(resolve => { started = resolve; });
  state.spec.tools.execute = async (_name, _args, signal) => {
    if (++count === 1) return { content: 'actual settled result', status: 'ok' };
    started(); await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })); throw new Error('unreachable');
  };
  const pending = new AgentRunner().run(state.spec, controller.signal); await reached; controller.abort(new DOMException('synthetic tool cancellation', 'AbortError'));
  await assert.rejects(pending, /synthetic tool cancellation/); assert.equal(state.requests.length, 1);
  const checkpoint = state.checkpoints.at(-1)!; assert.equal(checkpoint.phase, 'tools_completed');
  assert.equal(checkpoint.completed_tool_results[0].content, 'actual settled result'); assert.equal(checkpoint.completed_tool_results[1]._recovery_interrupted, true);
  assert.match(String(checkpoint.completed_tool_results[1].content), /outcome is unknown/);
});
test('only adjacent explicitly concurrency-safe tools overlap; exclusive calls and persisted rows preserve order', async () => {
  const names = ['read_a', 'read_b', 'write_stub', 'read_c'], calls = names.map((name, index) => ({ ...call(String(index)), name }));
  const state = setup([frame(null, calls), frame('done')], { concurrentTools: true }); const log: string[] = []; let active = 0;
  state.spec.tools = { definitions: names.map(name => ({ ...definition, function: { ...definition.function as ConfigObject, name } })), validate: () => [], concurrencySafe: name => name.startsWith('read'), execute: async name => {
    if (name === 'write_stub') assert.equal(active, 0); active++; log.push(`start:${name}`);
    await new Promise(resolve => setImmediate(resolve)); active--; log.push(`end:${name}`); return { content: name, status: 'ok' };
  } };
  const result = await new AgentRunner().run(state.spec);
  assert.deepEqual(log.slice(0, 2), ['start:read_a', 'start:read_b']); assert.ok(log.indexOf('start:write_stub') > log.indexOf('end:read_b')); assert.ok(log.indexOf('start:read_c') > log.indexOf('end:write_stub'));
  assert.deepEqual(result.messages.filter(message => message.role === 'tool').map(message => message.name), names);
});
test('follow-up context rejection retains the accepted tool checkpoint, and checkpoint failure blocks unstarted tools', async () => {
  const state = setup([frame(null, [call()])], { contextWindowTokens: 1200, estimatePromptTokens: messages => messages.some(message => message.role === 'tool') ? 1000 : 1 });
  await assert.rejects(new AgentRunner().run(state.spec), ContextWindowExceededError); assert.equal(state.requests.length, 1); assert.equal(state.executed.length, 1);
  assert.equal(state.checkpoints.at(-1)?.completed_tool_results[0].content, 'synthetic output');
  const blocked = setup([frame(null, [call()])], { onCheckpoint: async () => { throw new Error('checkpoint rejected'); } });
  await assert.rejects(new AgentRunner().run(blocked.spec), /checkpoint rejected/); assert.equal(blocked.executed.length, 0);
});
test('normal runner entry emits model/text/reasoning/tool progress and rejects malformed execution arguments', async () => {
  const state = setup([frame(null, [{ ...call(), arguments: '{value:"bad"}' }]), frame('done')]); let index = 0;
  state.spec.model = { chatStream: async (request, callbacks) => {
    state.requests.push(structuredClone(request)); await callbacks?.onContentDelta?.('live', new AbortController().signal); await callbacks?.onThinkingDelta?.('thought', new AbortController().signal);
    return index++ ? frame('done') : frame(null, [{ ...call(), arguments: '{value:"bad"}' }]);
  } };
  const result = await new AgentRunner().run(state.spec); assert.equal(state.executed.length, 0);
  assert.equal((result.messages.find(message => Array.isArray(message.tool_calls))!.tool_calls as ConfigObject[])[0].function && ((result.messages.find(message => Array.isArray(message.tool_calls))!.tool_calls as ConfigObject[])[0].function as ConfigObject).arguments, '{value:"bad"}');
  assert.match(String(result.messages.find(message => message.role === 'tool')?.content), /parameters must be a JSON object/);
  assert.ok(state.events.some(event => event.kind === 'stream_delta' && event.content === 'live')); assert.ok(state.events.some(event => event.kind === 'progress' && event.reasoningDelta));
});
