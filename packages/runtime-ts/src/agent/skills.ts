import { opendir, readFile, stat, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { object } from '../config/decoder.ts';
import type { ConfigObject } from '../config/decoder.ts';

const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;
export type SkillDocument = { name: string; path: string; source: 'workspace' | 'plugin' | 'builtin'; content: string; metadata?: ConfigObject };
export type AgentSkillsOptions = {
  workspace: string; builtinDirectory: string; disabled?: readonly string[]; aliases?: Readonly<Record<string, string>>;
  pluginDocuments?: readonly SkillDocument[]; environment?: Readonly<Record<string, string | undefined>>;
  binaryAvailable?: (command: string) => Promise<boolean>;
};
export const stripPythonWhitespace = (value: string): string => value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
export async function readContextText(path: string): Promise<string | null> {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path)).replace(/\r\n?/g, '\n'); }
  catch (error) { if (object(error) && error.code === 'ENOENT') return null; throw error; }
}
function metadata(content: string): ConfigObject {
  const match = frontmatter.exec(content); if (!match) return {};
  try { const value: unknown = parseYaml(match[1], { uniqueKeys: false }); return object(value) ? value : {}; } catch { return {}; }
}
function runtimeMetadata(meta: ConfigObject): ConfigObject {
  let raw = meta.metadata; if (typeof raw === 'string') try { raw = JSON.parse(raw); } catch { return {}; }
  if (!object(raw)) return {}; const payload = raw.nanobot ?? raw.openclaw; return object(payload) ? payload : {};
}
export class AgentSkillsSnapshot {
  readonly #options: AgentSkillsOptions; readonly #entries: SkillDocument[]; readonly #available = new Map<string, boolean>();
  private constructor(options: AgentSkillsOptions, entries: SkillDocument[]) { this.#options = options; this.#entries = entries; }
  static async load(options: AgentSkillsOptions): Promise<AgentSkillsSnapshot> {
    const entries: SkillDocument[] = [], seen = new Set<string>(), disabled = new Set(options.disabled ?? []);
    for (const [alias, canonical] of Object.entries(options.aliases ?? {})) if (disabled.has(alias) || disabled.has(canonical)) { disabled.add(alias); disabled.add(canonical); }
    const discover = async (directory: string, source: SkillDocument['source']) => {
      let directoryHandle;
      try { directoryHandle = await opendir(directory); } catch (error) { if (object(error) && error.code === 'ENOENT') return; throw error; }
      for await (const entry of directoryHandle) {
        const path = join(directory, entry.name, 'SKILL.md');
        try { if (!(await stat(join(directory, entry.name))).isDirectory()) continue; } catch (error) { if (object(error) && error.code === 'ENOENT') continue; throw error; }
        if (seen.has(entry.name)) continue; const content = await readContextText(path); if (content === null) continue;
        seen.add(entry.name); if (!disabled.has(entry.name)) entries.push({ name: entry.name, path, source, content, metadata: metadata(content) });
      }
    };
    await discover(join(options.workspace, 'skills'), 'workspace');
    for (const entry of options.pluginDocuments ?? []) if (!seen.has(entry.name)) { seen.add(entry.name); if (!disabled.has(entry.name)) entries.push({ ...structuredClone(entry), metadata: entry.metadata ?? metadata(entry.content) }); }
    await discover(options.builtinDirectory, 'builtin');
    const snapshot = new AgentSkillsSnapshot(options, entries);
    for (const entry of entries) snapshot.#available.set(entry.name, await snapshot.#requirements(entry));
    return snapshot;
  }
  async #requirements(entry: SkillDocument): Promise<boolean> {
    const meta = runtimeMetadata(entry.metadata ?? {}), requires = object(meta.requires) ? meta.requires : {};
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(stripPythonWhitespace(item))) : [];
    for (const command of strings(requires.bins)) if (!await this.#binary(command)) return false;
    const environment = this.#options.environment ?? process.env;
    return strings(requires.env).every(name => Object.hasOwn(environment, name) && Boolean(environment[name]));
  }
  async #binary(command: string): Promise<boolean> {
    if (this.#options.binaryAvailable) return this.#options.binaryAvailable(command);
    const environment = this.#options.environment ?? process.env;
    const dirs = command.includes('/') || command.includes('\\') ? [''] : (environment.PATH ?? '').split(delimiter);
    const extensions = process.platform === 'win32' ? ['', ...(environment.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
    for (const directory of dirs) for (const extension of extensions) {
      const candidate = directory ? join(directory, command + extension) : resolve(command + extension);
      try { await access(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK); if ((await stat(candidate)).isFile()) return true; } catch { /* The command is not available through this PATH candidate. */ }
    }
    return false;
  }
  entries(exclude: ReadonlySet<string> = new Set()): SkillDocument[] { return this.#entries.filter(entry => this.#available.get(entry.name) && !exclude.has(entry.name)); }
  always(exclude: ReadonlySet<string> = new Set()): string[] { return this.entries(exclude).filter(entry => runtimeMetadata(entry.metadata ?? {}).always || entry.metadata?.always).map(entry => entry.name); }
  content(names: readonly string[]): string {
    return names.map(name => {
      const entry = this.#entries.find(item => item.name === name); if (!entry) return '';
      const stripped = frontmatter.test(entry.content) ? stripPythonWhitespace(entry.content.replace(frontmatter, '')) : entry.content; return stripped ? `### Skill: ${name}\n\n${stripped}` : '';
    }).filter(Boolean).join('\n\n---\n\n');
  }
  explicit(text: string, exclude: ReadonlySet<string>): string | null {
    const available = new Set(this.entries(exclude).map(entry => entry.name)), names: string[] = [], always = this.always(exclude);
    for (const match of text.matchAll(/(?<![\p{L}\p{N}_$])\$([A-Za-z0-9_-]+)/gu)) {
      const name = available.has(match[1]) ? match[1] : this.#options.aliases?.[match[1]] ?? match[1];
      if (available.has(name) && !always.includes(name) && !names.includes(name)) names.push(name);
    }
    const content = this.content(names); return content ? `[Active Skills — instructions for this user turn]\n${content}\n[/Active Skills]` : null;
  }
  summary(project: string, exclude: ReadonlySet<string>): string {
    const sections: string[] = [], same = project === this.#options.workspace;
    for (const [label, source, root] of [['Workspace skills', 'workspace', join(this.#options.workspace, 'skills')], ['Agent Plugin skills', 'plugin', join(this.#options.workspace, 'plugins')], ['Built-in skills', 'builtin', this.#options.builtinDirectory]] as const) {
      const entries = this.entries(exclude).filter(entry => entry.source === source); if (!entries.length) continue;
      const displayRoot = same && source !== 'builtin' ? source === 'plugin' ? 'plugins' : 'skills' : root;
      sections.push([`### ${label} (\`${displayRoot}\`)`, ...entries.map(entry => {
        const path = relative(root, entry.path); if (isAbsolute(path) || path.startsWith(`..${sep}`) || path === '..') throw new Error('Skill path is outside its declared root');
        return `- **${entry.name}** — ${typeof entry.metadata?.description === 'string' && entry.metadata.description ? entry.metadata.description : entry.name}  \`${path.split(sep).join('/')}\``;
      })].join('\n'));
    }
    return sections.join('\n\n');
  }
}
