import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { DecodeError, decode, object, rootShape, serialize, shapeOf } from './decoder.ts';
import type { ConfigObject, Issue, Json } from './decoder.ts';
import type { ConfigData } from './types.ts';
export type * from './types.ts';
import { migrateFile, normalizeInput, normalizeProxy, validateConfig } from './normalize.ts';

export type { ConfigObject, Issue, Json } from './decoder.ts';
export class ConfigLoadError extends Error {
  path: string;
  kind: 'invalid_json' | 'invalid_root' | 'invalid_schema' | 'io_error' | 'missing_env';
  issues: Issue[];
  constructor(path: string, kind: ConfigLoadError['kind'], summary: string, issues: Issue[] = []) {
    super(`${path}: ${summary}${issues.map(issue => `\n${issue.path.join('.')}: ${issue.message}`).join('')}`);
    this.name = 'ConfigLoadError'; this.path = path; this.kind = kind; this.issues = issues;
  }
}
export type ConfigOptions = {
  home?: string;
  env?: Record<string, string | undefined>;
  userHome?: string;
  timezone?: string;
};
export function expandUser(path: string, userHome = homedir()): string {
  return path === '~' ? userHome : path.startsWith('~/') ? join(userHome, path.slice(2)) : path;
}
async function canonical(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return join(await canonical(dirname(path)), basename(path));
  }
}
export function getConfigPath(options: ConfigOptions = {}): string {
  return join(options.home ? resolve(expandUser(options.home, options.userHome)) : join(options.userHome ?? homedir(), '.nanobot'), 'config.json');
}
export function mergeMissingDefaults(existing: Json, defaults: Json): Json {
  if (!object(existing) || !object(defaults)) return existing;
  const merged = { ...existing };
  for (const [key, value] of Object.entries(defaults)) merged[key] = key in merged ? mergeMissingDefaults(merged[key], value) : structuredClone(value);
  return merged;
}
function merge(high: ConfigObject, low: ConfigObject): ConfigObject {
  const result: ConfigObject = Object.assign(Object.create(null), low);
  for (const [key, value] of Object.entries(high)) result[key] = object(value) && object(result[key]) ? merge(value, result[key]) : value;
  return result;
}
function canonicalKeys(value: Json, schema = rootShape): Json {
  const shape = shapeOf(schema);
  if (!object(value)) return value;
  const result: ConfigObject = Object.create(null);
  const consumed = new Set<string>();
  for (const [key, field] of Object.entries(shape.properties ?? {})) {
    const aliases = field['x-aliases'] ?? [key];
    const found = aliases.find(alias => Object.hasOwn(value, alias));
    if (found === undefined) continue;
    result[key] = canonicalKeys(value[found], field); consumed.add(found);
  }
  for (const [key, item] of Object.entries(value)) if (!consumed.has(key)) result[key] = item;
  return result;
}
function environmentData(env: Record<string, string | undefined>): ConfigObject {
  const result: ConfigObject = Object.create(null);
  for (const [name, raw] of Object.entries(env).sort(([a], [b]) => a.split('__').length - b.split('__').length)) {
    if (!name.toUpperCase().startsWith('NANOBOT_') || raw === undefined) continue;
    const parts = name.slice(8).toLowerCase().split('__');
    // Settings ignores unrecognized top-level environment variables.
    const root = Object.entries(rootShape.properties ?? {}).find(([key, field]) => [key, ...(field['x-aliases'] ?? [])].some(alias => alias.toLowerCase() === parts[0]));
    if (!root) continue;
    let target = result;
    let schema = rootShape;
    for (let index = 0; index < parts.length; index++) {
      const shape = shapeOf(schema);
      const match = Object.entries(shape.properties ?? {}).find(([key, field]) => [key, ...(field['x-aliases'] ?? [])].some(alias => alias.toLowerCase() === parts[index]));
      const key = match ? [match[0], ...(match[1]['x-aliases'] ?? [])].find(alias => alias.toLowerCase() === parts[index])! : parts[index];
      schema = match?.[1] ?? (typeof shape.additionalProperties === 'object' ? shape.additionalProperties : {});
      if (index < parts.length - 1) {
        if (!Object.hasOwn(target, key) || !object(target[key])) target[key] = Object.create(null);
        target = target[key] as ConfigObject;
      } else {
        const kind = shapeOf(schema);
        const complex = kind.type === 'object' || kind.type === 'array' || kind.anyOf?.some(branch => ['object', 'array'].includes(shapeOf(branch).type ?? ''));
        if (complex) {
          try { target[key] = JSON.parse(raw); }
          catch { throw new DecodeError(parts, 'Complex NANOBOT_* values must use valid JSON'); }
        } else target[key] = raw;
      }
    }
  }
  return result;
}
export class Configuration {
  data: ConfigData;
  sourcePath: string;
  userHome: string;
  oauthSettings: Record<string, string[]>;
  constructor(data: ConfigData, sourcePath: string, userHome: string, oauthSettings: Record<string, string[]>) {
    this.data = data; this.sourcePath = sourcePath; this.userHome = userHome;
    this.oauthSettings = structuredClone(oauthSettings);
    for (const key of ['openaiCodex', 'xaiGrok'] as const) {
      const names = this.oauthSettings[key];
      this.data.providers[key] = new Proxy(data.providers[key], {
        set(target, name, value) {
          if (typeof name === 'string' && ['useProxy', 'extraBody'].includes(name) && !names.includes(name)) names.push(name);
          return Reflect.set(target, name, value);
        },
      });
    }
  }
  get runtimeDataDir(): string { return dirname(this.sourcePath); }
  get workspacePath(): string {
    return expandUser(this.data.agents.defaults.workspace, this.userHome);
  }
}
export async function loadConfig(path?: string, options: ConfigOptions = {}): Promise<Configuration> {
  const userHome = options.userHome ?? homedir();
  const source = resolve(expandUser(path ?? getConfigPath(options), userHome));
  let input: Json = {};
  try {
    const bytes = await readFile(source);
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
    catch { throw new ConfigLoadError(source, 'io_error', 'The file is not valid UTF-8.'); }
    try { input = JSON.parse(text); }
    catch { throw new ConfigLoadError(source, 'invalid_json', 'Invalid JSON syntax.'); }
  } catch (error) {
    if (error instanceof ConfigLoadError) throw error;
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigLoadError(source, 'io_error', `Unable to read the file: ${(error as Error).message}`);
  }
  if (!object(input)) throw new ConfigLoadError(source, 'invalid_root', 'The top level of config.json must be a JSON object.', [{ path: [], message: 'Expected an object' }]);
  try {
    migrateFile(input);
    const env = environmentData(options.env ?? process.env);
    const high = canonicalKeys(input) as ConfigObject;
    const low = canonicalKeys(env) as ConfigObject;
    // Exec aliases conflict only within one source; a file value outranks env.
    for (const item of [input, env]) {
      const tools = object(item.tools) ? item.tools : {};
      const execution = object(tools.exec) ? tools.exec : {};
      if ('timeout' in execution && ('maxRuntime' in execution || 'max_runtime' in execution)) throw new DecodeError(['tools', 'exec'], 'Use maxRuntime or legacy timeout, not both');
    }
    const data = merge(high, low);
    normalizeInput(data, options.timezone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone);
    const parsed = decode(data) as ConfigData;
    // Portable workspace default depends on explicit instance selection, never process-global state.
    const inputDefaults = object(data.agents) && object(data.agents.defaults) ? data.agents.defaults : {};
    if (!('workspace' in inputDefaults) && options.home) parsed.agents.defaults.workspace = join(await canonical(resolve(expandUser(options.home, userHome))), 'workspace');
    validateConfig(parsed);
    const oauthSettings: Record<string, string[]> = {};
    const providers = object(data.providers) ? data.providers : {};
    for (const key of ['openaiCodex', 'xaiGrok']) {
      const provider = object(providers[key]) ? providers[key] : {};
      oauthSettings[key] = ['useProxy', 'extraBody'].filter(name => name in provider || name.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`) in provider);
    }
    return new Configuration(parsed, await canonical(source), userHome, oauthSettings);
  } catch (error) {
    if (error instanceof DecodeError) throw new ConfigLoadError(source, 'invalid_schema', 'Invalid configuration.', error.issues);
    throw error;
  }
}
const envPattern = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
export function resolveEnvRefs(value: Json, env: Record<string, string | undefined> = process.env): Json {
  if (typeof value !== 'string') return value;
  if ([...value.matchAll(envPattern)].some(match => env[match[1]] === undefined)) return '';
  return value.replace(envPattern, (_, name: string) => env[name]!);
}
export function resolveConfigEnvVars(config: Configuration, env: Record<string, string | undefined> = process.env): Configuration {
  const issues: Issue[] = [];
  const visit = (value: Json, path: (string | number)[]): Json => {
    if (typeof value === 'string') {
      for (const name of new Set([...value.matchAll(envPattern)].map(match => match[1]))) if (env[name] === undefined) issues.push({ path, message: `Environment variable '${name}' is not set.` });
      if (path.join('.') === 'network.proxy') {
        const start = value.indexOf('://') + 3, end = value.lastIndexOf('@');
        const expanded = value.replace(envPattern, (match, name: string, offset: number) => {
          const raw = env[name]; if (raw === undefined) return match;
          const quote = (part: string) => encodeURIComponent(part).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
          if (start <= offset && offset < end) {
            if (offset === start && offset + match.length === end) {
              const colon = raw.indexOf(':');
              const escape = (part: string) => quote(part).replaceAll('%25', '%');
              return colon < 0 ? escape(raw) : `${escape(raw.slice(0, colon))}:${escape(raw.slice(colon + 1))}`;
            }
            return quote(raw);
          }
          return raw;
        });
        return issues.length ? expanded : normalizeProxy(expanded);
      }
      return value.replace(envPattern, (match, name: string) => env[name] ?? match);
    }
    if (Array.isArray(value)) return value.map((item, index) => visit(item, [...path, index]));
    if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item, [...path, key])]));
    return value;
  };
  const data = visit(config.data, []) as ConfigData;
  if (issues.length) throw new ConfigLoadError(config.sourcePath, 'missing_env', `Found ${issues.length} missing environment variable reference(s).`, issues);
  if (JSON.stringify(data) === JSON.stringify(config.data)) return config;
  return new Configuration(data, config.sourcePath, config.userHome, config.oauthSettings);
}
export async function saveConfig(config: Configuration, path = config.sourcePath): Promise<void> {
  const data = serialize(config.data) as ConfigObject;
  const providers = data.providers as ConfigObject;
  for (const [key, names] of Object.entries(config.oauthSettings)) {
    const source = (config.data.providers as ConfigObject)[key] as ConfigObject;
    const settings = Object.fromEntries(names.filter(name => source[name] !== null).map(name => [name, source[name]]));
    if (Object.keys(settings).length) providers[key] = settings;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID().replaceAll('-', '')}.tmp`);
  let mode: number | undefined;
  try { mode = (await stat(path)).mode & 0o7777; } catch { /* Python also tolerates stat failure. */ }
  try {
    const file = await open(temporary, 'wx', 0o666);
    try {
      if (mode !== undefined) await chmod(temporary, mode);
      await file.writeFile(JSON.stringify(data, null, 2), 'utf8'); await file.sync();
    } finally { await file.close(); }
    await rename(temporary, path);
    try { const directory = await open(dirname(path), 'r'); try { await directory.sync(); } finally { await directory.close(); } }
    catch { /* Directory fsync is best effort, matching Python. */ }
  } finally {
    try { await unlink(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
