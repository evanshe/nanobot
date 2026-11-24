import { constants, type Stats } from 'node:fs';
import { open, lstat, stat, opendir } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, sep } from 'node:path';
import { WorkspaceBoundaryError, resolvePolicyPath } from '../security/paths.ts';
import { ReadableFile, FileAccessError, FileReadLimitError, NotRegularFileError, rejectFileDevice, fileErrorCode } from './file-handles.ts';
const within = (path: string, root: string) => { const suffix = relative(root, path); return !suffix || suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix); };
const same = (first: Stats, second: Stats) => first.dev === second.dev && first.ino === second.ino;
const ioError = (error: unknown) => error instanceof NotRegularFileError || /^E(?!RR_)[A-Z0-9_]+$/.test(fileErrorCode(error) ?? '');
export type SearchEntry = Readonly<{ name: string; isDirectory: boolean; isDirectoryLink: boolean }>;
export type SearchBytes = Readonly<{ data: Buffer | null; modified: number }>;
export type SearchBytesReader = (path: string, limit: number) => Promise<SearchBytes | null>;
class DirectorySession {
  readonly path: string; readonly descriptorPath: string; readonly #handle: FileHandle;
  private constructor(path: string, handle: FileHandle) { this.path = path; this.#handle = handle; this.descriptorPath = `/proc/self/fd/${handle.fd}`; }
  static async open(root: string, directory: string): Promise<DirectorySession> {
    if (process.platform !== 'linux') throw new Error('Descriptor-backed search requires the verified Linux /proc interface');
    try { if (!(await stat('/proc/self/fd')).isDirectory()) throw new Error('unavailable'); } catch { throw new Error('Descriptor-backed search requires an accessible /proc/self/fd interface'); }
    if (!within(directory, root) || relative(root, directory).split(sep).includes('..')) throw new TypeError('Expected a directory within the search root');
    const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW, before = await lstat(root);
    if (!before.isDirectory() || before.isSymbolicLink() || await resolvePolicyPath(root, { strict: true }) !== root) throw new FileAccessError('Search root changed');
    let handle = await open(root, flags);
    try {
      if (!same(before, await handle.stat())) throw new FileAccessError('Search root changed');
      for (const part of relative(root, directory).split(sep).filter(Boolean)) { const child = await open(`/proc/self/fd/${handle.fd}/${part}`, flags), previous = handle; handle = child; await previous.close(); }
      const result = new DirectorySession(directory, handle); await result.verify(); return result;
    } catch (error) { await handle.close(); throw error; }
  }
  async verify(): Promise<void> {
    try { if (await resolvePolicyPath(this.path, { strict: true }) === this.path && same(await this.#handle.stat(), await lstat(this.path))) return; } catch (error) { if (!ioError(error)) throw error; }
    throw new FileAccessError('Search directory changed during the scan; retry the search.');
  }
  close(): Promise<void> { return this.#handle.close(); }
}
export class FileSearch {
  readonly root: string; readonly isDirectory: boolean; readonly #authorize: (path: string) => Promise<string>; readonly #excluded: readonly string[];
  constructor(root: string, isDirectory: boolean, authorizeRead: (path: string) => Promise<string>, excluded: readonly string[] = []) { this.root = root; this.isDirectory = isDirectory; this.#authorize = authorizeRead; this.#excluded = [...excluded]; Object.freeze(this); }
  #visible(path: string): string { if (this.#excluded.some(root => within(path, root))) throw new WorkspaceBoundaryError('This path is not available in this session.'); return path; }
  async #candidate(path: string): Promise<string> { const target = await resolvePolicyPath(path, { strict: true }); return target === this.root || this.isDirectory && within(target, this.root) ? this.#visible(target) : this.#authorize(path); }
  async readFile(path: string): Promise<ReadableFile> { const target = await this.#candidate(path); await rejectFileDevice(target, true); const info = await stat(target); if (!info.isFile()) throw new NotRegularFileError(); return new ReadableFile(target, info, extname(path).toLowerCase()); }
  async *entries(directory: string, options: { signal?: AbortSignal } = {}): AsyncGenerator<SearchEntry> {
    options.signal?.throwIfAborted(); if (!this.isDirectory || !within(directory, this.root) || this.#excluded.some(root => within(directory, root)) || await resolvePolicyPath(directory) !== directory) return;
    const session = await DirectorySession.open(this.root, directory);
    try {
      const entries = await opendir(session.descriptorPath);
      for await (const entry of entries) {
        options.signal?.throwIfAborted(); if (this.#excluded.some(root => within(`${directory}${sep}${entry.name}`, root))) continue;
        let directoryLink = false;
        if (entry.isSymbolicLink()) try { directoryLink = (await stat(`${session.descriptorPath}/${entry.name}`)).isDirectory(); } catch (error) { if (!ioError(error)) throw error; continue; }
        yield { name: entry.name, isDirectory: entry.isDirectory() || directoryLink, isDirectoryLink: directoryLink };
      }
      options.signal?.throwIfAborted();
    } finally { try { await session.verify(); } finally { await session.close(); } }
  }
  async modified(path: string): Promise<number> { try { return (await stat(await this.#candidate(path))).mtimeMs / 1000; } catch (error) { if (!ioError(error)) throw error; return 0; } }
  async #bytes(path: string, limit: number, session: DirectorySession | null, signal?: AbortSignal): Promise<SearchBytes | null> {
    signal?.throwIfAborted();
    try {
      this.#visible(path); let file: ReadableFile;
      if (session) {
        const relativePath = `${session.descriptorPath}/${basename(path)}`, info = await lstat(relativePath);
        if (info.isSymbolicLink()) file = await this.readFile(path);
        else { if (!info.isFile()) return null; file = new ReadableFile(relativePath, info, extname(path).toLowerCase()); }
      } else file = await this.readFile(path);
      if (file.size > limit) return { data: null, modified: file.modified };
      try { return { data: await file.readBytes({ maxBytes: limit, signal }), modified: file.modified }; }
      catch (error) { if (error instanceof FileReadLimitError) return { data: null, modified: file.modified }; throw error; }
    } catch (error) { if (!ioError(error) || !this.isDirectory) throw error; return null; }
  }
  async readBytes(path: string, limit: number, options: { signal?: AbortSignal } = {}): Promise<SearchBytes | null> { return this.withBytesReader(read => read(path, limit), options); }
  async withBytesReader<T>(operation: (read: SearchBytesReader) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    let session: DirectorySession | null = null, tail: Promise<unknown> = Promise.resolve(), closed = false;
    const release = async () => { if (session) { const current = session; session = null; try { await current.verify(); } finally { await current.close(); } } };
    const read: SearchBytesReader = (path, limit) => {
      if (closed) return Promise.reject(new Error('Search reader is closed')); if (!Number.isSafeInteger(limit) || limit < 0) return Promise.reject(new RangeError('Search read limit must be a non-negative integer'));
      const task = tail.catch(() => {}).then(async () => {
        options.signal?.throwIfAborted();
        if (this.isDirectory && within(dirname(path), this.root)) {
          if (!session || session.path !== dirname(path)) { await release(); try { session = await DirectorySession.open(this.root, dirname(path)); } catch (error) { if (!ioError(error)) throw error; } }
        } else await release();
        return this.#bytes(path, limit, session, options.signal);
      }); tail = task; void task.catch(() => {}); return task;
    };
    try { return await operation(read); } finally { closed = true; await Promise.allSettled([tail]); await release(); }
  }
  async modifiedChildren(directory: string, names: readonly string[], options: { signal?: AbortSignal } = {}): Promise<number[]> {
    if (!this.isDirectory || !within(directory, this.root) || directory.split(sep).includes('..') || names.some(name => !name || name === '.' || name === '..' || basename(name) !== name)) throw new TypeError('Expected direct child names within the search root');
    const result: number[] = [];
    if (names.length < 4) { for (const name of names) { options.signal?.throwIfAborted(); result.push(await this.modified(`${directory}${sep}${name}`)); } return result; }
    let session: DirectorySession;
    try { session = await DirectorySession.open(this.root, directory); } catch (error) { if (!ioError(error)) throw error; for (const name of names) { options.signal?.throwIfAborted(); result.push(await this.modified(`${directory}${sep}${name}`)); } return result; }
    try {
      for (const name of names) { options.signal?.throwIfAborted(); try { const info = await lstat(`${session.descriptorPath}/${name}`); result.push(info.isSymbolicLink() ? await this.modified(`${directory}${sep}${name}`) : info.mtimeMs / 1000); } catch (error) { if (!ioError(error)) throw error; result.push(0); } }
      await session.verify(); options.signal?.throwIfAborted(); return result;
    } finally { await session.close(); }
  }
}
