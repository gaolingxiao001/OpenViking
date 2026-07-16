import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { opaqueRef, redactSensitive } from './logger.mjs';
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

function rowToOutbox(row) {
  if (!row) return null;
  return {
    id: number(row.id),
    turnId: number(row.turn_id),
    conversationKey: row.conv_key,
    idempotencyKey: row.idempotency_key,
    replyToMessageId: row.reply_to_message_id,
    targetChatId: row.target_chat_id,
    deliveryMode: row.delivery_mode || (row.reply_in_thread ? 'thread' : 'reply'),
    replyInThread: Boolean(row.reply_in_thread),
    body: row.body,
    status: row.status,
    attemptCount: number(row.attempt_count),
    lastAttemptMs: row.last_attempt_ms === null ? null : number(row.last_attempt_ms),
    remoteMessageId: row.remote_message_id,
    createdAtMs: number(row.created_at_ms),
    updatedAtMs: number(row.updated_at_ms),
    sentAtMs: row.sent_at_ms === null ? null : number(row.sent_at_ms),
    lastError: row.last_error,
    snapshotSeq: row.snapshot_seq === undefined ? undefined : number(row.snapshot_seq),
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
  'expired', 'filterReason', 'inboundSeqs', 'interruptedTurns', 'larkVersion',
  'messageType', 'outboxes', 'reason', 'reasonCode', 'removed',
  'requestedDeliveryMode', 'signal',
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
    `);
    const inboundColumns = new Set(
      this.db.prepare('PRAGMA table_info(inbound)').all().map((row) => row.name),
    );
    if (!inboundColumns.has('thread_id')) {
      this.db.exec('ALTER TABLE inbound ADD COLUMN thread_id TEXT');
    }
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
    this.updateLastIngress = this.db.prepare(`
      UPDATE conversations
      SET last_ingress_seq = CASE WHEN last_ingress_seq < ? THEN ? ELSE last_ingress_seq END,
          updated_at_ms = ?
      WHERE conv_key = ?
    `);
    this.getConversationStatement = this.db.prepare('SELECT * FROM conversations WHERE conv_key = ?');
    this.getMetaStatement = this.db.prepare('SELECT value FROM meta WHERE key = ?');
    this.setMetaStatement = this.db.prepare(`
      INSERT INTO meta(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `);
    this.deleteGlobalSessionStatement = this.db.prepare(
      "DELETE FROM meta WHERE key IN ('global_session_id', 'global_policy_hash')",
    );
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

  ingest(event, filterReason = null, now = Date.now(), queueLimits = null) {
    return this.transaction(() => {
      this.insertConversation.run(event.conversationKey, now, now);
      this.rememberChatSource(event.chatId, event.chatType, now);
      let effectiveFilterReason = filterReason;
      if (!effectiveFilterReason && queueLimits) {
        const total = number(this.db.prepare(`
          SELECT COUNT(*) AS count FROM inbound WHERE status = 'QUEUED'
        `).get().count);
        const conversation = number(this.db.prepare(`
          SELECT COUNT(*) AS count FROM inbound WHERE status = 'QUEUED' AND conv_key = ?
        `).get(event.conversationKey).count);
        if (total >= queueLimits.total) effectiveFilterReason = 'queue_total_full';
        else if (conversation >= queueLimits.perConversation) effectiveFilterReason = 'queue_conversation_full';
      }
      const status = effectiveFilterReason ? 'RULE_IGNORED' : 'QUEUED';
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
        effectiveFilterReason ? '' : event.content,
        JSON.stringify(effectiveFilterReason ? [] : event.mentions),
        '{}',
        event.createTimeMs,
        now,
        status,
        effectiveFilterReason,
      );
      const inserted = number(result.changes) > 0;
      let row = this.getInboundByMessage.get(event.messageId);
      if (!row && event.eventId) row = this.getInboundByEvent.get(event.eventId);
      if (inserted && !effectiveFilterReason) {
        this.updateLastIngress.run(row.seq, row.seq, now, event.conversationKey);
      }
      if (inserted) {
        const ignored = Boolean(effectiveFilterReason);
        const queueRejected = ['queue_total_full', 'queue_conversation_full'].includes(effectiveFilterReason);
        this.recordActivity({
          eventKey: `inbound:${row.seq}:${ignored ? 'ignored' : 'received'}`,
          kind: ignored ? 'message.ignored' : 'message.received',
          conversationKey: event.conversationKey,
          inboundSeq: number(row.seq),
          status,
          severity: queueRejected ? 'warn' : undefined,
          priority: queueRejected ? 85 : undefined,
          summary: ignored
            ? `未进入 Agent：${reasonLabel(effectiveFilterReason)}`
            : event.content,
          occurredAtMs: now,
          metadata: {
            chatType: event.chatType,
            messageType: event.messageType,
            filterReason: effectiveFilterReason,
          },
        }, now);
      }
      return { inserted, inbound: rowToInbound(row), filterReason: row?.filter_reason ?? effectiveFilterReason };
    });
  }

  expireQueued(cutoffMs, now = Date.now()) {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT seq, conv_key, content FROM inbound
        WHERE status = 'QUEUED' AND received_at_ms < ?
      `).all(cutoffMs);
      if (rows.length === 0) return 0;
      this.db.prepare(`
        UPDATE inbound
        SET status = 'RULE_IGNORED', filter_reason = 'queue_expired',
            content = '', mentions_json = '[]', last_error = NULL
        WHERE status = 'QUEUED' AND received_at_ms < ?
      `).run(cutoffMs);
      for (const row of rows) {
        this.recordActivity({
          eventKey: `inbound:${row.seq}:expired`,
          kind: 'message.expired',
          conversationKey: row.conv_key,
          inboundSeq: number(row.seq),
          status: 'RULE_IGNORED',
          summary: row.content || '排队时间过长，消息未交给 Agent',
          occurredAtMs: now,
          metadata: { filterReason: 'queue_expired' },
        }, now);
      }
      return rows.length;
    });
  }

  queuedConversationKeys() {
    return this.db.prepare(`
      SELECT conv_key, MIN(seq) AS first_seq
      FROM inbound
      WHERE status = 'QUEUED'
      GROUP BY conv_key
      ORDER BY first_seq
    `).all().map((row) => row.conv_key);
  }

  hasQueued(conversationKey) {
    return Boolean(this.db.prepare(`
      SELECT 1 AS present FROM inbound WHERE conv_key = ? AND status = 'QUEUED' LIMIT 1
    `).get(conversationKey));
  }

  claimBatch(conversationKey, limit, now = Date.now()) {
    return this.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM inbound
        WHERE conv_key = ? AND status = 'QUEUED'
        ORDER BY seq
        LIMIT ?
      `).all(conversationKey, limit);
      if (rows.length === 0) return null;

      const startSeq = number(rows[0].seq);
      const endSeq = number(rows.at(-1).seq);
      const snapshotSeq = endSeq;
      const conversation = this.getConversationStatement.get(conversationKey);
      const targetMessageId = rows.at(-1).message_id;
      const inserted = this.db.prepare(`
        INSERT INTO turns(
          conv_key, start_seq, end_seq, snapshot_seq, target_message_id,
          status, started_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?)
      `).run(conversationKey, startSeq, endSeq, snapshotSeq, targetMessageId, now, now);
      const turnId = number(inserted.lastInsertRowid);
      this.db.prepare(`
        UPDATE inbound SET status = 'RUNNING', turn_id = ?
        WHERE conv_key = ? AND status = 'QUEUED' AND seq BETWEEN ? AND ?
      `).run(turnId, conversationKey, startSeq, endSeq);

      this.recordActivity({
        eventKey: `turn:${turnId}:started`,
        kind: 'agent.started',
        conversationKey,
        turnId,
        inboundSeq: endSeq,
        status: 'RUNNING',
        summary: rows.at(-1).content,
        occurredAtMs: now,
        metadata: {
          batchSize: rows.length,
          inboundSeqs: rows.map((row) => number(row.seq)),
        },
      }, now);

      return {
        id: turnId,
        conversationKey,
        startSeq,
        endSeq,
        snapshotSeq,
        targetMessageId,
        pendingDraft: conversation.pending_draft_json
          ? JSON.parse(conversation.pending_draft_json)
          : null,
        messages: rows.map(rowToInbound),
      };
    });
  }

  getConversation(conversationKey) {
    const row = this.getConversationStatement.get(conversationKey);
    if (!row) return null;
    return {
      conversationKey: row.conv_key,
      pendingDraft: row.pending_draft_json ? JSON.parse(row.pending_draft_json) : null,
      lastIngressSeq: number(row.last_ingress_seq),
      createdAtMs: number(row.created_at_ms),
      updatedAtMs: number(row.updated_at_ms),
    };
  }

  // One Codex session is shared across every chat (cross-chat infinite context),
  // stored in the meta KV table rather than per-conversation.
  getGlobalSession() {
    return {
      sessionId: this.getMetaStatement.get('global_session_id')?.value ?? null,
      policyHash: this.getMetaStatement.get('global_policy_hash')?.value ?? null,
    };
  }

  setGlobalSession(sessionId, policyHash) {
    this.setMetaStatement.run('global_session_id', sessionId);
    this.setMetaStatement.run('global_policy_hash', policyHash);
  }

  clearGlobalSession() {
    this.deleteGlobalSessionStatement.run();
  }

  completeSilent(turnId, decision, now = Date.now()) {
    return this.transaction(() => {
      const turn = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId);
      const updated = this.db.prepare(`
        UPDATE turns
        SET status = 'SILENT', decision_action = ?, reason_code = ?, reply = ?,
            updated_at_ms = ?, completed_at_ms = ?
        WHERE id = ? AND status = 'RUNNING'
      `).run(decision.action, decision.reasonCode, decision.reply, now, now, turnId);
      if (number(updated.changes) === 0) return false;
      this.db.prepare(`
        UPDATE inbound SET status = 'DONE' WHERE turn_id = ? AND status = 'RUNNING'
      `).run(turnId);
      this.db.prepare(`
        UPDATE conversations SET pending_draft_json = NULL, updated_at_ms = ?
        WHERE conv_key = (SELECT conv_key FROM turns WHERE id = ?)
      `).run(now, turnId);
      this.recordActivity({
        eventKey: `turn:${turnId}:decision`,
        kind: 'agent.silent',
        conversationKey: turn.conv_key,
        turnId,
        inboundSeq: number(turn.end_seq),
        status: 'SILENT',
        summary: `未回复：${reasonLabel(decision.reasonCode)}`,
        occurredAtMs: now,
        metadata: { action: decision.action, reasonCode: decision.reasonCode },
      }, now);
      return true;
    });
  }

  failTurn(turnId, error, now = Date.now()) {
    return this.transaction(() => {
      const safeError = redactSensitive(error).slice(0, 4000);
      const turn = this.db.prepare('SELECT * FROM turns WHERE id = ?').get(turnId);
      const updated = this.db.prepare(`
        UPDATE turns SET status = 'DEAD', error = ?, updated_at_ms = ?, completed_at_ms = ?
        WHERE id = ? AND status = 'RUNNING'
      `).run(safeError, now, now, turnId);
      if (number(updated.changes) === 0) return false;
      this.db.prepare(`
        UPDATE inbound SET status = 'DEAD', last_error = ?
        WHERE turn_id = ? AND status = 'RUNNING'
      `).run(safeError, turnId);
      this.recordActivity({
        eventKey: `turn:${turnId}:failed`,
        kind: 'agent.failed',
        conversationKey: turn.conv_key,
        turnId,
        inboundSeq: number(turn.end_seq),
        status: 'DEAD',
        summary: safeError,
        occurredAtMs: now,
      }, now);
      return true;
    });
  }

  createOutboxIfFresh(turnId, decision, now = Date.now()) {
    return this.transaction(() => {
      const turn = this.db.prepare(`
        SELECT t.*, c.last_ingress_seq
        FROM turns t JOIN conversations c ON c.conv_key = t.conv_key
        WHERE t.id = ?
      `).get(turnId);
      if (!turn || turn.status !== 'RUNNING') throw new Error(`turn ${turnId} is not running`);

      if (number(turn.last_ingress_seq) > number(turn.snapshot_seq)) {
        const draft = {
          originTurnId: turnId,
          originTargetMessageId: turn.target_message_id,
          reply: decision.reply,
          reasonCode: decision.reasonCode,
          deliveryMode: decision.deliveryMode,
          withheldAtMs: now,
        };
        this.db.prepare(`
          UPDATE turns
          SET status = 'STALE', decision_action = ?, reason_code = ?, reply = ?,
              updated_at_ms = ?, completed_at_ms = ?
          WHERE id = ?
        `).run(decision.action, decision.reasonCode, decision.reply, now, now, turnId);
        this.db.prepare(`UPDATE inbound SET status = 'DONE' WHERE turn_id = ?`).run(turnId);
        this.db.prepare(`
          UPDATE conversations SET pending_draft_json = ?, updated_at_ms = ? WHERE conv_key = ?
        `).run(JSON.stringify(draft), now, turn.conv_key);
        this.recordActivity({
          eventKey: `turn:${turnId}:stale`,
          kind: 'agent.stale',
          conversationKey: turn.conv_key,
          turnId,
          inboundSeq: number(turn.end_seq),
          status: 'STALE',
          summary: '有更新消息，旧回复未发送',
          occurredAtMs: now,
          metadata: {
            reasonCode: decision.reasonCode,
            requestedDeliveryMode: decision.deliveryMode,
          },
        }, now);
        return { stale: true, outbox: null };
      }

      const target = this.db.prepare(`
        SELECT message_id, chat_id, chat_type, thread_id FROM inbound WHERE seq = ?
      `).get(turn.end_seq);
      let deliveryMode = decision.deliveryMode;
      if (target.chat_type === 'p2p' && deliveryMode === 'thread') deliveryMode = 'reply';
      if (target.chat_type !== 'p2p' && target.thread_id) deliveryMode = 'thread';
      const idempotencyKey = randomUUID();
      const inserted = this.db.prepare(`
        INSERT INTO outbox(
          turn_id, conv_key, idempotency_key, reply_to_message_id,
          reply_in_thread, delivery_mode, target_chat_id, body,
          status, created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
      `).run(
        turnId,
        turn.conv_key,
        idempotencyKey,
        target.message_id,
        deliveryMode === 'thread' ? 1 : 0,
        deliveryMode,
        target.chat_id,
        decision.reply,
        now,
        now,
      );
      this.db.prepare(`
        UPDATE turns
        SET status = 'OUTBOX_PENDING', decision_action = ?, reason_code = ?, reply = ?,
            updated_at_ms = ?, completed_at_ms = ?
        WHERE id = ?
      `).run(decision.action, decision.reasonCode, decision.reply, now, now, turnId);
      this.db.prepare(`UPDATE inbound SET status = 'DONE' WHERE turn_id = ?`).run(turnId);
      this.db.prepare(`
        UPDATE conversations SET pending_draft_json = NULL, updated_at_ms = ? WHERE conv_key = ?
      `).run(now, turn.conv_key);

      const outbox = this.db.prepare(`
        SELECT o.*, t.snapshot_seq FROM outbox o JOIN turns t ON t.id = o.turn_id WHERE o.id = ?
      `).get(inserted.lastInsertRowid);
      const outboxId = number(inserted.lastInsertRowid);
      this.recordActivity({
        eventKey: `turn:${turnId}:decision`,
        kind: 'agent.decided',
        conversationKey: turn.conv_key,
        turnId,
        inboundSeq: number(turn.end_seq),
        outboxId,
        status: 'OUTBOX_PENDING',
        summary: decision.reply,
        occurredAtMs: now,
        metadata: {
          action: decision.action,
          reasonCode: decision.reasonCode,
          requestedDeliveryMode: decision.deliveryMode,
          deliveryMode,
        },
      }, now);
      this.recordActivity({
        eventKey: `outbox:${outboxId}:queued`,
        kind: 'delivery.queued',
        conversationKey: turn.conv_key,
        turnId,
        inboundSeq: number(turn.end_seq),
        outboxId,
        status: 'PENDING',
        summary: decision.reply,
        occurredAtMs: now,
        metadata: { deliveryMode },
      }, now);
      return { stale: false, outbox: rowToOutbox(outbox) };
    });
  }

  cancelOutboxIfStale(outboxId, now = Date.now()) {
    return this.transaction(() => {
      const row = this.db.prepare(`
        SELECT o.*, t.snapshot_seq, t.end_seq, t.reason_code, c.last_ingress_seq
        FROM outbox o
        JOIN turns t ON t.id = o.turn_id
        JOIN conversations c ON c.conv_key = o.conv_key
        WHERE o.id = ?
      `).get(outboxId);
      if (!row || !['PENDING', 'RETRY'].includes(row.status)) return false;
      if (number(row.last_ingress_seq) <= number(row.snapshot_seq)) return false;

      const draft = {
        originTurnId: number(row.turn_id),
        originTargetMessageId: row.reply_to_message_id,
        reply: row.body,
        reasonCode: row.reason_code,
        deliveryMode: row.delivery_mode || (row.reply_in_thread ? 'thread' : 'reply'),
        withheldAtMs: now,
      };
      this.db.prepare(`
        UPDATE outbox SET status = 'CANCELLED_STALE', updated_at_ms = ? WHERE id = ?
      `).run(now, outboxId);
      this.db.prepare(`
        UPDATE turns SET status = 'STALE', updated_at_ms = ? WHERE id = ?
      `).run(now, row.turn_id);
      this.db.prepare(`
        UPDATE conversations SET pending_draft_json = ?, updated_at_ms = ? WHERE conv_key = ?
      `).run(JSON.stringify(draft), now, row.conv_key);
      this.recordActivity({
        eventKey: `turn:${row.turn_id}:stale`,
        kind: 'agent.stale',
        conversationKey: row.conv_key,
        turnId: number(row.turn_id),
        inboundSeq: number(row.end_seq),
        status: 'STALE',
        summary: '有更新消息，旧回复未发送',
        occurredAtMs: now,
        metadata: { reasonCode: row.reason_code },
      }, now);
      this.recordActivity({
        eventKey: `outbox:${outboxId}:cancelled_stale`,
        kind: 'delivery.cancelled',
        conversationKey: row.conv_key,
        turnId: number(row.turn_id),
        outboxId,
        status: 'CANCELLED_STALE',
        summary: '有更新消息，旧回复未发送',
        occurredAtMs: now,
        metadata: { deliveryMode: row.delivery_mode },
      }, now);
      return true;
    });
  }

  pendingOutboxes() {
    return this.db.prepare(`
      SELECT o.*, t.snapshot_seq
      FROM outbox o JOIN turns t ON t.id = o.turn_id
      WHERE o.status IN ('PENDING', 'RETRY', 'SENDING')
      ORDER BY o.id
    `).all().map(rowToOutbox);
  }

  prepareOutboxAttempt(outboxId, uncertainAfterMs, now = Date.now()) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(outboxId);
      if (!row || !['PENDING', 'RETRY', 'SENDING'].includes(row.status)) {
        return { ready: false, outbox: rowToOutbox(row) };
      }
      if (row.status === 'SENDING' && row.last_attempt_ms && now - number(row.last_attempt_ms) > uncertainAfterMs) {
        this.db.prepare(`
          UPDATE outbox SET status = 'UNCERTAIN', updated_at_ms = ?,
            last_error = 'previous send may have succeeded outside the idempotency window'
          WHERE id = ?
        `).run(now, outboxId);
        this.recordActivity({
          eventKey: `outbox:${outboxId}:uncertain`,
          kind: 'delivery.uncertain',
          conversationKey: row.conv_key,
          turnId: number(row.turn_id),
          outboxId,
          status: 'UNCERTAIN',
          summary: '上一次发送可能已经成功，已停止自动重试',
          occurredAtMs: now,
          metadata: { deliveryMode: row.delivery_mode, attempt: number(row.attempt_count) },
        }, now);
        const uncertain = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(outboxId);
        return { ready: false, uncertain: true, outbox: rowToOutbox(uncertain) };
      }
      this.db.prepare(`
        UPDATE outbox
        SET status = 'SENDING', attempt_count = attempt_count + 1,
            last_attempt_ms = ?, updated_at_ms = ?, last_error = NULL
        WHERE id = ?
      `).run(now, now, outboxId);
      const prepared = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(outboxId);
      this.recordActivity({
        eventKey: `outbox:${outboxId}:attempt:${prepared.attempt_count}`,
        kind: 'delivery.attempt',
        conversationKey: prepared.conv_key,
        turnId: number(prepared.turn_id),
        outboxId,
        status: 'SENDING',
        summary: prepared.body,
        occurredAtMs: now,
        metadata: {
          deliveryMode: prepared.delivery_mode,
          attempt: number(prepared.attempt_count),
        },
      }, now);
      return {
        ready: true,
        outbox: rowToOutbox(prepared),
      };
    });
  }

  markOutboxSent(outboxId, remoteMessageId, now = Date.now(), dryRun = false) {
    return this.transaction(() => {
      const status = dryRun ? 'DRY_RUN' : 'SENT';
      const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(outboxId);
      const updated = this.db.prepare(`
        UPDATE outbox
        SET status = ?, remote_message_id = ?, updated_at_ms = ?, sent_at_ms = ?, last_error = NULL
        WHERE id = ? AND status = 'SENDING'
      `).run(status, remoteMessageId, now, now, outboxId);
      if (number(updated.changes) === 0) return false;
      this.db.prepare(`
        UPDATE turns SET status = ?, updated_at_ms = ?
        WHERE id = (SELECT turn_id FROM outbox WHERE id = ?)
      `).run(status, now, outboxId);
      this.recordActivity({
        eventKey: `outbox:${outboxId}:${status.toLowerCase()}`,
        kind: dryRun ? 'delivery.dry_run' : 'delivery.sent',
        conversationKey: row.conv_key,
        turnId: number(row.turn_id),
        outboxId,
        status,
        summary: row.body,
        occurredAtMs: now,
        metadata: {
          deliveryMode: row.delivery_mode,
          attempt: number(row.attempt_count),
          dryRun,
        },
      }, now);
      return true;
    });
  }

  markOutboxFailure(outboxId, error, maxAttempts, now = Date.now()) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM outbox WHERE id = ?').get(outboxId);
      if (!row || row.status !== 'SENDING') return null;
      const safeError = redactSensitive(error).slice(0, 4000);
      const nextStatus = number(row.attempt_count) >= maxAttempts ? 'FAILED' : 'RETRY';
      const updated = this.db.prepare(`
        UPDATE outbox SET status = ?, last_error = ?, updated_at_ms = ?
        WHERE id = ? AND status = 'SENDING'
      `).run(nextStatus, safeError, now, outboxId);
      if (number(updated.changes) === 0) return null;
      if (nextStatus === 'FAILED') {
        this.db.prepare(`
          UPDATE turns SET status = 'SEND_FAILED', error = ?, updated_at_ms = ?
          WHERE id = ?
        `).run(safeError, now, row.turn_id);
      }
      this.recordActivity({
        eventKey: `outbox:${outboxId}:${nextStatus === 'FAILED' ? 'failed' : `retry:${row.attempt_count}`}`,
        kind: nextStatus === 'FAILED' ? 'delivery.failed' : 'delivery.retry',
        conversationKey: row.conv_key,
        turnId: number(row.turn_id),
        outboxId,
        status: nextStatus,
        summary: safeError,
        occurredAtMs: now,
        metadata: {
          deliveryMode: row.delivery_mode,
          attempt: number(row.attempt_count),
        },
      }, now);
      return nextStatus;
    });
  }

  // Global cross-chat history for injecting context into a fresh/reset session.
  // DONE inbound already excludes the in-flight RUNNING batch, so no seq guard is needed.
  history(limit) {
    if (limit <= 0) return [];
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT received_at_ms AS at_ms, 'inbound' AS direction,
               COALESCE(sender_id, 'unknown') AS actor,
               chat_id AS chat_id, thread_id AS thread_id, content AS text
        FROM inbound
        WHERE status = 'DONE'
        UNION ALL
        SELECT COALESCE(o.sent_at_ms, o.created_at_ms) AS at_ms, 'outbound' AS direction,
               'me' AS actor,
               o.target_chat_id AS chat_id, i.thread_id AS thread_id, o.body AS text
        FROM outbox o LEFT JOIN inbound i ON i.message_id = o.reply_to_message_id
        WHERE o.status IN ('SENT', 'DRY_RUN')
      )
      ORDER BY at_ms DESC
      LIMIT ?
    `).all(limit);
    return rows.reverse().map((row) => ({
      atMs: number(row.at_ms),
      direction: row.direction,
      actor: row.actor,
      chatId: row.chat_id,
      threadId: row.thread_id,
      text: row.text,
    }));
  }

  recoverInterrupted(now = Date.now()) {
    return this.transaction(() => {
      const interrupted = this.db.prepare(`
        SELECT * FROM turns WHERE status = 'RUNNING' ORDER BY id
      `).all();
      // ponytail: a crash mid-resume can leave the one shared session's rollout poisoned,
      // so any interruption discards the global session and the next turn replays history.
      if (interrupted.length > 0) this.deleteGlobalSessionStatement.run();
      this.db.prepare(`
        UPDATE turns
        SET status = 'INTERRUPTED', error = 'daemon stopped during Codex turn',
            updated_at_ms = ?, completed_at_ms = ?
        WHERE status = 'RUNNING'
      `).run(now, now);
      this.db.prepare(`
        UPDATE inbound
        SET status = 'DEAD', last_error = 'daemon stopped during Codex turn'
        WHERE status = 'RUNNING'
      `).run();
      for (const turn of interrupted) {
        this.recordActivity({
          eventKey: `turn:${turn.id}:interrupted`,
          kind: 'agent.interrupted',
          conversationKey: turn.conv_key,
          turnId: number(turn.id),
          inboundSeq: number(turn.end_seq),
          status: 'INTERRUPTED',
          summary: 'daemon stopped during Codex turn',
          occurredAtMs: now,
        }, now);
      }
      return interrupted.length;
    });
  }

  prune(retentionMs, now = Date.now()) {
    const cutoff = now - retentionMs;
    const removed = this.transaction(() => {
      const inbound = this.db.prepare(`
        DELETE FROM inbound
        WHERE received_at_ms < ? AND status IN ('DONE', 'DEAD', 'RULE_IGNORED')
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
    return { inbound, turns, outbox, activities };
  }

  close() {
    try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
    this.db.close();
  }
}
