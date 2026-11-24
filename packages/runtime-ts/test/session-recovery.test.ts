import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { InboundMessage, HistoryFact, openSessionStore, newSession, addSessionMessage, restoreRuntimeCheckpoint, runtimeCheckpointIsWellFormed, UNCERTAIN_TOOL_PHASES, pendingFollowups, SessionConflictError, restorePendingInterruption } from '@nanobot/runtime';
import type { ConfigObject } from '@nanobot/runtime';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const python = process.env.NANOBOT_TEST_PYTHON ?? join(repository, '.venv/bin/python');
const cases: { name: string; checkpoint: ConfigObject }[] = JSON.parse(await readFile(new URL('./fixtures/session-checkpoints.json', import.meta.url), 'utf8'));
const provider = () => ({ kind: 'openai_responses', provider: 'openai', model: 'model', version: 1, payload: { cursor: 'synthetic' }, pending_messages: [] });
async function isolated(run: (workspace: string, root: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-ts-recovery-'));
  try { await run(join(directory, 'workspace'), join(directory, 'sessions')); } finally { await rm(directory, { recursive: true, force: true }); }
}
for (const scenario of cases) test(`checkpoint Python parity: ${scenario.name}`, () => {
  const expected = spawnSync(python, [fileURLToPath(new URL('./session-recovery-reference.py', import.meta.url))], { cwd: repository, env: { ...process.env, PYTHONPATH: repository }, encoding: 'utf8', input: JSON.stringify(scenario.checkpoint) });
  assert.equal(expected.status, 0, expected.stderr);
  const session = newSession('chat:parity'); session.messages = [{ role: 'user', content: 'work', input_id: 'first', timestamp: '2026-01-01T00:00:00' }]; session.providerState = provider(); session.metadata = { pending_user_turn: true, runtime_checkpoint: structuredClone(scenario.checkpoint) };
  const valid = runtimeCheckpointIsWellFormed(scenario.checkpoint), restored = restoreRuntimeCheckpoint(session);
  for (const message of session.messages) if (!['2026-01-01T00:00:00', '2026-01-01T00:00:01', '2026-01-01T00:00:02'].includes(String(message.timestamp))) message.timestamp = '<generated>';
  assert.deepEqual({ valid, restored, second_restore: restoreRuntimeCheckpoint(session), messages: session.messages, metadata: session.metadata, provider_state: session.providerState, consumed_ids: [...session.consumedFollowupIds].sort() }, JSON.parse(expected.stdout));
});
test('SIGKILL after checkpoint commit recovers the durable final answer once without publishing draft-only changes', { timeout: 6000 }, async () => isolated(async (workspace, root) => {
  const execute = promisify(execFile); let generation = '';
  try { await execute(process.execPath, [fileURLToPath(new URL('./session-crash-child.ts', import.meta.url)), workspace, root], { timeout: 4000 }); assert.fail('Crash child unexpectedly exited normally'); }
  catch (error) {
    if (typeof error !== 'object' || error === null || !('signal' in error) || error.signal !== 'SIGKILL' || !('stdout' in error)) throw error;
    generation = JSON.parse(String(error.stdout)).generation;
  }
  let opened = await openSessionStore({ workspace, sessionsRoot: root });
  try {
    const session = await opened.state.get('websocket:crashed'); assert.equal(session.generation, generation); assert.equal(session.messages.length, 1); assert.equal(session.metadata.uncommitted, undefined);
    assert.ok(session.providerState); assert.equal(runtimeCheckpointIsWellFormed(session.metadata.runtime_checkpoint as ConfigObject), true);
    assert.deepEqual(await opened.state.recoveryCandidates('websocket:'), [[session.key, false]]);
    assert.equal(restoreRuntimeCheckpoint(session), true); await opened.state.restoreInterruption(session); assert.equal(restoreRuntimeCheckpoint(session), false);
  } finally { await opened.close(); }
  opened = await openSessionStore({ workspace, sessionsRoot: root });
  try {
    const recovered = await opened.state.get('websocket:crashed'); assert.deepEqual(recovered.messages.map(message => message.content), ['finish the accepted input', 'durable final answer']); assert.ok(recovered.providerState);
    assert.equal(recovered.metadata.runtime_checkpoint, undefined); assert.equal(recovered.metadata.pending_user_turn, undefined); assert.deepEqual(await opened.state.recoveryCandidates('websocket:'), []);
  } finally { await opened.close(); }
}));
test('uncertain tool outcomes become explicit interrupted results and never authorize implicit continuation', async () => isolated(async (workspace, root) => {
  const opened = await openSessionStore({ workspace, sessionsRoot: root });
  try {
    const session = await opened.state.get('websocket:tool'); addSessionMessage(session, 'user', 'work'); session.metadata.pending_user_turn = true; await opened.state.prepareInput(session);
    const checkpoint = structuredClone(cases.find(item => item.name === 'uncertain tool outcome')!.checkpoint);
    await opened.state.checkpointView(session, checkpoint); const persisted = await opened.state.get(session.key);
    assert.equal(runtimeCheckpointIsWellFormed(checkpoint), true); assert.equal(UNCERTAIN_TOOL_PHASES.has(String(checkpoint.phase)), true);
    restoreRuntimeCheckpoint(persisted); await opened.state.restoreInterruption(persisted);
    const tool = persisted.messages.at(-1)!; assert.equal(tool.role, 'tool'); assert.equal(tool.tool_call_id, 'call-a'); assert.equal(tool._recovery_interrupted, true); assert.match(String(tool.content), /outcome is unknown/); assert.equal(persisted.providerState, null);
  } finally { await opened.close(); }
}));
test('follow-up journal survives restart, deduplicates input IDs, and acknowledges only committed draft inputs', async () => isolated(async (workspace, root) => {
  let opened = await openSessionStore({ workspace, sessionsRoot: root }); const ids: string[] = [];
  try {
    const draft = await opened.state.get('websocket:followups'); addSessionMessage(draft, 'user', 'first'); draft.metadata.pending_user_turn = true; await opened.state.prepareInput(draft);
    for (let index = 0; index < 12; index++) {
      const id = await opened.state.queueFollowup(draft.key, new InboundMessage({ channel: 'websocket', chatId: 'followups', senderId: 'user', content: `follow-${index}`, sessionGeneration: draft.generation })); assert.ok(id); ids.push(id);
    }
    const duplicate = new InboundMessage({ channel: 'websocket', chatId: 'followups', senderId: 'user', content: 'follow-0', metadata: { _recovery_followup_id: ids[0] } }); assert.equal(await opened.state.queueFollowup(draft.key, duplicate), ids[0]);
    draft.consumedFollowupIds = [ids[0]]; addSessionMessage(draft, 'user', 'follow-0'); addSessionMessage(draft, 'assistant', 'answer'); await opened.state.finishTurn(draft);
    assert.equal(draft.metadata.pending_user_turn, undefined); assert.equal(pendingFollowups(draft).length, 11);
  } finally { await opened.close(); }
  opened = await openSessionStore({ workspace, sessionsRoot: root });
  try {
    const session = await opened.state.get('websocket:followups'), pending = pendingFollowups(session); assert.deepEqual(pending.map(message => message.content), Array.from({ length: 11 }, (_, index) => `follow-${index + 1}`));
    assert.equal(pending[0].requireExistingSession, true); assert.equal(pending[0].sessionKey, session.key);
    await opened.state.acknowledgeFollowups(session.key, ids.slice(1)); await opened.state.acknowledgeFollowups(session.key, ids.slice(1)); assert.deepEqual(pendingFollowups((await opened.state.read(session.key))!), []);
    const stale = new InboundMessage({ channel: 'websocket', chatId: 'followups', senderId: 'user', content: 'late', sessionGeneration: session.generation }); await opened.state.reset(session.key);
    await assert.rejects(opened.state.queueFollowup(session.key, stale), SessionConflictError); await assert.rejects(opened.state.checkpointView(session, cases[0].checkpoint), SessionConflictError);
  } finally { await opened.close(); }
}));
test('summary commit preserves display facts and rejects stale compaction prefixes', async () => isolated(async (workspace, root) => {
  const opened = await openSessionStore({ workspace, sessionsRoot: root });
  try {
    const draft = await opened.state.get('chat:summary'); addSessionMessage(draft, 'user', 'old'); addSessionMessage(draft, 'assistant', 'old answer'); addSessionMessage(draft, 'user', 'new'); await opened.state.finishTurn(draft);
    await opened.state.appendHistory(draft.key, [new HistoryFact('input', { text: 'old', input_id: 'old' }), new HistoryFact('answer', { text: 'old answer' })], draft.generation);
    await opened.state.commitSummary(draft, 'retained summary', 2); const compacted = await opened.state.get(draft.key);
    assert.equal(compacted.lastArchived, 2); assert.equal(compacted.messages[2]._hidden_history, true); assert.equal(compacted.metadata._last_summary && typeof compacted.metadata._last_summary, 'object'); assert.equal((await opened.state.projectHistory(draft.key, reader => reader.allFacts())).length, 2);
    await opened.state.reset(draft.key); await assert.rejects(opened.state.commitSummary(draft, 'stale', 2), SessionConflictError);
  } finally { await opened.close(); }
}));
test('incomplete display markers take precedence over telemetry and user-only interruption is materialized once', async () => isolated(async (workspace, root) => {
  const opened = await openSessionStore({ workspace, sessionsRoot: root });
  try {
    const session = await opened.state.get('websocket:incomplete');
    await opened.state.appendHistory(session.key, [new HistoryFact('model_request', { phase: 'completed' }), new HistoryFact('completion', { transcript_incomplete: true })], session.generation);
    assert.deepEqual(await opened.state.recoveryCandidates('websocket:'), [[session.key, true]]);
    addSessionMessage(session, 'user', 'unfinished'); session.metadata.pending_user_turn = true; await opened.state.prepareInput(session); assert.equal(restorePendingInterruption(session), true); await opened.state.restoreInterruption(session);
    assert.equal(restorePendingInterruption(session), false); assert.match(String(session.messages.at(-1)!.content), /before a response/);
  } finally { await opened.close(); }
}));
