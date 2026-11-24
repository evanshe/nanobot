import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { RetryingAgentModel, EventSink } from '@nanobot/runtime';
import type { ChatResponse, AgentEvent } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
const success: ChatResponse = { content: 'done', finish_reason: 'stop', reasoning_content: null, tool_calls: [], usage: null };
const failure = (kind: string | null = 'connection', status: number | null = null, content = 'synthetic connection failure'): ChatResponse => ({ ...success, content, finish_reason: 'error', error_kind: kind, error_status_code: status, error_should_retry: null });
type Frame = { response: ChatResponse; content?: readonly string[]; thinking?: readonly string[] };
async function oracle(input: object) {
  const child = spawn(join(root, '.venv/bin/python'), [fileURLToPath(new URL('./agent-retry-reference.py', import.meta.url))], { cwd: root, env: { ...process.env, PYTHONPATH: root } });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.stdin.end(JSON.stringify(input)); const [status] = await once(child, 'close'); assert.equal(status, 0, stderr); return JSON.parse(stdout);
}
for (const [name, frames, options] of [
  ['retryable server failure', [{ response: failure(null, 503) }, { response: success }], {}],
  ['permanent quota', [{ response: { ...failure(null, 429, 'quota'), error_code: 'insufficient_quota' } }], {}],
  ['visible output connection failure', [{ response: failure(), content: ['prefix'] }, { response: success }], {}],
  ['reasoning-only failure', [{ response: failure(), thinking: ['trace'] }, { response: success }], {}],
  ['visible timeout suppresses future callbacks', [{ response: failure('timeout'), content: ['prefix'] }, { response: success, content: ['new'], thinking: ['trace'] }], {}],
  ['visible timeout recovers explicit stream segment', [{ response: failure('timeout'), content: ['prefix'] }, { response: success, content: ['new'] }], { recover: true }],
  ['bounded standard exhaustion', [{ response: failure() }], {}],
  ['persistent identical errors', [{ response: failure() }], { mode: 'persistent' }],
  ['retry-after duration', [{ response: { ...failure(), error_retry_after_s: 2 } }, { response: success }], {}],
] as const) {
  test(`retry execution matches Python: ${name}`, { timeout: 15_000 }, async () => {
    const sleeps: number[] = [], states: object[] = [], content: string[] = [], thinking: string[] = [], progress: string[] = []; let attempts = 0, recoveries = 0;
    const model = new RetryingAgentModel({ chatStream: async (_request, callbacks, signal) => {
      const frame: Frame = frames[Math.min(attempts++, frames.length - 1)];
      for (const value of frame.content ?? []) await callbacks?.onContentDelta?.(value, signal!);
      for (const value of frame.thinking ?? []) await callbacks?.onThinkingDelta?.(value, signal!);
      return frame.response;
    } }, { mode: 'mode' in options ? options.mode : 'standard', random: () => 1, sleep: async value => { sleeps.push(value); }, events: new EventSink(async (event: AgentEvent) => { if (event.kind === 'retry_wait') progress.push(event.content); if (event.kind === 'retry_status') states.push({ state: event.state, attempt: event.attempt, max_attempts: event.maxAttempts, error_kind: event.errorKind }); }), ...('recover' in options ? { onStreamRecover: async () => { recoveries++; } } : {}) });
    const response = await model.chatStream({ messages: [{ role: 'user', content: 'synthetic' }] }, { onContentDelta: value => { content.push(value); }, onThinkingDelta: value => { thinking.push(value); } });
    assert.deepEqual({ content, thinking, sleeps, states, progress, attempts, recoveries, response: { content: response.content, finish_reason: response.finish_reason, error_kind: response.error_kind ?? null, error_should_retry: response.error_should_retry ?? null } }, await oracle({ frames, ...options }));
  });
}
test('retry sleep cancellation prevents another physical request', async () => {
  const controller = new AbortController(); let attempts = 0;
  const model = new RetryingAgentModel({ chatStream: async () => { attempts++; return failure(); } }, { sleep: async (_delay, signal) => { controller.abort(new DOMException('cancel retry', 'AbortError')); signal.throwIfAborted(); } });
  await assert.rejects(model.chatStream({ messages: [] }, {}, controller.signal), /cancel retry/); assert.equal(attempts, 1);
});

test('dependency cancellation is propagated without retries even without caller abort', async () => {
  let attempts = 0; const model = new RetryingAgentModel({ chatStream: async () => { attempts++; throw new DOMException('backend cancelled', 'AbortError'); } });
  await assert.rejects(model.chatStream({ messages: [] }), /backend cancelled/); assert.equal(attempts, 1);
});
