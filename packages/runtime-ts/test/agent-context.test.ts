import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { ContextBuilder, AgentRunner } from '@nanobot/runtime';
import type { ConfigObject, ChatRequest, TranscriptInput, ContextOptions } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
async function oracle(input: object): Promise<ConfigObject[]> {
  const child = spawn(join(root, '.venv/bin/python'), [fileURLToPath(new URL('./agent-context-reference.py', import.meta.url))], { cwd: root, env: { ...process.env, PYTHONPATH: root } });
  let stdout = '', stderr = ''; child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; }); child.stdin.end(JSON.stringify({ ...input, node_identity: `Node ${process.versions.node}` })); const [status] = await once(child, 'close'); assert.equal(status, 0, stderr); return JSON.parse(stdout);
}
async function isolated(run: (agent: string, project: string, builtin: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-ts-context-')), agent = join(directory, 'agent'), project = join(directory, 'project'), builtin = join(directory, 'builtin');
  try { for (const path of [agent, project, builtin]) await mkdir(path); await run(agent, project, builtin); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function skill(directory: string, name: string, body: string, meta = '') {
  await mkdir(join(directory, name), { recursive: true }); await writeFile(join(directory, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Synthetic ${name}\n${meta}---\n${body}`);
}
const noTools = { definitions: [], validate: () => [], execute: async () => { throw new Error('No real tools allowed'); } };
test('separate project/bootstrap/memory/skills roots match Python in captured first and resumed model requests', { timeout: 15_000 }, async () => isolated(async (agent, project, builtin) => {
  await writeFile(join(agent, 'AGENTS.md'), 'agent project rules must not leak'); await writeFile(join(agent, 'SOUL.md'), 'agent soul\r\n'); await writeFile(join(agent, 'USER.md'), 'agent user');
  await writeFile(join(project, 'AGENTS.md'), 'project rules 中文🙂'); await writeFile(join(project, 'SOUL.md'), 'project soul collision'); await mkdir(join(agent, 'memory')); await writeFile(join(agent, 'memory/MEMORY.md'), 'agent memory');
  await mkdir(join(project, 'memory')); await writeFile(join(project, 'memory/MEMORY.md'), 'project memory collision');
  await skill(join(agent, 'skills'), 'z-first', 'first active', 'always: true\n'); await skill(join(agent, 'skills'), 'a-second', 'explicit turn skill'); await skill(builtin, 'built-in', 'builtin instruction');
  const history: ConfigObject[] = [{ role: 'user', content: 'previous' }, { role: 'assistant', content: 'answer' }];
  for (const resumed of [false, true]) {
    const input: TranscriptInput = { history: resumed ? history : [], currentMessage: '$a-second task', inputMetadata: { input_id: 'fixed-input' }, runtimeContextBlocks: [{ source: 'synthetic', content: '[bounded metadata]' }], sessionSummary: { text: 'archived synthetic', last_active: '2026-01-01' } };
    const builder = new ContextBuilder(agent, { builtinSkillsDirectory: builtin }), transcript = await builder.buildTranscript(input, { projectWorkspace: project, channel: 'cli' });
    assert.deepEqual(transcript, await oracle({ agent, project, builtin, history: input.history, current: input.currentMessage, blocks: input.runtimeContextBlocks, input_metadata: input.inputMetadata, summary: input.sessionSummary, channel: 'cli' }));
    const captured: ChatRequest[] = []; await new AgentRunner().run({ initialMessages: transcript, modelName: 'synthetic', model: { chatStream: async request => { captured.push(request); return { content: 'done', reasoning_content: null, finish_reason: 'stop', tool_calls: [], usage: null }; } }, tools: noTools, maxIterations: 1, maxToolResultChars: 64 });
    assert.deepEqual(captured[0].messages, transcript); assert.match(String(captured[0].messages[0].content), /Node /); assert.doesNotMatch(String(transcript[0].content), /agent project rules|project soul collision|project memory collision/);
  }
}));
test('temporary context excludes saved profile, memory and memory/cron skills while retaining project and other skills', { timeout: 10_000 }, async () => isolated(async (agent, project, builtin) => {
  await writeFile(join(agent, 'SOUL.md'), 'private profile'); await writeFile(join(agent, 'USER.md'), 'private user'); await mkdir(join(agent, 'memory')); await writeFile(join(agent, 'memory/MEMORY.md'), 'private memory'); await writeFile(join(project, 'AGENTS.md'), 'project rules');
  for (const name of ['memory', 'cron', 'review']) await skill(join(agent, 'skills'), name, `${name} instruction`, 'always: true\n');
  const options: ContextOptions = { projectWorkspace: project, includeMemory: false, hasCron: false }, input: TranscriptInput = { history: [], currentMessage: '$memory $cron $review' };
  const transcript = await new ContextBuilder(agent, { builtinSkillsDirectory: builtin }).buildTranscript(input, options);
  assert.deepEqual(transcript, await oracle({ agent, project, builtin, current: input.currentMessage, include_memory: false, has_cron: false }));
  assert.doesNotMatch(String(transcript[0].content), /private profile|private user|private memory|memory instruction|cron instruction/); assert.match(String(transcript[0].content), /temporary session|project rules|review instruction/);
}));
test('bundled defaults, disabled aliases and skill requirements match Python availability', { timeout: 10_000 }, async () => isolated(async (agent, project, builtin) => {
  for (const name of ['AGENTS.md', 'USER.md']) await writeFile(join(agent, name), await readFile(join(root, 'nanobot/templates', name)));
  await skill(join(agent, 'skills'), 'real', 'disabled skill'); await skill(join(agent, 'skills'), 'env-blocked', 'blocked', 'metadata: {nanobot: {requires: {env: [constructor]}}}\n');
  await skill(join(agent, 'skills'), 'ready', 'enabled', 'metadata: {nanobot: {requires: {env: [NANOBOT_CONTEXT_FIXTURE]}}}\n');
  await skill(builtin, 'missing-bin', 'blocked', 'metadata: {nanobot: {requires: {bins: [nanobot-no-such-synthetic-bin]}}}\n');
  const environment = { NANOBOT_CONTEXT_FIXTURE: 'yes', PATH: '' }, aliases = { old: 'real' };
  const transcript = await new ContextBuilder(agent, { builtinSkillsDirectory: builtin, disabled: ['old'], aliases, environment }).buildTranscript({ history: [], currentMessage: 'work' }, { projectWorkspace: agent });
  assert.deepEqual(transcript, await oracle({ agent, project: agent, builtin, disabled: ['old'], aliases, environment, current: 'work' }));
  assert.doesNotMatch(String(transcript[0].content), /env-blocked|missing-bin|disabled skill/); assert.match(String(transcript[0].content), /ready/);
}));
test('text/multimodal current message and runtime marker boundaries match Python', { timeout: 10_000 }, async () => isolated(async (agent, project, builtin) => {
  const png = join(project, 'synthetic.bin'); await writeFile(png, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
  const input: TranscriptInput = { history: [], currentMessage: 'image', media: [png, join(project, 'missing.png')], runtimeContextBlocks: [{ source: 'test', content: '[metadata]' }] };
  const actual = await new ContextBuilder(agent, { builtinSkillsDirectory: builtin }).buildTranscript(input, { projectWorkspace: project });
  assert.deepEqual(actual, await oracle({ agent, project, builtin, current: input.currentMessage, media: input.media, blocks: input.runtimeContextBlocks }));
  assert.ok(Array.isArray(actual[1].content));
}));
