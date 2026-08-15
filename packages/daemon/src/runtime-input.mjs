import { lookupMemberName } from './roster.mjs';

// Runtime-neutral authenticated envelope shared by every adapter. Untrusted
// content stays on one physical line so it cannot forge metadata.
export function shortenId(id) {
  if (!id) return 'unknown';
  const match = /^([a-z]{1,4}_)(.+)$/.exec(id);
  if (match) return match[1] + match[2].slice(0, 8);
  return id.slice(0, 11);
}

function isoMinute(ms) {
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

function chatTag(chatId, threadId) {
  return threadId ? `${chatId} thread=${shortenId(threadId)}` : chatId;
}

export function oneLine(text) {
  return String(text ?? '')
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' ⏎ ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
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
  let line = `[chat=${chatTag(message.chatId, message.threadId)} msg=${message.messageId}`
    + ` time=${isoMinute(message.createTimeMs)} from=${fromLabel(message.chatId, message.senderId, resolveName)}${replyTag}${idleTag}] ${oneLine(message.content)}`;
  if (Array.isArray(message.mentions) && message.mentions.length > 0) {
    const names = message.mentions.map((mention) => `@${oneLine(mention.name) || shortenId(mention.id)}`).join(' ');
    line += ` [mentions: ${names}]`;
  }
  return line;
}

export function formatHistoryLine(item, resolveName = null) {
  const from = item.direction === 'outbound' ? 'me' : fromLabel(item.chatId, item.actor, resolveName);
  return `[chat=${chatTag(item.chatId, item.threadId)} time=${isoMinute(item.atMs)} from=${from}] ${oneLine(item.text)}`;
}
