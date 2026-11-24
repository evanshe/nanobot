import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { AgentLoop, ContextBuilder, MessageBus, RuntimeBusyError, openSessionStore } from '@nanobot/runtime';
import type { AgentRuntime, AgentModel, AgentTools, ChatRequest, ChatResponse, ChatToolCall, ConfigObject } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const definition: ConfigObject = { type: 'function', function: { name: 'echo', description: 'Synthetic output.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } };
const toolCall: ChatToolCall = { id: 'call', name: 'echo', arguments: { value: 'synthetic' }, extra_content: null, provider_specific_fields: null, function_provider_specific_fields: null };
const frame = (content: string | null, tool_calls: ChatToolCall[] = []): ChatResponse => ({ content, finish_reason: 'stop', reasoning_content: null, tool_calls, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cache_read_tokens: null, cache_write_tokens: null, reported_tokens: 2, estimated_tokens: 0, source: 'reported', generation_ms: 0, measured_output_tokens: 0, ttft_ms: 0, timed_requests: 0, context_tokens: 1, request_count: 1 } });
async function isolated(run: (directory: string, agent: string, builtin: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-ts-loop-')), agent = join(directory, 'agent'), builtin = join(directory, 'builtin');
  try { await mkdir(agent); await mkdir(builtin); await mkdir(join(directory, 'home')); await writeFile(join(agent, 'AGENTS.md'), 'synthetic project rules'); await run(directory, agent, builtin); } finally { await rm(directory, { recursive: true, force: true }); }
}
const registry = (): AgentTools => ({ definitions: [definition], validate: (_name, args) => typeof args.value === 'string' ? [] : ['value must be a string'], execute: async () => ({ content: 'synthetic output', status: 'ok' }) });
async function create(directory: string, agent: string, builtin: string, model: AgentModel, tools = registry()) {
  const store = await openSessionStore({ workspace: agent, sessionsRoot: join(directory, 'node-sessions') }), bus = new MessageBus<AgentRuntime>();
  const loop = new AgentLoop({ bus, state: store.state, context: new ContextBuilder(agent, { builtinSkillsDirectory: builtin }), dataDirectory: join(directory, 'data'), tools, runtimeForSession: async () => ({ runtimeId: 'synthetic-runtime', modelName: 'synthetic-model', model, maxTokens: 32, temperature: 0.7, contextWindowTokens: 100_000 }), maxIterations: 3, maxToolResultChars: 64, retry: { sleep: async () => {} } });
  return { store, bus, loop };
}
function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'timestamp' ? '<generated>' : key === 'latency_ms' ? '<latency>' : normalize(item)]));
  return value;
}
async function oracle(input: object, home: string) {
  const child = spawn(process.env.NANOBOT_TEST_PYTHON ?? join(root, '.venv/bin/python'), [fileURLToPath(new URL('./agent-loop-reference.py', import.meta.url))], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, PYTHONPATH: root } });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.stdin.end(JSON.stringify({ ...input, node_identity: `Node ${process.versions.node}` })); const [status] = await once(child, 'close'); assert.equal(status, 0, stderr); return JSON.parse(stdout);
}
test('normal direct loop persists a tool turn, reopens and captures the same next request as Python', { timeout: 20_000 }, async () => isolated(async (directory, agent, builtin) => {
  const responses = [frame('working', [toolCall]), frame('first done'), frame('second done')], requests: ChatRequest[] = [], outputs: string[] = []; let index = 0;
  const model: AgentModel = { chatStream: async request => { requests.push(structuredClone(request)); return responses[index++]; } };
  let runtime = await create(directory, agent, builtin, model), generation = '';
  try { outputs.push((await runtime.loop.processDirect('first'))!.content); generation = (await runtime.store.state.get('cli:direct')).generation; } finally { await runtime.loop.close(); await runtime.store.close(); }
  runtime = await create(directory, agent, builtin, model);
  try {
    outputs.push((await runtime.loop.processDirect('second'))!.content); const session = await runtime.store.state.get('cli:direct'); assert.equal(session.generation, generation); assert.equal(session.metadata.pending_user_turn, undefined); assert.equal(session.metadata.runtime_checkpoint, undefined);
    const expected = await oracle({ agent, builtin, sessions: join(directory, 'python-sessions'), inputs: ['first', 'second'], responses }, join(directory, 'home'));
    assert.deepEqual(normalize({ requests: requests.map(request => ({ messages: request.messages, tools: request.tools ?? null, model: request.model, max_tokens: request.max_tokens, temperature: request.temperature, reasoning_effort: request.reasoning_effort ?? null })), outputs, messages: session.messages }), normalize(expected));
  } finally { await runtime.loop.close(); await runtime.store.close(); }
}));
test('same-session direct calls stay ordered while another session runs and maintenance sees accepted work', async () => isolated(async (directory, agent, builtin) => {
  let started!: () => void, release!: () => void; const reached = new Promise<void>(resolve => { started = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; }); const seen: string[] = [];
  const runtime = await create(directory, agent, builtin, { chatStream: async request => { const content = String(request.messages.at(-1)?.content); seen.push(content); if (content === 'first') { started(); await blocked; } return frame(`answer:${content}`); } });
  try {
    const first = runtime.loop.processDirect('first', { sessionKey: 'cli:a' }); await reached;
    const second = runtime.loop.processDirect('second', { sessionKey: 'cli:a' }), other = runtime.loop.processDirect('other', { sessionKey: 'cli:b' }); await other;
    assert.deepEqual(seen, ['first', 'other']); assert.throws(() => runtime.bus.admission.pauseIfIdle(() => false), RuntimeBusyError);
    release(); await Promise.all([first, second]); assert.deepEqual(seen, ['first', 'other', 'second']);
    assert.deepEqual((await runtime.store.state.get('cli:a')).messages.map(row => row.content), ['first', 'answer:first', 'second', 'answer:second']);
    const resume = runtime.bus.admission.pauseIfIdle(() => false); resume();
  } finally { release(); await runtime.loop.close(); await runtime.store.close(); }
}));
test('temporary direct turns exclude durable messages and leave the parent store unchanged', async () => isolated(async (directory, agent, builtin) => {
  const requests: ChatRequest[] = [], runtime = await create(directory, agent, builtin, { chatStream: async request => { requests.push(request); return frame('answer'); } });
  try {
    await runtime.loop.processDirect('durable secret'); const before = await runtime.store.state.get('cli:direct');
    await runtime.loop.processDirect('temporary', { ephemeral: true }); const after = await runtime.store.state.get('cli:direct');
    assert.deepEqual(after, before); assert.doesNotMatch(JSON.stringify(requests[1].messages), /durable secret/); assert.match(String(requests[1].messages[0].content), /temporary session/);
    assert.equal((await runtime.store.state.listSessions()).filter(row => row.key.startsWith('temporary:')).length, 0);
  } finally { await runtime.loop.close(); await runtime.store.close(); }
}));
test('a reset during a model request rejects its late checkpoint before any tool can execute', async () => isolated(async (directory, agent, builtin) => {
  let started!: () => void, release!: () => void, executed = 0; const reached = new Promise<void>(resolve => { started = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const tools = registry(); tools.execute = async () => { executed++; return { content: 'never', status: 'ok' }; };
  const runtime = await create(directory, agent, builtin, { chatStream: async () => { started(); await blocked; return frame(null, [toolCall]); } }, tools);
  try {
    const pending = runtime.loop.processDirect('old generation'); await reached; const old = (await runtime.store.state.get('cli:direct')).generation; await runtime.store.state.reset('cli:direct'); release(); await assert.rejects(pending, /replaced session/);
    const fresh = await runtime.store.state.get('cli:direct'); assert.notEqual(fresh.generation, old); assert.deepEqual(fresh.messages, []); assert.equal(executed, 0);
  } finally { release(); await runtime.loop.close(); await runtime.store.close(); }
}));
