import { getRuntimeDefinition } from './runtime-catalog.mjs';
import { opaqueRef, safeError } from './logger.mjs';

// Seqs already nudged in this process. A restart forgets them: the ledger is
// durable, the reminder is best effort.
const NUDGED_LIMIT = 1_000;

// A switch that only means something to a runtime with Core agent tools
// (explicitSilence: stay_silent and the turn-end check; stagedReplies: interim
// messages). On the others it is inert, so say so once per runtime instead of
// letting an operator believe it is on. Returns whether it warned.
function warnIfInert(on, runtime, logger, message, what) {
  if (!on) return false;
  if (getRuntimeDefinition(runtime)?.capabilities.agentTools === 'core') return false;
  logger.warn(message, {
    runtime,
    reason: `runtime has no core agent tools; ${what} is not applied for this runtime`,
  });
  return true;
}

export function warnIfSilenceInert(config, runtime, logger) {
  return warnIfInert(config.explicitSilence, runtime, logger, 'explicit_silence_not_applied', 'explicit silence');
}

export function warnIfStagedRepliesInert(config, runtime, logger) {
  return warnIfInert(config.stagedReplies, runtime, logger, 'staged_replies_not_applied', 'staged replies');
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
// gets one reminder line (same event=, undecided=1, no seq); a seq is reminded
// about at most once per process, and a later miss on it is only recorded.
export class DecisionPolicy {
  constructor({ store, harness, logger, recordActivity, isStopping = () => false }) {
    Object.assign(this, { store, harness, logger, recordActivity, isStopping });
    this.nudged = new Set();
  }

  onTurnSucceeded({ inboundSeqs = [] } = {}) {
    if (this.isStopping()) return;
    const runtime = this.store.getCognitionState().runtime;
    if (getRuntimeDefinition(runtime)?.capabilities.agentTools !== 'core') return;
    try {
      this.settle({ inboundSeqs, runtime });
    } catch (error) {
      this.logger.warn('decision_settlement_failed', { error: safeError(error) });
    }
  }

  settle({ inboundSeqs, runtime }) {
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
      if (!this.nudged.has(row.seq)) {
        this.remember(row.seq);
        this.harness.redeliverUndecided(row);
        this.missing(row, 'NUDGED', runtime);
        this.logger.info('decision_nudged', { seq: row.seq, conversationRef: opaqueRef(scopeKey) });
        counts.nudged += 1;
      } else {
        this.missing(row, 'MISSING', runtime);
      }
    }
    if (scopes.size > 0) this.logger.info('decision_settlement', counts);
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
