import { formatInboundLine, resolveReplyTarget } from './runtime-input.mjs';
import { opaqueRef, safeChatLookupError, safeError } from './logger.mjs';

// A failure-notice mute only suppresses rapid repeats: a persistent failure
// re-notifies after this window instead of staying silent forever.
export const FAILURE_NOTICE_MUTE_TTL_MS = 10 * 60 * 1_000;
// After one automatic claude → codex fallback, no further automatic switch is
// attempted within this window (prevents switch churn if the user moves back).
export const MODEL_FALLBACK_COOLDOWN_MS = 5 * 60 * 1_000;

// Reply to an inbound message with a daemon-authored text, journaled so a later
// runtime catch-up knows the chat already saw it. Never carries model output.
// Returns { ok: true } or { ok: false, stage: 'reserve' | 'send', error }.
export async function journaledReply({ store, lark, logger, liveness }, target, text, action, journalKey) {
  try {
    store.appendCognitionJournal({
      kind: 'outbound',
      status: 'PENDING',
      chatId: target.chatId,
      threadId: target.threadId,
      messageId: target.messageId,
      actor: 'me',
      text,
      dedupeKey: journalKey,
      metadata: { action },
    });
  } catch (error) {
    logger.warn('daemon_reply_journal_reserve_failed', { action, error: safeError(error) });
    return { ok: false, stage: 'reserve', error };
  }
  try {
    await lark.replyMessage(target.messageId, text);
  } catch (sendError) {
    try {
      store.settleCognitionJournal(journalKey, 'UNCERTAIN', { metadata: { action } });
    } catch (error) {
      logger.warn('daemon_reply_journal_settle_failed', { action, error: safeError(error) });
    }
    logger.warn('daemon_reply_failed', {
      action,
      messageRef: opaqueRef(target.messageId),
      error: safeChatLookupError(sendError),
    });
    return { ok: false, stage: 'send', error: sendError };
  }
  try {
    store.settleCognitionJournal(journalKey, 'COMMITTED', { metadata: { action } });
  } catch (error) {
    // The Lark reply already succeeded; only the post-send journal write failed.
    // Never report a send failure or invite a retry because of it.
    logger.warn('daemon_reply_journal_settle_failed', { action, error: safeError(error) });
  }
  liveness?.touch();
  return { ok: true };
}

// What happens when a model turn fails: one shot at the automatic
// claude → codex fallback, then a muted-on-repeat failure notice to the sender
// so failures are never silent.
export class FailurePolicy {
  constructor({
    config,
    store,
    lark,
    logger,
    liveness = null,
    runtime,
    recordActivity,
    isStopping = () => false,
  }) {
    this.config = config;
    this.store = store;
    this.lark = lark;
    this.logger = logger;
    this.liveness = liveness;
    this.runtime = runtime;
    this.recordActivity = recordActivity;
    this.isStopping = isStopping;
    // conversationKey -> { summary, atMs } of the last delivered failure notice.
    // Repeats of the same error stay muted until a turn for that conversation
    // succeeds, the error changes, or the mute TTL expires (see notifyTurnFailure).
    this.failureNoticeMutes = new Map();
    // Automatic claude → codex fallback state (see tryModelFallback).
    this.fallbackInProgress = false;
    this.lastFallbackAtMs = 0;
  }

  // A successful turn clears the failure-notice mute for every conversation it
  // consumed messages from: the next failure there is news again.
  onTurnSucceeded({ inboundSeqs }) {
    if (this.failureNoticeMutes.size === 0) return;
    for (const seq of Array.isArray(inboundSeqs) ? inboundSeqs : []) {
      let inbound = null;
      try { inbound = this.store.inboundBySeq(seq); } catch { continue; }
      if (inbound?.conversationKey) this.failureNoticeMutes.delete(inbound.conversationKey);
    }
  }

  // A failed turn first gets one shot at the automatic claude → codex fallback;
  // when that is not applicable (or the switch itself fails) the normal failure
  // notice goes out instead.
  async onTurnFailed(info) {
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
    if (this.isStopping() || this.store.getCognitionState().runtime !== 'claude') return false;
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
      await this.runtime.transition({ kind: 'select-model', selector: model });
    } catch (switchError) {
      this.recordActivity('agent.fallback', {
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
    this.recordActivity('agent.fallback', {
      summary: `claude 失败，已自动切换到 ${model} 重试`,
      status: 'SWITCHED',
      conversationKey: rows.at(-1)?.conversationKey,
      inboundSeq: seqs.at(-1),
      metadata: { model, error: errorSummary, inboundSeqs: seqs },
    });
    const last = rows.at(-1);
    const notice = `⚠️ 因 ${errorSummary} 报错，已自动切换到 ${model} 重试`.slice(0, 600);
    await journaledReply(this, last, notice, 'daemon_fallback_notice', `fallback-notice:${last.messageId}`);
    // Redeliver the failed turn to the fallback runtime. A failure of the retry
    // surfaces through the normal onTurnFailed path (runtime is codex now).
    this.runtime.submit(rows.map((row) => ({
      text: formatInboundLine(row, null, {
        replyTo: resolveReplyTarget(this.store, row),
      }),
      seq: row.seq,
      conversationKey: row.conversationKey,
      scope: { kind: 'lark', conversationKey: row.conversationKey },
    })));
    return true;
  }

  // A failed turn consumes its messages without replying; tell the sender
  // programmatically. Best effort: reply to the last inbound message of the
  // failed turn. Repeats of the same error in the same conversation are muted
  // (activity only) until a turn succeeds or the error changes, so a persistent
  // failure does not spam the chat.
  async notifyTurnFailure({ inboundSeqs, error }) {
    if (this.isStopping()) return;
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
      this.recordActivity('agent.failure_notice', {
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
    this.recordActivity('agent.failure_notice', {
      summary: errorSummary,
      status: inbound?.messageId ? 'NOTIFYING' : 'NO_TARGET',
      conversationKey: inbound?.conversationKey,
      inboundSeq: seq ?? undefined,
    });
    if (!inbound?.messageId) return;
    const sent = await journaledReply(
      this, inbound, notice, 'daemon_failure_reply', `failure-notice:${inbound.messageId}`,
    );
    if (!sent.ok) {
      if (sent.stage === 'send') {
        this.recordActivity('agent.failure_notice', {
          summary: safeChatLookupError(sent.error),
          status: 'FAILED',
          conversationKey: inbound.conversationKey,
          inboundSeq: seq ?? undefined,
        });
      }
      return;
    }
    // Only a delivered notice arms the mute; a failed send stays eligible to retry.
    if (inbound.conversationKey) {
      this.failureNoticeMutes.set(inbound.conversationKey, { summary: errorSummary, atMs: Date.now() });
    }
  }
}
