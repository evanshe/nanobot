import compaction from './compaction-text.json' with { type: 'json' };
import { isEventKind } from './events.ts';
import type { AgentEvent, Metadata, OutboundMessage } from './events.ts';
function localeCode(value: string): string {
  const tag = value.split('.')[0].split('@')[0].toLowerCase().replaceAll('_', '-');
  const parts = tag.split('-'), base = parts[0];
  if (base === 'zh') return parts.some(part => ['tw', 'hk', 'mo', 'hant'].includes(part)) ? 'zh-TW' : 'zh-CN';
  return base === 'pt' ? 'pt-BR' : base;
}
function eventContent(event: AgentEvent, locale: unknown): string {
  if (isEventKind(event, 'progress') || isEventKind(event, 'retry_wait') || isEventKind(event, 'stream_delta') || isEventKind(event, 'stream_end') || isEventKind(event, 'user_input')) return event.content;
  if (isEventKind(event, 'context_compaction')) {
    const tag = typeof locale === 'string' && locale ? locale : process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || 'en';
    const translations: Record<string, string> = compaction[event.phase];
    return translations[localeCode(tag)] ?? translations.en;
  }
  return '';
}
export function outboundMessageForEvent(event: AgentEvent, channel: string, chatId: string, metadata: Metadata = {}, content?: string): OutboundMessage {
  return { channel, chatId, content: content ?? eventContent(event, metadata.locale), metadata: { ...metadata }, event };
}
export function replaceOutboundEvent(message: OutboundMessage, event: AgentEvent, content?: string): OutboundMessage {
  return { ...message, content: content ?? eventContent(event, message.metadata.locale), event };
}
