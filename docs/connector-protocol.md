# Personal Agent Connector protocol 0.2

The Core owns one agent runtime session and one OpenViking space. Connector
processes own provider credentials, receive loops, provider state, and external
side effects. A Core may start more than one Connector and routes all accepted
events into the same runtime session.

The protocol uses newline-delimited JSON over child process stdin/stdout. Stdout
is reserved for protocol messages; Connector logs go to stderr. Every message
contains:

```json
{
  "protocol_version": "0.2",
  "type": "REQUEST"
}
```

## Manifest and lifecycle

The Core starts a Connector and calls these operations in order:

1. `spec`: return the versioned manifest.
2. `check`: validate credentials, configuration, and provider availability.
3. `start`: begin receiving events.
4. `action`: execute a typed external action.
5. `pause`: stop event intake while keeping actions available for Core shutdown draining.
6. `stop`: drain and exit.

Each Connector fails on its own. When a worker exits unexpectedly, or fails
`check` or `start`, the Core restarts it from `spec` with backoff (5 s, 15 s,
1 min, then every 5 min) while the runtime and the other Connectors keep
running. It counts as recovered after 30 s of running, and its backoff starts
over. A Connector that cannot go on (an expired login, a lost long connection)
should send `STATUS failed` with a short `detail.error`, then exit; the Core
shows that reason in Activity. Actions for a Connector that is down are refused
before any outbox reservation (`connector_unavailable`). Startup fails only
when no Connector passes `check` and `start`.

Example manifest:

```json
{
  "protocol_version": "0.2",
  "name": "weixin",
  "version": "openclaw-weixin-protocol/2.4.9",
  "capabilities": ["events", "actions"],
  "actions": {
    "message.send": { "content": ["markdown", "file"] },
    "message.reply": { "content": ["markdown", "file"] }
  },
  "queries": ["message.media"],
  "auth_schema": { "type": "object", "additionalProperties": false },
  "config_schema": { "type": "object", "additionalProperties": false }
}
```

Capabilities are optional modules:

- `events`: subscribed, polled, or webhook events that may wake the agent.
- `actions`: external side effects such as sending a message or creating an event.
- `search`: on-demand reads requested by the agent.
- `sync`: bulk or incremental records destined for OpenViking.

`actions` declares the outbound operations the Core may route to this
Connector. `content` lists the message bodies an action accepts (`markdown`,
`file`, `file_key`, `card`); `mentions` and `thread` opt into those Lark
features; `idempotent: true` means the provider honours the idempotency key, so
the Core may retry an `UNCERTAIN` attempt with the same key. `queries` lists the
read-only operations. The Core offers an agent tool only when some configured
Connector declares the operation behind it, and checks every call against the
target Connector's declaration.

Version 0.2 implements `events`, `actions` and `queries`. Future `search` results should
reuse the team's normalized Document shape. Future `sync` implementations
should reuse `spec/check/discover/read` and `RECORD/SCHEMA/STATE` semantics.

## Event envelope

```json
{
  "protocol_version": "0.2",
  "type": "EVENT",
  "id": "issue-opened-delivery-123",
  "connector": "github",
  "instance": "github-personal",
  "kind": "issue.opened",
  "occurred_at": 1791374400000,
  "subject": { "type": "issue", "id": "owner/repo#123" },
  "actor": { "id": "provider-user-id", "type": "user" },
  "content": {
    "title": "Review requested",
    "text": "Please investigate this issue.",
    "attachments": []
  }
}
```

`connector` identifies the provider; `instance` identifies a configured source
instance/account and is unique within a Core. Built-in Lark and Weixin currently
use `instance=lark` and `instance=weixin`. The source process authenticates both
identities; input cannot select another Connector's identity.

`id` is required and stable across retries. The Core deduplicates on
`(instance, id)`, not a globally unique message id. An id identifies an event
occurrence, whereas `subject` identifies the object it concerns. For example a
Calendar Connector can use `reminder:meeting-42:2026-10-09T10:00Z:10m` for one
scheduled reminder. Redelivery keeps that id; another occurrence or reminder
rule uses a different id. Do not generate a new UUID or use receive time on
every delivery. Provider-native stable event ids are preferred when available.

`occurred_at` is UTC epoch milliseconds. `subject.type` and `subject.id` are
required; `actor`, `content.title`, `content.text`, and `content.attachments` are
optional. Each attachment is a reference with `id` and `type`, not inline bytes.
An event such as `reminder.due` can have no actor or text and still wake the agent.

Chat events additionally carry optional structured fields:

```json
{
  "conversation": {
    "id": "provider-chat-id", "type": "p2p",
    "tenant_id": "provider-account-id", "thread_id": null
  },
  "message": {
    "id": "provider-message-id", "type": "text",
    "parent_id": null, "root_id": null, "thread_root_id": null, "mentions": []
  },
  "reply_route": {
    "action": "message.reply", "input": { "message_id": "provider-message-id" }
  }
}
```

A missing reply route means no automatic reply target exists; it does not mean
that processing failed. A subject or actor id is never inferred to be a send
target. Notifications to a different Connector need a configured or explicitly
authorized destination. Choosing silence is independent of having a reply route.
A reply route may also belong to a non-chat event (for example `issue.comment`);
the Core invokes that action on the event's instance with `input` plus a
markdown `content` body, through the same outbox as agent deliveries.
Failure-notice muting uses the event scope, and its outbound history keeps the
source, subject and action without inventing a chat.

Lark's Connector decodes message, card-action, and meeting envelopes. Weixin's
Connector produces canonical chat events directly. The Core validates and
consumes only the fields above, plus optional typed extension `data`. Provider
raw envelopes are not required, forwarded to the runtime, or persisted. A
`provider_event` diagnostic field is ignored. Protocol 0.1 is rejected.

## Persistence and runtime input

`connector_events` is the single inbound ledger for every source. It stores the
canonical envelope and nullable chat indexes, with a unique `(connector_instance,
event_id)` constraint. There is no separate `inbound` message table or old-schema
migration. Use a fresh data directory for this pre-release schema change.

Generic runtime inputs retain the event semantics:

```text
[source=github instance=github-personal kind=issue.opened event=delivery-123 subject=issue:owner/repo#123 time=2026-10-09T10:00Z] title and body
```

Chat input keeps `chat=`, `msg=`, thread, mentions and reply context, and also
carries `event=`. An optional `instance=` is included when it differs from
`source=`. Tag values percent-encode whitespace, brackets and `%`, so an id
copied from a tag decodes back to the exact id. Untrusted content is
collapsed onto one physical line. Journal-to-OpenViking synchronization uses the
same formatter, so native session recovery preserves event identity and subject.

The Harness applies shared validation, filtering, persistence, and admission to
all events. Only replyable direct text/post chat messages can execute slash
commands. Only message events in a group are burst-batched; subject events are
submitted immediately or queued when the runtime cannot accept them. Lark roster
lookups require a Lark conversation. Failure retry retains the canonical event;
an event without a reply route records `NO_TARGET` instead of attempting an IM
reply. Specialized card and meeting handlers consume normalized extension data.

The generic event contract does not provide an inbound ACK/replay guarantee.
Connector cursor durability and Core acknowledgement are separate work; the
current Weixin receive loop still checkpoints after emitting events to stdout.

## Actions and the outbox

Every outbound action, whichever runtime asked, goes through one Core service
and one SQLite `outbox` table:

```
agent runtime ── MCP adapter (Codex, Claude) ─┐
              └─ CLI (Pi) ───────────────────┴─> <dataDir>/actions.sock
                                                   │ Core ActionService
                                                   │  runtime authority
                                                   │  route to a Connector
                                                   │  freshness fence + attribution
                                                   │  content + manifest checks
                                                   │  outbox + journal reserve
                                                   ▼
                                                 Connector `action` request
```

The adapters only relay `tools/list` / `tools/call` (`GET /v1/tools`,
`POST /v1/call`) with the runtime's authority token; neither validates nor
executes. The socket is mode `0600`. Agent runtimes never open a Connector
state database or call a provider API to send messages.

Every delivery names the input it acts on as `decision_id`: that input's
`event=`, or its `msg=` as an alias, copied as the tag shows it. The Core
resolves it to one accepted event `(instance, event_id, seq, scope_key)`;
`decision_instance` narrows the lookup to one instance. A reference that matches
several accepted events (an event id equal to another event's message id,
several events about one message, one event id on two instances) is refused
with `decision_ambiguous`, never settled by taking the newest.

The freshness fence is a conservative default: a decision is stale once the
Core has accepted a later event in its scope, the conversation for chat events
and `(instance, subject.type, subject.id)` otherwise, ordered by the Core's
receive `seq`, never by provider time. A newer event does not cancel earlier
work: `response_to_id` may name an earlier event in that scope, for attribution
only. Right before the outbox reservation the Core re-checks runtime authority
and the scope of the event it first resolved. The Connector defines what one
subject is, for example whether the occurrences of a recurring calendar event
share a subject (so a new occurrence makes the previous reminder stale) or each
have their own.

The Core derives the idempotency key from the decision and response events'
`(instance, event_id)`, the target and the canonical payload, so one event named
by `msg=` or `event=` is one delivery while two events with the same text are two
(a caller-supplied key is bound to that payload), reserves it in
`outbox` together with a `PENDING` outbound journal row, and only then sends the
Connector `action` request. It records `SENT` only after the Connector replies
successfully; any failure, or a process exit between remote acceptance and the
reply, leaves the row `UNCERTAIN`. A repeated identical request returns the
earlier result instead of sending again. An `UNCERTAIN` row is retried with the
same key only when the action is declared `idempotent`; otherwise it stays
blocked. Daemon-authored replies (slash command results, failure notices) use
the same path with a key per event and purpose.

```json
{
  "protocol_version": "0.2",
  "type": "REQUEST",
  "id": "request-id",
  "operation": "action",
  "payload": {
    "name": "message.reply",
    "input": {
      "message_id": "provider-message-id",
      "content": { "type": "markdown", "text": "hello" },
      "idempotency_key": "ld_..."
    }
  }
}
```

A `file` body arrives as `{ "type": "file", "path": "<absolute snapshot path>",
"name": "report.pdf" }`: the Core has already validated the workspace file and
frozen it in a private directory, which it removes after the attempt. Markdown
mentions arrive as `mentions: [{ id, name? }]` already resolved by the Core.
Results report the delivered `message_id` and, where known, `chat_id`,
`thread_id` and `root_id`.

## Current actions

| Operation | Lark | Weixin |
| --- | --- | --- |
| `message.send`, `message.reply` | markdown, file, file key, card; mentions; threads; idempotent | markdown (plain text), file |
| `message.react`, `message.retract` | yes | — |
| `message.media` (query) | download by image/file key | downloaded inbound media |
| `chat.list`, `chat.messages`, `message.search`, `thread.messages` (queries) | yes | — |

The Lark Connector also serves Core-internal operations that are not agent
tools: `message.reaction.delete` (temporary working reactions), `card.update`,
`chat.members.list`, `chat.get` and the meeting operations.
