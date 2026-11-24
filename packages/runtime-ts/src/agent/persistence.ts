import { object } from '../config/decoder.ts';
import type { ConfigObject, Json } from '../config/decoder.ts';
import { equal, localTimestamp } from '../session/records.ts';
import type { SessionRecord } from '../session/records.ts';
import { persistedMessage } from '../session/recovery.ts';
import { persistUserImages } from './history.ts';
export async function persistAgentMessages(session: SessionRecord, messages: readonly ConfigObject[], options: { dataDirectory: string; latencyMs?: number; storeImages?: boolean } ): Promise<number[]> {
  const declared = new Set<string>(), fulfilled = new Set<string>(), boundaries: number[] = [];
  for (const row of session.messages) {
    if (row.role === 'assistant' && Array.isArray(row.tool_calls)) for (const call of row.tool_calls) if (object(call) && call.id) declared.add(String(call.id));
    if (row.role === 'tool' && row.tool_call_id) fulfilled.add(String(row.tool_call_id));
  }
  let lastAssistant = -1;
  for (const raw of messages) {
    boundaries.push(session.messages.length); const entry = structuredClone(persistedMessage(raw)), followupId = entry._recovery_followup_id; delete entry._recovery_followup_id;
    if (entry.role === 'assistant' && !entry.content && !(Array.isArray(entry.tool_calls) && entry.tool_calls.length)) continue;
    if (entry.role === 'tool') {
      const id = entry.tool_call_id ? String(entry.tool_call_id) : ''; if (!id || !declared.has(id) || fulfilled.has(id)) continue; fulfilled.add(id);
      if (Array.isArray(entry.content)) {
        const filtered: Json[] = [];
        for (const block of entry.content) {
          if (object(block) && block.type === 'image_url' && object(block.image_url) && String(block.image_url.url || '').startsWith('data:image/')) {
            const path = object(block._meta) && typeof block._meta.path === 'string' ? block._meta.path : '', replacement = { type: 'text', text: path ? `[image: ${path}]` : '[image]' };
            if (!equal(filtered.at(-1), replacement)) filtered.push(replacement);
          } else filtered.push(block);
        }
        entry.content = filtered.length ? filtered : [{ type: 'text', text: '[tool result omitted during persistence]' }];
      }
    } else if (entry.role === 'user' && Array.isArray(entry.content)) {
      if (!entry.content.length) continue;
      if (options.storeImages !== false && session.policy.persist) entry.content = await persistUserImages(entry.content, options.dataDirectory);
    }
    if (!Object.hasOwn(entry, 'timestamp')) entry.timestamp = localTimestamp(); session.messages.push(entry);
    if (entry.role === 'user' && typeof followupId === 'string' && followupId) session.consumedFollowupIds = [...new Set([...session.consumedFollowupIds, followupId])];
    if (entry.role === 'assistant') {
      lastAssistant = session.messages.length - 1;
      if (Array.isArray(entry.tool_calls)) for (const call of entry.tool_calls) if (object(call) && call.id) declared.add(String(call.id));
    }
  }
  boundaries.push(session.messages.length);
  if (options.latencyMs !== undefined && lastAssistant >= 0) session.messages[lastAssistant].latency_ms = Math.trunc(options.latencyMs);
  session.updatedAt = localTimestamp(); return boundaries;
}
