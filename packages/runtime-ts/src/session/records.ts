import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ConfigObject, Json } from '../config/decoder.ts';
import { object } from '../config/decoder.ts';
export type SessionMessage = ConfigObject;
export type ProviderConversationState = {
  kind: string; provider: string; model: string; version: number;
  payload: ConfigObject; pending_messages: SessionMessage[];
};
export type SessionPolicy = Readonly<{ persist: boolean; logContent: boolean; disabledTools: readonly string[] }>;
export const DEFAULT_SESSION_POLICY: SessionPolicy = Object.freeze({ persist: true, logContent: true, disabledTools: Object.freeze([]) });
export type SessionRecord = {
  key: string; messages: SessionMessage[]; createdAt: string; updatedAt: string;
  metadata: ConfigObject; providerState: ProviderConversationState | null;
  lastArchived: number; revision: number; generation: string; persisted: boolean;
  policy: SessionPolicy; consumedFollowupIds: readonly string[];
};
export class SessionConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'SessionConflictError'; }
}
export function localTimestamp(date = new Date()): string {
  const pad = (value: number, length = 2) => String(value).padStart(length, '0');
  const time = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return date.getMilliseconds() ? `${time}.${pad(date.getMilliseconds(), 3)}000` : time;
}
export function newSession(key: string): SessionRecord {
  const now = localTimestamp();
  return { key, messages: [], createdAt: now, updatedAt: now, metadata: {}, providerState: null,
    lastArchived: 0, revision: 0, generation: randomUUID().replaceAll('-', ''), persisted: false, policy: DEFAULT_SESSION_POLICY, consumedFollowupIds: [] };
}
export function addSessionMessage(session: SessionRecord, role: string, content: Json, extra: ConfigObject = {}): void {
  session.messages.push({ role, content, timestamp: localTimestamp(), ...structuredClone(extra) }); session.updatedAt = localTimestamp();
}
export function parseObject(record: unknown): ConfigObject {
  if (typeof record !== 'string') throw new TypeError('stored session record must be JSON text');
  const value: unknown = JSON.parse(record);
  if (!object(value)) throw new TypeError('stored session record must be an object');
  return value;
}
export function encodeJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new TypeError('Session JSON numbers must be finite');
    if (item === undefined || typeof item === 'bigint' || typeof item === 'function' || typeof item === 'symbol') throw new TypeError('Session value is not JSON serializable');
    return item;
  });
}
export function providerState(value: ConfigObject): ProviderConversationState | null {
  const { kind, provider, model, version, payload } = value;
  const pending = value.pending_messages ?? [];
  if (typeof kind !== 'string' || !kind || typeof provider !== 'string' || !provider || typeof model !== 'string' || !model || typeof version !== 'number' || !Number.isInteger(version) || !object(payload) || !Array.isArray(pending) || !pending.every(object)) return null;
  return { kind, provider, model, version, payload, pending_messages: pending };
}
export function equal(a: unknown, b: unknown): boolean {
  if (isDeepStrictEqual(a, b, { skipPrototype: true })) return true;
  // Python compares JSON booleans as integers. Draft conflict/merge decisions
  // must retain that behavior even though the persisted JSON types stay intact.
  if ((typeof a === 'boolean' || typeof a === 'number') && (typeof b === 'boolean' || typeof b === 'number')) return Number(a) === Number(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => equal(value, b[index]));
  const plain = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && [null, Object.prototype].includes(Object.getPrototypeOf(value));
  if (plain(a) && plain(b)) return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => Object.hasOwn(b, key) && equal(a[key], b[key]));
  return false;
}
export function publicHistoryMessage(message: SessionMessage): SessionMessage {
  const cleaned = structuredClone(message), marker = cleaned._runtime_context;
  delete cleaned._runtime_context;
  if (!object(marker) || marker.version !== 1) return cleaned;
  const content = cleaned.content, suffix = marker.suffix;
  if (typeof content === 'string' && typeof suffix === 'string' && suffix) {
    if (content === suffix) cleaned.content = '';
    else if (content.endsWith(`\n\n${suffix}`)) cleaned.content = content.slice(0, -(suffix.length + 2));
  } else if (Array.isArray(content) && Array.isArray(marker.blocks) && marker.blocks.length && equal(content.slice(-marker.blocks.length), marker.blocks)) cleaned.content = content.slice(0, -marker.blocks.length);
  return cleaned;
}
export function hiddenHistory(message: SessionMessage): boolean {
  return message._hidden_history === true || object(message._hidden_history) || message._automation_turn === true || object(message._automation_turn) || message._cron_turn === true;
}
export function textContent(value: Json | undefined): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.filter(object).filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
}
export function messagePreview(message: SessionMessage): string {
  const content = publicHistoryMessage(message).content;
  let text = textContent(content);
  if (message.injected_event === 'subagent_result' && typeof content === 'string') {
    const stripped = content.replaceAll('\r\n', '\n').trim(), header = stripped.split('\n')[0].startsWith('[Subagent') ? stripped.split('\n')[0].trim() : '';
    const lower = stripped.toLowerCase(); let index = lower.indexOf('\nresult:\n'), length = 9;
    if (index < 0) { index = lower.indexOf('\nresult:'); length = 8; }
    if (index < 0) text = header || stripped;
    else {
      let body = stripped.slice(index + length).trimStart(); const summarize = body.toLowerCase().indexOf('summarize this naturally');
      if (summarize >= 0) body = body.slice(0, summarize).trimEnd();
      const chars = [...body.trim()]; if (chars.length > 800) body = `${chars.slice(0, 799).join('').trimEnd()}…`;
      text = header && body ? `${header}\n\n${body}` : header || body || stripped;
    }
  }
  text = text.replace(/[\s\u0085\u001c-\u001f]+/gu, ' ').trim(); const chars = [...text];
  return chars.length > 120 ? `${chars.slice(0, 119).join('').trimEnd()}…` : text;
}
export function stripThink(value: string): string {
  const tag = '(?:thinking|thought|think)';
  let text = value.replace(/<(?<tag>thinking|thought|think)>[\s\S]*?<\/\k<tag>>/g, '');
  text = text.replace(new RegExp(`^\\s*<${tag}>[\\s\\S]*$`), '').replace(/^\s*<thinking\/>\s*/, '').replace(/\s*<thinking\/>\s*$/, '');
  text = text.replace(new RegExp(`<${tag}(?![A-Za-z0-9_\\-:>/])`, 'g'), '').replace(new RegExp(`^\\s*</${tag}>\\s*`), '').replace(new RegExp(`\\s*</${tag}>\\s*$`), '');
  text = text.replace(/^\s*<\|?channel\|?>\s*/, '');
  const prefixes = [...new Set(['think', 'thinking', 'thought'].flatMap(tag => Array.from({ length: tag.length }, (_, i) => tag.slice(0, i + 1))))].sort((a, b) => b.length - a.length).join('|');
  return text.replace(new RegExp(`(?:</?(?:${prefixes})>?|<\\|?(?:c|ch|cha|chan|chann|channe|channel)(?:\\|?>?)?)$`), '').replace(/^\s*<\|?$/, '').trim();
}
export function metadataTitle(metadata: ConfigObject): string {
  return typeof metadata.title === 'string' ? metadata.title_user_edited === true ? metadata.title : stripThink(metadata.title) : '';
}
