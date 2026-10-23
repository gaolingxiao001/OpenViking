import { randomUUID } from 'node:crypto';
import { formatCognitionJournalLine } from './cognition.mjs';
import { safeError } from './logger.mjs';
import { OVConnection, readOVConfig } from './ov-connection.mjs';

// A commit keeps the newest complete turns, up to RETAINED_TOKENS, live as raw
// messages and runs once COMMIT_TOKENS more are pending, so the live session
// fits the context read whole.
const RETAINED_TOKENS = 24_000;
const COMMIT_TOKENS = 24_000;
const CONTEXT_TOKENS = RETAINED_TOKENS + COMMIT_TOKENS;

// OV owns archives and assembled context. SQLite retains only the transport
// cursor/intent here; cognition_journal is the existing durable delivery ledger
// and sync outbox, never a prompt source.
export class OVSessionClient extends OVConnection {
  constructor(configPath, options) {
    super(readOVConfig(configPath), options);
  }

  async request(route, body) {
    return (await this.json(`/api/v1${route}`, body)).result;
  }

  create(sessionId) {
    return this.request('/sessions', { session_id: sessionId, auto_commit_policy: {
      pending_token_threshold: 0, message_count_threshold: 0, idle_timeout_seconds: 0,
    } });
  }
  append(sessionId, message) { return this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, message); }
  context(sessionId) {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/context?token_budget=${CONTEXT_TOKENS}`);
  }
  // The turn count is OV's maximum, so only the token budget binds.
  commit(sessionId) {
    return this.request(`/sessions/${encodeURIComponent(sessionId)}/commit`, {
      retention_mode: 'turn_budget', keep_recent_turn_count: 10_000, retained_message_token_budget: RETAINED_TOKENS,
    });
  }
  archive(sessionId, archiveId) { return this.request(`/sessions/${encodeURIComponent(sessionId)}/archives/${encodeURIComponent(archiveId)}`); }
  read(uri, offset = 0, limit = 100) {
    return this.request(`/content/read?uri=${encodeURIComponent(uri)}&offset=${offset}&limit=${limit}&raw=true`);
  }
}

export class OVSessionContext {
  constructor(store, client, logger) {
    this.store = store;
    this.client = client;
    this.logger = logger;
    this.barrier = Promise.resolve();
    this.contexts = new Map();
    this.stopped = false;
    this.checked = new Map();
    store.db.exec(`CREATE TABLE IF NOT EXISTS ov_session_sync (
      epoch INTEGER PRIMARY KEY, session_id TEXT NOT NULL, uri TEXT,
      synced_seq INTEGER NOT NULL DEFAULT 0, pending_seq INTEGER
    )`);
    store.prepareOVContext = async (epoch) => {
      try {
        return await this.prepare(epoch);
      } catch (error) {
        if (this.stopped) throw error;
        // History is best effort: a fresh session starts without it rather
        // than blocking a runtime switch or an inbound message. Never reuse
        // stale prefetched history after a failure. The local outbox/cursors
        // remain intact, so the idle checkpoint can retry later.
        const empty = { messages: [] };
        this.contexts.set(epoch, empty);
        // A JSON parse error can quote remote content.
        this.logger.warn('ov_context_unavailable', {
          error: error instanceof SyntaxError ? 'OV returned malformed data' : safeError(error),
        });
        return empty;
      }
    };
    store.getOVContext = (epoch) => this.contexts.get(epoch);
  }

  run(fn) {
    const work = this.barrier.then(() => {
      if (this.stopped) throw new Error('OpenViking context transport is stopping');
      return fn();
    });
    this.barrier = work.catch(() => {});
    return work;
  }

  async session(epoch) {
    let state = this.store.db.prepare('SELECT * FROM ov_session_sync WHERE epoch=?').get(epoch);
    if (!state) {
      this.store.db.prepare('INSERT INTO ov_session_sync(epoch,session_id) VALUES (?,?)')
        .run(epoch, `lark-${randomUUID()}`);
      state = this.store.db.prepare('SELECT * FROM ov_session_sync WHERE epoch=?').get(epoch);
    }
    if (!state.uri) {
      const remote = await this.client.create(state.session_id);
      if (this.stopped) throw new Error('OV sync stopped');
      if (!remote?.uri || remote.session_id !== state.session_id) throw new Error('OV returned an invalid session identity');
      this.store.db.prepare('UPDATE ov_session_sync SET uri=? WHERE epoch=?').run(remote.uri, epoch);
      state.uri = remote.uri;
    }
    return state;
  }

  // A write timeout is ambiguous. Commits run only after a complete sync, so
  // the uncertain write remains in live messages until it is reconciled.
  // Do not retry an append based only on a timeout: first look for its source ID.
  async hasSource(state, sourceId) {
    for (let offset = 0; ; offset += 100) {
      if (this.stopped) throw new Error('OV sync stopped');
      let content;
      try { content = await this.client.read(`${state.uri}/messages.jsonl`, offset, 100); }
      catch (error) {
        // Confirmed absence is different from a read timeout/permission error.
        if (error.httpStatus === 404 && offset === 0) return false;
        throw error;
      }
      if (typeof content !== 'string') throw new Error('OV live message read returned invalid data');
      const lines = content.split('\n').filter(Boolean);
      for (const line of lines) {
        const message = JSON.parse(line);
        if (message.source_message_ids?.includes(sourceId)) return true;
      }
      if (lines.length < 100) return false;
    }
  }

  // Returns false when an unsettled local delivery stops the cursor; a later
  // checkpoint continues from it once it settles.
  async sync(state, epoch, throughSeq) {
    // Bounded DB reads; no epoch-sized array of bodies is materialized.
    while (state.synced_seq < throughSeq) {
      if (this.stopped) throw new Error('OV sync stopped');
      const row = this.store.db.prepare(`SELECT seq,status FROM cognition_journal
        WHERE epoch=? AND seq>? AND seq<=?
          AND status IN ('PENDING', 'COMMITTED', 'UNCERTAIN')
        ORDER BY seq LIMIT 1`).get(epoch, state.synced_seq, throughSeq);
      if (!row) break;
      if (row.status === 'PENDING') return false;
      const sourceId = `lark:${epoch}:${row.seq}`;
      if (!(state.pending_seq === row.seq && await this.hasSource(state, sourceId))) {
        const item = this.store.cognitionJournal(epoch, row.seq, row.seq - 1)[0];
        if (!item) throw new Error('OV sync source record is unavailable');
        this.store.db.prepare('UPDATE ov_session_sync SET pending_seq=? WHERE epoch=?').run(row.seq, epoch);
        state.pending_seq = row.seq;
        await this.client.append(state.session_id, {
          role: item.kind === 'outbound' ? 'assistant' : 'user',
          content: formatCognitionJournalLine(item),
          created_at: new Date(item.atMs).toISOString(),
          source_message_ids: [sourceId],
        });
      }
      if (this.stopped) throw new Error('OV sync stopped');
      this.store.db.prepare('UPDATE ov_session_sync SET synced_seq=?,pending_seq=NULL WHERE epoch=?').run(row.seq, epoch);
      state.synced_seq = row.seq;
      state.pending_seq = null;
    }
    return true;
  }

  // OV's recent raw history for a fresh native session. Older history stays in
  // OV archives, which the model reads on demand.
  prepare(epoch) {
    const throughSeq = this.store.cognitionJournalHead(epoch);
    return this.run(async () => {
      const state = await this.session(epoch);
      await this.sync(state, epoch, throughSeq);
      const context = await this.client.context(state.session_id);
      if (this.stopped) throw new Error('OV sync stopped');
      if (!context || !Array.isArray(context.messages)) throw new Error('OV session context is invalid');
      const prepared = { ...context, sessionId: state.session_id, throughSeq: state.synced_seq, epoch };
      this.contexts.set(epoch, prepared);
      return prepared;
    });
  }

  // Run only after the local runtime and ingress buffers are idle, so a commit
  // lands on a turn boundary.
  checkpoint(epoch) {
    const throughSeq = this.store.cognitionJournalHead(epoch);
    return this.run(async () => {
      if (this.checked.get(epoch) === throughSeq) return;
      const state = await this.session(epoch);
      if (!await this.sync(state, epoch, throughSeq)) return;
      await this.maybeCommit(state);
      this.checked.set(epoch, throughSeq);
    });
  }

  // Keeps no local commit state. A commit with an unknown outcome is safe to
  // repeat: one that landed leaves nothing pending to trigger another.
  async maybeCommit(state) {
    const meta = await this.client.request(`/sessions/${encodeURIComponent(state.session_id)}`);
    if (this.stopped) throw new Error('OV sync stopped');
    if ((meta.pending_tokens ?? 0) >= COMMIT_TOKENS) await this.client.commit(state.session_id);
  }

  stop() { this.stopped = true; }
}
