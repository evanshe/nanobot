import { readFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type, machine, homedir } from 'node:os';
import nunjucks from 'nunjucks';
import type { ConfigObject, Json } from '../config/decoder.ts';
import { canonicalStoragePath } from '../session/location.ts';
import { AgentSkillsSnapshot, readContextText, stripPythonWhitespace } from './skills.ts';
import type { AgentSkillsOptions } from './skills.ts';

import defaults from '../../resources/templates/defaults.json' with { type: 'json' };
const defaultTexts: Readonly<Record<string, string>> = defaults;

const resourceRoot = fileURLToPath(new URL('../../resources/', import.meta.url));
class ContextTemplateLoader extends nunjucks.Loader {
  getSource(name: string): nunjucks.LoaderSource {
    const path = resolve(resourceRoot, 'templates', name), subpath = relative(join(resourceRoot, 'templates'), path);
    if (isAbsolute(subpath) || subpath.startsWith('..')) throw new Error('Invalid bundled template path');
    return { src: readFileSync(path, 'utf8').replace(/\r\n?/g, '\n').replace(/\n$/, ''), path, noCache: false };
  }
}
const templates = new nunjucks.Environment(new ContextTemplateLoader(), { autoescape: false, trimBlocks: true, lstripBlocks: true });
const render = (name: string, values: Record<string, unknown>): string => templates.render(name, values);
export type RuntimeContextBlock = Readonly<{ source: string; content: string }>;
export type TranscriptInput = {
  history: readonly ConfigObject[]; currentMessage: string | null; currentRole?: string; media?: readonly string[];
  sessionSummary?: { text: string; last_active: string } | null; runtimeContextBlocks?: readonly RuntimeContextBlock[]; inputMetadata?: ConfigObject;
};
export type ContextOptions = {
  projectWorkspace?: string; channel?: string; includeMemory?: boolean; hasCron?: boolean;
};
export type ContextBuilderOptions = Omit<AgentSkillsOptions, 'workspace' | 'builtinDirectory'> & { builtinSkillsDirectory?: string; runtimeIdentity?: string };
async function canonical(path: string): Promise<string> {
  if (path === '~' || path.startsWith('~/') || process.platform === 'win32' && path.startsWith('~\\')) path = join(homedir(), path.slice(2));
  return canonicalStoragePath(path);
}
export function appendRuntimeContext(content: Json, blocks: readonly RuntimeContextBlock[]): { content: Json; marker: ConfigObject | null } {
  if (!blocks.length) return { content, marker: null };
  const sources = blocks.map(block => block.source), rendered = blocks.map(block => block.content);
  if (Array.isArray(content)) {
    const added = rendered.map(text => ({ type: 'text', text })); return { content: [...content, ...added], marker: { version: 1, sources, blocks: added } };
  }
  const text = content === null ? '' : String(content), suffix = rendered.join('\n\n');
  return { content: text ? `${text}\n\n${suffix}` : suffix, marker: { version: 1, sources, suffix } };
}
export class ContextBuilder {
  readonly workspace: string; readonly #options: ContextBuilderOptions;
  constructor(workspace: string, options: ContextBuilderOptions = {}) { this.workspace = workspace; this.#options = { ...options }; }
  async #skills(workspace: string): Promise<AgentSkillsSnapshot> { return AgentSkillsSnapshot.load({ ...this.#options, workspace, builtinDirectory: await canonical(this.#options.builtinSkillsDirectory ?? join(resourceRoot, 'skills')) }); }
  #excluded(options: ContextOptions): Set<string> { return new Set([...(options.includeMemory === false ? ['memory'] : []), ...(options.hasCron === false ? ['cron'] : [])]); }
  async #isDefault(content: string, name: string): Promise<boolean> {
    const bundled = defaultTexts[name] ?? null; return bundled !== null && stripPythonWhitespace(content) === stripPythonWhitespace(bundled);
  }
  async #system(options: ContextOptions, skills: AgentSkillsSnapshot, summary: TranscriptInput['sessionSummary']): Promise<string> {
    const agent = await canonical(this.workspace), project = await canonical(options.projectWorkspace ?? this.workspace), includeMemory = options.includeMemory !== false;
    const system = type(), platform = system === 'Darwin' ? 'macOS' : system;
    const identity = render('agent/identity.md', { runtime: this.#options.runtimeIdentity ?? `${platform} ${machine()}, Node ${process.versions.node}`, workspace_path: project, agent_workspace_path: agent, include_memory: includeMemory, platform_policy: render('agent/platform_policy.md', { system }), channel: options.channel ?? '' });
    const parts = [identity], bootstrap: string[] = [];
    for (const [name, root] of [['AGENTS.md', project], ...(includeMemory ? [['SOUL.md', agent], ['USER.md', agent]] : [])]) {
      let content = await readContextText(join(root, name)); if (content === null) continue;
      if (name === 'SOUL.md' && await this.#isDefault(content, 'legacy/SOUL.md')) content = defaultTexts['SOUL.md'] || content;
      if (!stripPythonWhitespace(content) || ['AGENTS.md', 'USER.md'].includes(name) && await this.#isDefault(content, name)) continue;
      bootstrap.push(`## ${name}\n\n${content}`);
    }
    if (bootstrap.length) parts.push(bootstrap.join('\n\n'));
    parts.push(render('agent/tool_contract.md', { has_cron: options.hasCron !== false, include_memory: includeMemory }));
    if (project !== agent) parts.push(`# Current Project\n\nWorking directory: ${project}\nUse it as the default root for project files and relative tool paths.`);
    if (includeMemory) { const memory = await readContextText(join(agent, 'memory/MEMORY.md')); if (memory && !await this.#isDefault(memory, 'memory/MEMORY.md')) parts.push(memory); }
    const excluded = this.#excluded(options), active = skills.always(excluded), activeContent = skills.content(active);
    if (activeContent) parts.push(`# Active Skills\n\n${activeContent}`);
    const skillSummary = skills.summary(project, new Set([...excluded, ...active]));
    if (skillSummary) parts.push(render('agent/skills_section.md', { skills_summary: skillSummary }));
    if (summary && summary.text !== '(nothing)') parts.push(`[Archived Context Summary]\n\nPrevious conversation summary (last active ${summary.last_active}):\n${summary.text}`);
    return parts.join('\n\n---\n\n');
  }
  async buildSystemPrompt(options: ContextOptions = {}, summary: TranscriptInput['sessionSummary'] = null): Promise<string> { return this.#system(options, await this.#skills(await canonical(this.workspace)), summary); }
  async #current(input: TranscriptInput, options: ContextOptions, skills: AgentSkillsSnapshot): Promise<ConfigObject> {
    const content = await this.buildUserContent(input.currentMessage ?? '', input.media), blocks = [...input.runtimeContextBlocks ?? []];
    if ((input.currentRole ?? 'user') === 'user') {
      const explicit = skills.explicit(input.currentMessage ?? '', this.#excluded(options)); if (explicit && !blocks.some(block => block.source === 'explicit_skills' && block.content === explicit)) blocks.push({ source: 'explicit_skills', content: explicit });
    } else blocks.length = 0;
    const combined = appendRuntimeContext(content, blocks), message: ConfigObject = { role: input.currentRole ?? 'user', content: combined.content };
    if (combined.marker || input.inputMetadata) message._meta = { ...(combined.marker ? { runtime_context: combined.marker } : {}), ...structuredClone(input.inputMetadata) };
    return message;
  }
  async buildTranscript(input: TranscriptInput, options: ContextOptions = {}): Promise<ConfigObject[]> {
    const skills = await this.#skills(await canonical(this.workspace)), messages: ConfigObject[] = [{ role: 'system', content: await this.#system(options, skills, input.sessionSummary) }, ...structuredClone(input.history)];
    if (input.currentMessage !== null) messages.push(await this.#current(input, options, skills)); return messages;
  }
  async buildCurrentMessage(input: Omit<TranscriptInput, 'history'>, options: ContextOptions = {}): Promise<ConfigObject> { return this.#current({ ...input, history: [] }, options, await this.#skills(await canonical(this.workspace))); }
  async buildUserContent(text: string, paths: readonly string[] = []): Promise<Json> {
    const images: ConfigObject[] = [];
    for (const path of paths) {
      try {
        if (!(await stat(path)).isFile()) continue; const raw = await readFile(path), extension = extname(path).toLowerCase();
        const mime = raw.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? 'image/png' : raw.subarray(0, 3).equals(Buffer.from([255, 216, 255])) ? 'image/jpeg' : ['GIF87a', 'GIF89a'].includes(raw.subarray(0, 6).toString()) ? 'image/gif' : raw.subarray(0, 4).toString() === 'RIFF' && raw.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.avif': 'image/avif', '.ico': 'image/vnd.microsoft.icon' }[extension]);
        if (mime) images.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${raw.toString('base64')}` } });
      } catch (error) { if (!(error instanceof Error && 'code' in error)) throw error; }
    }
    if (!images.length) return text; if (text) images.push({ type: 'text', text }); return images;
  }
}
