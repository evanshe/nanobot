import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute, basename } from 'node:path';
import { stat } from 'node:fs/promises';
import type { ConfigObject, Json } from '../config/decoder.ts';
import { expandPolicyUser, resolvePolicyPath } from './paths.ts';
export type WorkspaceAccessMode = 'restricted' | 'full';
export const WORKSPACE_SCOPE_METADATA_KEY = 'workspace_scope';
const trim = (value: string) => value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const jsonObject = (value: Json | undefined): value is ConfigObject => record(value);
const own = (value: Record<string, unknown>, key: string): unknown => Object.hasOwn(value, key) ? value[key] : undefined;
const truthy = (value: unknown) => Array.isArray(value) ? value.length > 0 : record(value) ? Object.keys(value).length > 0 : Boolean(value);
export class WorkspaceScopeError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.name = 'WorkspaceScopeError'; this.status = status; }
}
export type WorkspaceSandboxStatus = Readonly<{ restrictToWorkspace: boolean; workspaceRoot: string; level: 'off' | 'application' | 'system'; enforced: boolean; provider: string; providerLabel: string; summary: string }>;
export type WorkspaceScopeOptions = { sourceChannel?: string | null; environment?: Readonly<Record<string, string | undefined>>; home?: string };
function statusForRoot(restrict: boolean, root: string, environment: Readonly<Record<string, string | undefined>> = process.env): WorkspaceSandboxStatus {
  const marker = environment.NANOBOT_WORKSPACE_SANDBOX_ENFORCED ?? environment.NANOBOT_SANDBOX_ENFORCED;
  const normalized = marker === undefined ? '' : trim(marker).toLowerCase();
  const disabled = marker === undefined || new Set(['0', 'false', 'no', 'off', 'disabled', '']).has(normalized);
  const boolean = new Set(['1', 'true', 'yes', 'on', 'enabled']).has(normalized);
  const raw = boolean ? environment.NANOBOT_WORKSPACE_SANDBOX_PROVIDER : marker;
  const provider = disabled ? 'none' : raw ? trim(raw).toLowerCase().replaceAll('-', '_').replaceAll(' ', '_') || 'unknown' : 'unknown';
  const labels: Record<string, string> = { none: 'None', unknown: 'Unknown system sandbox', macos_app_sandbox: 'macOS App Sandbox', bwrap: 'Bubblewrap', seatbelt: 'macOS Seatbelt' };
  const label = Object.hasOwn(labels, provider) ? labels[provider] : provider.replaceAll('_', ' ').replace(/\b\w/g, value => value.toUpperCase());
  return Object.freeze(!restrict ? { restrictToWorkspace: false, workspaceRoot: root, level: 'off', enforced: false, provider: 'none', providerLabel: labels.none, summary: 'Workspace restriction is disabled.' } : disabled ? { restrictToWorkspace: true, workspaceRoot: root, level: 'application', enforced: false, provider: 'none', providerLabel: labels.none, summary: 'Workspace restriction uses nanobot application-level guards.' } : { restrictToWorkspace: true, workspaceRoot: root, level: 'system', enforced: true, provider, providerLabel: label, summary: `Workspace restriction is system-enforced by ${label}.` });
}
function statusPayload(value: WorkspaceSandboxStatus): ConfigObject {
  return { restrict_to_workspace: value.restrictToWorkspace, workspace_root: value.workspaceRoot, level: value.level, enforced: value.enforced, provider: value.provider, provider_label: value.providerLabel, summary: value.summary };
}
export async function workspaceSandboxStatus(restrictToWorkspace: boolean, workspace: string, options: WorkspaceScopeOptions = {}): Promise<WorkspaceSandboxStatus> {
  return statusForRoot(restrictToWorkspace, await resolvePolicyPath(workspace, options), options.environment);
}
function accessMode(value: string): WorkspaceAccessMode {
  let mode = trim(value).toLowerCase().replaceAll('_', '-'); if (mode === 'restrict') mode = 'restricted'; if (mode === 'full-access') mode = 'full';
  if (mode !== 'restricted' && mode !== 'full') throw new WorkspaceScopeError('access_mode must be restricted or full'); return mode;
}
export class WorkspaceScope {
  readonly projectPath: string; readonly accessMode: WorkspaceAccessMode; readonly restrictToWorkspace: boolean; readonly sandboxStatus: WorkspaceSandboxStatus; readonly sourceChannel: string | null;
  private constructor(projectPath: string, mode: WorkspaceAccessMode, options: WorkspaceScopeOptions) {
    this.projectPath = projectPath; this.accessMode = mode; this.restrictToWorkspace = mode === 'restricted'; this.sandboxStatus = statusForRoot(this.restrictToWorkspace, projectPath, options.environment); this.sourceChannel = options.sourceChannel ?? null; Object.freeze(this);
  }
  static async create(projectPath: string, mode: string, options: WorkspaceScopeOptions = {}): Promise<WorkspaceScope> { const normalized = accessMode(mode); return new WorkspaceScope(await resolvePolicyPath(projectPath, options), normalized, options); }
  get projectName(): string { return basename(this.projectPath) || this.projectPath; }
  metadata(): ConfigObject { return { project_path: this.projectPath, access_mode: this.accessMode }; }
  payload(): ConfigObject { return { ...this.metadata(), project_name: this.projectName, restrict_to_workspace: this.restrictToWorkspace, sandbox_status: statusPayload(this.sandboxStatus) }; }
}
export const buildWorkspaceScope = (projectPath: string, mode: string, options: WorkspaceScopeOptions = {}) => WorkspaceScope.create(projectPath, mode, options);
export const defaultWorkspaceScope = (workspace: string, restricted: boolean, options: WorkspaceScopeOptions = {}) => buildWorkspaceScope(workspace, restricted ? 'restricted' : 'full', options);
export type WorkspaceDefaults = WorkspaceScopeOptions & { defaultWorkspace: string; defaultRestrictToWorkspace: boolean };
export async function validateWorkspaceScopePayload(raw: unknown, defaults: WorkspaceDefaults): Promise<WorkspaceScope> {
  if (raw === undefined || raw === null) return defaultWorkspaceScope(defaults.defaultWorkspace, defaults.defaultRestrictToWorkspace, defaults);
  if (!record(raw)) throw new WorkspaceScopeError('workspace_scope must be an object');
  const primary = own(raw, 'project_path'); let path = truthy(primary) ? primary : own(raw, 'path');
  if (path === undefined || path === null || path === '') path = await resolvePolicyPath(defaults.defaultWorkspace, defaults);
  if (typeof path !== 'string') throw new WorkspaceScopeError('project_path must be a string');
  if (path.includes('\0')) throw new WorkspaceScopeError('project_path contains invalid characters');
  const expanded = await expandPolicyUser(path, defaults.home); if (!isAbsolute(expanded)) throw new WorkspaceScopeError('project_path must be absolute');
  const project = await resolvePolicyPath(expanded, defaults);
  let directory = false; try { directory = (await stat(project)).isDirectory(); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
  if (!directory) throw new WorkspaceScopeError('project_path must be an existing directory');
  const rawMode = own(raw, 'access_mode'), mode = rawMode === undefined || rawMode === null ? defaults.defaultRestrictToWorkspace ? 'restricted' : 'full' : rawMode;
  if (typeof mode !== 'string') throw new WorkspaceScopeError('access_mode must be a string');
  return buildWorkspaceScope(project, mode, defaults);
}
export async function workspaceScopeFromMetadata(metadata: unknown, defaults: WorkspaceDefaults): Promise<WorkspaceScope> {
  if (!record(metadata)) return defaultWorkspaceScope(defaults.defaultWorkspace, defaults.defaultRestrictToWorkspace, defaults);
  try { return await validateWorkspaceScopePayload(own(metadata, WORKSPACE_SCOPE_METADATA_KEY), defaults); }
  catch (error) { if (!(error instanceof WorkspaceScopeError)) throw error; return defaultWorkspaceScope(defaults.defaultWorkspace, defaults.defaultRestrictToWorkspace, defaults); }
}
export function resolveEffectiveWorkspaceScope(messageMetadata: unknown, sessionMetadata: unknown, defaults: WorkspaceDefaults): Promise<WorkspaceScope> {
  return workspaceScopeFromMetadata(record(messageMetadata) && Object.hasOwn(messageMetadata, WORKSPACE_SCOPE_METADATA_KEY) ? messageMetadata : sessionMetadata, defaults);
}
export class WorkspaceScopeResolver {
  readonly #defaults: WorkspaceDefaults; readonly #channel: string;
  constructor(defaults: WorkspaceDefaults & { scopedChannel?: string }) { this.#defaults = { ...defaults, ...(defaults.environment ? { environment: Object.freeze({ ...defaults.environment }) } : {}) }; this.#channel = defaults.scopedChannel ?? 'websocket'; }
  default(): Promise<WorkspaceScope> { return defaultWorkspaceScope(this.#defaults.defaultWorkspace, this.#defaults.defaultRestrictToWorkspace, { ...this.#defaults, sourceChannel: null }); }
  forTurn(channel: string | null, messageMetadata: unknown, sessionMetadata: unknown): Promise<WorkspaceScope> { return channel !== this.#channel ? this.default() : resolveEffectiveWorkspaceScope(messageMetadata, sessionMetadata, { ...this.#defaults, sourceChannel: channel }); }
  persistMessageScope(session: { metadata: ConfigObject }, message: { channel: string; metadata: ConfigObject }): void { const raw = message.metadata[WORKSPACE_SCOPE_METADATA_KEY]; if (message.channel === this.#channel && jsonObject(raw)) session.metadata[WORKSPACE_SCOPE_METADATA_KEY] = { ...raw }; }
}
const scopes = new AsyncLocalStorage<WorkspaceScope>();
export const currentWorkspaceScope = (): WorkspaceScope | null => scopes.getStore() ?? null;
export function withWorkspaceScope<T>(scope: WorkspaceScope, operation: () => T): T { return scopes.run(scope, operation); }
export type ToolWorkspace = Readonly<{ projectPath: string | null; restrictToWorkspace: boolean; scope: WorkspaceScope | null; allowedRoot: string | null }>;
export async function currentToolWorkspace(defaultWorkspace: string | null, options: { restrictToWorkspace?: boolean; sandboxRestrictsWorkspace?: boolean; scope?: WorkspaceScope | null; home?: string } = {}): Promise<ToolWorkspace> {
  const scope = options.scope ?? currentWorkspaceScope(), projectPath = scope?.projectPath ?? (defaultWorkspace === null ? null : await expandPolicyUser(defaultWorkspace, options.home)), restrict = (scope?.restrictToWorkspace ?? Boolean(options.restrictToWorkspace)) || Boolean(options.sandboxRestrictsWorkspace);
  return Object.freeze({ projectPath, restrictToWorkspace: restrict, scope, allowedRoot: restrict && projectPath !== null ? projectPath : null });
}
export function currentScopeAllowsLoopback(enabled: boolean): boolean { const scope = currentWorkspaceScope(); return enabled && scope !== null && scope.sourceChannel === 'websocket' && scope.accessMode === 'full' && !scope.restrictToWorkspace; }
