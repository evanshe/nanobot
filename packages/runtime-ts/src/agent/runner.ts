import { randomUUID } from 'node:crypto';
import { object } from '../config/decoder.ts';
import type { ConfigObject, Json } from '../config/decoder.ts';
import { NO_EVENTS, EventSink } from '../bus/index.ts';
import { addUsage } from '../bus/usage.ts';
import type { LLMUsage } from '../bus/usage.ts';
import type { ChatCallbacks, ChatRequest, ChatResponse } from '../provider/chat.ts';
import type { ChatToolCall, ChatUsage } from '../provider/values.ts';
import { parseChatToolArguments } from '../provider/values.ts';
import { stripThink, hiddenHistory } from '../session/records.ts';
import prompts from './prompts.json' with { type: 'json' };

export interface AgentModel {
  chatStream(request: ChatRequest, callbacks?: ChatCallbacks, signal?: AbortSignal): Promise<ChatResponse>;
}
export type AgentToolResult = { content: Json; status: 'ok' | 'error'; detail?: string };
// The injected execution boundary owns schema validation and later tool policy.
// No filesystem, process, network or plugin implementation is registered here.
export interface AgentTools {
  definitions: readonly ConfigObject[];
  concurrencySafe?: (name: string) => boolean;
  validate(name: string, args: ConfigObject): readonly string[];
  execute(name: string, args: ConfigObject, signal: AbortSignal): Promise<AgentToolResult>;
}
export type AgentCheckpoint = {
  phase: 'model_input' | 'awaiting_tools' | 'tools_completed' | 'final_response'; iteration: number; model: string;
  assistant_message: ConfigObject | null; completed_tool_results: ConfigObject[]; pending_tool_calls: ConfigObject[]; preceding_messages: ConfigObject[]; provider_state?: null;
};
export type AgentRunSpec = {
  initialMessages: readonly ConfigObject[]; model: AgentModel; modelName: string; tools: AgentTools;
  maxIterations: number; maxToolResultChars: number; maxTokens?: number; temperature?: number; reasoningEffort?: string;
  contextWindowTokens?: number; sessionKey?: string; concurrentTools?: boolean; finalizeOnMaxIterations?: boolean;
  maxIterationsMessage?: string; events?: EventSink;
  onCheckpoint?: (checkpoint: AgentCheckpoint) => Promise<void>;
  prepareRequest?: (messages: readonly ConfigObject[], tools: readonly ConfigObject[], signal: AbortSignal) => Promise<ConfigObject[]>;
  estimatePromptTokens?: (messages: readonly ConfigObject[], tools: readonly ConfigObject[]) => number;
};
export type AgentRunResult = {
  final_content: string | null; messages: ConfigObject[]; tools_used: string[]; usage: LLMUsage | null; round_usages: LLMUsage[];
  stop_reason: 'completed' | 'max_iterations' | 'empty_final_response' | 'error'; error: string | null;
  tool_events: ConfigObject[];
};
export class ContextWindowExceededError extends Error {
  readonly estimatedTokens: number; readonly inputBudget: number;
  constructor(estimated: number, budget: number, sessionKey = 'default') {
    super(`Model input exceeds the local context budget for ${sessionKey}: ${estimated}/${budget} via heuristic`);
    this.name = 'ContextWindowExceededError'; this.estimatedTokens = estimated; this.inputBudget = budget;
  }
}
function pythonJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(pythonJson).join(', ')}]`;
  if (object(value)) return `{${Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}: ${pythonJson(item)}`).join(', ')}}`;
  return JSON.stringify(value);
}
export function agentToolCallMessage(call: ChatToolCall): ConfigObject {
  const result: ConfigObject = { id: call.id, type: 'function', function: { name: call.name, arguments: typeof call.arguments === 'string' ? call.arguments : pythonJson(call.arguments) } };
  if (call.extra_content) result.extra_content = structuredClone(call.extra_content);
  if (call.provider_specific_fields) result.provider_specific_fields = structuredClone(call.provider_specific_fields);
  if (call.function_provider_specific_fields && object(result.function)) result.function.provider_specific_fields = structuredClone(call.function_provider_specific_fields);
  return result;
}
// Python's conservative UTF-8 fallback. A runtime can supply its tokenizer or
// provider counter; counting is applied to the final prepared model request.
export function estimateAgentPromptBytes(messages: readonly ConfigObject[], tools: readonly ConfigObject[] = []): number {
  const parts: string[] = [];
  for (const msg of messages) {
    if (typeof msg.content === 'string') parts.push(msg.content);
    else if (Array.isArray(msg.content)) for (const block of msg.content) if (object(block) && block.type === 'text' && typeof block.text === 'string' && block.text) parts.push(block.text);
    if (msg.tool_calls) parts.push(pythonJson(msg.tool_calls));
    if (typeof msg.reasoning_content === 'string' && msg.reasoning_content) parts.push(msg.reasoning_content);
    for (const key of ['name', 'tool_call_id']) if (typeof msg[key] === 'string' && msg[key]) parts.push(msg[key]);
  }
  const payload = parts.join('\n') + (tools.length ? `${parts.join('\n') ? '\n' : ''}${pythonJson([...tools])}` : '');
  return Buffer.byteLength(payload, 'utf8') + messages.length * 4;
}
function usage(value: ChatUsage): LLMUsage {
  return { inputTokens: value.input_tokens, outputTokens: value.output_tokens, totalTokens: value.total_tokens, cacheReadTokens: value.cache_read_tokens, cacheWriteTokens: value.cache_write_tokens, reportedTokens: value.reported_tokens, estimatedTokens: value.estimated_tokens, generationMs: value.generation_ms, measuredOutputTokens: value.measured_output_tokens, ttftMs: value.ttft_ms, timedRequests: value.timed_requests, contextTokens: value.context_tokens, requestCount: value.request_count };
}
const hint = "\n\n[Consider this result in the context of the user's goal and decide whether and how to proceed.]";
const interrupted = "Error: Task interrupted; this tool's outcome is unknown. Check its effects before retrying.";
function inputIds(messages: readonly ConfigObject[]): string[] {
  const ids: string[] = [];
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user') { if (ids.length) break; continue; }
    if (object(message._hidden_history) && message._hidden_history.kind === 'internal_continuation') { if (ids.length) break; continue; }
    const id = object(message._meta) ? message._meta.input_id : null; if (typeof id !== 'string' || !id) break; ids.push(id);
  }
  return ids.reverse();
}
function assistant(content: string | null, response: ChatResponse, ids: string[], calls: ChatToolCall[] = []): ConfigObject {
  const value: ConfigObject = { role: 'assistant', content: content || '', _meta: { response_input_ids: ids } };
  if (calls.length) value.tool_calls = calls.map(agentToolCallMessage);
  if (response.reasoning_content !== null) value.reasoning_content = stripThink(response.reasoning_content);
  return value;
}
function normalizeResult(name: string, content: Json, limit: number): Json {
  if (content === null || typeof content === 'string' && !content.trim() || Array.isArray(content) && !content.length) return `(${name} completed with no output)`;
  return typeof content === 'string' && limit > 0 && [...content].length > limit ? `${[...content].slice(0, limit).join('')}\n... (truncated)` : structuredClone(content);
}
function mergeVisibleUserText(messages: ConfigObject[]): ConfigObject[] {
  const prepared: ConfigObject[] = [];
  for (const source of messages) {
    const last = prepared.at(-1);
    if (source.role === 'user' && last?.role === 'user' && !hiddenHistory(source) && !hiddenHistory(last) && typeof source.content === 'string' && typeof last.content === 'string') last.content = `${last.content}\n\n${source.content}`;
    else prepared.push(source);
  }
  return prepared;
}
export class AgentRunner {
  async run(spec: AgentRunSpec, signal = new AbortController().signal): Promise<AgentRunResult> {
    if (!Number.isSafeInteger(spec.maxIterations) || spec.maxIterations < 0 || !Number.isSafeInteger(spec.maxToolResultChars)) throw new RangeError('Runner limits must be integers, with non-negative iteration count');
    const messages = structuredClone([...spec.initialMessages]), start = messages.length, events = spec.events ?? NO_EVENTS;
    const result: AgentRunResult = { final_content: null, messages, tools_used: [], usage: null, round_usages: [], stop_reason: 'completed', error: null, tool_events: [] };
    const runId = randomUUID(), lengths: string[] = []; let sequence = 0, empty = 0, lastStreamedContent = ''; 
    const checkpoint = async (phase: AgentCheckpoint['phase'], iteration: number, message: ConfigObject | null, completed: ConfigObject[] = [], pending: ConfigObject[] = []) => {
      const batchSize = phase === 'model_input' ? 0 : 1 + completed.length;
      await spec.onCheckpoint?.(structuredClone({ phase, iteration, model: spec.modelName, assistant_message: message, completed_tool_results: completed, pending_tool_calls: pending, preceding_messages: messages.slice(start, messages.length - batchSize), ...(phase === 'awaiting_tools' || phase === 'model_input' ? {} : { provider_state: null }) }));
    };
    const invoke = async (requestMessages: ConfigObject[], tools: readonly ConfigObject[]): Promise<ChatResponse> => {
      signal.throwIfAborted(); lastStreamedContent = '';
      const prepared = mergeVisibleUserText(spec.prepareRequest ? await spec.prepareRequest(structuredClone(requestMessages), structuredClone([...tools]), signal) : structuredClone(requestMessages));
      const budget = spec.contextWindowTokens ? Math.max(0, spec.contextWindowTokens - (spec.maxTokens ?? 4096) - 1024) : 0;
      if (budget) { const count = (spec.estimatePromptTokens ?? estimateAgentPromptBytes)(prepared, tools); if (count > budget) throw new ContextWindowExceededError(count, budget, spec.sessionKey); }
      const requestId = randomUUID(), ids = inputIds(messages);
      const emit = async (phase: 'started' | 'completed' | 'failed' | 'cancelled', requestUsage: LLMUsage | null = null) => events.emit({ kind: 'model_request', requestId, runId, sequence: ++sequence, phase, requestUsage, usage: result.usage, roundUsages: result.round_usages, contextWindowTokens: spec.contextWindowTokens, responseInputIds: phase === 'started' ? ids : [] });
      await events.emit({ kind: 'response_inputs', inputIds: ids }, signal); await emit('started');
      try {
        const request: ChatRequest = { messages: prepared, model: spec.modelName, max_tokens: spec.maxTokens ?? 4096, temperature: spec.temperature ?? 0.7, ...(spec.reasoningEffort === undefined ? {} : { reasoning_effort: spec.reasoningEffort }), ...(tools.length ? { tools } : {}) };
        const response = await spec.model.chatStream(request, {
          onContentDelta: async content => { lastStreamedContent += content; await events.emit({ kind: 'stream_delta', content }, signal); },
          onThinkingDelta: async content => events.emit({ kind: 'progress', content, reasoning: true, reasoningDelta: true }, signal),
          onToolCallDelta: async delta => events.emit({ kind: 'progress', content: '', toolEvents: [{ ...delta }] }, signal),
        }, signal);
        signal.throwIfAborted();
        if (response.usage) { const round = usage(response.usage); result.round_usages.push(round); result.usage = result.usage ? addUsage(result.usage, round) : round; }
        await emit(response.finish_reason === 'error' ? 'failed' : 'completed', response.usage ? usage(response.usage) : null);
        return structuredClone(response);
      } catch (error) { await emit(signal.aborted ? 'cancelled' : 'failed'); throw error; }
    };
    const appendFinal = (text: string, response: ChatResponse) => {
      const value = assistant(text, response, inputIds(messages)), last = messages.at(-1);
      if (last?.role === 'assistant' && !last.tool_calls) { if (last.content !== text) messages[messages.length - 1] = value; }
      else messages.push(value);
    };
    for (let iteration = 0; iteration < spec.maxIterations; iteration++) {
      signal.throwIfAborted(); let response = await invoke(messages, spec.tools.definitions);
      response.tool_calls = response.tool_calls.filter(call => typeof call.name === 'string' && call.name.length > 0);
      const executable = response.tool_calls.length && ['tool_calls', 'function_call', 'stop'].includes(response.finish_reason);
      if (executable) {
        const message = assistant(response.content ? stripThink(response.content) : '', response, inputIds(messages), response.tool_calls); messages.push(message);
        await checkpoint('awaiting_tools', iteration, message, [], response.tool_calls.map(agentToolCallMessage));
        const settled = new Map<string, AgentToolResult>(), toolController = new AbortController();
        const abortTools = () => toolController.abort(signal.reason); signal.addEventListener('abort', abortTools, { once: true }); if (signal.aborted) abortTools();
        const toolSignal = toolController.signal;
        const execute = async (call: ChatToolCall) => {
          toolSignal.throwIfAborted();
          let args = parseChatToolArguments(call.arguments), outcome: AgentToolResult;
          const definition = spec.tools.definitions.find(item => object(item.function) && item.function.name === call.name);
          const failure = (text: string): AgentToolResult => ({ status: 'error', content: text.endsWith(hint) ? text : text + hint, detail: text.split(': ').slice(1).join(': ').slice(0, 120) });
          if (!definition) outcome = failure(`Error: Tool '${call.name}' not found. Available: ${spec.tools.definitions.map(item => object(item.function) ? item.function.name : '').join(', ')}`);
          else {
            const properties = object(definition.function) && object(definition.function.parameters) && object(definition.function.parameters.properties) ? definition.function.parameters.properties : {};
            if (object(args) && Object.keys(args).length === 1 && 'arguments' in args && !('arguments' in properties)) args = parseChatToolArguments(args.arguments);
            if (!object(args)) outcome = failure(`Error: Tool '${call.name}' parameters must be a JSON object, got ${Array.isArray(args) ? 'list' : typeof args === 'string' ? 'str' : typeof args === 'boolean' ? 'bool' : 'int'}. Use named parameters like tool_name(param1="value1", param2="value2") matching the tool schema.`);
            else {
              const errors = spec.tools.validate(call.name, structuredClone(args));
              if (errors.length) outcome = failure(`Error: Invalid parameters for tool '${call.name}': ${errors.join('; ')}`);
              else {
                await events.emit({ kind: 'progress', content: '', toolEvents: [{ name: call.name, status: 'running' }] }, toolSignal);
                try { outcome = await spec.tools.execute(call.name, structuredClone(args), toolSignal); }
                catch (error) { if (toolSignal.aborted) throw toolSignal.reason; outcome = failure(`Error: ${error instanceof Error ? error.name + ': ' + error.message : String(error)}`); }
              }
            }
          }
          settled.set(call.id, structuredClone(outcome));
          await events.emit({ kind: 'progress', content: '', toolEvents: [{ name: call.name, status: outcome.status, detail: outcome.detail ?? String(outcome.content) }] }, toolSignal);
        };
        try {
          // Only explicitly safe adjacent calls share a batch. Every task stays
          // owned through settlement before exclusive or later work starts.
          const batches: ChatToolCall[][] = []; let batch: ChatToolCall[] = [];
          for (const call of response.tool_calls) {
            if (spec.concurrentTools && spec.tools.concurrencySafe?.(call.name)) batch.push(call);
            else { if (batch.length) { batches.push(batch); batch = []; } batches.push([call]); }
          }
          if (batch.length) batches.push(batch);
          for (const entries of batches) {
            const outcomes = await Promise.allSettled(entries.map(async call => { try { await execute(call); } catch (error) { toolController.abort(error); throw error; } }));
            const failure = outcomes.find(item => item.status === 'rejected'); if (failure?.status === 'rejected') throw failure.reason;
          }
        } finally {
          signal.removeEventListener('abort', abortTools);
          const completed: ConfigObject[] = [];
          for (const call of response.tool_calls) {
            const outcome = settled.get(call.id), row: ConfigObject = { role: 'tool', tool_call_id: call.id, name: call.name, content: outcome ? normalizeResult(call.name, outcome.content, spec.maxToolResultChars) : interrupted };
            if (!outcome) row._recovery_interrupted = true;
            else { const detail = outcome.detail ?? (outcome.content === null ? '(empty)' : String(outcome.content).replaceAll('\n', ' ').trim() || '(empty)'); result.tool_events.push({ name: call.name, status: outcome.status, detail }); if (outcome.status === 'ok') result.tools_used.push(call.name); }
            messages.push(row); completed.push(row);
          }
          await checkpoint('tools_completed', iteration, message, completed);
        }
        signal.throwIfAborted(); empty = 0; lengths.length = 0; continue;
      }
      if (!response.content?.trim() && !['error', 'length', 'refusal', 'content_filter'].includes(response.finish_reason)) {
        if (++empty < 2) continue;
        response = await invoke([...messages, { role: 'user', content: prompts.FINALIZATION_RETRY_PROMPT }], []);
      }
      const clean = response.content ? stripThink(response.content) : response.content;
      if (response.finish_reason === 'length' && lengths.length < 3) {
        lengths.push(clean || ''); messages.push(assistant(clean, response, inputIds(messages)));
        const tail = [...clean || ''].slice(-64).join('');
        messages.push({ role: 'user', content: `${prompts.LENGTH_RECOVERY_PROMPT}\n\nThe following tail was already delivered to the user. Treat it as immutable context and do not output it again:\n<already_delivered_tail>\n${tail}\n</already_delivered_tail>\nBegin with the text that belongs immediately after this tail.`, _hidden_history: { kind: 'internal_continuation' } }); continue;
      }
      if (response.finish_reason === 'error') {
        const partial = stripThink(lastStreamedContent); if (partial.trim()) messages.push({ ...assistant(partial, response, inputIds(messages)), _interrupted: true });
        result.final_content = clean || 'Sorry, I encountered an error calling the AI model.'; result.stop_reason = 'error'; result.error = result.final_content;
        if (messages.at(-1)?.role !== 'assistant' || messages.at(-1)?.tool_calls) messages.push({ role: 'assistant', content: '[Assistant reply unavailable due to model error.]' });
      } else if (!clean?.trim()) { result.final_content = prompts.EMPTY_FINAL_RESPONSE_MESSAGE; result.stop_reason = 'empty_final_response'; result.error = result.final_content; appendFinal(result.final_content, response); }
      else { result.final_content = lengths.length ? [...lengths, clean].join('').trim() : clean; messages.push(assistant(clean, response, inputIds(messages))); await checkpoint('final_response', iteration, messages.at(-1)!); }
      await events.emit({ kind: 'stream_end', content: result.final_content || '' }, signal); return result;
    }
    result.stop_reason = 'max_iterations';
    const fallback = (spec.maxIterationsMessage ?? prompts.MAX_ITERATIONS.replace('{{ max_iterations }}', String(spec.maxIterations))).replaceAll('{max_iterations}', String(spec.maxIterations));
    let terminal = fallback; let response: ChatResponse = { content: null, reasoning_content: null, tool_calls: [], usage: null, finish_reason: 'stop' };
    if (spec.finalizeOnMaxIterations !== false) {
      try { response = await invoke([...messages, { role: 'user', content: prompts.BUDGET_EXHAUSTED_FINALIZATION_PROMPT }], []); if (response.finish_reason !== 'error' && !response.tool_calls.length && response.content?.trim()) terminal = stripThink(response.content); }
      catch (error) { if (signal.aborted) throw error; }
    }
    result.final_content = lengths.length ? `${lengths.join('').trimEnd()}\n\n${terminal.trimStart()}`.trim() : terminal; appendFinal(terminal, response);
    await events.emit({ kind: 'stream_end', content: result.final_content }, signal); return result;
  }
}
