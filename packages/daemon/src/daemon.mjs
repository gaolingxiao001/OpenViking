import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { ProcessRegistry } from './process-utils.mjs';
import { AgentRuntime } from './agent-runtime.mjs';
import { Harness } from './harness.mjs';
import { executeCommand } from './commands.mjs';
import { LarkClient } from './lark.mjs';
import { ChatRoster, registerNameResolver } from './roster.mjs';
import { ChatNameTracker } from './chat-names.mjs';
import { FailurePolicy, journaledReply } from './notices.mjs';
import { startHttpApi } from './http-api.mjs';
import { InstanceLock } from './lock.mjs';
import { safeChatLookupError, safeError } from './logger.mjs';
import { IdleLivenessExtension } from './extensions/idle-liveness.mjs';
import { OVSessionClient, OVSessionContext } from './ov-session-context.mjs';
import {
  isMeetingEvent,
  MeetingPlugin,
} from './meeting/index.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Composition root and process lifecycle. The moving parts live in their own
// modules: the Harness owns the inbound pipe, FailurePolicy owns turn-failure
// behavior, ChatNameTracker owns background naming, http-api owns the local
// observation surface. LarkDaemon wires them together, starts them in order,
// and tears them down in reverse.
export class LarkDaemon {
  constructor(config, logger, { ovClient = null } = {}) {
    this.config = config;
    this.logger = logger;
    this.lock = new InstanceLock(config.lockPath);
    this.registry = new ProcessRegistry(logger);
    this.store = null;
    this.agentRuntime = null;
    this.harness = null;
    this.lark = null;
    this.meeting = null;
    this.liveness = null;
    this.roster = null;
    this.chatNames = null;
    this.failurePolicy = null;
    this.httpServer = null;
    this.startedAt = Date.now();
    this.ready = false;
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.maintenanceTimer = null;
    this.runId = randomUUID();
    this.activitySequence = 0;
    this.ovClient = ovClient;
    this.ovContext = null;
    this.ovSyncTimer = null;
    this.ovSyncBusy = false;
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
      this.ovContext = new OVSessionContext(this.store,
        this.ovClient ?? new OVSessionClient(this.config.openVikingConfigPath), this.logger,
        { canCommit: () => !this.lark?.subscriptionRunning
          && !this.store.db.prepare("SELECT 1 FROM inbound WHERE status = 'QUEUED' LIMIT 1").get() });
      this.recordSystemActivity('system.starting', {
        summary: '本机飞书 Agent 正在启动',
        status: 'STARTING',
        metadata: { eventMode: this.config.eventMode },
      }, 'starting');
      this.runMaintenance();

      this.lark = new LarkClient(this.config, this.registry, this.logger.child({ component: 'lark' }));
      this.meeting = new MeetingPlugin({
        config: this.config,
        store: this.store,
        lark: this.lark,
        registry: this.registry,
        logger: this.logger.child({ component: 'meeting' }),
      });
      await this.meeting.prepare();
      // Best-effort member roster so inbound lines carry display names instead
      // of id stubs. The formatters read it through the process-wide resolver.
      this.roster = new ChatRoster({
        fetchMembers: (chatId) => this.lark.listChatMembers(chatId),
        logger: this.logger.child({ component: 'roster' }),
      });
      registerNameResolver((chatId, userId) => this.roster.nameForId(chatId, userId));
      const larkInfo = await this.lark.preflight();
      this.config.profile = larkInfo.profile;
      this.config.botOpenId = larkInfo.botOpenId;
      this.logger.info('cli_preflight_ok', { larkVersion: larkInfo.version });
      this.recordSystemActivity('system.preflight_ok', {
        summary: 'lark-cli 可用',
        status: 'OK',
        metadata: { larkVersion: larkInfo.version },
      }, 'preflight-ok');

      this.chatNames = new ChatNameTracker({
        store: this.store,
        lark: this.lark,
        logger: this.logger,
        isActive: () => this.ready && !this.shuttingDown,
      });

      this.liveness = new IdleLivenessExtension({
        thresholdMs: this.config.idleReactionAfterMs ?? 600_000,
        enabled: !this.config.dryRun,
      });

      this.agentRuntime = new AgentRuntime(this.config, this.store, this.logger.child({ component: 'agent-runtime' }), {
        onTurnFailed: (info) => {
          this.meeting?.onTurnFailed(info);
          void this.failurePolicy.onTurnFailed(info)
            .catch((error) => {
              this.logger.warn('turn_failure_handler_failed', { error: safeError(error) });
            });
        },
        onTurnSucceeded: (info) => {
          this.meeting?.onTurnSucceeded(info);
          this.failurePolicy.onTurnSucceeded(info);
        },
        onTurnAbandoned: (info) => {
          this.meeting?.onTurnAbandoned(info);
        },
        onDeliverySucceeded: (info) => { void this.liveness?.onDeliverySucceeded(info); },
        onAvailable: () => { this.harness?.onAvailable(); },
        onAuthorityChanged: ({ authorityToken }) => {
          this.meeting?.onAuthorityChanged(authorityToken);
        },
      });
      this.failurePolicy = new FailurePolicy({
        config: this.config,
        store: this.store,
        lark: this.lark,
        logger: this.logger,
        liveness: this.liveness,
        runtime: this.agentRuntime,
        recordActivity: (kind, fields) => this.recordSystemActivity(kind, fields),
        isStopping: () => this.shuttingDown,
      });
      this.harness = new Harness({
        config: this.config,
        store: this.store,
        logger: this.logger,
        recordActivity: (kind, fields) => this.recordSystemActivity(kind, fields),
        runtime: this.agentRuntime,
        roster: this.roster,
        liveness: this.liveness,
        meeting: this.meeting,
        isMeetingEvent,
        onSlashCommand: (command, event, inbound) => this.handleSlashCommand(command, event, inbound),
        onInboundChat: (chatId) => this.chatNames.schedule(chatId),
        isStopping: () => this.shuttingDown,
      });
      this.meeting.attachHarness({
        runtime: this.agentRuntime,
        enqueueIngress: (action) => this.harness.enqueueIngress(action),
        flushBufferedIngress: () => this.harness.flushBufferedIngress(),
      });
      await this.agentRuntime.start();
      this.meeting.onAuthorityChanged(this.store.getCognitionState().authorityToken);
      void this.meeting.start().catch((error) => {
        this.logger.warn('meeting_plugin_start_failed', { error: safeError(error) });
      });
      this.recordSystemActivity('system.subscriber_started', {
        summary: `${this.store.getCognitionState().runtime} runtime 已连接`,
        status: 'RUNNING',
      }, 'codex-connected');

      if (this.config.httpEnabled) {
        this.httpServer = await startHttpApi({
          config: this.config,
          store: this.store,
          logger: this.logger,
          serviceSnapshot: (options) => this.serviceSnapshot(options),
        });
      }
      this.lark.startSubscription(
        (line) => this.harness.handleEventLine(line),
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
      this.chatNames.refresh();
      this.maintenanceTimer = setInterval(() => this.runMaintenance(), 86_400_000);
      this.ovSyncTimer = setInterval(() => {
        if (this.shuttingDown || this.ovSyncBusy || this.harness.pendingIngress > 0 || this.agentRuntime.turnInProgress
          || this.agentRuntime.state.queued > 0 || this.harness.groupBurst.pendingConversations > 0) return;
        this.ovSyncBusy = true;
        void this.ovContext.checkpoint(this.store.getCognitionState().epoch)
          .catch(() => this.logger.warn('ov_session_sync_failed', { error: 'OV sync will retry; local transport cursor retained' }))
          .finally(() => { this.ovSyncBusy = false; });
      }, 5_000);
      this.ovSyncTimer.unref();
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

  // Slash commands never touch the model: execute deterministically against the
  // runtime's connection state, then reply straight back through lark-cli.
  // Local commands are a priority control plane: read-only commands such as
  // /help and /status answer alongside an active turn; session-mutating
  // commands interrupt that turn inside executeCommand before rotating.
  async handleSlashCommand(command, event, inbound) {
    if (this.shuttingDown) return;
    const label = command.name ? `/${command.name}` : String(event.content).trim().split(/\s+/)[0];
    this.store.appendCognitionJournal({
      kind: 'control',
      chatId: event.chatId,
      threadId: event.threadId,
      messageId: event.messageId,
      actor: event.senderId,
      text: `slash command ${String(event.content).trim()}`,
      dedupeKey: `command:${event.messageId}`,
    });
    let outcome;
    try {
      outcome = await executeCommand(command, this.agentRuntime);
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
    const sent = await journaledReply(
      this, event, outcome.text, 'daemon_command_reply', `command-reply:${event.messageId}`,
    );
    if (!sent.ok && sent.stage === 'send') {
      this.recordSystemActivity('command.reply_failed', {
        summary: safeChatLookupError(sent.error),
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
    try { this.meeting?.prune(); } catch (error) {
      this.logger.warn('meeting_prune_failed', { error: safeError(error) });
    }
    this.chatNames?.refresh();
  }

  serviceSnapshot({ includeState = true } = {}) {
    const healthy = !this.shuttingDown && Boolean(this.lark?.subscriptionRunning);
    const ready = healthy && this.ready;
    const body = {
      status: ready ? 'ready' : (healthy ? 'starting' : 'unhealthy'),
      subscriber: this.lark?.subscriptionRunning ? 'running' : 'stopped',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      activeTurns: this.agentRuntime?.snapshot().work.turnInProgress ? 1 : 0,
      scheduledConversations: 0,
    };
    if (includeState) body.state = this.store?.stats() ?? {};
    return { healthy, ready, body };
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
      if (this.ovSyncTimer) clearInterval(this.ovSyncTimer);
      this.ovContext?.stop();
      this.maintenanceTimer = null;
      registerNameResolver(null);
      try { await this.lark?.stop(); } catch (error) { this.logger.warn('subscriber_stop_failed', { error }); }
      // Fence model-owned meeting authority before stopping the model process:
      // first stop and drain local issuance, then revoke every outstanding cap
      // and close the only claim path.
      try {
        await this.meeting?.stop({ drainIngress: () => this.harness?.ingressBarrier });
      } catch (error) {
        this.logger.warn('meeting_stop_failed', { error });
      }
      this.harness?.stop();
      // Give an in-flight turn a bounded chance to finish before the backends
      // are killed. A mid-turn kill poisons the native transcript: resuming it
      // later patches the interrupted tool call, which mutates the message
      // history and forces a full prompt-cache rewrite at write price. Inbound
      // is already stopped above, so no new work can start during the drain.
      // Budget stays inside main.mjs's shutdownTimeoutMs + 2s force-exit timer.
      const drainMs = Math.max(0, Math.min((this.config.shutdownTimeoutMs ?? 20_000) - 8_000, 12_000));
      if (drainMs > 0 && this.agentRuntime?.turnInProgress) {
        this.logger.info('shutdown_turn_drain', { drainMs });
        await Promise.race([this.agentRuntime.whenIdle(), delay(drainMs)]);
      }
      try { await this.agentRuntime?.stop(); } catch (error) { this.logger.warn('agent_runtime_stop_failed', { error }); }
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
