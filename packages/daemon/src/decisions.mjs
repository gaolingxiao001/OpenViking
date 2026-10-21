import { getRuntimeDefinition } from './runtime-catalog.mjs';
import { opaqueRef, safeError } from './logger.mjs';

const NUDGE_RECEIPT = 'decision:';
// Seqs already nudged in this process. A restart forgets them: the ledger is
// durable, the reminder is best effort.
const NUDGED_LIMIT = 1_000;

// explicitSilence only means something to a runtime with Core agent tools
// (stay_silent, the turn-end check). On the others it is inert, so say so once
// per runtime instead of letting an operator believe it is on. Returns whether
// it warned.
export function warnIfSilenceInert(config, runtime, logger) {
  if (!config.explicitSilence) return false;
  if (getRuntimeDefinition(runtime)?.capabilities.agentTools === 'core') return false;
  logger.warn('explicit_silence_not_applied', {
    runtime,
    reason: 'runtime has no core agent tools; explicit silence is not applied for this runtime',
  });
  return true;
}

export function isDecisionReceipt(receiptId) {
  return typeof receiptId === 'string' && receiptId.startsWith(NUDGE_RECEIPT);
}

// Whether an unsettled input needs a decision: every chat message on every IM
// (direct, group, thread, card answer), as zouk asks a send or no_reply of
// every inbound message. A reminder costs a turn only when the model missed
// one. Non-chat events (mail) stay optional: each is its own subject scope and
// one owner notice may rightly cover several, so a mail without its own
// decision is not reliably a miss, and nobody is waiting in a conversation.
function expected(row) {
  return Boolean(row.chatId) && Boolean(row.kind?.startsWith('message.'));
}

// Turn-end check that every input a successful turn consumed ended in a
// decision: a final delivery or stay_silent (the ledger in `decisions`). It
// never judges the decision, never sends anything, and never touches the
// inbound ledger, freshness or the outbox. An expected input with no decision
// gets one reminder line (same event=, undecided=1, no seq); a second miss is
// only recorded.
export class DecisionPolicy {
  constructor({ config, store, harness, logger, recordActivity, isStopping = () => false }) {
    Object.assign(this, { config, store, harness, logger, recordActivity, isStopping });
    this.nudged = new Set();
  }

  onTurnSucceeded({ inboundSeqs = [], receiptIds = [] } = {}) {
    if (this.isStopping()) return;
    const runtime = this.store.getCognitionState().runtime;
    if (getRuntimeDefinition(runtime)?.capabilities.agentTools !== 'core') return;
    try {
      this.settle({ inboundSeqs, receiptIds, runtime });
    } catch (error) {
      this.logger.warn('decision_settlement_failed', { error: safeError(error) });
    }
  }

  // A failed turn belongs to FailurePolicy (notice, or the claude → codex
  // resubmit of the same seqs); an abandoned one stays in the native thread or
  // becomes catch-up history. Neither is a decision, and a reminder receipt on
  // either is dropped.
  onTurnFailed() {}

  onTurnAbandoned() {}

  settle({ inboundSeqs, receiptIds, runtime }) {
    const scopes = new Map();
    for (const seq of Array.isArray(inboundSeqs) ? inboundSeqs : []) {
      if (seq === null || seq === undefined) continue;
      const row = this.store.inboundBySeq(seq);
      if (row?.status !== 'DONE' || !row.scopeKey) continue;
      const current = scopes.get(row.scopeKey);
      if (!current || row.seq > current.seq) scopes.set(row.scopeKey, row);
    }
    const counts = { delivered: 0, silent: 0, superseded: 0, expected_unsettled: 0, optional_unsettled: 0, nudged: 0 };
    for (const [scopeKey, row] of scopes) {
      const outcome = this.store.coveringDecision(scopeKey, row.seq);
      if (outcome) {
        counts[outcome === 'delivered' ? 'delivered' : 'silent'] += 1;
        continue;
      }
      // The newer input is checked when its own turn ends.
      if (this.store.newerAcceptedSeq(scopeKey, row.seq) !== null) {
        counts.superseded += 1;
        continue;
      }
      if (!expected(row)) {
        counts.optional_unsettled += 1;
        continue;
      }
      counts.expected_unsettled += 1;
      if (this.config.decisionNudge && !this.nudged.has(row.seq)) {
        this.remember(row.seq);
        this.harness.redeliverUndecided(row, { receiptId: `${NUDGE_RECEIPT}${row.seq}` });
        this.missing(row, 'NUDGED', runtime);
        this.logger.info('decision_nudged', { seq: row.seq, conversationRef: opaqueRef(scopeKey) });
        counts.nudged += 1;
      } else {
        this.missing(row, 'MISSING', runtime);
      }
    }
    // A reminder turn that still ended without a decision is final.
    for (const receiptId of Array.isArray(receiptIds) ? receiptIds : []) {
      if (!isDecisionReceipt(receiptId)) continue;
      const seq = Number(receiptId.slice(NUDGE_RECEIPT.length));
      const row = Number.isSafeInteger(seq) ? this.store.inboundBySeq(seq) : null;
      if (!row?.scopeKey) continue;
      if (this.store.coveringDecision(row.scopeKey, row.seq)
        || this.store.newerAcceptedSeq(row.scopeKey, row.seq) !== null) continue;
      this.missing(row, 'UNSETTLED', runtime);
    }
    if (scopes.size > 0 || receiptIds.some(isDecisionReceipt)) this.logger.info('decision_settlement', counts);
    return counts;
  }

  remember(seq) {
    this.nudged.add(seq);
    if (this.nudged.size > NUDGED_LIMIT) this.nudged.delete(this.nudged.values().next().value);
  }

  missing(row, status, runtime) {
    this.recordActivity('agent.decision_missing', {
      status,
      conversationKey: row.conversationKey,
      inboundSeq: row.seq,
      metadata: { expectation: 'expected', runtime },
    });
  }
}
