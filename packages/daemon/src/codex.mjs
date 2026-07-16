import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { terminateProcessTree } from './process-utils.mjs';
import { redactSensitive } from './logger.mjs';

function safe(error) {
  return redactSensitive(error instanceof Error ? error.message : String(error));
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function tomlString(value) {
  return JSON.stringify(value);
}

export function sanitizeCodexEnv(environment) {
  const safeEnv = { ...environment, FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const key of Object.keys(safeEnv)) {
    if (/^(?:LARK|FEISHU)_/i.test(key)) delete safeEnv[key];
  }
  return safeEnv;
}

// Shorten a Lark id to a recognisable stub: keep the type prefix (oc_/om_/ou_/...)
// and the first 8 chars after it. Ids without an underscore prefix are already short.
export function shortenId(id) {
  if (!id) return 'unknown';
  const match = /^([a-z]{1,4}_)(.+)$/.exec(id);
  if (match) return match[1] + match[2].slice(0, 8);
  return id.slice(0, 11);
}

function isoMinute(ms) {
  return `${new Date(ms).toISOString().slice(0, 16)}Z`;
}

// Full chat id (codex needs it to send), short thread suffix for recognition.
function chatTag(chatId, threadId) {
  return threadId ? `${chatId}:${shortenId(threadId)}` : chatId;
}

// Compressed one-line-per-message format (see agent/system-prompt.md "Message format").
// chat= and msg= carry the full id so codex can call lark-cli; from= and the thread
// suffix stay shortened stubs.
export function formatInboundLine(message) {
  let line = `[chat=${chatTag(message.chatId, message.threadId)} msg=${message.messageId}`
    + ` time=${isoMinute(message.createTimeMs)} from=${shortenId(message.senderId)}] ${message.content}`;
  if (Array.isArray(message.mentions) && message.mentions.length > 0) {
    const names = message.mentions.map((m) => `@${m.name || shortenId(m.id)}`).join(' ');
    line += ` [mentions: ${names}]`;
  }
  return line;
}

export function formatHistoryLine(item) {
  const from = item.direction === 'outbound' ? 'me' : shortenId(item.actor);
  return `[chat=${chatTag(item.chatId, item.threadId)} time=${isoMinute(item.atMs)} from=${from}] ${item.text}`;
}

const HISTORY_SEPARATOR = '--- history above, new messages below ---';

// The daemon is a thin pipe: inbound Lark lines are fed to one persistent codex
// app-server thread via turn/start (idle) or turn/steer (mid-turn). Codex sends its
// own replies with lark-cli. This class owns the app-server process, the JSON-RPC
// handshake, the turn/steer state machine, and reconnect-with-resume.
export class CodexAgent {
  constructor(config, store, logger, options = {}) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this._spawn = options.spawn ?? nodeSpawn;
    this.reconnectBaseMs = options.reconnectBaseMs ?? 1000;
    this.reconnectCapMs = options.reconnectCapMs ?? 30_000;
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;

    this.systemPrompt = fs.readFileSync(config.systemPromptPath, 'utf8');
    this.developerInstructionsText = this.developerInstructions(config.profile);
    // One global thread is shared across every chat; policyHash only detects when the
    // instructions/model/workspace change so a stored thread is not resumed under a
    // different policy.
    this.policyHash = createHash('sha256')
      .update(this.developerInstructionsText).update('\0')
      .update(config.codexModel || 'default-model').update('\0')
      .update(config.workspace).update('\0')
      .update('steer-v1').digest('hex');

    this.child = null;
    this.threadId = null;
    this.storedThreadId = null;
    this.activeTurnId = null;
    this.startingTurn = false;      // turn/start sent, turn/started not yet observed
    this.needsHistoryPrefix = false; // fresh thread: prepend history to the first turn
    this.queue = [];                 // texts waiting for a live idle thread
    this.pending = new Map();        // rpc id -> { resolve, reject }
    this.nextId = 0;
    this.stdoutBuffer = '';
    this.stopping = false;
    this.startedOk = false;
    this.reconnecting = false;
    this.backoffMs = this.reconnectBaseMs;
    this.drainTimer = null;
    this.activitySeq = 0;
  }

  developerInstructions(profile) {
    return `${this.systemPrompt.trim()}\n\nDaemon-authenticated: lark-cli profile is ${profile}`;
  }

  get state() {
    return {
      connected: Boolean(this.child && this.threadId),
      activeTurn: this.activeTurnId ? 1 : 0,
      queued: this.queue.length,
    };
  }

  async start() {
    this.stopping = false;
    await this._handshake();
  }

  // ---- outbound state machine -------------------------------------------------

  deliver(text, seq = null) {
    if (this.stopping) return;
    if (!this.child || !this.threadId) { this.queue.push({ text, seq }); return; }
    if (this.activeTurnId) { this._steer(text, seq); return; }
    if (this.startingTurn) { this.queue.push({ text, seq }); return; }
    this._startTurn([{ text, seq }]);
  }

  _startTurn(items) {
    const text = items.map((item) => item.text).join('\n');
    let body = text;
    const hadPrefix = this.needsHistoryPrefix;
    if (hadPrefix) {
      this.needsHistoryPrefix = false;
      // History is prior context only: cut it off before the oldest message of this batch.
      const seqs = items.map((item) => item.seq).filter((seq) => seq != null);
      const beforeSeq = seqs.length > 0 ? Math.min(...seqs) : null;
      const history = this.store.history(this.config.historyLimit, beforeSeq).map(formatHistoryLine);
      if (history.length > 0) body = [...history, HISTORY_SEPARATOR, text].join('\n');
    }
    this.startingTurn = true;
    this._request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: body }],
    }).catch((error) => {
      this.startingTurn = false;
      if (hadPrefix) this.needsHistoryPrefix = true;
      this.logger.warn('codex_turn_start_failed', { error: safe(error) });
      this.queue.unshift(...items); // never drop a message
      this._scheduleDrain();
    });
  }

  _steer(text, seq = null) {
    const expectedTurnId = this.activeTurnId;
    this._request('turn/steer', {
      threadId: this.threadId,
      expectedTurnId,
      input: [{ type: 'text', text }],
    }).then(() => {
      this._recordActivity('agent.steered', { turnId: expectedTurnId, summary: text });
    }).catch((error) => {
      // Race: the turn ended just as we steered. Re-deliver so the message is not lost.
      this.logger.info('codex_steer_fell_back', { error: safe(error) });
      this.deliver(text, seq);
    });
  }

  // turn/started: the in-flight turn/start is live; steer whatever queued meanwhile.
  _onTurnStarted(turnId) {
    this.startingTurn = false;
    this.activeTurnId = turnId ?? null;
    this._recordActivity('agent.turn_started', { turnId: this.activeTurnId });
    if (!this.activeTurnId) return;
    const items = this.queue.splice(0);
    for (const item of items) this._steer(item.text, item.seq);
  }

  // turn/completed: idle again. Anything still queued (e.g. a very fast turn that never
  // emitted turn/started) is merged into one fresh turn/start.
  _onTurnCompleted(status, error) {
    const turnId = this.activeTurnId;
    this.activeTurnId = null;
    this.startingTurn = false;
    this._recordActivity('agent.turn_completed', {
      turnId,
      status,
      metadata: { status, error: error ? safe(error) : undefined },
    });
    this._drain();
  }

  // Start a turn with everything queued, if the connection is idle.
  _drain() {
    if (this.stopping || !this.child || !this.threadId) return;
    if (this.activeTurnId || this.startingTurn) return;
    if (this.queue.length === 0) return;
    this._startTurn(this.queue.splice(0));
  }

  _scheduleDrain() {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this._drain();
    }, this.reconnectBaseMs);
    this.drainTimer.unref?.();
  }

  _flushQueue() {
    const items = this.queue.splice(0);
    for (const item of items) this.deliver(item.text, item.seq);
  }

  // ---- JSON-RPC wire ----------------------------------------------------------

  _encodeRequest(method, params) {
    const id = ++this.nextId;
    return { id, line: `${JSON.stringify({ id, method, params })}\n` };
  }

  _request(method, params) {
    const { id, line } = this._encodeRequest(method, params);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.child.stdin.write(line);
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  _notify(method, params) {
    try {
      this.child?.stdin.write(`${JSON.stringify({ method, params })}\n`);
    } catch { /* connection lost; handled by exit */ }
  }

  // Pure dispatch of one server line: resolves a pending response or routes a
  // notification. Unit-tested directly.
  _handleLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (msg.id !== undefined && msg.method === undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || 'codex rpc error'));
      else pending.resolve(msg.result);
      return;
    }
    if (typeof msg.method === 'string') this._handleNotification(msg.method, msg.params || {});
  }

  _handleNotification(method, params) {
    switch (method) {
      case 'turn/started':
        this._onTurnStarted(params.turn?.id ?? params.turnId ?? null);
        break;
      case 'turn/completed':
        this._onTurnCompleted(params.turn?.status ?? params.status, params.turn?.error ?? params.error);
        break;
      case 'item/completed': {
        const item = params.item;
        const text = item?.text ?? item?.message?.text;
        if ((item?.type === 'agentMessage' || item?.type === 'agent_message') && text) {
          this._recordActivity('agent.note', { turnId: this.activeTurnId, summary: text });
        }
        break;
      }
      default: // thread/started, mcpServer/*, hook/*, thread/*, account/*, item/* — ignore
        break;
    }
  }

  _onStdout(chunk) {
    this.stdoutBuffer += chunk;
    let index;
    while ((index = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line.trim()) {
        try { this._handleLine(line); } catch (error) {
          this.logger.warn('codex_line_error', { error: safe(error) });
        }
      }
    }
  }

  // ---- connection lifecycle ---------------------------------------------------

  _handshake() {
    return new Promise((resolve, reject) => {
      const global = this.store.getGlobalSession();
      this.storedThreadId = (global.sessionId && global.policyHash === this.policyHash)
        ? global.sessionId : null;

      const args = [
        'app-server', '--listen', 'stdio://',
        '-c', `developer_instructions=${tomlString(this.developerInstructionsText)}`,
      ];
      // Proactive IM tools (list_lark_chats / send_lark_message) ride along as an
      // MCP stdio server so codex can send messages through a typed, validated path.
      if (this.config.profile) {
        const toolArgs = [
          this.config.larkToolServerPath,
          '--lark-cli-bin', this.config.larkCliBin,
          '--profile', this.config.profile,
          '--project-dir', this.config.projectDir,
          '--timeout-ms', String(this.config.sendTimeoutMs),
          '--max-text-chars', String(this.config.maxReplyChars),
          '--dry-run', String(Boolean(this.config.dryRun)),
        ];
        args.push(
          '-c', `mcp_servers.lark_daemon_im.command=${tomlString(process.execPath)}`,
          '-c', `mcp_servers.lark_daemon_im.args=${JSON.stringify(toolArgs)}`,
          '-c', 'mcp_servers.lark_daemon_im.startup_timeout_sec=10',
          '-c', `mcp_servers.lark_daemon_im.tool_timeout_sec=${Math.max(10, Math.ceil(this.config.sendTimeoutMs / 1_000) + 5)}`,
        );
      }
      let child;
      try {
        child = this._spawn(this.config.codexBin, args, {
          cwd: this.config.workspace,
          env: sanitizeCodexEnv(process.env),
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) { reject(error); return; }

      this.child = child;
      this.threadId = null;
      this.activeTurnId = null;
      this.startingTurn = false;
      this.stdoutBuffer = '';
      this.pending.clear();
      this.nextId = 0;

      let settled = false;
      const timer = setTimeout(() => finish(new Error('codex handshake timed out')), this.handshakeTimeoutMs);
      timer.unref?.();
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!error) { resolve(); return; }
        // A handshake can fail while the child is still alive (timeout, rpc error
        // response); detach and kill it so a retry does not orphan a live codex.
        this._handleExit(child);
        if (child.exitCode === null) terminateProcessTree(child, 'SIGKILL');
        reject(error);
      };

      child.stdin?.on('error', () => {});
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => { if (this.child === child) this._onStdout(chunk); });
      child.stderr?.on('data', () => {});
      child.once('error', (error) => { this._handleExit(child); finish(error); });
      child.once('exit', (code, signal) => {
        this._handleExit(child, code, signal);
        finish(new Error(`codex exited during handshake (code ${code}, signal ${signal})`));
      });

      this._request('initialize', {
        clientInfo: { name: 'lark-daemon', version: '1' },
        capabilities: { experimentalApi: true },
      }).then(() => {
        this._notify('initialized', {});
        return this._startOrResumeThread();
      }).then(() => {
        this.startedOk = true;
        this.backoffMs = this.reconnectBaseMs;
        this.store.setGlobalSession(this.threadId, this.policyHash);
        this._flushQueue();
        finish();
      }).catch(finish);
    });
  }

  async _startOrResumeThread() {
    const params = {
      cwd: this.config.workspace,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      config: { model_reasoning_effort: this.config.codexEffort },
      ...(this.config.codexModel ? { model: this.config.codexModel } : {}),
    };
    if (this.storedThreadId) {
      try {
        const result = await this._request('thread/resume', { ...params, threadId: this.storedThreadId });
        this.threadId = result?.thread?.id ?? this.storedThreadId;
        this.needsHistoryPrefix = false; // codex retains the resumed thread's context
        return;
      } catch (error) {
        this.logger.warn('codex_resume_failed_fresh_start', { error: safe(error) });
      }
    }
    const result = await this._request('thread/start', params);
    this.threadId = result?.thread?.id;
    if (!this.threadId) throw new Error('thread/start returned no thread id');
    this.needsHistoryPrefix = true;
  }

  _handleExit(child, code, signal) {
    if (this.child !== child) return; // a stale child from a prior connection
    this.child = null;
    this.threadId = null;
    this.activeTurnId = null;
    this.startingTurn = false;
    for (const pending of this.pending.values()) {
      try { pending.reject(new Error('codex connection lost')); } catch { /* ignore */ }
    }
    this.pending.clear();
    if (this.stopping || !this.startedOk) return;
    this.logger.warn('codex_disconnected', { code, signal });
    void this._reconnectLoop();
  }

  async _reconnectLoop() {
    if (this.reconnecting || this.stopping) return;
    this.reconnecting = true;
    while (!this.stopping) {
      await delay(this.backoffMs);
      if (this.stopping) break;
      try {
        await this._handshake();
        break;
      } catch (error) {
        this.logger.warn('codex_reconnect_failed', { error: safe(error), backoffMs: this.backoffMs });
        this.backoffMs = Math.min(this.backoffMs * 2, this.reconnectCapMs);
      }
    }
    this.reconnecting = false;
  }

  _recordActivity(kind, fields = {}) {
    try {
      this.activitySeq += 1;
      this.store.recordActivity({
        eventKey: `codex:${this.threadId ?? 'na'}:${fields.turnId ?? 'na'}:${kind}:${this.activitySeq}`,
        kind,
        summary: fields.summary,
        status: fields.status,
        metadata: fields.metadata,
      });
    } catch (error) {
      this.logger.warn('activity_persist_failed', { kind, error: safe(error) });
    }
  }

  async stop() {
    this.stopping = true;
    if (this.drainTimer) { clearTimeout(this.drainTimer); this.drainTimer = null; }
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    terminateProcessTree(child, 'SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      delay(3_000),
    ]);
    terminateProcessTree(child, 'SIGKILL');
  }
}
