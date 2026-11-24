import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile, stat, cp, rename, unlink, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { SessionLocation, withNamespaceLock, atomicPrivateWrite } from '@nanobot/runtime';
const repository = fileURLToPath(new URL('../../../', import.meta.url));
const python = process.env.NANOBOT_TEST_PYTHON ?? join(repository, '.venv/bin/python');
const env = { ...process.env, PYTHONPATH: repository };
async function isolated(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-ts-location-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function reference(workspace: string, root: string): string {
  const child = spawnSync(python, ['-c', 'import sys;from pathlib import Path;from nanobot.session.location import SessionLocation;print(SessionLocation(Path(sys.argv[1]),sessions_root=Path(sys.argv[2])).sessions_dir)', workspace, root], { env, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr); return child.stdout.trim();
}
test('workspace identity interoperates with Python across alias, copied and moved workspaces', async () => isolated(async directory => {
  const workspace = join(directory, 'workspace'), root = join(directory, 'sessions');
  const original = await SessionLocation.open(workspace, root); assert.equal(reference(workspace, root), original.sessionsDirectory);
  const alias = join(directory, 'alias'); await symlink(workspace, alias); assert.equal((await SessionLocation.open(alias, root)).sessionsDirectory, original.sessionsDirectory);
  const copied = join(directory, 'copied'); await cp(workspace, copied, { recursive: true });
  const copy = await SessionLocation.open(copied, root); assert.notEqual(copy.sessionsDirectory, original.sessionsDirectory); assert.equal(reference(copied, root), copy.sessionsDirectory);
  await unlink(join(workspace, '.nanobot/workspace-id'));
  assert.equal((await SessionLocation.open(workspace, root)).sessionsDirectory, original.sessionsDirectory);
  const moved = join(directory, 'moved'); await rename(workspace, moved);
  assert.equal((await SessionLocation.open(moved, root)).sessionsDirectory, original.sessionsDirectory); assert.equal(reference(moved, root), original.sessionsDirectory);
  assert.equal((await stat(root)).mode & 0o777, 0o700); assert.equal((await stat(join(moved, '.nanobot/workspace-id'))).mode & 0o777, 0o600);
}));
test('namespace locking actually excludes Python FileLock in both directions', async () => isolated(async directory => {
  const workspace = join(directory, 'workspace'), root = join(directory, 'sessions'); await mkdir(root);
  const lock = join(root, '.workspace-migration.lock');
  const child = spawn(python, ['-c', 'import sys;from filelock import FileLock;lock=FileLock(sys.argv[1]);lock.acquire();print("locked",flush=True);sys.stdin.readline();lock.release()', lock], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  try {
    await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw new Error('Python lock holder exited before readiness'); })]); let completed = false;
    const pending = SessionLocation.open(workspace, root).then(result => { completed = true; return result; });
    await delay(40); assert.equal(completed, false); child.stdin.write('release\n'); await pending; await exited;
    await withNamespaceLock(lock, async () => {
      const probe = spawnSync(python, ['-c', 'import sys;from filelock import FileLock,Timeout\ntry:\n FileLock(sys.argv[1],timeout=0).acquire()\n print("incorrectly acquired")\nexcept Timeout:\n print("busy")', lock], { env, encoding: 'utf8' });
      assert.equal(probe.status, 0, probe.stderr); assert.equal(probe.stdout.trim(), 'busy');
    });
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } }
}));
test('native backup timestamps retain exact nanoseconds with private atomic writes', async () => isolated(async directory => {
  const path = join(directory, 'backup.jsonl'), ns = 1700000000123456789n;
  await atomicPrivateWrite(path, 'synthetic backup', { atimeNs: ns, mtimeNs: ns });
  const result = await stat(path, { bigint: true }); assert.equal(result.mtimeNs, ns); assert.equal(result.atimeNs, ns); assert.equal(Number(result.mode & 0o777n), 0o600);
}));
test('location rejects in-workspace storage and symlink identity/namespace markers', async () => isolated(async directory => {
  const workspace = join(directory, 'workspace'); await assert.rejects(SessionLocation.open(workspace, join(workspace, 'sessions')), /outside/);
  const root = join(directory, 'sessions'); await mkdir(join(workspace, '.nanobot'), { recursive: true });
  const external = join(directory, 'external'); await writeFile(external, 'f'.repeat(32));
  await symlink(external, join(workspace, '.nanobot/workspace-id'));
  await assert.rejects(SessionLocation.open(workspace, root), /must not be a symlink/);
  assert.equal(await readFile(external, 'utf8'), 'f'.repeat(32));
  await unlink(join(workspace, '.nanobot/workspace-id'));
  const location = await SessionLocation.open(workspace, root); const marker = join(location.sessionsDirectory, '.workspace');
  await unlink(marker); await symlink(external, marker); await assert.rejects(SessionLocation.open(workspace, root), /must not be a symlink/);
}));
