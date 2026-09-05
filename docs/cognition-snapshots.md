# Cognition snapshots

Native Codex/Claude/Pi compaction only manages the native transcript. The
daemon's event ledger is independent. Previously, replacing an unresumable
session or switching runtimes replayed the entire cognition epoch. This could
undo the size benefit of native compaction and hit the 120,000-character
handoff limit.

## Ledger and handoff are separate

`cognition_journal` remains the original audit/deduplication ledger. No rows are
deleted or rewritten by snapshotting. `cognition_snapshots` stores versioned,
model-authored summaries and unresolved inbound message references, keyed by
`(epoch, through_seq)`. A checkpoint covers a source prefix, not a new epoch.
It contains decisions, constraints and artifact references, not native hidden
reasoning or private tool output.

During a real turn, the agent can call `save_cognition_snapshot`. Once at least
40 records or 16,000 source characters have accumulated since the last saved
checkpoint, the next constructed handoff requests one. No extra model process,
timer-driven model turn or external Lark message is created. This is cooperative
checkpointing: an agent can defer it when it lacks context. Native compaction
events themselves are not exported or intercepted.

The writer verifies the active runtime token and epoch inside a SQLite
transaction, requires a real source cursor, and validates unresolved references
against covered inbound rows. Checkpoints move forward; retrying the identical
checkpoint is idempotent. A changed checkpoint at the same cursor is rejected.
Previous open requests carry forward automatically. Removing one requires an
explicit `resolved_message_ids` entry; a missing entry in a new summary cannot
silently close it. These checks validate provenance, not the semantic quality of a generated
summary. The agent must carry forward unresolved work and must not claim to
summarize history it has not read.

## Bounded replay

All four adapters and runtime-switch preflight use the shared
`cognitionHistoryPrefix` projection. Its total target is 32,000 characters,
further capped by `LARK_DAEMON_COGNITION_MAX_CHARS` (existing default 120,000).
It loads the latest compatible checkpoint plus newer records, newest first for
selection and chronological for display. Selection reads at most 128 records
with 4,000-character source excerpts per record. Excerpts carry source cursors.
If a checkpoint cannot fit a smaller configured budget, it is explicitly linked
for retrieval instead of silently cut mid-summary.

A legacy epoch without a checkpoint, or a large delta after one, falls back to
recent records plus an explicit archive-gap notice. **That notice is not a
semantic summary.** It preserves access to originals, but older task context
requires retrieval. `read_cognition_journal` provides bounded pages, exact
chat/thread/message filters, optional scope inventory, and character offsets
for oversized records. Keeping the filters fixed while following the returned
cursor reconstructs complete originals. `read_cognition_snapshot` retrieves a
checkpoint omitted by the prompt budget.

Current-session incremental replay continues to skip its own successful
deliveries and empty deltas. Snapshots already covered by its acceptance cursor
are not re-injected. Acceptance means the runtime received this bounded view;
it does not claim the model read every archived source record.

## Uncertain delivery is independent

Handoff queries the current PENDING/UNCERTAIN count through its source cursor,
including rows older than the snapshot. The count and retrieval instruction are
always included when nonzero. Source statuses remain in the ledger and are
read via `uncertain_only=true`; a snapshot cannot turn uncertainty into failure
or permission to retry. This avoids freezing a PENDING status that settles after
the checkpoint was saved.

## Rollout and limits

The new table is an additive startup migration. Rollback to older code ignores
it and can still read the untouched ledger. The policy change can cause a fresh
native session under the existing policy-hash rule. New trusted tools are
available after the updated daemon/MCP process starts; editing the workspace
does not update a running release.

Snapshotting does not prune old epochs on disk, infer completion from a reply,
fix crash-time input scheduling, or copy proprietary native session formats.
Semantic handoff quality still depends on checkpoint generation and retrieval.
Tests cover bounded legacy replay, persistent summary plus delta, provenance
and authority checks, idempotency, epoch/cursor isolation, Unicode pagination,
live uncertainty, and native incremental replay.
