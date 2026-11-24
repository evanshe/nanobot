import { createRequire } from 'node:module';
import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
type NativeFiles = { lock(fd: number, release: boolean): boolean; setTimes(fd: number, accessNs: bigint, modifiedNs: bigint): void };
const candidate: unknown = createRequire(import.meta.url)('../../native/build/Release/session_fs.node');
function binding(value: unknown): value is NativeFiles {
  return value !== null && typeof value === 'object' && 'lock' in value && typeof value.lock === 'function' && 'setTimes' in value && typeof value.setTimes === 'function';
}
if (!binding(candidate)) throw new Error('Invalid session filesystem native binding; rebuild the package');
export const sessionFiles: NativeFiles = candidate;
export async function fsyncDirectory(path: string): Promise<void> {
  try { const directory = await open(path, 'r'); try { await directory.sync(); } finally { await directory.close(); } }
  catch (error) { if (!['EINVAL', 'ENOTSUP', 'EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
}
export async function atomicPrivateWrite(path: string, content: string | Uint8Array, times?: { atimeNs: bigint; mtimeNs: bigint }): Promise<void> {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID().replaceAll('-', '')}.tmp`);
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(content); if (times) sessionFiles.setTimes(file.fd, times.atimeNs, times.mtimeNs); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path); await fsyncDirectory(dirname(path));
  } finally { try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
}
export async function withNamespaceLock<T>(path: string, operation: () => Promise<T>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
  options.signal?.throwIfAborted();
  const file = await open(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
  let held = false;
  try {
    const deadline = performance.now() + (options.timeoutMs ?? 30_000);
    while (!(held = sessionFiles.lock(file.fd, false))) {
      if (performance.now() >= deadline) throw new Error(`Timed out acquiring session namespace lock: ${path}`);
      await delay(10, undefined, { signal: options.signal });
    }
    options.signal?.throwIfAborted(); return await operation();
  } finally { try { if (held) sessionFiles.lock(file.fd, true); } finally { await file.close(); } }
}
