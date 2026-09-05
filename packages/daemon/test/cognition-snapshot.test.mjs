import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Store } from '../src/store.mjs';
import { cognitionHistoryPrefix, cognitionCatchupPrompt } from '../src/cognition.mjs';
import { latestCognitionSnapshot, saveCognitionSnapshot, readCognitionJournal } from '../src/cognition-snapshot.mjs';
import { LarkToolService, createMcpHandler } from '../src/lark-tools.mjs';
import { CodexAgent } from '../src/codex.mjs';
import { ClaudeAgent } from '../src/claude.mjs';
import { PiAgent } from '../src/pi.mjs';
import { VolcAgent } from '../src/volc.mjs';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

describe('bounded cognition snapshots', () => {
  let dir, store, epoch, seq, databasePath;
  const add = (fields = {}) => store.appendCognitionJournal({
    kind: 'inbound', chatId: 'oc_chat12345678', actor: 'ou_person123456',
    messageId: `om_message${++seq}`, text: `request ${seq}`, epoch, ...fields,
  });
  const save = (throughSeq, fields = {}) => saveCognitionSnapshot(store.db, {
    epoch, throughSeq, summary: 'Decided to inspect the repository; request 1 is still open.',
    openMessageIds: ['om_message1'], runtimeToken: 'owner-a', ...fields,
  });
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cognition-snapshot-'));
    databasePath = path.join(dir, 'state.sqlite3');
    store = new Store(databasePath, logger);
    epoch = store.initializeCognition('codex', 'owner-a').epoch;
    seq = 0;
  });
  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads a persistent checkpoint plus only its subsequent raw delta', () => {
    const first = add({ text: 'old body that should not be replayed' });
    save(first);
    const head = add({ text: 'new delta body' });
    store.close();
    store = new Store(databasePath, logger);
    const { text, throughSeq } = cognitionHistoryPrefix(store, epoch, head);
    assert.equal(throughSeq, head);
    assert.match(text, /Decided to inspect/);
    assert.match(text, /om_message1/);
    assert.match(text, /new delta body/);
    assert.doesNotMatch(text, /old body that should not be replayed/);
    assert.equal(store.cognitionJournal(epoch).length, 2);
    assert.equal(latestCognitionSnapshot(store.db, epoch, first - 1), null);
    assert.equal(latestCognitionSnapshot(store.db, epoch + 1, head), null);
  });

  it('bounds legacy epochs with a recoverable archive gap, including a giant single message', () => {
    for (let i = 0; i < 788; i++) add({ text: `record ${i}: ${'x'.repeat(310)}` });
    const head = add({ text: 'giant-message ' + 'z'.repeat(180_000) });
    const { text } = cognitionHistoryPrefix(store, epoch, head);
    assert.ok(text.length <= 32_000);
    assert.match(text, /Archive gap:/);
    assert.match(text, /not a summary/);
    assert.match(text, /giant-message/);
    assert.match(text, /excerpt; read original/);
    assert.match(text, /Checkpoint due/);
    assert.equal(store.cognitionJournal(epoch).length, 789);
    assert.ok(cognitionHistoryPrefix(store, epoch, head, 10_000).text.length <= 10_000);
    assert.ok(cognitionCatchupPrompt(store, epoch, head).text.length <= 120_000);
  });

  it('never treats a snapshot as resolution of an uncertain outbound', () => {
    add();
    const head = add({ kind: 'outbound', status: 'PENDING', text: 'possibly sent', runtimeToken: 'owner-a' });
    save(head);
    assert.match(cognitionHistoryPrefix(store, epoch, head).text, /1 PENDING\/UNCERTAIN/);
    store.db.prepare("UPDATE cognition_journal SET status='COMMITTED' WHERE seq=?").run(head);
    assert.doesNotMatch(cognitionHistoryPrefix(store, epoch, head).text, /1 PENDING\/UNCERTAIN/);
  });

  it('links a checkpoint too large for a small prompt budget instead of silently truncating it', () => {
    const head = add();
    save(head, { summary: 'important decision '.repeat(600) });
    const { text } = cognitionHistoryPrefix(store, epoch, head, 10_000);
    assert.ok(text.length <= 10_000);
    assert.match(text, /read_cognition_snapshot/);
    assert.match(text, /exceeds this handoff budget/);
    assert.equal(latestCognitionSnapshot(store.db, epoch, head).summary, 'important decision '.repeat(600));
  });

  it('keeps current-session deltas empty for already observed committed sends', () => {
    const first = add();
    const head = add({ kind: 'outbound', text: 'observed', runtimeToken: 'owner-a' });
    assert.equal(cognitionHistoryPrefix(store, epoch, head, 120_000, first,
      { excludeCommittedOutboundFrom: 'owner-a' }).text, '');
    // Null-token outbound rows are not accidentally excluded by SQL NULL logic.
    const other = add({ kind: 'outbound', text: 'external notice', runtimeToken: null });
    assert.match(cognitionHistoryPrefix(store, epoch, other, 120_000, head,
      { excludeCommittedOutboundFrom: 'owner-a' }).text, /external notice/);
  });

  it('requests a checkpoint even after silent turns with no unsynced journal delta, in all adapters', () => {
    for (let i = 0; i < 40; i++) add();
    const head = store.cognitionJournalHead(epoch);
    const state = {
      store, cognitionEpoch: epoch, authorityToken: 'owner-a',
      config: { cognitionMaxChars: 120_000 }, needsHistoryPrefix: false,
      deliveredThroughSeq: head, syncedThroughSeq: head,
    };
    const input = [{ text: 'a new real inbound', seq: null }];
    for (const Runtime of [ClaudeAgent, PiAgent, VolcAgent]) {
      assert.match(Runtime.prototype._bodyFor.call({ ...state }, input).body, /Checkpoint due/);
    }
    let started;
    CodexAgent.prototype._startTurn.call({ ...state, _request: (_method, params) => {
      started = params.input[0].text;
      return Promise.resolve();
    } }, input);
    assert.match(started, /Checkpoint due/);
    save(head);
    assert.equal(store.cognitionCheckpointDue(epoch, head), false);
    assert.equal(cognitionHistoryPrefix(store, epoch, head, 120_000, head).text, '');
  });

  it('rejects stale owners, invalid provenance, future cuts and checkpoint rewinds atomically', () => {
    const first = add();
    const second = add();
    assert.throws(() => save(second, { runtimeToken: 'old-owner' }), /authority/);
    assert.throws(() => save(second, { epoch: epoch + 1 }), /epoch/);
    assert.throws(() => save(second + 100), /journal row/);
    assert.throws(() => save(first, { openMessageIds: ['om_message2'] }), /covered/);
    assert.equal(latestCognitionSnapshot(store.db, epoch, second), null);
    save(second);
    assert.equal(save(second).replay, true);
    assert.throws(() => save(first), /behind/);
    assert.throws(() => save(second, { summary: 'different' }), /overwrite/);
    assert.equal(latestCognitionSnapshot(store.db, epoch, second).throughSeq, second);
  });

  it('carries open requests across snapshots until they are explicitly resolved', () => {
    const first = add();
    save(first);
    const second = add();
    save(second, { openMessageIds: ['om_message2'] });
    assert.deepEqual(latestCognitionSnapshot(store.db, epoch, second).openMessageIds, ['om_message1', 'om_message2']);
    const third = add();
    const update = { openMessageIds: [], resolvedMessageIds: ['om_message1'] };
    save(third, update);
    assert.deepEqual(latestCognitionSnapshot(store.db, epoch, third).openMessageIds, ['om_message2']);
    assert.equal(save(third, update).replay, true);
  });

  it('lists all archived conversation scopes with bounded pages', () => {
    for (let i = 0; i < 70; i++) add({ chatId: `oc_chat_${i}` });
    const scopes = [];
    let indexOffset = 0;
    do {
      const page = readCognitionJournal(store.db, { epoch, scope_index: true, index_offset: indexOffset });
      assert.ok(page.scopes.length <= 32);
      scopes.push(...page.scopes);
      indexOffset = page.next_index_offset;
    } while (indexOffset !== null);
    assert.equal(new Set(scopes.map((scope) => scope.chat_id)).size, 70);
  });

  it('pages complete originals without losing offsets, Unicode, scope or epoch boundaries', () => {
    const original = 'long😀原文\n'.repeat(1600);
    const first = add({ text: original, threadId: 'omt_thread123456' });
    add({ text: 'another chat', chatId: 'oc_other12345678' });
    add({ text: 'another thread' });
    const head = add({ text: 'second matching record', threadId: 'omt_thread123456' });
    const input = { epoch, through_seq: head, chat_id: 'oc_chat12345678', thread_id: 'omt_thread123456', max_chars: 999 };
    let cursor = { after_seq: 0, offset: 0 };
    const texts = new Map();
    let calls = 0;
    do {
      const page = readCognitionJournal(store.db, { ...input, ...cursor });
      for (const row of page.items) texts.set(row.seq, (texts.get(row.seq) ?? '') + row.text);
      cursor = page.next;
      assert.ok(++calls < 100);
    } while (cursor);
    assert.equal(texts.size, 2);
    assert.equal(texts.get(first), original);
    assert.equal(texts.get(head), 'second matching record');
    assert.deepEqual(readCognitionJournal(store.db, { epoch: epoch + 1 }).items, []);
    assert.throws(() => readCognitionJournal(store.db, { epoch, max_chars: 100_000 }), /16000/);
  });

  it('uses the trusted MCP path without sending Lark messages and fences a retired sidecar', async () => {
    const head = add();
    const service = new LarkToolService({ databasePath, runtimeToken: 'owner-a',
      run: () => { throw new Error('must not call Lark'); } });
    const handle = createMcpHandler(service);
    const call = (name, args) => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    try {
      const saved = await call('save_cognition_snapshot', { epoch, through_seq: head, summary: 'Still open', open_message_ids: ['om_message1'] });
      assert.equal(saved.result.structuredContent.saved, true);
      assert.equal((await call('read_cognition_snapshot', { epoch, through_seq: head })).result.structuredContent.snapshot.summary, 'Still open');
      assert.equal((await call('read_cognition_journal', { epoch })).result.structuredContent.items.length, 1);
      store.initializeCognition('claude', 'owner-b');
      assert.equal((await call('read_cognition_journal', { epoch })).result.isError, true);
      assert.equal((await call('save_cognition_snapshot', { epoch, through_seq: head, summary: 'stale' })).result.isError, true);
    } finally { service.close(); }
  });
});
