import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { newSession, sessionModelHistory, persistUserImages, replayUserImages } from '@nanobot/runtime';
import type { ConfigObject, Json } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
async function oracle(input: object): Promise<Json> {
  const child = spawn(join(root, '.venv/bin/python'), [fileURLToPath(new URL('./agent-history-reference.py', import.meta.url))], { cwd: root, env: { ...process.env, PYTHONPATH: root } });
  let stdout = '', stderr = ''; child.stdout.on('data', part => { stdout += part; }); child.stderr.on('data', part => { stderr += part; }); child.stdin.end(JSON.stringify(input)); const [status] = await once(child, 'close'); assert.equal(status, 0, stderr); return JSON.parse(stdout);
}
async function isolated(run: (directory: string) => Promise<void>) { const directory = await mkdtemp(join(tmpdir(), 'nanobot-ts-replay-')); try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); } }
test('model replay command/summary filtering, legal boundaries, ownership and history budgets match Python', async () => isolated(async data => {
  const session = newSession('chat:synthetic');
  session.messages = [
    { role: 'assistant', content: 'proactive', _channel_delivery: true }, { role: 'user', content: '/model', _command: true }, { role: 'assistant', content: 'model', _command: true },
    { role: 'user', content: 'old', input_id: 'user:old' }, { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'echo', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'call', name: 'echo', content: 'result' },
    { role: 'assistant', content: 'done', response_input_ids: ['user:old'] }, { role: 'user', content: 'Continue the active task from the working-memory checkpoint above.', _hidden_history: true },
    { role: 'user', content: 'next\n\n[private context]', input_id: 'user:next', _runtime_context: { version: 1, suffix: '[private context]', sources: ['test'] } }, { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'legacy', cli_apps: [{ name: 'Demo', entry_point: 'synthetic' }] },
  ];
  const before = structuredClone(session.messages);
  for (const options of [{}, { maxMessages: 2 }, { maxMessages: 4, extendToUser: true }, { maxTokens: 1 }, { includeRuntimeContext: false }]) {
    const actual = await sessionModelHistory(session, { dataDirectory: data, ...options });
    assert.deepEqual(actual, await oracle({ data, messages: session.messages, max_messages: 'maxMessages' in options ? options.maxMessages : 0, max_tokens: 'maxTokens' in options ? options.maxTokens : 0, extend: 'extendToUser' in options && options.extendToUser, context: !('includeRuntimeContext' in options) || options.includeRuntimeContext }));
  }
  session.lastArchived = 7;
  assert.deepEqual(await sessionModelHistory(session, { dataDirectory: data }), await oracle({ data, messages: session.messages, last_archived: 7 }));
  assert.deepEqual(session.messages, before);
  const orphan = newSession('chat:orphan'); orphan.messages = [{ role: 'tool', tool_call_id: 'missing', content: 'orphan' }, { role: 'assistant', content: 'not a user' }];
  assert.deepEqual(await sessionModelHistory(orphan, { dataDirectory: data }), await oracle({ data, messages: orphan.messages }));
}));
test('Python and TS share private hashed image references, exact replay and unavailable-image fallback', async () => isolated(async data => {
  const content: Json[] = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAE=' } }, { type: 'text', text: 'synthetic image caption' }];
  const stored = await persistUserImages(content, data); assert.deepEqual(stored, await oracle({ action: 'persist', data, content }));
  const reference = stored[0] as ConfigObject; assert.equal((await stat(join(data, 'session-images', String(reference.id)))).mode & 0o777, 0o600);
  const session = newSession('chat:images'); session.messages = [{ role: 'user', content: stored, input_id: 'image' }];
  assert.deepEqual(await sessionModelHistory(session, { dataDirectory: data }), await oracle({ data, messages: session.messages }));
  const pythonStored = await oracle({ action: 'persist', data, content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AgM=' } }] }); assert.ok(Array.isArray(pythonStored));
  const replayed = await replayUserImages(pythonStored, data); assert.equal((replayed[0] as ConfigObject).type, 'image_url');
  await writeFile(join(data, 'session-images', String(reference.id)), 'corrupt');
  assert.deepEqual(await sessionModelHistory(session, { dataDirectory: data }), await oracle({ data, messages: session.messages }));
  const invalid = await replayUserImages([{ type: 'image_attachment', id: '../escape' }], data); assert.deepEqual(invalid, [{ type: 'text', text: '[Previous image unavailable]' }]);
}));
