import { AsyncLocalStorage } from 'node:async_hooks';
import { constants, type Stats } from 'node:fs';
import { open, stat, mkdir, unlink, readdir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { WorkspaceBoundaryError, resolveAllowedPath, resolvePolicyPath } from '../security/paths.ts';
import { currentToolWorkspace } from '../security/workspace.ts';
const exclusions = new AsyncLocalStorage<{ all: readonly string[]; writes: readonly string[] }>();
const within = (path: string, root: string) => { const suffix = relative(root, path); return !suffix || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
export async function withFileExclusions<T>(paths: readonly string[], operation: () => T | Promise<T>, options: { writesOnly?: boolean } = {}): Promise<T> {
  const current = exclusions.getStore() ?? { all: [], writes: [] }, resolved = await Promise.all(paths.map(path => resolvePolicyPath(path)));
  return exclusions.run(options.writesOnly ? { all: current.all, writes: [...current.writes, ...resolved] } : { all: [...current.all, ...resolved], writes: current.writes }, operation);
}
const excluded = (path: string, roots: readonly string[]) => roots.some(root => within(path, root));
function visible(path: string): string { if (excluded(path, exclusions.getStore()?.all ?? [])) throw new WorkspaceBoundaryError('This path is not available in this session.'); return path; }
export class FileAccessError extends Error { readonly code = 'EACCES'; constructor(message: string) { super(message); this.name = 'PermissionError'; } }
export class NotRegularFileError extends Error { constructor(message = '') { super(message); this.name = 'NotRegularFileError'; } }
export class FileReadLimitError extends Error { constructor(limit: number) { super(`File exceeds the ${limit}-byte read limit`); this.name = 'FileReadLimitError'; } }
const missing = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
const blocked = new Set(['/dev/zero', '/dev/random', '/dev/urandom', '/dev/full', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/console', '/dev/fd/0', '/dev/fd/1', '/dev/fd/2']);
async function rejectDevice(path: string, resolved = false): Promise<void> {
  let canonical = path; if (!resolved) try { canonical = await resolvePolicyPath(path); } catch (error) { if (!(error instanceof Error)) throw error; }
  if (blocked.has(path) || blocked.has(canonical) || /^\/proc\/(?:[0-9]+|self)\/fd\/[012]$/.test(path) || /^\/proc\/(?:[0-9]+|self)\/fd\/[012]$/.test(canonical) || canonical.startsWith('/dev/')) throw new FileAccessError(`Reading ${path} is blocked (device path that could hang or produce infinite output).`);
}
async function regular<T>(path: string, write: boolean, operation: (handle: FileHandle, info: Stats) => Promise<T>): Promise<T> {
  const flags = (write ? constants.O_WRONLY | constants.O_CREAT : constants.O_RDONLY) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o666);
  try { const info = await handle.stat(); if (!info.isFile()) throw new NotRegularFileError(); return await operation(handle, info); }
  finally { await handle.close(); }
}
async function readBytes(path: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<Buffer> {
  const limit = options.maxBytes ?? Number.MAX_SAFE_INTEGER; if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError('Read limit must be a non-negative integer'); options.signal?.throwIfAborted();
  return regular(path, false, async (handle, info) => {
    if (info.size > limit) throw new FileReadLimitError(limit);
    const parts: Buffer[] = []; let size = 0;
    while (true) {
      options.signal?.throwIfAborted(); const buffer = Buffer.allocUnsafe(Math.min(65536, limit - size + 1)), { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      options.signal?.throwIfAborted(); if (!bytesRead) break; size += bytesRead; if (size > limit) throw new FileReadLimitError(limit); parts.push(buffer.subarray(0, bytesRead));
    }
    return Buffer.concat(parts, size);
  });
}
async function writeBytes(path: string, bytes: Uint8Array): Promise<void> { await regular(path, true, async handle => { await handle.truncate(0); await handle.writeFile(bytes); }); }
export type FileSnapshot = Readonly<{ exists: boolean; text: string | null }>;
export class ReadableFile {
  readonly path: string; readonly size: number; readonly modified: number; readonly suffix: string;
  constructor(path: string, info: Stats, suffix = extname(path).toLowerCase()) { this.path = path; this.size = info.size; this.modified = info.mtimeMs / 1000; this.suffix = suffix; Object.freeze(this); }
  withOpen<T>(operation: (handle: FileHandle, size: number) => Promise<T>): Promise<T> { return regular(this.path, false, (handle, info) => operation(handle, info.size)); }
  readBytes(options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<Buffer> { return readBytes(this.path, options); }
}
export class WritableFile {
  readonly path: string;
  constructor(path: string) { this.path = path; Object.freeze(this); }
  exists(): Promise<boolean> { return exists(this.path); }
  async size(): Promise<number> { return (await stat(this.path)).size; }
  readBytes(options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<Buffer> { return readBytes(this.path, options); }
  async write(content: string, options: { createParents?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    options.signal?.throwIfAborted(); if (options.createParents) await mkdir(dirname(this.path), { recursive: true });
    // Once admitted, finish the native write and descriptor close before
    // surfacing cancellation; never truncate before checking the opened type.
    await writeBytes(this.path, Buffer.from(content, 'utf8')); options.signal?.throwIfAborted();
  }
  async snapshot(maxBytes: number): Promise<FileSnapshot> {
    try {
      if (!(await stat(this.path)).isFile()) return { exists: false, text: '' };
      const bytes = await this.readBytes({ maxBytes }); if (bytes.includes(0)) return { exists: true, text: null };
      try { return { exists: true, text: new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes).replaceAll('\r\n', '\n') }; } catch { return { exists: true, text: null }; }
    } catch (error) {
      if (missing(error)) return { exists: false, text: '' };
      if (error instanceof FileReadLimitError || error instanceof NotRegularFileError || (error as NodeJS.ErrnoException).code) return { exists: await exists(this.path), text: null };
      throw error;
    }
  }
}
export async function commitFileEdits(writes: ReadonlyMap<WritableFile, string>, options: { signal?: AbortSignal } = {}): Promise<void> {
  options.signal?.throwIfAborted(); const backups = new Map<WritableFile, Buffer | null>(), attempted: WritableFile[] = [], unique = new Map<string, [WritableFile, string]>();
  for (const [target, content] of writes) unique.set(target.path, [unique.get(target.path)?.[0] ?? target, content]);
  for (const [target] of unique.values()) backups.set(target, await target.exists() ? await target.readBytes() : null);
  try { for (const [target, content] of unique.values()) { attempted.push(target); await target.write(content, { createParents: true }); } }
  catch (error) {
    for (const target of attempted) try { const bytes = backups.get(target)!; if (bytes === null) { try { await unlink(target.path); } catch (failure) { if (!missing(failure)) throw failure; } } else await writeBytes(target.path, bytes); } catch (failure) { if (!(failure as NodeJS.ErrnoException).code && !(failure instanceof NotRegularFileError)) throw error; }
    throw error;
  }
  options.signal?.throwIfAborted();
}
export type WorkspaceFilesOptions = {
  workspace?: string | null; allowedDirectory?: string | null; restrictToWorkspace?: boolean; sandboxRestrictsWorkspace?: boolean;
  extraAllowedDirectories?: readonly string[]; extraReadAllowedDirectories?: readonly string[]; extraReadAllowedFiles?: readonly string[];
  extraWriteAllowedDirectories?: readonly string[]; extraWriteAllowedFiles?: readonly string[];
  mediaDirectory: string; builtinSkillsDirectory: string; pluginSkillRoots?: (workspace: string, target: string) => readonly string[] | Promise<readonly string[]>;
};
export class WorkspaceFiles {
  readonly #options: WorkspaceFilesOptions;
  constructor(options: WorkspaceFilesOptions) { this.#options = { ...options, extraReadAllowedDirectories: [...options.extraAllowedDirectories ?? [], ...options.extraReadAllowedDirectories ?? []], extraReadAllowedFiles: [...options.extraReadAllowedFiles ?? []], extraWriteAllowedDirectories: [...options.extraWriteAllowedDirectories ?? []], extraWriteAllowedFiles: [...options.extraWriteAllowedFiles ?? []] }; }
  async displayWorkspace(): Promise<string | null> { return (await currentToolWorkspace(this.#options.workspace ?? null)).projectPath; }
  async #roots(): Promise<{ workspace: string | null; root: string | null }> {
    const options = this.#options, access = await currentToolWorkspace(options.workspace ?? null, { restrictToWorkspace: options.restrictToWorkspace ?? options.allowedDirectory != null, sandboxRestrictsWorkspace: options.sandboxRestrictsWorkspace });
    let root = access.allowedRoot;
    if (options.allowedDirectory != null && options.workspace != null) {
      try { if (await resolvePolicyPath(options.allowedDirectory) !== await resolvePolicyPath(options.workspace)) root = options.allowedDirectory; }
      catch { root = access.allowedRoot ?? options.allowedDirectory; }
    }
    return { workspace: access.projectPath, root };
  }
  async #readPath(path: string, includeFileGrants = true): Promise<string> {
    const options = this.#options, { workspace, root } = await this.#roots(); const extra: string[] = [];
    if (root !== null) {
      extra.push(options.mediaDirectory, ...options.extraReadAllowedDirectories ?? []);
      if (options.workspace && options.pluginSkillRoots) try { extra.push(...await options.pluginSkillRoots(options.workspace, await resolvePolicyPath(path, { workspace }))); } catch (error) { if (!(error instanceof Error)) throw error; }
    }
    return visible(await resolveAllowedPath(path, { workspace, allowedRoot: root, extraAllowedRoots: extra, extraAllowedFiles: root !== null && includeFileGrants ? options.extraReadAllowedFiles : [] }));
  }
  async editTarget(path: string): Promise<WritableFile> {
    const options = this.#options, { workspace, root } = await this.#roots(), target = await resolveAllowedPath(path, { workspace, allowedRoot: root, extraAllowedRoots: root === null ? [] : options.extraWriteAllowedDirectories, extraAllowedFiles: options.extraWriteAllowedFiles });
    visible(target); if (excluded(target, exclusions.getStore()?.writes ?? [])) throw new WorkspaceBoundaryError('This path is read-only to file tools in this session.');
    if (options.workspace != null) {
      const agent = await resolvePolicyPath(options.workspace);
      for (const name of ['memory/history.jsonl', 'memory/.cursor', 'memory/.dream_cursor']) { const managed = join(agent, name); if (target === managed || target === await resolvePolicyPath(managed)) throw new WorkspaceBoundaryError(`${name} is managed by the runtime and is read-only to file tools.`); }
    }
    try { if (!(await stat(target)).isFile()) throw new NotRegularFileError(`Not a regular file: ${path}`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    return new WritableFile(target);
  }
  async readFile(path: string): Promise<ReadableFile> {
    await rejectDevice(path); let target = await this.#readPath(path);
    if (!await exists(target)) {
      const parts = path.split(sep).filter(part => part && part !== '.');
      if (!isAbsolute(path) && parts.length >= 2 && parts[0] === 'skills') {
        const builtin = await resolvePolicyPath(this.#options.builtinSkillsDirectory), candidate = await resolvePolicyPath(join(builtin, ...parts.slice(1)));
        if (within(candidate, builtin)) try { if ((await stat(candidate)).isFile()) target = visible(candidate); } catch (error) { if (!missing(error)) throw error; }
      }
    }
    if (!await exists(target)) { await rejectDevice(target, true); const error = new Error(`No such file: ${path}`) as NodeJS.ErrnoException; error.code = 'ENOENT'; throw error; }
    await rejectDevice(target, true); const info = await stat(target); if (!info.isFile()) throw new NotRegularFileError(); return new ReadableFile(target, info);
  }
  async siblingFiles(target: WritableFile): Promise<string[]> {
    let parent: string; try { parent = await this.#readPath(dirname(target.path), false); } catch (error) { if (error instanceof WorkspaceBoundaryError) return []; throw error; }
    const names: string[] = []; try { if (!(await stat(parent)).isDirectory()) return names; } catch (error) { if (missing(error)) return names; throw error; }
    for (const name of await readdir(parent)) if ((await stat(join(parent, name))).isFile()) names.push(name); return names;
  }
}
