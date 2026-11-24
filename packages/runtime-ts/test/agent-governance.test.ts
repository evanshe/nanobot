import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { AgentRunner, AgentContextGovernor, EventSink, prepareAgentMessages, appendRuntimeContext } from '@nanobot/runtime';
import type { ConfigObject, ChatRequest, ChatResponse, AgentEvent } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
async function reference(script: string, input: object) {
  const child = spawn(join(root, '.venv/bin/python'), [fileURLToPath(new URL(script, import.meta.url))], { cwd: root, env: { ...process.env, PYTHONPATH: root } });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.stdin.end(JSON.stringify(input)); const [status] = await once(child, 'close'); assert.equal(status, 0, stderr); return JSON.parse(stdout);
}
const wireCall = (id: string, name: string) => ({ id, type: 'function', function: { name, arguments: '{}' } });
test('model-facing cleanup, tool-result budgets and context-aware merges match Python without changing raw history', async () => {
  const a = appendRuntimeContext('left', [{ source: 'one', content: '[one]' }]), b = appendRuntimeContext('right', [{ source: 'two', content: '[two]' }]);
  const messages: ConfigObject[] = [
    { role: 'system', content: 'synthetic' }, { role: 'assistant', content: '[Previous assistant message omitted.]', tool_calls: [] },
    { role: 'assistant', content: '', tool_calls: [wireCall('bad', ''), wireCall('ok', 'echo'), wireCall('lost', 'echo')] },
    { role: 'tool', tool_call_id: 'bad', content: 'orphaned malformed' }, { role: 'tool', tool_call_id: 'ok', name: 'echo', content: '🙂'.repeat(20) }, { role: 'tool', tool_call_id: 'ok', content: 'duplicate' },
    { role: 'user', content: a.content, _meta: { runtime_context: a.marker! } }, { role: 'user', content: b.content, _meta: { runtime_context: b.marker! } },
    { role: 'user', content: 'hidden', _hidden_history: true }, { role: 'user', content: 'next' },
    { role: 'user', content: 'boundary', _meta: { provider_state_boundary: true } },
  ];
  const before = structuredClone(messages), actual = prepareAgentMessages(messages, 8);
  assert.deepEqual(actual, await reference('./agent-governance-reference.py', { messages, limit: 8 })); assert.deepEqual(messages, before);
  assert.ok(actual.some(message => String(message.content).includes('left\n\nright\n\n[one]\n\n[two]')));
});
test('context compaction rewrites only accepted model history and retains a durable summary boundary', async () => {
  const messages: ConfigObject[] = [{ role: 'system', content: 'system' }, { role: 'user', content: 'x'.repeat(1800) }], before = structuredClone(messages), requests: ChatRequest[] = [], events: AgentEvent[] = [];
  const response: ChatResponse = { content: 'done', finish_reason: 'stop', reasoning_content: null, tool_calls: [], usage: null };
  const result = await new AgentRunner().run({ initialMessages: messages, tools: { definitions: [], validate: () => [], execute: async () => { throw new Error('no tools'); } }, modelName: 'synthetic', model: { chatStream: async request => { requests.push(request); return response; } }, maxIterations: 1, maxToolResultChars: 64, maxTokens: 32, contextWindowTokens: 1500, consolidateHistory: async history => { assert.deepEqual(history, messages); return 'short summary'; }, events: new EventSink(async event => { events.push(event); }) });
  assert.deepEqual(messages, before); assert.deepEqual(result.messages.slice(0, 2), before); assert.deepEqual(result.summary_checkpoint, { summary: 'short summary', transcript_boundary: 2 });
  assert.match(String(requests[0].messages[0].content), /short summary/); assert.equal(requests[0].messages[1].content, 'Continue the active task from the working-memory checkpoint above.');
  const oracle = await reference('./agent-runner-reference.py', { messages, responses: [response], context_window_tokens: 1500, summary_text: 'short summary' });
  // The oracle's registered synthetic tool schema is part of its request; its
  // normalized compaction prefix and preserved raw transcript remain identical.
  assert.deepEqual(requests[0].messages, oracle.requests[0].messages); assert.deepEqual(result.messages, oracle.messages);
  assert.deepEqual(events.filter(event => event.kind === 'context_compaction').map(event => event.phase), ['started', 'succeeded']);
});
test('only pending oversized read results can be replaced after summary and the complete request fits', async () => {
  const initial: ConfigObject[] = [{ role: 'system', content: 'system' }, { role: 'user', content: 'accepted history' }], events: AgentEvent[] = [];
  const governor = new AgentContextGovernor(initial, { contextWindowTokens: 1800, maxTokens: 32, maxToolResultChars: 16, consolidateHistory: async () => 'summary', events: new EventSink(async event => { events.push(event); }) });
  const raw: ConfigObject[] = [...structuredClone(initial), { role: 'assistant', content: '', tool_calls: [wireCall('read', 'read_file')] }, { role: 'tool', tool_call_id: 'read', name: 'read_file', content: 'r'.repeat(2000) }];
  const prepared = await governor.prepare(raw, [], new AbortController().signal);
  assert.match(String(raw.at(-1)?.content), /result was not sent/); assert.equal(prepared.at(-1)?.content, raw.at(-1)?.content); assert.deepEqual(raw.slice(0, 2), initial);
  assert.deepEqual(governor.summaryCheckpoint, { summary: 'summary', transcript_boundary: 2 }); assert.equal(events.filter(event => event.kind === 'context_compaction' && event.phase === 'succeeded').length, 1);
  const failing = new AgentContextGovernor(initial, { contextWindowTokens: 1040, maxTokens: 32, maxToolResultChars: 16, consolidateHistory: async () => 'summary' }); const untouched = structuredClone(raw);
  await assert.rejects(failing.prepare(untouched, [], new AbortController().signal), /context budget/); assert.deepEqual(untouched, raw); assert.equal(failing.summaryCheckpoint, null);
});
test('matching provider usage is authoritative while a non-positive input budget always rejects', async () => {
  const initial: ConfigObject[] = [{ role: 'system', content: 'system' }, { role: 'user', content: 'input' }];
  const governor = new AgentContextGovernor(initial, { contextWindowTokens: 1500, maxTokens: 32, maxToolResultChars: 16, estimatePromptTokens: () => 1000 });
  const usage = { input_tokens: 1, output_tokens: 1, total_tokens: 2, cache_read_tokens: null, cache_write_tokens: null, reported_tokens: 2, estimated_tokens: 0, source: 'reported' as const, generation_ms: 0, measured_output_tokens: 0, ttft_ms: 0, timed_requests: 0, context_tokens: 1, request_count: 1 };
  governor.accept(2, initial, { content: null, reasoning_content: null, tool_calls: [], finish_reason: 'stop', usage }, []);
  assert.deepEqual(await governor.prepare(structuredClone(initial), [], new AbortController().signal), initial);
  const noBudget = new AgentContextGovernor(initial, { contextWindowTokens: 1024, maxTokens: 32, maxToolResultChars: 16, estimatePromptTokens: () => 1 });
  await assert.rejects(noBudget.prepare(structuredClone(initial), [], new AbortController().signal), /1\/0/);
});
