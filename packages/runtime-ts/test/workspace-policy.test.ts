import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolvePolicyPath, resolveAllowedPath, requirePathWithin, isPathWithin, isPathAllowed, WorkspaceBoundaryError } from '@nanobot/runtime';
import type { AllowedPathOptions } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
type Case = { operation: 'resolve' | 'allowed' | 'within' | 'roots' | 'require'; path: string; root?: string; roots?: string[]; options?: AllowedPathOptions & { message?: string } };
async function actual(item: Case): Promise<unknown> {
  try {
    const options = item.options ?? {};
    return { value: item.operation === 'resolve' ? await resolvePolicyPath(item.path, options) : item.operation === 'allowed' ? await resolveAllowedPath(item.path, options) : item.operation === 'within' ? await isPathWithin(item.path, item.root!, options) : item.operation === 'roots' ? await isPathAllowed(item.path, item.roots!, options) : await requirePathWithin(item.path, item.root!, options) };
  } catch (error) {
    if (error instanceof WorkspaceBoundaryError) return { error: 'boundary', message: error.message };
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { error: 'missing' }; if (code === 'ENOTDIR') return { error: 'not-directory' }; if (code === 'ELOOP') return { error: 'loop' }; if (code === 'ERR_INVALID_ARG_VALUE') return { error: 'invalid' };
    throw error;
  }
}
test('workspace path policy matches Python on real temporary files, links, exact grants and strict missing targets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-policy-')), workspace = join(directory, 'workspace'), outside = join(directory, 'outside'), home = join(directory, 'home');
  try {
    await Promise.all([mkdir(join(workspace, 'src'), { recursive: true }), mkdir(join(workspace, 'skills'), { recursive: true }), mkdir(join(outside, 'child'), { recursive: true }), mkdir(home)]);
    const file = join(workspace, 'src', 'file.txt'), secret = join(outside, 'secret.txt'), missing = join(outside, 'missing.txt'); await writeFile(file, 'synthetic'); await writeFile(secret, 'synthetic outside');
    await symlink(secret, join(workspace, 'linked')); await symlink(join(outside, 'child'), join(workspace, 'portal')); await symlink(missing, join(workspace, 'dangling')); await symlink('loop', join(workspace, 'loop'));
    const restricted = { workspace, allowedRoot: workspace };
    const cases: Case[] = [
      { operation: 'allowed', path: 'src/file.txt', options: restricted },
      ...['../outside/secret.txt', 'src/../../outside/secret.txt', 'linked', 'portal/../secret.txt', 'dangling'].map(path => ({ operation: 'allowed' as const, path, options: restricted })),
      { operation: 'allowed', path: join(directory, 'workspace-other', 'secret'), options: restricted },
      { operation: 'allowed', path: secret, options: { ...restricted, extraAllowedRoots: [outside] } },
      ...[secret, missing].map(path => ({ operation: 'allowed' as const, path, options: { ...restricted, extraAllowedFiles: [path] } })),
      { operation: 'allowed', path: `${missing}/child`, options: { ...restricted, extraAllowedFiles: [missing] } },
      { operation: 'allowed', path: outside, options: { ...restricted, extraAllowedFiles: [outside] } },
      { operation: 'allowed', path: 'linked', options: { workspace, allowedRoot: join(workspace, 'skills'), extraAllowedFiles: [join(workspace, 'linked'), secret] } },
      { operation: 'allowed', path: secret, options: { extraAllowedFiles: [secret] } },
      { operation: 'allowed', path: '/' + secret, options: { extraAllowedFiles: ['/' + secret] } },
      { operation: 'allowed', path: file, options: { extraAllowedFiles: [secret] } },
      { operation: 'allowed', path: secret, options: { extraAllowedRoots: [workspace] } },
      { operation: 'allowed', path: 'src/missing/../file.txt', options: restricted },
      { operation: 'allowed', path: 'src/missing/../file.txt', options: { ...restricted, strict: true } },
      { operation: 'allowed', path: 'src/file.txt/child', options: { ...restricted, strict: true } },
      { operation: 'allowed', path: 'dangling', options: { ...restricted, extraAllowedRoots: [outside], strict: true } },
      { operation: 'resolve', path: 'portal/../secret.txt', options: { workspace } },
      { operation: 'resolve', path: join(workspace, 'loop') },
      { operation: 'within', path: join(workspace, 'linked'), root: workspace },
      { operation: 'within', path: join(workspace, 'loop'), root: workspace },
      { operation: 'roots', path: file, roots: [join(workspace, 'loop'), workspace] },
      { operation: 'require', path: secret, root: workspace },
      { operation: 'require', path: secret, root: workspace, options: { message: 'synthetic custom denial' } },
      { operation: 'allowed', path: '~/missing', options: { home, allowedRoot: home } },
      { operation: 'resolve', path: `${workspace}/bad\0path` },
    ];
    const child = spawn(process.env.NANOBOT_TEST_PYTHON ?? join(root, '.venv/bin/python'), [fileURLToPath(new URL('./workspace-policy-reference.py', import.meta.url))], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, PYTHONPATH: root } });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.stdin.end(JSON.stringify(cases)); const [status] = await once(child, 'close'); assert.equal(status, 0, stderr);
    const expected: unknown[] = JSON.parse(stdout); for (let index = 0; index < cases.length; index++) assert.deepEqual(await actual(cases[index]), expected[index], JSON.stringify(cases[index]));
    assert.equal(await isPathWithin(file, workspace), true); assert.equal(await isPathWithin(secret, workspace), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
