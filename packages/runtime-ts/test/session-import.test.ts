import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat, unlink, access, utimes, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { openSessionStore, SessionLocation, SqliteDriver } from '@nanobot/runtime';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const python = process.env.NANOBOT_TEST_PYTHON ?? join(repository, '.venv/bin/python');
async function isolated(run: (directory: string, workspace: string, root: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-ts-import-')), workspace = join(directory, 'workspace'), root = join(directory, 'sessions');
  try { await mkdir(join(workspace, 'sessions'), { recursive: true }); await run(directory, workspace, root); } finally { await rm(directory, { recursive: true, force: true }); }
}
function legacy(key = 'websocket:legacy', metadata: object = {}) {
  return [JSON.stringify({ _type: 'metadata', key, metadata, created_at: '2026-01-01T00:00:00', updated_at: '2026-01-01T00:00:00', last_archived: 0 }), JSON.stringify({ role: 'user', content: '中文🙂\u0085NEL\u2028LS\u2029PS\nLF\rCR' })].join('\n') + '\n';
}
function inspectPython(workspace: string, root: string, key: string) {
  const child = spawnSync(python, ['-c', 'import sys,json;from pathlib import Path;from nanobot.session.manager import SessionManager;m=SessionManager(Path(sys.argv[1]),sessions_root=Path(sys.argv[2]));s=m.get_existing(sys.argv[3]);print(json.dumps(None if s is None else {"messages":s.messages,"metadata":s.metadata,"provider_state":s.provider_state.to_private_record() if s.provider_state else None}))', workspace, root, key], { cwd: repository, env: { ...process.env, PYTHONPATH: repository }, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout);
}
test('legacy JSONL and matching checkpoint migrate atomically, leave exact private backups and reopen in Python', async () => isolated(async (_directory, workspace, root) => {
  const key = 'websocket:legacy', path = join(workspace, 'sessions/old.jsonl'), content = legacy(key);
  await writeFile(path, content); const sourceStat = await stat(path, { bigint: true });
  const provider = { kind: 'openai_responses', provider: 'openai', model: 'model', version: 1, payload: { cursor: 'synthetic-private' }, pending_messages: [] };
  const checkpointPath = join(workspace, 'sessions/old.checkpoint.json');
  await writeFile(checkpointPath, JSON.stringify({ version: 1, session_key: key, base_updated_at: '2026-01-01T00:00:00', base_message_count: 1, checkpoint: { phase: 'final_response', assistant_message: { role: 'assistant', content: 'committed' } }, provider_state: provider }));
  const opened = await openSessionStore({ workspace, sessionsRoot: root });
  try {
    const session = await opened.state.get(key); assert.equal(session.metadata.runtime_checkpoint && typeof session.metadata.runtime_checkpoint, 'object'); assert.deepEqual(session.providerState, provider);
    await assert.rejects(access(path)); await assert.rejects(access(checkpointPath));
    const backup = join(opened.location.sessionsDirectory, 'jsonl-backup/old.jsonl');
    assert.equal((await stat(backup, { bigint: true })).mtimeNs, sourceStat.mtimeNs); assert.equal((await stat(backup)).mode & 0o777, 0o600); assert.equal(await readFile(backup, 'utf8'), content);
    const python = inspectPython(workspace, root, key); assert.deepEqual(python.messages, session.messages); assert.deepEqual(python.metadata, session.metadata); assert.deepEqual(python.provider_state, provider);
  } finally { await opened.close(); }
}));
test('malformed import rolls back schema and every row without altering sources', async () => isolated(async (_directory, workspace, root) => {
  const valid = join(workspace, 'sessions/first.jsonl'), broken = join(workspace, 'sessions/last.jsonl'), original = legacy(); await writeFile(valid, original); await writeFile(broken, 'not JSON');
  await assert.rejects(openSessionStore({ workspace, sessionsRoot: root }), /JSONL migration failed/);
  assert.equal(await readFile(valid, 'utf8'), original); assert.equal(await readFile(broken, 'utf8'), 'not JSON');
  const location = await SessionLocation.open(workspace, root), driver = await SqliteDriver.open(join(location.sessionsDirectory, 'sessions.sqlite3'));
  try { assert.equal((await driver.read(snapshot => snapshot.all('PRAGMA user_version')))[0].user_version, 0); assert.equal((await driver.read(snapshot => snapshot.all("SELECT name FROM sqlite_master WHERE type='table'"))).length, 0); }
  finally { await driver.close(); }
  await unlink(broken); const opened = await openSessionStore({ workspace, sessionsRoot: root }); try { assert.equal((await opened.state.get('websocket:legacy')).messages.length, 1); } finally { await opened.close(); }
}));
test('nested duplicate keys and repeated provider blocks fail closed before removing legacy data', async () => isolated(async (_directory, workspace, root) => {
  const path = join(workspace, 'sessions/old.jsonl');
  const cases = [legacy().split('\n')[0] + '\n{"role":"user","content":{"x":1,"\\u0078":2}}\n', legacy() + '{"_type":"provider_state","state":{"kind":"k","provider":"p","model":"m","version":1,"payload":{}}}\n' + '{"_type":"provider_state","state":{"kind":"k","provider":"p","model":"m","version":1,"payload":{}}}\n'];
  for (const value of cases) { await writeFile(path, value); await assert.rejects(openSessionStore({ workspace, sessionsRoot: root }), /migration failed/); assert.equal(await readFile(path, 'utf8'), value); }
}));
test('committed import resumes failed backup isolation and rejects a changed workspace source', async () => isolated(async (_directory, workspace, root) => {
  const path = join(workspace, 'sessions/old.jsonl'), original = legacy(); await writeFile(path, original);
  const location = await SessionLocation.open(workspace, root), backup = join(location.sessionsDirectory, 'jsonl-backup'); await mkdir(backup); await writeFile(join(backup, 'old.jsonl'), 'conflicting backup');
  await assert.rejects(openSessionStore({ workspace, sessionsRoot: root }), /Could not move legacy/); assert.equal(await readFile(path, 'utf8'), original);
  await unlink(join(backup, 'old.jsonl')); await writeFile(path, legacy('websocket:changed'));
  await assert.rejects(openSessionStore({ workspace, sessionsRoot: root }), /Could not move legacy/); assert.equal(await readFile(path, 'utf8'), legacy('websocket:changed'));
  await writeFile(path, original); const opened = await openSessionStore({ workspace, sessionsRoot: root });
  try { assert.equal((await opened.state.get('websocket:legacy')).messages.length, 1); assert.equal(await readFile(join(backup, 'old.jsonl'), 'utf8'), original); await assert.rejects(access(path)); }
  finally { await opened.close(); }
}));
test('identical private/workspace copies import once; deleting cannot resurrect retained private JSONL', async () => isolated(async (_directory, workspace, root) => {
  const location = await SessionLocation.open(workspace, root), privatePath = join(location.sessionsDirectory, 'copy.jsonl'), workspacePath = join(workspace, 'sessions/copy.jsonl'), original = legacy();
  await writeFile(privatePath, original); await writeFile(workspacePath, original);
  let opened = await openSessionStore({ workspace, sessionsRoot: root });
  try { const session = await opened.state.get('websocket:legacy'); assert.equal(session.messages.length, 1); assert.equal(await readFile(privatePath, 'utf8'), original); await opened.state.delete(session.key); } finally { await opened.close(); }
  await writeFile(privatePath, 'stale invalid source is deliberately ignored after import'); opened = await openSessionStore({ workspace, sessionsRoot: root });
  try { assert.equal(await opened.state.read('websocket:legacy'), null); } finally { await opened.close(); }
}));
test('older checkpoint is preserved in backup without overriding current state; source symlinks are rejected', async () => isolated(async (directory, workspace, root) => {
  const path = join(workspace, 'sessions/old.jsonl'), checkpoint = join(workspace, 'sessions/old.checkpoint.json'); await writeFile(path, legacy());
  await writeFile(checkpoint, JSON.stringify({ version: 1, session_key: 'websocket:legacy', base_updated_at: '2026-01-01T00:00:00', base_message_count: 1, checkpoint: { phase: 'awaiting_tools' } }));
  await utimes(checkpoint, 1, 1); const opened = await openSessionStore({ workspace, sessionsRoot: root });
  try { assert.equal((await opened.state.get('websocket:legacy')).metadata.runtime_checkpoint, undefined); await access(join(opened.location.sessionsDirectory, 'jsonl-backup/old.checkpoint.json')); }
  finally { await opened.close(); }
  const other = join(directory, 'other'); await mkdir(join(other, 'sessions'), { recursive: true }); const external = join(directory, 'external'); await writeFile(external, legacy()); await symlink(external, join(other, 'sessions/link.jsonl'));
  await assert.rejects(openSessionStore({ workspace: other, sessionsRoot: root }), /migration failed/); assert.equal(await readFile(external, 'utf8'), legacy());
}));

test('unsafe legacy integers roll back migration and preserve exact authoritative originals', async () => isolated(async (_directory, workspace, root) => {
  const path = join(workspace, 'sessions/old.jsonl');
  for (const integer of ['1234567890123456789', '9007199254740992', '-9007199254740992']) {
    const original = legacy().replace('"metadata":{}', `"metadata":{"integer":${integer}}`);
    await writeFile(path, original);
    await assert.rejects(openSessionStore({ workspace, sessionsRoot: root }), /migration failed/);
    assert.equal(await readFile(path, 'utf8'), original);
    const oracle = spawnSync(python, ['-c', 'import json,sys;print(str(json.loads(open(sys.argv[1]).readline())["metadata"]["integer"]))', path], { encoding: 'utf8' });
    assert.equal(oracle.status, 0, oracle.stderr); assert.equal(oracle.stdout.trim(), integer);
    const location = await SessionLocation.open(workspace, root), driver = await SqliteDriver.open(join(location.sessionsDirectory, 'sessions.sqlite3'));
    try { assert.equal((await driver.read(snapshot => snapshot.all("SELECT name FROM sqlite_master WHERE type='table'"))).length, 0); }
    finally { await driver.close(); }
  }
  await writeFile(path, legacy().replace('"metadata":{}', '"metadata":{"integer":9007199254740991}'));
  const opened = await openSessionStore({ workspace, sessionsRoot: root });
  try { assert.equal((await opened.state.get('websocket:legacy')).metadata.integer, Number.MAX_SAFE_INTEGER); } finally { await opened.close(); }
}));
