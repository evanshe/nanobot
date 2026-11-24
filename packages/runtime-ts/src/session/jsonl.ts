import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import type { BigIntStats } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { object } from '../config/decoder.ts';
import type { ConfigObject, Json } from '../config/decoder.ts';
import type { SqlWrite } from './sqlite.ts';
import { SessionRepository } from './repository.ts';
import { SessionLocation } from './location.ts';
import { atomicPrivateWrite, fsyncDirectory } from './files.ts';
import { encodeJson, equal, localTimestamp, newSession, providerState } from './records.ts';
import type { SessionRecord } from './records.ts';
import { parseUniqueJson } from './unique-json.ts';
const manifestKey = 'jsonl_workspace_sources';
type LegacyFile = { path: string; bytes: Buffer; stat: BigIntStats; digest: string };
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs; }
const trim = (text: string) => text.replace(/^[\s\u0085\u001c-\u001f]+|[\s\u0085\u001c-\u001f]+$/gu, '');
const truthy = (value: Json | undefined) => Array.isArray(value) ? value.length > 0 : object(value) ? Object.keys(value).length > 0 : !!value;
async function readStable(path: string): Promise<LegacyFile> {
  if (!(await lstat(path)).isFile()) throw new Error(`JSONL migration requires a regular file: ${path}`);
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat({ bigint: true }); if (!before.isFile()) throw new Error(`JSONL migration requires a regular file: ${path}`);
    const bytes = await file.readFile(), after = await file.stat({ bigint: true });
    if (!sameIdentity(before, after)) throw new Error(`JSONL migration source changed while reading: ${path}`);
    return { path, bytes, stat: after, digest: createHash('sha256').update(bytes).digest('hex') };
  } finally { await file.close(); }
}
function record(text: string): ConfigObject { const value = parseUniqueJson(text); if (!object(value)) throw new TypeError('JSONL records must be objects'); return value; }
function decode(bytes: Uint8Array): string { return new TextDecoder('utf8', { fatal: true, ignoreBOM: true }).decode(bytes); }
function datetime(value: Json | string | undefined, fallback: string): string {
  if (!truthy(value)) return fallback;
  if (typeof value !== 'string') throw new TypeError('invalid legacy session timestamp');
  const match = /^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2})(?::?(\d{2}))?(?::?(\d{2})(?:[.,](\d+))?)?)?(Z|[+-]\d{2}:?\d{2}(?::?\d{2}(?:\.\d+)?)?)?$/.exec(value);
  if (!match || match[8] && !match[4]) throw new TypeError('invalid legacy session timestamp');
  const [year, month, day, hour, minute, second] = [match[1], match[2], match[3], match[4] ?? '00', match[5] ?? '00', match[6] ?? '00'].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0), days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) throw new TypeError('invalid legacy session timestamp');
  const pad = (number: number, width = 2) => String(number).padStart(width, '0');
  const microseconds = (match[7] ?? '').slice(0, 6).padEnd(6, '0'); let offset = match[8] ?? '';
  if (offset === 'Z') offset = '+00:00';
  if (offset) {
    const parts = /^([+-])(\d{2}):?(\d{2})(?::?(\d{2})(?:\.(\d+))?)?$/.exec(offset)!;
    if (Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4] ?? 0) > 59) throw new TypeError('invalid legacy timezone offset');
    const fraction = (parts[5] ?? '').slice(0, 6).padEnd(6, '0');
    offset = `${parts[1]}${parts[2]}:${parts[3]}${Number(parts[4] ?? 0) || Number(fraction) ? `:${parts[4] ?? '00'}${Number(fraction) ? `.${fraction}` : ''}` : ''}`;
    if (Number(parts[2]) === 0 && Number(parts[3]) === 0 && Number(parts[4] ?? 0) === 0 && Number(fraction) === 0) offset = '+00:00';
  }
  return `${pad(year, 4)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${Number(microseconds) ? `.${microseconds}` : ''}${offset}`;
}
function modificationTime(source: LegacyFile): string {
  const seconds = Number(source.stat.mtimeNs / 1_000_000_000n) + Number(source.stat.mtimeNs % 1_000_000_000n) / 1e9, whole = Math.floor(seconds);
  const fraction = (seconds - whole) * 1e6, lower = Math.floor(fraction);
  let micros = fraction - lower === 0.5 ? lower + (lower % 2) : Math.round(fraction);
  const carry = micros === 1_000_000 ? 1 : 0; if (carry) micros = 0;
  const value = localTimestamp(new Date((whole + carry) * 1000)); return micros ? `${value}.${String(micros).padStart(6, '0')}` : value;
}
async function readLegacy(path: string): Promise<{ session: SessionRecord; files: LegacyFile[] }> {
  const source = await readStable(path), files = [source], messages: ConfigObject[] = []; let header: ConfigObject | null = null, provider: SessionRecord['providerState'] = null, providerSeen = false;
  for (const line of decode(source.bytes).split('\n')) {
    if (!trim(line)) continue; const item = record(line);
    if (item._type === 'metadata') { if (header) throw new Error(`multiple session headers: ${path}`); header = item; }
    else if (item._type === 'provider_state') {
      if (providerSeen) throw new Error(`multiple provider state records: ${path}`); providerSeen = true;
      provider = object(item.state) ? providerState(item.state) : null; if (!provider) throw new Error(`invalid private provider state: ${path}`);
    } else { if (typeof item.role !== 'string') throw new Error(`invalid session message: ${path}`); messages.push(item); }
  }
  if (!header) throw new Error(`missing session header: ${path}`);
  const key = truthy(header.key) ? header.key : SessionLocation.sessionKeyFromPath(path);
  if (typeof key !== 'string' || !key) throw new Error(`cannot determine session key: ${path}`);
  const metadata = header.metadata ?? {}; if (!object(metadata)) throw new Error(`invalid session metadata: ${path}`);
  const session = newSession(key), fallback = modificationTime(source);
  session.messages = messages; session.metadata = metadata; session.createdAt = datetime(header.created_at, fallback); session.updatedAt = datetime(header.updated_at, fallback); session.providerState = provider;
  const offset = Object.hasOwn(header, 'last_archived') ? header.last_archived : header.last_consolidated ?? 0;
  session.lastArchived = typeof offset === 'number' && Number.isInteger(offset) && offset >= 0 && offset <= messages.length ? offset : 0;
  const checkpointPath = path.slice(0, -'.jsonl'.length) + '.checkpoint.json';
  let checkpointSource: LegacyFile | null = null;
  try { checkpointSource = await readStable(checkpointPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (checkpointSource) {
    files.push(checkpointSource); const checkpoint = record(decode(checkpointSource.bytes));
    if (checkpointSource.stat.mtimeNs >= source.stat.mtimeNs && checkpoint.version === 1 && checkpoint.session_key === key && checkpoint.base_updated_at === session.updatedAt && checkpoint.base_message_count === messages.length) {
      if (!object(checkpoint.checkpoint)) throw new Error(`invalid checkpoint: ${checkpointPath}`); session.metadata.runtime_checkpoint = checkpoint.checkpoint;
      const raw = checkpoint.provider_state; session.providerState = object(raw) ? providerState(raw) : null;
      if (raw != null && !session.providerState) throw new Error(`invalid checkpoint provider state: ${checkpointPath}`);
    }
  }
  return { session, files };
}
async function rejectSymlink(path: string): Promise<void> {
  try { if ((await lstat(path)).isSymbolicLink()) throw new Error(`migration directory must not be a symlink: ${path}`); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}
function comparable(session: SessionRecord) { return [session.key, session.messages, session.metadata, session.createdAt, session.updatedAt, session.lastArchived, session.providerState]; }
export async function importLegacyJsonl(transaction: SqlWrite, repository: SessionRepository, workspace: string): Promise<void> {
  const marker = (await transaction.all("SELECT value FROM storage_meta WHERE key='jsonl_import'"))[0];
  if (marker) { if (marker.value !== 'complete') throw new Error(`invalid JSONL migration marker: ${String(marker.value)}`); return; }
  const imported = new Map<string, { path: string; digests: string[]; session: SessionRecord }>(), manifest: { name: string; digest: string }[] = [];
  const sourceDirectory = join(workspace, 'sessions');
  for (const directory of [dirname(repository.driver.path), sourceDirectory]) {
    await rejectSymlink(directory); let names: string[];
    try { names = (await readdir(directory)).filter(name => name.endsWith('.jsonl')).sort(); }
    catch (error) { if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue; throw error; }
    for (const name of names) {
      const path = join(directory, name);
      try {
        const { session, files } = await readLegacy(path), digests = files.map(file => file.digest), prior = imported.get(session.key);
        if (prior) { if (!equal(prior.digests, digests) || !equal(comparable(prior.session), comparable(session))) throw new Error(`duplicate JSONL session key: ${prior.path} and ${path}`); }
        else {
          if (await repository.loadFrom(transaction, session.key)) throw new Error(`session already exists in SQLite: ${session.key}`);
          await repository.saveTo(transaction, session); imported.set(session.key, { path, digests, session: structuredClone(session) });
        }
        if (directory === sourceDirectory) for (const source of files) manifest.push({ name: basename(source.path), digest: source.digest });
      } catch (cause) { throw new Error(`JSONL migration failed for ${path}; source files are unchanged. Resolve the invalid or conflicting file and restart.`, { cause }); }
    }
  }
  if (manifest.length) await transaction.run('INSERT INTO storage_meta (key,value) VALUES (?,?)', [manifestKey, encodeJson(manifest)]);
  await transaction.run("INSERT INTO storage_meta (key,value) VALUES ('jsonl_import','complete')");
}
export async function finishLegacyIsolation(transaction: SqlWrite, repository: SessionRepository, workspace: string): Promise<void> {
  const pending = (await transaction.all('SELECT value FROM storage_meta WHERE key=?', [manifestKey]))[0]; if (!pending) return;
  const directory = join(workspace, 'sessions'), backup = join(dirname(repository.driver.path), 'jsonl-backup');
  try {
    if (typeof pending.value !== 'string') throw new Error('workspace migration manifest must be JSON');
    const manifest = parseUniqueJson(pending.value); if (!Array.isArray(manifest)) throw new Error('workspace migration manifest must be a list');
    const records = manifest.map(value => {
      if (!object(value)) throw new Error('invalid workspace migration source');
      const { name, digest } = value;
      if (typeof name !== 'string' || basename(name) !== name || !['.jsonl', '.checkpoint.json'].some(suffix => name.endsWith(suffix)) || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) throw new Error('invalid workspace migration source');
      return { name, digest };
    });
    await rejectSymlink(directory); await rejectSymlink(backup); await mkdir(backup, { mode: 0o700, recursive: true }); await fsyncDirectory(dirname(backup));
    const prepared: { path: string; stat: BigIntStats }[] = [];
    for (const item of records) {
      const sourcePath = join(directory, item.name), backupPath = join(backup, item.name); let source: LegacyFile | null = null;
      try { source = await readStable(sourcePath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (source) { if (source.digest !== item.digest) throw new Error(`workspace migration source changed: ${sourcePath}`); prepared.push({ path: sourcePath, stat: source.stat }); }
      let existing: LegacyFile | null = null;
      try { existing = await readStable(backupPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (existing) { if (existing.digest !== item.digest) throw new Error(`workspace migration backup differs from its source: ${backupPath}`); }
      else { if (!source) throw new Error(`workspace migration source and backup are missing: ${sourcePath}`); await atomicPrivateWrite(backupPath, source.bytes, source.stat); }
    }
    await fsyncDirectory(backup);
    for (const item of prepared) { const actual = await lstat(item.path, { bigint: true }); if (!actual.isFile() || !sameIdentity(actual, item.stat)) throw new Error(`workspace migration source changed: ${item.path}`); }
    for (const item of prepared) await unlink(item.path);
    try { if ((await lstat(directory)).isDirectory()) await fsyncDirectory(directory); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await transaction.run('DELETE FROM storage_meta WHERE key=?', [manifestKey]);
  } catch (cause) { throw new Error(`Could not move legacy sessions out of ${directory}; backups are in ${backup}. Resolve the file error and restart.`, { cause }); }
}
