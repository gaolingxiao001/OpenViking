import fs from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { terminateProcessTree } from './process-utils.mjs';
import { redactSensitive } from './logger.mjs';

function safe(error) {
  return redactSensitive(error instanceof Error ? error.message : String(error));
}

// turn/completed carries error as an object whose .message is often a JSON blob
// wrapping the upstream API error; unwrap to the innermost human-readable message.
export function turnErrorText(error) {
  if (error === null || error === undefined) return '';
  const raw = typeof error === 'string'
    ? error
    : typeof error.message === 'string' ? error.message : JSON.stringify(error);
  try {
    const parsed = JSON.parse(raw);
    const inner = parsed?.error?.message ?? parsed?.message;
    if (typeof inner === 'string' && inner.trim()) return safe(inner);
  } catch { /* not JSON: use as-is */ }
  return safe(raw);
}

function cleanToolPart(value, fallback) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 80) : fallback;
}

function completedToolActivity(item) {
  if (!item || typeof item !== 'object') return null;
  const durationMs = Number.isFinite(item.durationMs) ? Math.max(0, item.durationMs) : undefined;
  const failed = item.status === 'failed' || item.status === 'declined' || Boolean(item.error);
  const common = (itemType, toolLabel, extra = {}) => ({
    kind: 'agent.tool',
    summary: toolLabel,
    status: failed ? 'FAILED' : 'COMPLETED',
    metadata: {
      itemType,
      toolLabel,
      toolStatus: cleanToolPart(item.status, failed ? 'failed' : 'completed'),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...extra,
    },
  });

  if (item.type === 'mcpToolCall') {
    const toolServer = cleanToolPart(item.server, 'mcp');
    const toolName = cleanToolPart(item.tool, 'tool');
    const isLarkDelivery = toolServer === 'lark_daemon_im'
      && ['react_to_lark_message', 'retract_lark_message', 'reply_lark_message', 'send_lark_message'].includes(toolName);
    if (isLarkDelivery) {
      const reply = item.arguments && typeof item.arguments === 'object'
        ? String(item.arguments.text ?? item.arguments.emoji_type ?? '').trim()
        : '';
      const deliveryMode = toolName === 'react_to_lark_message'
        ? 'reaction'
        : toolName === 'retract_lark_message'
          ? 'retract'
        : toolName === 'send_lark_message'
          ? 'chat'
          : item.arguments?.reply_in_thread === true ? 'thread' : 'reply';
      const toolLabel = toolName === 'react_to_lark_message'
        ? '飞书表态'
        : toolName === 'retract_lark_message'
          ? '飞书撤回'
        : toolName === 'send_lark_message' ? '飞书发送' : '飞书回复';
      const activity = common('mcpToolCall', toolLabel, {
        toolName,
        toolServer,
        deliveryMode,
      });
      activity.summary = reply || toolLabel;
      activity.status = failed ? 'FAILED' : 'SENT';
      return activity;
    }
    return common('mcpToolCall', `${toolServer} · ${toolName}`, { toolName, toolServer });
  }

  if (item.type === 'dynamicToolCall') {
    const toolName = cleanToolPart(item.tool, 'tool');
    const namespace = cleanToolPart(item.namespace, 'dynamic');
    return common('dynamicToolCall', `${namespace} · ${toolName}`, {
      toolName,
      toolServer: namespace,
    });
  }

  if (item.type === 'commandExecution') {
    const actionName = item.commandActions?.find((action) => action?.name)?.name;
    const toolName = cleanToolPart(actionName, 'shell');
    return common('commandExecution', toolName === 'shell' ? '运行命令' : `运行命令 · ${toolName}`, {
      toolName,
      ...(Number.isInteger(item.exitCode) ? { exitCode: item.exitCode } : {}),
    });
  }

  if (item.type === 'fileChange') {
    const count = Array.isArray(item.changes) ? item.changes.length : 0;
    return common('fileChange', count ? `修改文件 · ${count}` : '修改文件', { toolName: 'file_change' });
  }

  if (item.type === 'webSearch') {
    return common('webSearch', '搜索网页', { toolName: 'web_search' });
  }

  if (item.type === 'imageView') {
    return common('imageView', '查看图片', { toolName: 'image_view' });
  }

  if (item.type === 'imageGeneration') {
    return common('imageGeneration', '生成图片', { toolName: 'image_generation' });
  }

  if (item.type === 'collabAgentToolCall') {
    return common('collabAgentToolCall', '协作 Agent', {
      toolName: cleanToolPart(typeof item.tool === 'string' ? item.tool : item.tool?.type, 'collaboration'),
    });
  }

  return null;
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
    this.onTurnFailed = options.onTurnFailed ?? null; // ({ inboundSeqs, error }) => void

    this.systemPrompt = fs.readFileSync(config.systemPromptPath, 'utf8');
    this.developerInstructionsText = this.developerInstructions(config.profile);
    // Model/effort start from env config but can be switched at runtime via the
    // /model and /effort slash commands; overrides persist in the store's meta table.
    this.model = store.getSetting?.('codex_model') ?? config.codexModel ?? '';
    this.effort = store.getSetting?.('codex_effort') ?? config.codexEffort;

    this.child = null;
    this.threadId = null;
    this.storedThreadId = null;
    this.activeTurnId = null;
    this.startingTurn = false;      // turn/start sent, turn/started not yet observed
    this.startingItems = [];         // inbound items waiting for turn/started
    this.activeInboundSeqs = [];     // inbound rows associated with the live app-server turn
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

  // One global thread is shared across every chat; policyHash only detects when the
  // instructions/workspace change so a stored thread is not resumed under a different
  // policy. Model/effort are deliberately not part of the hash: they are per-turn
  // overrides now, and switching them must not orphan the stored thread.
  get policyHash() {
    return createHash('sha256')
      .update(this.developerInstructionsText).update('\0')
      .update(this.config.workspace).update('\0')
      .update('steer-v2').digest('hex');
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
    this.startingItems = items.map((item) => ({ text: item.text, seq: item.seq }));
    // model/effort ride on every turn/start: thread/resume does not re-apply its
    // config to an already-running thread, so per-turn overrides are the only way
    // /model and /effort reliably take effect.
    this._request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: body }],
      effort: this.effort,
      ...(this.model ? { model: this.model } : {}),
    }).catch((error) => {
      this.startingTurn = false;
      this.startingItems = [];
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
      if (seq !== null && seq !== undefined && !this.activeInboundSeqs.includes(seq)) {
        this.activeInboundSeqs.push(seq);
      }
      this._recordActivity('agent.steered', {
        turnId: expectedTurnId,
        inboundSeq: seq,
        summary: text,
        metadata: { inboundSeqs: [...this.activeInboundSeqs] },
      });
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
    this.activeInboundSeqs = [...new Set(
      this.startingItems.map((item) => item.seq).filter((seq) => seq !== null && seq !== undefined),
    )];
    this.startingItems = [];
    this._recordActivity('agent.turn_started', {
      turnId: this.activeTurnId,
      inboundSeq: this.activeInboundSeqs.at(-1) ?? null,
      metadata: { inboundSeqs: [...this.activeInboundSeqs] },
    });
    if (!this.activeTurnId) return;
    const items = this.queue.splice(0);
    for (const item of items) this._steer(item.text, item.seq);
  }

  _associatedInboundSeqs() {
    if (this.activeInboundSeqs.length > 0) return [...this.activeInboundSeqs];
    return [...new Set(
      this.startingItems.map((item) => item.seq).filter((seq) => seq !== null && seq !== undefined),
    )];
  }

  // turn/completed: idle again. Anything still queued (e.g. a very fast turn that never
  // emitted turn/started) is merged into one fresh turn/start.
  _onTurnCompleted(status, error, completedTurnId = null) {
    const turnId = this.activeTurnId ?? completedTurnId;
    const inboundSeqs = this._associatedInboundSeqs();
    this.activeTurnId = null;
    this.startingTurn = false;
    const failed = status === 'failed';
    const errorText = error ? turnErrorText(error) : '';
    this._recordActivity('agent.turn_completed', {
      turnId,
      inboundSeq: inboundSeqs.at(-1) ?? null,
      status,
      summary: failed ? errorText : undefined,
      metadata: { status, error: errorText || undefined, inboundSeqs },
    });
    this.activeInboundSeqs = [];
    this.startingItems = [];
    if (failed && this.onTurnFailed) {
      try {
        this.onTurnFailed({ inboundSeqs, error: errorText || '未知错误' });
      } catch (callbackError) {
        this.logger.warn('turn_failure_notify_failed', { error: safe(callbackError) });
      }
    }
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
    // After a session rotate, the abandoned thread's dying turn may still emit
    // notifications; never let them corrupt the new thread's turn state.
    const threadId = params.threadId ?? params.turn?.threadId ?? null;
    if (threadId && this.threadId && threadId !== this.threadId) return;
    switch (method) {
      case 'turn/started':
        this._onTurnStarted(params.turn?.id ?? params.turnId ?? null);
        break;
      case 'turn/completed':
        this._onTurnCompleted(
          params.turn?.status ?? params.status,
          params.turn?.error ?? params.error,
          params.turn?.id ?? params.turnId ?? null,
        );
        break;
      case 'item/completed': {
        const item = params.item;
        const text = item?.text ?? item?.message?.text;
        const associatedInboundSeqs = this._associatedInboundSeqs();
        if ((item?.type === 'agentMessage' || item?.type === 'agent_message') && text) {
          this._recordActivity('agent.note', {
            turnId: params.turnId ?? this.activeTurnId,
            inboundSeq: associatedInboundSeqs.at(-1) ?? null,
            summary: text,
            metadata: { inboundSeqs: associatedInboundSeqs },
          });
          break;
        }
        const tool = completedToolActivity(item);
        if (tool) {
          const replyMessageId = item?.type === 'mcpToolCall'
            && item.server === 'lark_daemon_im'
            && ['react_to_lark_message', 'reply_lark_message'].includes(item.tool)
            ? item.arguments?.message_id
            : null;
          const resolvedSeq = replyMessageId
            ? this.store.inboundSeqForMessageId?.(replyMessageId)
            : null;
          const inboundSeq = resolvedSeq ?? associatedInboundSeqs.at(-1) ?? null;
          const inboundSeqs = [...associatedInboundSeqs];
          if (resolvedSeq !== null && resolvedSeq !== undefined && !inboundSeqs.includes(resolvedSeq)) {
            inboundSeqs.push(resolvedSeq);
          }
          this._recordActivity(tool.kind, {
            turnId: params.turnId ?? this.activeTurnId,
            inboundSeq,
            summary: tool.summary,
            status: tool.status,
            metadata: { ...tool.metadata, inboundSeqs },
          });
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
      config: { model_reasoning_effort: this.effort },
      ...(this.model ? { model: this.model } : {}),
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

  // Rebuild the codex thread without restarting the child (slash commands).
  // resume=true re-opens the current thread under the current model/effort params
  // (context kept, fresh-start fallback inside _startOrResumeThread); resume=false
  // is /new: an empty thread with no history prefix. Returns the new thread id, or
  // null while disconnected (the stored policy/settings apply on reconnect).
  async rotateSession({ resume = false } = {}) {
    if (!resume) {
      this.storedThreadId = null;
      this.store.clearGlobalSession?.();
    }
    if (!this.child || !this.threadId) return null;
    const previousThreadId = this.threadId;
    if (this.activeTurnId) {
      try {
        await this._request('turn/interrupt', {
          threadId: previousThreadId,
          turnId: this.activeTurnId,
        });
      } catch { /* best effort; the thread is being replaced anyway */ }
    }
    // ponytail: a turn/start still in flight (startingTurn) cannot be interrupted by
    // id yet; its turn runs out on the abandoned thread. Window is one RPC ack.
    this.activeTurnId = null;
    this.startingTurn = false;
    this.startingItems = [];
    this.activeInboundSeqs = [];
    this.storedThreadId = resume ? previousThreadId : null;
    this.threadId = null; // deliver() queues while the new thread comes up
    try {
      await this._startOrResumeThread();
    } catch (error) {
      // No usable thread: recycle the child so the reconnect loop rebuilds a clean
      // connection instead of stranding the queue behind a null threadId.
      this.logger.warn('codex_rotate_failed', { error: safe(error) });
      if (this.child) terminateProcessTree(this.child, 'SIGKILL');
      throw error;
    }
    if (!resume) this.needsHistoryPrefix = false; // /new means a clean slate
    this.store.setGlobalSession(this.threadId, this.policyHash);
    this._recordActivity('agent.session_rotated', {
      summary: resume ? '会话参数已更新' : '已开启新会话',
      metadata: { resume },
    });
    this._drain();
    return this.threadId;
  }

  // Model/effort values ride on the next turn/start (see _startTurn). Command
  // policy decides whether to preserve or rotate the thread after updating them.
  setModel(model) {
    this.model = model;
    this.store.setSetting?.('codex_model', model);
  }

  setEffort(effort) {
    this.effort = effort;
    this.store.setSetting?.('codex_effort', effort);
  }

  // Visible models from the app-server with their supported reasoning efforts,
  // for /model discovery and /effort validation. Empty while disconnected or
  // when the server lacks model/list.
  async listModels() {
    if (!this.child) return [];
    try {
      const result = await this._request('model/list', {});
      const models = Array.isArray(result?.data) ? result.data : [];
      return models
        .filter((model) => model && !model.hidden && typeof model.id === 'string')
        .map((model) => ({
          id: model.id,
          efforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
            .map((effort) => (typeof effort === 'string' ? effort : effort?.reasoningEffort))
            .filter((effort) => typeof effort === 'string' && effort),
        }));
    } catch (error) {
      this.logger.info('codex_model_list_failed', { error: safe(error) });
      return [];
    }
  }

  _handleExit(child, code, signal) {
    if (this.child !== child) return; // a stale child from a prior connection
    this.child = null;
    this.threadId = null;
    this.activeTurnId = null;
    this.startingTurn = false;
    this.startingItems = [];
    this.activeInboundSeqs = [];
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
        turnId: fields.turnId,
        inboundSeq: fields.inboundSeq,
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
