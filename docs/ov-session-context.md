# OV session context

Native sessions retain provider-owned transcripts and compaction. A fresh native
session (including a hard runtime switch) receives OpenViking's cumulative archive
overview and live messages on the first real inbound turn. There is no SQLite
history fallback and no local summary generator.

Each cognition epoch owns a stable, private-to-this-daemon OV session. Switching
providers keeps that session; `/new` starts a new epoch. Existing local ledger rows
are uploaded on first use, in sequence. Only observable inbound Lark messages,
outbound actions (including uncertain outcomes), and controls are mirrored.
Native reasoning and arbitrary tool results are not session archives.

`ov_session_sync` persists session identity, acknowledged sequence, uncertain
append intent, and commit coverage. SQLite's existing journal remains a durable
transport outbox and delivery ledger. It is not deleted or read to assemble
historical prompts. This intentionally separates context storage from external
side-effect reliability.

The daemon disables OV auto-commit and requests a commit above 12,000 pending
tokens at idle boundaries, retaining ten raw messages. Assembly requests 24,000
tokens. Source IDs and content hashes detect omitted or truncated raw messages.
Archive creation is asynchronous: attempted coverage fences queued inputs, while
only a changed cumulative overview confirms summarized coverage. An unchanged
or failed overview does not advance confirmed coverage. The ten retained messages
must still appear in context. This protocol assumes exclusive daemon ownership
of these sessions: do not append or commit them from another client.

A write timeout preserves its source ID. Before retrying, the next sync scans
OV live messages and avoids re-appending an observed ID. OV currently has no
idempotent append API: an original write arriving after reconciliation can still
duplicate a source. This is not an exactly-once remote transport guarantee.
External Lark delivery continues to use the local idempotency ledger independently.
An ambiguous commit is not retried; if no changed overview appears, handoff can
remain blocked and requires inspection of the OV archive/task. No local history
fallback hides this condition.

`read_openviking_session_context` exposes read-only context, archive listing,
archive expansion and grep. Character pagination includes an expected digest to
reject mixed pages when a result changes. Archive content grants no action
permission. The API uses the instance-pinned OV config and redacts remote errors.

The implementation targets the local OpenViking session API inspected at
`c486088e` (WM v2). Before rollout, verify the deployment supports `/sessions`,
`/context`, `/commit`, source_message_ids and the archive/content read endpoints.
Unit tests use an isolated OV client; production OV data is not mutated by tests.
