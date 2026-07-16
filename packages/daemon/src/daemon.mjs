import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { normalizeEvent, deterministicFilter } from './event.mjs';
import { Store } from './store.mjs';
import { ProcessRegistry } from './process-utils.mjs';
import { CodexRunner } from './codex.mjs';
import { LarkClient } from './lark.mjs';
import { Semaphore } from './semaphore.mjs';
import { InstanceLock } from './lock.mjs';
import { opaqueRef, redactSensitive } from './logger.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeError(error) {
  return redactSensitive(error instanceof Error ? error.message : String(error));
}

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
    this.lark = null;
    this.httpServer = null;
    // All chats share one global Codex session; turns must never resume it concurrently.
    this.semaphore = new Semaphore(1);
    this.scheduled = new Map();
    this.runningConversations = new Set();
    this.startedAt = Date.now();
    this.ready = false;
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.maintenanceTimer = null;
    this.runId = randomUUID();
    this.activitySequence = 0;
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
        turnId: fields.turnId,
        inboundSeq: fields.inboundSeq,
        outboxId: fields.outboxId,
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
    fs.mkdirSync(this.config.tempDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.config.workspace, { recursive: true, mode: 0o700 });
    this.lock.acquire();
    try {
      this.store = new Store(this.config.databasePath, this.logger.child({ component: 'store' }));
      this.recordSystemActivity('system.starting', {
        summary: '本机飞书 Agent 正在启动',
        status: 'STARTING',
        metadata: { eventMode: this.config.eventMode },
      }, 'starting');
      this.codex = new CodexRunner(this.config, this.registry, this.logger.child({ component: 'codex' }));
      this.lark = new LarkClient(this.config, this.registry, this.logger.child({ component: 'lark' }));

      const interrupted = this.store.recoverInterrupted();
      if (interrupted > 0) {
        this.logger.warn('interrupted_turns_quarantined', { count: interrupted });
        this.recordSystemActivity('system.recovery', {
          summary: `隔离了 ${interrupted} 个被中断的判断`,
          status: 'RECOVERED',
          metadata: { interruptedTurns: interrupted },
        }, 'recover-interrupted');
      }
      this.runMaintenance();

      const [codexInfo, larkInfo] = await Promise.all([
        this.codex.preflight(),
        this.lark.preflight(),
      ]);
      this.config.profile = larkInfo.profile;
      this.logger.info('cli_preflight_ok', {
        codexVersion: codexInfo.version,
        larkVersion: larkInfo.version,
      });
      this.recordSystemActivity('system.preflight_ok', {
        summary: 'Codex 与 lark-cli 均可用',
        status: 'OK',
        metadata: {
          codexVersion: codexInfo.version,
          larkVersion: larkInfo.version,
        },
      }, 'preflight-ok');

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

      const recoveredOutboxes = await this.recoverOutboxes();
      if (recoveredOutboxes > 0) {
        this.recordSystemActivity('system.recovery', {
          summary: `检查了 ${recoveredOutboxes} 条待发送回复`,
          status: 'RECOVERED',
          metadata: { outboxes: recoveredOutboxes },
        }, 'recover-outboxes');
      }
      this.ready = true;
      for (const conversationKey of this.store.queuedConversationKeys()) {
        this.scheduleConversation(conversationKey, 0);
      }
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
    let result;
    try {
      result = this.store.ingest(event, filterReason, Date.now(), {
        perConversation: this.config.maxQueuedPerConversation,
        total: this.config.maxQueuedTotal,
      });
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
    if (result.filterReason) {
      this.logger.info('event_rule_ignored', {
        messageRef: opaqueRef(event.messageId),
        chatRef: opaqueRef(event.chatId),
        reason: result.filterReason,
      });
      return;
    }
    this.logger.info('event_queued', {
      messageRef: opaqueRef(event.messageId),
      chatRef: opaqueRef(event.chatId),
      conversationRef: opaqueRef(event.conversationKey),
      chatType: event.chatType,
    });
    this.scheduleConversation(event.conversationKey, this.config.debounceMs);
  }

  scheduleConversation(conversationKey, delayMs = this.config.debounceMs) {
    if (this.shuttingDown) return;
    const current = this.scheduled.get(conversationKey);
    if (current) clearTimeout(current);
    const timer = setTimeout(() => {
      this.scheduled.delete(conversationKey);
      void this.dispatchConversation(conversationKey);
    }, delayMs);
    this.scheduled.set(conversationKey, timer);
  }

  async dispatchConversation(conversationKey) {
    if (!this.ready || this.shuttingDown || this.runningConversations.has(conversationKey)) return;
    this.runningConversations.add(conversationKey);
    const release = await this.semaphore.acquire();
    try {
      if (!this.shuttingDown) await this.processConversation(conversationKey);
    } catch (error) {
      this.logger.error('conversation_worker_failed', {
        conversationRef: opaqueRef(conversationKey),
        error,
      });
      this.recordSystemActivity('system.worker_failed', {
        summary: safeError(error),
        status: 'FAILED',
        conversationKey,
      });
    } finally {
      release();
      this.runningConversations.delete(conversationKey);
      if (!this.shuttingDown && this.store.hasQueued(conversationKey)) {
        this.scheduleConversation(conversationKey, this.config.debounceMs);
      }
    }
  }

  async processConversation(conversationKey) {
    const expired = this.store.expireQueued(Date.now() - this.config.maxQueuedAgeMs);
    if (expired > 0) this.logger.warn('queued_events_expired', { count: expired });
    const turn = this.store.claimBatch(conversationKey, this.config.maxBatchSize);
    if (!turn) return;
    try {
      const global = this.store.getGlobalSession();
      const policyHash = this.codex.policyHash;
      let sessionId = global.sessionId;
      if (sessionId && global.policyHash !== policyHash) {
        this.store.clearGlobalSession();
        sessionId = null;
        this.logger.info('codex_session_rotated_for_policy', {
          conversationRef: opaqueRef(conversationKey),
        });
        this.recordSystemActivity('agent.session_rotated', {
          summary: '策略变化，已开始新的 Codex 上下文',
          status: 'ROTATED',
          conversationKey,
          turnId: turn.id,
          inboundSeq: turn.endSeq,
        });
      }
      const history = this.store.history(this.config.historyLimit);
      const turnLog = {
        turnId: turn.id,
        conversationRef: opaqueRef(conversationKey),
        batchSize: turn.messages.length,
      };
      this.logger.info('codex_turn_started', turnLog);

      const result = await this.codex.runTurn({
        turn,
        sessionId,
        history,
        onSessionId: (newSessionId) => this.store.setGlobalSession(newSessionId, policyHash),
      });
      if (result.staleSessionReset && !result.sessionId) this.store.clearGlobalSession();
      if (!result.ok) {
        this.store.failTurn(turn.id, result.error);
        this.logger.error('codex_turn_failed', { ...turnLog, durationMs: result.durationMs, error: result.error });
        return;
      }

      this.logger.info('codex_turn_decided', {
        ...turnLog,
        durationMs: result.durationMs,
        action: result.decision.action,
        reasonCode: result.decision.reasonCode,
        deliveryMode: result.decision.deliveryMode,
      });
      if (result.decision.action === 'ignore') {
        this.store.completeSilent(turn.id, result.decision);
        return;
      }

      const created = this.store.createOutboxIfFresh(turn.id, result.decision);
      if (created.stale) {
        this.logger.info('reply_withheld_for_freshness', turnLog);
        return;
      }
      await delay(this.config.freshnessGraceMs);
      if (this.store.cancelOutboxIfStale(created.outbox.id)) {
        this.logger.info('reply_cancelled_for_newer_message', turnLog);
        return;
      }
      await this.deliverOutbox(created.outbox);
    } catch (error) {
      const message = safeError(error);
      let quarantined = false;
      try { quarantined = this.store.failTurn(turn.id, message); } catch {}
      this.logger.error('claimed_turn_failed', {
        turnId: turn.id,
        conversationRef: opaqueRef(conversationKey),
        quarantined,
        error: message,
      });
    }
  }

  async deliverOutbox(outbox) {
    let current = outbox;
    for (let attempt = 0; attempt < this.config.sendRetries; attempt += 1) {
      if (this.shuttingDown) return;
      if (this.store.cancelOutboxIfStale(current.id)) {
        this.scheduleConversation(current.conversationKey, this.config.debounceMs);
        return;
      }
      const prepared = this.store.prepareOutboxAttempt(current.id, this.config.uncertainAfterMs);
      if (!prepared.ready) {
        if (prepared.uncertain) {
          this.logger.error('outbox_uncertain', { outboxId: current.id });
        }
        return;
      }
      current = prepared.outbox;
      try {
        const sent = await this.lark.sendOutbound(current);
        this.store.markOutboxSent(
          current.id,
          sent.remoteMessageId,
          Date.now(),
          this.config.dryRun,
        );
        this.logger.info('outbound_sent', {
          outboxId: current.id,
          conversationRef: opaqueRef(current.conversationKey),
          remoteMessageRef: opaqueRef(sent.remoteMessageId),
          deliveryMode: current.deliveryMode,
          dryRun: this.config.dryRun,
        });
        return;
      } catch (error) {
        const nextStatus = this.store.markOutboxFailure(
          current.id,
          safeError(error),
          this.config.sendRetries,
        );
        this.logger.error('outbound_send_failed', {
          outboxId: current.id,
          attempt: current.attemptCount,
          deliveryMode: current.deliveryMode,
          nextStatus,
          error,
        });
        if (nextStatus !== 'RETRY') return;
        await delay(500 * (2 ** attempt));
      }
    }
  }

  async recoverOutboxes() {
    const pending = this.store.pendingOutboxes();
    if (pending.length > 0) this.logger.warn('recovering_outboxes', { count: pending.length });
    for (const outbox of pending) {
      if (this.store.cancelOutboxIfStale(outbox.id)) {
        this.scheduleConversation(outbox.conversationKey, 0);
        continue;
      }
      await this.deliverOutbox(outbox);
    }
    return pending.length;
  }

  runMaintenance() {
    if (!this.store) return;
    const expired = this.store.expireQueued(Date.now() - this.config.maxQueuedAgeMs);
    const removed = this.store.prune(this.config.retentionMs);
    if (expired > 0 || Object.values(removed).some((count) => count > 0)) {
      this.logger.info('state_maintenance_completed', { expired, removed });
      this.recordSystemActivity('system.maintenance', {
        summary: expired > 0
          ? `清理完成；${expired} 条排队消息已过期`
          : '历史运行状态清理完成',
        status: 'COMPLETED',
        metadata: { expired, removed },
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
      activeTurns: this.runningConversations.size,
      scheduledConversations: this.scheduled.size,
    };
    if (includeState) body.state = this.store?.stats() ?? {};
    return {
      healthy,
      ready,
      body,
    };
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
      for (const timer of this.scheduled.values()) clearTimeout(timer);
      this.scheduled.clear();
      try { await this.lark?.stop(); } catch (error) { this.logger.warn('subscriber_stop_failed', { error }); }
      try { this.store?.closeRunningSubscriberActivities(); } catch (error) {
        this.logger.warn('subscriber_activity_close_failed', { error: safeError(error) });
      }
      const workerDeadline = Date.now() + Math.min(this.config.shutdownTimeoutMs - 5_000, 10_000);
      while (this.runningConversations.size > 0 && Date.now() < workerDeadline) {
        await delay(25);
      }
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
