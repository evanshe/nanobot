import { randomUUID } from 'node:crypto';
import { NO_EVENTS } from '../bus/index.ts';
import type { EventSink } from '../bus/index.ts';
import type { ConfigObject } from '../config/decoder.ts';
import { equal } from '../session/records.ts';
import type { ChatResponse } from '../provider/chat.ts';
import { ContextWindowExceededError, estimateAgentPromptBytes, prepareAgentMessages, SUMMARY_CONTINUATION } from './requests.ts';
export type AgentSummaryCheckpoint = { summary: string; transcript_boundary: number };
export type AgentContextGovernorOptions = {
  contextWindowTokens?: number; maxTokens?: number; maxToolResultChars: number; sessionKey?: string; events?: EventSink;
  estimatePromptTokens?: (messages: readonly ConfigObject[], tools: readonly ConfigObject[]) => number;
  acceptedHistoryBoundary?: number; activeSummary?: string | null;
  consolidateHistory?: (messages: readonly ConfigObject[], previous: string | null, signal: AbortSignal) => Promise<string | null>;
  buildSummaryTranscript?: (summary: string) => Promise<ConfigObject[]>;
};
const readNotice = 'Error: read_file result was not sent because the combined request exceeds the context budget. No file was modified by this recovery. Read one file at a time with a smaller offset/limit range; for large single-line JSON, use exec to select only the needed records or fields.';
export class AgentContextGovernor {
  readonly #options: AgentContextGovernorOptions; readonly #prefix: ConfigObject[];
  #accepted: ConfigObject[]; #rawBoundary: number; #activeSummary: string | null; #checkpoint: AgentSummaryCheckpoint | null = null;
  #usageContext: number | null = null; #lastTools: ConfigObject[] | null = null; #reported = 0;
  constructor(initialMessages: readonly ConfigObject[], options: AgentContextGovernorOptions) {
    this.#options = { ...options }; this.#rawBoundary = options.acceptedHistoryBoundary ?? initialMessages.length;
    if (!Number.isSafeInteger(this.#rawBoundary) || this.#rawBoundary < 0 || this.#rawBoundary > initialMessages.length) throw new RangeError('Invalid accepted history boundary');
    this.#accepted = structuredClone(initialMessages.slice(0, this.#rawBoundary)); this.#activeSummary = options.activeSummary ?? null;
    const prefix: ConfigObject[] = []; for (const message of initialMessages) { if (message.role !== 'system' && message.role !== 'developer') break; prefix.push(structuredClone(message)); } this.#prefix = prefix;
  }
  get summaryCheckpoint(): AgentSummaryCheckpoint | null { return structuredClone(this.#checkpoint); }
  get inputBudget(): number { return this.#options.contextWindowTokens ? Math.max(0, this.#options.contextWindowTokens - (this.#options.maxTokens ?? 4096) - 1024) : 0; }
  #count(messages: readonly ConfigObject[], tools: readonly ConfigObject[]): number { return (this.#options.estimatePromptTokens ?? estimateAgentPromptBytes)(messages, tools); }
  ensureFits(messages: ConfigObject[], tools: readonly ConfigObject[]): ConfigObject[] {
    if (!this.#options.contextWindowTokens) return messages;
    const count = this.#count(messages, tools), budget = this.inputBudget;
    if (budget > 0 && count <= budget) return messages;
    throw new ContextWindowExceededError(count, budget, this.#options.sessionKey, this.#options.estimatePromptTokens ? 'runtime_counter' : 'heuristic');
  }
  async #summaryTranscript(summary: string): Promise<ConfigObject[]> {
    if (this.#options.buildSummaryTranscript) return this.#options.buildSummaryTranscript(summary);
    const prefix = structuredClone(this.#prefix), archived = `[Archived Context Summary]\n\nPrevious conversation summary:\n${summary}`;
    for (const message of [...prefix].reverse()) if (typeof message.content === 'string') { message.content += `\n\n---\n\n${archived}`; return prefix; }
    return [{ role: 'system', content: archived }, ...prefix];
  }
  async prepare(raw: ConfigObject[], tools: readonly ConfigObject[], signal: AbortSignal): Promise<ConfigObject[]> {
    return (await this.prepareWithTransient(raw, tools, signal, [])).request;
  }
  async prepareWithTransient(raw: ConfigObject[], tools: readonly ConfigObject[], signal: AbortSignal, transient: readonly ConfigObject[]): Promise<{ request: ConfigObject[]; canonical: ConfigObject[] }> {
    signal.throwIfAborted();
    const delta = structuredClone(raw.slice(this.#rawBoundary)), joined = [...structuredClone(this.#accepted), ...delta];
    const canonical = prepareAgentMessages(joined, this.#options.maxToolResultChars);
    const prepared = transient.length ? prepareAgentMessages([...canonical, ...transient], this.#options.maxToolResultChars) : canonical;
    if (!this.#options.contextWindowTokens) return { request: prepared, canonical };
    const estimated = this.#count(prepared, tools), budget = this.inputBudget; let measured = estimated, source = this.#options.estimatePromptTokens ? 'runtime_counter' : 'heuristic';
    if (!transient.length && this.#lastTools !== null && equal(tools, this.#lastTools) && this.#usageContext !== null) {
      if (equal(prepared, this.#accepted)) { measured = this.#usageContext; source = 'matching provider usage'; }
      else if (this.#reported > 0 && prepared.length >= this.#accepted.length && equal(prepared.slice(0, this.#accepted.length), this.#accepted) && this.#usageContext > estimated) { measured = this.#usageContext; source = 'prior provider usage plus pending messages'; }
    }
    if (budget > 0 && measured < budget) return { request: prepared, canonical };
    const events = this.#options.events ?? NO_EVENTS, compactionId = randomUUID();
    await events.emit({ kind: 'context_compaction', compactionId, phase: 'started', reason: 'context_pressure' }, signal);
    try {
      const summary = await this.#options.consolidateHistory?.(prepareAgentMessages(this.#accepted, this.#options.maxToolResultChars), this.#activeSummary, signal);
      signal.throwIfAborted();
      if (!summary) throw new ContextWindowExceededError(measured, budget, this.#options.sessionKey, source);
      const summaryPrefix = await this.#summaryTranscript(summary);
      const continuation: ConfigObject[] = delta.some(message => message.role === 'user') ? [] : [{ role: 'user', content: SUMMARY_CONTINUATION }];
      const fittedCanonical = prepareAgentMessages([...summaryPrefix, ...continuation, ...delta], this.#options.maxToolResultChars);
      let fitted = transient.length ? prepareAgentMessages([...fittedCanonical, ...transient], this.#options.maxToolResultChars) : fittedCanonical;
      const pendingIds = new Set(delta.filter(message => message.role === 'tool' && message.name === 'read_file').map(message => message.tool_call_id));
      const candidates = fitted.map((message, index) => ({ message, index })).filter(({ message }) => message.role === 'tool' && pendingIds.has(message.tool_call_id) && typeof message.content === 'string' && Buffer.byteLength(message.content) > readNotice.length).sort((a, b) => Buffer.byteLength(String(b.message.content)) - Buffer.byteLength(String(a.message.content)));
      const replacements = new Map<string, string>();
      while (true) {
        try { this.ensureFits(fitted, tools); break; }
        catch (error) {
          if (!(error instanceof ContextWindowExceededError)) throw error;
          const candidate = candidates.shift(); if (!candidate) throw error;
          const id = String(candidate.message.tool_call_id); replacements.set(id, readNotice); fitted[candidate.index] = { ...candidate.message, content: readNotice };
        }
      }
      signal.throwIfAborted();
      for (const message of raw.slice(this.#rawBoundary)) if (message.role === 'tool' && typeof message.tool_call_id === 'string' && replacements.has(message.tool_call_id)) message.content = replacements.get(message.tool_call_id)!;
      this.#activeSummary = summary; this.#checkpoint = { summary, transcript_boundary: this.#rawBoundary }; this.#usageContext = null;
      await events.emit({ kind: 'context_compaction', compactionId, phase: 'succeeded', reason: 'context_pressure' });
      for (const message of fittedCanonical) if (message.role === 'tool' && typeof message.tool_call_id === 'string' && replacements.has(message.tool_call_id)) message.content = replacements.get(message.tool_call_id)!;
      return { request: fitted, canonical: fittedCanonical };
    } catch (error) { await events.emit({ kind: 'context_compaction', compactionId, phase: signal.aborted ? 'cancelled' : 'failed', reason: 'context_pressure' }); throw error; }
  }
  accept(rawBoundary: number, prepared: readonly ConfigObject[], response: ChatResponse, tools: readonly ConfigObject[], usageMatchesCanonical = true): void {
    this.#accepted = structuredClone([...prepared]); this.#rawBoundary = rawBoundary; this.#usageContext = usageMatchesCanonical ? response.usage?.context_tokens ?? null : null; this.#reported = usageMatchesCanonical ? response.usage?.reported_tokens ?? 0 : 0; this.#lastTools = structuredClone([...tools]);
  }
}
