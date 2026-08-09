function parseJson(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function collectText(value, output, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) output.push(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, output, depth + 1);
    return;
  }
  if (typeof value !== 'object') return;

  const priorityKeys = ['text', 'title', 'content', 'name', 'file_name'];
  const visited = new Set();
  for (const key of priorityKeys) {
    if (Object.hasOwn(value, key)) {
      collectText(value[key], output, depth + 1);
      visited.add(key);
    }
  }
  for (const [key, child] of Object.entries(value)) {
    if (visited.has(key) || ['tag', 'style', 'language'].includes(key) || /(?:_key|_id|url|token|secret)$/i.test(key)) continue;
    collectText(child, output, depth + 1);
  }
}

export function humanizeContent(messageType, rawContent) {
  if (typeof rawContent === 'string' && !rawContent.trim().startsWith('{') && !rawContent.trim().startsWith('[')) {
    return rawContent.trim();
  }
  const parsed = parseJson(rawContent);
  if (typeof parsed === 'string') return parsed.trim();
  // image_key/file_key are resource pointers scoped to this message and requiring bot auth
  // to resolve, so surfacing them here (unlike other *_key/*_url fields) is not a content
  // leak — see packages/daemon/agent/lark-message-formats.md for how to fetch each type.
  if (messageType === 'image' && typeof parsed?.image_key === 'string' && parsed.image_key) {
    return `[image image_key=${parsed.image_key}]`;
  }
  if (['file', 'audio', 'media', 'video', 'sticker'].includes(messageType)
    && typeof parsed?.file_key === 'string' && parsed.file_key) {
    const name = typeof parsed.file_name === 'string' && parsed.file_name ? ` file_name=${parsed.file_name}` : '';
    return `[${messageType} file_key=${parsed.file_key}${name}]`;
  }
  const parts = [];
  collectText(parsed, parts);
  const unique = [...new Set(parts)];
  if (unique.length > 0) return unique.join('\n').trim();
  if (['image', 'file', 'audio', 'media', 'video', 'sticker'].includes(messageType)) {
    return `[${messageType}]`;
  }
  return '';
}

function normalizeMentions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((mention) => {
    if (!mention || typeof mention !== 'object') return null;
    return {
      key: mention.key ?? null,
      name: mention.name ?? null,
      id: mention.id?.open_id ?? mention.id?.user_id ?? mention.open_id ?? mention.user_id ?? null,
    };
  }).filter(Boolean);
}

function valueOrNull(value) {
  return value === undefined || value === null || value === '' ? null : String(value);
}

export function normalizeEvent(input, profile = 'default') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('event must be a JSON object');
  }

  const isRaw = input.header && input.event;
  const header = isRaw ? input.header : {};
  const event = isRaw ? input.event : input;
  const message = isRaw ? event.message ?? {} : input;
  const sender = isRaw ? event.sender ?? {} : {};

  const type = valueOrNull(header.event_type ?? input.type ?? input.event_type);
  const messageId = valueOrNull(message.message_id ?? input.message_id ?? input.id);
  const eventId = valueOrNull(header.event_id ?? input.event_id);
  const chatId = valueOrNull(message.chat_id ?? input.chat_id);
  const chatType = valueOrNull(message.chat_type ?? input.chat_type) ?? 'unknown';
  const messageType = valueOrNull(message.message_type ?? input.message_type) ?? 'unknown';
  const senderId = valueOrNull(
    sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? input.sender_id,
  );
  const senderType = valueOrNull(sender.sender_type ?? input.sender_type);
  const rootId = valueOrNull(message.root_id ?? input.root_id);
  const parentId = valueOrNull(message.parent_id ?? input.parent_id);
  const threadId = valueOrNull(message.thread_id ?? input.thread_id);
  const threadRootId = threadId ? (rootId || (parentId && parentId !== messageId ? parentId : messageId)) : null;
  const tenantKey = valueOrNull(header.tenant_key ?? sender.tenant_key ?? input.tenant_key) ?? '-';
  const createTimeRaw = message.create_time ?? header.create_time ?? input.create_time ?? input.timestamp;
  const createTimeMs = Number.parseInt(String(createTimeRaw ?? Date.now()), 10);
  const rawContent = message.content ?? input.content ?? '';
  const content = humanizeContent(messageType, rawContent);
  const mentions = normalizeMentions(message.mentions ?? input.mentions);

  if (!type) throw new Error('event type is missing');
  if (!messageId) throw new Error('message_id is missing');
  if (!chatId) throw new Error('chat_id is missing');

  const scope = threadId ? `thread:${threadId}` : 'main';
  const conversationKey = `${profile}:${tenantKey}:${chatId}:${scope}`;

  return {
    type,
    eventId,
    messageId,
    chatId,
    chatType,
    messageType,
    senderId,
    senderType,
    rootId,
    parentId,
    threadId,
    threadRootId,
    tenantKey,
    conversationKey,
    content,
    mentions,
    createTimeMs: Number.isFinite(createTimeMs) ? createTimeMs : Date.now(),
    raw: input,
  };
}

export function deterministicFilter(event, config, now = Date.now()) {
  if (event.type !== 'im.message.receive_v1') return 'wrong_event_type';
  if (event.senderType === 'bot' || event.senderType === 'app') return 'bot_message';
  if (event.senderId && config.ignoredSenderIds.has(event.senderId)) return 'ignored_sender';
  if (!config.allowedMessageTypes.has(event.messageType)) return 'unsupported_message_type';
  if (!event.content.trim()) return 'empty_content';
  if (event.createTimeMs < now - config.maxEventAgeMs) return 'stale_event';
  return null;
}
