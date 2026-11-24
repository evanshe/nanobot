import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, sep, dirname, relative, basename } from 'node:path';
import { lstat, mkdir, open, readFile, readdir, readlink, stat, unlink, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { atomicPrivateWrite, fsyncDirectory, withNamespaceLock } from './files.ts';
const identity = /^[0-9a-f]{32}$/;
const expand = (path: string) => path === '~' ? homedir() : path.startsWith('~/') ? `${homedir()}${sep}${path.slice(2)}` : path;
export async function canonicalStoragePath(value: string, links = new Set<string>()): Promise<string> {
  const path = expand(value), absolute = isAbsolute(path) ? path : `${process.cwd()}${sep}${path}`, root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep)) {
    if (!part || part === '.') continue; if (part === '..') { current = dirname(current); continue; }
    const candidate = join(current, part); let symbolic = false;
    try { symbolic = (await lstat(candidate)).isSymbolicLink(); } catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    if (symbolic) {
      if (links.has(candidate)) throw new Error(`Symlink loop at ${candidate}`); links.add(candidate);
      try { const target = await readlink(candidate); current = await canonicalStoragePath(isAbsolute(target) ? target : `${current}${sep}${target}`, links); }
      finally { links.delete(candidate); }
    } else current = candidate;
  }
  return current;
}
const trim = (value: string) => value.replace(/^[\s\u0085\u001c-\u001f]+|[\s\u0085\u001c-\u001f]+$/gu, '');
async function utf8(path: string): Promise<string> { return new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(await readFile(path)); }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) return false; throw error; } }
async function rejectSymlink(path: string, label: string): Promise<void> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
async function sameFile(a: string, b: string): Promise<boolean> {
  try { const [left, right] = await Promise.all([stat(a), stat(b)]); return left.dev === right.dev && left.ino === right.ino; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export class SessionLocation {
  readonly workspace: string;
  readonly sessionsRoot: string;
  readonly sessionsDirectory: string;
  private constructor(workspace: string, root: string, directory: string) { this.workspace = workspace; this.sessionsRoot = root; this.sessionsDirectory = directory; }
  static async open(workspace: string, sessionsRoot: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<SessionLocation> {
    const canonical = await canonicalStoragePath(workspace), root = await canonicalStoragePath(sessionsRoot);
    const nested = relative(canonical, root);
    if (!nested || !nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested)) throw new Error('session storage must be outside the agent workspace');
    await mkdir(canonical, { recursive: true }); await mkdir(root, { recursive: true }); await chmod(root, 0o700);
    return withNamespaceLock(join(root, '.workspace-migration.lock'), async () => {
      const stateDirectory = join(canonical, '.nanobot'); await rejectSymlink(stateDirectory, 'workspace state directory'); await mkdir(stateDirectory, { recursive: true });
      const marker = join(stateDirectory, 'workspace-id'); await rejectSymlink(marker, 'workspace identity marker');
      let workspaceId: string;
      if (await exists(marker)) {
        workspaceId = trim(await utf8(marker)); if (!identity.test(workspaceId)) throw new Error(`workspace identity marker is invalid: ${marker}`);
      } else {
        const matches: string[] = [];
        for (const entry of await readdir(root, { withFileTypes: true })) {
          if (!identity.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) continue;
          const owned = join(root, entry.name, '.workspace');
          try {
            const markerStat = await lstat(owned); if (markerStat.isSymbolicLink() || !markerStat.isFile()) continue;
            const recorded = await canonicalStoragePath(trim(await utf8(owned)));
            if (recorded === canonical || await sameFile(recorded, canonical)) matches.push(entry.name);
          } catch (error) { if (!(error instanceof TypeError) && (typeof error !== 'object' || error === null || !('code' in error))) throw error; }
        }
        if (matches.length > 1) throw new Error(`multiple session namespaces claim workspace ${canonical}`);
        workspaceId = matches[0] ?? randomBytes(16).toString('hex');
        if (matches.length) await atomicPrivateWrite(marker, `${workspaceId}\n`);
        else {
          try {
            const file = await open(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
            try { await file.writeFile(`${workspaceId}\n`); await file.sync(); } catch (error) { await unlink(marker); throw error; } finally { await file.close(); }
            await fsyncDirectory(stateDirectory);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            await rejectSymlink(marker, 'workspace identity marker'); workspaceId = trim(await utf8(marker));
            if (!identity.test(workspaceId)) throw new Error(`workspace identity marker is invalid: ${marker}`);
          }
        }
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const directory = join(root, workspaceId), owned = join(directory, '.workspace'); await rejectSymlink(directory, 'session namespace');
        if (!await exists(directory)) { await mkdir(directory, { recursive: true }); await atomicPrivateWrite(owned, `${canonical}\n`); return new SessionLocation(canonical, root, directory); }
        await rejectSymlink(owned, 'session workspace marker');
        if (!await exists(owned)) {
          if ((await readdir(directory)).length) throw new Error(`session namespace has data but no workspace marker: ${directory}`);
          await atomicPrivateWrite(owned, `${canonical}\n`); return new SessionLocation(canonical, root, directory);
        }
        const recordedText = trim(await utf8(owned)); if (!recordedText) throw new Error(`session workspace marker is empty: ${owned}`);
        const recorded = await canonicalStoragePath(recordedText);
        if (recorded === canonical) return new SessionLocation(canonical, root, directory);
        if (await sameFile(recorded, canonical) || !await exists(recorded)) { await atomicPrivateWrite(owned, `${canonical}\n`); return new SessionLocation(canonical, root, directory); }
        workspaceId = randomBytes(16).toString('hex'); await atomicPrivateWrite(marker, `${workspaceId}\n`);
      }
      throw new Error(`could not allocate an isolated session namespace for ${canonical}`);
    }, options);
  }
  static storageKey(key: string): string { return Buffer.from(key, 'utf8').toString('base64url'); }
  static sessionKeyFromPath(path: string): string | null {
    const name = basename(path), stem = name.slice(0, name.length - '.jsonl'.length);
    if (!name.endsWith('.jsonl') || !/^[A-Za-z0-9_-]*$/.test(stem) || stem.length % 4 === 1) return null;
    try { const value = new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(stem, 'base64url')); return this.storageKey(value) === stem ? value : null; }
    catch { return null; }
  }
}
