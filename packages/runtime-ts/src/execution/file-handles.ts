import { constants, type Stats } from 'node:fs';
import { open, stat, mkdir, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { resolvePolicyPath } from '../security/paths.ts';
export class FileAccessError extends Error { readonly code = 'EACCES'; constructor(message: string) { super(message); this.name = 'PermissionError'; } }
export class NotRegularFileError extends Error { constructor(message = '') { super(message); this.name = 'NotRegularFileError'; } }
export class FileReadLimitError extends Error { constructor(limit: number) { super(`File exceeds the ${limit}-byte read limit`); this.name = 'FileReadLimitError'; } }
export function fileErrorCode(error: unknown): string | undefined { return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined; }
export const isMissingFile = (error: unknown) => ['ENOENT', 'ENOTDIR'].includes(fileErrorCode(error) ?? '');
export async function fileExists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (error) { if (isMissingFile(error)) return false; throw error; } }
const blocked = new Set(['/dev/zero', '/dev/random', '/dev/urandom', '/dev/full', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty', '/dev/console', '/dev/fd/0', '/dev/fd/1', '/dev/fd/2']);
export async function rejectFileDevice(path: string, resolved = false): Promise<void> {
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
  exists(): Promise<boolean> { return fileExists(this.path); }
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
      if (isMissingFile(error)) return { exists: false, text: '' };
      if (error instanceof FileReadLimitError || error instanceof NotRegularFileError || fileErrorCode(error)) return { exists: await fileExists(this.path), text: null };
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
    for (const target of attempted) try { const bytes = backups.get(target)!; if (bytes === null) { try { await unlink(target.path); } catch (failure) { if (!isMissingFile(failure)) throw failure; } } else await writeBytes(target.path, bytes); } catch (failure) { if (!fileErrorCode(failure) && !(failure instanceof NotRegularFileError)) throw error; }
    throw error;
  }
  options.signal?.throwIfAborted();
}
