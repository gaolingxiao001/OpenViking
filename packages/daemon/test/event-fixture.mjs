import { normalizeEvent } from '../src/event.mjs';
import { eventMessage } from '../src/connectors/protocol.mjs';

// A non-chat event about one subject, as a calendar or issue Connector sends it.
export function subjectEvent(fields = {}) {
  const source = fields.source ?? 'calendar';
  return normalizeEvent(eventMessage(source, {
    instance: fields.instance ?? source,
    id: fields.eventId ?? 'reminder-1',
    kind: fields.kind ?? 'calendar.event.reminder', occurred_at: fields.createTimeMs ?? Date.now(),
    subject: { type: fields.subjectType ?? 'calendar_event', id: fields.subjectId ?? 'evt_42' },
    content: { title: fields.title ?? '1:1 in 10 minutes', text: '' },
  }));
}

export function chatEvent(fields = {}) {
  const source = fields.source ?? 'lark';
  const messageId = fields.messageId ?? 'om-test';
  const chatId = fields.chatId ?? 'oc-chat';
  const event = normalizeEvent(eventMessage(source, {
    instance: fields.connectorInstance ?? source,
    id: fields.eventId ?? `message:${messageId}`,
    kind: fields.kind ?? 'message.created', occurred_at: fields.createTimeMs ?? Date.now(),
    subject: { type: 'conversation', id: chatId },
    actor: { type: fields.senderType ?? 'user', id: fields.senderId ?? 'ou-user' },
    content: { text: fields.content ?? 'hello' },
    conversation: { id: chatId, type: fields.chatType ?? 'p2p',
      tenant_id: fields.tenantKey ?? 'tenant', thread_id: fields.threadId ?? null },
    message: { id: messageId, type: fields.messageType ?? 'text',
      root_id: fields.rootId ?? null, parent_id: fields.parentId ?? null,
      thread_root_id: fields.threadRootId ?? null, mentions: fields.mentions ?? [] },
    reply_route: fields.replyRoute === null ? null : { action: 'message.reply', input: { message_id: messageId } },
  }));
  return { ...event, ...(fields.seq == null ? {} : { seq: fields.seq }) };
}
