import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { WorkspaceFiles, WritableFile, NotRegularFileError, FileReadLimitError, buildWorkspaceScope, withWorkspaceScope, withFileExclusions, commitFileEdits } from '@nanobot/runtime';
import type { WorkspaceFilesOptions } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
async function isolated(run: (directory: string, options: WorkspaceFilesOptions) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-files-')), agent = join(directory, 'agent'), builtin = join(directory, 'builtin'), media = join(directory, 'instance', 'media');
  try { await Promise.all([mkdir(agent), mkdir(builtin), mkdir(media, { recursive: true })]); await run(directory, { workspace: agent, allowedDirectory: agent, builtinSkillsDirectory: builtin, mediaDirectory: media }); } finally { await rm(directory, { recursive: true, force: true }); }
}
type Selection = { operation: 'read' | 'edit' | 'siblings'; path: string; project?: string; mode?: string; options?: Partial<WorkspaceFilesOptions>; excluded?: string[]; writesOnly?: boolean };
test('scoped authorized selections and previews match Python for read/write roots, managed files and exclusions', async () => isolated(async (directory, options) => {
  const agent = options.workspace!, project = join(directory, 'project'), outside = join(directory, 'outside'), builtin = options.builtinSkillsDirectory;
  await Promise.all([mkdir(join(agent, 'memory', 'wiki'), { recursive: true }), mkdir(join(agent, 'skills'), { recursive: true }), mkdir(project), mkdir(outside), mkdir(join(builtin, 'demo'))]);
  await Promise.all([writeFile(join(agent, 'memory', 'history.jsonl'), 'managed history'), writeFile(join(agent, 'memory', '.cursor'), 'managed cursor'), writeFile(join(agent, 'memory', '.dream_cursor'), 'managed dream'), writeFile(join(agent, 'skills', 'SKILL.md'), 'agent skill'), writeFile(join(agent, 'memory', 'wiki', 'topic.md'), 'wiki'), writeFile(join(builtin, 'demo', 'SKILL.md'), 'builtin fallback'), writeFile(join(project, 'file.txt'), 'project\r\ntext'), writeFile(join(outside, 'approved.txt'), 'approved'), writeFile(join(outside, 'private.txt'), 'private'), writeFile(join(options.mediaDirectory, 'image.txt'), 'uploaded')]);
  const extra = { extraReadAllowedDirectories: [join(agent, 'skills'), join(agent, 'memory', 'wiki')], extraReadAllowedFiles: [join(agent, 'memory', 'history.jsonl')] }, approved = join(outside, 'approved.txt');
  const cases: Selection[] = [
    { operation: 'read', path: 'file.txt', project }, { operation: 'edit', path: 'file.txt', project },
    { operation: 'read', path: approved, project, options: { extraAllowedDirectories: [outside] } },
    { operation: 'edit', path: approved, project, options: { extraAllowedDirectories: [outside] } },
    { operation: 'edit', path: approved, project, options: { extraWriteAllowedDirectories: [outside] } },
    { operation: 'edit', path: approved, project, options: { extraWriteAllowedFiles: [approved] } },
    { operation: 'siblings', path: approved, project, options: { extraWriteAllowedFiles: [approved] } },
    { operation: 'read', path: join(agent, 'skills', 'SKILL.md'), project, options: extra },
    { operation: 'read', path: join(agent, 'memory', 'history.jsonl'), project, options: extra },
    { operation: 'read', path: join(agent, 'memory', '.cursor'), project, options: extra },
    ...['history.jsonl', '.cursor', '.dream_cursor'].map(name => ({ operation: 'edit' as const, path: join(agent, 'memory', name), project, mode: 'full' })),
    { operation: 'edit', path: 'memory/.cursor', project, mode: 'full' },
    { operation: 'read', path: join(options.mediaDirectory, 'image.txt'), project },
    { operation: 'edit', path: join(options.mediaDirectory, 'image.txt'), project },
    { operation: 'read', path: 'skills/demo/SKILL.md', project },
    { operation: 'read', path: 'file.txt', project, excluded: [join(project, 'file.txt')] },
    { operation: 'edit', path: 'file.txt', project, excluded: [join(project, 'file.txt')], writesOnly: true },
    { operation: 'read', path: 'file.txt', project, excluded: [join(project, 'file.txt')], writesOnly: true },
    { operation: 'edit', path: approved, project, mode: 'full' },
  ];
  const child = spawn(process.env.NANOBOT_TEST_PYTHON ?? join(root, '.venv/bin/python'), [fileURLToPath(new URL('./execution-files-reference.py', import.meta.url))], { cwd: root, env: { ...process.env, HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'), PYTHONPATH: root } });
  let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.stdin.end(JSON.stringify({ agent, builtin, instance: join(directory, 'instance'), cases })); const [status] = await once(child, 'close'); assert.equal(status, 0, stderr);
  const expected: unknown[] = JSON.parse(stdout);
  for (let index = 0; index < cases.length; index++) {
    const item = cases[index], files = new WorkspaceFiles({ ...options, ...item.options }), scope = await buildWorkspaceScope(item.project ?? agent, item.mode ?? 'restricted', { environment: {} });
    const operation = async () => { try { if (item.operation === 'read') { const target = await files.readFile(item.path); return { path: target.path, size: target.size, suffix: target.suffix, text: (await target.readBytes()).toString('utf8') }; } const target = await files.editTarget(item.path); return item.operation === 'edit' ? { path: target.path, snapshot: await target.snapshot(1024) } : { siblings: (await files.siblingFiles(target)).sort() }; } catch (error) { return { error: (error as Error).name, message: (error as Error).message }; } };
    const actual = await withWorkspaceScope(scope, () => item.excluded ? withFileExclusions(item.excluded, operation, { writesOnly: item.writesOnly }) : operation()); assert.deepEqual(actual, expected[index], JSON.stringify(item));
  }
}));
test('authorized regular handles reject swapped leaf links and FIFOs without changing outside data', { timeout: 6000, skip: !constants.O_NOFOLLOW ? 'requires native no-follow opens and POSIX FIFO support' : false }, async () => isolated(async (directory, options) => {
  const files = new WorkspaceFiles(options), workspace = options.workspace!, inside = join(workspace, 'inside'), outside = join(directory, 'outside'); await writeFile(inside, 'before'); await writeFile(outside, 'private');
  const readable = await files.readFile('inside'), writable = await files.editTarget('inside'); await unlink(inside); await symlink(outside, inside);
  await assert.rejects(readable.readBytes(), { code: 'ELOOP' }); await assert.rejects(writable.write('bad'), { code: 'ELOOP' }); assert.equal(await readFile(outside, 'utf8'), 'private');
  await unlink(inside); await promisify(execFile)('mkfifo', [inside]); await assert.rejects(files.editTarget('inside'), NotRegularFileError); await assert.rejects(files.readFile('inside'), NotRegularFileError); await assert.rejects(readable.readBytes(), NotRegularFileError); await assert.rejects(writable.write('bad'));
}));
test('read ownership closes descriptors, enforces limits and cancellation; admitted writes settle before abort surfaces', async () => isolated(async (_directory, options) => {
  const files = new WorkspaceFiles(options), target = await files.editTarget('created/file.txt'), controller = new AbortController();
  const writing = target.write('accepted\r\nbytes', { createParents: true, signal: controller.signal }); controller.abort(new DOMException('cancel accepted write', 'AbortError')); await assert.rejects(writing, /cancel accepted write/); assert.equal(await readFile(target.path, 'utf8'), 'accepted\r\nbytes');
  const readable = await files.readFile('created/file.txt'); await assert.rejects(readable.readBytes({ maxBytes: 2 }), FileReadLimitError); await assert.rejects(readable.readBytes({ signal: controller.signal }), /cancel accepted write/);
  let handle!: FileHandle; await readable.withOpen(async opened => { handle = opened; assert.equal((await opened.stat()).isFile(), true); }); await assert.rejects(handle.stat(), { code: 'EBADF' });
  await assert.rejects(target.write('must not overwrite', { signal: controller.signal }), /cancel accepted write/); assert.equal(await readFile(target.path, 'utf8'), 'accepted\r\nbytes');
}));
test('multi-file edits restore prior bytes on failure, normalize duplicate target identities and settle accepted cancellation', async () => isolated(async (_directory, options) => {
  const files = new WorkspaceFiles(options), first = await files.editTarget('first'), second = await files.editTarget('second'); await first.write('before first'); await second.write('before second');
  class FailedWrite extends WritableFile { override async write(): Promise<void> { throw new Error('synthetic write failure'); } }
  await assert.rejects(commitFileEdits(new Map([[first, 'new first'], [new FailedWrite(second.path), 'new second']])), /synthetic write failure/); assert.equal(await readFile(first.path, 'utf8'), 'before first'); assert.equal(await readFile(second.path, 'utf8'), 'before second');
  const duplicate = await files.editTarget('first'); await commitFileEdits(new Map([[first, 'earlier'], [duplicate, 'last value']])); assert.equal(await readFile(first.path, 'utf8'), 'last value');
  const controller = new AbortController(), committed = commitFileEdits(new Map([[first, 'accepted first'], [second, 'accepted second']]), { signal: controller.signal }); controller.abort(new DOMException('cancel accepted patch', 'AbortError')); await assert.rejects(committed, /cancel accepted patch/); assert.equal(await readFile(first.path, 'utf8'), 'accepted first'); assert.equal(await readFile(second.path, 'utf8'), 'accepted second');
}));
