import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { sanitizeNonArkChildEnv, terminateProcessTree } from '../process-utils.mjs';
import { safeError } from '../logger.mjs';
import { connectorManifest, parseProtocolLine, requestMessage } from './protocol.mjs';

const defaultWorkerPath = fileURLToPath(new URL('./worker.mjs', import.meta.url));

function appendTail(current, chunk, limit = 8_000) {
  const next = current + chunk;
  return next.length <= limit ? next : next.slice(-limit);
}

function childConfig(config, connector) {
  return {
    channel: connector,
    projectDir: config.projectDir,
    dataDir: config.dataDir,
    tempDir: config.tempDir,
    profile: config.profile,
    larkCliBin: config.larkCliBin,
    weixinAllowFrom: [...(config.weixinAllowFrom ?? [])],
    weixinLongPollTimeoutMs: config.weixinLongPollTimeoutMs,
    retentionMs: config.retentionMs,
    maxEventBytes: config.maxEventBytes,
    sendTimeoutMs: config.sendTimeoutMs,
    dryRun: config.dryRun,
    logLevel: config.logLevel,
  };
}

export class ConnectorProcess {
  constructor(id, config, registry, logger) {
    this.id = id;
    this.config = config;
    this.registry = registry;
    this.logger = logger;
    this.child = null;
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.pending = new Map();
    this.manifest = null;
    this.profile = id === 'lark' ? config.profile : null;
    this.checked = false;
    this.started = false;
    this.stopping = false;
    this.onEvent = null;
    this.onUnexpectedExit = null;
  }

  spawn() {
    if (this.child) return;
    const workerPath = this.config.connectorWorkerPath || defaultWorkerPath;
    const env = sanitizeNonArkChildEnv(process.env);
    env.PERSONAL_AGENT_CONNECTOR_CONFIG = JSON.stringify(childConfig(this.config, this.id));
    const child = this.registry.register(spawn(process.execPath, [workerPath, this.id], {
      cwd: this.config.projectDir,
      env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    }));
    this.child = child;
    child.stdin?.on('error', () => {});
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => this.handleStdout(chunk));
    child.stderr?.on('data', (chunk) => {
      this.stderrTail = appendTail(this.stderrTail, chunk);
    });
    child.once('error', (error) => this.failPending(error));
    child.once('exit', (code, signal) => {
      const wasStopping = this.stopping;
      this.child = null;
      this.started = false;
      const error = new Error(
        `connector ${this.id} exited ${code ?? signal ?? 'unknown'}${this.stderrTail ? `: ${this.stderrTail.trim().slice(-2_000)}` : ''}`,
      );
      this.failPending(error);
      if (!wasStopping) {
        terminateProcessTree(child, 'SIGKILL');
        this.onUnexpectedExit?.({ code, signal, stderr: safeError(error) });
      }
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.trim()) this.handleLine(line);
    }
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.config.maxEventBytes) {
      this.logger.error('connector_protocol_line_oversize', { connector: this.id });
      terminateProcessTree(this.child, 'SIGKILL');
    }
  }

  handleLine(line) {
    let message;
    try { message = parseProtocolLine(line); } catch (error) {
      this.logger.warn('connector_protocol_invalid', { connector: this.id, error: safeError(error) });
      return;
    }
    if (message.type === 'RESULT') {
      const pending = this.pending.get(message.request_id);
      if (!pending) return;
      this.pending.delete(message.request_id);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || `connector ${this.id} request failed`));
      return;
    }
    if (message.type === 'EVENT') {
      if (message.connector !== this.id || message.instance !== this.id) {
        this.logger.warn('connector_event_invalid', { connector: this.id });
        return;
      }
      this.onEvent?.(message);
      return;
    }
    if (message.type === 'STATUS' && message.status === 'failed' && !this.stopping) {
      this.logger.error('connector_reported_failure', {
        connector: this.id,
        error: message.detail?.error,
      });
    }
  }

  failPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  request(operation, payload = {}, timeoutMs = 30_000) {
    this.spawn();
    const message = requestMessage(operation, payload);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.id);
        reject(new Error(`connector ${this.id} ${operation} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(message.id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(message.id);
        reject(error);
      }
    });
  }

  async preflight() {
    const spec = await this.request('spec', {}, 10_000);
    this.manifest = connectorManifest(spec?.manifest);
    if (this.manifest.name !== this.id) throw new Error(`connector spec name mismatch: ${this.id}`);
    const checked = await this.request('check', {}, 30_000);
    this.checked = true;
    this.profile = checked?.profile || this.profile;
    return {
      profile: this.profile,
      version: checked?.version || this.manifest.version,
      manifest: this.manifest,
    };
  }

  async startSubscription(onEvent, onUnexpectedExit) {
    if (!this.checked) throw new Error(`connector ${this.id} has not passed preflight`);
    this.onEvent = onEvent;
    this.onUnexpectedExit = onUnexpectedExit;
    await this.request('start', {}, 10_000);
    this.started = true;
  }

  get subscriptionRunning() {
    return Boolean(this.started && this.child && this.child.exitCode === null);
  }

  invoke(name, input, timeoutMs = this.config.sendTimeoutMs ?? 30_000) {
    return this.request('action', { name, input }, timeoutMs);
  }

  async pauseSubscription() {
    if (!this.started || !this.child) return;
    await this.request('pause', {}, 5_000);
    this.started = false;
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    try { await this.request('stop', {}, 5_000); } catch {}
    if (child.exitCode === null) {
      terminateProcessTree(child, 'SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
    terminateProcessTree(child, 'SIGKILL');
  }
}

export class ConnectorManager {
  constructor(config, registry, logger) {
    this.config = config;
    this.logger = logger;
    this.connectors = new Map((config.connectors ?? [config.channel]).map((id) => [
      id,
      new ConnectorProcess(id, config, registry, logger.child({ connector: id })),
    ]));
    this.profile = config.profile || null;
  }

  connector(id) {
    const connector = this.connectors.get(id);
    if (!connector) throw new Error(`connector is not configured: ${id}`);
    return connector;
  }

  async preflight() {
    const entries = await Promise.all([...this.connectors.entries()].map(async ([id, connector]) => (
      [id, await connector.preflight()]
    )));
    const checked = Object.fromEntries(entries);
    this.profile = checked.lark?.profile || this.profile || checked.weixin?.profile;
    return {
      profile: this.profile,
      version: entries.map(([id, info]) => `${id}:${info.version}`).join(', '),
      connectors: Object.fromEntries(entries.map(([id, info]) => [id, info.manifest])),
    };
  }

  async startSubscription(onEvent, onUnexpectedExit) {
    await Promise.all([...this.connectors.values()].map((connector) => (
      connector.startSubscription(onEvent, (exit) => onUnexpectedExit({ ...exit, connector: connector.id }))
    )));
  }

  get subscriptionRunning() {
    return this.connectors.size > 0
      && [...this.connectors.values()].every((connector) => connector.subscriptionRunning);
  }

  snapshot() {
    return Object.fromEntries([...this.connectors.entries()].map(([id, connector]) => [id, {
      running: connector.subscriptionRunning,
      capabilities: connector.manifest?.capabilities ?? [],
      version: connector.manifest?.version ?? null,
    }]));
  }

  invoke(connector, action, input, timeoutMs) {
    return this.connector(connector).invoke(action, input, timeoutMs);
  }

  // Manifests come from each Connector's spec response during preflight.
  manifests() {
    return [...this.connectors.values()].filter((connector) => connector.manifest)
      .map((connector) => [connector.id, connector.manifest]);
  }

  listChatMembers(chatId) {
    if (!this.connectors.has('lark')) return Promise.resolve([]);
    return this.invoke('lark', 'chat.members.list', { chat_id: chatId }, 15_000);
  }

  getChatName(chatId) {
    if (!this.connectors.has('lark')) return Promise.resolve(null);
    return this.invoke('lark', 'chat.get', { chat_id: chatId }, 15_000);
  }

  updateCard(messageId, card) {
    return this.invoke('lark', 'card.update', { message_id: messageId, card });
  }

  joinMeeting(input) { return this.invoke('lark', 'meeting.join', input); }
  getMeetingRealtimeEndpoint(meetingId) {
    return this.invoke('lark', 'meeting.realtime_endpoint', { meeting_id: meetingId });
  }
  leaveMeeting(meetingId) {
    return this.invoke('lark', 'meeting.leave', { meeting_id: meetingId });
  }
  listMeetingEvents(input) { return this.invoke('lark', 'meeting.events.list', input); }

  async pauseSubscriptions() {
    const results = await Promise.allSettled(
      [...this.connectors.values()].map((connector) => connector.pauseSubscription()),
    );
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
  }

  async stop() {
    await Promise.allSettled([...this.connectors.values()].map((connector) => connector.stop()));
  }
}
