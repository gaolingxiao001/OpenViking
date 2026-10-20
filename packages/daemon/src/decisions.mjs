import { getRuntimeDefinition } from './runtime-catalog.mjs';
import { resolveReplyTarget } from './runtime-input.mjs';
import { opaqueRef, safeError } from './logger.mjs';

const NUDGE_RECEIPT = 'decision:';
// Seqs already nudged in this process. A restart forgets them: the ledger is
// durable, the reminder is best effort.
const NUDGED_LIMIT = 1_000;

export function isDecisionReceipt(receiptId) {
  return typeof receiptId === 'string' && receiptId.startsWith(NUDGE_RECEIPT);
}

// Whether an unsettled input is one the model is expected to decide on, from
// what its row already says: a direct chat, a card answer, or a group message
// quoting the bot. Ambient group chat and non-chat events (mail) stay optional:
// the daemon does not know its own open_id, so an @mention is not visible here.
function expected(store, row) {
  if (!row.chatId || !row.kind?.startsWith('message.')) return false;
  if (row.chatType === 'p2p' || row.messageType === 'card_action') return true;
  return resolveReplyTarget(store, row)?.kind === 'me';
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
      if (!expected(this.store, row)) {
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
