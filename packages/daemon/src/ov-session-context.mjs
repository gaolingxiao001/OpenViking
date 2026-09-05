import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { formatCognitionJournalLine } from './cognition.mjs';

// OV owns summaries, archives and assembled context. SQLite retains only the
// transport cursor/intent here; cognition_journal is the existing durable
// delivery ledger and migration/sync outbox, never a prompt source.
export class OVSessionClient {
  constructor(configPath, { fetch: fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    this.url = String(config.url || '').replace(/\/$/, '');
    if (!/^https?:\/\//.test(this.url)) throw new Error('OpenViking URL is missing or invalid');
    this.headers = { 'Content-Type': 'application/json' };
    if (config.api_key) this.headers['X-API-Key'] = config.api_key;
    for (const [key, header] of [['account', 'X-OpenViking-Account'], ['user', 'X-OpenViking-User'], ['agent', 'X-OpenViking-Agent']]) {
      if (config[key]) this.headers[header] = config[key];
    }
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async request(route, body) {
    let response;
    try {
      response = await this.fetch(`${this.url}/api/v1${route}`, {
        method: body === undefined ? 'GET' : 'POST', headers: this.headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs), redirect: 'error',
      });
      const text = await response.text();
      if (text.length > 8_000_000) throw new Error('response too large');
      const data = JSON.parse(text);
      if (!response.ok || data.status !== 'ok') throw new Error('OV request rejected');
      return data.result;
    } catch {
      // Never expose auth headers, config contents, remote messages or URLs.
      const error = new Error(`OpenViking session request failed${response ? ` (HTTP ${response.status})` : ' or timed out'}`);
      error.httpStatus = response?.status;
      throw error;
    }
  }

  create(sessionId) {
    return this.request('/sessions', { session_id: sessionId, auto_commit_policy: {
      pending_token_threshold: 0, message_count_threshold: 0, idle_timeout_seconds: 0,
    } });
  }
  append(sessionId, message) { return this.request(`/sessions/${encodeURIComponent(sessionId)}/messages`, message); }
  context(sessionId) { return this.request(`/sessions/${encodeURIComponent(sessionId)}/context?token_budget=24000`); }
  commit(sessionId) { return this.request(`/sessions/${encodeURIComponent(sessionId)}/commit`, { keep_recent_count: 10 }); }
  archive(sessionId, archiveId) { return this.request(`/sessions/${encodeURIComponent(sessionId)}/archives/${encodeURIComponent(archiveId)}`); }
  read(uri, offset = 0, limit = 100) {
    return this.request(`/content/read?uri=${encodeURIComponent(uri)}&offset=${offset}&limit=${limit}&raw=true`);
  }
}

export class OVSessionContext {
  constructor(store, client, logger, { canCommit = () => false, waitMs = 15_000 } = {}) {
    this.store = store;
    this.client = client;
    this.logger = logger;
    this.barrier = Promise.resolve();
    this.contexts = new Map();
    this.stopped = false;
    this.checked = new Map();
    this.canCommit = canCommit;
    this.waitMs = waitMs;
    store.db.exec(`CREATE TABLE IF NOT EXISTS ov_session_sync (
      epoch INTEGER PRIMARY KEY, session_id TEXT NOT NULL, uri TEXT,
      synced_seq INTEGER NOT NULL DEFAULT 0, pending_seq INTEGER,
      commit_seq INTEGER NOT NULL DEFAULT 0, confirmed_seq INTEGER NOT NULL DEFAULT 0,
      commit_pending INTEGER NOT NULL DEFAULT 0, previous_overview TEXT, pending_confirm_seq INTEGER NOT NULL DEFAULT 0
    )`);
    store.prepareOVContext = (epoch) => this.prepare(epoch);
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

  // A write timeout is ambiguous. Auto-commit is disabled for daemon-owned OV
  // sessions, so the uncertain write remains in live messages until reconciled.
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

  async sync(epoch, throughSeq) {
    const state = await this.session(epoch);
    // Bounded DB reads; no epoch-sized array of bodies is materialized.
    while (state.synced_seq < throughSeq) {
      if (this.stopped) throw new Error('OV sync stopped');
      const row = this.store.db.prepare(`SELECT seq,status FROM cognition_journal
        WHERE epoch=? AND seq>? AND seq<=? ORDER BY seq LIMIT 1`).get(epoch, state.synced_seq, throughSeq);
      if (!row) break;
      if (row.status === 'PENDING') throw new Error('OV sync is waiting for an unsettled local delivery');
      const sourceId = `lark:${epoch}:${row.seq}`;
      if (!(state.pending_seq === row.seq && await this.hasSource(state, sourceId))) {
        const item = this.store.cognitionJournal(epoch, row.seq, row.seq - 1)[0];
        if (!item) throw new Error('OV sync source record is unavailable');
        this.store.db.prepare('UPDATE ov_session_sync SET pending_seq=? WHERE epoch=?').run(row.seq, epoch);
        state.pending_seq = row.seq;
        const content = formatCognitionJournalLine(item);
        await this.client.append(state.session_id, {
          role: item.kind === 'outbound' ? 'assistant' : 'user',
          content,
          created_at: new Date(item.atMs).toISOString(),
          source_message_ids: [sourceId, `sha256:${createHash('sha256').update(content).digest('hex')}`],
        });
      }
      if (this.stopped) throw new Error('OV sync stopped');
      this.store.db.prepare('UPDATE ov_session_sync SET synced_seq=?,pending_seq=NULL WHERE epoch=?').run(row.seq, epoch);
      state.synced_seq = row.seq;
      state.pending_seq = null;
    }
    return state;
  }

  prepare(epoch) {
    const throughSeq = this.store.cognitionJournalHead(epoch);
    return this.run(async () => {
      const state = await this.sync(epoch, throughSeq);
      if (this.canCommit()) await this.maybeCommit(state, epoch);
      let context = await this.client.context(state.session_id);
      const deadline = Date.now() + this.waitMs;
      while (state.commit_pending && (!context.latest_archive_overview || context.latest_archive_overview === state.previous_overview)
        && !context.stats.failedArchives && Date.now() < deadline && !this.stopped) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        context = await this.client.context(state.session_id);
      }
      if (this.stopped) throw new Error('OV sync stopped');
      if (!context || !Array.isArray(context.messages)) throw new Error('OV session context is invalid');
      if (context.stats?.failedArchives > 0) throw new Error('OV archive failed; refusing an incomplete handoff');
      if (context.stats?.totalArchives > 0 && !context.latest_archive_overview) {
        throw new Error('OV archive overview is pending or excluded by its context budget; retry when available');
      }
      this.confirmCommit(state, epoch, context);
      for (const message of context.messages) {
        const expected = message.source_message_ids?.find((id) => id.startsWith('sha256:'));
        if (expected) {
          const text = (message.parts ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
          if (`sha256:${createHash('sha256').update(text).digest('hex')}` !== expected) {
            throw new Error('OV live context was truncated; compact the OV session before handoff');
          }
        }
      }
      const visibleSources = new Set(context.messages.flatMap((message) => message.source_message_ids ?? []));
      const needed = this.store.db.prepare('SELECT seq FROM cognition_journal WHERE epoch=? AND seq>? AND seq<=?')
        .all(epoch, state.confirmed_seq, state.synced_seq);
      if (needed.some((row) => !visibleSources.has(`lark:${epoch}:${row.seq}`))) {
        throw new Error('OV context omitted unsummarized source messages; refusing an incomplete handoff');
      }
      const prepared = { ...context, sessionId: state.session_id, throughSeq: state.synced_seq,
        archiveThroughSeq: state.commit_seq, epoch };
      this.contexts.set(epoch, prepared);
      return prepared;
    });
  }

  // Run only after the local runtime and ingress buffers are idle. This gives
  // commit a turn boundary and prevents summaries from covering queued inputs.
  checkpoint(epoch) {
    const throughSeq = this.store.cognitionJournalHead(epoch);
    return this.run(async () => {
      if (this.checked.get(epoch) === throughSeq
        && !this.store.db.prepare('SELECT commit_pending FROM ov_session_sync WHERE epoch=?').get(epoch)?.commit_pending) return;
      const state = await this.sync(epoch, throughSeq);
      await this.maybeCommit(state, epoch);
      this.checked.set(epoch, throughSeq);
    });
  }

  confirmCommit(state, epoch, context) {
    if (state.commit_pending && !context.stats?.failedArchives
      && context.latest_archive_overview && context.latest_archive_overview !== state.previous_overview) {
      this.store.db.prepare('UPDATE ov_session_sync SET confirmed_seq=pending_confirm_seq,commit_pending=0 WHERE epoch=?').run(epoch);
      state.confirmed_seq = state.pending_confirm_seq;
      state.commit_pending = 0;
    }
  }

  async maybeCommit(state, epoch) {
    const context = await this.client.context(state.session_id);
    if (this.stopped) throw new Error('OV sync stopped');
    this.confirmCommit(state, epoch, context);
    // An ambiguous commit is never resubmitted. A changed cumulative overview
    // confirms completion for this exclusively daemon-owned session. Until then
    // every unconfirmed source must remain visible in OV's raw context.
    if (state.commit_pending || context.stats?.failedArchives) return;
    const meta = await this.client.request(`/sessions/${encodeURIComponent(state.session_id)}`);
    if (this.stopped) throw new Error('OV sync stopped');
    if ((meta.pending_tokens ?? 0) >= 12_000) {
      // keep_recent_count=10 leaves these raw messages outside the summary.
      // Coverage comes from source metadata only, never local message bodies.
      const retained = this.store.db.prepare('SELECT seq FROM cognition_journal WHERE epoch=? AND seq<=? ORDER BY seq DESC LIMIT 10')
        .all(epoch, state.synced_seq);
      const covered = retained.length ? Math.min(...retained.map((row) => row.seq)) - 1 : state.confirmed_seq;
      if (covered <= state.confirmed_seq) return;
      this.store.db.prepare('UPDATE ov_session_sync SET commit_seq=?,commit_pending=1,previous_overview=?,pending_confirm_seq=? WHERE epoch=?')
        .run(state.synced_seq, context.latest_archive_overview || '', covered, epoch);
      state.pending_confirm_seq = covered;
      state.commit_seq = state.synced_seq;
      state.commit_pending = 1;
      state.previous_overview = context.latest_archive_overview || '';
      await this.client.commit(state.session_id);
    }
  }

  stop() { this.stopped = true; }
}
