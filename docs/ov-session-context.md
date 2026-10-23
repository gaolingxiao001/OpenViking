# OV session context

Native sessions retain provider-owned transcripts and compaction. A fresh native
session (including a hard runtime switch) receives OpenViking's recent raw
messages on the first real inbound turn. Older history stays in OV archives,
which the model reads on demand with `read_openviking_session_context`. There
is no SQLite history fallback and no local summary generator. Whether the
handoff carries enough history is not checked here; a fuller cross-runtime
handoff is expected from OV itself.

OpenViking is required. Installation and setup verify it with public health plus
a protected `GET /api/v1/system/status`, which passes the same identity check as
the session API at a cost that does not grow with the user's sessions. At daemon startup a config or credential
OV rejects (4xx) stops the daemon; an OV that cannot be reached yet only records
`system.ov_unavailable`, so boot order or a blip during a restart cannot use up
pm2's restarts. Any failure while preparing history (unreachable OV, an invalid
or malformed response) starts the fresh native session without history, without
stopping message delivery or sending a failure notice to chat. Cached history is
discarded on that failure; transport cursors and uncertain writes remain durable
and the idle checkpoint retries. Recovery does not inject history into an
already-running native transcript.

`agents[].ovAutoRecall` defaults to `false`. When enabled it sets the runtime
plugin's auto-recall switch with `peer_scope=actor`; it does not control this
session transport, auto-capture, or commit-on-compact.

Each cognition epoch owns a stable, private-to-this-daemon OV session. Switching
providers keeps that session; `/new` starts a new epoch. Existing local ledger rows
are uploaded on first use, in sequence. Only observable inbound Connector events,
outbound actions (including uncertain outcomes), and controls are mirrored:
inbound and control rows as `user` messages, outbound rows as `assistant`
messages. Native reasoning and arbitrary tool results are not session archives.
An outbound row still `PENDING` holds the sync cursor until it settles; a
handoff prepared meanwhile carries the rows before it.

`ov_session_sync` persists session identity, acknowledged sequence and uncertain
append intent. SQLite's cognition journal remains the durable source for this
sync and the outbound delivery ledger; the `outbox` table guards the external
side effects themselves. Neither is read to assemble historical prompts. This
intentionally separates context storage from external side-effect reliability.

The daemon never uses OV's Working Memory. It is off by default since it became
opt-in after v0.4.23: a completed archive has no overview, and `/context`
returns only the raw messages of archives still being processed plus the live
messages, trimmed to the requested budget by complete turns, newest first.
Releases up to v0.4.23, among them the Volcengine hosted service (v0.4.20.x),
still write one per archive: `latest_archive_overview` in `/context`,
`.overview.md` / `.abstract.md` in the archive directory, and a `checkpoint`
message that `/context` inserts after a turn whose earlier part was archived
(its text kept in the archive's `.meta.json`). The VLM-written document only
grows. The daemon does not change OV's settings to stop it (a session-level
memory policy would replace the user's whole one); it drops the overview and
checkpoint messages from the handoff and from every tool result, so history is
raw messages on every release. A checkpoint (at most 1,024 tokens, one turn)
still counts against the context budget before it is dropped. The daemon disables OV auto-commit. At idle boundaries, once
OV reports 24,000 pending tokens, it commits with `retention_mode=turn_budget`,
keeping the newest complete turns, up to 24,000 tokens, live as raw messages.
Assembly requests 48,000 tokens, so the live session fits whole. No commit
state is kept locally: OV's pending tokens decide every commit, and a commit
with an unknown outcome is safe to repeat, because one that landed leaves
nothing pending. A commit runs only after a complete sync, so an uncertain
append is reconciled before it can be archived. This protocol assumes exclusive
daemon ownership of these sessions: do not append or commit them from another
client.

A write timeout preserves its source ID. Before retrying, the next sync scans
OV live messages and avoids re-appending an observed ID. OV currently has no
idempotent append API: an original write arriving after reconciliation can still
duplicate a source. This is not an exactly-once remote transport guarantee.
External deliveries (Lark, Weixin) use the Core `outbox` idempotency ledger
independently.

`read_openviking_session_context` exposes read-only context, archive listing,
archive reading (the original messages) and grep. Archives are read from their
stored `history/<archive>/messages.jsonl`, not OV's archive API, which adds the
Working Memory where a release writes one, answers 404 up to v0.4.23 for an
archive without it, and skips archives still being processed. Listing drops the
Working Memory abstract; grep keeps only matches in `messages.jsonl`. Character pagination includes
an expected digest to reject mixed pages when a result changes. Archive content
grants no action permission. The API uses the instance-pinned OV config and
redacts remote errors.

The implementation targets the local OpenViking session API inspected at
`c01bb34d` (Working Memory off by default, `turn_budget` retention) and was
checked against the hosted service at v0.4.20.6 (Working Memory on). Before
rollout, verify the deployment supports `/sessions`, `/context`, `/commit` with
`retention_mode`, source_message_ids and the content read endpoint.
Unit tests use an isolated OV client; production OV data is not mutated by tests.
