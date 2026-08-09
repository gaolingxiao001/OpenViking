import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { terminateProcessTree } from './process-utils.mjs';

function findChatName(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findChatName(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (typeof value.name === 'string' && value.name.trim()) return value.name.trim();
  for (const child of Object.values(value)) {
    const found = findChatName(child, depth + 1);
    if (found) return found;
  }
  return null;
}

export class LarkClient {
  constructor(config, registry, logger) {
    this.config = config;
    this.registry = registry;
    this.logger = logger;
    this.subscriber = null;
    this.stopping = false;
    this.profile = config.profile || null;
  }

  async preflight() {
    if (!this.profile) {
      const listed = await this.registry.run(this.config.larkCliBin, ['profile', 'list'], {
        timeoutMs: 10_000,
      });
      if (listed.code !== 0) throw new Error('lark-cli profile list failed');
      let profiles;
      try { profiles = JSON.parse(listed.stdout); } catch {}
      const active = Array.isArray(profiles) ? profiles.filter((profile) => profile?.active) : [];
      if (active.length !== 1 || typeof active[0].name !== 'string' || !active[0].name) {
        throw new Error('lark-cli must have exactly one active profile, or set LARK_DAEMON_PROFILE');
      }
      this.profile = active[0].name;
    }
    const prefix = ['--profile', this.profile];
    const checks = [
      { args: ['event', '+subscribe', '--help'], required: ['--event-types', '--quiet'] },
      { args: ['im', '--help'], required: ['+chat-list', '+messages-reply', '+messages-send'] },
    ];
    const outputs = [];
    for (const check of checks) {
      const result = await this.registry.run(this.config.larkCliBin, [...prefix, ...check.args], {
        timeoutMs: 10_000,
      });
      const text = `${result.stdout}\n${result.stderr}`;
      const missing = check.required.filter((flag) => !text.includes(flag));
      if (result.code !== 0 || missing.length > 0) {
        throw new Error(`lark-cli preflight failed for ${check.args.join(' ')}${missing.length ? `; missing ${missing.join(', ')}` : ''}`);
      }
      outputs.push(text.trim().split(/\r?\n/).at(-1) || 'unknown');
    }
    const doctor = await this.registry.run(this.config.larkCliBin, [...prefix, 'doctor'], {
      timeoutMs: 30_000,
    });
    if (doctor.code !== 0) throw new Error('lark-cli doctor failed for the selected profile');
    const version = await this.registry.run(this.config.larkCliBin, ['--version'], {
      timeoutMs: 10_000,
    });
    if (version.code !== 0) throw new Error('lark-cli --version failed');
    return {
      profile: this.profile,
      version: `${version.stdout}\n${version.stderr}`.trim().split(/\r?\n/).at(-1),
    };
  }

  startSubscription(onLine, onUnexpectedExit) {
    if (this.subscriber) throw new Error('Lark subscriber is already running');
    const args = [
      '--profile', this.profile,
      'event', '+subscribe',
      '--event-types', 'im.message.receive_v1',
      '--as', 'bot',
      '--quiet',
      '--format', 'ndjson',
    ];

    this.stopping = false;
    const child = this.registry.register(spawn(this.config.larkCliBin, args, {
      cwd: this.config.projectDir,
      env: process.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    this.subscriber = child;
    let buffer = '';
    let stderrTail = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      buffer += chunk;
      while (true) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) onLine(line);
      }
      if (Buffer.byteLength(buffer, 'utf8') > this.config.maxEventBytes) {
        this.logger.warn('lark_event_line_oversize', {
          bytes: Buffer.byteLength(buffer, 'utf8'),
        });
        buffer = '';
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk).slice(-4000);
    });
    child.once('error', (error) => {
      this.logger.error('lark_subscriber_error', { error });
    });
    child.once('exit', (code, signal) => {
      this.subscriber = null;
      if (buffer.trim()) onLine(buffer);
      if (!this.stopping) onUnexpectedExit({ code, signal, stderr: stderrTail });
    });
    return child;
  }

  get subscriptionRunning() {
    return Boolean(this.subscriber && this.subscriber.exitCode === null);
  }

  // Direct quote-reply from the daemon itself (slash-command responses). Codex
  // replies go through the MCP tool server instead; this path never carries
  // model output.
  async replyMessage(messageId, text) {
    if (this.config.dryRun) return { sent: false, dryRun: true };
    const result = await this.registry.run(this.config.larkCliBin, [
      '--profile', this.profile,
      'im', '+messages-reply', '--as', 'bot',
      '--message-id', messageId,
      '--text', text,
      '--idempotency-key', randomUUID(),
      '--format', 'json',
    ], {
      cwd: this.config.projectDir,
      timeoutMs: this.config.sendTimeoutMs,
    });
    if (result.timedOut) throw new Error(`lark-cli reply timed out after ${this.config.sendTimeoutMs}ms`);
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch {}
    if (result.code !== 0 || parsed?.ok === false) {
      const detail = parsed?.error?.message || result.stderr.trim() || `exit ${result.code}`;
      throw new Error(`lark-cli reply failed: ${detail.slice(-2000)}`);
    }
    return { sent: true };
  }

  // Daemon-authored liveness acknowledgement. This is deliberately separate
  // from the model MCP delivery path: after a long idle period it gives the
  // sender immediate proof that the local subscriber is alive, while the
  // original message still continues to the model normally.
  async reactMessage(messageId, emojiType = 'OnIt') {
    if (this.config.dryRun) return { reacted: false, dryRun: true };
    const result = await this.registry.run(this.config.larkCliBin, [
      '--profile', this.profile,
      'im', 'reactions', 'create', '--as', 'bot',
      '--params', JSON.stringify({ message_id: messageId }),
      '--data', JSON.stringify({ reaction_type: { emoji_type: emojiType } }),
      '--format', 'json',
    ], {
      cwd: this.config.projectDir,
      timeoutMs: this.config.sendTimeoutMs,
    });
    if (result.timedOut) throw new Error(`lark-cli reaction timed out after ${this.config.sendTimeoutMs}ms`);
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch {}
    if (result.code !== 0 || parsed?.ok === false) {
      const detail = parsed?.error?.message || result.stderr.trim() || `exit ${result.code}`;
      throw new Error(`lark-cli reaction failed: ${detail.slice(-2000)}`);
    }
    return { reacted: true };
  }

  // Chat member roster fetch (bot identity) for name<->open_id resolution.
  // Returns the parsed lark-cli JSON payload; roster.mjs owns bucket parsing.
  async listChatMembers(chatId) {
    const result = await this.registry.run(this.config.larkCliBin, [
      '--profile', this.profile,
      'im', '+chat-members-list',
      '--as', 'bot',
      '--chat-id', chatId,
      '--page-all',
      '--format', 'json',
    ], {
      cwd: this.config.projectDir,
      timeoutMs: 15_000,
    });
    if (result.timedOut) throw new Error('lark-cli chat member lookup timed out after 15000ms');
    if (result.code !== 0) {
      throw new Error(result.stderr.trim().slice(-2000) || `lark-cli chat member lookup exited ${result.code}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error('lark-cli chat member lookup returned invalid JSON');
    }
    return parsed?.data ?? parsed;
  }

  async getChatName(chatId) {
    const result = await this.registry.run(this.config.larkCliBin, [
      '--profile', this.profile,
      'im', 'chats', 'get',
      '--as', 'bot',
      '--chat-id', chatId,
      '--format', 'json',
    ], {
      cwd: this.config.projectDir,
      timeoutMs: 15_000,
    });
    if (result.timedOut) throw new Error('lark-cli chat lookup timed out after 15000ms');
    if (result.code !== 0) {
      throw new Error(result.stderr.trim().slice(-2000) || `lark-cli chat lookup exited ${result.code}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error('lark-cli chat lookup returned invalid JSON');
    }
    return findChatName(parsed);
  }

  async stop() {
    this.stopping = true;
    const child = this.subscriber;
    if (!child || child.exitCode !== null) return;
    terminateProcessTree(child, 'SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    terminateProcessTree(child, 'SIGKILL');
  }
}
