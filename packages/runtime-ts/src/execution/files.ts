import { AsyncLocalStorage } from 'node:async_hooks';
import { stat, readdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { WorkspaceBoundaryError, resolveAllowedPath, resolvePolicyPath } from '../security/paths.ts';
import { FileSearch } from './search-files.ts';
import { currentToolWorkspace } from '../security/workspace.ts';
import { ReadableFile, WritableFile, NotRegularFileError, fileExists as exists, isMissingFile as missing, rejectFileDevice as rejectDevice, fileErrorCode } from './file-handles.ts';
export { ReadableFile, WritableFile, NotRegularFileError, FileAccessError, FileReadLimitError, commitFileEdits } from './file-handles.ts';
export type { FileSnapshot } from './file-handles.ts';
export { FileSearch } from './search-files.ts';
export type { SearchBytes, SearchEntry, SearchBytesReader } from './search-files.ts';
const exclusions = new AsyncLocalStorage<{ all: readonly string[]; writes: readonly string[] }>();
const within = (path: string, root: string) => { const suffix = relative(root, path); return !suffix || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
export async function withFileExclusions<T>(paths: readonly string[], operation: () => T | Promise<T>, options: { writesOnly?: boolean } = {}): Promise<T> {
  const current = exclusions.getStore() ?? { all: [], writes: [] }, resolved = await Promise.all(paths.map(path => resolvePolicyPath(path)));
  return exclusions.run(options.writesOnly ? { all: current.all, writes: [...current.writes, ...resolved] } : { all: [...current.all, ...resolved], writes: current.writes }, operation);
}
const excluded = (path: string, roots: readonly string[]) => roots.some(root => within(path, root));
function visible(path: string, roots = exclusions.getStore()?.all ?? []): string { if (excluded(path, roots)) throw new WorkspaceBoundaryError('This path is not available in this session.'); return path; }
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
  async #readPath(path: string, includeFileGrants = true, authorization?: { workspace: string | null; root: string | null; excluded: readonly string[] }): Promise<string> {
    const options = this.#options, { workspace, root } = authorization ?? await this.#roots(); const extra: string[] = [];
    if (root !== null) {
      extra.push(options.mediaDirectory, ...options.extraReadAllowedDirectories ?? []);
      if (options.workspace && options.pluginSkillRoots) try { extra.push(...await options.pluginSkillRoots(options.workspace, await resolvePolicyPath(path, { workspace }))); } catch (error) { if (!(error instanceof Error)) throw error; }
    }
    return visible(await resolveAllowedPath(path, { workspace, allowedRoot: root, extraAllowedRoots: extra, extraAllowedFiles: root !== null && includeFileGrants ? options.extraReadAllowedFiles : [] }), authorization?.excluded);
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
  async searchTree(path: string): Promise<FileSearch> {
    const authorization = { ...await this.#roots(), excluded: [...exclusions.getStore()?.all ?? []] }, authorize = (path: string) => this.#readPath(path, true, authorization);
    let target = await authorize(path); const info = await stat(target);
    if (info.isDirectory()) target = await this.#readPath(target, false, authorization); else if (!info.isFile()) throw new NotRegularFileError();
    return new FileSearch(target, info.isDirectory(), authorize, authorization.excluded);
  }
  async listDirectory(path: string, options: { recursive: boolean; ignored: ReadonlySet<string>; limit: number; signal?: AbortSignal }): Promise<{ entries: { path: string; isDirectory: boolean }[]; total: number }> {
    if (!Number.isSafeInteger(options.limit)) throw new RangeError('Directory limit must be an integer');
    const tree = await this.searchTree(path); if (!tree.isDirectory) { const error = new Error(`Not a directory: ${path}`) as NodeJS.ErrnoException; error.code = 'ENOTDIR'; throw error; }
    const ignored = new Set(options.ignored), recursive = options.recursive, pending = [tree.root], retained: { path: string; isDirectory: boolean }[] = [], limit = Math.max(0, options.limit); let total = 0;
    const compare = (left: string, right: string): number => {
      const first = left.split(sep), second = right.split(sep);
      for (let index = 0; index < Math.min(first.length, second.length); index++) { const a = [...first[index]], b = [...second[index]]; for (let letter = 0; letter < Math.min(a.length, b.length); letter++) { const difference = a[letter].codePointAt(0)! - b[letter].codePointAt(0)!; if (difference) return difference; } if (a.length !== b.length) return a.length - b.length; }
      return first.length - second.length;
    };
    const retain = (entry: { path: string; isDirectory: boolean }) => {
      if (!limit) return;
      if (retained.length < limit) { retained.push(entry); let index = retained.length - 1; while (index > 0) { const parent = Math.floor((index - 1) / 2); if (compare(retained[parent].path, retained[index].path) >= 0) break; [retained[parent], retained[index]] = [retained[index], retained[parent]]; index = parent; } return; }
      if (compare(entry.path, retained[0].path) >= 0) return; retained[0] = entry; let index = 0;
      while (true) { const left = index * 2 + 1, right = left + 1; if (left >= retained.length) break; const largest = right < retained.length && compare(retained[right].path, retained[left].path) > 0 ? right : left; if (compare(retained[index].path, retained[largest].path) >= 0) break; [retained[index], retained[largest]] = [retained[largest], retained[index]]; index = largest; }
    };
    while (pending.length) {
      const directory = pending.pop()!, before = retained.slice(), previousTotal = total, previousPending = pending.length; options.signal?.throwIfAborted();
      try { for await (const entry of tree.entries(directory, options)) { if (ignored.has(entry.name)) continue; const child = join(directory, entry.name); if (recursive && entry.isDirectory && !entry.isDirectoryLink) pending.push(child); total++; retain({ path: relative(tree.root, child), isDirectory: entry.isDirectory }); } }
      catch (error) { options.signal?.throwIfAborted(); if (!recursive || !['EACCES', 'EPERM'].includes(fileErrorCode(error) ?? '')) throw error; retained.splice(0, retained.length, ...before); total = previousTotal; pending.length = previousPending; }
    }
    return { entries: retained.sort((a, b) => compare(a.path, b.path)), total };
  }
  async siblingFiles(target: WritableFile): Promise<string[]> {
    let parent: string; try { parent = await this.#readPath(dirname(target.path), false); } catch (error) { if (error instanceof WorkspaceBoundaryError || ['EACCES', 'EPERM'].includes(fileErrorCode(error) ?? '')) return []; throw error; }
    const names: string[] = []; try { if (!(await stat(parent)).isDirectory()) return names; } catch (error) { if (missing(error)) return names; throw error; }
    for (const name of await readdir(parent)) if ((await stat(join(parent, name))).isFile()) names.push(name); return names;
  }
}
