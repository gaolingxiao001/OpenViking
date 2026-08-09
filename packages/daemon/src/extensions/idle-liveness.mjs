import { opaqueRef, redactSensitive } from '../logger.mjs';

function safeError(error) {
  return redactSensitive(error instanceof Error ? error.message : String(error));
}

// ponytail: this is a process-local UX hint, not durable work state. Exact
// reaction tokens plus lifecycle cleanup are enough; no polling or DB scan.
export class IdleLivenessExtension {
  constructor({
    thresholdMs = 600_000,
    enabled = true,
    lark,
    store,
    logger,
    recordActivity = null,
    now = () => Date.now(),
  }) {
    this.thresholdMs = thresholdMs;
    this.enabled = enabled && thresholdMs > 0;
    this.lark = lark;
    this.store = store;
    this.logger = logger;
    this.recordActivity = recordActivity;
    this.now = now;
    this.lastActivityAtMs = now();
    this.pending = new Map(); // inbound seq -> { messageId, reactionId, ... }
    this.creating = new Set();
    this.stopping = false;
  }

  touch(atMs = this.now()) {
    this.lastActivityAtMs = atMs;
  }

  async beforeInbound(event, inbound, { modelBusy = false } = {}) {
    const now = this.now();
    const direct = (event.chatType ?? 'p2p') === 'p2p'
      || (Array.isArray(event.mentions) && event.mentions.length > 0);
    const shouldReact = this.enabled
      && !this.stopping
      && direct
      && !modelBusy
      && now - this.lastActivityAtMs >= this.thresholdMs
      && inbound?.seq !== null
      && inbound?.seq !== undefined;
    this.touch(now);
    if (!shouldReact) return false;

    const creating = this._create(event, inbound);
    this.creating.add(creating);
    try { return await creating; } finally { this.creating.delete(creating); }
  }

  async _create(event, inbound) {
    const journalKey = `idle-liveness-reaction:${event.messageId}`;
    const action = 'ux_idle_liveness_reaction';
    try {
      this.store.appendCognitionJournal({
        kind: 'outbound',
        status: 'PENDING',
        chatId: event.chatId,
        threadId: event.threadId,
        messageId: event.messageId,
        actor: 'me',
        text: '[temporary reaction OnIt]',
        dedupeKey: journalKey,
        metadata: { action, emojiType: 'OnIt' },
      });
    } catch (error) {
      this.logger.warn('idle_liveness_journal_reserve_failed', { error: safeError(error) });
      return false;
    }

    let reaction;
    try {
      reaction = await this.lark.reactMessage(event.messageId, 'OnIt');
      if (!reaction?.reacted || !reaction.reactionId) {
        throw new Error('liveness reaction did not return a trackable reaction_id');
      }
    } catch (error) {
      this._settle(journalKey, 'UNCERTAIN', { action, emojiType: 'OnIt' });
      this.logger.warn('idle_liveness_reaction_failed', {
        messageRef: opaqueRef(event.messageId),
        error: safeError(error),
      });
      return false;
    }

    const token = {
      inboundSeq: inbound.seq,
      chatId: event.chatId,
      threadId: event.threadId,
      messageId: event.messageId,
      conversationKey: event.conversationKey,
      reactionId: reaction.reactionId,
      journalKey,
    };
    this._settle(journalKey, 'COMMITTED', {
      action,
      emojiType: 'OnIt',
      reactionId: reaction.reactionId,
    });

    // stop() waits for every _create task. If shutdown won the race, remove the
    // just-created reaction here instead of publishing a token after cleanup.
    if (this.stopping) {
      await this._delete(token, 'shutdown_race');
      return false;
    }
    this.pending.set(inbound.seq, token);
    this._record('system.liveness_ack', {
      summary: '长时间空闲后已先用临时 reaction 确认在线',
      status: 'SENT',
      conversationKey: event.conversationKey,
      inboundSeq: inbound.seq,
    });
    return true;
  }

  onDeliverySucceeded({ inboundSeqs } = {}) {
    return this.cleanup(inboundSeqs, 'delivery_succeeded');
  }

  onTurnSettled({ inboundSeqs } = {}) {
    this.touch();
    return this.cleanup(inboundSeqs, 'turn_settled');
  }

  async cleanup(inboundSeqs, reason) {
    const tokens = new Set();
    for (const seq of Array.isArray(inboundSeqs) ? inboundSeqs : []) {
      const token = this.pending.get(seq);
      if (token) tokens.add(token);
    }
    await Promise.allSettled([...tokens].map((token) => this._takeAndDelete(token, reason)));
  }

  async cleanupAll(reason = 'control_delivery') {
    await Promise.allSettled(
      [...this.pending.values()].map((token) => this._takeAndDelete(token, reason)),
    );
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    await Promise.allSettled([...this.creating]);
    await this.cleanupAll('shutdown');
  }

  async _takeAndDelete(token, reason) {
    if (this.pending.get(token.inboundSeq) !== token) return false;
    this.pending.delete(token.inboundSeq); // claim once before the async delete
    return await this._delete(token, reason);
  }

  async _delete(token, reason) {
    try {
      await this.lark.deleteReaction(token.messageId, token.reactionId);
    } catch (error) {
      this.logger.warn('idle_liveness_cleanup_failed', {
        messageRef: opaqueRef(token.messageId),
        reason,
        error: safeError(error),
      });
      return false;
    }
    // The temporary observable no longer exists. Reuse its original row and
    // let the journal's normal status filter exclude it from future catch-up.
    this._settle(token.journalKey, 'CANCELLED', {
      action: 'ux_idle_liveness_reaction',
      cleanupReason: reason,
    });
    this._record('system.liveness_cleared', {
      summary: '最终处理结束，临时 reaction 已撤掉',
      status: 'COMPLETED',
      conversationKey: token.conversationKey,
      inboundSeq: token.inboundSeq,
      metadata: { reason },
    });
    return true;
  }

  _settle(key, status, metadata) {
    try { this.store.settleCognitionJournal(key, status, { metadata }); } catch (error) {
      this.logger.warn('idle_liveness_journal_settle_failed', { error: safeError(error) });
    }
  }

  _record(kind, fields) {
    try { this.recordActivity?.(kind, fields); } catch (error) {
      this.logger.warn('idle_liveness_activity_failed', { kind, error: safeError(error) });
    }
  }
}
