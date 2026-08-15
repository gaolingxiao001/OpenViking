import fs from 'node:fs';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { normalizeEvent, deterministicFilter } from './event.mjs';
import { Store } from './store.mjs';
import { ProcessRegistry } from './process-utils.mjs';
import { formatInboundLine } from './runtime-input.mjs';
import { AgentRuntime } from './agent-runtime.mjs';
import { GroupBurstRouter } from './group-burst.mjs';
import { commandCandidate, executeCommand, parseCommand } from './commands.mjs';
import { LarkClient } from './lark.mjs';
import { ChatRoster, registerNameResolver } from './roster.mjs';
import { ManagedAgentOutputPort } from './runtime-output.mjs';
import { InstanceLock } from './lock.mjs';
import { opaqueRef, redactSensitive } from './logger.mjs';
import { IdleLivenessExtension } from './extensions/idle-liveness.mjs';
import {
  DecisionAuthorityServer,
  FlyReferenceRing,
  GenericDecisionAuthority,
  isMeetingEvent,
  LiveSpool,
  MeetingAdapter,
  MeetingAudioCoordinator,
  MeetingGenerationClock,
  MeetingInboxNotifier,
  MeetingInputPort,
  MeetingMediaSupervisor,
  MeetingRuntimeAdapter,
  StdioMeetingWorkerFactory,
} from './meeting/index.mjs';

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
// A failure-notice mute only suppresses rapid repeats: a persistent failure
// re-notifies after this window instead of staying silent forever.
const FAILURE_NOTICE_MUTE_TTL_MS = 10 * 60 * 1_000;
// After one automatic claude → codex fallback, no further automatic switch is
// attempted within this window (prevents switch churn if the user moves back).
const MODEL_FALLBACK_COOLDOWN_MS = 5 * 60 * 1_000;

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
    this.agentRuntime = null;
    this.groupBurst = null;
    this.lark = null;
    this.meeting = null;
    this.meetingInboxNotifier = null;
    this.meetingAudio = null;
    this.meetingAudioRuntime = null;
    this.meetingAudioSpool = null;
    this.meetingDecisionAuthority = null;
    this.meetingDecisionServer = null;
    this.liveness = null;
    this.managedOutput = null;
    this.roster = null;
    this.httpServer = null;
    this.startedAt = Date.now();
    this.ready = false;
    this.shuttingDown = false;
    this.shutdownPromise = null;
    this.maintenanceTimer = null;
    this.runId = randomUUID();
    this.activitySequence = 0;
    this.chatNameLookups = new Map();
    this.ingressBarrier = Promise.resolve();
    // conversationKey -> { summary, atMs } of the last delivered failure notice.
    // Repeats of the same error stay muted until a turn for that conversation
    // succeeds, the error changes, or the mute TTL expires (see notifyTurnFailure).
    this.failureNoticeMutes = new Map();
    // Automatic claude → codex fallback state (see tryModelFallback).
    this.fallbackInProgress = false;
    this.lastFallbackAtMs = 0;
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
      if (this.config.meetingAudio) {
        const audioConfig = this.config.meetingAudio;
        this.meetingAudioSpool = new LiveSpool(audioConfig.spoolPath);
        const generationClock = new MeetingGenerationClock();
        const flyReferences = new FlyReferenceRing({ ttlMs: audioConfig.flyReferenceTtlMs });
        this.meetingDecisionAuthority = new GenericDecisionAuthority({
          runtimeToken: this.store.getCognitionState().authorityToken,
          getCurrentGeneration: (sessionEpoch) => generationClock.current(sessionEpoch),
          getLatestLarkSeq: (chatId) => this.store.latestAcceptedInboundSeq(chatId),
          ttlMs: audioConfig.capabilityTtlMs,
        });
        this.meetingDecisionServer = new DecisionAuthorityServer({
          socketPath: audioConfig.authoritySocketPath,
          authority: this.meetingDecisionAuthority,
          getRuntimeToken: () => this.store.getCognitionState().authorityToken,
          logger: this.logger.child({ component: 'meeting-decision-authority' }),
        });
        await this.meetingDecisionServer.start();
        const input = new MeetingInputPort({
          spool: this.meetingAudioSpool,
          onReady: (item) => this.meetingAudioRuntime?.onReady(item),
        });
        const workerFactory = new StdioMeetingWorkerFactory({
          command: audioConfig.workerCommand,
          args: audioConfig.workerArgs,
          cwd: audioConfig.workerCwd,
          registry: this.registry,
          logger: this.logger.child({ component: 'meeting-media-worker' }),
          stopTimeoutMs: 15_000,
        });
        let coordinator = null;
        const media = new MeetingMediaSupervisor({
          workerFactory,
          onFinal: (session, event) => input.accept(session, event),
          onUnavailable: (session, reason) => coordinator?.onUnavailable(session, reason),
          onState: (session) => coordinator?.onMediaState(session),
          logger: this.logger.child({ component: 'meeting-media' }),
        });
        coordinator = new MeetingAudioCoordinator({
          media,
          flyReferences,
          authority: this.meetingDecisionAuthority,
          generationClock,
          mediaEndpointProvider: (meetingId) => this.lark.getMeetingRealtimeEndpoint(meetingId),
          onSessionClosed: (session) => {
            this.meetingAudioSpool.retireSession(session.sessionEpoch);
          },
          sessionCloseGraceMs: audioConfig.capabilityTtlMs * 2,
          logger: this.logger.child({ component: 'meeting-audio' }),
        });
        this.meetingAudio = { coordinator, generationClock, flyReferences };
      }
      this.meeting = new MeetingAdapter({
        store: this.store.meetings,
        lark: this.lark,
        logger: this.logger.child({ component: 'meeting' }),
        onInboxReady: (batch) => this.meetingInboxNotifier?.signal(batch),
        ...(this.meetingAudio ? {
          onJoined: (session) => this.meetingAudio.coordinator.onJoined(session),
          onEnding: (event) => this.meetingAudio.coordinator.onEnding(event),
          onFlyTranscript: (event) => this.meetingAudio.coordinator.observeFlyTranscript(event),
        } : {}),
      });
      // Best-effort member roster so inbound lines carry display names instead
      // of id stubs. The formatters read it through the process-wide resolver.
      this.roster = new ChatRoster({
        fetchMembers: (chatId) => this.lark.listChatMembers(chatId),
        logger: this.logger.child({ component: 'roster' }),
      });
      registerNameResolver((chatId, userId) => this.roster.nameForId(chatId, userId));
      const larkInfo = await this.lark.preflight();
      this.config.profile = larkInfo.profile;
      this.logger.info('cli_preflight_ok', { larkVersion: larkInfo.version });
      this.recordSystemActivity('system.preflight_ok', {
        summary: 'lark-cli 可用',
        status: 'OK',
        metadata: { larkVersion: larkInfo.version },
      }, 'preflight-ok');

      this.liveness = new IdleLivenessExtension({
        thresholdMs: this.config.idleReactionAfterMs ?? 600_000,
        enabled: !this.config.dryRun,
      });

      this.managedOutput = new ManagedAgentOutputPort({
        config: this.config,
        store: this.store,
        logger: this.logger.child({ component: 'managed-output' }),
        roster: this.roster,
        liveness: this.liveness,
        isStopping: () => this.shuttingDown,
      });

      this.agentRuntime = new AgentRuntime(this.config, this.store, this.logger.child({ component: 'agent-runtime' }), {
        onTurnFailed: (info) => {
          this.meetingAudioRuntime?.onTurnFailed(info);
          void this.handleTurnFailure(info)
            .catch((error) => {
              this.logger.warn('turn_failure_handler_failed', { error: safeError(error) });
            });
        },
        onTurnSucceeded: (info) => {
          this.meetingAudioRuntime?.onTurnSucceeded(info);
          this.handleTurnSuccess(info);
        },
        onTurnOutput: (info) => this.managedOutput.deliver(info),
        onToolCall: (info) => this.managedOutput.callTool(info),
        toolDefinitions: this.managedOutput.toolDefinitions,
        onTurnAbandoned: (info) => {
          this.meetingAudioRuntime?.onTurnAbandoned(info);
        },
        onDeliverySucceeded: (info) => { void this.liveness?.onDeliverySucceeded(info); },
        onAvailable: () => { this.groupBurst?.onAvailable(); },
        onAuthorityChanged: ({ authorityToken }) => {
          this.meetingDecisionAuthority?.setRuntimeToken(authorityToken);
        },
      });
      this.groupBurst = new GroupBurstRouter({
        submit: (items, options) => this.agentRuntime.submit(items, options),
        isConnected: () => this.agentRuntime.snapshot().session.connected,
        isTurnInProgress: () => this.agentRuntime.snapshot().work.turnInProgress,
      });
      this.meetingInboxNotifier = new MeetingInboxNotifier({
        store: this.store.meetings,
        runtime: this.agentRuntime,
        logger: this.logger.child({ component: 'meeting-inbox' }),
      });
      if (this.meetingAudio) {
        this.meetingAudioRuntime = new MeetingRuntimeAdapter({
          spool: this.meetingAudioSpool,
          generationClock: this.meetingAudio.generationClock,
          flyReferences: this.meetingAudio.flyReferences,
          runtime: this.agentRuntime,
          submitIngress: (action) => this.enqueueIngress(action),
          flushBufferedIngress: () => this.groupBurst.flushAll(),
          logger: this.logger.child({ component: 'meeting-runtime' }),
        });
      }
      await this.agentRuntime.start();
      if (this.meetingDecisionAuthority) {
        this.meetingDecisionAuthority.setRuntimeToken(
          this.store.getCognitionState().authorityToken,
        );
      }
      this.meetingAudioRuntime?.start();
      this.meetingInboxNotifier.start();
      this.recordSystemActivity('system.subscriber_started', {
        summary: `${this.store.getCognitionState().runtime} runtime 已连接`,
        status: 'RUNNING',
      }, 'codex-connected');

      if (this.config.httpEnabled) await this.startHttpServer();
      this.lark.startSubscription(
        (line) => this.handleEventLine(line),
        (exit) => this.handleSubscriberExit(exit),
      );

      await delay(500);
      if (!this.lark.subscriptionRunning) throw new Error('lark-cli subscriber exited during startup');
      void this.meeting.start().catch((error) => {
        this.logger.warn('meeting_recovery_start_failed', { error: safeError(error) });
      });
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

    // VC events have a different schema and lifecycle from IM messages. Keep
    // them off the IM normalizer/filter path so existing chat behavior remains
    // byte-for-byte unchanged.
    if (isMeetingEvent(parsed)) {
      void this.meeting.handleEvent(parsed).catch((error) => {
        this.logger.warn('meeting_event_handle_failed', { error: safeError(error) });
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
      this.enqueueIngress(async () => {
        this.groupBurst.flushAll();
        await this.handleSlashCommand(command, event, result.inbound);
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
    this.logger.info('event_delivered', {
      messageRef: opaqueRef(event.messageId),
      chatRef: opaqueRef(event.chatId),
      conversationRef: opaqueRef(event.conversationKey),
      chatType: event.chatType,
    });
    this.enqueueIngress(async () => {
      const idleHint = this.liveness?.beforeInbound(event, result.inbound, {
        modelBusy: this.agentRuntime?.snapshot().work.turnInProgress,
      });
      // Bounded roster warm-up so formatInboundLine can resolve from= to a
      // display name. warm() never rejects and races an internal timeout, so a
      // slow or failing lark-cli only degrades the label back to the id stub.
      await this.roster?.warm(event.chatId);
      this.groupBurst.route({
        conversationKey: event.conversationKey,
        scope: { kind: 'lark', conversationKey: event.conversationKey },
        target: {
          chatId: event.chatId,
          threadId: event.threadId,
          messageId: event.messageId,
        },
        chatType: event.chatType,
        text: formatInboundLine(event, null, { ...(idleHint ?? {}), replyTo: this.replyToHint(event) }),
        seq: result.inbound.seq,
      });
    });
  }

  // A quote-reply's target, resolved from local history: 'me' when the sender
  // quoted one of the bot's own messages (a strong addressing signal). Plain
  // thread membership (parent == thread root) is not a quote and stays untagged.
  replyToHint(message) {
    const parentId = message.parentId;
    if (!parentId || parentId === message.messageId) return null;
    if (message.threadRootId && parentId === message.threadRootId) return null;
    const author = this.store.resolveMessageAuthor?.(parentId);
    return author ?? { kind: 'unknown', id: parentId };
  }

  // A slash command and every later accepted message share one global order.
  // Slow model discovery and two-phase runtime catch-up therefore cannot let a
  // following message slip into the old runtime.
  enqueueIngress(action) {
    const run = this.ingressBarrier.then(async () => {
      if (!this.shuttingDown) await action();
    });
    this.ingressBarrier = run.catch((error) => {
      this.logger.error('ingress_barrier_action_failed', { error: safeError(error) });
    });
    return run;
  }

  // A successful turn clears the failure-notice mute for every conversation it
  // consumed messages from: the next failure there is news again.
  handleTurnSuccess({ inboundSeqs }) {
    if (this.failureNoticeMutes.size === 0 || !this.store) return;
    for (const seq of Array.isArray(inboundSeqs) ? inboundSeqs : []) {
      let inbound = null;
      try { inbound = this.store.inboundBySeq(seq); } catch { continue; }
      if (inbound?.conversationKey) this.failureNoticeMutes.delete(inbound.conversationKey);
    }
  }

  // A failed turn first gets one shot at the automatic claude → codex fallback;
  // when that is not applicable (or the switch itself fails) the normal failure
  // notice goes out instead.
  async handleTurnFailure(info) {
    try {
      if (await this.tryModelFallback(info)) return true;
    } catch (error) {
      this.logger.warn('model_fallback_failed', { error: safeError(error) });
    }
    await this.notifyTurnFailure(info);
    return false;
  }

  // Claude CLI/API errors auto-switch to the codex fallback model (hard switch)
  // and retry the failed turn by redelivering its inbound rows. Loop guard: the
  // retry runs on the codex runtime, so its failure can never fall back again;
  // a cooldown blocks repeated automatic switches if the user moves back to
  // claude while it is still broken. Returns true when the fallback owns the
  // failure (no separate failure notice is sent).
  async tryModelFallback({ inboundSeqs, error }) {
    if (this.shuttingDown || this.store.getCognitionState().runtime !== 'claude') return false;
    if (this.fallbackInProgress) return false;
    const now = Date.now();
    if (now - this.lastFallbackAtMs < MODEL_FALLBACK_COOLDOWN_MS) return false;
    const seqs = (Array.isArray(inboundSeqs) ? inboundSeqs : []).filter((seq) => seq != null);
    const rows = [];
    for (const seq of seqs) {
      let row = null;
      try { row = this.store.inboundBySeq(seq); } catch { /* ignore */ }
      if (row?.messageId) rows.push(row);
    }
    if (rows.length === 0) return false; // nothing to retry on the fallback model
    const model = this.config.fallbackModel || 'gpt-5.6-sol';
    const errorSummary = safeError(error);
    this.fallbackInProgress = true;
    this.lastFallbackAtMs = now;
    try {
      await this.agentRuntime.transition({ kind: 'select-model', selector: model });
    } catch (switchError) {
      this.recordSystemActivity('agent.fallback', {
        summary: safeError(switchError),
        status: 'FAILED',
        conversationKey: rows.at(-1)?.conversationKey,
        inboundSeq: seqs.at(-1),
        metadata: { model, error: errorSummary },
      });
      this.logger.warn('model_fallback_switch_failed', { error: safeError(switchError) });
      return false; // fall through to the normal failure notice
    } finally {
      this.fallbackInProgress = false;
    }
    this.recordSystemActivity('agent.fallback', {
      summary: `claude 失败，已自动切换到 ${model} 重试`,
      status: 'SWITCHED',
      conversationKey: rows.at(-1)?.conversationKey,
      inboundSeq: seqs.at(-1),
      metadata: { model, error: errorSummary, inboundSeqs: seqs },
    });
    const last = rows.at(-1);
    const notice = `⚠️ 因 ${errorSummary} 报错，已自动切换到 ${model} 重试`.slice(0, 600);
    await this.journaledDaemonReply(last, notice, 'daemon_fallback_notice', `fallback-notice:${last.messageId}`);
    // Redeliver the failed turn to the fallback runtime. A failure of the retry
    // surfaces through the normal onTurnFailed path (runtime is codex now).
    this.agentRuntime.submit(rows.map((row) => ({
      text: formatInboundLine(row, null, { replyTo: this.replyToHint(row) }),
      seq: row.seq,
      conversationKey: row.conversationKey,
      scope: { kind: 'lark', conversationKey: row.conversationKey },
    })));
    return true;
  }

  // Reply to an inbound message with a daemon-authored notice, journaled so a
  // later runtime catch-up knows the chat already saw it. Returns delivery.
  async journaledDaemonReply(inbound, text, action, journalKey) {
    let journalReserved = false;
    try {
      this.store.appendCognitionJournal({
        kind: 'outbound',
        status: 'PENDING',
        chatId: inbound.chatId,
        threadId: inbound.threadId,
        messageId: inbound.messageId,
        actor: 'me',
        text,
        dedupeKey: journalKey,
        metadata: { action },
      });
      journalReserved = true;
    } catch (error) {
      this.logger.warn('daemon_reply_journal_reserve_failed', { action, error: safeError(error) });
      return false;
    }
    try {
      await this.lark.replyMessage(inbound.messageId, text);
    } catch (sendError) {
      try {
        this.store.settleCognitionJournal(journalKey, 'UNCERTAIN', { metadata: { action } });
      } catch (error) {
        this.logger.warn('daemon_reply_journal_settle_failed', { action, error: safeError(error) });
      }
      this.logger.warn('daemon_reply_failed', {
        action,
        messageRef: opaqueRef(inbound.messageId),
        error: safeChatLookupError(sendError),
      });
      return false;
    }
    try {
      this.store.settleCognitionJournal(journalKey, 'COMMITTED', { metadata: { action } });
    } catch (error) {
      // The Lark reply already succeeded; only the post-send journal write failed.
      this.logger.warn('daemon_reply_journal_settle_failed', { action, error: safeError(error) });
    }
    this.liveness?.touch();
    return true;
  }

  // A failed codex turn consumes its messages without replying; tell the sender
  // programmatically so failures are never silent. Best effort: reply to the last
  // inbound message of the failed turn. Repeats of the same error in the same
  // conversation are muted (activity only) until a turn succeeds or the error
  // changes, so a persistent failure does not spam the chat.
  async notifyTurnFailure({ inboundSeqs, error }) {
    if (this.shuttingDown) return;
    const seqs = Array.isArray(inboundSeqs) ? inboundSeqs : [];
    const seq = seqs.at(-1) ?? null;
    const inbound = seq === null || seq === undefined ? null : this.store.inboundBySeq(seq);
    const errorSummary = safeError(error);
    // Mention bypass: like commandCandidate, the daemon does not know its own
    // open_id, so any @-mention on any inbound of the failed turn counts as
    // mentioning the bot and always gets the notice.
    const mentioned = seqs.some((itemSeq) => {
      const row = itemSeq === seq ? inbound : this.store.inboundBySeq(itemSeq);
      return Array.isArray(row?.mentions) && row.mentions.length > 0;
    });
    const mute = inbound?.conversationKey
      ? this.failureNoticeMutes.get(inbound.conversationKey)
      : null;
    if (mute && !mentioned && mute.summary === errorSummary
      && Date.now() - mute.atMs < FAILURE_NOTICE_MUTE_TTL_MS) {
      this.recordSystemActivity('agent.failure_notice', {
        summary: errorSummary,
        status: 'MUTED',
        conversationKey: inbound.conversationKey,
        inboundSeq: seq ?? undefined,
        metadata: { reason: 'repeat_failure_muted' },
      });
      return;
    }
    const notice = `⚠️ 这一轮处理失败，没有生成回复：${error}`.slice(0, 600)
      + '\n（消息不会自动重试；可再发一次，或用 /effort、/model 调整后重试）';
    this.recordSystemActivity('agent.failure_notice', {
      summary: errorSummary,
      status: inbound?.messageId ? 'NOTIFYING' : 'NO_TARGET',
      conversationKey: inbound?.conversationKey,
      inboundSeq: seq ?? undefined,
    });
    if (!inbound?.messageId) return;
    const journalKey = `failure-notice:${inbound.messageId}`;
    let journalReserved = false;
    try {
      this.store.appendCognitionJournal({
        kind: 'outbound',
        status: 'PENDING',
        chatId: inbound.chatId,
        threadId: inbound.threadId,
        messageId: inbound.messageId,
        actor: 'me',
        text: notice,
        dedupeKey: journalKey,
        metadata: { action: 'daemon_failure_reply' },
      });
      journalReserved = true;
    } catch (error) {
      this.logger.warn('turn_failure_notice_journal_reserve_failed', { error: safeError(error) });
      return;
    }
    try {
      await this.lark.replyMessage(inbound.messageId, notice);
    } catch (sendError) {
      if (journalReserved) {
        try {
          this.store.settleCognitionJournal(journalKey, 'UNCERTAIN', {
            metadata: { action: 'daemon_failure_reply' },
          });
        } catch (error) {
          this.logger.warn('turn_failure_notice_journal_settle_failed', { error: safeError(error) });
        }
      }
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
      return;
    }
    // Only a delivered notice arms the mute; a failed send stays eligible to retry.
    if (inbound.conversationKey) {
      this.failureNoticeMutes.set(inbound.conversationKey, { summary: errorSummary, atMs: Date.now() });
    }
    if (journalReserved) {
      try {
        this.store.settleCognitionJournal(journalKey, 'COMMITTED', {
          metadata: { action: 'daemon_failure_reply' },
        });
      } catch (error) {
        // The Lark reply already succeeded. Never report a send failure or
        // invite a retry because only the post-send journal write failed.
        this.logger.warn('turn_failure_notice_journal_settle_failed', { error: safeError(error) });
      }
    }
    this.liveness?.touch();
  }

  // Slash commands never touch the model: execute deterministically against the
  // codex agent's connection state, then reply straight back through lark-cli.
  async handleSlashCommand(command, event, inbound) {
    // Local commands are a priority control plane. Read-only commands such as
    // /help and /status answer alongside an active turn; session-mutating
    // commands interrupt that turn inside executeCommand before rotating.
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
    const journalKey = `command-reply:${event.messageId}`;
    let journalReserved = false;
    try {
      this.store.appendCognitionJournal({
        kind: 'outbound',
        status: 'PENDING',
        chatId: event.chatId,
        threadId: event.threadId,
        messageId: event.messageId,
        actor: 'me',
        text: outcome.text,
        dedupeKey: journalKey,
        metadata: { action: 'daemon_command_reply' },
      });
      journalReserved = true;
    } catch (error) {
      this.logger.warn('command_reply_journal_reserve_failed', { error: safeError(error) });
      return;
    }
    try {
      await this.lark.replyMessage(event.messageId, outcome.text);
    } catch (error) {
      if (journalReserved) {
        try {
          this.store.settleCognitionJournal(journalKey, 'UNCERTAIN', {
            metadata: { action: 'daemon_command_reply' },
          });
        } catch (settleError) {
          this.logger.warn('command_reply_journal_settle_failed', { error: safeError(settleError) });
        }
      }
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
      return;
    }
    if (journalReserved) {
      try {
        this.store.settleCognitionJournal(journalKey, 'COMMITTED', {
          metadata: { action: 'daemon_command_reply' },
        });
      } catch (error) {
        this.logger.warn('command_reply_journal_settle_failed', { error: safeError(error) });
      }
    }
    // A successful direct control reply is visible activity too. It does not
    // need to inspect MCP-side temporary reaction state.
    this.liveness?.touch();
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
    try { this.meetingAudioSpool?.prune(); } catch (error) {
      this.logger.warn('meeting_spool_prune_failed', { error: safeError(error) });
    }
    try { this.meetingDecisionAuthority?.prune(); } catch (error) {
      this.logger.warn('meeting_decision_prune_failed', { error: safeError(error) });
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
      activeTurns: this.agentRuntime?.snapshot().work.turnInProgress ? 1 : 0,
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
      registerNameResolver(null);
      try { await this.lark?.stop(); } catch (error) { this.logger.warn('subscriber_stop_failed', { error }); }
      this.meetingInboxNotifier?.stop();
      // Fence model-owned meeting authority before stopping the model process:
      // first stop and drain local issuance, then revoke every outstanding cap
      // and close the only claim path.
      this.meetingAudioRuntime?.stop();
      try { await this.ingressBarrier; } catch {}
      this.meetingDecisionAuthority?.revokeAll();
      try { await this.meetingDecisionServer?.close(); } catch (error) {
        this.logger.warn('meeting_decision_server_stop_failed', { error });
      }
      try { await this.meeting?.stop(); } catch (error) { this.logger.warn('meeting_stop_failed', { error }); }
      try { await this.meetingAudio?.coordinator.stop(); } catch (error) {
        this.logger.warn('meeting_audio_stop_failed', { error });
      }
      this.groupBurst?.stop();
      try { await this.agentRuntime?.stop(); } catch (error) { this.logger.warn('agent_runtime_stop_failed', { error }); }
      try { this.meetingAudioSpool?.close(); } catch (error) {
        this.logger.warn('meeting_spool_close_failed', { error });
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
