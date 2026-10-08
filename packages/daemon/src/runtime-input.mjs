import { lookupMemberName } from './roster.mjs';

// Runtime-neutral authenticated envelope shared by every adapter. Untrusted
// content stays on one physical line so it cannot forge metadata.

// The submit-item contract shared by every runtime backend: a text line with an
// optional inbound seq and delivery receipt id.
export function deliveryItem({ text, seq = null, receiptId }) {
  return receiptId === null || receiptId === undefined
    ? { text, seq }
    : { text, seq, receiptId };
}

export function receiptIds(items) {
  return [...new Set(items
    .map((item) => item.receiptId)
    .filter((receiptId) => receiptId !== null && receiptId !== undefined))];
}

export function withReceiptIds(fields, ids) {
  return ids.length > 0 ? { ...fields, receiptIds: ids } : fields;
}
export function shortenId(id) {
  if (!id) return 'unknown';
  const match = /^([a-z]{1,4}_)(.+)$/.exec(id);
  if (match) return match[1] + match[2].slice(0, 8);
  return String(id).slice(0, 11);
}

export function isoMinute(ms) {
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

function fromLabel(chatId, senderId, resolveName = null) {
  if (resolveName) {
    try {
      const resolved = resolveName(chatId, senderId);
      if (resolved) return resolved;
    } catch { /* fall through to the shared resolver / stub */ }
  }
  return lookupMemberName(chatId, senderId) ?? shortenId(senderId);
}

export function chatTag(chatId, threadId) {
  const chat = chatId || 'unknown';
  return threadId ? `${chat} thread=${shortenId(threadId)}` : chat;
}

export function oneLine(text) {
  return String(text ?? '')
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ⏎ ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

function renderInboundContent(message) {
  let content = String(message.content ?? '');
  for (const mention of message.mentions ?? []) {
    if (typeof mention?.key !== 'string' || !mention.key) continue;
    const label = oneLine(mention.name).trim() || shortenId(mention.id);
    content = content.split(mention.key).join(`@${label}`);
  }
  return oneLine(content);
}

export function formatInboundLine(message, resolveName = null, authenticated = {}) {
  const idleForMs = Number(authenticated?.idleForMs);
  const idleTag = Number.isFinite(idleForMs) && idleForMs >= 0
    ? ` idle=${Math.max(1, Math.floor(idleForMs / 1_000))}s`
    : '';
  const replyTo = authenticated?.replyTo;
  const replyTag = replyTo
    ? ` reply_to=${replyTo.kind === 'me'
      ? 'me'
      : replyTo.kind === 'user'
        ? fromLabel(replyTo.chatId ?? message.chatId, replyTo.senderId, resolveName)
        : shortenId(replyTo.id)}`
    : '';
  return `[chat=${chatTag(message.chatId, message.threadId)} msg=${message.messageId}`
    + ` time=${isoMinute(message.createTimeMs)} from=${fromLabel(message.chatId, message.senderId, resolveName)}`
    + `${replyTag}${idleTag}] ${renderInboundContent(message)}`;
}

// A quote-reply's target, resolved from local history: 'me' when the sender
// quoted one of the bot's own messages (a strong addressing signal). Plain
// thread membership (parent == thread root) is not a quote and stays untagged.
export function resolveReplyTarget(store, message) {
  const parentId = message.parentId;
  if (!parentId || parentId === message.messageId) return null;
  if (message.threadRootId && parentId === message.threadRootId) return null;
  const author = store.resolveMessageAuthor?.(parentId);
  return author ?? { kind: 'unknown', id: parentId };
}

export function formatHistoryLine(item, resolveName = null) {
  const from = item.direction === 'outbound' ? 'me' : fromLabel(item.chatId, item.actor, resolveName);
  return `[chat=${chatTag(item.chatId, item.threadId)} time=${isoMinute(item.atMs)} from=${from}] ${oneLine(item.text)}`;
}
