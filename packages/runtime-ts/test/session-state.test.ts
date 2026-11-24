import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import sqlite3 from 'sqlite3';
import { HistoryFact, SessionConflictError, SessionOperationQueueFullError, SessionRepository, SessionState, SqliteDriver, addSessionMessage, newSession, providerState } from '@nanobot/runtime';
import type { HistoryReader, SessionRecord } from '@nanobot/runtime';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const python = process.env.NANOBOT_TEST_PYTHON ?? join(repository, '.venv/bin/python');
const fixture = JSON.parse(await readFile(new URL('./fixtures/stored-session.json', import.meta.url), 'utf8'));
const fixtureFacts = JSON.parse(await readFile(new URL('./fixtures/session-history.json', import.meta.url), 'utf8'));
const facts = () => fixtureFacts.map((item: { kind: ConstructorParameters<typeof HistoryFact>[0]; content: ConstructorParameters<typeof HistoryFact>[1]; turn_id: string; phase: string; sequence: number; created_at_ms: number }) => new HistoryFact(item.kind, item.content, { turnId: item.turn_id, phase: item.phase, sequence: item.sequence, createdAtMs: item.created_at_ms }));
function reference(directory: string, action = 'inspect', key = 'chat:extensions') {
  const result = spawnSync(python, [fileURLToPath(new URL('./session-history-reference.py', import.meta.url))], { cwd: repository, env: { ...process.env, PYTHONPATH: repository }, input: JSON.stringify({ directory, action, key }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
async function isolated(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-ts-session-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
async function open(directory: string, capacity = 64) {
  const driver = await SqliteDriver.open(join(directory, 'sessions.sqlite3')); await driver.initializeSchema();
  const repository = new SessionRepository(driver), state = new SessionState(repository, { capacity });
  return { driver, repository, state };
}
function portable(session: SessionRecord) {
  return { key: session.key, messages: session.messages, metadata: session.metadata, provider_state: session.providerState,
    created_at: session.createdAt, updated_at: session.updatedAt, generation: session.generation, revision: session.revision, last_archived: session.lastArchived };
}
async function display(reader: HistoryReader, generation: string) {
  const page = await reader.readEntryPage(0, { start: 0, end: 100, reverse: false, maxRecords: 3, maxBytes: 500 });
  return { revision: await reader.revision(), turns: (await reader.turns()).map(turn => ({ ordinal: turn.ordinal, record_count: turn.recordCount, byte_count: turn.byteCount, user_count: turn.userCount })),
    facts: (await reader.allFacts()).map(fact => JSON.parse(fact.encode())), page: { entries: page.entries.map(([position, fact]) => [position, JSON.parse(fact.encode())]), source_bytes: page.sourceBytes },
    latest_usage: await reader.latestContextUsage(generation), open_tail: await reader.openTailSequences(), has_input: await reader.hasInput('input-1'), missing_references: await reader.hasMissingInputReferences(0),
    unique_position: await reader.uniqueUserPosition(0), prior_users: await reader.userCountBefore(1), navigation: (await reader.navigation()).map(([ordinal, position, fact]) => [ordinal, position, fact.kind]) };
}
test('Python display/model histories read identically with byte pages, navigation and context-usage boundaries', async () => isolated(async directory => {
  const expected = reference(directory, 'seed'); const { state } = await open(directory);
  try {
    const session = await state.get('chat:extensions'); assert.deepEqual(portable(session), expected.session);
    assert.deepEqual(await state.projectHistory(session.key, reader => display(reader, session.generation)), expected.display);
    await state.appendHistory(session.key, [facts()[0]], session.generation);
    assert.deepEqual(await state.projectHistory(session.key, reader => display(reader, session.generation)), expected.display); // duplicate input is idempotent
    const json = reference(directory); assert.deepEqual(json.session, expected.session); assert.deepEqual(json.display, expected.display);
  } finally { await state.close(); }
}));
test('TS session/facts reopen through Python with the same checkpoints, private provider state and display ordering', async () => isolated(async directory => {
  const { state, repository } = await open(directory);
  try {
    const session = newSession(fixture.key); session.createdAt = fixture.created_at; session.updatedAt = fixture.updated_at;
    session.generation = 'f'.repeat(32); session.messages = fixture.messages; session.metadata = fixture.metadata; session.providerState = providerState(fixture.provider_state);
    await repository.save(session); await state.appendHistory(session.key, facts(), session.generation);
    const expected = reference(directory); assert.deepEqual(expected.session, portable(session));
    assert.deepEqual(expected.display, await state.projectHistory(session.key, reader => display(reader, session.generation)));
    assert.equal((await state.get(session.key)).messages.length, fixture.messages.length);
  } finally { await state.close(); }
}));
test('ordered metadata commands and append-only drafts merge without losing independently accepted changes', async () => isolated(async directory => {
  const { state } = await open(directory);
  try {
    const draft = await state.get('chat:ordered'); const created = draft.updatedAt;
    await Promise.all(Array.from({ length: 24 }, () => state.mutateMetadata(draft.key, metadata => { metadata.counter = Number(metadata.counter ?? 0) + 1; })));
    assert.equal((await state.read(draft.key))!.updatedAt, created);
    addSessionMessage(draft, 'user', 'from draft'); await state.finishTurn(draft);
    assert.equal(draft.metadata.counter, 24); assert.equal((await state.read(draft.key))!.messages[0].content, 'from draft');
    const first = await state.get(draft.key), second = await state.get(draft.key);
    addSessionMessage(first, 'user', 'first suffix'); addSessionMessage(second, 'user', 'second suffix');
    await state.finishTurn(first); await state.finishTurn(second);
    assert.deepEqual((await state.read(draft.key))!.messages.map(message => message.content), ['from draft', 'first suffix', 'second suffix']);
    const detached = await state.read(draft.key); detached!.metadata.counter = -100; detached!.messages[0].content = 'not persisted';
    assert.equal(state.peek(draft.key)!.metadata.counter, 24); assert.equal((await state.read(draft.key))!.messages[0].content, 'from draft');
    assert.throws(() => state.updateMetadata(draft.key, { runtime_checkpoint: {} }), /turn operations/);
    const stale = await state.get(draft.key); stale.metadata.counter = 25;
    await state.updateMetadata(draft.key, { counter: 26 }); await assert.rejects(state.finishTurn(stale), SessionConflictError);
  } finally { await state.close(); }
}));
test('reset/delete revoke old drafts and display generations without resurrecting deleted sessions', async () => isolated(async directory => {
  const { state } = await open(directory);
  try {
    const old = await state.get('chat:lifecycle'); addSessionMessage(old, 'user', 'old'); await state.finishTurn(old);
    await state.appendHistory(old.key, [new HistoryFact('input', { text: 'old', input_id: 'old' })], old.generation);
    await state.setArchivedKeys([old.key]); await state.reset(old.key);
    const current = await state.get(old.key); assert.notEqual(current.generation, old.generation); assert.deepEqual(current.messages, []);
    assert.deepEqual(await state.archivedKeys(), [old.key]);
    await assert.rejects(state.finishTurn(old), SessionConflictError);
    await assert.rejects(state.appendHistory(old.key, facts(), old.generation), SessionConflictError);
    const child = await state.get('chat:child'); await state.updateMetadata(child.key, { parent_session_key: old.key });
    const grandchild = await state.get('chat:grandchild'); await state.updateMetadata(grandchild.key, { parent_session_key: child.key });
    assert.equal(await state.delete(old.key, { expectedGeneration: current.generation }), true);
    assert.equal(await state.read(child.key), null); assert.equal(await state.read(grandchild.key), null);
    await assert.rejects(state.updateMetadata(old.key, { late: true }, { createIfMissing: true }), SessionConflictError);
    assert.deepEqual(await state.archivedKeys(), []); assert.equal(await state.projectHistory(old.key, reader => reader.revision()), null);
    assert.notEqual((await state.get(old.key)).generation, current.generation);
  } finally { await state.close(); }
}));
test('fork copies model/display prefixes in one transaction and rolls back a failed projection', async () => isolated(async directory => {
  const { state } = await open(directory);
  try {
    const source = await state.get('chat:fork-source');
    source.metadata.title = 'source title'; source.metadata.runtime_checkpoint = { phase: 'model_input' };
    addSessionMessage(source, 'user', 'question\n\nprivate', { _runtime_context: { version: 1, suffix: 'private' } });
    addSessionMessage(source, 'assistant', 'answer'); addSessionMessage(source, 'user', 'next'); await state.finishTurn(source);
    await state.appendHistory(source.key, facts(), source.generation);
    const fork = await state.fork(source.key, 'chat:forked', 1); assert.ok(fork);
    assert.deepEqual(fork.messages.map(message => message.content), ['question', 'answer']); assert.equal(fork.metadata.runtime_checkpoint, undefined); assert.equal(fork.metadata.title, undefined); assert.equal(fork.providerState, null);
    assert.deepEqual((await state.projectHistory(fork.key, reader => reader.allFacts())).map(fact => fact.kind), [...fixtureFacts.slice(0, 5).map((fact: { kind: string }) => fact.kind), 'fork_boundary']);
    const noHistory = await state.get('chat:no-display'); addSessionMessage(noHistory, 'user', 'work'); await state.finishTurn(noHistory);
    await assert.rejects(state.fork(noHistory.key, 'chat:failed-fork', 1, { historyProjection: () => { throw new Error('projection failed'); } }), /projection failed/);
    assert.equal(await state.read('chat:failed-fork'), null); assert.equal((await state.get(noHistory.key)).messages[0].content, 'work');
  } finally { await state.close(); }
}));
test('WAL snapshot remains consistent while a separate ordered mutation commits', async () => isolated(async directory => {
  const { state } = await open(directory); let entered!: () => void, resume!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
  try {
    const session = await state.get('chat:snapshot'); await state.updateMetadata(session.key, { version: 'before' });
    const reading = state.snapshot(async snapshot => {
      const first = await snapshot.all('SELECT metadata FROM sessions WHERE key=?', [session.key]); entered(); await release;
      const second = await snapshot.all('SELECT metadata FROM sessions WHERE key=?', [session.key]); return [first[0].metadata, second[0].metadata];
    });
    await ready; await state.updateMetadata(session.key, { version: 'after' }); resume();
    const [first, second] = await reading; assert.equal(first, second); assert.equal((await state.read(session.key))!.metadata.version, 'after');
  } finally { resume(); await state.close(); }
}));
test('bounded owner drains accepted mutations on cancellation/close while snapshot reads stay responsive', { timeout: 6000 }, async () => isolated(async directory => {
  const { state, driver } = await open(directory, 3); const session = await state.get('chat:capacity');
  const locker = await new Promise<sqlite3.Database>((resolve, reject) => { const db = new sqlite3.Database(driver.path, error => error ? reject(error) : resolve(db)); });
  const native = (sql: string) => new Promise<void>((resolve, reject) => locker.exec(sql, error => error ? reject(error) : resolve()));
  let released = false;
  try {
    await native('BEGIN IMMEDIATE'); const cancellation = new AbortController();
    const first = state.updateMetadata(session.key, { accepted: 1 }, { signal: cancellation.signal }); const rejected = assert.rejects(first, { name: 'AbortError' }); cancellation.abort();
    const second = state.updateMetadata(session.key, { accepted: 2 });
    const third = state.snapshot(snapshot => snapshot.all('SELECT key FROM sessions'));
    assert.throws(() => state.get('chat:overflow'), SessionOperationQueueFullError); assert.equal((await third).length, 1);
    const closing = state.close(); assert.throws(() => state.get('chat:closed'), /closed/);
    await native('COMMIT'); released = true; await rejected; await second; await closing;
    const peer = await SqliteDriver.open(driver.path); try { assert.equal(JSON.parse(String((await peer.read(snapshot => snapshot.all('SELECT metadata FROM sessions WHERE key=?', [session.key])))[0].metadata)).accepted, 2); } finally { await peer.close(); }
  } finally { if (!released) await native('ROLLBACK'); await new Promise<void>((resolve, reject) => locker.close(error => error ? reject(error) : resolve())); await state.close(); }
}));
test('temporary policy leaves no durable model transcript and does not expose shared mutable records', async () => isolated(async directory => {
  const { state, driver } = await open(directory);
  try {
    const temporary = newSession('chat:temporary'); temporary.messages = [{ role: 'user', content: 'private' }];
    const draft = await state.registerTransient(temporary, { persist: false, logContent: false, disabledTools: ['memory'] });
    addSessionMessage(draft, 'assistant', 'private reply'); await state.finishTurn(draft);
    assert.equal((await state.get(draft.key)).messages.length, 2);
    assert.equal((await driver.read(snapshot => snapshot.all('SELECT * FROM sessions WHERE key=?', [draft.key]))).length, 0);
    await state.mutateMetadata(draft.key, metadata => { metadata.temporary = true; }); assert.equal((await state.get(draft.key)).messages.length, 2);
  } finally { await state.close(); }
}));

test('draft merging retains Python boolean/integer JSON equality without rewriting stored types', async () => isolated(async directory => {
  const expected = reference(directory, 'metadata_equality');
  const { state } = await open(directory);
  try {
    // Reuse the committed Python baseline and perform the same supported draft edit.
    const draft = await state.get('chat:comparison');
    draft.metadata.flag = 1; draft.metadata.nested = { value: 0 };
    await state.finishTurn(draft);
    assert.deepEqual(draft.metadata, expected.metadata);
    assert.equal(draft.revision, expected.revision + 1);
    assert.equal((await state.read(draft.key))!.metadata.flag, true);
  } finally { await state.close(); }
}));

test('existing Python large integers reject reads and title edits without altering authoritative JSON', async () => isolated(async directory => {
  const opened = await open(directory);
  try {
    await opened.state.get('chat:large');
    const script = 'import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); c.execute("UPDATE sessions SET metadata=? WHERE key=?", (json.dumps({"integer":1234567890123456789,"title":"original"}),"chat:large")); c.commit()';
    const seeded = spawnSync(python, ['-c', script, join(directory, 'sessions.sqlite3')], { encoding: 'utf8' }); assert.equal(seeded.status, 0, seeded.stderr);
    await assert.rejects(opened.state.get('chat:large'), /safe integer range/);
    await assert.rejects(opened.state.updateMetadata('chat:large', { title: 'changed' }), /safe integer range/);
    const inspected = spawnSync(python, ['-c', 'import sqlite3,json,sys; m=json.loads(sqlite3.connect(sys.argv[1]).execute("SELECT metadata FROM sessions WHERE key=?",("chat:large",)).fetchone()[0]); assert m["title"]=="original"; print(str(m["integer"]))', join(directory, 'sessions.sqlite3')], { encoding: 'utf8' });
    assert.equal(inspected.status, 0, inspected.stderr); assert.equal(inspected.stdout.trim(), '1234567890123456789');
  } finally { await opened.state.close(); }
}));

test('policy changes cannot promote private transient history or missing sessions to durable storage', async () => isolated(async directory => {
  const opened = await open(directory), durable = { persist: true, logContent: true, disabledTools: ['shell'] }, temporary = { persist: false, logContent: false, disabledTools: [] };
  try {
    const secret = newSession('chat:private'); addSessionMessage(secret, 'user', 'private-history');
    await opened.state.registerTransient(secret, temporary);
    await assert.rejects(opened.state.setPolicy(secret.key, durable), /existing durable session/);
    await assert.rejects(opened.state.setPolicy('chat:missing', durable), /existing durable session/);
    await assert.rejects(opened.state.setPolicy(secret.key, temporary), /registerTransient/);
    await opened.state.updateMetadata(secret.key, { title: 'private title' });
    assert.equal((await opened.state.get(secret.key)).messages[0].content, 'private-history');
    await opened.state.get('chat:durable');
    await opened.state.setPolicy('chat:durable', durable);
    assert.deepEqual((await opened.state.get('chat:durable')).policy, durable);
    await assert.rejects(opened.state.setPolicy('chat:durable', temporary), /registerTransient/);
    assert.deepEqual((await opened.state.get('chat:durable')).policy, durable);
  } finally { await opened.state.close(); }
  const reopened = await open(directory);
  try {
    assert.equal(await reopened.state.read('chat:private'), null); assert.equal(await reopened.state.read('chat:missing'), null);
    assert.ok(await reopened.state.read('chat:durable'));
    assert.equal((await reopened.driver.read(snapshot => snapshot.all("SELECT key FROM sessions WHERE key IN ('chat:private','chat:missing')"))).length, 0);
  } finally { await reopened.state.close(); }
}));
