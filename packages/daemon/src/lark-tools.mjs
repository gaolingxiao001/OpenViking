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
    description: 'Send a plain-text message as the bot to a Lark chat. Use a full chat_id returned by list_lark_chats or supplied in daemon-authenticated metadata. This is an external side effect: call it only when the user has asked for the message or a previously requested follow-up is now due.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chat_id: { type: 'string', pattern: '^oc_[A-Za-z0-9_-]{8,}$', description: 'Full Lark chat ID (oc_...). Never guess or reconstruct a shortened ID.' },
        text: { type: 'string', minLength: 1, description: 'Plain-text message body.' },
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
    const text = typeof input.text === 'string' ? neutralizeMassMention(input.text.trim()) : '';
    if (!/^oc_[A-Za-z0-9_-]{8,}$/.test(chatId)) throw new Error('chat_id must be a full oc_ Lark chat ID');
    if (!text) throw new Error('text must not be empty');
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
      message_id: findMessageId(data),
      idempotency_key: idempotencyKey,
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
