import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { OpenAIChatProvider } from '@nanobot/runtime';
import type { ChatRequest } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
export async function pythonReference(input: object): Promise<{ response: object; content: string[]; thinking: string[]; tools: object[] }> {
  const child = spawn(process.env.NANOBOT_TEST_PYTHON ?? join(root, '.venv/bin/python'), [fileURLToPath(new URL('./provider-reference.py', import.meta.url))], { cwd: root, env: { ...process.env, PYTHONPATH: root } });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
  child.stdin.end(JSON.stringify(input)); const [code] = await once(child, 'close'); assert.equal(code, 0, stderr); return JSON.parse(stdout);
}
export async function stub(run: (base: string, requests: { path: string; headers: IncomingMessage['headers']; body: unknown }[]) => Promise<void>, respond: (response: ServerResponse, body: Record<string, unknown>) => void | Promise<void>) {
  const requests: { path: string; headers: IncomingMessage['headers']; body: unknown }[] = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw); requests.push({ path: request.url!, headers: request.headers, body });
    await respond(response, body);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert.ok(address && typeof address !== 'string');
  try { await run(`http://127.0.0.1:${address.port}/v1`, requests); } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
}
const chunk = (delta: object, finish_reason: string | null = null) => ({ id: 'chatcmpl-synthetic', object: 'chat.completion.chunk', created: 0, model: 'test-model', choices: [{ index: 0, delta, finish_reason }] });
const request: ChatRequest = { messages: [{ role: 'system', content: 'synthetic' }, { role: 'user', content: '', _meta: { private: 'omit' }, timestamp: 'omit' }, { role: 'user', content: [{ type: 'text', text: '' }, { type: 'text', text: '中文🙂', _meta: {} }] }, { role: 'assistant', content: 'trailing prefill' }] };
test('normal package Chat request and text response match public Python on real HTTP', async () => {
  await stub(async (base, requests) => {
    const options = { headers: { 'x-synthetic': 'private-fixture' }, extra_body: { nested: { enabled: true } }, extra_query: { fixture: 'yes' } };
    const reference = await pythonReference({ base, request, ...options });
    const provider = new OpenAIChatProvider({ apiBase: base, defaultModel: 'test-model', extraHeaders: options.headers, extraBody: options.extra_body, extraQuery: options.extra_query });
    assert.deepEqual(await provider.chat(request), reference.response);
    assert.deepEqual(requests[1].body, requests[0].body); assert.equal(requests[1].path, requests[0].path);
    assert.equal(requests[1].headers.authorization, 'Bearer no-key'); assert.equal(requests[1].headers['x-synthetic'], 'private-fixture');
    assert.equal(request.messages[1].content, '');
  }, response => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ id: 'c', object: 'chat.completion', created: 0, model: 'test-model', choices: [{ index: 0, message: { role: 'assistant', content: 'hello 中文🙂', reasoning_content: 'thought' }, finish_reason: 'stop' }] })); });
});
test('fragmented UTF-8 CRLF SSE and awaited text/reasoning callbacks match Python', async () => {
  await stub(async (base, requests) => {
    const reference = await pythonReference({ base, request, stream: true });
    const content: string[] = [], thinking: string[] = [], provider = new OpenAIChatProvider({ apiBase: base, defaultModel: 'test-model' });
    const response = await provider.chatStream(request, { onContentDelta: async value => { await new Promise(resolve => setImmediate(resolve)); content.push(value); }, onThinkingDelta: value => { thinking.push(value); } });
    assert.deepEqual({ response, content, thinking, tools: [] }, reference); assert.deepEqual(requests[1].body, requests[0].body);
  }, async response => {
    response.setHeader('content-type', 'text/event-stream');
    const bytes = Buffer.from(': heartbeat\r\n\r\n' + [chunk({ reasoning_content: '思考' }), chunk({ content: 'hello ' }), chunk({ content: '中文🙂' }), chunk({}, 'stop')].map(value => `data: ${JSON.stringify(value)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n');
    for (let index = 0; index < bytes.length; index += 7) { response.write(bytes.subarray(index, index + 7)); await new Promise(resolve => setImmediate(resolve)); } response.end();
  });
});
test('OpenAI model token/temperature rules and ordinary body overrides match Python', async () => {
  await stub(async base => {
    for (const model of ['test-model', 'gpt-5-mini', 'o3-mini', 'gpt-6']) {
      const input = { messages: [{ role: 'user', content: 'synthetic' }], model, max_tokens: 0, reasoning_effort: 'none' };
      const reference = await pythonReference({ base, request: input });
      assert.deepEqual(await new OpenAIChatProvider({ apiBase: base }).chat(input), reference.response);
    }
  }, (response, body) => { const isCompletion = /^(gpt-5|o3)/.test(String(body.model)); assert.equal(body[isCompletion ? 'max_completion_tokens' : 'max_tokens'], 1); assert.equal('temperature' in body, !isCompletion); response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] })); });
});
test('shared tool fragments, interleaved indices, extras and trailing usage match Python HTTP/SSE', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/openai-chat-tools.json', import.meta.url), 'utf8'));
  const chunks = [...fixture.chunks, { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 30, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2 }, cached_tokens: 8 } }];
  await stub(async base => {
    const input = { messages: [{ role: 'user', content: 'synthetic' }], tools: [{ type: 'function', function: { name: 'write_file', parameters: { type: 'object' } } }] };
    const reference = await pythonReference({ base, request: input, stream: true }), tools: object[] = [];
    const response = await new OpenAIChatProvider({ apiBase: base, defaultModel: 'test-model' }).chatStream(input, { onToolCallDelta: async value => { await new Promise(resolve => setImmediate(resolve)); tools.push(value); } });
    assert.deepEqual({ response, content: [], thinking: [], tools }, reference);
    assert.deepEqual(tools, fixture.expected.deltas); assert.equal(response.tool_calls.length, 1);
    assert.deepEqual(response.tool_calls[0].arguments, fixture.expected.tool_call.arguments);
    assert.equal(response.usage?.cache_read_tokens, 0); assert.equal(response.usage?.total_tokens, 30);
  }, response => { response.setHeader('content-type', 'text/event-stream'); response.end(chunks.map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n'); });
  const interleaved = [chunk({ tool_calls: [{ index: 3, id: 'three', function: { name: 'a', arguments: '{"x":' }, extra_content: { google: { thought_signature: 'synthetic' } }, vendor: 'value' }, { index: 1, id: 'one', function: { name: 'b', arguments: 'false', inner: 'extra' } }] }), chunk({ tool_calls: [{ index: 3, function: { arguments: '1}' } }] }, 'tool_calls')];
  await stub(async base => {
    const input = { messages: [{ role: 'user', content: 'synthetic' }] }, reference = await pythonReference({ base, request: input, stream: true }), tools: object[] = [];
    const response = await new OpenAIChatProvider({ apiBase: base }).chatStream(input, { onToolCallDelta: value => { tools.push(value); } });
    assert.deepEqual({ response, content: [], thinking: [], tools }, reference); assert.deepEqual(response.tool_calls.map(call => call.id), ['three', 'one']);
  }, response => { response.setHeader('content-type', 'text/event-stream'); response.end(interleaved.map(value => `data: ${JSON.stringify(value)}\n\n`).join('')); });
});
test('fresh tool arguments preserve malformed and non-object shapes; replay repairs only historical objects', async () => {
  for (const argument of ['', '{path:"foo.txt"}', '["foo.txt"]', 'false', 'null', '{"path":"中文"}']) {
    await stub(async (base, requests) => {
      const input: ChatRequest = { messages: [{ role: 'assistant', tool_calls: [{ id: 'history', type: 'function', function: { name: 'old', arguments: '{path:"foo.txt"}' } }] }, { role: 'tool', tool_call_id: 'history', content: 'done' }] };
      const reference = await pythonReference({ base, request: input });
      const response = await new OpenAIChatProvider({ apiBase: base, defaultModel: 'test-model' }).chat(input);
      assert.deepEqual(response, reference.response); assert.deepEqual(requests[1].body, requests[0].body);
    }, response => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: { name: 'optional', arguments: argument, inner: 'value' }, extra_content: { synthetic: true } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3 } })); });
  }
});
test('usage cache precedence, explicit zeros, missing totals and hidden totals match Python', async () => {
  for (const usage of [{ prompt_tokens: 15, completion_tokens: 18, total_tokens: 175, prompt_cache_hit_tokens: 4 }, { prompt_tokens: 15, completion_tokens: 18, total_tokens: 12, cached_tokens: 0 }, { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 }, cached_tokens: 8 }]) {
    await stub(async base => {
      const input = { messages: [{ role: 'user', content: 'synthetic' }] }, reference = await pythonReference({ base, request: input });
      assert.deepEqual(await new OpenAIChatProvider({ apiBase: base }).chat(input), reference.response);
    }, response => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage })); });
  }
});
test('duplicate and legacy streaming tool IDs become unique nine-character IDs', async () => {
  await stub(async base => {
    const response = await new OpenAIChatProvider({ apiBase: base }).chatStream({ messages: [{ role: 'user', content: 'synthetic' }] });
    assert.equal(response.tool_calls.length, 3); assert.equal(new Set(response.tool_calls.map(call => call.id)).size, 3);
    assert.equal(response.tool_calls[0].id, 'same'); for (const call of response.tool_calls.slice(1)) assert.match(call.id, /^[A-Za-z0-9]{9}$/);
    assert.deepEqual(response.tool_calls.map(call => call.arguments), [{}, {}, {}]);
  }, response => { response.setHeader('content-type', 'text/event-stream'); response.end([chunk({ tool_calls: [{ index: 0, id: 'same', function: { name: 'a', arguments: '{}' } }, { index: 1, id: 'same', function: { name: 'b' } }, { index: 2, function: { name: 'c' } }] }, 'tool_calls')].map(value => `data: ${JSON.stringify(value)}\n\n`).join('')); });
});
test('legacy function_call fragments preserve empty arguments and emit matching public deltas', async () => {
  await stub(async base => {
    const input = { messages: [{ role: 'user', content: 'synthetic' }] }, reference = await pythonReference({ base, request: input, stream: true }), tools: object[] = [];
    const response = await new OpenAIChatProvider({ apiBase: base }).chatStream(input, { onToolCallDelta: value => { tools.push(value); } });
    assert.deepEqual(tools, reference.tools); assert.equal(response.tool_calls[0].name, 'legacy'); assert.deepEqual(response.tool_calls[0].arguments, {}); assert.match(response.tool_calls[0].id, /^[A-Za-z0-9]{9}$/);
  }, response => { response.setHeader('content-type', 'text/event-stream'); response.end([chunk({ function_call: { name: 'legacy', arguments: ' ' } }), chunk({}, 'function_call')].map(value => `data: ${JSON.stringify(value)}\n\n`).join('')); });
});
