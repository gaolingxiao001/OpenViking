import { spawn } from 'node:child_process';
import { terminateProcessTree } from './process-utils.mjs';

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
      { args: ['im', '--help'], required: ['+messages-reply', '+messages-send'] },
    ];
    const outputs = [];
    for (const check of checks) {
      const result = await this.registry.run(this.config.larkCliBin, [...prefix, ...check.args], {
        timeoutMs: 10_000,
      });
      const text = `${result.stdout}\n${result.stderr}`;
      const missing = check.required.filter((flag) => !text.includes(flag));
      if (result.code !== 0 || missing.length > 0) {
        const error = `lark-cli preflight failed for ${check.args.join(' ')}${missing.length ? `; missing ${missing.join(', ')}` : ''}`;
        if (this.config.strictCliPreflight) throw new Error(error);
        this.logger.warn('lark_preflight_warning', { error });
      }
      outputs.push(text.trim().split(/\r?\n/).at(-1) || 'unknown');
    }
    const doctor = await this.registry.run(this.config.larkCliBin, [...prefix, 'doctor'], {
      timeoutMs: 30_000,
    });
    if (doctor.code !== 0) {
      const error = 'lark-cli doctor failed for the selected profile';
      if (this.config.strictCliPreflight) throw new Error(error);
      this.logger.warn('lark_doctor_warning', { error });
    }
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

  async sendOutbound(outbox) {
    if (this.config.dryRun) return { remoteMessageId: `dry-run-${outbox.id}` };
    const args = ['--profile', this.profile, 'im'];
    if (outbox.deliveryMode === 'chat') {
      if (!outbox.targetChatId) throw new Error('chat delivery is missing target_chat_id');
      args.push('+messages-send', '--as', 'bot', '--chat-id', outbox.targetChatId);
    } else {
      if (!['reply', 'thread'].includes(outbox.deliveryMode)) {
        throw new Error(`unsupported delivery mode: ${outbox.deliveryMode}`);
      }
      args.push('+messages-reply', '--as', 'bot', '--message-id', outbox.replyToMessageId);
    }
    args.push(
      '--text', outbox.body,
      '--idempotency-key', outbox.idempotencyKey,
      '--format', 'json',
    );
    if (outbox.deliveryMode === 'thread') args.push('--reply-in-thread');
    const result = await this.registry.run(this.config.larkCliBin, args, {
      cwd: this.config.projectDir,
      timeoutMs: this.config.sendTimeoutMs,
    });
    if (result.timedOut) throw new Error(`lark-cli delivery timed out after ${this.config.sendTimeoutMs}ms`);
    if (result.code !== 0) {
      throw new Error(result.stderr.trim().slice(-2000) || `lark-cli delivery exited ${result.code}`);
    }
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch {}
    return { remoteMessageId: findMessageId(parsed) };
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
