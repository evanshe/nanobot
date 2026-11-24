import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { WorkspaceScopeResolver, WorkspaceScopeError, buildWorkspaceScope, defaultWorkspaceScope, validateWorkspaceScopePayload, workspaceScopeFromMetadata, resolveEffectiveWorkspaceScope, workspaceSandboxStatus, withWorkspaceScope, currentWorkspaceScope, currentToolWorkspace, currentScopeAllowsLoopback } from '@nanobot/runtime';
import type { ConfigObject } from '@nanobot/runtime';
const root = fileURLToPath(new URL('../../../', import.meta.url));
type Case = { operation: string; workspace: string; restricted?: boolean; mode?: string; raw?: unknown; metadata?: unknown; message?: unknown; session?: unknown; channel?: string; environment?: Record<string, string | undefined> };
async function actual(item: Case, home: string): Promise<unknown> {
  const defaults = { defaultWorkspace: item.workspace, defaultRestrictToWorkspace: item.restricted ?? true, home, environment: item.environment ?? {} };
  try {
    if (item.operation === 'status') { const value = await workspaceSandboxStatus(defaults.defaultRestrictToWorkspace, item.workspace, defaults); return { restrict_to_workspace: value.restrictToWorkspace, workspace_root: value.workspaceRoot, level: value.level, enforced: value.enforced, provider: value.provider, provider_label: value.providerLabel, summary: value.summary }; }
    const scope = item.operation === 'default' ? await defaultWorkspaceScope(item.workspace, defaults.defaultRestrictToWorkspace, defaults) : item.operation === 'build' ? await buildWorkspaceScope(item.workspace, item.mode!, defaults) : item.operation === 'validate' ? await validateWorkspaceScopePayload(item.raw, defaults) : item.operation === 'metadata' ? await workspaceScopeFromMetadata(item.metadata, defaults) : item.operation === 'effective' ? await resolveEffectiveWorkspaceScope(item.message, item.session, defaults) : await new WorkspaceScopeResolver(defaults).forTurn(item.channel ?? null, item.message, item.session);
    return { payload: scope.payload(), metadata: scope.metadata(), source_channel: scope.sourceChannel };
  } catch (error) { if (error instanceof WorkspaceScopeError) return { error: error.message, status: error.status }; throw error; }
}
test('scope validation, safe metadata fallback, channel selection and sandbox labels match Python', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-scope-')), agent = join(directory, 'agent'), project = join(directory, 'project'), home = join(directory, 'home');
  try {
    await Promise.all([mkdir(agent), mkdir(project), mkdir(home)]); const file = join(project, 'file'); await writeFile(file, 'synthetic');
    const valid = { workspace_scope: { project_path: project, access_mode: 'full' } }, stale = { workspace_scope: { project_path: join(directory, 'missing'), access_mode: 'full' } };
    const cases: Case[] = [
      ...[true, false].map(restricted => ({ operation: 'default', workspace: agent, restricted })),
      ...['restrict', ' full_access ', 'invalid'].map(mode => ({ operation: 'build', workspace: project, mode })),
      ...[null, {}, [], 'invalid', { project_path: 'relative' }, { project_path: file }, { project_path: join(directory, 'missing') }, { project_path: 'bad\0path' }, { project_path: 1 }, { project_path: project, access_mode: 0 }, { project_path: project, access_mode: 'unknown' }, { project_path: '~/..', access_mode: 'restricted' }, { path: project, project_path: '', access_mode: 'full-access' }].map(raw => ({ operation: 'validate', workspace: agent, raw })),
      ...[null, stale, valid, { workspace_scope: 'bad' }].map(metadata => ({ operation: 'metadata', workspace: agent, metadata })),
      { operation: 'effective', workspace: agent, message: stale, session: valid },
      { operation: 'effective', workspace: agent, message: {}, session: valid },
      ...['websocket', 'cli', 'telegram'].map(channel => ({ operation: 'turn', workspace: agent, channel, message: valid, session: {} })),
      ...[{}, { NANOBOT_SANDBOX_ENFORCED: 'macos_app_sandbox' }, { NANOBOT_WORKSPACE_SANDBOX_ENFORCED: 'true', NANOBOT_WORKSPACE_SANDBOX_PROVIDER: 'bwrap' }, { NANOBOT_WORKSPACE_SANDBOX_ENFORCED: 'false', NANOBOT_SANDBOX_ENFORCED: 'bwrap' }, { NANOBOT_WORKSPACE_SANDBOX_ENFORCED: 'constructor' }, { NANOBOT_WORKSPACE_SANDBOX_ENFORCED: 'yes', NANOBOT_WORKSPACE_SANDBOX_PROVIDER: ' ' }].map(environment => ({ operation: 'status', workspace: agent, environment })),
      { operation: 'status', workspace: agent, restricted: false, environment: { NANOBOT_SANDBOX_ENFORCED: 'seatbelt' } },
    ];
    const child = spawn(process.env.NANOBOT_TEST_PYTHON ?? join(root, '.venv/bin/python'), [fileURLToPath(new URL('./workspace-scope-reference.py', import.meta.url))], { cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home, PYTHONPATH: root } });
    let stdout = '', stderr = ''; child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; }); child.stdin.end(JSON.stringify({ home, cases })); const [status] = await once(child, 'close'); assert.equal(status, 0, stderr);
    const expected: unknown[] = JSON.parse(stdout); for (let index = 0; index < cases.length; index++) assert.deepEqual(await actual(cases[index], home), expected[index], JSON.stringify(cases[index]));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('request scopes stay isolated across concurrent waits and restore after nested failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'nanobot-scope-owner-')); const first = await buildWorkspaceScope(join(directory, 'first'), 'restricted', { environment: {}, sourceChannel: 'websocket' }), second = await buildWorkspaceScope(join(directory, 'second'), 'full', { environment: {}, sourceChannel: 'websocket' });
  try {
    await Promise.all([first, second].map(scope => withWorkspaceScope(scope, async () => {
      await new Promise(resolve => setImmediate(resolve)); assert.equal(currentWorkspaceScope(), scope);
      const access = await currentToolWorkspace(directory, { restrictToWorkspace: true }); assert.equal(access.projectPath, scope.projectPath); assert.equal(access.allowedRoot, scope.restrictToWorkspace ? scope.projectPath : null); assert.equal(currentScopeAllowsLoopback(true), scope === second); assert.equal(currentScopeAllowsLoopback(false), false);
      assert.equal((await currentToolWorkspace(directory, { sandboxRestrictsWorkspace: true })).allowedRoot, scope.projectPath);
      await assert.rejects(withWorkspaceScope(scope === first ? second : first, async () => { await new Promise(resolve => setImmediate(resolve)); throw new Error('synthetic nested failure'); }), /nested failure/);
      assert.equal(currentWorkspaceScope(), scope);
    })));
    assert.equal(currentWorkspaceScope(), null); assert.equal((await currentToolWorkspace(directory, { restrictToWorkspace: true })).allowedRoot, directory);
    const session: { metadata: ConfigObject } = { metadata: {} }, raw: ConfigObject = { project_path: directory, access_mode: 'full' }, resolver = new WorkspaceScopeResolver({ defaultWorkspace: directory, defaultRestrictToWorkspace: true });
    resolver.persistMessageScope(session, { channel: 'websocket', metadata: { workspace_scope: raw } }); raw.project_path = 'changed after capture'; assert.equal((session.metadata.workspace_scope as ConfigObject).project_path, directory);
    resolver.persistMessageScope(session, { channel: 'cli', metadata: { workspace_scope: { project_path: 'ignored' } } }); assert.equal((session.metadata.workspace_scope as ConfigObject).project_path, directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
