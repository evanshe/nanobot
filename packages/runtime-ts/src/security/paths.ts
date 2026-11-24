import { homedir, userInfo } from 'node:os';
import { lstat, readFile, readlink, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
// nanobot/security/workspace_policy.py owns the corresponding Python boundary.
export const WORKSPACE_BOUNDARY_NOTE = ' (this is a hard policy boundary, not a transient failure; do not retry with shell tricks or alternative tools, and ask the user how to proceed if the resource is genuinely required)';
export class WorkspaceBoundaryError extends Error {
  readonly code = 'EACCES';
  constructor(message: string) { super(message); this.name = 'WorkspaceBoundaryError'; }
}
export type PolicyPathOptions = { workspace?: string | null; strict?: boolean; home?: string };
export async function expandPolicyUser(path: string, home = homedir()): Promise<string> {
  if (!path.startsWith('~')) return path;
  const end = path.indexOf(sep), username = path.slice(1, end < 0 ? undefined : end), suffix = end < 0 ? '' : path.slice(end);
  if (!username) return home + suffix;
  const current = userInfo(); if (username === current.username) return current.homedir + suffix;
  // Local passwd accounts on the verified Unix host. Directory-service account
  // lookup and non-current Windows account expansion need platform validation.
  if (process.platform !== 'win32') {
    const account = (await readFile('/etc/passwd', 'utf8')).split('\n').map(row => row.split(':')).find(fields => fields.length >= 7 && fields[0] === username);
    if (account?.[5]) return account[5] + suffix;
  }
  throw new Error(`Could not determine home directory for ${username}`);
}
async function canonical(path: string, strict: boolean, links = new Set<string>()): Promise<string> {
  const root = parse(path).root; let current = root;
  for (const part of path.slice(root.length).split(sep)) {
    if (!part || part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    const child = join(current, part); let link = false;
    try { link = (await lstat(child)).isSymbolicLink(); }
    catch (error) { if (strict || !['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    if (!link) { current = child; continue; }
    if (links.has(child)) { const error = new Error(`Symlink loop from ${child}`) as NodeJS.ErrnoException; error.code = 'ELOOP'; throw error; }
    links.add(child);
    try { const target = await readlink(child); current = await canonical(isAbsolute(target) ? target : `${current}${sep}${target}`, strict, links); }
    finally { links.delete(child); }
  }
  return current;
}
async function candidate(path: string, options: PolicyPathOptions): Promise<string> {
  const expanded = await expandPolicyUser(path, options.home);
  const value = !isAbsolute(expanded) && options.workspace != null ? `${await expandPolicyUser(options.workspace, options.home)}${sep}${expanded}` : expanded;
  return isAbsolute(value) ? value : `${process.cwd()}${sep}${value}`;
}
export async function resolvePolicyPath(path: string, options: PolicyPathOptions = {}): Promise<string> {
  return canonical(await candidate(path, options), options.strict ?? false);
}
function logicalPath(path: string): string {
  const normalized = resolve(path);
  return process.platform !== 'win32' && path.startsWith('//') && !path.startsWith('///') ? '/' + normalized : normalized;
}
const pathKey = (path: string) => process.platform === 'win32' ? path.toLowerCase() : path;
function contains(path: string, root: string): boolean {
  const suffix = relative(root, path); return !suffix || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
}
export async function isPathWithin(path: string, root: string, options: Pick<PolicyPathOptions, 'home'> = {}): Promise<boolean> {
  try { return contains(await resolvePolicyPath(path, { home: options.home }), await resolvePolicyPath(root, { home: options.home })); } catch { return false; }
}
export async function isPathAllowed(path: string, roots: readonly string[], options: Pick<PolicyPathOptions, 'home'> = {}): Promise<boolean> {
  for (const root of roots) if (await isPathWithin(path, root, options)) return true;
  return false;
}
export async function requirePathWithin(path: string, root: string, options: { message?: string; home?: string } = {}): Promise<string> {
  const resolved = await resolvePolicyPath(path, { home: options.home });
  if (!await isPathWithin(resolved, root, options)) throw new WorkspaceBoundaryError(options.message ?? `Path ${path} is outside allowed directory ${await expandPolicyUser(root, options.home)}${WORKSPACE_BOUNDARY_NOTE}`);
  return resolved;
}
export type AllowedPathOptions = PolicyPathOptions & { allowedRoot?: string | null; extraAllowedRoots?: readonly string[]; extraAllowedFiles?: readonly string[] };
export async function resolveAllowedPath(path: string, options: AllowedPathOptions = {}): Promise<string> {
  const resolved = await resolvePolicyPath(path, { ...options, strict: false }), files = options.extraAllowedFiles ?? [];
  if (options.allowedRoot == null && !files.length) return options.strict ? resolvePolicyPath(path, options) : resolved;
  const roots = [...options.allowedRoot == null ? [] : [options.allowedRoot], ...options.extraAllowedRoots ?? []];
  const logical = logicalPath(await candidate(path, options)); let exact = false;
  if (pathKey(resolved) === pathKey(logical)) for (const file of files) {
    let allowed: string; try { allowed = logicalPath(await candidate(file, { home: options.home })); } catch { continue; }
    if (pathKey(allowed) !== pathKey(logical)) continue;
    let directory = false; try { directory = (await stat(resolved)).isDirectory(); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    exact = !directory; if (exact) break;
  }
  if (!await isPathAllowed(resolved, roots, options) && !exact) throw new WorkspaceBoundaryError(`Path ${path} is outside allowed directory ${options.allowedRoot == null ? 'allowed files' : await expandPolicyUser(options.allowedRoot, options.home)}${WORKSPACE_BOUNDARY_NOTE}`);
  return options.strict ? resolvePolicyPath(path, options) : resolved;
}
