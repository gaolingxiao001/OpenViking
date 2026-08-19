import { normalizeEvent, deterministicFilter } from './event.mjs';
import { commandCandidate, parseCommand } from './commands.mjs';
import { GroupBurstRouter } from './group-burst.mjs';
import { formatInboundLine, resolveReplyTarget } from './runtime-input.mjs';
import { opaqueRef, safeError } from './logger.mjs';

// The harness: the inbound pipe from a raw lark-cli event line to
// AgentRuntime.submit. Owns the deterministic steps — parse, meeting dispatch,
// normalize, filter, slash detection, persist/dedupe, roster warm-up, burst
// batching — and the ingress barrier that keeps slash commands and later
// messages in one global order. Everything that talks back to Lark (slash
// execution, failure notices) lives outside; the harness only routes.
export class Harness {
  constructor({
    config,
    store,
    logger,
    recordActivity,
    runtime,
    roster = null,
    liveness = null,
    meeting = null,
    isMeetingEvent = () => false,
    onSlashCommand,
    onInboundChat = null,
    isStopping = () => false,
  }) {
    this.config = config;
    this.store = store;
    this.logger = logger;
    this.recordActivity = recordActivity;
    this.runtime = runtime;
    this.roster = roster;
    this.liveness = liveness;
    this.meeting = meeting;
    this.isMeetingEvent = isMeetingEvent;
    this.onSlashCommand = onSlashCommand;
    this.onInboundChat = onInboundChat;
    this.isStopping = isStopping;
    this.ingressBarrier = Promise.resolve();
    this.groupBurst = new GroupBurstRouter({
      submit: (items, options) => this.runtime.submit(items, options),
      isConnected: () => this.runtime.snapshot().session.connected,
      isTurnInProgress: () => this.runtime.snapshot().work.turnInProgress,
    });
  }

  handleEventLine(line) {
    if (this.isStopping()) return;
    if (Buffer.byteLength(line, 'utf8') > this.config.maxEventBytes) {
      this.logger.warn('event_dropped_oversize', { bytes: Buffer.byteLength(line, 'utf8') });
      this.recordActivity('system.event_dropped', {
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
      this.recordActivity('system.event_dropped', {
        summary: '收到无法解析的飞书事件',
        status: 'DROPPED',
        metadata: { reason: 'invalid_json', error: safeError(error) },
      });
      return;
    }

    // VC events have a different schema and lifecycle from IM messages. Keep
    // them off the IM normalizer/filter path so existing chat behavior remains
    // byte-for-byte unchanged.
    if (this.isMeetingEvent(parsed)) {
      void this.meeting?.handleEvent(parsed).catch((error) => {
        this.logger.warn('meeting_event_handle_failed', { error: safeError(error) });
      });
      return;
    }

    let event;
    try {
      event = normalizeEvent(parsed, this.config.profile);
    } catch (error) {
      this.logger.warn('event_invalid_shape', { error: safeError(error) });
      this.recordActivity('system.event_dropped', {
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
      this.recordActivity('system.persist_failed', {
        summary: safeError(error),
        status: 'FAILED',
      });
      return;
    }
    if (!result.inserted) {
      this.logger.debug('event_duplicate', { messageRef: opaqueRef(event.messageId) });
      this.recordActivity('message.duplicate', {
        summary: '同一条飞书消息已经处理过',
        status: 'DUPLICATE',
        conversationKey: event.conversationKey,
        metadata: { reason: 'deduplicated' },
      });
      return;
    }
    this.onInboundChat?.(event.chatId);
    if (command) {
      this.logger.info('event_slash_command', {
        messageRef: opaqueRef(event.messageId),
        chatRef: opaqueRef(event.chatId),
        command: command.name ?? 'unknown',
      });
      this.enqueueIngress(async () => {
        this.groupBurst.flushAll();
        await this.onSlashCommand(command, event, result.inbound);
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
        modelBusy: this.runtime.snapshot().work.turnInProgress,
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
        text: formatInboundLine(event, null, {
          ...(idleHint ?? {}),
          replyTo: resolveReplyTarget(this.store, event),
        }),
        seq: result.inbound.seq,
      });
    });
  }

  // A slash command and every later accepted message share one global order.
  // Slow model discovery and two-phase runtime catch-up therefore cannot let a
  // following message slip into the old runtime.
  enqueueIngress(action) {
    const run = this.ingressBarrier.then(async () => {
      if (!this.isStopping()) await action();
    });
    this.ingressBarrier = run.catch((error) => {
      this.logger.error('ingress_barrier_action_failed', { error: safeError(error) });
    });
    return run;
  }

  // Hand every already-arrived group batch to the current runtime, e.g. before
  // a /model or /new control action can overtake it.
  flushBufferedIngress() {
    return this.groupBurst.flushAll();
  }

  // The runtime became idle: give buffered group bursts a chance to claim it.
  onAvailable() {
    this.groupBurst.onAvailable();
  }

  stop() {
    this.groupBurst.stop();
  }
}
