import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import sqlite3 from 'sqlite3';
import { SqliteDriver } from '@nanobot/runtime';
const execute = promisify(execFile);
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const python = process.env.NANOBOT_TEST_PYTHON ?? join(repository, '.venv/bin/python');
async function isolated(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-ts-sqlite-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function reference(directory: string, action: string) {
  const result = spawnSync(python, [fileURLToPath(new URL('./sqlite-schema-reference.py', import.meta.url))], {
    cwd: repository, env: { ...process.env, PYTHONPATH: repository }, encoding: 'utf8', input: JSON.stringify({ directory, action }),
  });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
const nativeExec = (database: sqlite3.Database, sql: string) => new Promise<void>((resolve, reject) => database.exec(sql, error => error ? reject(error) : resolve()));
const nativeClose = (database: sqlite3.Database) => new Promise<void>((resolve, reject) => database.close(error => error ? reject(error) : resolve()));
test('native driver JSON, WAL, FULL, foreign keys, transactional rollback and private mode', async () => isolated(async directory => {
  const path = join(directory, 'sessions.sqlite3'); const driver = await SqliteDriver.open(path);
  try {
    await driver.initializeSchema();
    const settings = await driver.read(async snapshot => ({
      version: await snapshot.all('PRAGMA user_version'), journal: await snapshot.all('PRAGMA journal_mode'),
      sync: await snapshot.all('PRAGMA synchronous'), foreign: await snapshot.all('PRAGMA foreign_keys'),
      json: await snapshot.all("SELECT json_extract(?, '$.ok') AS ok", ['{"ok":true}']),
    }));
    assert.equal(settings.version[0].user_version, 6); assert.equal(settings.journal[0].journal_mode, 'wal');
    assert.equal(settings.sync[0].synchronous, 2); assert.equal(settings.foreign[0].foreign_keys, 1); assert.equal(settings.json[0].ok, 1);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await driver.write(transaction => transaction.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value TEXT)'));
    await assert.rejects(driver.write(async transaction => { await transaction.run('INSERT INTO probe VALUES (?,?)', [1, 'first']); await transaction.run('INSERT INTO probe VALUES (?,?)', [1, 'duplicate']); }), /UNIQUE/);
    assert.equal((await driver.read(snapshot => snapshot.all('SELECT * FROM probe'))).length, 0);
    await assert.rejects(driver.read(snapshot => snapshot.all("INSERT INTO probe VALUES (1,'read-only mutation')")), /readonly/);
  } finally { await driver.close(); }
}));
test('real long SELECT is natively interrupted within a bounded child process', { timeout: 6000 }, async () => isolated(async directory => {
  const path = join(directory, 'sessions.sqlite3'); const driver = await SqliteDriver.open(path);
  try {
    await driver.initializeSchema();
    await driver.write(transaction => transaction.exec('CREATE TABLE interrupt_peer(value TEXT)'));
    const result = await execute(process.execPath, [fileURLToPath(new URL('./sqlite-cancel-child.ts', import.meta.url)), path], { timeout: 3000 });
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.nativeCode, 'SQLITE_INTERRUPT'); assert.equal(evidence.writeCommitted, true); assert.ok(evidence.elapsedMs < 1500, JSON.stringify(evidence));
    console.log('native interruption evidence', evidence);
    await driver.write(transaction => transaction.exec('CREATE TABLE after_interrupt (value TEXT)'));
  } finally { await driver.close(); }
}));
test('lock wait leaves HTTP and readers responsive; cancelled accepted write settles before rejection', { timeout: 6000 }, async () => isolated(async directory => {
  const path = join(directory, 'sessions.sqlite3'); const driver = await SqliteDriver.open(path);
  await driver.initializeSchema(); await driver.write(transaction => transaction.exec('CREATE TABLE probe (value TEXT)'));
  const locker = await new Promise<sqlite3.Database>((resolve, reject) => { const db = new sqlite3.Database(path, error => error ? reject(error) : resolve(db)); });
  const server = createServer((_request, response) => response.end('responsive'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP address');
  const controller = new AbortController(); let ticks = 0; const timer = setInterval(() => { ticks++; }, 10);
  let released = false;
  try {
    await nativeExec(locker, 'BEGIN IMMEDIATE');
    const writing = driver.write(transaction => transaction.run('INSERT INTO probe VALUES (?)', ['accepted']), controller.signal);
    const rejected = assert.rejects(writing, { name: 'AbortError' });
    controller.abort();
    const started = performance.now();
    const response = await fetch(`http://127.0.0.1:${address.port}`); assert.equal(await response.text(), 'responsive');
    const servingMs = performance.now() - started;
    assert.equal((await driver.read(snapshot => snapshot.all('SELECT * FROM probe'))).length, 0);
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.ok(ticks >= 5, `Event-loop timer ticked only ${ticks} times`); assert.ok(servingMs < 1000, `HTTP blocked for ${servingMs}ms`);
    await nativeExec(locker, 'COMMIT'); released = true; await rejected;
    assert.equal((await driver.read(snapshot => snapshot.all('SELECT value FROM probe')))[0].value, 'accepted');
    console.log('lock response evidence', { servingMs, ticks, sqlite: sqlite3.VERSION });
  } finally {
    clearInterval(timer); if (!released) await nativeExec(locker, 'ROLLBACK');
    await nativeClose(locker); await new Promise<void>(resolve => server.close(() => resolve())); await driver.close();
  }
}));
test('Python v1 fixture upgrades; TS updates survive Python reopen and subsequent write', async () => isolated(async directory => {
  const before = reference(directory, 'create_v1');
  const driver = await SqliteDriver.open(join(directory, 'sessions.sqlite3'));
  try {
    await driver.initializeSchema();
    const rows = await driver.read(snapshot => snapshot.all('SELECT generation, created_at, updated_at, revision FROM sessions WHERE key=?', [before.key]));
    assert.equal(rows[0].generation, before.generation); assert.equal(rows[0].created_at, before.created_at); assert.equal(rows[0].updated_at, before.updated_at);
    await driver.write(async transaction => {
      await transaction.run('INSERT INTO messages (session_key,position,record) VALUES (?,?,?)', [before.key, before.messages.length, JSON.stringify({ role: 'assistant', content: 'TS after Python' })]);
      await transaction.run('UPDATE sessions SET revision=revision+1 WHERE key=? AND generation=?', [before.key, before.generation]);
    });
    const after = reference(directory, 'read_write');
    assert.equal(after.generation, before.generation); assert.equal(after.revision, before.revision + 2);
    assert.deepEqual(after.metadata, before.metadata); assert.deepEqual(after.provider_state, before.provider_state);
    assert.equal(after.messages.at(-2).content, 'TS after Python'); assert.equal(after.messages.at(-1).content, 'Python after TS');
    const messages = await driver.read(snapshot => snapshot.all('SELECT record FROM messages WHERE session_key=? ORDER BY position', [before.key]));
    assert.deepEqual(messages.map(row => JSON.parse(String(row.record))), after.messages);
  } finally { await driver.close(); }
}));
test('future schema rejected before WAL changes; symlink database rejected', async () => isolated(async directory => {
  const path = join(directory, 'sessions.sqlite3'); const driver = await SqliteDriver.open(path);
  try {
    await driver.write(transaction => transaction.exec('PRAGMA user_version=7'));
    await assert.rejects(driver.initializeSchema(), /unsupported session database schema: 7/);
    assert.equal((await driver.read(snapshot => snapshot.all('PRAGMA journal_mode')))[0].journal_mode, 'delete');
    const alias = join(directory, 'alias.sqlite3'); await symlink(path, alias); await assert.rejects(SqliteDriver.open(alias), /must not be a symlink/);
  } finally { await driver.close(); }
}));
