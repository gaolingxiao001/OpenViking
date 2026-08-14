import { spawn as nodeSpawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { terminateProcessTree } from './process-utils.mjs';
import { redactSensitive } from './logger.mjs';
import { cognitionHistoryPrefix, CognitionLimitError } from './cognition.mjs';
import { lookupMemberName } from './roster.mjs';
import { loadSystemPrompt } from './config.mjs';

function safe(error) {
  return redactSensitive(error instanceof Error ? error.message : String(error));
}

function deliveryItem({ text, seq = null, receiptId }) {
  return receiptId === null || receiptId === undefined
    ? { text, seq }
    : { text, seq, receiptId };
}

function receiptIds(items) {
  return [...new Set(items
    .map((item) => item.receiptId)
    .filter((receiptId) => receiptId !== null && receiptId !== undefined))];
}

function withReceiptIds(fields, ids) {
  return ids.length > 0 ? { ...fields, receiptIds: ids } : fields;
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

export function sanitizeCodexEnv(environment, profile = '') {
  const safeEnv = { ...environment, FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const key of Object.keys(safeEnv)) {
    if (/^(?:LARK|FEISHU|LARKSUITE)_/i.test(key)) delete safeEnv[key];
  }
  if (profile) safeEnv.LARKSUITE_CLI_PROFILE = profile;
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

// from= label: the member's sanitized display name when the roster knows it
// (resolver param first, then the process-wide roster), else the shortened stub.
function fromLabel(chatId, senderId, resolveName = null) {
  if (resolveName) {
    try {
      const resolved = resolveName(chatId, senderId);
      if (resolved) return resolved;
    } catch { /* fall through to the shared resolver / stub */ }
  }
  return lookupMemberName(chatId, senderId) ?? shortenId(senderId);
}

// Full chat id (codex needs it to send); thread membership rides as a separate
// `thread=` bracket field so the audience boundary stays salient to the model.
function chatTag(chatId, threadId) {
  return threadId ? `${chatId} thread=${shortenId(threadId)}` : chatId;
}

// One message must stay one physical line: the system prompt promises that only the
// leading [ … ] bracket is daemon-authenticated, so a literal newline inside untrusted
// content would let a sender forge a metadata line (or the history separator) of their
// own. Line breaks render as ⏎; other control chars collapse to spaces.
export function oneLine(text) {
  return String(text ?? '')
    .replace(/\s*[\r\n\u2028\u2029]+\s*/g, ' \u23CE ')
    .replace(/[\u0000-\u001f\u007f]/g, ' ');
}

// Compressed one-line-per-message format (see agent/system-prompt.md "Message format").
// chat= and msg= carry the full id so codex can call lark-cli; from= and the thread=
// field stay shortened stubs.
export function formatInboundLine(message, resolveName = null, authenticated = {}) {
  const idleForMs = Number(authenticated?.idleForMs);
  const idleTag = Number.isFinite(idleForMs) && idleForMs >= 0
    ? ` idle=${Math.max(1, Math.floor(idleForMs / 1_000))}s`
    : '';
  // Daemon-resolved quote-reply target: reply_to=me means the sender quoted one
  // of the bot's own messages (strong addressing signal); otherwise the quoted
  // message author's label, falling back to a shortened id stub.
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
    const names = message.mentions.map((m) => `@${oneLine(m.name) || shortenId(m.id)}`).join(' ');
    line += ` [mentions: ${names}]`;
  }
  return line;
}

export function formatHistoryLine(item, resolveName = null) {
  const from = item.direction === 'outbound' ? 'me' : fromLabel(item.chatId, item.actor, resolveName);
  return `[chat=${chatTag(item.chatId, item.threadId)} time=${isoMinute(item.atMs)} from=${from}] ${oneLine(item.text)}`;
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
    this.onTurnSucceeded = options.onTurnSucceeded ?? null; // ({ inboundSeqs }) => void
    this.onDeliverySucceeded = options.onDeliverySucceeded ?? null; // ({ inboundSeqs, mode }) => void
    this.onTurnAbandoned = options.onTurnAbandoned ?? null; // ({ inboundSeqs }) => void
    this.onAvailable = options.onAvailable ?? null;   // () => void
    const cognition = store.getCognitionState?.() ?? { runtime: 'codex', epoch: 1, authorityToken: null };
    this.runtime = 'codex';
    this.cognitionEpoch = options.cognitionEpoch ?? cognition.epoch;
    this.authorityToken = options.authorityToken ?? cognition.authorityToken ?? '';
    this.sessionPersistence = options.sessionPersistence !== false;
    this.allowResume = options.allowResume !== false;
    this.syncedThroughSeq = options.syncedThroughSeq ?? 0;

    this.systemPrompt = loadSystemPrompt(config);
    this.developerInstructionsText = this.developerInstructions(config.profile);
    // Model/effort start from env config but can be switched at runtime via the
    // /model and /effort slash commands; overrides persist in the store's meta table.
    this.model = options.model ?? store.getSetting?.('codex_model') ?? config.codexModel ?? '';
    this.effort = store.getSetting?.('codex_effort') ?? config.codexEffort;

    this.child = null;
    this.threadId = null;
    this.storedThreadId = null;
    this.activeTurnId = null;
    this.startingTurn = false;      // turn/start sent, turn/started not yet observed
    this.turnStartedAtMs = null;
    this.modelWorking = false;
    this.modelStartedAtMs = null;
    this.startingItems = [];         // inbound items waiting for turn/started
    this.startingJournalThroughSeq = 0; // promoted only after turn completion
    this.activeInboundSeqs = [];     // inbound rows associated with the live app-server turn
    this.activeReceiptIds = [];      // opaque non-DB receipts associated with the live turn
    this.needsHistoryPrefix = false; // fresh thread: prepend history to the first turn
    this.queue = [];                 // texts waiting for a live idle thread
    this.pending = new Map();        // rpc id -> { resolve, reject }
    this.nextId = 0;
    this.nextQueuedBatchId = 0;
    this.stdoutBuffer = '';
    this.stopping = false;
    this.startedOk = false;
    this.reconnecting = false;
    this.backoffMs = this.reconnectBaseMs;
    this.drainTimer = null;
    this.activitySeq = 0;
    this.idleWaiters = [];
    this.primeWaiter = null;
  }

  developerInstructions(profile) {
    return `${this.systemPrompt.trim()}\n\nDaemon-authenticated: lark-cli profile is ${profile}. Shell fallbacks inherit this profile through LARKSUITE_CLI_PROFILE. Never pass --profile and never override or unset that environment variable.`;
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

  get turnInProgress() {
    return Boolean(this.activeTurnId || this.startingTurn);
  }

  async start() {
    this.stopping = false;
    await this._handshake();
  }

  get sessionDescriptor() {
    return {
      runtime: this.runtime,
      sessionId: this.threadId,
      policyHash: this.policyHash,
      epoch: this.cognitionEpoch,
      syncedThroughSeq: this.syncedThroughSeq,
    };
  }

  activateSession() {
    this.sessionPersistence = true;
  }

  whenIdle() {
    if (!this.turnInProgress && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  primeCognition(text, syncedThroughSeq) {
    void text;
    void syncedThroughSeq;
    return Promise.reject(new Error('standalone cognition catch-up is disabled; prefix the first real turn'));
  }

  // ---- outbound state machine -------------------------------------------------

  deliver(text, seq = null, receiptId = null) {
    return this.deliverBatch([deliveryItem({ text, seq, receiptId })]);
  }

  // Starts one turn atomically when idle. The burst router uses this to keep
  // same-conversation corrections in one prompt instead of turning the later
  // lines into steer calls during the turn/start acknowledgement window.
  deliverBatch(items) {
    if (this.stopping) return false;
    if (!Array.isArray(items) || items.length === 0) return false;
    const batch = items.map(deliveryItem);
    if (!this.child || !this.threadId) { this._enqueueBatch(batch); return true; }
    if (this.activeTurnId) {
      this._steerBatch(batch);
      return true;
    }
    if (this.startingTurn) { this._enqueueBatch(batch); return true; }
    if (this.queue.length > 0) {
      this._enqueueBatch(batch);
      this._drain();
      return true;
    }
    this._claimBatch(batch);
    return true;
  }

  // Atomic transport hand-off: a queued group burst may start only when no older
  // Codex-owned work exists. A true result means this agent owns every item.
  tryStartBatch(items) {
    if (this.stopping
      || !this.child
      || !this.threadId
      || this.turnInProgress
      || this.queue.length > 0
      || !Array.isArray(items)
      || items.length === 0) return false;
    const batch = items.map(deliveryItem);
    this._claimBatch(batch);
    return true;
  }

  _claimBatch(batch) {
    try {
      this._startTurn(batch);
    } catch (error) {
      if (error instanceof CognitionLimitError) {
        const inboundSeqs = batch.map((item) => item.seq).filter((seq) => seq != null);
        const receipts = receiptIds(batch);
        this.logger.warn('codex_cognition_limit', { error: safe(error) });
        try {
          this.onTurnFailed?.(withReceiptIds({ inboundSeqs, error: safe(error) }, receipts));
        } catch {}
        this._notifyAvailable();
        return;
      }
      // Ownership has already crossed the transport boundary. Keep the whole
      // batch in the Codex queue and retry; never leave half of it behind.
      this.logger.warn('codex_turn_start_sync_failed', { error: safe(error) });
      this._enqueueBatch(batch, { front: true });
      this._scheduleDrain();
    }
  }

  _enqueueBatch(batch, { front = false } = {}) {
    const queuedBatchId = batch.length < 2 ? null : ++this.nextQueuedBatchId;
    const queued = queuedBatchId === null
      ? batch
      : batch.map((item) => ({ ...item, queuedBatchId }));
    if (front) this.queue.unshift(...queued);
    else this.queue.push(...queued);
  }

  _startTurn(items, { prime = false } = {}) {
    const text = items.map((item) => item.text).join('\n');
    let body = text;
    const hadPrefix = this.needsHistoryPrefix;
    let journalThroughSeq = this.syncedThroughSeq;
    if (!prime) {
      const seqs = items.map((item) => item.seq).filter((seq) => seq != null);
      const beforeSeq = seqs.length > 0 ? Math.min(...seqs) : null;
      const throughSeq = this.store.cognitionJournalBeforeInbound?.(beforeSeq, this.cognitionEpoch) ?? 0;
      const needsCatchup = hadPrefix || throughSeq > this.syncedThroughSeq;
      if (needsCatchup && this.store.cognitionJournal && this.store.cognitionJournalBeforeInbound) {
        const catchup = cognitionHistoryPrefix(
          this.store,
          this.cognitionEpoch,
          throughSeq,
          this.config.cognitionMaxChars,
          hadPrefix ? 0 : this.syncedThroughSeq,
        );
        journalThroughSeq = catchup.throughSeq;
        body = `${catchup.text}\n${text}`;
      } else if (hadPrefix) {
        // Compatibility fallback for isolated tests and pre-journal stores.
        const history = this.store.history(this.config.historyLimit, beforeSeq).map(formatHistoryLine);
        if (history.length > 0) body = [...history, HISTORY_SEPARATOR, text].join('\n');
      }
      this.needsHistoryPrefix = false;
    }
    this.turnStartedAtMs = Date.now();
    this.modelWorking = true;
    this.modelStartedAtMs = this.turnStartedAtMs;
    this.startingTurn = true;
    this.startingItems = items.map(deliveryItem);
    this.startingJournalThroughSeq = journalThroughSeq;
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
      this.turnStartedAtMs = null;
      this.modelWorking = false;
      this.modelStartedAtMs = null;
      this.startingItems = [];
      this.startingJournalThroughSeq = 0;
      if (hadPrefix) this.needsHistoryPrefix = true;
      this.logger.warn('codex_turn_start_failed', { error: safe(error) });
      if (prime && this.primeWaiter) {
        const waiter = this.primeWaiter;
        this.primeWaiter = null;
        waiter.reject(error);
        this._notifyAvailable();
      } else {
        this._enqueueBatch(items, { front: true }); // never drop a message
        this._scheduleDrain();
      }
    });
  }

  _steer(text, seq = null, receiptId = null) {
    this._steerBatch([deliveryItem({ text, seq, receiptId })]);
  }

  _steerBatch(items) {
    const expectedTurnId = this.activeTurnId;
    const text = items.map((item) => item.text).join('\n');
    const seqs = [...new Set(
      items.map((item) => item.seq).filter((seq) => seq !== null && seq !== undefined),
    )];
    const receipts = receiptIds(items);
    this._request('turn/steer', {
      threadId: this.threadId,
      expectedTurnId,
      input: [{ type: 'text', text }],
    }).then(() => {
      for (const seq of seqs) {
        if (!this.activeInboundSeqs.includes(seq)) this.activeInboundSeqs.push(seq);
      }
      for (const receiptId of receipts) {
        if (!this.activeReceiptIds.includes(receiptId)) this.activeReceiptIds.push(receiptId);
      }
      this._recordActivity('agent.steered', {
        turnId: expectedTurnId,
        inboundSeq: seqs.at(-1) ?? null,
        summary: text,
        metadata: { inboundSeqs: [...this.activeInboundSeqs] },
      });
    }).catch((error) => {
      // Race: the turn ended just as we steered. Re-deliver so the message is not lost.
      this.logger.info('codex_steer_fell_back', { error: safe(error) });
      this.deliverBatch(items);
    });
  }

  // turn/started: the in-flight turn/start is live; steer whatever queued meanwhile.
  _onTurnStarted(turnId) {
    this.startingTurn = false;
    this.activeTurnId = turnId ?? null;
    this.activeInboundSeqs = [...new Set(
      this.startingItems.map((item) => item.seq).filter((seq) => seq !== null && seq !== undefined),
    )];
    this.activeReceiptIds = receiptIds(this.startingItems);
    this.startingItems = [];
    this._recordActivity('agent.turn_started', {
      turnId: this.activeTurnId,
      inboundSeq: this.activeInboundSeqs.at(-1) ?? null,
      metadata: { inboundSeqs: [...this.activeInboundSeqs] },
    });
    if (!this.activeTurnId) return;
    const items = this.queue.splice(0);
    for (let index = 0; index < items.length;) {
      const queuedBatchId = items[index].queuedBatchId;
      if (queuedBatchId === undefined) {
        this._steer(items[index].text, items[index].seq, items[index].receiptId);
        index += 1;
        continue;
      }
      let end = index + 1;
      while (items[end]?.queuedBatchId === queuedBatchId) end += 1;
      this._steerBatch(items.slice(index, end));
      index = end;
    }
  }

  _associatedInboundSeqs() {
    if (this.activeInboundSeqs.length > 0) return [...this.activeInboundSeqs];
    return [...new Set(
      this.startingItems.map((item) => item.seq).filter((seq) => seq !== null && seq !== undefined),
    )];
  }

  _associatedReceiptIds() {
    if (this.activeReceiptIds.length > 0) return [...this.activeReceiptIds];
    return receiptIds(this.startingItems);
  }

  // turn/completed: idle again. Anything still queued (e.g. a very fast turn that never
  // emitted turn/started) is merged into one fresh turn/start.
  _onTurnCompleted(status, error, completedTurnId = null) {
    const turnId = this.activeTurnId ?? completedTurnId;
    const inboundSeqs = this._associatedInboundSeqs();
    const receipts = this._associatedReceiptIds();
    this.activeTurnId = null;
    this.startingTurn = false;
    this.turnStartedAtMs = null;
    this.modelWorking = false;
    this.modelStartedAtMs = null;
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
    this.activeReceiptIds = [];
    this.startingItems = [];
    if (!failed) {
      this.syncedThroughSeq = Math.max(this.syncedThroughSeq, this.startingJournalThroughSeq);
      for (const seq of inboundSeqs) {
        this.syncedThroughSeq = Math.max(
          this.syncedThroughSeq,
          this.store.cognitionJournalSeqForInbound?.(seq, this.cognitionEpoch) ?? 0,
        );
      }
    }
    this.startingJournalThroughSeq = 0;
    if (this.sessionPersistence && this.threadId) {
      this.store.setGlobalSession?.(this.threadId, this.policyHash, {
        runtime: this.runtime,
        epoch: this.cognitionEpoch,
        syncedThroughSeq: this.syncedThroughSeq,
      });
    }
    const wasPrime = Boolean(this.primeWaiter);
    if (this.primeWaiter) {
      const waiter = this.primeWaiter;
      this.primeWaiter = null;
      if (failed) waiter.reject(new Error(errorText || 'codex cognition catch-up failed'));
      else {
        this.syncedThroughSeq = waiter.syncedThroughSeq;
        waiter.resolve();
      }
    }
    if (failed && !wasPrime && this.onTurnFailed) {
      try {
        this.onTurnFailed(withReceiptIds(
          { inboundSeqs, error: errorText || '未知错误' },
          receipts,
        ));
      } catch (callbackError) {
        this.logger.warn('turn_failure_notify_failed', { error: safe(callbackError) });
      }
    }
    if (!failed && !wasPrime && this.onTurnSucceeded) {
      try {
        this.onTurnSucceeded(withReceiptIds({ inboundSeqs }, receipts));
      } catch (callbackError) {
        this.logger.warn('turn_success_notify_failed', { error: safe(callbackError) });
      }
    }
    this._drain();
    this._notifyAvailable();
  }

  // Start a turn with everything queued, if the connection is idle.
  _drain() {
    if (this.stopping || !this.child || !this.threadId) return;
    if (this.activeTurnId || this.startingTurn) return;
    if (this.queue.length === 0) return;
    this._claimBatch(this.queue.splice(0));
  }

  _scheduleDrain() {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this._drain();
      this._notifyAvailable();
    }, this.reconnectBaseMs);
    this.drainTimer.unref?.();
  }

  _flushQueue() {
    const items = this.queue.splice(0);
    for (let index = 0; index < items.length;) {
      const queuedBatchId = items[index].queuedBatchId;
      if (queuedBatchId === undefined) {
        this.deliver(items[index].text, items[index].seq, items[index].receiptId);
        index += 1;
        continue;
      }
      let end = index + 1;
      while (items[end]?.queuedBatchId === queuedBatchId) end += 1;
      this.deliverBatch(items.slice(index, end));
      index = end;
    }
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
      case 'item/started': {
        const type = params.item?.type;
        const modelOutput = ['reasoning', 'agentMessage', 'agent_message'].includes(type);
        this.modelWorking = modelOutput;
        this.modelStartedAtMs = modelOutput ? Date.now() : null;
        break;
      }
      case 'item/completed': {
        const item = params.item;
        if (['reasoning', 'agentMessage', 'agent_message'].includes(item?.type)) {
          this.modelWorking = false;
          this.modelStartedAtMs = null;
        }
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
          const larkDelivery = item?.type === 'mcpToolCall'
            && item.server === 'lark_daemon_im'
            && tool.metadata?.deliveryMode;
          const responseMessageId = larkDelivery
            ? item.arguments?.response_to_message_id
              ?? (['react_to_lark_message', 'reply_lark_message'].includes(item.tool)
                ? item.arguments?.message_id
                : item.arguments?.decision_message_id)
            : null;
          const resolvedSeq = responseMessageId
            ? this.store.inboundSeqForMessageId?.(responseMessageId)
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
          if (tool.status === 'SENT' && tool.metadata?.deliveryMode && this.onDeliverySucceeded) {
            try {
              this.onDeliverySucceeded({
                // response_to_message_id separates attribution from the latest
                // freshness fence. Fall back to the whole live turn only for
                // legacy tools (notably retract) that carry no decision id.
                inboundSeqs: resolvedSeq === null || resolvedSeq === undefined
                  ? associatedInboundSeqs
                  : [resolvedSeq],
                mode: tool.metadata.deliveryMode,
              });
            } catch (callbackError) {
              this.logger.warn('delivery_success_notify_failed', { error: safe(callbackError) });
            }
          }
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
      const resumable = (this.allowResume
        && global.sessionId
        && global.policyHash === this.policyHash
        && (global.runtime ?? 'codex') === this.runtime
        && (global.epoch || this.cognitionEpoch) === this.cognitionEpoch);
      if (resumable) this.syncedThroughSeq = global.syncedThroughSeq ?? this.syncedThroughSeq;
      this.storedThreadId = resumable ? global.sessionId : null;

      const args = [
        'app-server', '--listen', 'stdio://',
        '-c', `developer_instructions=${tomlString(this.developerInstructionsText)}`,
        // Fast mode is a Codex service tier. Pin both the tier and its stable
        // feature gate for this daemon-owned app-server process.
        '-c', 'service_tier="fast"',
        '-c', 'features.fast_mode=true',
        // The user's interactive ~/.codex config drags desktop-only machinery into
        // every turn: plugin marketplaces, <recommended_plugins> prompt injections,
        // plugin-suggestion tools, and multi-agent framing. None of it serves a
        // chat-reply agent, and it measurably costs prefill size plus whole model
        // round-trips (~2x wall time on short replies). Skills (~/.agents) and the
        // lark_daemon_im MCP server configured below are unaffected.
        '-c', 'features.plugins=false',
        '-c', 'features.tool_suggest=false',
        '-c', 'features.apps=false',
      ];
      // Proactive IM tools (list_lark_chats / send_lark_message) ride along as an
      // MCP stdio server so codex can send messages through a typed, validated path.
      if (this.config.profile) {
        const toolArgs = [
          this.config.larkToolServerPath,
          '--lark-cli-bin', this.config.larkCliBin,
          '--profile', this.config.profile,
          '--project-dir', this.config.projectDir,
          '--database-path', this.config.databasePath,
          '--temp-dir', this.config.tempDir,
          '--timeout-ms', String(this.config.sendTimeoutMs),
          '--max-text-chars', String(this.config.maxReplyChars),
          '--dry-run', String(Boolean(this.config.dryRun)),
          '--runtime-token', this.authorityToken,
        ];
        if (this.config.meetingAudio?.authoritySocketPath) {
          toolArgs.push(
            '--decision-authority-socket',
            this.config.meetingAudio.authoritySocketPath,
          );
        }
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
          env: sanitizeCodexEnv(process.env, this.config.profile),
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) { reject(error); return; }

      this.child = child;
      this.threadId = null;
      this.activeTurnId = null;
      this.startingTurn = false;
      this.modelWorking = false;
      this.modelStartedAtMs = null;
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
        if (this.sessionPersistence) {
          this.store.setGlobalSession(this.threadId, this.policyHash, {
            runtime: this.runtime,
            epoch: this.cognitionEpoch,
            syncedThroughSeq: this.syncedThroughSeq,
          });
        }
        this._flushQueue();
        this._notifyAvailable();
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

  // /m must not wait for a stuck turn: best-effort turn/interrupt on the live
  // turn, then abandon local turn state. The abandoned turn's inbound rows are
  // already in the cognition journal and the queue keeps undelivered items, so
  // no message is lost. Queued work is deliberately NOT flushed here — the
  // caller rotates or switches sessions and drains onto the new one.
  async interruptTurn() {
    if (!this.turnInProgress) return;
    const inboundSeqs = this._associatedInboundSeqs();
    const receipts = this._associatedReceiptIds();
    if (this.activeTurnId && this.child && this.threadId) {
      try {
        await this._request('turn/interrupt', {
          threadId: this.threadId,
          turnId: this.activeTurnId,
        });
      } catch { /* best effort; the session is being replaced */ }
    }
    // ponytail: an in-flight turn/start (startingTurn) has no id to interrupt
    // yet; like rotateSession, that turn runs out abandoned.
    this.activeTurnId = null;
    this.startingTurn = false;
    this.modelWorking = false;
    this.modelStartedAtMs = null;
    this.startingItems = [];
    this.startingJournalThroughSeq = 0;
    this.activeInboundSeqs = [];
    this.activeReceiptIds = [];
    if ((inboundSeqs.length > 0 || receipts.length > 0) && this.onTurnAbandoned) {
      try { this.onTurnAbandoned(withReceiptIds({ inboundSeqs }, receipts)); } catch (error) {
        this.logger.warn('turn_abandoned_notify_failed', { error: safe(error) });
      }
    }
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
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
    const abandonedInboundSeqs = this._associatedInboundSeqs();
    const abandonedReceiptIds = this._associatedReceiptIds();
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
    this.modelWorking = false;
    this.modelStartedAtMs = null;
    this.startingItems = [];
    this.startingJournalThroughSeq = 0;
    this.activeInboundSeqs = [];
    this.activeReceiptIds = [];
    if ((abandonedInboundSeqs.length > 0 || abandonedReceiptIds.length > 0)
      && this.onTurnAbandoned) {
      try {
        this.onTurnAbandoned(withReceiptIds(
          { inboundSeqs: abandonedInboundSeqs },
          abandonedReceiptIds,
        ));
      } catch (error) {
        this.logger.warn('turn_abandoned_notify_failed', { error: safe(error) });
      }
    }
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
    if (this.sessionPersistence) {
      this.store.setGlobalSession(this.threadId, this.policyHash, {
        runtime: this.runtime,
        epoch: this.cognitionEpoch,
        syncedThroughSeq: this.syncedThroughSeq,
      });
    }
    this._recordActivity('agent.session_rotated', {
      summary: resume ? '会话参数已更新' : '已开启新会话',
      metadata: { resume },
    });
    this._drain();
    this._notifyAvailable();
    return this.threadId;
  }

  // Clears connection state for a child we are intentionally replacing, without
  // entering the reconnect loop (unlike _handleExit on an unexpected death).
  _handleExitDetached(child) {
    if (this.child !== child) return;
    this.child = null;
    this.threadId = null;
    this.activeTurnId = null;
    this.startingTurn = false;
    this.modelWorking = false;
    this.modelStartedAtMs = null;
    this.startingItems = [];
    this.startingJournalThroughSeq = 0;
    this.activeInboundSeqs = [];
    this.activeReceiptIds = [];
    for (const pending of this.pending.values()) {
      try { pending.reject(new Error('codex connection replaced')); } catch { /* ignore */ }
    }
    this.pending.clear();
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
    // An unacknowledged turn/start rejects below and its closure requeues the
    // original items. Only a receipt already owned by a live turn is terminal.
    const failedInboundSeqs = [...this.activeInboundSeqs];
    const failedReceiptIds = [...this.activeReceiptIds];
    this.child = null;
    this.threadId = null;
    this.activeTurnId = null;
    this.startingTurn = false;
    this.modelWorking = false;
    this.modelStartedAtMs = null;
    this.startingItems = [];
    this.startingJournalThroughSeq = 0;
    this.activeInboundSeqs = [];
    this.activeReceiptIds = [];
    for (const pending of this.pending.values()) {
      try { pending.reject(new Error('codex connection lost')); } catch { /* ignore */ }
    }
    this.pending.clear();
    if (!this.stopping && failedReceiptIds.length > 0 && this.onTurnFailed) {
      try {
        this.onTurnFailed(withReceiptIds({
          inboundSeqs: failedInboundSeqs,
          error: 'codex connection lost',
        }, failedReceiptIds));
      } catch (error) {
        this.logger.warn('turn_failure_notify_failed', { error: safe(error) });
      }
    }
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

  _notifyAvailable() {
    if (this.turnInProgress
      || this.queue.length > 0
      || !this.state.connected) return;
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
    if (!this.onAvailable) return;
    try {
      this.onAvailable();
    } catch (error) {
      this.logger.warn('codex_available_callback_failed', { error: safe(error) });
    }
  }

  async stop() {
    this.stopping = true;
    const failedItems = [
      ...this.startingItems,
      ...this.queue,
      ...this.activeReceiptIds.map((receiptId) => ({ receiptId })),
    ];
    const failedReceiptIds = receiptIds(failedItems);
    if (failedReceiptIds.length > 0 && this.onTurnFailed) {
      const inboundSeqs = [...new Set([
        ...this._associatedInboundSeqs(),
        ...this.queue.map((item) => item.seq).filter((seq) => seq != null),
      ])];
      try {
        this.onTurnFailed(withReceiptIds({
          inboundSeqs,
          error: 'codex stopped before turn completion',
        }, failedReceiptIds));
      } catch (error) {
        this.logger.warn('turn_failure_notify_failed', { error: safe(error) });
      }
    }
    this.queue = [];
    this.startingItems = [];
    this.activeInboundSeqs = [];
    this.activeReceiptIds = [];
    if (this.primeWaiter) {
      this.primeWaiter.reject(new Error('codex stopped during cognition catch-up'));
      this.primeWaiter = null;
    }
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
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
