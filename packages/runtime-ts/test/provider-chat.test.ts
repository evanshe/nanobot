import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { OpenAIChatProvider, isTransientChatResponse, resolveChatIdleTimeoutMs, isLocalChatEndpoint } from '@nanobot/runtime';
import type { ChatRequest, ChatResponse } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
export async function pythonReference(input: object): Promise<{ response: ChatResponse; transient?: boolean; argument_json?: string[]; local_endpoints?: boolean[]; content: string[]; thinking: string[]; tools: object[] }> {
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
function errorMetadata(response: ChatResponse) {
  return Object.fromEntries(['error_status_code', 'error_kind', 'error_type', 'error_code', 'error_retry_after_s', 'error_should_retry', 'retry_after'].map(key => [key, response[key as keyof ChatResponse]]));
}
const synthetic: ChatRequest = { messages: [{ role: 'user', content: 'synthetic' }] };
test('HTTP retry metadata and classification match Python without hidden retries', { timeout: 30_000 }, async () => {
  for (const [status, code, headers] of [[429, 'rate_limit_exceeded', { 'retry-after-ms': '250' }], [429, 'insufficient_quota', {}], [503, 'unavailable', { 'x-should-retry': 'false' }], [401, 'invalid_api_key', {}], [400, 'custom', { 'x-should-retry': 'true', 'retry-after': '2' }]] as const) {
    await stub(async (base, requests) => {
      const reference = await pythonReference({ base, request: synthetic });
      const result = await new OpenAIChatProvider({ apiBase: base }).chat(synthetic);
      assert.equal(result.finish_reason, 'error'); assert.deepEqual(errorMetadata(result), errorMetadata(reference.response)); assert.equal(isTransientChatResponse(result), reference.transient); assert.equal(requests.length, 2);
    }, response => { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify({ error: { message: 'synthetic failure', type: 'test', code } })); });
  }
});
test('idle deadline renews on parsed reasoning/usage events and permits total duration above deadline', { timeout: 10_000 }, async () => {
  await stub(async base => {
    const reference = await pythonReference({ base, request: synthetic, stream: true, timeout_s: 0.3 });
    const result = await new OpenAIChatProvider({ apiBase: base, idleTimeoutMs: 300 }).chatStream(synthetic);
    assert.deepEqual(result, reference.response); assert.equal(result.content, 'done');
  }, async response => {
    response.setHeader('content-type', 'text/event-stream'); response.flushHeaders();
    for (const value of [chunk({ reasoning_content: 'a' }), { choices: [], usage: { prompt_tokens: 1, completion_tokens: 0 } }, chunk({ reasoning_content: 'b' }), chunk({ content: 'done' }, 'stop')]) {
      await new Promise(resolve => setTimeout(resolve, 100)); if (response.destroyed) return; response.write(`data: ${JSON.stringify(value)}\n\n`);
    } response.end('data: [DONE]\n\n');
  });
});
test('silent headers/body and comment-only streams time out and close the loopback response', { timeout: 15_000 }, async () => {
  for (const mode of ['headers', 'body', 'comments', 'chat']) {
    let closes = 0;
    await stub(async base => {
      const stream = mode !== 'chat', reference = await pythonReference({ base, request: synthetic, stream, timeout_s: 0.15 });
      const provider = new OpenAIChatProvider({ apiBase: base, idleTimeoutMs: 150, requestTimeoutMs: 150 });
      const result = stream ? await provider.chatStream(synthetic) : await provider.chat(synthetic);
      assert.equal(result.error_kind, 'timeout'); assert.equal(reference.response.error_kind, 'timeout');
      assert.equal(isTransientChatResponse(result), reference.transient);
      await provider.close(); const deadline = Date.now() + 1500; while (closes < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(closes, 2);
    }, response => {
      response.on('close', () => { closes++; });
      if (mode === 'headers') return;
      response.setHeader('content-type', mode === 'chat' ? 'application/json' : 'text/event-stream'); response.flushHeaders();
      if (mode === 'comments') { const timer = setInterval(() => response.write(': ping\n\n'), 20); response.on('close', () => clearInterval(timer)); }
    });
  }
});
test('truncated streams and SSE errors take priority over deferred usage parse errors', { timeout: 15_000 }, async () => {
  for (const terminal of ['eof', 'finish', 'sse-error', 'disconnect-after-finish']) {
    await stub(async base => {
      const reference = await pythonReference({ base, request: synthetic, stream: true }), content: string[] = [];
      const response = await new OpenAIChatProvider({ apiBase: base }).chatStream(synthetic, { onContentDelta: value => { content.push(value); } });
      assert.equal(response.finish_reason, 'error'); assert.deepEqual(content, reference.content); assert.equal(response.error_kind, reference.response.error_kind); assert.equal(isTransientChatResponse(response), reference.transient);
      if (terminal === 'sse-error') assert.match(response.content!, /provider stream error/);
    }, async response => {
      response.setHeader('content-type', 'text/event-stream');
      response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: terminal === 'finish' ? 'invalid' : -1, completion_tokens: 0 } })}\n\n`);
      response.write(`data: ${JSON.stringify(chunk({ content: 'live despite parse error' }))}\n\n`);
      if (terminal === 'finish' || terminal === 'disconnect-after-finish') response.write(`data: ${JSON.stringify(chunk({}, 'stop'))}\n\n`);
      if (terminal === 'sse-error') response.write('data: {"error":{"message":"provider stream error"}}\n\n');
      if (terminal === 'disconnect-after-finish') { await new Promise(resolve => setTimeout(resolve, 20)); response.destroy(); } else response.end();
    });
  }
});
test('callback errors are non-retryable and close the stream; slow callbacks do not count as idle', { timeout: 10_000 }, async () => {
  let closes = 0;
  await stub(async base => {
    const reference = await pythonReference({ base, request: synthetic, stream: true, fail_callback: true });
    const provider = new OpenAIChatProvider({ apiBase: base, idleTimeoutMs: 100 });
    const failure = await provider.chatStream(synthetic, { onContentDelta: () => { throw new Error('callback failed'); } });
    assert.equal(failure.error_kind, reference.response.error_kind); assert.equal(failure.error_should_retry, false); assert.equal(isTransientChatResponse(failure), false);
    const success = await provider.chatStream(synthetic, { onContentDelta: async () => { await new Promise(resolve => setTimeout(resolve, 200)); } }); assert.equal(success.content, 'text');
    await provider.close(); assert.ok(closes >= 2);
  }, response => { response.on('close', () => { closes++; }); response.setHeader('content-type', 'text/event-stream'); response.end(`data: ${JSON.stringify(chunk({ content: 'text' }))}\n\ndata: ${JSON.stringify(chunk({}, 'stop'))}\n\n`); });
});
test('AbortSignal interrupts blocked reads and callbacks, closes sockets and retains callback ownership for drain', { timeout: 10_000 }, async () => {
  for (const mode of ['read', 'callback']) {
    let closed = false, started!: () => void; const reached = new Promise<void>(resolve => { started = resolve; });
    await stub(async base => {
      const controller = new AbortController(), provider = new OpenAIChatProvider({ apiBase: base });
      let release!: () => void; const retained = new Promise<void>(resolve => { release = resolve; });
      const pending = provider.chatStream(synthetic, { onContentDelta: async (_text, signal) => { started(); assert.equal(signal.aborted, false); await retained; } }, controller.signal);
      await reached; controller.abort(new DOMException('synthetic cancellation', 'AbortError')); await assert.rejects(pending, /synthetic cancellation/);
      let drained = false; const closing = provider.close().then(() => { drained = true; }); await new Promise(resolve => setImmediate(resolve));
      if (mode === 'callback') assert.equal(drained, false); release(); await closing;
      const deadline = Date.now() + 1500; while (!closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(closed, true);
      await assert.rejects(provider.chat(synthetic), /closed/);
    }, response => { response.on('close', () => { closed = true; }); response.setHeader('content-type', 'text/event-stream'); response.flushHeaders(); if (mode === 'callback') response.write(`data: ${JSON.stringify(chunk({ content: 'wait' }))}\n\n`); else started(); });
  }
});
test('idle timeout resolver accepts positive values and clamps environmental deadlines', () => {
  assert.equal(resolveChatIdleTimeoutMs(''), 90_000); assert.equal(resolveChatIdleTimeoutMs('-1'), 90_000); assert.equal(resolveChatIdleTimeoutMs('invalid'), 90_000);
  assert.equal(resolveChatIdleTimeoutMs('0.3'), 300); assert.equal(resolveChatIdleTimeoutMs('99999'), 3_600_000);
});
test('empty completion errors and retry text durations match the Python public boundary', { timeout: 10_000 }, async () => {
  await stub(async base => {
    const reference = await pythonReference({ base, request: synthetic }), response = await new OpenAIChatProvider({ apiBase: base }).chat(synthetic);
    assert.equal(response.content, reference.response.content); assert.deepEqual(errorMetadata(response), errorMetadata(reference.response));
  }, response => { response.setHeader('content-type', 'application/json'); response.end('{"choices":[]}'); });
  await stub(async base => {
    const reference = await pythonReference({ base, request: synthetic }), response = await new OpenAIChatProvider({ apiBase: base }).chat(synthetic);
    assert.equal(response.retry_after, reference.response.retry_after); assert.equal(response.retry_after, 90);
  }, response => { response.writeHead(429, { 'content-type': 'application/json' }); response.end('{"error":{"message":"try again in 1m30s","code":"rate_limit_exceeded"}}'); });
});
test('fresh Chat and split SSE arguments follow Python strip and preserve unsafe integer originals', { timeout: 30_000 }, async () => {
  for (const argument of ['\uFEFF', '\u00A0{"id":1}\u00A0', '\u0085\u001c', '{"id":1234567890123456789}', '{"nested":[-9007199254740992]}', '{"id":9007199254740991}']) {
    for (const stream of [false, true]) {
      await stub(async base => {
        const reference = await pythonReference({ base, request: synthetic, stream, exact_arguments: true });
        const provider = new OpenAIChatProvider({ apiBase: base });
        const response = stream ? await provider.chatStream(synthetic) : await provider.chat(synthetic);
        if (argument.includes('1234567890123456789') || argument.includes('-9007199254740992')) {
          assert.equal(response.tool_calls[0].arguments, argument);
          assert.equal(reference.argument_json?.[0], argument.includes('nested') ? '{"nested": [-9007199254740992]}' : '{"id": 1234567890123456789}');
        } else assert.deepEqual(response, reference.response);
        await provider.close();
      }, response => {
        const functionCall = { name: 'synthetic_tool', arguments: argument };
        if (!stream) { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', tool_calls: [{ id: 'call', type: 'function', function: functionCall }] }, finish_reason: 'tool_calls' }] })); }
        else {
          const split = Math.floor(argument.length / 2); response.setHeader('content-type', 'text/event-stream');
          response.end([chunk({ tool_calls: [{ index: 0, id: 'call', function: { ...functionCall, arguments: argument.slice(0, split) } }] }), chunk({ tool_calls: [{ index: 0, function: { arguments: argument.slice(split) } }] }, 'tool_calls')].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n');
        }
      });
    }
  }
});
test('local Chat redirects match Python and never forward synthetic body or custom headers to another port', { timeout: 15_000 }, async () => {
  await stub(async (destination, destinationRequests) => {
    await stub(async (base, sourceRequests) => {
      for (const stream of [false, true]) {
        const reference = await pythonReference({ base, request: synthetic, stream, headers: { 'x-synthetic-private': 'fixture-only' } });
        const provider = new OpenAIChatProvider({ apiBase: base, extraHeaders: { 'x-synthetic-private': 'fixture-only' } });
        const response = stream ? await provider.chatStream(synthetic) : await provider.chat(synthetic);
        assert.equal(response.error_status_code, 307); assert.equal(reference.response.error_status_code, 307); await provider.close();
      }
      assert.equal(sourceRequests.length, 4); assert.equal(destinationRequests.length, 0);
    }, response => { response.writeHead(307, { location: `${destination}/chat/completions` }); response.end(); });
  }, response => { response.setHeader('content-type', 'application/json'); response.end('{}'); });
});
test('local redirect endpoint ranges and hostname handling match the Python IP oracle', async () => {
  const cases = ['localhost', 'LOCALHOST', 'localhost.', 'host.docker.internal', '127.0.0.1', '127.1', '10.1.2.3', '172.16.0.1', '172.32.0.1', '192.168.1.2', '192.0.0.9', '192.0.0.8', '100.64.0.1', '198.51.100.1', '8.8.8.8', '[::1]', '[::]', '[fc00::1]', '[fe80::1]', '[::ffff:127.0.0.1]', '[::ffff:8.8.8.8]', '[::ffff:0:7f00:1]', '[2001:1::1]', '[2001:1::3]', '[2001:db8::1]', '[2001:4860:4860::8888]', 'public.invalid'].map(host => `http://${host}:1234/v1`);
  await stub(async base => {
    const reference = await pythonReference({ base, request: synthetic, endpoint_cases: cases });
    assert.deepEqual(cases.map(isLocalChatEndpoint), reference.local_endpoints);
  }, response => { response.setHeader('content-type', 'application/json'); response.end('{"choices":[{"index":0,"message":{"role":"assistant","content":"ok"},"finish_reason":"stop"}]}'); });
});
