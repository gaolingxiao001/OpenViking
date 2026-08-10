import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { opaqueRef } from './logger.mjs';
import {
  activityDefinition,
  activityPhase,
  cleanActivityMetadata,
  cleanActivityText,
  reasonLabel,
} from './activity.mjs';

function number(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function rowToInbound(row) {
  if (!row) return null;
  return {
    seq: number(row.seq),
    messageId: row.message_id,
    eventId: row.event_id,
    conversationKey: row.conv_key,
    chatId: row.chat_id,
    chatType: row.chat_type,
    messageType: row.message_type,
    senderId: row.sender_id,
    senderType: row.sender_type,
    rootId: row.root_id,
    parentId: row.parent_id,
    threadId: row.thread_id,
    threadRootId: row.thread_root_id,
    content: row.content,
    mentions: JSON.parse(row.mentions_json || '[]'),
    createTimeMs: number(row.create_time_ms),
    receivedAtMs: number(row.received_at_ms),
    status: row.status,
    filterReason: row.filter_reason,
    turnId: row.turn_id === null ? null : number(row.turn_id),
  };
}

function rowToChatSource(row) {
  if (!row) return null;
  return {
    chatId: row.chat_id,
    sourceRef: row.source_ref,
    chatType: row.chat_type,
    name: row.name,
    lookupStatus: row.lookup_status,
    failureCount: number(row.failure_count),
    lastLookupAtMs: row.last_lookup_at_ms === null ? null : number(row.last_lookup_at_ms),
    nextLookupAtMs: number(row.next_lookup_at_ms),
    createdAtMs: number(row.created_at_ms),
    updatedAtMs: number(row.updated_at_ms),
  };
}

function rowToCognitionJournal(row) {
  if (!row) return null;
  return {
    seq: number(row.seq),
    epoch: number(row.epoch),
    kind: row.kind,
    status: row.status,
    atMs: number(row.at_ms),
    inboundSeq: row.inbound_seq === null ? null : number(row.inbound_seq),
    chatId: row.chat_id,
    threadId: row.thread_id,
    messageId: row.message_id,
    actor: row.actor,
    text: row.text,
    metadata: parseJsonObject(row.detail_json),
  };
}

function rowToMeetingSession(row) {
  if (!row) return null;
  return {
    sessionKey: row.session_key,
    meetingId: row.meeting_id,
    meetingNumber: row.meeting_no,
    callId: row.call_id,
    inviteEventId: row.invite_event_id,
    status: row.status,
    pageToken: row.page_token,
    lastSequence: row.last_sequence === null ? null : number(row.last_sequence),
    lastEventAtMs: row.last_event_at_ms === null ? null : number(row.last_event_at_ms),
    joinedAtMs: row.joined_at_ms === null ? null : number(row.joined_at_ms),
    endedAtMs: row.ended_at_ms === null ? null : number(row.ended_at_ms),
    lastError: row.last_error,
    updatedAtMs: number(row.updated_at_ms),
  };
}

function rowToMeetingEvent(row) {
  if (!row) return null;
  return {
    id: number(row.id),
    eventKey: row.event_key,
    meetingId: row.meeting_id,
    eventType: row.event_type,
    activityType: row.activity_type,
    occurredAtMs: number(row.occurred_at_ms),
    receivedAtMs: number(row.received_at_ms),
    payload: parseJsonObject(row.payload_json),
    journalSeq: row.journal_seq === null ? null : number(row.journal_seq),
    inboxBatchId: row.inbox_batch_id === null || row.inbox_batch_id === undefined
      ? null
      : number(row.inbox_batch_id),
    inboxReadAtMs: row.inbox_read_at_ms === null || row.inbox_read_at_ms === undefined
      ? null
      : number(row.inbox_read_at_ms),
  };
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function maskPublicIdentifiers(value) {
  return cleanActivityText(value, 4000)
    .replace(/\b(?:om|oc|ou|on|omt|cli)_[A-Za-z0-9_-]{6,}\b/g, '[LARK_ID]');
}

function chatIdFromConversationKey(value) {
  if (!value) return null;
  const match = String(value).match(/:([^:]+):(?:main|thread:[^:]+)$/);
  return match?.[1] || null;
}

function sourceRefFromConversationKey(value) {
  return opaqueRef(chatIdFromConversationKey(value)) || opaqueRef(value);
}

const PUBLIC_METADATA_KEYS = new Set([
  'action', 'attempt', 'backfilled', 'batchSize', 'bytes', 'chatType',
  'code', 'codexVersion', 'deliveryMode', 'dryRun', 'eventMode', 'exitCode',
  'durationMs', 'expired', 'filterReason', 'inboundSeqs', 'interruptedTurns', 'itemType', 'larkVersion',
  'messageType', 'outboxes', 'reason', 'reasonCode', 'removed',
  'requestedDeliveryMode', 'signal', 'toolLabel', 'toolName', 'toolServer', 'toolStatus',
]);
const PUBLIC_NESTED_METADATA_KEYS = new Set(['conversations', 'inbound', 'outbox', 'turns']);

function publicMetadataValue(value) {
  if (typeof value === 'string') return maskPublicIdentifiers(value);
  if (Array.isArray(value)) return value.slice(0, 50).map(publicMetadataValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).slice(0, 50)
        .filter(([key]) => PUBLIC_NESTED_METADATA_KEYS.has(key))
        .map(([key, child]) => [key, publicMetadataValue(child)]),
    );
  }
  return value;
}

function publicMetadata(value) {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => PUBLIC_METADATA_KEYS.has(key))
      .map(([key, child]) => [key, publicMetadataValue(child)]),
  );
}

function rowToPublicActivity(row) {
  const sourceRef = row.source_ref || (row.conv_key ? sourceRefFromConversationKey(row.conv_key) : 'system');
  const sourceType = row.source_type || (row.conv_key ? null : 'system');
  return {
    id: number(row.id),
    kind: row.kind,
    category: row.category,
    severity: row.severity,
    priority: number(row.priority),
    title: maskPublicIdentifiers(row.title),
    summary: maskPublicIdentifiers(row.summary),
    conversationRef: opaqueRef(row.conv_key),
    sourceRef,
    sourceType,
    sourceName: row.source_name ? maskPublicIdentifiers(row.source_name) : null,
    turnId: row.turn_id === null ? null : number(row.turn_id),
    inboundSeq: row.inbound_seq === null ? null : number(row.inbound_seq),
    outboxId: row.outbox_id === null ? null : number(row.outbox_id),
    status: row.status,
    metadata: publicMetadata(parseJsonObject(row.detail_json)),
    createdAtMs: number(row.occurred_at_ms),
  };
}

export class Store {
  constructor(databasePath, logger) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    try { fs.chmodSync(databasePath, 0o600); } catch {}
    this.logger = logger;
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.migrate();
    this.prepare();
    this.backfillChatSources();
    this.backfillActivities();
    this.backfillActivitySources();
    this.backfillActivitySourceNames();
  }

  migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS conversations (
        conv_key TEXT PRIMARY KEY,
        session_id TEXT,
        policy_hash TEXT,
        pending_draft_json TEXT,
        last_ingress_seq INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS inbound (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        event_id TEXT UNIQUE,
        conv_key TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        message_type TEXT NOT NULL,
        sender_id TEXT,
        sender_type TEXT,
        root_id TEXT,
        parent_id TEXT,
        thread_id TEXT,
        thread_root_id TEXT,
        content TEXT NOT NULL,
        mentions_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        create_time_ms INTEGER NOT NULL,
        received_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        filter_reason TEXT,
        turn_id INTEGER,
        last_error TEXT,
        FOREIGN KEY (conv_key) REFERENCES conversations(conv_key)
      );

      CREATE INDEX IF NOT EXISTS inbound_conv_status_seq
        ON inbound(conv_key, status, seq);
      CREATE INDEX IF NOT EXISTS inbound_received_at
        ON inbound(received_at_ms);

      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conv_key TEXT NOT NULL,
        start_seq INTEGER NOT NULL,
        end_seq INTEGER NOT NULL,
        snapshot_seq INTEGER NOT NULL,
        target_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        decision_action TEXT,
        reason_code TEXT,
        reply TEXT,
        error TEXT,
        started_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        completed_at_ms INTEGER,
        FOREIGN KEY (conv_key) REFERENCES conversations(conv_key)
      );

      CREATE INDEX IF NOT EXISTS turns_conv_status
        ON turns(conv_key, status, id);
      CREATE INDEX IF NOT EXISTS turns_status_completed
        ON turns(status, completed_at_ms);

      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        turn_id INTEGER NOT NULL UNIQUE,
        conv_key TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,
        reply_to_message_id TEXT NOT NULL,
        reply_in_thread INTEGER NOT NULL DEFAULT 0,
        delivery_mode TEXT NOT NULL DEFAULT 'reply',
        target_chat_id TEXT,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        last_attempt_ms INTEGER,
        remote_message_id TEXT,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        sent_at_ms INTEGER,
        FOREIGN KEY (turn_id) REFERENCES turns(id),
        FOREIGN KEY (conv_key) REFERENCES conversations(conv_key)
      );

      CREATE INDEX IF NOT EXISTS outbox_status_updated
        ON outbox(status, updated_at_ms);
      CREATE INDEX IF NOT EXISTS outbox_status_sent
        ON outbox(status, sent_at_ms);

      CREATE TABLE IF NOT EXISTS activities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL,
        category TEXT NOT NULL,
        severity TEXT NOT NULL,
        priority INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL DEFAULT '',
        conv_key TEXT,
        source_ref TEXT,
        source_type TEXT,
        source_name TEXT,
        turn_id INTEGER,
        inbound_seq INTEGER,
        outbox_id INTEGER,
        status TEXT,
        detail_json TEXT NOT NULL DEFAULT '{}',
        occurred_at_ms INTEGER NOT NULL,
        recorded_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS activities_time
        ON activities(occurred_at_ms DESC, id DESC);
      CREATE INDEX IF NOT EXISTS activities_priority
        ON activities(priority DESC, id DESC);
      CREATE INDEX IF NOT EXISTS activities_kind
        ON activities(kind, id DESC);
      CREATE INDEX IF NOT EXISTS activities_conversation
        ON activities(conv_key, id DESC);
      CREATE INDEX IF NOT EXISTS activities_turn
        ON activities(turn_id, id);
      CREATE INDEX IF NOT EXISTS activities_inbound
        ON activities(inbound_seq, id);

      CREATE TABLE IF NOT EXISTS chat_sources (
        chat_id TEXT PRIMARY KEY,
        source_ref TEXT NOT NULL,
        chat_type TEXT NOT NULL,
        name TEXT,
        lookup_status TEXT NOT NULL DEFAULT 'PENDING',
        failure_count INTEGER NOT NULL DEFAULT 0,
        last_lookup_at_ms INTEGER,
        next_lookup_at_ms INTEGER NOT NULL DEFAULT 0,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS chat_sources_lookup
        ON chat_sources(chat_type, next_lookup_at_ms);

      CREATE TABLE IF NOT EXISTS meeting_sessions (
        session_key TEXT PRIMARY KEY,
        meeting_id TEXT UNIQUE,
        meeting_no TEXT,
        call_id TEXT,
        invite_event_id TEXT,
        status TEXT NOT NULL,
        page_token TEXT,
        last_sequence INTEGER,
        last_event_at_ms INTEGER,
        joined_at_ms INTEGER,
        ended_at_ms INTEGER,
        last_error TEXT,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS meeting_sessions_status
        ON meeting_sessions(status, updated_at_ms);

      CREATE TABLE IF NOT EXISTS meeting_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_key TEXT NOT NULL UNIQUE,
        meeting_id TEXT,
        event_type TEXT NOT NULL,
        activity_type TEXT,
        occurred_at_ms INTEGER NOT NULL,
        received_at_ms INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        journal_seq INTEGER,
        inbox_batch_id INTEGER,
        inbox_read_at_ms INTEGER
      );

      CREATE INDEX IF NOT EXISTS meeting_events_received
        ON meeting_events(received_at_ms);

      CREATE TABLE IF NOT EXISTS meeting_inbox_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        meeting_id TEXT NOT NULL,
        first_event_id INTEGER NOT NULL,
        last_event_id INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        created_at_ms INTEGER NOT NULL,
        notified_at_ms INTEGER,
        UNIQUE(meeting_id, first_event_id, last_event_id)
      );

      -- Canonical, daemon-owned observable cognition shared by every chat and
      -- every model runtime. Runtime-native transcripts stay opaque; a hard
      -- runtime switch starts one fresh target session and catches it up from
      -- this ordered journal instead of reviving a stale per-runtime session.
      CREATE TABLE IF NOT EXISTS cognition_journal (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        epoch INTEGER NOT NULL,
        kind TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'COMMITTED',
        at_ms INTEGER NOT NULL,
        inbound_seq INTEGER,
        chat_id TEXT,
        thread_id TEXT,
        message_id TEXT,
        actor TEXT,
        text TEXT NOT NULL DEFAULT '',
        runtime_token TEXT,
        dedupe_key TEXT UNIQUE,
        detail_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS cognition_journal_epoch_seq
        ON cognition_journal(epoch, seq);
      CREATE INDEX IF NOT EXISTS cognition_journal_runtime_token
        ON cognition_journal(runtime_token, seq);

      -- A prior sidecar may have died after Lark accepted an action but before
      -- its local commit. Preserve that ambiguity for catch-up; never silently
      -- treat it as failed and invite a duplicate send.
      UPDATE cognition_journal SET status = 'UNCERTAIN' WHERE status = 'PENDING';
    `);
    const inboundColumns = new Set(
      this.db.prepare('PRAGMA table_info(inbound)').all().map((row) => row.name),
    );
    if (!inboundColumns.has('thread_id')) {
      this.db.exec('ALTER TABLE inbound ADD COLUMN thread_id TEXT');
    }
    const meetingEventColumns = new Set(
      this.db.prepare('PRAGMA table_info(meeting_events)').all().map((row) => row.name),
    );
    if (!meetingEventColumns.has('inbox_batch_id') || !meetingEventColumns.has('inbox_read_at_ms')) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!meetingEventColumns.has('inbox_batch_id')) {
          this.db.exec('ALTER TABLE meeting_events ADD COLUMN inbox_batch_id INTEGER');
        }
        if (!meetingEventColumns.has('inbox_read_at_ms')) {
          this.db.exec('ALTER TABLE meeting_events ADD COLUMN inbox_read_at_ms INTEGER');
        }
        // Rows journaled by the previous release have already been exposed to
        // the model. Mark them read so an upgrade never replays old transcripts.
        this.db.exec(`
          UPDATE meeting_events
          SET inbox_read_at_ms = COALESCE(inbox_read_at_ms, received_at_ms)
          WHERE journal_seq IS NOT NULL
        `);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS meeting_events_pending_v2
        ON meeting_events(meeting_id, inbox_batch_id, id);
      CREATE INDEX IF NOT EXISTS meeting_events_inbox
        ON meeting_events(inbox_read_at_ms, inbox_batch_id, id)
    `);
    const outboxColumns = new Set(
      this.db.prepare('PRAGMA table_info(outbox)').all().map((row) => row.name),
    );
    if (!outboxColumns.has('delivery_mode') || !outboxColumns.has('target_chat_id')) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!outboxColumns.has('delivery_mode')) {
          this.db.exec("ALTER TABLE outbox ADD COLUMN delivery_mode TEXT NOT NULL DEFAULT 'reply'");
          this.db.exec("UPDATE outbox SET delivery_mode = CASE WHEN reply_in_thread <> 0 THEN 'thread' ELSE 'reply' END");
        }
        if (!outboxColumns.has('target_chat_id')) {
          this.db.exec('ALTER TABLE outbox ADD COLUMN target_chat_id TEXT');
        }
        this.db.exec(`
          UPDATE outbox
          SET target_chat_id = (
            SELECT inbound.chat_id
            FROM turns JOIN inbound ON inbound.seq = turns.end_seq
            WHERE turns.id = outbox.turn_id
          )
          WHERE target_chat_id IS NULL
        `);
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }
    const activityColumns = new Set(
      this.db.prepare('PRAGMA table_info(activities)').all().map((row) => row.name),
    );
    if (!activityColumns.has('source_ref')
      || !activityColumns.has('source_type')
      || !activityColumns.has('source_name')) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        if (!activityColumns.has('source_ref')) {
          this.db.exec('ALTER TABLE activities ADD COLUMN source_ref TEXT');
        }
        if (!activityColumns.has('source_type')) {
          this.db.exec('ALTER TABLE activities ADD COLUMN source_type TEXT');
        }
        if (!activityColumns.has('source_name')) {
          this.db.exec('ALTER TABLE activities ADD COLUMN source_name TEXT');
        }
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    }
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS activities_source
        ON activities(source_ref, id DESC)
    `);
  }

  prepare() {
    this.insertConversation = this.db.prepare(`
      INSERT INTO conversations(conv_key, created_at_ms, updated_at_ms)
      VALUES (?, ?, ?)
      ON CONFLICT(conv_key) DO NOTHING
    `);
    this.insertInbound = this.db.prepare(`
      INSERT OR IGNORE INTO inbound(
        message_id, event_id, conv_key, chat_id, chat_type, message_type,
        sender_id, sender_type, root_id, parent_id, thread_id, thread_root_id,
        content, mentions_json, raw_json, create_time_ms, received_at_ms,
        status, filter_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getInboundByMessage = this.db.prepare('SELECT * FROM inbound WHERE message_id = ?');
    this.getInboundByEvent = this.db.prepare('SELECT * FROM inbound WHERE event_id = ?');
    this.getMetaStatement = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    this.setMetaStatement = this.db.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.deleteGlobalSessionStatement = this.db.prepare(
      `DELETE FROM meta WHERE key IN (
        'global_session_id', 'global_policy_hash', 'global_session_runtime',
        'global_session_epoch', 'global_session_synced_through_seq',
        'global_session_ready'
      )`,
    );
    this.insertJournalStatement = this.db.prepare(`
      INSERT OR IGNORE INTO cognition_journal(
        epoch, kind, status, at_ms, inbound_seq, chat_id, thread_id,
        message_id, actor, text, runtime_token, dedupe_key, detail_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.insertActivityStatement = this.db.prepare(`
      INSERT OR IGNORE INTO activities(
        event_key, kind, category, severity, priority, title, summary,
        conv_key, source_ref, source_type, source_name, turn_id, inbound_seq, outbox_id,
        status, detail_json, occurred_at_ms, recorded_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.updateActivitySourceStatement = this.db.prepare(`
      UPDATE activities SET source_ref = ?, source_type = ?, source_name = ?
      WHERE id = ? AND source_ref IS NULL
    `);
    this.getActivitySourceByInboundStatement = this.db.prepare(`
      SELECT inbound.chat_id, inbound.chat_type, chat_sources.name AS source_name
      FROM inbound
      LEFT JOIN chat_sources ON chat_sources.chat_id = inbound.chat_id
      WHERE inbound.seq = ?
    `);
    this.getActivitySourceByTurnStatement = this.db.prepare(`
      SELECT inbound.chat_id, inbound.chat_type, chat_sources.name AS source_name
      FROM turns
      JOIN inbound ON inbound.seq = turns.end_seq
      LEFT JOIN chat_sources ON chat_sources.chat_id = inbound.chat_id
      WHERE turns.id = ?
    `);
    this.getActivitySourceByOutboxStatement = this.db.prepare(`
      SELECT COALESCE(outbox.target_chat_id, inbound.chat_id) AS chat_id,
             inbound.chat_type AS chat_type,
             chat_sources.name AS source_name
      FROM outbox
      LEFT JOIN turns ON turns.id = outbox.turn_id
      LEFT JOIN inbound ON inbound.seq = turns.end_seq
      LEFT JOIN chat_sources
        ON chat_sources.chat_id = COALESCE(outbox.target_chat_id, inbound.chat_id)
      WHERE outbox.id = ?
    `);
    this.getChatSourceStatement = this.db.prepare(`
      SELECT * FROM chat_sources WHERE chat_id = ?
    `);
    this.upsertChatSourceStatement = this.db.prepare(`
      INSERT INTO chat_sources(
        chat_id, source_ref, chat_type, lookup_status, failure_count,
        next_lookup_at_ms, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 'PENDING', 0, 0, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET
        source_ref = excluded.source_ref,
        chat_type = excluded.chat_type,
        updated_at_ms = MAX(chat_sources.updated_at_ms, excluded.updated_at_ms)
    `);
    this.resolveChatSourceStatement = this.db.prepare(`
      UPDATE chat_sources
      SET name = ?, lookup_status = 'RESOLVED', failure_count = 0,
          last_lookup_at_ms = ?, next_lookup_at_ms = ?, updated_at_ms = ?
      WHERE chat_id = ?
    `);
    this.deferChatSourceStatement = this.db.prepare(`
      UPDATE chat_sources
      SET lookup_status = ?, failure_count = failure_count + 1,
          last_lookup_at_ms = ?, next_lookup_at_ms = ?, updated_at_ms = ?
      WHERE chat_id = ?
    `);
    this.updateActivitiesSourceNameStatement = this.db.prepare(`
      UPDATE activities SET source_name = ? WHERE source_ref = ?
    `);
  }

  resolveActivitySource(activity) {
    let row = null;
    if (activity.inboundSeq !== undefined && activity.inboundSeq !== null) {
      row = this.getActivitySourceByInboundStatement.get(activity.inboundSeq);
    }
    if (!row?.chat_id && activity.outboxId !== undefined && activity.outboxId !== null) {
      row = this.getActivitySourceByOutboxStatement.get(activity.outboxId);
    }
    if (!row?.chat_id && activity.turnId !== undefined && activity.turnId !== null) {
      row = this.getActivitySourceByTurnStatement.get(activity.turnId);
    }
    if (!row?.chat_id) {
      const chatId = chatIdFromConversationKey(activity.conversationKey);
      const source = chatId ? this.getChatSourceStatement.get(chatId) : null;
      return {
        sourceRef: sourceRefFromConversationKey(activity.conversationKey) || null,
        sourceType: ['p2p', 'group'].includes(
          activity.sourceType || activity.chatType || activity.metadata?.chatType,
        )
          ? (activity.sourceType || activity.chatType || activity.metadata?.chatType)
          : null,
        sourceName: source?.name ?? null,
      };
    }
    return {
      sourceRef: opaqueRef(row.chat_id),
      sourceType: ['p2p', 'group'].includes(row.chat_type) ? row.chat_type : null,
      sourceName: row.source_name ?? null,
    };
  }

  recordActivity(activity, recordedAtMs = Date.now()) {
    if (!activity?.eventKey || !activity?.kind) {
      throw new Error('activity requires eventKey and kind');
    }
    const definition = activityDefinition(activity.kind);
    const metadata = cleanActivityMetadata(activity.metadata);
    const source = this.resolveActivitySource(activity);
    const result = this.insertActivityStatement.run(
      cleanActivityText(activity.eventKey, 500),
      activity.kind,
      activity.category ?? definition.category,
      activity.severity ?? definition.severity,
      activity.priority ?? definition.priority,
      cleanActivityText(activity.title ?? definition.title, 200),
      cleanActivityText(activity.summary, 4000),
      activity.conversationKey ?? null,
      source.sourceRef,
      source.sourceType,
      source.sourceName,
      activity.turnId ?? null,
      activity.inboundSeq ?? null,
      activity.outboxId ?? null,
      activity.status ?? null,
      JSON.stringify(metadata),
      activity.occurredAtMs ?? recordedAtMs,
      recordedAtMs,
    );
    return number(result.changes) > 0;
  }

  backfillActivitySources() {
    return this.transaction(() => {
      let updated = 0;
      const rows = this.db.prepare(`
        SELECT id, conv_key, inbound_seq, outbox_id, turn_id, detail_json
        FROM activities
        WHERE source_ref IS NULL
          AND (inbound_seq IS NOT NULL OR outbox_id IS NOT NULL OR turn_id IS NOT NULL)
        ORDER BY id
      `).all();
      for (const row of rows) {
        const source = this.resolveActivitySource({
          inboundSeq: row.inbound_seq,
          outboxId: row.outbox_id,
          turnId: row.turn_id,
          conversationKey: row.conv_key,
          chatType: parseJsonObject(row.detail_json).chatType,
        });
        if (!source.sourceRef) continue;
        updated += number(this.updateActivitySourceStatement.run(
          source.sourceRef,
          source.sourceType,
          source.sourceName,
          row.id,
        ).changes);
      }
      return updated;
    });
  }

  rememberChatSource(chatId, chatType, now = Date.now()) {
    if (!chatId || !['p2p', 'group'].includes(chatType)) return false;
    const result = this.upsertChatSourceStatement.run(
      chatId,
      opaqueRef(chatId),
      chatType,
      now,
      now,
    );
    return number(result.changes) > 0;
  }

  backfillChatSources() {
    return this.transaction(() => {
      let updated = 0;
      const rows = this.db.prepare(`
        SELECT chat_id, chat_type,
               MIN(received_at_ms) AS created_at_ms,
               MAX(received_at_ms) AS updated_at_ms
        FROM inbound
        WHERE chat_type IN ('p2p', 'group')
        GROUP BY chat_id, chat_type
      `).all();
      for (const row of rows) {
        updated += number(this.upsertChatSourceStatement.run(
          row.chat_id,
          opaqueRef(row.chat_id),
          row.chat_type,
          number(row.created_at_ms),
          number(row.updated_at_ms),
        ).changes);
      }
      return updated;
    });
  }

  chatNameLookupCandidate(chatId, now = Date.now()) {
    const row = this.getChatSourceStatement.get(chatId);
    if (!row || row.chat_type !== 'group' || number(row.next_lookup_at_ms) > now) return null;
    return rowToChatSource(row);
  }

  dueChatNameLookups(now = Date.now(), limit = 20) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.db.prepare(`
      SELECT * FROM chat_sources
      WHERE chat_type = 'group' AND next_lookup_at_ms <= ?
      ORDER BY next_lookup_at_ms, updated_at_ms
      LIMIT ?
    `).all(now, safeLimit).map(rowToChatSource);
  }

  saveChatSourceName(chatId, name, nextLookupAtMs, now = Date.now()) {
    const safeName = cleanActivityText(name, 200);
    if (!safeName) return false;
    return this.transaction(() => {
      const source = this.getChatSourceStatement.get(chatId);
      if (!source || source.chat_type !== 'group') return false;
      const updated = this.resolveChatSourceStatement.run(
        safeName,
        now,
        nextLookupAtMs,
        now,
        chatId,
      );
      if (number(updated.changes) === 0) return false;
      this.updateActivitiesSourceNameStatement.run(safeName, source.source_ref);
      return true;
    });
  }

  deferChatSourceName(chatId, status, nextLookupAtMs, now = Date.now()) {
    const safeStatus = status === 'EMPTY' ? 'EMPTY' : 'RETRY';
    return number(this.deferChatSourceStatement.run(
      safeStatus,
      now,
      nextLookupAtMs,
      now,
      chatId,
    ).changes) > 0;
  }

  backfillActivitySourceNames() {
    return number(this.db.prepare(`
      UPDATE activities
      SET source_name = (
        SELECT chat_sources.name
        FROM chat_sources
        WHERE chat_sources.source_ref = activities.source_ref
      )
      WHERE source_name IS NULL
        AND EXISTS (
          SELECT 1 FROM chat_sources
          WHERE chat_sources.source_ref = activities.source_ref
            AND chat_sources.name IS NOT NULL
        )
    `).run().changes);
  }

  closeRunningSubscriberActivities(status = 'STOPPED') {
    const safeStatus = status === 'FAILED' ? 'FAILED' : 'STOPPED';
    return number(this.db.prepare(`
      UPDATE activities SET status = ?
      WHERE kind = 'system.subscriber_started' AND status = 'RUNNING'
    `).run(safeStatus).changes);
  }

  backfillActivities(now = Date.now()) {
    return this.transaction(() => {
      let inserted = 0;
      const pending = [];
      const add = (activity) => {
        pending.push(activity);
      };

      for (const row of this.db.prepare('SELECT * FROM inbound ORDER BY seq').all()) {
        const expired = row.filter_reason === 'queue_expired';
        const ignored = row.status === 'RULE_IGNORED' && !expired;
        const queueRejected = ['queue_total_full', 'queue_conversation_full', 'queue_expired']
          .includes(row.filter_reason);
        add({
          eventKey: `inbound:${row.seq}:${expired ? 'expired' : ignored ? 'ignored' : 'received'}`,
          kind: expired ? 'message.expired' : ignored ? 'message.ignored' : 'message.received',
          conversationKey: row.conv_key,
          inboundSeq: number(row.seq),
          status: row.status,
          severity: queueRejected ? 'warn' : undefined,
          priority: queueRejected ? 85 : undefined,
          summary: expired
            ? (row.content || '排队时间过长，消息未交给 Agent')
            : ignored
              ? `未进入 Agent：${reasonLabel(row.filter_reason)}`
              : row.content,
          occurredAtMs: number(row.received_at_ms),
          metadata: {
            chatType: row.chat_type,
            messageType: row.message_type,
            filterReason: row.filter_reason,
          },
        });
      }

      const turns = this.db.prepare(`
        SELECT t.*, i.content AS input_content,
          EXISTS(SELECT 1 FROM outbox o WHERE o.turn_id = t.id) AS has_outbox
        FROM turns t LEFT JOIN inbound i ON i.seq = t.end_seq
        ORDER BY t.id
      `).all();
      for (const row of turns) {
        const inboundSeqs = this.db.prepare(`
          SELECT seq FROM inbound WHERE turn_id = ? ORDER BY seq
        `).all(row.id).map((inbound) => number(inbound.seq));
        add({
          eventKey: `turn:${row.id}:started`,
          kind: 'agent.started',
          conversationKey: row.conv_key,
          turnId: number(row.id),
          inboundSeq: number(row.end_seq),
          status: 'RUNNING',
          summary: row.input_content,
          occurredAtMs: number(row.started_at_ms),
          metadata: {
            batchSize: inboundSeqs.length || (number(row.end_seq) - number(row.start_seq) + 1),
            inboundSeqs,
          },
        });
        if (row.decision_action === 'ignore' || row.status === 'SILENT') {
          add({
            eventKey: `turn:${row.id}:decision`,
            kind: 'agent.silent',
            conversationKey: row.conv_key,
            turnId: number(row.id),
            inboundSeq: number(row.end_seq),
            status: row.status,
            summary: `未回复：${reasonLabel(row.reason_code)}`,
            occurredAtMs: number(row.updated_at_ms),
            metadata: { action: 'ignore', reasonCode: row.reason_code },
          });
        } else if (row.decision_action === 'reply' && (row.status !== 'STALE' || row.has_outbox)) {
          add({
            eventKey: `turn:${row.id}:decision`,
            kind: 'agent.decided',
            conversationKey: row.conv_key,
            turnId: number(row.id),
            inboundSeq: number(row.end_seq),
            status: row.status,
            summary: row.reply,
            occurredAtMs: number(row.completed_at_ms ?? row.updated_at_ms),
            metadata: { action: 'reply', reasonCode: row.reason_code },
          });
        }
        if (row.status === 'STALE') {
          add({
            eventKey: `turn:${row.id}:stale`,
            kind: 'agent.stale',
            conversationKey: row.conv_key,
            turnId: number(row.id),
            inboundSeq: number(row.end_seq),
            status: row.status,
            summary: '有更新消息，旧回复未发送',
            occurredAtMs: number(row.updated_at_ms),
            metadata: { reasonCode: row.reason_code },
          });
        } else if (row.status === 'DEAD') {
          add({
            eventKey: `turn:${row.id}:failed`,
            kind: 'agent.failed',
            conversationKey: row.conv_key,
            turnId: number(row.id),
            inboundSeq: number(row.end_seq),
            status: row.status,
            summary: row.error,
            occurredAtMs: number(row.completed_at_ms ?? row.updated_at_ms),
          });
        } else if (row.status === 'INTERRUPTED') {
          add({
            eventKey: `turn:${row.id}:interrupted`,
            kind: 'agent.interrupted',
            conversationKey: row.conv_key,
            turnId: number(row.id),
            inboundSeq: number(row.end_seq),
            status: row.status,
            summary: row.error || 'daemon stopped during Codex turn',
            occurredAtMs: number(row.completed_at_ms ?? row.updated_at_ms),
          });
        }
      }

      for (const row of this.db.prepare('SELECT * FROM outbox ORDER BY id').all()) {
        add({
          eventKey: `outbox:${row.id}:queued`,
          kind: 'delivery.queued',
          conversationKey: row.conv_key,
          turnId: number(row.turn_id),
          outboxId: number(row.id),
          status: 'PENDING',
          summary: row.body,
          occurredAtMs: number(row.created_at_ms),
          metadata: { deliveryMode: row.delivery_mode },
        });
        const finalKinds = {
          SENT: 'delivery.sent',
          DRY_RUN: 'delivery.dry_run',
          FAILED: 'delivery.failed',
          UNCERTAIN: 'delivery.uncertain',
          CANCELLED_STALE: 'delivery.cancelled',
        };
        const kind = finalKinds[row.status];
        if (kind) {
          add({
            eventKey: `outbox:${row.id}:${row.status.toLowerCase()}`,
            kind,
            conversationKey: row.conv_key,
            turnId: number(row.turn_id),
            outboxId: number(row.id),
            status: row.status,
            summary: ['FAILED', 'UNCERTAIN'].includes(row.status) ? row.last_error : row.body,
            occurredAtMs: number(row.sent_at_ms ?? row.updated_at_ms),
            metadata: {
              deliveryMode: row.delivery_mode,
              attempt: number(row.attempt_count),
            },
          });
        }
      }

      pending.sort((left, right) => (
        Number(left.occurredAtMs ?? 0) - Number(right.occurredAtMs ?? 0)
        || activityPhase(left.kind) - activityPhase(right.kind)
        || left.eventKey.localeCompare(right.eventKey)
      ));
      for (const activity of pending) {
        if (this.recordActivity({
          ...activity,
          metadata: { ...activity.metadata, backfilled: true },
        }, now)) inserted += 1;
      }
      return inserted;
    });
  }

  listActivities({ limit = 100, beforeId = null } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 100));
    const rows = beforeId === null
      ? this.db.prepare(`
        SELECT * FROM activities ORDER BY id DESC LIMIT ?
      `).all(safeLimit + 1)
      : this.db.prepare(`
        SELECT * FROM activities WHERE id < ? ORDER BY id DESC LIMIT ?
      `).all(beforeId, safeLimit + 1);
    const hasMore = rows.length > safeLimit;
    const visible = hasMore ? rows.slice(0, safeLimit) : rows;
    return {
      activities: visible.map(rowToPublicActivity),
      nextCursor: hasMore ? number(visible.at(-1).id) : null,
    };
  }

  activityOverview(now = Date.now()) {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    const startMs = start.getTime();
    const scalar = (sql, ...params) => number(this.db.prepare(sql).get(...params).count);
    const failedTurns = scalar(`
      SELECT COUNT(*) AS count FROM turns
      WHERE status IN ('DEAD', 'INTERRUPTED', 'SEND_FAILED')
    `);
    const uncertainOutboxes = scalar(`
      SELECT COUNT(*) AS count FROM outbox WHERE status = 'UNCERTAIN'
    `);
    const activeTurns = scalar(`
      SELECT COUNT(*) AS count FROM turns WHERE status = 'RUNNING'
    `);
    const activeOutboxes = scalar(`
      SELECT COUNT(*) AS count FROM outbox WHERE status IN ('PENDING', 'SENDING', 'RETRY')
    `);
    return {
      attention: failedTurns + uncertainOutboxes,
      active: activeTurns + activeOutboxes,
      queued: scalar(`SELECT COUNT(*) AS count FROM inbound WHERE status = 'QUEUED'`),
      receivedToday: scalar(`SELECT COUNT(*) AS count FROM inbound WHERE received_at_ms >= ?`, startMs),
      sentToday: scalar(`
        SELECT COUNT(*) AS count FROM outbox
        WHERE status IN ('SENT', 'DRY_RUN') AND sent_at_ms >= ?
      `, startMs),
      silentToday: scalar(`
        SELECT COUNT(*) AS count FROM turns
        WHERE status = 'SILENT' AND completed_at_ms >= ?
      `, startMs),
    };
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  // The daemon is a thin pipe now: an accepted message is recorded DONE and handed
  // straight to the codex thread. Filtered messages are recorded RULE_IGNORED with a
  // blanked body. Dedup is by message_id/event_id unique constraints.
  ingest(event, filterReason = null, now = Date.now()) {
    return this.transaction(() => {
      this.insertConversation.run(event.conversationKey, now, now);
      this.rememberChatSource(event.chatId, event.chatType, now);
      const status = filterReason ? 'RULE_IGNORED' : 'DONE';
      const result = this.insertInbound.run(
        event.messageId,
        event.eventId,
        event.conversationKey,
        event.chatId,
        event.chatType,
        event.messageType,
        event.senderId,
        event.senderType,
        event.rootId,
        event.parentId,
        event.threadId,
        event.threadRootId,
        filterReason ? '' : event.content,
        JSON.stringify(filterReason ? [] : event.mentions),
        '{}',
        event.createTimeMs,
        now,
        status,
        filterReason,
      );
      const inserted = number(result.changes) > 0;
      let row = this.getInboundByMessage.get(event.messageId);
      if (!row && event.eventId) row = this.getInboundByEvent.get(event.eventId);
      if (inserted) {
        const ignored = Boolean(filterReason);
        if (!ignored) {
          this.appendCognitionJournal({
            kind: 'inbound',
            atMs: event.createTimeMs || now,
            inboundSeq: number(row.seq),
            chatId: event.chatId,
            threadId: event.threadId,
            messageId: event.messageId,
            actor: event.senderId || 'unknown',
            text: event.content,
            dedupeKey: `inbound:${event.messageId}`,
          });
        }
        this.recordActivity({
          eventKey: `inbound:${row.seq}:${ignored ? 'ignored' : 'received'}`,
          kind: ignored ? 'message.ignored' : 'message.received',
          conversationKey: event.conversationKey,
          inboundSeq: number(row.seq),
          status,
          summary: ignored ? `未进入 Agent：${reasonLabel(filterReason)}` : event.content,
          occurredAtMs: now,
          metadata: {
            chatType: event.chatType,
            messageType: event.messageType,
            filterReason,
          },
        }, now);
      }
      return { inserted, inbound: rowToInbound(row), filterReason: row?.filter_reason ?? filterReason };
    });
  }

  upsertMeetingInvite({
    sessionKey,
    meetingId = null,
    meetingNumber,
    callId = null,
    eventId,
    atMs = Date.now(),
  }) {
    this.db.prepare(`
      INSERT INTO meeting_sessions(
        session_key, meeting_id, meeting_no, call_id, invite_event_id,
        status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, 'INVITED', ?, ?)
      ON CONFLICT(session_key) DO UPDATE SET
        meeting_id = COALESCE(excluded.meeting_id, meeting_sessions.meeting_id),
        meeting_no = COALESCE(excluded.meeting_no, meeting_sessions.meeting_no),
        call_id = COALESCE(excluded.call_id, meeting_sessions.call_id),
        invite_event_id = COALESCE(excluded.invite_event_id, meeting_sessions.invite_event_id),
        updated_at_ms = MAX(meeting_sessions.updated_at_ms, excluded.updated_at_ms)
    `).run(sessionKey, meetingId, meetingNumber, callId, eventId, atMs, atMs);
    return rowToMeetingSession(this.db.prepare(
      'SELECT * FROM meeting_sessions WHERE session_key = ?',
    ).get(sessionKey));
  }

  markMeetingJoining(sessionKey, atMs = Date.now()) {
    return number(this.db.prepare(`
      UPDATE meeting_sessions SET status = 'JOINING', last_error = NULL, updated_at_ms = ?
      WHERE session_key = ? AND status IN ('INVITED', 'FAILED')
    `).run(atMs, sessionKey).changes) > 0;
  }

  markMeetingJoinFailed(sessionKey, error, atMs = Date.now()) {
    return number(this.db.prepare(`
      UPDATE meeting_sessions SET status = 'FAILED', last_error = ?, updated_at_ms = ?
      WHERE session_key = ?
    `).run(String(error).slice(0, 2000), atMs, sessionKey).changes) > 0;
  }

  markMeetingJoined(sessionKey, { meetingId, meetingNumber = null, atMs = Date.now() }) {
    return this.transaction(() => {
      const placeholder = this.db.prepare(`
        SELECT * FROM meeting_sessions WHERE meeting_id = ? AND session_key <> ?
      `).get(meetingId, sessionKey);
      if (placeholder) {
        // A fast activity push can identify the meeting before the join command
        // returns. Merge that placeholder into the invite-correlated row rather
        // than colliding with the UNIQUE(meeting_id) constraint.
        this.db.prepare('DELETE FROM meeting_sessions WHERE session_key = ?')
          .run(placeholder.session_key);
      }
      this.db.prepare(`
        UPDATE meeting_sessions
        SET meeting_id = ?, meeting_no = COALESCE(?, meeting_no, ?),
            status = CASE WHEN ? = 'ENDED' THEN 'ENDED' ELSE 'JOINED' END,
            page_token = COALESCE(page_token, ?),
            last_sequence = CASE
              WHEN last_sequence IS NULL THEN ?
              WHEN ? IS NULL THEN last_sequence
              ELSE MAX(last_sequence, ?)
            END,
            last_event_at_ms = CASE
              WHEN last_event_at_ms IS NULL THEN ?
              WHEN ? IS NULL THEN last_event_at_ms
              ELSE MAX(last_event_at_ms, ?)
            END,
            joined_at_ms = COALESCE(joined_at_ms, ?),
            ended_at_ms = COALESCE(ended_at_ms, ?),
            last_error = NULL, updated_at_ms = ?
        WHERE session_key = ?
      `).run(
        meetingId,
        meetingNumber,
        placeholder?.meeting_no ?? null,
        placeholder?.status ?? null,
        placeholder?.page_token ?? null,
        placeholder?.last_sequence ?? null,
        placeholder?.last_sequence ?? null,
        placeholder?.last_sequence ?? null,
        placeholder?.last_event_at_ms ?? null,
        placeholder?.last_event_at_ms ?? null,
        placeholder?.last_event_at_ms ?? null,
        atMs,
        placeholder?.ended_at_ms ?? null,
        atMs,
        sessionKey,
      );
      return this.meetingSessionById(meetingId);
    });
  }

  ensureMeetingSession(meetingId, { meetingNumber = null, atMs = Date.now() } = {}) {
    this.db.prepare(`
      INSERT OR IGNORE INTO meeting_sessions(
        session_key, meeting_id, meeting_no, status, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, 'ACTIVE', ?, ?)
    `).run(`meeting:${meetingId}`, meetingId, meetingNumber, atMs, atMs);
    this.db.prepare(`
      UPDATE meeting_sessions
      SET meeting_no = COALESCE(?, meeting_no),
          status = CASE WHEN status IN ('ENDED', 'JOINING') THEN status ELSE 'ACTIVE' END,
          updated_at_ms = MAX(updated_at_ms, ?)
      WHERE meeting_id = ?
    `).run(meetingNumber, atMs, meetingId);
    return this.meetingSessionById(meetingId);
  }

  meetingSessionById(meetingId) {
    return rowToMeetingSession(this.db.prepare(
      'SELECT * FROM meeting_sessions WHERE meeting_id = ?',
    ).get(meetingId));
  }

  activeMeetingSessions() {
    return this.db.prepare(`
      SELECT * FROM meeting_sessions
      WHERE meeting_id IS NOT NULL AND status IN ('JOINED', 'ACTIVE')
      ORDER BY updated_at_ms
    `).all().map(rowToMeetingSession);
  }

  ingestMeetingEvent({
    eventKey,
    meetingId,
    eventType,
    activityType = null,
    occurredAtMs = Date.now(),
    payload = {},
    receivedAtMs = Date.now(),
  }) {
    const payloadJson = JSON.stringify(payload ?? {});
    const existing = this.db.prepare(`
      SELECT id, payload_json, inbox_batch_id, inbox_read_at_ms
      FROM meeting_events WHERE event_key = ?
    `).get(eventKey);
    // Live transcript pushes can revise the same sentence_id as speech
    // recognition stabilizes. Before the inbox item is read, retain the newest text.
    if (existing) {
      if (existing.payload_json === payloadJson) return false;
      // Revisions arriving before the agent reads the item can replace it in
      // place. After acknowledgement, retain the correction as a new inbox
      // item so a low-latency flush never freezes or drops a later ASR final.
      if (existing.inbox_read_at_ms === null) {
        return number(this.db.prepare(`
          UPDATE meeting_events
          SET event_type = ?, activity_type = ?, occurred_at_ms = ?,
              received_at_ms = ?, payload_json = ?
          WHERE id = ? AND inbox_read_at_ms IS NULL
        `).run(
          eventType,
          activityType,
          occurredAtMs,
          receivedAtMs,
          payloadJson,
          existing.id,
        ).changes) > 0 && existing.inbox_batch_id === null;
      }
      eventKey = `${eventKey}:revision:${createHash('sha256').update(payloadJson).digest('hex')}`;
    }
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO meeting_events(
        event_key, meeting_id, event_type, activity_type, occurred_at_ms,
        received_at_ms, payload_json, journal_seq
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
    `).run(
      eventKey,
      meetingId,
      eventType,
      activityType,
      occurredAtMs,
      receivedAtMs,
      payloadJson,
    );
    return number(result.changes) > 0;
  }

  updateMeetingProgress(meetingId, {
    pageToken = null,
    sequence = null,
    eventAtMs = null,
    atMs = Date.now(),
  } = {}) {
    return number(this.db.prepare(`
      UPDATE meeting_sessions SET
        page_token = COALESCE(?, page_token),
        last_sequence = CASE
          WHEN ? IS NULL THEN last_sequence
          WHEN last_sequence IS NULL OR ? > last_sequence THEN ?
          ELSE last_sequence
        END,
        last_event_at_ms = CASE
          WHEN ? IS NULL THEN last_event_at_ms
          WHEN last_event_at_ms IS NULL OR ? > last_event_at_ms THEN ?
          ELSE last_event_at_ms
        END,
        updated_at_ms = MAX(updated_at_ms, ?)
      WHERE meeting_id = ?
    `).run(
      pageToken,
      sequence, sequence, sequence,
      eventAtMs, eventAtMs, eventAtMs,
      atMs,
      meetingId,
    ).changes) > 0;
  }

  meetingHasSequenceGap(meetingId, sequence) {
    if (!Number.isSafeInteger(sequence)) return false;
    const previous = this.meetingSessionById(meetingId)?.lastSequence;
    return Number.isSafeInteger(previous) && sequence > previous + 1;
  }

  pendingMeetingEvents(meetingId, limit = 50) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
    return this.db.prepare(`
      SELECT * FROM meeting_events
      WHERE meeting_id = ? AND inbox_batch_id IS NULL AND inbox_read_at_ms IS NULL
      ORDER BY id LIMIT ?
    `).all(meetingId, safeLimit).map(rowToMeetingEvent);
  }

  pendingMeetingIds() {
    return this.db.prepare(`
      SELECT DISTINCT meeting_id FROM meeting_events
      WHERE meeting_id IS NOT NULL AND inbox_batch_id IS NULL AND inbox_read_at_ms IS NULL
      ORDER BY meeting_id
    `).all().map((row) => row.meeting_id);
  }

  commitMeetingInboxBatch(meetingId, rows, atMs = Date.now()) {
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return this.transaction(() => {
      const eligible = rows.filter((row) => {
        const current = this.db.prepare(`
          SELECT inbox_batch_id, inbox_read_at_ms FROM meeting_events WHERE id = ?
        `).get(row.id);
        return current && current.inbox_batch_id === null && current.inbox_read_at_ms === null;
      });
      if (eligible.length === 0) return null;
      const first = eligible[0];
      const last = eligible.at(-1);
      const inserted = this.db.prepare(`
        INSERT OR IGNORE INTO meeting_inbox_batches(
          meeting_id, first_event_id, last_event_id, event_count, created_at_ms
        ) VALUES (?, ?, ?, ?, ?)
      `).run(meetingId, first.id, last.id, eligible.length, atMs);
      const batch = this.db.prepare(`
        SELECT * FROM meeting_inbox_batches
        WHERE meeting_id = ? AND first_event_id = ? AND last_event_id = ?
      `).get(meetingId, first.id, last.id);
      if (!batch || number(inserted.changes) === 0) return null;
      const update = this.db.prepare(`
        UPDATE meeting_events SET inbox_batch_id = ?
        WHERE id = ? AND inbox_batch_id IS NULL AND inbox_read_at_ms IS NULL
      `);
      let committed = 0;
      for (const row of eligible) committed += number(update.run(batch.id, row.id).changes);
      if (committed !== eligible.length) throw new Error('meeting inbox batch changed during commit');
      return {
        batchId: number(batch.id),
        meetingId,
        eventCount: eligible.length,
        pendingCount: this.unreadMeetingInboxCount(),
      };
    });
  }

  unreadMeetingInboxCount(meetingId = null) {
    const row = meetingId
      ? this.db.prepare(`
        SELECT COUNT(*) AS count FROM meeting_events
        WHERE inbox_batch_id IS NOT NULL AND inbox_read_at_ms IS NULL AND meeting_id = ?
      `).get(meetingId)
      : this.db.prepare(`
        SELECT COUNT(*) AS count FROM meeting_events
        WHERE inbox_batch_id IS NOT NULL AND inbox_read_at_ms IS NULL
      `).get();
    return number(row?.count) || 0;
  }

  readMeetingInbox({ meetingId = null, limit = 100, atMs = Date.now() } = {}) {
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.transaction(() => {
      const rows = (meetingId
        ? this.db.prepare(`
          SELECT * FROM meeting_events
          WHERE inbox_batch_id IS NOT NULL AND inbox_read_at_ms IS NULL AND meeting_id = ?
          ORDER BY id LIMIT ?
        `).all(meetingId, safeLimit)
        : this.db.prepare(`
          SELECT * FROM meeting_events
          WHERE inbox_batch_id IS NOT NULL AND inbox_read_at_ms IS NULL
          ORDER BY id LIMIT ?
        `).all(safeLimit));
      const acknowledge = this.db.prepare(`
        UPDATE meeting_events SET inbox_read_at_ms = ?
        WHERE id = ? AND inbox_read_at_ms IS NULL
      `);
      for (const row of rows) acknowledge.run(atMs, row.id);
      return {
        items: rows.map((row) => rowToMeetingEvent({ ...row, inbox_read_at_ms: atMs })),
        remaining: this.unreadMeetingInboxCount(meetingId),
      };
    });
  }

  markMeetingInboxBatchesNotified(batchIds, atMs = Date.now()) {
    if (!Array.isArray(batchIds) || batchIds.length === 0) return 0;
    const update = this.db.prepare(`
      UPDATE meeting_inbox_batches SET notified_at_ms = COALESCE(notified_at_ms, ?) WHERE id = ?
    `);
    return this.transaction(() => batchIds.reduce(
      (count, id) => count + number(update.run(atMs, id).changes),
      0,
    ));
  }

  finishMeeting(meetingId, atMs = Date.now()) {
    return number(this.db.prepare(`
      UPDATE meeting_sessions
      SET status = 'ENDED', ended_at_ms = COALESCE(ended_at_ms, ?), updated_at_ms = ?
      WHERE meeting_id = ?
    `).run(atMs, atMs, meetingId).changes) > 0;
  }

  getCognitionState() {
    const epoch = Number.parseInt(this.getMetaStatement.get('global_cognition_epoch')?.value ?? '1', 10);
    return {
      runtime: this.getMetaStatement.get('active_runtime')?.value ?? 'codex',
      epoch: Number.isSafeInteger(epoch) && epoch > 0 ? epoch : 1,
      authorityToken: this.getMetaStatement.get('active_runtime_token')?.value ?? null,
    };
  }

  initializeCognition(runtime, authorityToken) {
    return this.transaction(() => {
      const current = this.getCognitionState();
      this.setMetaStatement.run('active_runtime', runtime);
      this.setMetaStatement.run('active_runtime_token', authorityToken);
      this.setMetaStatement.run('global_cognition_epoch', String(current.epoch));
      return { runtime, epoch: current.epoch, authorityToken };
    });
  }

  bumpCognitionEpoch(runtime, authorityToken) {
    return this.transaction(() => {
      const epoch = this.getCognitionState().epoch + 1;
      this.deleteGlobalSessionStatement.run();
      this.setMetaStatement.run('active_runtime', runtime);
      this.setMetaStatement.run('active_runtime_token', authorityToken);
      this.setMetaStatement.run('global_cognition_epoch', String(epoch));
      return { runtime, epoch, authorityToken };
    });
  }

  // Two-phase runtime commit. The target has already started under a
  // non-authoritative token. sessionReady distinguishes a real native
  // transcript from Claude's preassigned UUID before its first stdin turn.
  commitRuntimeSwitch({
    runtime,
    authorityToken,
    sessionId,
    policyHash,
    epoch,
    syncedThroughSeq = 0,
    sessionReady = true,
    model = '',
  }) {
    return this.transaction(() => {
      const current = this.getCognitionState();
      if (current.epoch !== epoch) throw new Error('cognition epoch changed during runtime switch');
      this.setMetaStatement.run('active_runtime', runtime);
      this.setMetaStatement.run('active_runtime_token', authorityToken);
      this.setMetaStatement.run('global_session_id', sessionId);
      this.setMetaStatement.run('global_policy_hash', policyHash);
      this.setMetaStatement.run('global_session_runtime', runtime);
      this.setMetaStatement.run('global_session_epoch', String(epoch));
      this.setMetaStatement.run('global_session_synced_through_seq', String(syncedThroughSeq));
      this.setMetaStatement.run('global_session_ready', sessionReady ? '1' : '0');
      this.setMetaStatement.run(`setting:${runtime}_model`, String(model));
      return { runtime, epoch, authorityToken };
    });
  }

  appendCognitionJournal({
    kind,
    status = 'COMMITTED',
    atMs = Date.now(),
    inboundSeq = null,
    chatId = null,
    threadId = null,
    messageId = null,
    actor = null,
    text = '',
    runtimeToken = null,
    dedupeKey = null,
    metadata = {},
    epoch = this.getCognitionState().epoch,
  }) {
    const result = this.insertJournalStatement.run(
      epoch,
      kind,
      status,
      atMs,
      inboundSeq,
      chatId,
      threadId,
      messageId,
      actor,
      text,
      runtimeToken,
      dedupeKey,
      JSON.stringify(metadata ?? {}),
    );
    if (number(result.changes) === 0 && dedupeKey) {
      return number(this.db.prepare('SELECT seq FROM cognition_journal WHERE dedupe_key = ?').get(dedupeKey)?.seq);
    }
    return number(this.db.prepare('SELECT last_insert_rowid() AS seq').get().seq);
  }

  cognitionJournal(
    epoch = this.getCognitionState().epoch,
    throughSeq = Number.MAX_SAFE_INTEGER,
    afterSeq = 0,
  ) {
    return this.db.prepare(`
      SELECT * FROM cognition_journal
      WHERE epoch = ? AND seq > ? AND seq <= ?
        AND status IN ('PENDING', 'COMMITTED', 'UNCERTAIN')
      ORDER BY seq
    `).all(epoch, afterSeq, throughSeq).map(rowToCognitionJournal);
  }

  cognitionJournalHead(epoch = this.getCognitionState().epoch) {
    const row = this.db.prepare(`
      SELECT MAX(seq) AS seq FROM cognition_journal
      WHERE epoch = ? AND status IN ('PENDING', 'COMMITTED', 'UNCERTAIN')
    `).get(epoch);
    return number(row?.seq) || 0;
  }

  cognitionJournalBeforeInbound(inboundSeq, epoch = this.getCognitionState().epoch) {
    if (inboundSeq === null || inboundSeq === undefined) return this.cognitionJournalHead(epoch);
    const row = this.db.prepare(`
      SELECT seq FROM cognition_journal
      WHERE epoch = ? AND inbound_seq = ? AND kind = 'inbound'
    `).get(epoch, inboundSeq);
    return row ? Math.max(0, number(row.seq) - 1) : this.cognitionJournalHead(epoch);
  }

  cognitionJournalSeqForInbound(inboundSeq, epoch = this.getCognitionState().epoch) {
    if (inboundSeq === null || inboundSeq === undefined) return 0;
    const row = this.db.prepare(`
      SELECT seq FROM cognition_journal
      WHERE epoch = ? AND inbound_seq = ? AND kind = 'inbound'
    `).get(epoch, inboundSeq);
    return number(row?.seq) || 0;
  }

  // One active runtime session is shared across every chat. No per-runtime or
  // per-conversation session cache exists: a hard switch replaces these fields.
  getGlobalSession() {
    const epoch = Number.parseInt(this.getMetaStatement.get('global_session_epoch')?.value ?? '0', 10);
    const synced = Number.parseInt(
      this.getMetaStatement.get('global_session_synced_through_seq')?.value ?? '0',
      10,
    );
    return {
      sessionId: this.getMetaStatement.get('global_session_id')?.value ?? null,
      policyHash: this.getMetaStatement.get('global_policy_hash')?.value ?? null,
      runtime: this.getMetaStatement.get('global_session_runtime')?.value ?? null,
      epoch: Number.isSafeInteger(epoch) ? epoch : 0,
      syncedThroughSeq: Number.isSafeInteger(synced) ? synced : 0,
      sessionReady: Boolean(this.getMetaStatement.get('global_session_id')?.value)
        && this.getMetaStatement.get('global_session_ready')?.value !== '0',
    };
  }

  setGlobalSession(sessionId, policyHash, {
    runtime = this.getCognitionState().runtime,
    epoch = this.getCognitionState().epoch,
    syncedThroughSeq = this.getGlobalSession().syncedThroughSeq,
    sessionReady = true,
  } = {}) {
    return this.transaction(() => {
      this.setMetaStatement.run('global_session_id', sessionId);
      this.setMetaStatement.run('global_policy_hash', policyHash);
      this.setMetaStatement.run('global_session_runtime', runtime);
      this.setMetaStatement.run('global_session_epoch', String(epoch));
      this.setMetaStatement.run('global_session_synced_through_seq', String(syncedThroughSeq));
      this.setMetaStatement.run('global_session_ready', sessionReady ? '1' : '0');
    });
  }

  settleCognitionJournal(dedupeKey, status, { messageId = null, metadata = {} } = {}) {
    if (!dedupeKey) return false;
    const result = this.db.prepare(`
      UPDATE cognition_journal
      SET status = ?, message_id = COALESCE(?, message_id), detail_json = ?
      WHERE dedupe_key = ?
    `).run(status, messageId, JSON.stringify(metadata ?? {}), dedupeKey);
    return number(result.changes) > 0;
  }

  inboundSeqForMessageId(messageId) {
    if (!messageId) return null;
    const row = this.getInboundByMessage.get(messageId);
    return row ? number(row.seq) : null;
  }

  inboundBySeq(seq) {
    if (seq === null || seq === undefined) return null;
    return rowToInbound(this.db.prepare('SELECT * FROM inbound WHERE seq = ?').get(seq));
  }

  clearGlobalSession() {
    this.deleteGlobalSessionStatement.run();
  }

  // Runtime overrides (e.g. /model, /effort) in the same meta KV table.
  getSetting(key) {
    return this.getMetaStatement.get(`setting:${key}`)?.value ?? null;
  }

  setSetting(key, value) {
    this.setMetaStatement.run(`setting:${key}`, String(value));
  }

  // Cross-chat history injected into a fresh thread's first turn. DONE rows include
  // every accepted sender, including bot/app messages. Outbound replies re-enter only
  // if Lark emits them back as inbound events.
  // ponytail: a resumed thread keeps codex's in-process context, but a fresh thread
  // after a policy change loses prior answers that Lark did not emit back.
  history(limit, beforeSeq = null) {
    if (limit <= 0) return [];
    const rows = this.db.prepare(`
      SELECT received_at_ms AS at_ms, COALESCE(sender_id, 'unknown') AS actor,
             chat_id AS chat_id, thread_id AS thread_id, content AS text
      FROM inbound
      WHERE status = 'DONE' AND seq < ?
      ORDER BY received_at_ms DESC, seq DESC
      LIMIT ?
    `).all(beforeSeq ?? Number.MAX_SAFE_INTEGER, limit);
    return rows.reverse().map((row) => ({
      atMs: number(row.at_ms),
      direction: 'inbound',
      actor: row.actor,
      chatId: row.chat_id,
      threadId: row.thread_id,
      text: row.text,
    }));
  }

  prune(retentionMs, now = Date.now()) {
    const cutoff = now - retentionMs;
    const removed = this.transaction(() => {
      const inbound = this.db.prepare(`
        DELETE FROM inbound
        WHERE received_at_ms < ? AND status IN ('DONE', 'DEAD', 'RULE_IGNORED')
      `).run(cutoff);
      const meetingEvents = this.db.prepare(`
        DELETE FROM meeting_events WHERE received_at_ms < ? AND inbox_read_at_ms IS NOT NULL
      `).run(cutoff);
      this.db.prepare(`
        DELETE FROM meeting_inbox_batches
        WHERE created_at_ms < ?
          AND NOT EXISTS (
            SELECT 1 FROM meeting_events WHERE meeting_events.inbox_batch_id = meeting_inbox_batches.id
          )
      `).run(cutoff);
      const meetingSessions = this.db.prepare(`
        DELETE FROM meeting_sessions
        WHERE status IN ('ENDED', 'FAILED') AND updated_at_ms < ?
          AND (meeting_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM meeting_events WHERE meeting_events.meeting_id = meeting_sessions.meeting_id
          ))
      `).run(cutoff);
      const outbox = this.db.prepare(`
        DELETE FROM outbox
        WHERE updated_at_ms < ?
          AND status IN ('SENT', 'DRY_RUN', 'FAILED', 'UNCERTAIN', 'CANCELLED_STALE')
      `).run(cutoff);
      const turns = this.db.prepare(`
        DELETE FROM turns
        WHERE updated_at_ms < ?
          AND status NOT IN ('RUNNING', 'OUTBOX_PENDING')
          AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.turn_id = turns.id)
      `).run(cutoff);
      const conversations = this.db.prepare(`
        DELETE FROM conversations
        WHERE NOT EXISTS (SELECT 1 FROM inbound WHERE inbound.conv_key = conversations.conv_key)
          AND NOT EXISTS (SELECT 1 FROM turns WHERE turns.conv_key = conversations.conv_key)
          AND NOT EXISTS (SELECT 1 FROM outbox WHERE outbox.conv_key = conversations.conv_key)
      `).run();
      return {
        inbound: number(inbound.changes),
        meetingEvents: number(meetingEvents.changes),
        meetingSessions: number(meetingSessions.changes),
        outbox: number(outbox.changes),
        turns: number(turns.changes),
        conversations: number(conversations.changes),
      };
    });
    try { this.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); } catch {}
    return removed;
  }

  stats() {
    const inbound = Object.fromEntries(this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM inbound GROUP BY status
    `).all().map((row) => [row.status, number(row.count)]));
    const outbox = Object.fromEntries(this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM outbox GROUP BY status
    `).all().map((row) => [row.status, number(row.count)]));
    const turns = Object.fromEntries(this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM turns GROUP BY status
    `).all().map((row) => [row.status, number(row.count)]));
    const activities = number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM activities
    `).get().count);
    const meetings = Object.fromEntries(this.db.prepare(`
      SELECT status, COUNT(*) AS count FROM meeting_sessions GROUP BY status
    `).all().map((row) => [row.status, number(row.count)]));
    const meetingEvents = number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM meeting_events
    `).get().count);
    const meetingInbox = this.unreadMeetingInboxCount();
    return { inbound, turns, outbox, activities, meetings, meetingEvents, meetingInbox };
  }

  close() {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    this.db.close();
  }
}
