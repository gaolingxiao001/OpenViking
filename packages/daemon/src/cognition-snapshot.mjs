// The event ledger is lossless. Checkpoints are bounded, model-authored views
// of that ledger, never authority to execute historical requests or resend an
// uncertain delivery. This module is shared by the daemon and its MCP sidecar.
export const SNAPSHOT_VERSION = 1;
export const SNAPSHOT_MAX_CHARS = 12_000;
export const HANDOFF_TARGET_CHARS = 32_000;

export function migrateCognitionSnapshots(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS cognition_snapshots (
    epoch INTEGER NOT NULL,
    through_seq INTEGER NOT NULL,
    version INTEGER NOT NULL,
    summary TEXT NOT NULL,
    open_messages_json TEXT NOT NULL,
    runtime_token TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (epoch, through_seq)
  )`);
}

export function latestCognitionSnapshot(db, epoch, throughSeq) {
  const row = db.prepare(`SELECT * FROM cognition_snapshots
    WHERE epoch = ? AND through_seq <= ? AND version = ?
    ORDER BY through_seq DESC LIMIT 1`).get(epoch, throughSeq, SNAPSHOT_VERSION);
  return row ? {
    epoch: row.epoch, throughSeq: row.through_seq, summary: row.summary,
    openMessageIds: JSON.parse(row.open_messages_json), version: row.version,
  } : null;
}

function integer(value, name, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be an integer >= ${min}`);
  return value;
}

export function saveCognitionSnapshot(db, { epoch, throughSeq, summary, openMessageIds = [], resolvedMessageIds = [], runtimeToken }) {
  integer(epoch, 'epoch', 1);
  integer(throughSeq, 'through_seq', 1);
  if (typeof summary !== 'string' || !summary.trim() || summary.length > SNAPSHOT_MAX_CHARS) {
    throw new Error(`summary must contain 1-${SNAPSHOT_MAX_CHARS} characters`);
  }
  for (const ids of [openMessageIds, resolvedMessageIds]) {
    if (!Array.isArray(ids) || ids.length > 64 || ids.some((id) => typeof id !== 'string')) {
      throw new Error('open_message_ids and resolved_message_ids must contain at most 64 message IDs');
    }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    const active = db.prepare("SELECT value FROM meta WHERE key = 'active_runtime_token'").get()?.value;
    const activeEpoch = Number(db.prepare("SELECT value FROM meta WHERE key = 'global_cognition_epoch'").get()?.value);
    if (!runtimeToken || active !== runtimeToken || epoch !== activeEpoch) {
      throw new Error('snapshot rejected: runtime authority or epoch changed');
    }
    if (!db.prepare('SELECT 1 FROM cognition_journal WHERE epoch = ? AND seq = ?').get(epoch, throughSeq)) {
      throw new Error('snapshot through_seq is not a journal row in this epoch');
    }
    const previous = latestCognitionSnapshot(db, epoch, throughSeq - 1);
    const resolved = new Set(resolvedMessageIds);
    if (resolvedMessageIds.some((id) => !previous?.openMessageIds.includes(id) || openMessageIds.includes(id))) {
      throw new Error('resolved_message_ids must reference previous open requests and cannot also remain open');
    }
    // Omitting an old task in a new summary must not silently close it.
    const ids = [...new Set([...(previous?.openMessageIds ?? []), ...openMessageIds])]
      .filter((id) => !resolved.has(id));
    if (ids.length > 64) throw new Error('too many unresolved requests for one snapshot; resolve completed requests explicitly');
    for (const id of ids) {
      if (!db.prepare(`SELECT 1 FROM cognition_journal
        WHERE epoch = ? AND seq <= ? AND kind = 'inbound' AND message_id = ?`).get(epoch, throughSeq, id)) {
        throw new Error('open_message_ids must reference inbound rows covered by the snapshot');
      }
    }
    const latest = latestCognitionSnapshot(db, epoch, Number.MAX_SAFE_INTEGER);
    if (latest && latest.throughSeq >= throughSeq) {
      if (latest.throughSeq === throughSeq && latest.summary === summary
        && JSON.stringify(latest.openMessageIds) === JSON.stringify(ids)) {
        db.exec('COMMIT');
        return { saved: true, epoch, through_seq: throughSeq, replay: true };
      }
      throw new Error('snapshot rejected: checkpoint would overwrite or move behind an existing checkpoint');
    }
    db.prepare(`INSERT INTO cognition_snapshots
      (epoch, through_seq, version, summary, open_messages_json, runtime_token, created_at_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(epoch, throughSeq, SNAPSHOT_VERSION, summary, JSON.stringify(ids), runtimeToken, Date.now());
    db.exec('COMMIT');
    return { saved: true, epoch, through_seq: throughSeq };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

// Bounded pages, with a character cursor, so even a single oversized paste
// is retrievable without an unbounded tool response. The next cursor never
// skips the unread remainder of a row. Scope filters are exact, not labels.
export function readCognitionJournal(db, input = {}) {
  const epoch = integer(input.epoch, 'epoch', 1);
  const after = integer(input.after_seq ?? 0, 'after_seq');
  const offset = integer(input.offset ?? 0, 'offset');
  const limit = integer(input.max_chars ?? 8_000, 'max_chars', 1);
  if (limit > 16_000) throw new Error('max_chars must be <= 16000');
  const where = ['epoch = ?', 'seq > ?'];
  const args = [epoch, after];
  if (input.through_seq !== undefined) {
    where.push('seq <= ?'); args.push(integer(input.through_seq, 'through_seq'));
  }
  for (const name of ['chat_id', 'thread_id', 'message_id']) {
    if (input[name] !== undefined) {
      if (typeof input[name] !== 'string') throw new Error(`${name} must be a string`);
      where.push(`COALESCE(${name}, '') = ?`); args.push(input[name]);
    }
  }
  if (input.uncertain_only === true) where.push("kind = 'outbound' AND status IN ('PENDING', 'UNCERTAIN')");
  if (input.scope_index === true) {
    const indexOffset = integer(input.index_offset ?? 0, 'index_offset');
    const scopes = db.prepare(`SELECT chat_id, thread_id, COUNT(*) AS records,
      MIN(seq) AS first_seq, MAX(seq) AS last_seq,
      SUM(CASE WHEN kind = 'inbound' THEN 1 ELSE 0 END) AS inbound_records
      FROM cognition_journal WHERE ${where.join(' AND ')}
      GROUP BY chat_id, thread_id ORDER BY last_seq DESC LIMIT 33 OFFSET ?`).all(...args, indexOffset);
    return { epoch, scopes: scopes.slice(0, 32), next_index_offset: scopes.length > 32 ? indexOffset + 32 : null };
  }
  const statement = db.prepare(`SELECT seq, epoch, kind, status, at_ms, chat_id, thread_id,
    message_id, actor, text FROM cognition_journal WHERE ${where.join(' AND ')} ORDER BY seq LIMIT 1`);
  const head = db.prepare('SELECT MAX(seq) AS head FROM cognition_journal WHERE epoch = ?').get(epoch).head ?? 0;
  const items = [];
  let remaining = limit;
  let cursor = { after_seq: after, offset };
  while (items.length < 50 && remaining > 0) {
    args[1] = cursor.after_seq;
    const row = statement.get(...args);
    if (!row) return { epoch, head, items, next: null };
    if (cursor.offset > 0 && row.seq !== cursor.after_seq + 1) {
      throw new Error('fragment no longer matches the filters; retry this cursor with offset=0');
    }
    if (cursor.offset > row.text.length) throw new Error('offset exceeds the current row length');
    const text = row.text.slice(cursor.offset, cursor.offset + remaining);
    const partial = cursor.offset + text.length < row.text.length;
    items.push({ ...row, text, offset: cursor.offset, total_chars: row.text.length });
    remaining -= text.length;
    cursor = partial
      ? { after_seq: row.seq - 1, offset: cursor.offset + text.length }
      : { after_seq: row.seq, offset: 0 };
    if (partial) break;
  }
  return { epoch, head, items, next: cursor };
}
