import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Store } from './store.mjs';
import { ProcessRegistry } from './process-utils.mjs';
import { AgentRuntime } from './agent-runtime.mjs';
import { Harness } from './harness.mjs';
import { executeCommand } from './commands.mjs';
import { ConnectorManager } from './connectors/process.mjs';
import { ActionService } from './actions/service.mjs';
import { startActionApi, stopActionApi } from './actions/api.mjs';
import { ChatRoster, registerNameResolver } from './roster.mjs';
import { ChatNameTracker } from './chat-names.mjs';
import { FailurePolicy } from './notices.mjs';
import { startHttpApi } from './http-api.mjs';
import { InstanceLock } from './lock.mjs';
import { safeChatLookupError, safeError } from './logger.mjs';
import { approvalNote } from './actions/approval.mjs';
import { resolveCardAction, settledChoiceCard } from './card-messages.mjs';
import { IdleLivenessExtension } from './extensions/idle-liveness.mjs';
import { OVSessionClient, OVSessionContext } from './ov-session-context.mjs';
import { OVUnavailableError } from './ov-connection.mjs';
import { loadOpenVikingIdentity } from './openviking.mjs';
import {
  MeetingPlugin,
} from './meeting/index.mjs';

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DisabledMeetingPlugin {
  async prepare() { return this; }
  attachHarness() { return this; }
  async start() {}
  async stop() {}
  async handleEvent() { return false; }
  onTurnFailed() {}
  onTurnSucceeded() {}
  onTurnAbandoned() {}
  onAuthorityChanged() {}
  prune() {}
}

// Composition root and process lifecycle. The moving parts live in their own
// modules: the Harness owns the inbound pipe, FailurePolicy owns turn-failure
// behavior, ChatNameTracker owns background naming, http-api owns the local
// observation surface. PersonalAgentDaemon wires them together, starts them in order,
// and tears them down in reverse.
export class PersonalAgentDaemon {
  constructor(config, logger, { ovClient = null } = {}) {
    this.connectorIds = config.connectors;
    this.config = { ...config, connectors: this.connectorIds };
    this.logger = logger;
    this.lock = new InstanceLock(config.lockPath);
    this.registry = new ProcessRegistry(logger);
    this.store = null;
    this.agentRuntime = null;
    this.harness = null;
    this.connectors = null;
    this.actions = null;
    this.actionApi = null;
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

  // Opt-in (VIKA_OV_IDENTITY). Every runtime assembles its policy from
  // this.config, so the read happens once, before the first runtime exists. A
  // failed read only leaves the identity section out.
  async loadOpenVikingIdentity(client) {
    if (!this.config.openVikingIdentityEnabled) return;
    try {
      this.config.openVikingIdentity = await loadOpenVikingIdentity(this.config, { client });
      this.logger.info('ov_identity_loaded', { found: Boolean(this.config.openVikingIdentity.text) });
    } catch (error) {
      this.logger.warn('ov_identity_unavailable', { error: safeError(error) });
    }
  }

  // A config or credential OV rejects needs the owner, so startup stops. An
  // OV that is not up yet (boot order, a blip during a restart) must not keep
  // the instance down: pm2 gives up after a few quick exits, while messages
  // can flow without history and OV sync retries once it is back.
  async checkOpenViking(client) {
    try {
      await client.check();
    } catch (error) {
      const status = error.httpStatus;
      const rejected = !(error instanceof OVUnavailableError)
        || (status >= 400 && status < 500 && status !== 408 && status !== 429);
      if (rejected) throw error;
      this.logger.warn('ov_unavailable_at_startup', { error: safeError(error) });
      this.recordSystemActivity('system.ov_unavailable', {
        summary: 'OpenViking 暂时连不上：先不带历史收发消息，恢复后自动同步',
        status: 'DEGRADED',
      });
    }
  }

  async start() {
    fs.mkdirSync(this.config.dataDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.config.workspace, { recursive: true, mode: 0o700 });
    this.lock.acquire();
    try {
      this.store = new Store(this.config.databasePath, this.logger.child({ component: 'store' }));
      const ovClient = this.ovClient ?? new OVSessionClient(this.config.openVikingConfigPath);
      this.ovContext = new OVSessionContext(this.store, ovClient, this.logger,
        { canCommit: () => !this.connectors?.subscribed });
      this.recordSystemActivity('system.starting', {
        summary: `本机 Personal Agent 正在启动（${this.connectorIds.join('、')}）`,
        status: 'STARTING',
      }, 'starting');
      await this.checkOpenViking(ovClient);
      this.runMaintenance();

      this.connectors = new ConnectorManager(
        this.config,
        this.registry,
        this.logger.child({ component: 'connectors' }),
      );
      this.meeting = this.connectorIds.includes('lark')
        ? new MeetingPlugin({
          config: this.config,
          store: this.store,
          lark: this.connectors,
          registry: this.registry,
          logger: this.logger.child({ component: 'meeting' }),
        })
        : new DisabledMeetingPlugin();
      await this.meeting.prepare();
      // Best-effort member roster so inbound lines carry display names instead
      // of id stubs. The formatters read it through the process-wide resolver.
      this.roster = new ChatRoster({
        fetchMembers: (chatId) => this.connectors.listChatMembers(chatId),
        logger: this.logger.child({ component: 'roster' }),
      });
      registerNameResolver((chatId, userId) => this.roster.nameForId(chatId, userId));
      // A Connector that fails check does not stop the others; it is retried
      // once subscriptions start.
      const transportInfo = await this.connectors.preflight();
      this.config.profile = transportInfo.profile;
      const checked = Object.keys(transportInfo.connectors);
      this.logger.info('connector_preflight_ok', {
        connectors: checked,
        failed: Object.keys(transportInfo.failed),
        version: transportInfo.version,
      });
      this.recordSystemActivity('system.preflight_ok', {
        summary: `${checked.join('、')} Connector 可用`,
        status: 'OK',
        metadata: { connectors: checked, version: transportInfo.version },
      }, 'preflight-ok');

      this.chatNames = new ChatNameTracker({
        store: this.store,
        lark: this.connectors,
        logger: this.logger,
        isActive: () => this.ready && !this.shuttingDown,
      });

      this.liveness = new IdleLivenessExtension({
        thresholdMs: this.config.idleReactionAfterMs ?? 600_000,
        enabled: !this.config.dryRun && this.connectorIds.includes('lark'),
      });
      // Every outbound action, from any runtime or the daemon itself, goes
      // through this one service and its outbox. Runtimes reach it over the
      // local socket via the MCP adapter.
      this.actions = new ActionService({
        config: this.config,
        store: this.store,
        connectors: this.connectors,
        roster: this.roster,
        liveness: this.liveness,
        meetingEnabled: this.connectorIds.includes('lark'),
        ovClient,
        logger: this.logger.child({ component: 'actions' }),
      });
      this.actionApi = await startActionApi({
        socketPath: this.config.actionSocketPath,
        service: this.actions,
        logger: this.logger.child({ component: 'action-api' }),
      });

      await this.loadOpenVikingIdentity(ovClient);
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
        onAvailable: () => { this.harness?.onAvailable(); },
        onAuthorityChanged: ({ authorityToken }) => {
          this.meeting?.onAuthorityChanged(authorityToken);
        },
      });
      this.failurePolicy = new FailurePolicy({
        config: this.config,
        store: this.store,
        actions: this.actions,
        logger: this.logger,
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
        prepareEvent: (event) => event.source === 'lark' && event.kind === 'message.action'
          ? resolveCardAction(this.store.db, event, this.config.profile) : event,
        eventHandler: (event) => {
          // The owner answered an approval card: the Core sends or drops the
          // draft itself, off the ingress queue (an SMTP send may be slow).
          // The model then hears what actually went out.
          if (event.question?.kind === 'approval') {
            return (accepted) => { void this.actions.settleApproval(accepted)
              .then((settled) => this.harness.deliverNote(accepted, approvalNote(accepted.question.draft, settled)))
              .catch((error) => this.logger.error('approval_settle_failed', { error: safeError(error) })); };
          }
          return event.source === 'lark' && event.kind.startsWith('meeting.') && event.data.meeting
            ? (accepted) => this.meeting.handleEvent(accepted.data.meeting) : null;
        },
        onSlashCommand: (command, event, inbound) => this.handleSlashCommand(command, event, inbound),
        // The owner's answer to a numbered mail draft: the Core sends, edits or
        // drops it, and the model hears what actually went out.
        approvalReply: (text, event) => {
          const reply = this.actions.matchApprovalReply(text, event);
          return reply && { verb: reply.verb, handle: (accepted, inbound) => void this.actions
            .answerApproval({ ...accepted, seq: inbound?.seq }, reply)
            .then((note) => note && this.harness.deliverNote(accepted, note))
            .catch((error) => this.logger.error('approval_answer_failed', { error: safeError(error) })) };
        },
        onInboundChat: (chatId) => this.chatNames.schedule(chatId),
        afterEvent: (event) => {
          const card = settledChoiceCard(event);
          if (card) return this.connectors.updateCard(event.parentId, card);
        },
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
      await this.connectors.startSubscription(
        (event) => this.harness.handleConnectorEvent(event),
        (status) => this.handleConnectorStatus(status),
      );

      await delay(500);
      if (!this.connectors.anySubscriptionRunning) {
        throw new Error('every connector subscriber exited during startup');
      }

      this.store.closeRunningSubscriberActivities();
      const running = Object.entries(this.connectors.snapshot())
        .filter(([, connector]) => connector.running).map(([id]) => id);
      this.recordSystemActivity('system.subscriber_started', {
        summary: `正在接收 ${running.join('、')} 事件`,
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
  // runtime's connection state, then reply on the event's own route.
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
    const sent = await this.actions.replyToEvent({ ...event, seq: inbound?.seq }, outcome.text, 'command-reply');
    if (!sent.ok) {
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

  // One Connector down while another still serves is `degraded`, and still
  // ready: an expired Weixin login must not hold back or roll back a release.
  serviceSnapshot({ includeState = true } = {}) {
    const anyRunning = Boolean(this.connectors?.anySubscriptionRunning);
    const allRunning = Boolean(this.connectors?.subscriptionRunning);
    const healthy = !this.shuttingDown && anyRunning;
    const ready = healthy && this.ready;
    const body = {
      status: ready ? (allRunning ? 'ready' : 'degraded') : (healthy ? 'starting' : 'unhealthy'),
      subscriber: allRunning ? 'running' : (anyRunning ? 'degraded' : 'stopped'),
      connectors: this.connectors?.snapshot() ?? {},
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
      activeTurns: this.agentRuntime?.snapshot().work.turnInProgress ? 1 : 0,
      scheduledConversations: 0,
    };
    if (includeState) body.state = this.store?.stats() ?? {};
    return { healthy, ready, body };
  }

  // A Connector going down or coming back is recorded and nothing more: the
  // ConnectorManager restarts it while the runtime and other Connectors keep
  // running. During shutdown a worker may exit first (systemd signals the
  // whole cgroup); that is not a failure.
  handleConnectorStatus(status) {
    if (this.shuttingDown) return;
    const { connector, failures } = status;
    if (status.status === 'recovered') {
      this.logger.info('connector_recovered', { connector, failures });
      this.recordSystemActivity('system.connector_recovered', {
        summary: `${connector} Connector 已恢复`,
        status: 'RUNNING',
        metadata: { connector, failures },
      });
      return;
    }
    const error = safeError(status.error || `exit ${status.code ?? status.signal ?? 'unknown'}`);
    this.logger.error('connector_failed', {
      connector, code: status.code, signal: status.signal, failures, retryInMs: status.retryInMs, error,
    });
    this.recordSystemActivity('system.connector_failed', {
      summary: `${connector} Connector 不可用，${Math.ceil(status.retryInMs / 1000)} 秒后重连：${error}`,
      status: 'FAILED',
      metadata: { connector, code: status.code, signal: status.signal, failures, retryInMs: status.retryInMs },
    });
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
      try { await this.connectors?.pauseSubscriptions(); } catch (error) {
        this.logger.warn('connector_pause_failed', { error });
      }
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
      // is already paused above, so no new work can start during the drain.
      // Budget stays inside main.mjs's shutdownTimeoutMs + 2s force-exit timer.
      const drainMs = Math.max(0, Math.min((this.config.shutdownTimeoutMs ?? 20_000) - 8_000, 12_000));
      if (drainMs > 0 && this.agentRuntime?.turnInProgress) {
        this.logger.info('shutdown_turn_drain', { drainMs });
        await Promise.race([this.agentRuntime.whenIdle(), delay(drainMs)]);
      }
      try { await this.agentRuntime?.stop(); } catch (error) { this.logger.warn('agent_runtime_stop_failed', { error }); }
      try { await stopActionApi(this.actionApi); } catch (error) {
        this.logger.warn('action_api_stop_failed', { error });
      }
      this.actionApi = null;
      try { await this.actions?.close(); } catch (error) { this.logger.warn('actions_close_failed', { error }); }
      try { await this.connectors?.stop(); } catch (error) { this.logger.warn('connector_stop_failed', { error }); }
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
