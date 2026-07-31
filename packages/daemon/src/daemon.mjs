import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { normalizeEvent, deterministicFilter } from './event.mjs';
import { Store } from './store.mjs';
import { ProcessRegistry } from './process-utils.mjs';
import { CodexAgent, formatInboundLine } from './codex.mjs';
import { GroupBurstRouter } from './group-burst.mjs';
import { commandCandidate, executeCommand, parseCommand } from './commands.mjs';
import { LarkClient } from './lark.mjs';
import { InstanceLock } from './lock.mjs';
import { opaqueRef, redactSensitive } from './logger.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeError(error) {
  return redactSensitive(error instanceof Error ? error.message : String(error));
}

function safeChatLookupError(error) {
  return safeError(error)
    .replace(/\b(?:om|oc|ou|on|omt|cli)_[A-Za-z0-9_-]{6,}\b/g, '[LARK_ID]');
}

const CHAT_NAME_REFRESH_MS = 24 * 60 * 60 * 1_000;
const CHAT_NAME_RETRY_BASE_MS = 5 * 60 * 1_000;

const SECURITY_HEADERS = Object.freeze({
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; worker-src 'none'; manifest-src 'none'; media-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'x-frame-options': 'DENY',
});

function loopbackHostname(value) {
  if (typeof value !== 'string' || /[@/\\\s]/.test(value)) return false;
  try {
    const hostname = new URL(`http://${value}`).hostname.toLowerCase();
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname);
  } catch {
    return false;
  }
}

function requestIsSameOrigin(request) {
  const host = request.headers.host;
  if (!host || !loopbackHostname(host)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return parsed.protocol === 'http:' && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

function send(response, status, contentType, body, extraHeaders = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'cache-control': 'no-store',
    'content-type': contentType,
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  response.end(payload);
}

export class LarkDaemon {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.lock = new InstanceLock(config.lockPath);
    this.registry = new ProcessRegistry(logger);
    this.store = null;
    this.codex = null;
    this.groupBurst = null;
    this.lark = null;
    this.httpServer = null;
    this.startedAt = Date.now();
    this.ready = false;
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.maintenanceTimer = null;
    this.runId = randomUUID();
    this.activitySequence = 0;
    this.chatNameLookups = new Map();
  }

  recordSystemActivity(kind, fields = {}, eventSuffix = null) {
    if (!this.store) return false;
    this.activitySequence += 1;
    try {
      return this.store.recordActivity({
        eventKey: `run:${this.runId}:${eventSuffix ?? `${kind}:${this.activitySequence}`}`,
        kind,
        summary: fields.summary,
        status: fields.status,
        conversationKey: fields.conversationKey,
        inboundSeq: fields.inboundSeq,
        metadata: fields.metadata,
        occurredAtMs: fields.occurredAtMs,
      });
    } catch (error) {
      this.logger.warn('activity_persist_failed', { kind, error: safeError(error) });
      return false;
    }
  }

  async start() {
    fs.mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.config.workspace, { recursive: true, mode: 0o700 });
    this.lock.acquire();
    try {
      this.store = new Store(this.config.databasePath, this.logger.child({ component: 'store' }));
      this.recordSystemActivity('system.starting', {
        summary: '本机飞书 Agent 正在启动',
        status: 'STARTING',
        metadata: { eventMode: this.config.eventMode },
      }, 'starting');
      this.runMaintenance();

      this.lark = new LarkClient(this.config, this.registry, this.logger.child({ component: 'lark' }));
      const larkInfo = await this.lark.preflight();
      this.config.profile = larkInfo.profile;
      this.logger.info('cli_preflight_ok', { larkVersion: larkInfo.version });
      this.recordSystemActivity('system.preflight_ok', {
        summary: 'lark-cli 可用',
        status: 'OK',
        metadata: { larkVersion: larkInfo.version },
      }, 'preflight-ok');

      this.codex = new CodexAgent(this.config, this.store, this.logger.child({ component: 'codex' }), {
        onTurnFailed: (info) => { void this.notifyTurnFailure(info); },
        onAvailable: () => { this.groupBurst?.onAvailable(); },
      });
      this.groupBurst = new GroupBurstRouter({
        deliverBatch: (items) => this.codex.deliverBatch(items),
        tryStartBatch: (items) => this.codex.tryStartBatch(items),
        isConnected: () => this.codex.state.connected,
        isTurnInProgress: () => this.codex.turnInProgress,
      });
      await this.codex.start();
      this.recordSystemActivity('system.subscriber_started', {
        summary: 'Codex app-server 已连接',
        status: 'RUNNING',
      }, 'codex-connected');

      if (this.config.httpEnabled) await this.startHttpServer();
      this.lark.startSubscription(
        (line) => this.handleEventLine(line),
        (exit) => this.handleSubscriberExit(exit),
      );

      await delay(500);
      if (!this.lark.subscriptionRunning) throw new Error('lark-cli subscriber exited during startup');
      this.store.closeRunningSubscriberActivities();
      this.recordSystemActivity('system.subscriber_started', {
        summary: '正在接收飞书消息事件',
        status: 'RUNNING',
      }, 'subscriber-started');

      this.ready = true;
      this.refreshChatNames();
      this.maintenanceTimer = setInterval(() => this.runMaintenance(), 86_400_000);
      this.maintenanceTimer.unref();
      this.logger.info('daemon_ready', {
        address: this.config.httpEnabled ? `http://${this.config.host}:${this.config.port}` : 'disabled',
        eventMode: this.config.eventMode,
      });
      this.recordSystemActivity('system.ready', {
        summary: '可以接收消息并按需回复',
        status: 'READY',
      }, 'ready');
    } catch (error) {
      this.recordSystemActivity('system.startup_failed', {
        summary: safeError(error),
        status: 'FAILED',
      }, 'startup-failed');
      await this.shutdown('startup_failure', 1);
      throw error;
    }
  }

  handleEventLine(line) {
    if (this.shuttingDown) return;
    if (Buffer.byteLength(line, 'utf8') > this.config.maxEventBytes) {
      this.logger.warn('event_dropped_oversize', { bytes: Buffer.byteLength(line, 'utf8') });
      this.recordSystemActivity('system.event_dropped', {
        summary: '收到的事件体积超过本机限制',
        status: 'DROPPED',
        metadata: { reason: 'oversize', bytes: Buffer.byteLength(line, 'utf8') },
      });
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      this.logger.warn('event_invalid_json', { error: safeError(error) });
      this.recordSystemActivity('system.event_dropped', {
        summary: '收到无法解析的飞书事件',
        status: 'DROPPED',
        metadata: { reason: 'invalid_json', error: safeError(error) },
      });
      return;
    }

    let event;
    try {
      event = normalizeEvent(parsed, this.config.profile);
    } catch (error) {
      this.logger.warn('event_invalid_shape', { error: safeError(error) });
      this.recordSystemActivity('system.event_dropped', {
        summary: '飞书事件缺少必要字段',
        status: 'DROPPED',
        metadata: { reason: 'invalid_shape', error: safeError(error) },
      });
      return;
    }
    const filterReason = deterministicFilter(event, this.config);
    // '/'-prefixed text is reserved for local slash commands: handled by the daemon
    // itself, recorded as filtered so it never enters codex delivery or history.
    // P2P takes bare /commands; a group only when the bot is @-mentioned.
    const commandText = filterReason ? null : commandCandidate(event);
    const command = commandText === null ? null : parseCommand(commandText);
    let result;
    try {
      result = this.store.ingest(event, command ? 'slash_command' : filterReason, Date.now());
    } catch (error) {
      this.logger.error('event_persist_failed', { error: safeError(error) });
      this.recordSystemActivity('system.persist_failed', {
        summary: safeError(error),
        status: 'FAILED',
      });
      return;
    }
    if (!result.inserted) {
      this.logger.debug('event_duplicate', { messageRef: opaqueRef(event.messageId) });
      this.recordSystemActivity('message.duplicate', {
        summary: '同一条飞书消息已经处理过',
        status: 'DUPLICATE',
        conversationKey: event.conversationKey,
        metadata: { reason: 'deduplicated' },
      });
      return;
    }
    this.scheduleChatNameLookup(event.chatId);
    if (command) {
      this.logger.info('event_slash_command', {
        messageRef: opaqueRef(event.messageId),
        chatRef: opaqueRef(event.chatId),
        command: command.name ?? 'unknown',
      });
      void this.handleSlashCommand(command, event, result.inbound);
      return;
    }
    if (result.filterReason) {
      this.logger.info('event_rule_ignored', {
        messageRef: opaqueRef(event.messageId),
        chatRef: opaqueRef(event.chatId),
        reason: result.filterReason,
      });
      return;
    }
    this.logger.info('event_delivered', {
      messageRef: opaqueRef(event.messageId),
      chatRef: opaqueRef(event.chatId),
      conversationRef: opaqueRef(event.conversationKey),
      chatType: event.chatType,
    });
    this.groupBurst.route({
      conversationKey: event.conversationKey,
      chatType: event.chatType,
      text: formatInboundLine(event),
      seq: result.inbound.seq,
    });
  }

  // A failed codex turn consumes its messages without replying; tell the sender
  // programmatically so failures are never silent. Best effort: reply to the last
  // inbound message of the failed turn.
  async notifyTurnFailure({ inboundSeqs, error }) {
    if (this.shuttingDown) return;
    const seq = Array.isArray(inboundSeqs) ? inboundSeqs.at(-1) : null;
    const inbound = seq === null || seq === undefined ? null : this.store.inboundBySeq(seq);
    const notice = `⚠️ 这一轮处理失败，没有生成回复：${error}`.slice(0, 600)
      + '\n（消息不会自动重试；可再发一次，或用 /effort、/model 调整后重试）';
    this.recordSystemActivity('agent.failure_notice', {
      summary: safeError(error),
      status: inbound?.messageId ? 'NOTIFYING' : 'NO_TARGET',
      conversationKey: inbound?.conversationKey,
      inboundSeq: seq ?? undefined,
    });
    if (!inbound?.messageId) return;
    try {
      await this.lark.replyMessage(inbound.messageId, notice);
    } catch (sendError) {
      this.logger.warn('turn_failure_notice_failed', {
        messageRef: opaqueRef(inbound.messageId),
        error: safeChatLookupError(sendError),
      });
      this.recordSystemActivity('agent.failure_notice', {
        summary: safeChatLookupError(sendError),
        status: 'FAILED',
        conversationKey: inbound.conversationKey,
        inboundSeq: seq ?? undefined,
      });
    }
  }

  // Slash commands never touch the model: execute deterministically against the
  // codex agent's connection state, then reply straight back through lark-cli.
  async handleSlashCommand(command, event, inbound) {
    const label = command.name ? `/${command.name}` : String(event.content).trim().split(/\s+/)[0];
    let outcome;
    try {
      outcome = await executeCommand(command, this.codex);
    } catch (error) {
      outcome = { ok: false, text: `命令执行失败：${safeError(error)}` };
    }
    this.recordSystemActivity('command.executed', {
      summary: `${label} → ${outcome.text.split('\n')[0]}`,
      status: outcome.ok ? 'OK' : 'FAILED',
      conversationKey: event.conversationKey,
      inboundSeq: inbound?.seq,
      metadata: { chatType: event.chatType },
    });
    try {
      await this.lark.replyMessage(event.messageId, outcome.text);
    } catch (error) {
      this.logger.warn('command_reply_failed', {
        messageRef: opaqueRef(event.messageId),
        error: safeChatLookupError(error),
      });
      this.recordSystemActivity('command.reply_failed', {
        summary: safeChatLookupError(error),
        status: 'FAILED',
        conversationKey: event.conversationKey,
        inboundSeq: inbound?.seq,
      });
    }
  }

  runMaintenance() {
    if (!this.store) return;
    const removed = this.store.prune(this.config.retentionMs);
    if (Object.values(removed).some((count) => count > 0)) {
      this.logger.info('state_maintenance_completed', { removed });
      this.recordSystemActivity('system.maintenance', {
        summary: '历史运行状态清理完成',
        status: 'COMPLETED',
        metadata: { removed },
      });
    }
    if (this.ready) this.refreshChatNames();
  }

  refreshChatNames(limit = 20) {
    if (this.shuttingDown || !this.store || !this.lark?.profile) return;
    for (const source of this.store.dueChatNameLookups(Date.now(), limit)) {
      this.scheduleChatNameLookup(source.chatId);
    }
  }

  scheduleChatNameLookup(chatId) {
    if (this.shuttingDown || !this.store || !this.lark?.profile
      || this.chatNameLookups.has(chatId)) return false;
    const source = this.store.chatNameLookupCandidate(chatId);
    if (!source) return false;
    const lookup = this.lookupChatName(source)
      .catch((error) => {
        this.logger.warn('chat_name_lookup_internal_failed', {
          chatRef: opaqueRef(chatId),
          error: safeChatLookupError(error),
        });
      })
      .finally(() => {
        this.chatNameLookups.delete(chatId);
        if (this.ready && !this.shuttingDown) queueMicrotask(() => this.refreshChatNames());
      });
    this.chatNameLookups.set(chatId, lookup);
    return true;
  }

  async lookupChatName(source) {
    try {
      const name = await this.lark.getChatName(source.chatId);
      if (this.shuttingDown) return;
      const now = Date.now();
      if (name) {
        this.store.saveChatSourceName(source.chatId, name, now + CHAT_NAME_REFRESH_MS, now);
        this.logger.info('chat_name_resolved', { chatRef: source.sourceRef });
        return;
      }
      this.store.deferChatSourceName(source.chatId, 'EMPTY', now + CHAT_NAME_REFRESH_MS, now);
      this.logger.debug('chat_name_empty', { chatRef: source.sourceRef });
    } catch (error) {
      if (this.shuttingDown) return;
      const now = Date.now();
      const backoffMs = Math.min(
        CHAT_NAME_REFRESH_MS,
        CHAT_NAME_RETRY_BASE_MS * (2 ** Math.min(source.failureCount, 8)),
      );
      this.store.deferChatSourceName(source.chatId, 'RETRY', now + backoffMs, now);
      this.logger.warn('chat_name_lookup_failed', {
        chatRef: source.sourceRef,
        retryInMs: backoffMs,
        error: safeChatLookupError(error),
      });
    }
  }

  serviceSnapshot({ includeState = true } = {}) {
    const healthy = !this.shuttingDown && Boolean(this.lark?.subscriptionRunning);
    const ready = healthy && this.ready;
    const body = {
      status: ready ? 'ready' : (healthy ? 'starting' : 'unhealthy'),
      subscriber: this.lark?.subscriptionRunning ? 'running' : 'stopped',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      activeTurns: this.codex?.state.activeTurn ?? 0,
      scheduledConversations: 0,
    };
    if (includeState) body.state = this.store?.stats() ?? {};
    return { healthy, ready, body };
  }

  async startHttpServer() {
    this.httpServer = http.createServer((request, response) => {
      try {
      if (!requestIsSameOrigin(request)) {
        send(response, 403, 'application/json; charset=utf-8', { error: 'forbidden' });
        return;
      }
      if (request.method !== 'GET') {
        send(response, 405, 'application/json; charset=utf-8', { error: 'method_not_allowed' }, { allow: 'GET' });
        return;
      }
      if (!request.url || request.url.length > 2048) {
        send(response, 414, 'application/json; charset=utf-8', { error: 'request_target_too_long' });
        return;
      }
      if (!request.url.startsWith('/') || request.url.startsWith('//')) {
        send(response, 400, 'application/json; charset=utf-8', { error: 'invalid_request_target' });
        return;
      }
      let url;
      try {
        url = new URL(request.url, 'http://localhost');
      } catch {
        send(response, 400, 'application/json; charset=utf-8', { error: 'invalid_request_target' });
        return;
      }

      if (url.pathname === '/api/activity') {
        const allowed = new Set(['limit', 'before']);
        if ([...url.searchParams.keys()].some((key) => !allowed.has(key))
          || url.searchParams.getAll('limit').length > 1
          || url.searchParams.getAll('before').length > 1) {
          send(response, 400, 'application/json; charset=utf-8', { error: 'invalid_query' });
          return;
        }
        const limitText = url.searchParams.get('limit');
        const beforeText = url.searchParams.get('before');
        if ((limitText !== null && !/^[1-9]\d*$/.test(limitText))
          || (beforeText !== null && !/^[1-9]\d*$/.test(beforeText))) {
          send(response, 400, 'application/json; charset=utf-8', { error: 'invalid_query' });
          return;
        }
        const limit = limitText === null ? 100 : Number(limitText);
        const beforeId = beforeText === null ? null : Number(beforeText);
        if (!Number.isSafeInteger(limit) || limit > 100
          || (beforeId !== null && !Number.isSafeInteger(beforeId))) {
          send(response, 400, 'application/json; charset=utf-8', { error: 'invalid_query' });
          return;
        }
        const feed = this.store.listActivities({ limit, beforeId });
        const service = this.serviceSnapshot({ includeState: false });
        send(response, 200, 'application/json; charset=utf-8', {
          generatedAt: Date.now(),
          service: {
            ready: service.ready,
            subscriber: service.body.subscriber,
            uptimeSeconds: service.body.uptimeSeconds,
          },
          overview: this.store.activityOverview(),
          activities: feed.activities,
          nextCursor: feed.nextCursor,
        });
        return;
      }

      if (['/health', '/ready'].includes(url.pathname) && url.searchParams.size === 0) {
        const service = this.serviceSnapshot();
        const ok = url.pathname === '/health' ? service.healthy : service.ready;
        send(response, ok ? 200 : 503, 'application/json; charset=utf-8', service.body);
        return;
      }

      send(response, 404, 'application/json; charset=utf-8', { error: 'not_found' });
      } catch (error) {
        this.logger.error('http_request_failed', {
          method: request.method,
          error: safeError(error),
        });
        if (!response.headersSent) {
          try {
            send(response, 500, 'application/json; charset=utf-8', { error: 'internal_error' });
          } catch {
            response.destroy();
          }
        } else {
          response.destroy();
        }
      }
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.httpServer.once('error', onError);
      this.httpServer.listen(this.config.port, this.config.host, () => {
        this.httpServer.off('error', onError);
        resolve();
      });
    });
  }

  handleSubscriberExit(exit) {
    this.logger.error('lark_subscriber_exited', {
      code: exit.code,
      signal: exit.signal,
      error: exit.stderr?.trim().slice(-2000),
    });
    this.recordSystemActivity('system.subscriber_exit', {
      summary: safeError(exit.stderr?.trim().slice(-2000) || `exit ${exit.code ?? exit.signal ?? 'unknown'}`),
      status: 'FAILED',
      metadata: { code: exit.code, signal: exit.signal },
    }, 'subscriber-exit');
    void this.shutdown('subscriber_exit', 1).then(() => process.exit(1));
  }

  async shutdown(reason = 'shutdown', exitCode = 0) {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shuttingDown = true;
    this.ready = false;
    this.shutdownPromise = (async () => {
      this.logger.info('daemon_stopping', { reason });
      this.recordSystemActivity('system.stopping', {
        summary: `停止原因：${safeError(reason)}`,
        status: 'STOPPING',
        metadata: { reason: safeError(reason), exitCode },
      }, 'stopping');
      if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
      this.maintenanceTimer = null;
      try { await this.lark?.stop(); } catch (error) { this.logger.warn('subscriber_stop_failed', { error }); }
      this.groupBurst?.stop();
      try { await this.codex?.stop(); } catch (error) { this.logger.warn('codex_stop_failed', { error }); }
      try { await this.registry.stopAll(Math.min(3_000, this.config.shutdownTimeoutMs)); } catch {}
      if (this.httpServer) {
        await Promise.race([
          new Promise((resolve) => this.httpServer.close(resolve)),
          delay(2_000),
        ]);
      }
      this.recordSystemActivity('system.stopped', {
        summary: '本次守护进程运行已结束',
        status: 'STOPPED',
        metadata: { reason: safeError(reason), exitCode },
      }, 'stopped');
      try { this.store?.close(); } catch {}
      this.lock.release();
      process.exitCode = exitCode;
      this.logger.info('daemon_stopped', { reason, exitCode });
    })();
    return this.shutdownPromise;
  }
}
