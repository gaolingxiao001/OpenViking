import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const LIVE_SPOOL_STATES = Object.freeze({
  PENDING: 'pending',
  INFLIGHT: 'inflight',
  CONSUMED: 'consumed',
});

export const DEFAULT_LIVE_SPOOL_RETENTION_MS = 60 * 60 * 1_000;
export const DEFAULT_LIVE_SPOOL_LEASE_MS = 30_000;

const ALLOWED_INPUT_KEYS = new Set([
  'inputId',
  'sessionEpoch',
  'captureGeneration',
  'segmentId',
  'segmentSeq',
  'meetingId',
  'meetingNumber',
  'targetChatId',
  'text',
  'speaker',
  'speakerId',
  'speakerName',
  'audioStartMs',
  'audioEndMs',
  'startMs',
  'endMs',
  'receivedAtMs',
  'finalizedAtMs',
  'isFinal',
  'final',
]);

function number(value) {
  return typeof value === 'bigint' ? Number(value) : value;
}

function requiredId(value, label) {
  if (!['string', 'number', 'bigint'].includes(typeof value)) {
    throw new TypeError(`${label} must be a non-empty string or integer`);
  }
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    throw new TypeError(`${label} must be a non-negative safe integer when numeric`);
  }
  if (typeof value === 'bigint' && value < 0n) {
    throw new TypeError(`${label} must be non-negative when numeric`);
  }
  const normalized = String(value);
  if (!normalized || normalized.length > 512) {
    throw new TypeError(`${label} must contain 1-512 characters`);
  }
  return normalized;
}

function optionalText(value, label, maxLength = 2_000) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  if (value.length > maxLength) throw new RangeError(`${label} is too long`);
  return value;
}

function requiredText(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError('text must be a non-empty normalized final transcript');
  }
  if (value.length > 32_000) throw new RangeError('text is too long');
  return value;
}

function timestamp(value, label, fallback = null) {
  const candidate = value === undefined || value === null ? fallback : value;
  if (candidate === null) return null;
  if (!Number.isSafeInteger(candidate) || candidate < 0) {
    throw new TypeError(`${label} must be a non-negative millisecond timestamp`);
  }
  return candidate;
}

function finiteTime(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative finite millisecond value`);
  }
  return value;
}

function optionalInteger(value, label) {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
  return value;
}

function positiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return value;
}

function stableInputId(sessionEpoch, segmentId) {
  const hash = createHash('sha256')
    .update(`${sessionEpoch.length}:${sessionEpoch}${segmentId.length}:${segmentId}`)
    .digest('hex');
  return `live_${hash}`;
}

function normalizeFinalInput(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('normalized final input must be an object');
  }
  const unknown = Object.keys(input).filter((key) => !ALLOWED_INPUT_KEYS.has(key));
  if (unknown.length > 0) {
    throw new TypeError(`normalized final input has unsupported field: ${unknown[0]}`);
  }
  if (input.isFinal === false || input.final === false) {
    throw new TypeError('partial transcript input cannot enter the live spool');
  }
  if (input.isFinal !== undefined && input.isFinal !== true) {
    throw new TypeError('isFinal must be true when provided');
  }
  if (input.final !== undefined && input.final !== true) {
    throw new TypeError('final must be true when provided');
  }

  const startMs = finiteTime(input.audioStartMs ?? input.startMs, 'audioStartMs');
  const endMs = finiteTime(input.audioEndMs ?? input.endMs, 'audioEndMs');
  if (startMs !== null && endMs !== null && endMs < startMs) {
    throw new RangeError('audioEndMs must not be earlier than audioStartMs');
  }
  const receivedAtMs = timestamp(input.receivedAtMs, 'receivedAtMs', now);
  return {
    inputId: input.inputId === undefined || input.inputId === null
      ? null
      : requiredId(input.inputId, 'inputId'),
    captureGeneration: optionalInteger(input.captureGeneration, 'captureGeneration'),
    segmentSeq: optionalInteger(input.segmentSeq, 'segmentSeq'),
    meetingId: optionalText(input.meetingId, 'meetingId', 512),
    meetingNumber: optionalText(input.meetingNumber, 'meetingNumber', 512),
    targetChatId: optionalText(input.targetChatId, 'targetChatId', 512),
    text: requiredText(input.text),
    speakerId: optionalText(input.speakerId, 'speakerId', 512),
    speakerName: optionalText(input.speakerName ?? input.speaker, 'speakerName', 512),
    startMs,
    endMs,
    receivedAtMs,
    finalizedAtMs: timestamp(input.finalizedAtMs, 'finalizedAtMs', receivedAtMs),
  };
}

function rowToItem(row) {
  if (!row) return null;
  const inputId = row.input_id;
  return {
    key: inputId,
    inputId,
    sessionEpoch: row.session_epoch,
    captureGeneration: row.capture_generation === null
      ? null
      : number(row.capture_generation),
    segmentId: row.segment_id,
    segmentSeq: row.segment_seq === null ? null : number(row.segment_seq),
    generation: number(row.generation),
    meetingId: row.meeting_id,
    meetingNumber: row.meeting_number,
    targetChatId: row.target_chat_id,
    text: row.text,
    speaker: row.speaker_name,
    speakerId: row.speaker_id,
    audioStartMs: row.start_ms === null ? null : number(row.start_ms),
    audioEndMs: row.end_ms === null ? null : number(row.end_ms),
    receivedAtMs: number(row.received_at_ms),
    finalizedAtMs: number(row.finalized_at_ms),
    input: {
      inputId,
      sessionEpoch: row.session_epoch,
      captureGeneration: row.capture_generation === null
        ? null
        : number(row.capture_generation),
      segmentId: row.segment_id,
      segmentSeq: row.segment_seq === null ? null : number(row.segment_seq),
      meetingId: row.meeting_id,
      meetingNumber: row.meeting_number,
      targetChatId: row.target_chat_id,
      text: row.text,
      speakerId: row.speaker_id,
      speaker: row.speaker_name,
      audioStartMs: row.start_ms === null ? null : number(row.start_ms),
      audioEndMs: row.end_ms === null ? null : number(row.end_ms),
      receivedAtMs: number(row.received_at_ms),
      finalizedAtMs: number(row.finalized_at_ms),
    },
    status: row.status,
    claimedAtMs: row.claimed_at_ms === null ? null : number(row.claimed_at_ms),
    leaseExpiresAtMs: row.lease_expires_at_ms === null
      ? null
      : number(row.lease_expires_at_ms),
    consumedAtMs: row.consumed_at_ms === null ? null : number(row.consumed_at_ms),
    createdAtMs: number(row.created_at_ms),
    updatedAtMs: number(row.updated_at_ms),
  };
}

export class LiveSpool {
  constructor(databasePath, {
    now = Date.now,
    retentionMs = DEFAULT_LIVE_SPOOL_RETENTION_MS,
    leaseMs = DEFAULT_LIVE_SPOOL_LEASE_MS,
  } = {}) {
    if (typeof databasePath !== 'string' || databasePath.trim() === '') {
      throw new TypeError('LiveSpool requires an independent SQLite database path');
    }
    if (typeof now !== 'function') throw new TypeError('now must be a function');
    this.now = now;
    this.retentionMs = positiveInteger(retentionMs, 'retentionMs');
    this.leaseMs = positiveInteger(leaseMs, 'leaseMs');
    this.databasePath = databasePath;

    if (databasePath !== ':memory:') {
      fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    }
    this.db = new DatabaseSync(databasePath);
    if (databasePath !== ':memory:') {
      try { fs.chmodSync(databasePath, 0o600); } catch {}
    }
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = FULL');
    this.db.exec('PRAGMA busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS live_spool_sessions (
        session_epoch TEXT PRIMARY KEY,
        last_generation INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS live_spool_inputs (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        input_id TEXT NOT NULL UNIQUE,
        session_epoch TEXT NOT NULL,
        capture_generation INTEGER,
        segment_id TEXT NOT NULL,
        segment_seq INTEGER,
        generation INTEGER NOT NULL,
        meeting_id TEXT,
        meeting_number TEXT,
        target_chat_id TEXT,
        text TEXT NOT NULL,
        speaker_id TEXT,
        speaker_name TEXT,
        start_ms INTEGER,
        end_ms INTEGER,
        received_at_ms INTEGER NOT NULL,
        finalized_at_ms INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'inflight', 'consumed')),
        claimed_at_ms INTEGER,
        lease_expires_at_ms INTEGER,
        consumed_at_ms INTEGER,
        created_at_ms INTEGER NOT NULL,
        updated_at_ms INTEGER NOT NULL,
        UNIQUE(session_epoch, segment_id),
        UNIQUE(session_epoch, generation)
      );

      CREATE INDEX IF NOT EXISTS live_spool_inputs_pending
        ON live_spool_inputs(status, row_id);
      CREATE INDEX IF NOT EXISTS live_spool_inputs_session
        ON live_spool_inputs(session_epoch, generation);
      CREATE INDEX IF NOT EXISTS live_spool_inputs_consumed
        ON live_spool_inputs(status, consumed_at_ms);
    `);
    this.bySegmentStatement = this.db.prepare(`
      SELECT * FROM live_spool_inputs
      WHERE session_epoch = ? AND segment_id = ?
    `);
    this.byInputIdStatement = this.db.prepare(`
      SELECT * FROM live_spool_inputs WHERE input_id = ?
    `);
  }

  enqueue(input) {
    const sessionEpoch = requiredId(input?.sessionEpoch, 'sessionEpoch');
    const segmentId = requiredId(input?.segmentId, 'segmentId');
    const atMs = timestamp(this.now(), 'now');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Dedupe comes before normalization and generation allocation. A retried
      // segment always returns the original durable input without advancing the
      // per-session generation, even if the retry carries changed provider data.
      const existing = this.bySegmentStatement.get(sessionEpoch, segmentId);
      if (existing) {
        this.db.exec('COMMIT');
        return { inserted: false, duplicate: true, item: rowToItem(existing) };
      }

      const normalized = normalizeFinalInput(input, atMs);
      this.db.prepare(`
        INSERT INTO live_spool_sessions(session_epoch, last_generation)
        VALUES (?, 1)
        ON CONFLICT(session_epoch) DO UPDATE SET
          last_generation = live_spool_sessions.last_generation + 1
      `).run(sessionEpoch);
      const generation = number(this.db.prepare(`
        SELECT last_generation AS generation
        FROM live_spool_sessions WHERE session_epoch = ?
      `).get(sessionEpoch).generation);
      const inputId = normalized.inputId ?? stableInputId(sessionEpoch, segmentId);
      this.db.prepare(`
        INSERT INTO live_spool_inputs(
          input_id, session_epoch, capture_generation, segment_id, segment_seq, generation,
          meeting_id, meeting_number, target_chat_id, text, speaker_id, speaker_name,
          start_ms, end_ms, received_at_ms, finalized_at_ms, status,
          created_at_ms, updated_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(
        inputId,
        sessionEpoch,
        normalized.captureGeneration,
        segmentId,
        normalized.segmentSeq,
        generation,
        normalized.meetingId,
        normalized.meetingNumber,
        normalized.targetChatId,
        normalized.text,
        normalized.speakerId,
        normalized.speakerName,
        normalized.startMs,
        normalized.endMs,
        normalized.receivedAtMs,
        normalized.finalizedAtMs,
        atMs,
        atMs,
      );
      const row = this.byInputIdStatement.get(inputId);
      this.db.exec('COMMIT');
      return { inserted: true, duplicate: false, item: rowToItem(row) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  getBySegment(sessionEpoch, segmentId) {
    return rowToItem(this.bySegmentStatement.get(
      requiredId(sessionEpoch, 'sessionEpoch'),
      requiredId(segmentId, 'segmentId'),
    ));
  }

  get(inputId) {
    return rowToItem(this.byInputIdStatement.get(requiredId(inputId, 'inputId')));
  }

  claim({ sessionEpoch = null, limit = 100, atMs = this.now(), leaseMs = this.leaseMs } = {}) {
    const safeLimit = positiveInteger(limit, 'limit', 500);
    const safeAtMs = timestamp(atMs, 'atMs');
    const safeLeaseMs = positiveInteger(leaseMs, 'leaseMs');
    const safeEpoch = sessionEpoch === null || sessionEpoch === undefined
      ? null
      : requiredId(sessionEpoch, 'sessionEpoch');

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`
        UPDATE live_spool_inputs SET
          status = 'pending',
          claimed_at_ms = NULL,
          lease_expires_at_ms = NULL,
          updated_at_ms = ?
        WHERE status = 'inflight' AND lease_expires_at_ms <= ?
      `).run(safeAtMs, safeAtMs);
      const rows = safeEpoch === null
        ? this.db.prepare(`
            SELECT * FROM live_spool_inputs
            WHERE status = 'pending'
            ORDER BY row_id LIMIT ?
          `).all(safeLimit)
        : this.db.prepare(`
            SELECT * FROM live_spool_inputs
            WHERE status = 'pending' AND session_epoch = ?
            ORDER BY generation LIMIT ?
          `).all(safeEpoch, safeLimit);
      const leaseExpiresAtMs = safeAtMs + safeLeaseMs;
      const mark = this.db.prepare(`
        UPDATE live_spool_inputs SET
          status = 'inflight',
          claimed_at_ms = ?,
          lease_expires_at_ms = ?,
          updated_at_ms = ?
        WHERE input_id = ? AND status = 'pending'
      `);
      for (const row of rows) {
        mark.run(safeAtMs, leaseExpiresAtMs, safeAtMs, row.input_id);
      }
      const claimed = rows.map((row) => rowToItem({
        ...row,
        status: LIVE_SPOOL_STATES.INFLIGHT,
        claimed_at_ms: safeAtMs,
        lease_expires_at_ms: leaseExpiresAtMs,
        updated_at_ms: safeAtMs,
      }));
      this.db.exec('COMMIT');
      return claimed;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  consume(inputId, atMs = this.now()) {
    const safeInputId = requiredId(inputId, 'inputId');
    const safeAtMs = timestamp(atMs, 'atMs');
    const current = this.byInputIdStatement.get(safeInputId);
    if (!current) return null;
    if (current.status === LIVE_SPOOL_STATES.CONSUMED) return rowToItem(current);
    if (current.status !== LIVE_SPOOL_STATES.INFLIGHT) {
      throw new Error('only an inflight live spool item can be consumed');
    }
    this.db.prepare(`
      UPDATE live_spool_inputs SET
        status = 'consumed',
        lease_expires_at_ms = NULL,
        consumed_at_ms = ?,
        updated_at_ms = ?
      WHERE input_id = ? AND status = 'inflight'
    `).run(safeAtMs, safeAtMs, safeInputId);
    return rowToItem(this.byInputIdStatement.get(safeInputId));
  }

  release(inputId, atMs = this.now()) {
    const safeInputId = requiredId(inputId, 'inputId');
    const safeAtMs = timestamp(atMs, 'atMs');
    this.db.prepare(`
      UPDATE live_spool_inputs SET
        status = 'pending',
        claimed_at_ms = NULL,
        lease_expires_at_ms = NULL,
        updated_at_ms = ?
      WHERE input_id = ? AND status = 'inflight'
    `).run(safeAtMs, safeInputId);
    return rowToItem(this.byInputIdStatement.get(safeInputId));
  }

  retireSession(sessionEpoch, atMs = this.now()) {
    const safeEpoch = requiredId(sessionEpoch, 'sessionEpoch');
    const safeAtMs = timestamp(atMs, 'atMs');
    return number(this.db.prepare(`
      UPDATE live_spool_inputs SET
        status = 'consumed',
        lease_expires_at_ms = NULL,
        consumed_at_ms = ?,
        updated_at_ms = ?
      WHERE session_epoch = ? AND status IN ('pending', 'inflight')
    `).run(safeAtMs, safeAtMs, safeEpoch).changes);
  }

  prune({ atMs = this.now(), beforeMs = null } = {}) {
    const safeAtMs = timestamp(atMs, 'atMs');
    const cutoff = beforeMs === null
      ? Math.max(0, safeAtMs - this.retentionMs)
      : timestamp(beforeMs, 'beforeMs');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const removed = number(this.db.prepare(`
        DELETE FROM live_spool_inputs
        WHERE status = 'consumed' AND consumed_at_ms <= ?
      `).run(cutoff).changes);
      this.db.exec(`
        DELETE FROM live_spool_sessions
        WHERE NOT EXISTS (
          SELECT 1 FROM live_spool_inputs
          WHERE live_spool_inputs.session_epoch = live_spool_sessions.session_epoch
        )
      `);
      this.db.exec('COMMIT');
      return removed;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  stats() {
    const counts = Object.fromEntries(this.db.prepare(`
      SELECT status, COUNT(*) AS count
      FROM live_spool_inputs GROUP BY status
    `).all().map((row) => [row.status, number(row.count)]));
    return {
      pending: counts.pending ?? 0,
      inflight: counts.inflight ?? 0,
      consumed: counts.consumed ?? 0,
      items: (counts.pending ?? 0) + (counts.inflight ?? 0) + (counts.consumed ?? 0),
      sessions: number(this.db.prepare(
        'SELECT COUNT(*) AS count FROM live_spool_sessions',
      ).get().count),
    };
  }

  close() {
    this.db.close();
  }
}
