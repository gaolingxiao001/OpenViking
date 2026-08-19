import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { sanitizeNonArkChildEnv, terminateProcessTree } from './process-utils.mjs';
import { MEETING_EVENT_TYPES } from './meeting/index.mjs';

export const SUBSCRIBED_EVENT_TYPES = Object.freeze([
  'im.message.receive_v1',
  ...MEETING_EVENT_TYPES,
]);

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
      '--event-types', SUBSCRIBED_EVENT_TYPES.join(','),
      '--as', 'bot',
      '--quiet',
      '--format', 'ndjson',
    ];

    this.stopping = false;
    const child = this.registry.register(spawn(this.config.larkCliBin, args, {
      cwd: this.config.projectDir,
      env: sanitizeNonArkChildEnv(process.env),
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
      if (!this.stopping) {
        // Leader is gone; stop() will not see this handle. Reap the group so
        // grandchildren that ignored the leader's death do not leak.
        terminateProcessTree(child, 'SIGKILL');
        onUnexpectedExit({ code, signal, stderr: stderrTail });
      }
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

  async joinMeeting({ meetingNumber, callId = null, password = null }) {
    const args = [
      '--profile', this.profile,
      'vc', '+meeting-join', '--as', 'bot',
      '--meeting-number', meetingNumber,
    ];
    if (callId) args.push('--call-id', callId);
    if (password) args.push('--password', password);
    args.push('--format', 'json');
    return this.runJson(args, 'meeting join', this.config.sendTimeoutMs ?? 30_000);
  }

  async getMeetingRealtimeEndpoint(meetingId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(meetingId ?? ''))) {
      throw new Error('meeting realtime endpoint requires a valid meeting id');
    }
    const result = await this.runJson([
      '--profile', this.profile,
      'api', 'GET', '/open-apis/vc/v1/realtime/endpoint',
      '--as', 'bot',
      '--params', JSON.stringify({ meeting_id: String(meetingId) }),
      '--json',
    ], 'meeting realtime endpoint', this.config.sendTimeoutMs ?? 30_000);
    const url = result?.data?.websocket_url
      ?? result?.data?.data?.websocket_url
      ?? result?.websocket_url;
    if (typeof url !== 'string' || !/^wss:\/\//i.test(url)) {
      throw new Error('lark-cli meeting realtime endpoint returned no secure websocket URL');
    }
    return url;
  }

  async leaveMeeting(meetingId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(String(meetingId ?? ''))) {
      throw new Error('meeting leave requires a valid meeting id');
    }
    return await this.runJson([
      '--profile', this.profile,
      'vc', '+meeting-leave', '--as', 'bot',
      '--meeting-id', String(meetingId),
      '--format', 'json',
    ], 'meeting leave', this.config.sendTimeoutMs ?? 30_000);
  }

  async listMeetingEvents({ meetingId, pageToken = null, startMs = null }) {
    const args = [
      '--profile', this.profile,
      'vc', '+meeting-events', '--as', 'bot',
      '--meeting-id', meetingId,
    ];
    if (pageToken) args.push('--page-token', pageToken);
    else if (Number.isFinite(startMs) && startMs > 0) {
      // Small overlap makes timestamp-only crash recovery lossless; event_key
      // dedupe removes the overlap after the pull.
      args.push('--start', new Date(Math.max(0, startMs - 2_000)).toISOString());
    }
    args.push('--page-all', '--format', 'json');
    return this.runJson(args, 'meeting event recovery', 30_000);
  }

  async runJson(args, label, timeoutMs) {
    const result = await this.registry.run(this.config.larkCliBin, args, {
      cwd: this.config.projectDir,
      timeoutMs,
    });
    if (result.timedOut) throw new Error(`lark-cli ${label} timed out after ${timeoutMs}ms`);
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch {}
    if (result.code !== 0 || parsed?.ok === false) {
      const detail = parsed?.error?.message || result.stderr.trim() || `exit ${result.code}`;
      const code = parsed?.error?.code ? ` (${parsed.error.code})` : '';
      throw new Error(`lark-cli ${label} failed${code}: ${detail.slice(-2000)}`);
    }
    if (!parsed) throw new Error(`lark-cli ${label} returned invalid JSON`);
    return parsed;
  }

  async stop() {
    this.stopping = true;
    const child = this.subscriber;
    if (!child?.pid) return;
    terminateProcessTree(child, 'SIGTERM');
    if (child.exitCode === null) {
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
    terminateProcessTree(child, 'SIGKILL');
  }
}
