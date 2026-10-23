import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../src/store.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OVSessionClient, OVSessionContext } from '../src/ov-session-context.mjs';
import { cognitionHistoryPrefix } from '../src/cognition.mjs';
import { OVUnavailableError } from '../src/ov-connection.mjs';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
function setup(t) {
  const store = new Store(':memory:', logger);
  const { epoch } = store.initializeCognition('codex', 'owner');
  // Latest OV with Working Memory off: a completed archive leaves no overview
  // and drops out of /context.
  const client = {
    messages: [], archives: 0, failed: 0, writes: 0, commits: 0, pending: 0,
    async create(id) { return { session_id: id, uri: `viking://session/${id}` }; },
    async append(id, message) {
      this.writes++;
      this.messages.push({ ...message, parts: [{ type: 'text', text: message.content }] });
      if (this.timeout) { this.timeout = false; throw new Error('timeout'); }
    },
    async read() { return this.messages.map((m) => JSON.stringify(m)).join('\n'); },
    async request() { return { pending_tokens: this.pending }; },
    async commit() {
      this.commits++;
      if (this.commitTimeout) { this.commitTimeout = false; throw new OVUnavailableError('timeout'); }
      this.archives++; this.pending = 0; this.messages = this.messages.slice(-10);
    },
    async context() { return { messages: this.messages, latest_archive_overview: '',
      stats: { totalArchives: this.archives, failedArchives: this.failed } }; },
  };
  const warnings = [];
  const service = new OVSessionContext(store, client, { ...logger, warn: (event, fields) => warnings.push({ event, ...fields }) });
  t.after(() => { service.stop(); store.close(); });
  const append = (text) => store.appendCognitionJournal({ kind: 'inbound', actor: 'user', chatId: 'chat', messageId: 'message', text });
  return { store, epoch, client, service, append, warnings };
}

test('OV survives service recreation and context never reads local bodies', async (t) => {
  const { store, epoch, client, service, append } = setup(t);
  append('one'); append('two');
  const first = await service.prepare(epoch);
  const restored = new OVSessionContext(store, client, logger);
  const second = await restored.prepare(epoch);
  assert.equal(first.sessionId, second.sessionId);
  assert.equal(client.writes, 2);
  store.cognitionJournal = () => { throw new Error('local body access forbidden'); };
  assert.match(cognitionHistoryPrefix(store, epoch, second.throughSeq).text, /one/);
  assert.equal(cognitionHistoryPrefix(store, epoch, second.throughSeq, 1).text, '');
  assert.doesNotMatch(cognitionHistoryPrefix(store, epoch, first.throughSeq - 1).text, /\] two/);
});

test('uncertain successful append reconciles source ID after restart', async (t) => {
  const { store, epoch, client, service, append } = setup(t);
  append('only once'); client.timeout = true;
  await assert.rejects(service.prepare(epoch), /timeout/);
  const restored = new OVSessionContext(store, client, logger);
  await restored.prepare(epoch);
  assert.equal(client.writes, 1);
  assert.equal(store.db.prepare('SELECT pending_seq FROM ov_session_sync').get().pending_seq, null);
});

test('cancelled journal rows are skipped while syncing to OV', async (t) => {
  const { store, epoch, client, service, append } = setup(t);
  append('first');
  store.appendCognitionJournal({ kind: 'outbound', status: 'CANCELLED', text: 'cancelled' });
  append('second');

  const context = await service.prepare(epoch);

  assert.equal(client.writes, 2);
  assert.equal(context.messages.length, 2);
  assert.match(context.messages[0].content, /first/);
  assert.match(context.messages[1].content, /second/);
  assert.doesNotMatch(context.messages.map((message) => message.content).join('\n'), /cancelled/);
});

test('archives without an overview hand off the recent raw tail', async (t) => {
  const { store, epoch, client, service, append } = setup(t);
  for (let i = 0; i < 15; i++) append(`message ${i}`);
  client.pending = 30_000;
  await service.checkpoint(epoch);
  assert.equal(client.archives, 1);
  // A failed archive's memory extraction does not block a handoff either.
  client.failed = 1;
  const context = await store.prepareOVContext(epoch);
  assert.equal(context.messages.length, 10);
  const prefix = cognitionHistoryPrefix(store, epoch, context.throughSeq).text;
  assert.match(prefix, /message 14/);
  assert.doesNotMatch(prefix, /message 4\b/);
  assert.match(prefix, /Earlier history of this epoch is in OpenViking archives/);
});

test('commits only above the pending threshold and keeps no local commit state', async (t) => {
  const { epoch, client, service, append } = setup(t);
  append('one'); client.pending = 23_999;
  await service.checkpoint(epoch);
  assert.equal(client.commits, 0);
  append('two'); client.pending = 24_000;
  client.commitTimeout = true;
  await assert.rejects(service.checkpoint(epoch), /timeout/);
  // An unknown outcome is retried while OV still reports pending tokens.
  await service.checkpoint(epoch);
  assert.equal(client.commits, 2);
  assert.equal(client.archives, 1);
  append('three');
  await service.checkpoint(epoch);
  assert.equal(client.commits, 2);
});

test('an unsettled delivery holds the cursor but not the handoff', async (t) => {
  const { store, epoch, client, service, append } = setup(t);
  append('before');
  store.appendCognitionJournal({ kind: 'outbound', status: 'PENDING', text: 'in flight' });
  append('after'); client.pending = 30_000;
  const context = await service.prepare(epoch);
  assert.equal(client.writes, 1);
  assert.match(context.messages[0].content, /before/);
  await service.checkpoint(epoch);
  assert.equal(client.commits, 0);
});

test('epochs have independent remote sessions; stop prevents new work', async (t) => {
  const { service, epoch } = setup(t);
  const a = await service.prepare(epoch);
  const b = await service.prepare(epoch + 1);
  assert.notEqual(a.sessionId, b.sessionId);
  service.stop();
  await assert.rejects(service.prepare(epoch), /stopping/);
});

test('OV HTTP client pins auth, disables auto commits, retains a token tail, and redacts server errors', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-http-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ url: 'https://ov.invalid', api_key: 'secret-test-key' }));
  let request;
  const client = new OVSessionClient(config, { fetch: async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ status: 'ok', result: { session_id: 'test' } }));
  } });
  await client.create('test');
  assert.equal(request.url, 'https://ov.invalid/api/v1/sessions');
  assert.equal(request.options.headers['X-API-Key'], 'secret-test-key');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body).auto_commit_policy, {
    pending_token_threshold: 0, message_count_threshold: 0, idle_timeout_seconds: 0,
  });
  await client.commit('test');
  assert.deepEqual(JSON.parse(request.options.body), {
    retention_mode: 'turn_budget', keep_recent_turn_count: 10_000, retained_message_token_budget: 24_000,
  });
  await client.context('test');
  assert.equal(request.url, 'https://ov.invalid/api/v1/sessions/test/context?token_budget=48000');
  client.fetch = async () => new Response('secret-test-key remote private content', { status: 503 });
  await assert.rejects(client.context('test'), (error) => {
    assert.equal(error.httpStatus, 503);
    assert.doesNotMatch(error.message, /secret-test-key|private content/);
    return true;
  });
});

test('OV failures omit stale history, retain uncertain writes, and recover without duplicate capture', async (t) => {
  const { service, store, client, epoch, append, warnings } = setup(t);
  append('before outage');
  await store.prepareOVContext(epoch);
  const appendRemote = client.append.bind(client);
  client.append = async (...args) => {
    await appendRemote(...args);
    throw new OVUnavailableError('timeout');
  };
  append('accepted remotely but timed out');
  // An outage costs the history, never the message.
  assert.deepEqual(await store.prepareOVContext(epoch), { messages: [] });
  const pending = store.db.prepare('SELECT pending_seq FROM ov_session_sync').get().pending_seq;
  assert.ok(pending);
  const readRemote = client.read.bind(client);
  client.read = async () => { throw new OVUnavailableError('offline'); };
  await store.prepareOVContext(epoch);
  assert.equal(cognitionHistoryPrefix(store, epoch, pending).text, '');
  assert.equal(store.db.prepare('SELECT pending_seq FROM ov_session_sync').get().pending_seq, pending);
  client.append = appendRemote;
  client.read = readRemote;
  await service.checkpoint(epoch);
  await store.prepareOVContext(epoch);
  assert.equal(client.writes, 2);
  assert.match(cognitionHistoryPrefix(store, epoch, pending).text, /accepted remotely/);
  // Malformed OV data degrades the same way, without quoting it in logs.
  client.read = async () => 'private {not json';
  append('reconciled against unreadable OV');
  store.db.prepare('UPDATE ov_session_sync SET pending_seq=?').run(store.cognitionJournalHead(epoch));
  assert.deepEqual(await store.prepareOVContext(epoch), { messages: [] });
  assert.deepEqual(warnings.at(-1), { event: 'ov_context_unavailable', error: 'OV returned malformed data' });
});
