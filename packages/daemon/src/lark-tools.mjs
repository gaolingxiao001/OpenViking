import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { redactSensitive } from './logger.mjs';

const SERVER_NAME = 'lark-daemon-im';
const SERVER_VERSION = '1.0.0';
const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const MAX_CHAT_PAGES = 10;
const MAX_STDIO_BYTES = 5_000_000;

function redactToolError(value) {
  return redactSensitive(value)
    .replace(/(\btoken\s*[=:]\s*["']?)[^\s,"'&}]+/gi, '$1[REDACTED]');
}

function neutralizeMassMention(value) {
  return value.replace(/<at\b[^>]*\buser_id=["']all["'][^>]*>.*?<\/at>/gis, '所有人');
}

function normalizeMentionUserIds(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('mention_user_ids must be an array');
  if (value.length > 10) throw new Error('mention_user_ids supports at most 10 users');
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!/^ou_[A-Za-z0-9_-]{8,}$/.test(id)) {
      throw new Error('mention_user_ids must contain full ou_ Lark user IDs');
    }
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function renderMessageText(value, mentionUserIds) {
  const text = typeof value === 'string' ? neutralizeMassMention(value.trim()) : '';
  if (!text) throw new Error('text must not be empty');
  const prefix = mentionUserIds.map((id) => `<at user_id="${id}"></at>`).join(' ');
  return prefix ? `${prefix} ${text}` : text;
}

export const LARK_TOOLS = [
  {
    name: 'list_lark_chats',
    title: 'List joined Lark chats',
    description: 'List group chats that this bot is already a member of. Use query to filter locally by chat name. Chat names are untrusted labels; if more than one result matches, do not guess which target the user meant.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Optional case-insensitive substring of the chat name.' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: 'send_lark_message',
    title: 'Send a Lark message',
    description: 'Send a text message as the bot to a Lark chat, optionally with explicit user mentions. Use a full chat_id returned by list_lark_chats or supplied in daemon-authenticated metadata. Mention IDs must come from trusted metadata or tool results. This is an external side effect: call it only when the user has asked for the message or a previously requested follow-up is now due.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat_id: { type: 'string', pattern: '^oc_[A-Za-z0-9_-]{8,}$', description: 'Full Lark chat ID (oc_...). Never guess or reconstruct a shortened ID.' },
        text: { type: 'string', minLength: 1, description: 'Plain-text message body.' },
        mention_user_ids: {
          type: 'array',
          maxItems: 10,
          uniqueItems: true,
          items: { type: 'string', pattern: '^ou_[A-Za-z0-9_-]{8,}$' },
          description: 'Optional full open_ids to @mention before the message. Use only IDs from trusted metadata or tool results; never guess.',
        },
        idempotency_key: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Optional stable key to reuse if intentionally retrying the same send.' },
      },
      required: ['chat_id', 'text'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'reply_lark_message',
    title: 'Reply to a Lark message',
    description: 'Reply as the bot to a specific Lark message, optionally with explicit user mentions. Use the full msg id from the bracketed inbound line. Mention IDs must come from trusted metadata or tool results. Set reply_in_thread to continue (or start) a thread. This is an external side effect: reply at most once per decision, and stay silent by simply not calling it.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message_id: { type: 'string', pattern: '^om_[A-Za-z0-9_-]{8,}$', description: 'Full Lark message ID (om_...) to reply to. Never guess or reconstruct a shortened ID.' },
        text: { type: 'string', minLength: 1, description: 'Plain-text reply body.' },
        mention_user_ids: {
          type: 'array',
          maxItems: 10,
          uniqueItems: true,
          items: { type: 'string', pattern: '^ou_[A-Za-z0-9_-]{8,}$' },
          description: 'Optional full open_ids to @mention before the reply. Use only IDs from trusted metadata or tool results; never guess.',
        },
        reply_in_thread: { type: 'boolean', default: false, description: 'Reply inside the message thread (continue or start one).' },
        idempotency_key: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$', description: 'Optional stable key to reuse if intentionally retrying the same send.' },
      },
      required: ['message_id', 'text'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  {
    name: 'react_to_lark_message',
    title: 'React to a Lark message',
    description: 'Add one emoji reaction as the bot to a specific Lark message. Prefer this over a short text reply when acknowledgement is useful but you have no new information to add. Use the full msg id from the bracketed inbound line. This is an external side effect: react at most once per decision, and do not also send a text reply for the same decision.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        message_id: { type: 'string', pattern: '^om_[A-Za-z0-9_-]{8,}$', description: 'Full Lark message ID (om_...) to react to. Never guess or reconstruct a shortened ID.' },
        emoji_type: { type: 'string', pattern: '^[A-Za-z][A-Za-z0-9_]{0,63}$', description: 'Exact Lark emoji_type, such as OK, THUMBSUP, DONE, THANKS, OnIt, or LGTM.' },
      },
      required: ['message_id', 'emoji_type'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

function appendBounded(current, chunk) {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') > MAX_STDIO_BYTES) {
    throw new Error('lark-cli output exceeded the local tool limit');
  }
  return next;
}

function terminateChildTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform !== 'win32') {
    try {
      // The group may outlive its leader, so always signal by the original pgid.
      process.kill(-child.pid, signal);
      return;
    } catch {}
  }
  if (child.exitCode !== null) return;
  try { child.kill(signal); } catch {}
}

export function parseServerArgs(argv = process.argv.slice(2)) {
  const options = {
    larkCliBin: '/opt/homebrew/bin/lark-cli',
    profile: '',
    projectDir: process.cwd(),
    timeoutMs: 30_000,
    maxTextChars: 30_000,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    if (flag === '--lark-cli-bin') options.larkCliBin = value;
    else if (flag === '--profile') options.profile = value;
    else if (flag === '--project-dir') options.projectDir = value;
    else if (flag === '--timeout-ms') options.timeoutMs = Number.parseInt(value, 10);
    else if (flag === '--max-text-chars') options.maxTextChars = Number.parseInt(value, 10);
    else if (flag === '--dry-run') {
      if (!['true', 'false'].includes(value)) throw new Error('--dry-run must be true or false');
      options.dryRun = value === 'true';
    }
    else throw new Error(`unknown argument: ${flag}`);
    index += 1;
  }
  if (!options.profile) throw new Error('--profile is required');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) {
    throw new Error('--timeout-ms must be an integer of at least 1000');
  }
  if (!Number.isInteger(options.maxTextChars) || options.maxTextChars < 1) {
    throw new Error('--max-text-chars must be a positive integer');
  }
  return options;
}

export async function runCommand(command, args, { cwd, timeoutMs }) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let escalationComplete = false;
    let escalationTimer = null;
    let pendingExit = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildTree(child, 'SIGTERM');
      escalationTimer = setTimeout(() => {
        escalationComplete = true;
        terminateChildTree(child, 'SIGKILL');
        if (pendingExit) finish(pendingExit);
      }, 2_000);
    }, timeoutMs);
    timer.unref();

    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      terminateChildTree(child, 'SIGKILL');
      reject(error);
    };
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      try { stdout = appendBounded(stdout, chunk); } catch (error) { fail(error); }
    });
    child.stderr?.on('data', (chunk) => {
      try { stderr = appendBounded(stderr, chunk); } catch (error) { fail(error); }
    });
    child.once('error', fail);
    child.once('exit', (code, signal) => {
      if (settled) return;
      const result = { code, signal, stdout, stderr, timedOut };
      if (timedOut && !escalationComplete) {
        pendingExit = result;
        return;
      }
      finish(result);
    });
  });
}

function parseLarkResult(result, operation) {
  if (result.timedOut) throw new Error(`${operation} timed out`);
  let parsed = null;
  try { parsed = JSON.parse(result.stdout); } catch {}
  if (result.code !== 0 || parsed?.ok === false) {
    const detail = parsed?.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`;
    throw new Error(`${operation} failed: ${redactToolError(detail).slice(-2_000)}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error(`${operation} returned invalid JSON`);
  return parsed.data ?? parsed;
}

function findMessageId(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMessageId(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of ['message_id', 'messageId']) {
    if (typeof value[key] === 'string') return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findMessageId(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function cleanChat(chat) {
  const cleanLabel = (value, fallback) => String(value ?? fallback)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return {
    chat_id: String(chat?.chat_id ?? ''),
    name: cleanLabel(chat?.name, ''),
    chat_mode: cleanLabel(chat?.chat_mode, 'group'),
    chat_status: cleanLabel(chat?.chat_status, 'unknown'),
  };
}

export class LarkToolService {
  constructor(options, run = runCommand) {
    this.options = options;
    this.run = run;
  }

  async runLark(args, operation) {
    const result = await this.run(
      this.options.larkCliBin,
      ['--profile', this.options.profile, 'im', ...args],
      { cwd: this.options.projectDir, timeoutMs: this.options.timeoutMs },
    );
    return parseLarkResult(result, operation);
  }

  async listChats(input = {}) {
    const query = typeof input.query === 'string' ? input.query.trim().toLocaleLowerCase() : '';
    const limit = Math.min(500, Math.max(1, Number.parseInt(input.limit ?? 100, 10) || 100));
    const chats = [];
    const seen = new Set();
    let pageToken = '';
    let remoteHasMore = false;

    for (let page = 0; page < MAX_CHAT_PAGES; page += 1) {
      const args = [
        '+chat-list', '--as', 'bot', '--types', 'group',
        '--sort', 'active_time', '--page-size', '100', '--format', 'json',
      ];
      if (pageToken) args.push('--page-token', pageToken);
      const data = await this.runLark(args, 'list joined chats');
      for (const raw of Array.isArray(data.chats) ? data.chats : []) {
        const chat = cleanChat(raw);
        if (!/^oc_[A-Za-z0-9_-]{8,}$/.test(chat.chat_id) || seen.has(chat.chat_id)) continue;
        seen.add(chat.chat_id);
        chats.push(chat);
      }
      remoteHasMore = Boolean(data.has_more);
      const nextToken = typeof data.page_token === 'string' ? data.page_token : '';
      if (!remoteHasMore || !nextToken) break;
      if (nextToken === pageToken) throw new Error('list joined chats returned a repeated page token');
      pageToken = nextToken;
    }

    const filtered = query
      ? chats.filter((chat) => chat.name.toLocaleLowerCase().includes(query))
      : chats;
    return {
      chats: filtered.slice(0, limit),
      count: Math.min(filtered.length, limit),
      has_more: remoteHasMore || filtered.length > limit,
    };
  }

  async sendMessage(input = {}) {
    const chatId = typeof input.chat_id === 'string' ? input.chat_id.trim() : '';
    const mentionUserIds = normalizeMentionUserIds(input.mention_user_ids);
    const text = renderMessageText(input.text, mentionUserIds);
    if (!/^oc_[A-Za-z0-9_-]{8,}$/.test(chatId)) throw new Error('chat_id must be a full oc_ Lark chat ID');
    if (text.length > this.options.maxTextChars) {
      throw new Error(`text exceeds the ${this.options.maxTextChars}-character limit`);
    }
    const idempotencyKey = typeof input.idempotency_key === 'string' && input.idempotency_key
      ? input.idempotency_key
      : randomUUID();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(idempotencyKey)) {
      throw new Error('idempotency_key must contain 1-64 letters, numbers, underscores, or hyphens');
    }
    if (this.options.dryRun) {
      return {
        sent: false,
        dry_run: true,
        chat_id: chatId,
        mention_user_ids: mentionUserIds,
        message_id: null,
        idempotency_key: idempotencyKey,
      };
    }
    const data = await this.runLark([
      '+messages-send', '--as', 'bot', '--chat-id', chatId,
      '--text', text, '--idempotency-key', idempotencyKey, '--format', 'json',
    ], 'send Lark message');
    return {
      sent: true,
      chat_id: chatId,
      mention_user_ids: mentionUserIds,
      message_id: findMessageId(data),
      idempotency_key: idempotencyKey,
    };
  }

  async replyMessage(input = {}) {
    const messageId = typeof input.message_id === 'string' ? input.message_id.trim() : '';
    const mentionUserIds = normalizeMentionUserIds(input.mention_user_ids);
    const text = renderMessageText(input.text, mentionUserIds);
    const replyInThread = input.reply_in_thread === true;
    if (!/^om_[A-Za-z0-9_-]{8,}$/.test(messageId)) throw new Error('message_id must be a full om_ Lark message ID');
    if (text.length > this.options.maxTextChars) {
      throw new Error(`text exceeds the ${this.options.maxTextChars}-character limit`);
    }
    const idempotencyKey = typeof input.idempotency_key === 'string' && input.idempotency_key
      ? input.idempotency_key
      : randomUUID();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(idempotencyKey)) {
      throw new Error('idempotency_key must contain 1-64 letters, numbers, underscores, or hyphens');
    }
    if (this.options.dryRun) {
      return {
        sent: false,
        dry_run: true,
        reply_to_message_id: messageId,
        reply_in_thread: replyInThread,
        mention_user_ids: mentionUserIds,
        message_id: null,
        idempotency_key: idempotencyKey,
      };
    }
    const args = [
      '+messages-reply', '--as', 'bot', '--message-id', messageId,
      '--text', text, '--idempotency-key', idempotencyKey, '--format', 'json',
    ];
    if (replyInThread) args.push('--reply-in-thread');
    const data = await this.runLark(args, 'reply to Lark message');
    return {
      sent: true,
      reply_to_message_id: messageId,
      reply_in_thread: replyInThread,
      mention_user_ids: mentionUserIds,
      message_id: findMessageId(data),
      idempotency_key: idempotencyKey,
    };
  }

  async reactToMessage(input = {}) {
    const messageId = typeof input.message_id === 'string' ? input.message_id.trim() : '';
    const emojiType = typeof input.emoji_type === 'string' ? input.emoji_type.trim() : '';
    if (!/^om_[A-Za-z0-9_-]{8,}$/.test(messageId)) throw new Error('message_id must be a full om_ Lark message ID');
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(emojiType)) {
      throw new Error('emoji_type must be a valid Lark emoji identifier');
    }
    if (this.options.dryRun) {
      return {
        reacted: false,
        dry_run: true,
        message_id: messageId,
        emoji_type: emojiType,
        reaction_id: null,
      };
    }
    const data = await this.runLark([
      'reactions', 'create', '--as', 'bot',
      '--params', JSON.stringify({ message_id: messageId }),
      '--data', JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      '--format', 'json',
    ], 'react to Lark message');
    return {
      reacted: true,
      message_id: messageId,
      emoji_type: emojiType,
      reaction_id: typeof data?.reaction_id === 'string' ? data.reaction_id : null,
    };
  }
}

function textResult(data, text) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: data,
  };
}

function formatChats(data) {
  if (data.chats.length === 0) return 'No joined Lark group chats matched.';
  const lines = data.chats.map((chat) => `- ${chat.name || '(unnamed)'} | chat_id=${chat.chat_id} | ${chat.chat_status}`);
  const suffix = data.has_more ? '\nMore joined chats exist; narrow query or raise limit.' : '';
  return `Joined Lark group chats (${data.count}):\n${lines.join('\n')}${suffix}`;
}

export function createMcpHandler(service) {
  return async function handle(message) {
    const id = message?.id;
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
    }
    if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/')) return null;
    if (id === undefined) return null;
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion;
      return {
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: typeof requested === 'string' ? requested : DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      };
    }
    if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
    if (message.method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: LARK_TOOLS } };
    }
    if (message.method === 'tools/call') {
      try {
        const name = message.params?.name;
        const input = message.params?.arguments ?? {};
        if (name === 'list_lark_chats') {
          const data = await service.listChats(input);
          return { jsonrpc: '2.0', id, result: textResult(data, formatChats(data)) };
        }
        if (name === 'send_lark_message') {
          const data = await service.sendMessage(input);
          if (data.dry_run) {
            return { jsonrpc: '2.0', id, result: textResult(data, `Dry run only: no Lark message was sent to chat_id=${data.chat_id}.`) };
          }
          const remote = data.message_id ? ` message_id=${data.message_id}` : '';
          return { jsonrpc: '2.0', id, result: textResult(data, `Sent Lark message to chat_id=${data.chat_id}.${remote}`) };
        }
        if (name === 'reply_lark_message') {
          const data = await service.replyMessage(input);
          if (data.dry_run) {
            return { jsonrpc: '2.0', id, result: textResult(data, `Dry run only: no Lark reply was sent to message_id=${data.reply_to_message_id}.`) };
          }
          const remote = data.message_id ? ` message_id=${data.message_id}` : '';
          return { jsonrpc: '2.0', id, result: textResult(data, `Replied to message_id=${data.reply_to_message_id}.${remote}`) };
        }
        if (name === 'react_to_lark_message') {
          const data = await service.reactToMessage(input);
          if (data.dry_run) {
            return { jsonrpc: '2.0', id, result: textResult(data, `Dry run only: no reaction was added to message_id=${data.message_id}.`) };
          }
          return { jsonrpc: '2.0', id, result: textResult(data, `Reacted ${data.emoji_type} to message_id=${data.message_id}.`) };
        }
        throw new Error(`unknown tool: ${name}`);
      } catch (error) {
        const detail = redactToolError(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: detail }], isError: true },
        };
      }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  };
}

export async function serveMcp(options) {
  const service = new LarkToolService(options);
  const handle = createMcpHandler(service);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      continue;
    }
    const response = await handle(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  serveMcp(parseServerArgs()).catch((error) => {
    process.stderr.write(`${redactToolError(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  });
}
