import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cognitionHistoryPrefix, CognitionLimitError } from './cognition.mjs';
import { redactSensitive } from './logger.mjs';
import { terminateProcessTree } from './process-utils.mjs';
import { loadSystemPrompt, loadSystemPromptDetail } from './config.mjs';

const MAX_LINE_BYTES = 5_000_000;
const START_TIMEOUT_MS = 5_000;
const START_STABILITY_MS = 250;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

export const CLAUDE_MODELS = [
  'sonnet',
  'opus',
  'haiku',
  'fable',
];
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safe(error) {
  return redactSensitive(error instanceof Error ? error.message : String(error));
}

function appendBounded(current, chunk, label) {
  const next = current + chunk;
  if (Buffer.byteLength(next, 'utf8') > MAX_LINE_BYTES) {
    throw new Error(`claude ${label} exceeded local limit`);
  }
  return next;
}

export function sanitizeClaudeEnv(environment) {
  const safeEnv = { ...environment, FORCE_COLOR: '0', NO_COLOR: '1' };
  for (const key of Object.keys(safeEnv)) {
    if (/^(?:LARK|FEISHU)_/i.test(key) || key === 'CLAUDECODE') delete safeEnv[key];
  }
  return safeEnv;
}

// Persistent Anthropic stream-json adapter, adapted from zouk-daemon v0.6.0's
// MIT-licensed Claude driver. The daemon-specific state machine below keeps one
// global runtime, journal cursor, and Lark authority fence; it does not reuse
// Zouk's per-agent/server topology.
export class ClaudeAgent {
  constructor(config, store, logger, options = {}) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this._spawn = options.spawn ?? nodeSpawn;
    this.onTurnFailed = options.onTurnFailed ?? null;
    this.onTurnSucceeded = options.onTurnSucceeded ?? null;
    this.onAvailable = options.onAvailable ?? null;
    this.startTimeoutMs = options.startTimeoutMs ?? START_TIMEOUT_MS;
    this.startStabilityMs = options.startStabilityMs ?? START_STABILITY_MS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS;
    this.reconnectCapMs = options.reconnectCapMs ?? RECONNECT_CAP_MS;

    const cognition = store.getCognitionState?.()
      ?? { runtime: 'claude', epoch: 1, authorityToken: null };
    this.runtime = 'claude';
    this.cognitionEpoch = options.cognitionEpoch ?? cognition.epoch;
    this.authorityToken = options.authorityToken ?? cognition.authorityToken ?? '';
    this.sessionPersistence = options.sessionPersistence !== false;
    this.autoReconnect = this.sessionPersistence;
    this.allowResume = options.allowResume !== false;
    this.syncedThroughSeq = options.syncedThroughSeq ?? 0;
    this.deliveredThroughSeq = this.syncedThroughSeq;

    this.systemPrompt = loadSystemPrompt(config);
    this.developerInstructionsText = `${this.systemPrompt.trim()}\n\nDaemon-authenticated: lark-cli profile is ${config.profile}`;
    this.model = options.model ?? store.getSetting?.('claude_model') ?? config.claudeModel ?? '';
    this.effort = store.getSetting?.('claude_effort') ?? config.claudeEffort ?? 'medium';

    this.sessionId = null;
    this.sessionInitialized = false;
    this.resumeRequested = false;
    this.needsHistoryPrefix = false;
    this.child = null;
    this.connected = false;
    this.turnActive = false;
    this.turnStartedAtMs = null;
    this.modelWorking = false;
    this.modelStartedAtMs = null;
    this.turnError = null;
    this.activeItems = [];
    this.queue = [];
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.stopping = false;
    this.startedOk = false;
    this.reconnecting = false;
    this.backoffMs = this.reconnectBaseMs;
    this.activitySeq = 0;
    this.idleWaiters = [];
    this.mcpTempDir = null;
  }

  get threadId() { return this.sessionId; }

  get policyHash() {
    return createHash('sha256')
      .update(this.developerInstructionsText).update('\0')
      .update(this.config.workspace).update('\0')
      .update('claude-stream-json-v1').digest('hex');
  }

  get state() {
    return {
      connected: this.connected,
      activeTurn: this.turnActive ? 1 : 0,
      queued: this.queue.reduce((count, batch) => count + batch.length, 0),
    };
  }

  get turnInProgress() { return this.turnActive; }

  get sessionDescriptor() {
    return {
      runtime: this.runtime,
      sessionId: this.sessionId,
      policyHash: this.policyHash,
      epoch: this.cognitionEpoch,
      syncedThroughSeq: this.syncedThroughSeq,
      sessionReady: this.sessionInitialized,
    };
  }

  activateSession() {
    this.sessionPersistence = true;
    this.autoReconnect = true;
  }

  async start() {
    this.stopping = false;
    const global = this.store.getGlobalSession?.() ?? {};
    const resumable = this.allowResume
      && global.sessionId
      && global.sessionReady !== false
      && global.policyHash === this.policyHash
      && global.runtime === this.runtime
      && global.epoch === this.cognitionEpoch;
    this.sessionId = resumable ? global.sessionId : randomUUID();
    this.sessionInitialized = Boolean(resumable);
    this.resumeRequested = Boolean(resumable);
    this.syncedThroughSeq = resumable ? global.syncedThroughSeq ?? 0 : this.syncedThroughSeq;
    this.deliveredThroughSeq = this.syncedThroughSeq;
    this.needsHistoryPrefix = !resumable;

    await this._preflight();
    await this._spawnPersistent();
    this.startedOk = true;
    this.backoffMs = this.reconnectBaseMs;
    this._persistSession();
    this._drain();
    this._notifyAvailable();
  }

  async _preflight() {
    const version = await this._probe(['--version']);
    if (!/Claude Code/i.test(version.stdout)) {
      throw new Error('claude preflight returned an unrecognised version');
    }
    const help = await this._probe(['--help']);
    for (const flag of [
      '--input-format', '--output-format', '--resume', '--session-id', '--mcp-config',
      '--dangerously-skip-permissions', '--disallowed-tools', '--effort',
      '--append-system-prompt', '--no-chrome', '--model', '--print',
    ]) {
      if (!help.stdout.includes(flag)) {
        throw new Error(`claude preflight is missing required flag ${flag}`);
      }
    }
    const auth = await this._probe(['auth', 'status', '--json']);
    let status;
    try { status = JSON.parse(auth.stdout); } catch {
      throw new Error('claude auth status returned invalid JSON');
    }
    if (status?.loggedIn !== true) throw new Error('claude is not logged in');
  }

  _probe(args) {
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = this._spawn(this.config.claudeBin, args, {
          cwd: this.config.workspace,
          env: sanitizeClaudeEnv(process.env),
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) { reject(error); return; }
      let stdout = '';
      let stderr = '';
      let outputError = null;
      let settled = false;
      const finish = (error, result = null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => {
        terminateProcessTree(child, 'SIGKILL');
        finish(new Error(`claude preflight timed out: ${args.join(' ')}`));
      }, this.startTimeoutMs);
      timer.unref?.();
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        try { stdout = appendBounded(stdout, chunk, 'preflight output'); } catch (error) {
          outputError = error;
          terminateProcessTree(child, 'SIGKILL');
        }
      });
      child.stderr?.on('data', (chunk) => {
        try { stderr = appendBounded(stderr, chunk, 'preflight error'); } catch (error) {
          outputError = error;
          terminateProcessTree(child, 'SIGKILL');
        }
      });
      child.once('error', (error) => finish(error));
      child.once('exit', (code) => {
        if (outputError) { finish(outputError); return; }
        if (code === 0) finish(null, { stdout, stderr });
        else finish(new Error(`claude preflight failed: ${safe(stderr || stdout || `exit ${code}`)}`));
      });
    });
  }

  _writeMcpConfig() {
    this._cleanupMcpConfig();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-daemon-claude-mcp-'));
    try { fs.chmodSync(directory, 0o700); } catch {}
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
    const configPath = path.join(directory, 'mcp-config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        lark_daemon_im: { command: process.execPath, args: toolArgs },
      },
    }), { encoding: 'utf8', mode: 0o600 });
    this.mcpTempDir = directory;
    return configPath;
  }

  _cleanupMcpConfig() {
    const directory = this.mcpTempDir;
    this.mcpTempDir = null;
    if (!directory) return;
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch {}
  }

  _spawnPersistent() {
    return new Promise((resolve, reject) => {
      const mcpConfigPath = this._writeMcpConfig();
      const args = [
        '--print',
        '--dangerously-skip-permissions',
        '--verbose',
        '--output-format', 'stream-json',
        '--input-format', 'stream-json',
        // No --strict-mcp-config: user-scope and plugin MCP servers (e.g. the
        // openviking-memory plugin's OV proxy) load alongside lark_daemon_im.
        '--mcp-config', mcpConfigPath,
        '--disallowed-tools', 'EnterPlanMode,ExitPlanMode',
        '--append-system-prompt', this.developerInstructionsText,
        '--effort', this.effort,
        '--no-chrome',
      ];
      if (this.model) args.push('--model', this.model);
      if (this.resumeRequested && this.sessionInitialized) args.push('--resume', this.sessionId);
      else args.push('--session-id', this.sessionId);

      let child;
      try {
        child = this._spawn(this.config.claudeBin, args, {
          cwd: this.config.workspace,
          env: sanitizeClaudeEnv(process.env),
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (error) {
        this._cleanupMcpConfig();
        reject(error);
        return;
      }

      this.child = child;
      this.stdoutBuffer = '';
      this.stderrBuffer = '';
      let spawned = false;
      let ready = false;
      let settled = false;
      let stabilityTimer = null;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.child = null;
        terminateProcessTree(child, 'SIGKILL');
        this._cleanupMcpConfig();
        reject(new Error('claude stream-json process start timed out'));
      }, this.startTimeoutMs);
      timer.unref?.();

      const failStart = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (stabilityTimer) clearTimeout(stabilityTimer);
        this.child = null;
        this.connected = false;
        this._cleanupMcpConfig();
        reject(error);
      };

      child.stdin?.on('error', (error) => {
        if (this.child === child) this.logger.warn('claude_stdin_error', { error: safe(error) });
      });
      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('data', (chunk) => {
        if (this.child === child) this._onStdout(chunk, child);
      });
      child.stderr?.on('data', (chunk) => {
        if (this.child === child) this._onStderr(chunk);
      });
      child.once('spawn', () => {
        if (settled) return;
        spawned = true;
        // spawn only proves exec(2) succeeded. Hold a short no-input window so
        // invalid model/flag combinations can fail before the authority commit.
        stabilityTimer = setTimeout(() => {
          if (settled || child.exitCode !== null) return;
          ready = true;
          settled = true;
          clearTimeout(timer);
          this.connected = true;
          resolve();
        }, this.startStabilityMs);
      });
      child.once('error', (error) => {
        if (!ready) failStart(error);
        else this._handleExit(child, null, null, error);
      });
      child.once('exit', (code, signal) => {
        if (!ready) {
          failStart(new Error(`claude exited during startup (code ${code}, signal ${signal})`));
          return;
        }
        this._handleExit(child, code, signal);
      });
    });
  }

  deliver(text, seq = null) { return this.deliverBatch([{ text, seq }]); }

  deliverBatch(items) {
    if (this.stopping || !Array.isArray(items) || items.length === 0) return false;
    const batch = items.map(({ text, seq = null }) => ({ text, seq }));
    if (!this.connected || !this.child?.stdin?.writable) {
      this.queue.push(batch);
      return true;
    }
    this._writeBatch(batch);
    return true;
  }

  tryStartBatch(items) {
    if (this.stopping || !this.connected || this.turnActive || this.queue.length > 0
      || !Array.isArray(items) || items.length === 0) return false;
    this._writeBatch(items.map(({ text, seq = null }) => ({ text, seq })));
    return true;
  }

  whenIdle() {
    if (!this.turnActive && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  primeCognition(text, syncedThroughSeq) {
    void text;
    void syncedThroughSeq;
    return Promise.reject(new Error('standalone cognition catch-up is disabled; prefix the first real turn'));
  }

  _bodyFor(items) {
    const seqs = items.map((item) => item.seq).filter((seq) => seq != null);
    const beforeSeq = seqs.length > 0 ? Math.min(...seqs) : null;
    const throughSeq = this.store.cognitionJournalBeforeInbound?.(
      beforeSeq,
      this.cognitionEpoch,
    ) ?? 0;
    const needsCatchup = this.needsHistoryPrefix || throughSeq > this.deliveredThroughSeq;
    let body = items.map((item) => item.text).join('\n');
    let prefixThroughSeq = this.deliveredThroughSeq;
    if (needsCatchup && this.store.cognitionJournal && this.store.cognitionJournalBeforeInbound) {
      const catchup = cognitionHistoryPrefix(
        this.store,
        this.cognitionEpoch,
        throughSeq,
        this.config.cognitionMaxChars,
        this.needsHistoryPrefix ? 0 : this.deliveredThroughSeq,
      );
      prefixThroughSeq = catchup.throughSeq;
      body = `${catchup.text}\n${body}`;
    }
    let deliveredThroughSeq = prefixThroughSeq;
    for (const seq of seqs) {
      deliveredThroughSeq = Math.max(
        deliveredThroughSeq,
        this.store.cognitionJournalSeqForInbound?.(seq, this.cognitionEpoch) ?? 0,
      );
    }
    return { body, seqs, deliveredThroughSeq };
  }

  _writeBatch(items) {
    let prepared;
    try {
      prepared = this._bodyFor(items);
    } catch (error) {
      this._failItems(items, error);
      return;
    }
    const message = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: prepared.body }] },
    };
    if (this.sessionInitialized || this.resumeRequested) message.session_id = this.sessionId;

    const wasActive = this.turnActive;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this._failItems(items, error);
      return;
    }
    this.needsHistoryPrefix = false;
    this.deliveredThroughSeq = Math.max(this.deliveredThroughSeq, prepared.deliveredThroughSeq);
    this.activeItems.push(...items);
    this.turnActive = true;
    if (!wasActive) this.turnStartedAtMs = Date.now();
    if (!wasActive) {
      this.modelWorking = true;
      this.modelStartedAtMs = this.turnStartedAtMs;
    }
    this._recordActivity(wasActive ? 'agent.steered' : 'agent.turn_started', {
      inboundSeq: prepared.seqs.at(-1) ?? null,
      metadata: { runtime: 'claude', inboundSeqs: prepared.seqs },
    });
  }

  _onStdout(chunk, child) {
    try { this.stdoutBuffer = appendBounded(this.stdoutBuffer, chunk, 'stdout line'); } catch (error) {
      this.turnError = error;
      terminateProcessTree(child, 'SIGKILL');
      return;
    }
    let index;
    while ((index = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, index);
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (!line.trim()) continue;
      try { this._handleLine(line); } catch (error) {
        this.logger.warn('claude_line_error', { error: safe(error) });
      }
    }
  }

  _onStderr(chunk) {
    try { this.stderrBuffer = appendBounded(this.stderrBuffer, chunk, 'stderr line'); } catch {
      this.stderrBuffer = this.stderrBuffer.slice(-4_000);
    }
    let index;
    while ((index = this.stderrBuffer.indexOf('\n')) >= 0) {
      const line = this.stderrBuffer.slice(0, index);
      this.stderrBuffer = this.stderrBuffer.slice(index + 1);
      if (line.trim()) this.logger.debug('claude_stderr', { detail: safe(line.slice(0, 500)) });
    }
  }

  _handleLine(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;

    if (message.type === 'system' && message.subtype === 'init') {
      const sessionId = message.session_id ?? message.sessionId;
      if (typeof sessionId === 'string' && sessionId) {
        this.sessionId = sessionId;
        this.sessionInitialized = true;
        this.resumeRequested = true;
        this._persistSession();
      }
      return;
    }

    if (message.type === 'assistant') {
      const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
      for (const block of blocks) {
        if (!block || typeof block !== 'object') continue;
        if (['thinking', 'text'].includes(block.type) && !this.modelWorking) {
          this.modelWorking = true;
          this.modelStartedAtMs = Date.now();
        }
        if (block.type === 'thinking') {
          // Hidden thinking is intentionally not persisted into the daemon journal.
          this._recordActivity('agent.thinking', {
            inboundSeq: this._activeSeqs().at(-1) ?? null,
            metadata: { runtime: 'claude' },
          });
        } else if (block.type === 'text' && block.text) {
          // Telemetry only. Claude must call the Lark MCP tool to deliver text.
          this._recordActivity('agent.note', {
            inboundSeq: this._activeSeqs().at(-1) ?? null,
            summary: String(block.text),
            metadata: { runtime: 'claude', delivery: 'telemetry_only' },
          });
        } else if (block.type === 'tool_use') {
          this.modelWorking = false;
          this.modelStartedAtMs = null;
          this._recordActivity('agent.tool_called', {
            inboundSeq: this._activeSeqs().at(-1) ?? null,
            summary: String(block.name ?? 'unknown tool'),
            metadata: { runtime: 'claude', toolId: block.id },
          });
        }
      }
      return;
    }

    if (message.type === 'user') {
      const blocks = Array.isArray(message.message?.content) ? message.message.content : [];
      for (const block of blocks) {
        if (block?.type !== 'tool_result') continue;
        this._recordActivity('agent.tool_completed', {
          inboundSeq: this._activeSeqs().at(-1) ?? null,
          status: block.is_error === true ? 'FAILED' : 'COMPLETED',
          summary: block.is_error === true ? 'Claude tool failed' : 'Claude tool completed',
          metadata: { runtime: 'claude', toolId: block.tool_use_id },
        });
      }
      if (blocks.some((block) => block?.type === 'tool_result')) {
        this.modelWorking = true;
        this.modelStartedAtMs = Date.now();
      }
      return;
    }

    if (message.type === 'result') {
      const subtype = typeof message.subtype === 'string' ? message.subtype : '';
      let error = this.turnError;
      if (!error && subtype && subtype !== 'success') {
        const details = Array.isArray(message.errors) ? message.errors.filter(Boolean).join(' | ') : '';
        error = new Error(details || String(message.result || `Claude error: ${subtype}`));
      }
      // Claude CLI reports some hard failures (usage/session limits, API
      // errors) as subtype "success" with is_error=true. Treating them as
      // completed turns silently swallowed every failure notice.
      if (!error && message.is_error === true) {
        error = new Error(String(message.result || 'Claude error result'));
      }
      this.turnError = null;
      this._completeTurn(error);
    }
  }

  _activeSeqs() {
    return [...new Set(
      this.activeItems.map((item) => item.seq).filter((seq) => seq != null),
    )];
  }

  _completeTurn(error = null) {
    const items = this.activeItems.splice(0);
    const seqs = [...new Set(items.map((item) => item.seq).filter((seq) => seq != null))];
    this.turnActive = false;
    this.turnStartedAtMs = null;
    this.modelWorking = false;
    this.modelStartedAtMs = null;
    if (!error) {
      this.syncedThroughSeq = Math.max(this.syncedThroughSeq, this.deliveredThroughSeq);
      this._persistSession();
    } else {
      // A failed result is not a durable acknowledgement of the journal
      // prefix. Recompute the missing delta before the next real turn.
      this.deliveredThroughSeq = this.syncedThroughSeq;
    }
    this._recordActivity('agent.turn_completed', {
      inboundSeq: seqs.at(-1) ?? null,
      status: error ? 'failed' : 'completed',
      summary: error ? safe(error) : undefined,
      metadata: { runtime: 'claude', inboundSeqs: seqs },
    });
    if (error && this.onTurnFailed) {
      try { this.onTurnFailed({ inboundSeqs: seqs, error: safe(error) }); } catch {}
    }
    if (!error && this.onTurnSucceeded) {
      try { this.onTurnSucceeded({ inboundSeqs: seqs }); } catch {}
    }
    this._drain();
    this._notifyAvailable();
  }

  _failItems(items, error) {
    const seqs = items.map((item) => item.seq).filter((seq) => seq != null);
    this._recordActivity('agent.turn_completed', {
      inboundSeq: seqs.at(-1) ?? null,
      status: 'failed',
      summary: safe(error),
      metadata: {
        runtime: 'claude',
        inboundSeqs: seqs,
        terminal: error instanceof CognitionLimitError,
      },
    });
    if (this.onTurnFailed) {
      try { this.onTurnFailed({ inboundSeqs: seqs, error: safe(error) }); } catch {}
    }
    this._notifyAvailable();
  }

  _drain() {
    if (this.stopping || !this.connected || !this.child?.stdin?.writable) return;
    while (this.queue.length > 0) this._writeBatch(this.queue.shift());
  }

  _persistSession() {
    if (!this.sessionPersistence || !this.sessionId) return;
    try {
      this.store.setGlobalSession?.(this.sessionId, this.policyHash, {
        runtime: this.runtime,
        epoch: this.cognitionEpoch,
        syncedThroughSeq: this.syncedThroughSeq,
        sessionReady: this.sessionInitialized,
      });
    } catch (error) {
      this.logger.warn('claude_session_persist_failed', { error: safe(error) });
    }
  }

  _handleExit(child, code, signal, processError = null) {
    if (this.child !== child) return;
    this.child = null;
    this.connected = false;
    this._cleanupMcpConfig();
    const wasActive = this.turnActive;
    const items = this.activeItems.splice(0);
    this.turnActive = false;
    this.turnStartedAtMs = null;
    this.modelWorking = false;
    this.modelStartedAtMs = null;
    this.deliveredThroughSeq = this.syncedThroughSeq;
    this.needsHistoryPrefix = !this.sessionInitialized;
    if (!this.sessionInitialized && !this.stopping && this.startedOk && this.autoReconnect) {
      // Claude may have partially created a transcript before emitting
      // system/init. Reusing the preassigned UUID with --session-id can then
      // collide forever, so every pre-init reconnect gets a fresh identity.
      this.sessionId = randomUUID();
      this.resumeRequested = false;
    }
    if (wasActive) {
      this._failItems(items, processError ?? this.turnError
        ?? new Error(`claude connection lost (code ${code}, signal ${signal})`));
    }
    this.turnError = null;
    if (this.stopping || !this.startedOk || !this.autoReconnect) {
      this._resolveIdleWaiters();
      return;
    }
    this.logger.warn('claude_disconnected', { code, signal, error: processError ? safe(processError) : undefined });
    void this._reconnectLoop();
  }

  async _reconnectLoop() {
    if (this.reconnecting || this.stopping) return;
    this.reconnecting = true;
    while (!this.stopping && !this.connected) {
      await delay(this.backoffMs);
      if (this.stopping) break;
      this.resumeRequested = this.sessionInitialized;
      try {
        await this._spawnPersistent();
        this.backoffMs = this.reconnectBaseMs;
        this._drain();
        this._notifyAvailable();
        break;
      } catch (error) {
        this.logger.warn('claude_reconnect_failed', { error: safe(error), backoffMs: this.backoffMs });
        this.backoffMs = Math.min(this.backoffMs * 2, this.reconnectCapMs);
      }
    }
    this.reconnecting = false;
  }

  async _replaceProcess({ fresh }) {
    await this._terminateCurrent();
    if (fresh) {
      this.sessionId = randomUUID();
      this.sessionInitialized = false;
      this.resumeRequested = false;
    } else {
      this.resumeRequested = this.sessionInitialized;
    }
    await this._spawnPersistent();
    this._persistSession();
    this._drain();
    this._notifyAvailable();
  }

  // /m must not wait for a stuck turn: kill the in-flight turn's process. The
  // abandoned items' inbound rows stay in the cognition journal; queued batches
  // survive in this.queue and are written after the next respawn. Intentional
  // abandonment, so onTurnFailed is not raised for the interrupted items.
  async interruptTurn() {
    if (!this.turnActive) return;
    this.activeItems.splice(0);
    this.turnActive = false;
    this.turnStartedAtMs = null;
    this.modelWorking = false;
    this.modelStartedAtMs = null;
    this.turnError = null;
    this.deliveredThroughSeq = this.syncedThroughSeq;
    await this._terminateCurrent();
    this._resolveIdleWaiters();
  }

  async rotateSession({ resume = false } = {}) {
    if (this.turnActive) throw new Error('claude session rotation requires an idle runtime');
    if (resume) {
      await this._replaceProcess({ fresh: false });
      return this.sessionId;
    }
    this.syncedThroughSeq = 0;
    this.deliveredThroughSeq = 0;
    this.needsHistoryPrefix = false;
    await this._replaceProcess({ fresh: true });
    return this.sessionId;
  }

  // /restart: re-read the kernel from disk. --append-system-prompt rides on the
  // child's spawn args, so the fresh text applies when the caller rotates to a
  // fresh session (rotateSession respawns the process).
  async reloadSystemPrompt() {
    const detail = loadSystemPromptDetail(this.config);
    this.systemPrompt = detail.text;
    this.developerInstructionsText = `${this.systemPrompt.trim()}\n\nDaemon-authenticated: lark-cli profile is ${this.config.profile}`;
    return detail;
  }

  async setModel(model) {
    await this.whenIdle();
    this.model = model;
    this.store.setSetting?.('claude_model', model);
    if (this.connected) await this._replaceProcess({ fresh: false });
  }

  setEffort(effort) {
    this.effort = effort;
    this.store.setSetting?.('claude_effort', effort);
  }

  async listModels() {
    return CLAUDE_MODELS.map((id) => ({ id, efforts: CLAUDE_EFFORTS }));
  }

  _recordActivity(kind, fields = {}) {
    try {
      this.activitySeq += 1;
      this.store.recordActivity?.({
        eventKey: `claude:${this.sessionId ?? 'na'}:${kind}:${this.activitySeq}`,
        kind,
        summary: fields.summary,
        status: fields.status,
        inboundSeq: fields.inboundSeq,
        metadata: fields.metadata,
      });
    } catch (error) {
      this.logger.warn('activity_persist_failed', { kind, error: safe(error) });
    }
  }

  _resolveIdleWaiters() {
    const waiters = this.idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  _notifyAvailable() {
    if (this.turnActive || this.queue.length > 0 || !this.connected) return;
    this._resolveIdleWaiters();
    try { this.onAvailable?.(); } catch (error) {
      this.logger.warn('claude_available_callback_failed', { error: safe(error) });
    }
  }

  async _terminateCurrent() {
    const child = this.child;
    this.child = null;
    this.connected = false;
    if (!child || child.exitCode !== null) {
      this._cleanupMcpConfig();
      return;
    }
    const exited = new Promise((resolve) => child.once('exit', resolve));
    terminateProcessTree(child, 'SIGTERM');
    await Promise.race([
      exited,
      delay(3_000),
    ]);
    terminateProcessTree(child, 'SIGKILL');
    this._cleanupMcpConfig();
  }

  async stop() {
    this.stopping = true;
    this.autoReconnect = false;
    this.queue = [];
    const items = this.activeItems.splice(0);
    this.turnActive = false;
    if (items.length > 0) this._failItems(items, new Error('claude stopped during an active turn'));
    this._resolveIdleWaiters();
    await this._terminateCurrent();
  }
}
