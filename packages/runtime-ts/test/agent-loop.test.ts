import assert from 'node:assert/strict';
import sqlite3 from 'sqlite3';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { AgentLoop, ContextBuilder, MessageBus, RuntimeBusyError, openSessionStore, InboundMessage } from '@nanobot/runtime';
import type { AgentLoopOptions, AgentRuntime, AgentModel, AgentTools, ChatRequest, ChatResponse, ChatToolCall, ConfigObject } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const definition: ConfigObject = { type: 'function', function: { name: 'echo', description: 'Synthetic output.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } };
const toolCall: ChatToolCall = { id: 'call', name: 'echo', arguments: { value: 'synthetic' }, extra_content: null, provider_specific_fields: null, function_provider_specific_fields: null };
const frame = (content: string | null, tool_calls: ChatToolCall[] = []): ChatResponse => ({ content, finish_reason: 'stop', reasoning_content: null, tool_calls, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2, cache_read_tokens: null, cache_write_tokens: null, reported_tokens: 2, estimated_tokens: 0, source: 'reported', generation_ms: 0, measured_output_tokens: 0, ttft_ms: 0, timed_requests: 0, context_tokens: 1, request_count: 1 } });
async function isolated(run: (directory: string, agent: string, builtin: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-ts-loop-')), agent = join(directory, 'agent'), builtin = join(directory, 'builtin');
  try { await mkdir(agent); await mkdir(builtin); await mkdir(join(directory, 'home')); await writeFile(join(agent, 'AGENTS.md'), 'synthetic project rules'); await run(directory, agent, builtin); } finally { await rm(directory, { recursive: true, force: true }); }
}
const registry = (): AgentTools => ({ definitions: [definition], validate: (_name, args) => typeof args.value === 'string' ? [] : ['value must be a string'], execute: async () => ({ content: 'synthetic output', status: 'ok' }) });
async function create(directory: string, agent: string, builtin: string, model: AgentModel, tools = registry(), overrides: Partial<AgentLoopOptions> = {}) {
  const store = await openSessionStore({ workspace: agent, sessionsRoot: join(directory, 'node-sessions') }), bus = new MessageBus<AgentRuntime>();
  const loop = new AgentLoop({ bus, state: store.state, context: new ContextBuilder(agent, { builtinSkillsDirectory: builtin }), dataDirectory: join(directory, 'data'), tools, runtimeForSession: async () => ({ runtimeId: 'synthetic-runtime', modelName: 'synthetic-model', model, maxTokens: 32, temperature: 0.7, contextWindowTokens: 100_000 }), maxIterations: 3, maxToolResultChars: 64, retry: { sleep: async () => {} }, ...overrides });
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
    const pending = runtime.loop.processDirect('old generation'); await reached; const old = (await runtime.store.state.get('cli:direct')).generation; await runtime.store.state.reset('cli:direct'); assert.equal(await runtime.loop.stopSession('cli:direct', { expectedGeneration: old }), 0); release(); await assert.rejects(pending, /replaced session/);
    const fresh = await runtime.store.state.get('cli:direct'); assert.notEqual(fresh.generation, old); assert.deepEqual(fresh.messages, []); assert.equal(executed, 0);
  } finally { release(); await runtime.loop.close(); await runtime.store.close(); }
}));
async function seedCheckpoint(runtime: Awaited<ReturnType<typeof create>>, key = 'cli:recover') {
  const session = await runtime.store.state.get(key); session.messages.push({ role: 'user', content: 'original request', input_id: 'user:original' }); session.metadata.pending_user_turn = true;
  await runtime.store.state.prepareInput(session);
  await runtime.store.state.checkpointView(session, { phase: 'tools_completed', iteration: 0, model: 'synthetic-model', assistant_message: { role: 'assistant', content: '', tool_calls: [{ id: 'saved', type: 'function', function: { name: 'echo', arguments: '{}' } }] }, completed_tool_results: [{ role: 'tool', tool_call_id: 'saved', name: 'echo', content: 'actual saved result' }], pending_tool_calls: [], preceding_messages: [], provider_state_checkpoint_version: 'v1' });
  return session.generation;
}
test('recovery scan is read-only and concurrent same-session restores materialize one checkpoint', async () => isolated(async (directory, agent, builtin) => {
  let models = 0; const runtime = await create(directory, agent, builtin, { chatStream: async () => { models++; return frame('never'); } });
  try {
    const generation = await seedCheckpoint(runtime), before = await runtime.store.state.read('cli:recover');
    const candidates = await runtime.loop.scanRecovery('cli:'); assert.equal(candidates.length, 1); assert.equal(candidates[0].checkpointValid, true); assert.equal(candidates[0].requiresConfirmation, true);
    assert.deepEqual(await runtime.store.state.read('cli:recover'), before);
    assert.deepEqual(await Promise.all([runtime.loop.restoreSession('cli:recover'), runtime.loop.restoreSession('cli:recover')]), [true, false]);
    const saved = await runtime.store.state.get('cli:recover'); assert.deepEqual(saved.messages.map(row => row.role), ['user', 'assistant', 'tool']); assert.equal(saved.messages[2].content, 'actual saved result'); assert.equal(models, 0);
    await runtime.store.state.reset(saved.key); await assert.rejects(runtime.loop.restoreSession(saved.key, { expectedGeneration: generation }), /replaced session/);
  } finally { await runtime.loop.close(); await runtime.store.close(); }
}));
for (const shutdown of [false, true]) test(`explicit stop and shutdown retain distinct checkpoint ownership: shutdown=${shutdown}`, async () => isolated(async (directory, agent, builtin) => {
  let entered!: () => void, requests = 0; const reached = new Promise<void>(resolve => { entered = resolve; });
  const runtime = await create(directory, agent, builtin, { chatStream: async (_request, _callbacks, signal) => {
    if (++requests === 1) return frame(null, [toolCall]); entered(); await new Promise<never>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); throw new Error('unreachable');
  } });
  try {
    const pending = runtime.loop.processDirect('request'); await reached;
    const draft = await runtime.store.state.get('cli:direct');
    await runtime.store.state.queueFollowup(draft.key, new InboundMessage({ channel: 'websocket', chatId: 'direct', senderId: 'user', content: 'accepted follow-up', sessionKeyOverride: draft.key, sessionGeneration: draft.generation }));
    if (shutdown) await runtime.loop.close(); else assert.equal(await runtime.loop.stopSession(draft.key), 1);
    await assert.rejects(pending, shutdown ? /shutdown/ : /stopped/);
    const saved = await runtime.store.state.get(draft.key); assert.equal(Boolean(saved.metadata.pending_user_turn), shutdown); assert.equal(Boolean(saved.metadata.runtime_checkpoint), shutdown);
    assert.equal(Boolean(saved.metadata.pending_user_followups), shutdown);
    if (!shutdown) assert.equal(saved.messages.find(row => row.role === 'tool')?.content, 'synthetic output');
    assert.equal(requests, 2);
    const resume = runtime.bus.admission.pauseIfIdle(() => false); resume();
  } finally { await runtime.loop.close(); await runtime.store.close(); }
}));
test('stop retains activity until a cancellation-suppressing model settles before releasing the next draft', async () => isolated(async (directory, agent, builtin) => {
  let entered!: () => void, release!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const runtime = await create(directory, agent, builtin, { chatStream: async () => { entered(); await blocked; return frame('late answer must not commit'); } });
  try {
    const pending = runtime.loop.processDirect('request'); await reached;
    let stopped = false; const stopping = runtime.loop.stopSession('cli:direct').then(() => { stopped = true; }); await new Promise(resolve => setImmediate(resolve));
    assert.equal(stopped, false); assert.throws(() => runtime.bus.admission.pauseIfIdle(() => false), RuntimeBusyError);
    await assert.rejects(runtime.loop.restoreSession('cli:direct'), /control is active/);
    release(); await stopping; await assert.rejects(pending, /stopped/);
    assert.deepEqual((await runtime.store.state.get('cli:direct')).messages.map(row => row.content), ['request']);
    const resume = runtime.bus.admission.pauseIfIdle(() => false); resume();
  } finally { release(); await runtime.loop.close(); await runtime.store.close(); }
}));
test('explicit recovery confirmation is single-use and preserves saved tool results and origin', async () => isolated(async (directory, agent, builtin) => {
  let models = 0, executions = 0; const requests: ChatRequest[] = [], tools = registry(); tools.execute = async () => { executions++; return { content: 'unexpected', status: 'ok' }; };
  const runtime = await create(directory, agent, builtin, { chatStream: async request => { models++; requests.push(request); return frame('continued'); } }, tools);
  try {
    const generation = await seedCheckpoint(runtime), session = await runtime.store.state.get('cli:recover'); session.metadata.request_origin = { message_id: 'original', turn_id: 'original-turn' }; await runtime.store.state.prepareInput(session);
    const [candidate] = await runtime.loop.scanRecovery(); assert.equal(candidate.canContinue, true);
    const confirmation = { recoveryId: candidate.recoveryId, expectedGeneration: generation, confirmed: true };
    await assert.rejects(runtime.loop.resumeSession(session.key, { ...confirmation, confirmed: false }), /explicit confirmation/); assert.equal(models, 0);
    const outcomes = await Promise.allSettled([runtime.loop.resumeSession(session.key, confirmation), runtime.loop.resumeSession(session.key, confirmation)]);
    assert.equal(outcomes[0].status, 'fulfilled'); assert.equal(outcomes[1].status, 'rejected'); assert.equal(models, 1); assert.equal(executions, 0);
    assert.match(JSON.stringify(requests[0].messages), /actual saved result/); assert.match(String(requests[0].messages.at(-1)?.content), /Continue the interrupted request/);
    const saved = await runtime.store.state.get(session.key); assert.deepEqual(saved.metadata.request_origin, { message_id: 'original', turn_id: 'original-turn' });
    assert.equal(saved.messages.filter(row => row.content === 'actual saved result').length, 1); assert.equal(saved.messages.at(-1)?.content, 'continued'); assert.doesNotMatch(JSON.stringify(saved.messages), /Continue the interrupted request/);
  } finally { await runtime.loop.close(); await runtime.store.close(); }
}));
test('recovery tickets reject changed content, stale generations and final-response continuation', async () => isolated(async (directory, agent, builtin) => {
  let models = 0; const runtime = await create(directory, agent, builtin, { chatStream: async () => { models++; return frame('never'); } });
  try {
    const generation = await seedCheckpoint(runtime); let [candidate] = await runtime.loop.scanRecovery();
    await runtime.store.state.updateMetadata(candidate.key, { extra: 'changed' });
    await assert.rejects(runtime.loop.resumeSession(candidate.key, { recoveryId: candidate.recoveryId, expectedGeneration: generation, confirmed: true }), /stale/);
    [candidate] = await runtime.loop.scanRecovery(); await runtime.store.state.reset(candidate.key);
    await assert.rejects(runtime.loop.resumeSession(candidate.key, { recoveryId: candidate.recoveryId, expectedGeneration: generation, confirmed: true }), /replaced/);
    await seedCheckpoint(runtime); const draft = await runtime.store.state.get(candidate.key); (draft.metadata.runtime_checkpoint as ConfigObject).phase = 'final_response'; await runtime.store.state.prepareInput(draft);
    [candidate] = await runtime.loop.scanRecovery(); assert.equal(candidate.canContinue, false); await assert.rejects(runtime.loop.resumeSession(candidate.key, { recoveryId: candidate.recoveryId, expectedGeneration: draft.generation, confirmed: true }), /cannot continue/); assert.equal(models, 0);
  } finally { await runtime.loop.close(); await runtime.store.close(); }
}));
test('new input cancels recovery and waits for an uncooperative request before reading its draft', async () => isolated(async (directory, agent, builtin) => {
  let entered!: () => void, release!: () => void, count = 0; const reached = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const runtime = await create(directory, agent, builtin, { chatStream: async request => { if (++count === 1) { entered(); await blocked; return frame('late recovery'); } assert.match(JSON.stringify(request.messages), /actual saved result/); return frame('fresh answer'); } });
  try {
    const generation = await seedCheckpoint(runtime), [candidate] = await runtime.loop.scanRecovery();
    const recovery = runtime.loop.resumeSession(candidate.key, { recoveryId: candidate.recoveryId, expectedGeneration: generation, confirmed: true }); await reached;
    const fresh = runtime.loop.processDirect('fresh input', { sessionKey: candidate.key }); await new Promise(resolve => setImmediate(resolve)); assert.equal(count, 1);
    release(); await assert.rejects(recovery, /superseded/); assert.equal((await fresh)?.content, 'fresh answer');
    const saved = await runtime.store.state.get(candidate.key); assert.doesNotMatch(JSON.stringify(saved.messages), /late recovery/); assert.equal(saved.messages.filter(row => row.content === 'actual saved result').length, 1);
  } finally { release(); await runtime.loop.close(); await runtime.store.close(); }
}));

test('shutdown drains an accepted checkpoint blocked by a real SQLite writer before releasing activity', { timeout: 6000 }, async () => isolated(async (directory, agent, builtin) => {
  let lock!: () => Promise<void>, entered!: () => void, executions = 0; const reached = new Promise<void>(resolve => { entered = resolve; });
  const tools = registry(); tools.execute = async () => { executions++; return { content: 'never', status: 'ok' }; };
  const runtime = await create(directory, agent, builtin, { chatStream: async () => { await lock(); return frame(null, [toolCall]); } }, tools);
  const locker = await new Promise<sqlite3.Database>((resolve, reject) => { const db = new sqlite3.Database(join(runtime.store.location.sessionsDirectory, 'sessions.sqlite3'), error => error ? reject(error) : resolve(db)); });
  const native = (sql: string) => new Promise<void>((resolve, reject) => locker.exec(sql, error => error ? reject(error) : resolve()));
  let locked = false; lock = async () => { await native('BEGIN IMMEDIATE'); locked = true; };
  const checkpoint = runtime.store.state.checkpointView.bind(runtime.store.state);
  runtime.store.state.checkpointView = (draft, payload, signal) => { const accepted = checkpoint(draft, payload, signal); if (payload.phase === 'awaiting_tools') entered(); return accepted; };
  try {
    const task = runtime.loop.processDirect('accepted input'); const rejection = assert.rejects(task, /shutdown/); await reached;
    let closed = false; const closing = runtime.loop.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false); assert.throws(() => runtime.bus.admission.pauseIfIdle(() => false), RuntimeBusyError);
    await native('COMMIT'); locked = false; await rejection; await closing; assert.equal(executions, 0);
    const saved = await runtime.store.state.get('cli:direct'); assert.equal((saved.metadata.runtime_checkpoint as ConfigObject).phase, 'tools_completed'); assert.equal(((saved.metadata.runtime_checkpoint as ConfigObject).completed_tool_results as ConfigObject[])[0]._recovery_interrupted, true); assert.equal(saved.metadata.pending_user_turn, true);
    await runtime.store.close(); const reopened = await openSessionStore({ workspace: agent, sessionsRoot: join(directory, 'node-sessions') });
    try { const persisted = await reopened.state.get(saved.key); assert.deepEqual(persisted.metadata.runtime_checkpoint, saved.metadata.runtime_checkpoint); assert.equal(persisted.messages[0].content, 'accepted input'); } finally { await reopened.close(); }
    const resume = runtime.bus.admission.pauseIfIdle(() => false); resume();
  } finally { if (locked) await native('ROLLBACK'); await new Promise<void>((resolve, reject) => locker.close(error => error ? reject(error) : resolve())); await runtime.loop.close(); await runtime.store.close(); }
}));
test('bus intake owns dequeue through ordered execution and outbound enqueue without blocking other keys', async () => isolated(async (directory, agent, builtin) => {
  let entered!: () => void, release!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [], errors: unknown[] = [], runtime = await create(directory, agent, builtin, { chatStream: async request => { const content = String(request.messages.at(-1)?.content); seen.push(content); if (content === 'first') { entered(); await blocked; } return frame(`answer:${content}`); } });
  const intake = new AbortController();
  try {
    await runtime.bus.publishInbound(new InboundMessage({ channel: 'cli', chatId: 'a', senderId: 'user', content: 'first' }));
    const running = runtime.loop.run({ signal: intake.signal, onTurnError: error => { errors.push(error); } });
    assert.throws(() => runtime.bus.admission.pauseIfIdle(() => false), RuntimeBusyError); await reached;
    await assert.rejects(runtime.loop.run(), /already running/);
    for (const [chatId, content] of [['a', 'second'], ['b', 'other']]) await runtime.bus.publishInbound(new InboundMessage({ channel: 'cli', chatId, senderId: 'user', content }));
    let other;
    do { other = await runtime.bus.consumeOutbound(); } while (other.content !== 'answer:other');
    assert.deepEqual(seen, ['first', 'other']); intake.abort(); release(); await running;
    assert.deepEqual(seen, ['first', 'other', 'second']); assert.deepEqual(errors, []);
    assert.deepEqual((await runtime.store.state.get('cli:a')).messages.filter(row => row.role === 'user').map(row => row.content), ['first', 'second']);
    await runtime.bus.drain(); while (runtime.bus.outboundSize) await runtime.bus.consumeOutbound();
    const resume = runtime.bus.admission.pauseIfIdle(() => false); resume();
  } finally { intake.abort(); release(); await runtime.loop.close(); await runtime.store.close(); }
}));
test('closing the loop wakes an empty bus intake and waits for accepted cancellation', async () => isolated(async (directory, agent, builtin) => {
  const runtime = await create(directory, agent, builtin, { chatStream: async () => frame('unused') });
  try { const running = runtime.loop.run(); await runtime.loop.close(); await running; assert.equal(runtime.bus.inboundSize, 0); }
  finally { await runtime.loop.close(); await runtime.store.close(); }
}));
test('accepted websocket inputs are journaled while queued and remain recoverable after shutdown', async () => isolated(async (directory, agent, builtin) => {
  let entered!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; });
  const runtime = await create(directory, agent, builtin, { chatStream: async (_request, _callbacks, signal) => { entered(); await new Promise<never>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); throw new Error('unreachable'); } });
  try {
    const first = runtime.loop.processDirect('first', { channel: 'websocket', sessionKey: 'websocket:journal' }); const firstRejected = assert.rejects(first, /shutdown/); await reached;
    const second = runtime.loop.processDirect('queued', { channel: 'websocket', sessionKey: 'websocket:journal' }); const secondRejected = assert.rejects(second, /shutdown/);
    // Queue the read after the synchronously accepted journal admission microtask.
    await new Promise(resolve => setImmediate(resolve)); const queued = await runtime.store.state.get('websocket:journal');
    assert.equal((queued.metadata.pending_user_followups as ConfigObject[]).length, 1); assert.match(JSON.stringify(queued.metadata.pending_user_followups), /queued/);
    await runtime.loop.close(); await Promise.all([firstRejected, secondRejected]); await runtime.store.close();
    const reopened = await openSessionStore({ workspace: agent, sessionsRoot: join(directory, 'node-sessions') });
    try { const saved = await reopened.state.get(queued.key); assert.match(JSON.stringify(saved.metadata.pending_user_followups), /queued/); assert.equal(saved.messages.filter(row => row.content === 'first').length, 1); assert.equal(saved.messages.filter(row => row.content === 'queued').length, 0); } finally { await reopened.close(); }
  } finally { await runtime.loop.close(); await runtime.store.close(); }
}));
test('successful queued websocket inputs acknowledge journal ids only when their input is committed', async () => isolated(async (directory, agent, builtin) => {
  const runtime = await create(directory, agent, builtin, { chatStream: async () => frame('answer') });
  try {
    await Promise.all(['first', 'second'].map(content => runtime.loop.processDirect(content, { channel: 'websocket', sessionKey: 'websocket:journal' })));
    const saved = await runtime.store.state.get('websocket:journal'); assert.equal(saved.metadata.pending_user_followups, undefined); assert.equal(saved.metadata.pending_user_turn, undefined);
    assert.deepEqual(saved.messages.filter(row => row.role === 'user').map(row => row.content), ['first', 'second']);
  } finally { await runtime.loop.close(); await runtime.store.close(); }
}));
test('busy loop injects a complete ordered input snapshot and commits each journal once', async () => isolated(async (directory, agent, builtin) => {
  let entered!: () => void, release!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const requests: ChatRequest[] = [], runtime = await create(directory, agent, builtin, { chatStream: async request => { requests.push(structuredClone(request)); if (requests.length === 1) { entered(); await blocked; return frame('first answer'); } return frame('batch answer'); } });
  try {
    const first = runtime.loop.processDirect('first', { channel: 'websocket', sessionKey: 'websocket:inbox' }); await reached;
    const followups = ['second', 'third'].map(content => runtime.loop.processDirect(content, { channel: 'websocket', sessionKey: 'websocket:inbox', allowInjection: true }));
    await new Promise(resolve => setImmediate(resolve)); release(); assert.equal((await first)?.content, 'batch answer'); assert.deepEqual(await Promise.all(followups), [null, null]);
    assert.equal(requests.length, 2); assert.match(String(requests[1].messages.at(-1)?.content), /second\n\nthird/);
    const saved = await runtime.store.state.get('websocket:inbox'); assert.deepEqual(saved.messages.filter(row => row.role === 'user').map(row => row.content), ['first', 'second', 'third']);
    assert.equal(saved.metadata.pending_user_followups, undefined); assert.equal(saved.messages.filter(row => row.content === 'first answer').length, 1);
  } finally { release(); await runtime.loop.close(); await runtime.store.close(); }
}));
test('a non-injectable command is a FIFO barrier for later ordinary inputs', async () => isolated(async (directory, agent, builtin) => {
  let entered!: () => void, release!: () => void; const reached = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [], runtime = await create(directory, agent, builtin, { chatStream: async request => { const content = String(request.messages.at(-1)?.content); seen.push(content); if (seen.length === 1) { entered(); await blocked; } return frame('answer'); } });
  try {
    const first = runtime.loop.processDirect('first'); await reached;
    const command = runtime.loop.processDirect('/synthetic', { allowInjection: true }), later = runtime.loop.processDirect('later', { allowInjection: true });
    release(); await Promise.all([first, command, later]); assert.deepEqual(seen, ['first', '/synthetic', 'later']);
  } finally { release(); await runtime.loop.close(); await runtime.store.close(); }
}));

test('failed inbox conversion leaves the entire snapshot available to later ordered execution', async () => isolated(async (directory, agent, builtin) => {
  let entered!: () => void, release!: () => void, fail = true; const reached = new Promise<void>(resolve => { entered = resolve; }), blocked = new Promise<void>(resolve => { release = resolve; });
  const requests: ChatRequest[] = [], runtime = await create(directory, agent, builtin, { chatStream: async request => { requests.push(structuredClone(request)); if (requests.length === 1) { entered(); await blocked; } return frame('answer'); } }, registry(), { runtimeContext: async message => { if (message.content === 'third' && fail) { fail = false; throw new Error('synthetic conversion failure'); } return []; } });
  try {
    const first = runtime.loop.processDirect('first', { channel: 'websocket' }); await reached;
    const followups = ['second', 'third'].map(content => runtime.loop.processDirect(content, { channel: 'websocket', allowInjection: true }));
    await new Promise(resolve => setImmediate(resolve)); release(); await first; await Promise.all(followups);
    const saved = await runtime.store.state.get('cli:direct'); assert.deepEqual(saved.messages.filter(row => row.role === 'user').map(row => row.content), ['first', 'second', 'third']); assert.equal(saved.metadata.pending_user_followups, undefined);
    assert.equal(requests.length, 2); assert.match(String(requests[1].messages.at(-1)?.content), /second\n\nthird/);
  } finally { release(); await runtime.loop.close(); await runtime.store.close(); }
}));
test('bus /stop bypasses the session queue, drains active work and emits the structured receipt', async () => isolated(async (directory, agent, builtin) => {
  let entered!: () => void, calls = 0; const reached = new Promise<void>(resolve => { entered = resolve; });
  const runtime = await create(directory, agent, builtin, { chatStream: async (_request, _callbacks, signal) => { calls++; entered(); await new Promise<never>((_resolve, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true })); throw new Error('unreachable'); } });
  const intake = new AbortController(), errors: unknown[] = [], running = runtime.loop.run({ signal: intake.signal, onTurnError: error => { errors.push(error); } });
  try {
    await runtime.bus.publishInbound(new InboundMessage({ channel: 'websocket', chatId: 'stop', senderId: 'user', content: 'first' })); await reached;
    await runtime.bus.publishInbound(new InboundMessage({ channel: 'websocket', chatId: 'stop', senderId: 'user', content: 'queued' }));
    await runtime.bus.publishInbound(new InboundMessage({ channel: 'websocket', chatId: 'stop', senderId: 'user', content: '/stop', metadata: { locale: 'zh-CN' } }));
    let reply; do { reply = await runtime.bus.consumeOutbound(); } while (reply.event?.kind !== 'command_result');
    assert.deepEqual(reply.event, { kind: 'command_result', command: '/stop', parts: [{ key: 'stop.done', values: {} }], outcome: 'stopped' }); assert.equal(reply.content, ''); assert.equal(reply.metadata.locale, 'zh-CN');
    assert.equal(calls, 1); assert.equal(errors.length, 2); const saved = await runtime.store.state.get('websocket:stop'); assert.equal(saved.metadata.pending_user_followups, undefined); assert.equal(saved.metadata.pending_user_turn, undefined);
    const idle = await runtime.loop.processDirect('/stop', { sessionKey: 'websocket:stop' }); assert.equal(idle?.event?.kind, 'command_result'); assert.equal(calls, 1);
  } finally { intake.abort(); await running; await runtime.loop.close(); await runtime.store.close(); }
}));
test('recovery scan includes a journal-only accepted input before its first turn starts', async () => isolated(async (directory, agent, builtin) => {
  let calls = 0; const runtime = await create(directory, agent, builtin, { chatStream: async () => { calls++; return frame('never'); } });
  try {
    await runtime.store.state.queueFollowup('websocket:only-queued', new InboundMessage({ channel: 'websocket', chatId: 'only-queued', senderId: 'user', content: 'accepted but not started' }));
    const [candidate] = await runtime.loop.scanRecovery('websocket:'); assert.equal(candidate.key, 'websocket:only-queued'); assert.equal(candidate.pendingFollowups, 1); assert.equal(candidate.pendingInput, false); assert.equal(candidate.canContinue, false); assert.equal(candidate.requiresConfirmation, true); assert.equal(calls, 0);
    await runtime.loop.stopSession(candidate.key); assert.deepEqual(await runtime.loop.scanRecovery('websocket:'), []);
  } finally { await runtime.loop.close(); await runtime.store.close(); }
}));

test('an immediate stop drains accepted journal admissions before acknowledging their ids', async () => isolated(async (directory, agent, builtin) => {
  let calls = 0; const runtime = await create(directory, agent, builtin, { chatStream: async () => { calls++; return frame('never'); } });
  try {
    const inputs = ['first', 'second'].map(content => runtime.loop.processDirect(content, { channel: 'websocket', sessionKey: 'websocket:immediate' }));
    const stopped = runtime.loop.processDirect('/stop', { channel: 'websocket', sessionKey: 'websocket:immediate' });
    const outcomes = await Promise.allSettled(inputs); assert.ok(outcomes.every(item => item.status === 'rejected')); await stopped;
    const saved = await runtime.store.state.get('websocket:immediate'); assert.equal(saved.metadata.pending_user_followups, undefined); assert.deepEqual(saved.messages, []); assert.equal(calls, 0);
  } finally { await runtime.loop.close(); await runtime.store.close(); }
}));
