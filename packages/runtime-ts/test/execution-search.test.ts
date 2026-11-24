import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rename, rm, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WorkspaceFiles, withFileExclusions, buildWorkspaceScope, withWorkspaceScope, FileAccessError } from '@nanobot/runtime';
import type { WorkspaceFilesOptions, SearchBytesReader } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
async function isolated(run: (directory: string, options: WorkspaceFilesOptions) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-search-')), workspace = join(directory, 'workspace'), builtin = join(directory, 'builtin'), media = join(directory, 'instance', 'media');
  try { await Promise.all([mkdir(workspace), mkdir(builtin), mkdir(media, { recursive: true })]); await run(directory, { workspace, allowedDirectory: workspace, builtinSkillsDirectory: builtin, mediaDirectory: media }); } finally { await rm(directory, { recursive: true, force: true }); }
}
type Case = { operation: 'list' | 'entries' | 'bytes' | 'modified'; recursive?: boolean; ignored?: string[]; limit?: number; excluded?: string[]; extra?: string[]; paths?: string[]; names?: string[] };
test('descriptor directory listing and bounded search match Python, including links, exclusions, ordering and exact totals', { skip: process.platform !== 'linux' }, async () => isolated(async (directory, options) => {
  const workspace = options.workspace!, outside = join(directory, 'outside'); await Promise.all([mkdir(join(workspace, 'a')), mkdir(join(workspace, 'ignored')), mkdir(outside)]);
  const files = [['small', 'tiny'], ['large', 'x'.repeat(100)], ['a/child', 'nested'], ['a.txt', 'sibling'], ['ignored/file', 'ignored'], ['😀', 'emoji'], ['\uffff', 'high BMP']] as const;
  await Promise.all(files.map(async ([name, data]) => { const path = join(workspace, name); await writeFile(path, data); await utimes(path, 1700000000, 1700000000); }));
  await writeFile(join(outside, 'secret'), 'synthetic outside'); await utimes(join(outside, 'secret'), 1700000000, 1700000000); await symlink(outside, join(workspace, 'dir-link')); await symlink(join(outside, 'secret'), join(workspace, 'external')); await symlink('small', join(workspace, 'internal'));
  const cases: Case[] = [
    ...[false, true].flatMap(recursive => [0, 3, 100].map(limit => ({ operation: 'list' as const, recursive, limit, ignored: ['ignored'] }))),
    { operation: 'entries', excluded: [join(workspace, 'ignored')] },
    { operation: 'bytes', paths: ['small', 'large', 'external', 'internal', 'a/child', 'missing'], limit: 10 },
    { operation: 'bytes', paths: ['external'], extra: [outside], limit: 100 },
    { operation: 'bytes', paths: ['small', 'internal'], excluded: [join(workspace, 'small')], limit: 10 },
    { operation: 'modified', names: ['small', 'large', 'internal', 'external', 'missing'] },
  ];
  const child = spawn(process.env.NANOBOT_TEST_PYTHON ?? join(root, '.venv/bin/python'), [fileURLToPath(new URL('./execution-search-reference.py', import.meta.url))], { cwd: root, env: { ...process.env, HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'), PYTHONPATH: root } });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.stdin.end(JSON.stringify({ workspace, builtin: options.builtinSkillsDirectory, instance: join(directory, 'instance'), cases })); const [status] = await once(child, 'close'); assert.equal(status, 0, stderr); const expected: unknown[] = JSON.parse(stdout);
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index], owner = new WorkspaceFiles({ ...options, extraReadAllowedDirectories: item.extra });
    const actual = await withFileExclusions(item.excluded ?? [], async () => {
      if (item.operation === 'list') return owner.listDirectory('.', { recursive: item.recursive!, ignored: new Set(item.ignored), limit: item.limit! });
      const tree = await owner.searchTree('.'); if (item.operation === 'entries') { const values = []; for await (const entry of tree.entries(workspace)) values.push(entry); return values; }
      if (item.operation === 'modified') return tree.modifiedChildren(workspace, item.names!);
      return tree.withBytesReader(async read => { const values = []; for (const path of item.paths!) { const value = await read(join(workspace, path), item.limit!); values.push(value === null ? null : { data: value.data === null ? null : value.data.toString('base64'), modified: value.modified }); } return values; });
    });
    // Entry enumeration itself has no ordering contract; Path-based listing does.
    if (item.operation === 'entries') assert.deepEqual(new Map((actual as { name: string }[]).map(value => [value.name, value])), new Map((expected[index] as { name: string }[]).map(value => [value.name, value]))); else assert.deepEqual(actual, expected[index], JSON.stringify(item));
  }
}));
test('a pinned reader discards results if its authorized directory moves, drains accepted reads and closes its capability', { skip: process.platform !== 'linux' }, async () => isolated(async (directory, options) => {
  const workspace = options.workspace!, parent = join(workspace, 'parent'), moved = join(workspace, 'moved'), outside = join(directory, 'outside'); await mkdir(parent); await mkdir(outside); await writeFile(join(parent, 'file'), 'authorized'); await writeFile(join(outside, 'file'), 'private');
  const tree = await new WorkspaceFiles(options).searchTree('.'); let escaped!: SearchBytesReader; const descriptorCount = (await readdir('/proc/self/fd')).length;
  await assert.rejects(tree.withBytesReader(async read => { escaped = read; assert.equal((await read(join(parent, 'file'), 100))?.data?.toString(), 'authorized'); await rename(parent, moved); await symlink(outside, parent); const values = await Promise.all([read(join(parent, 'file'), 100), read(join(parent, 'file'), 100)]); assert.ok(values.every(value => value?.data?.toString() === 'authorized')); return values; }), FileAccessError);
  await assert.rejects(escaped(join(parent, 'file'), 100), /closed/);
  const full = await buildWorkspaceScope(workspace, 'full', { environment: {} }); await withWorkspaceScope(full, async () => { assert.equal(await tree.readBytes(join(parent, 'file'), 100), null); });
  await assert.rejects(tree.modifiedChildren(workspace, ['../outside']), /direct child/);
  const cancellation = new AbortController(); await assert.rejects(tree.withBytesReader(async read => { await read(join(moved, 'file'), 100); cancellation.abort(new DOMException('cancel pinned reader', 'AbortError')); await read(join(moved, 'file'), 100); }, { signal: cancellation.signal }), /cancel pinned reader/);
  assert.equal((await readdir('/proc/self/fd')).length, descriptorCount);
}));
