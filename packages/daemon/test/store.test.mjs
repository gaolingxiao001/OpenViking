import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function event(id, content = `message ${id}`, overrides = {}) {
  return {
    type: 'im.message.receive_v1',
    eventId: `evt-${id}`,
    messageId: `om-${id}`,
    conversationKey: overrides.conversationKey || 'default:tenant:oc-chat:main',
    chatId: 'oc-chat',
    chatType: 'group',
    messageType: 'text',
    senderId: 'ou-user',
    senderType: 'user',
    rootId: null,
    parentId: null,
    threadId: null,
    threadRootId: null,
    content,
    mentions: [],
    createTimeMs: Date.now(),
    raw: { id },
    ...overrides,
  };
}

describe('Store', () => {
  let directory;
  let store;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-daemon-store-'));
    store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
  });

  afterEach(() => {
    try { store.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('records an accepted message DONE and deduplicates replay durably', () => {
    assert.equal(store.ingest(event('1')).inserted, true);
    assert.equal(store.ingest(event('1')).inserted, false);
    assert.equal(store.stats().inbound.DONE, 1);

    store.close();
    store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    assert.equal(store.ingest(event('1')).inserted, false);
  });

  it('looks an inbound row up by seq for failure notices', () => {
    const { inbound } = store.ingest(event('7', 'needs a reply'));
    const found = store.inboundBySeq(inbound.seq);
    assert.equal(found.messageId, 'om-7');
    assert.equal(found.content, 'needs a reply');
    assert.equal(store.inboundBySeq(9999), null);
    assert.equal(store.inboundBySeq(null), null);
  });

  it('persists group chat names and applies retry timing without scheduling p2p lookups', () => {
    const now = 1_700_000_000_000;
    const group = event('named-source', 'group message', {
      chatId: 'oc-named-source',
      conversationKey: 'default:tenant:oc-named-source:main',
    });
    const direct = event('direct-source', 'direct message', {
      chatId: 'oc-direct-source',
      chatType: 'p2p',
      conversationKey: 'default:tenant:oc-direct-source:main',
    });
    store.ingest(group, null, now);
    store.ingest(direct, null, now + 1);

    assert.deepEqual(
      store.dueChatNameLookups(now + 2).map((source) => source.chatId),
      [group.chatId],
    );
    assert.equal(store.deferChatSourceName(group.chatId, 'RETRY', now + 5_000, now + 2), true);
    assert.equal(store.chatNameLookupCandidate(group.chatId, now + 4_999), null);
    assert.equal(store.chatNameLookupCandidate(group.chatId, now + 5_000).failureCount, 1);
    assert.equal(
      store.saveChatSourceName(group.chatId, 'Backend 日常群', now + 86_400_000, now + 5_001),
      true,
    );

    const databasePath = path.join(directory, 'state.sqlite3');
    store.close();
    store = new Store(databasePath, quietLogger);
    const persisted = store.db.prepare(`
      SELECT name, lookup_status, failure_count FROM chat_sources WHERE chat_id = ?
    `).get(group.chatId);
    assert.deepEqual({ ...persisted }, {
      name: 'Backend 日常群',
      lookup_status: 'RESOLVED',
      failure_count: 0,
    });
  });

  it('migrates existing group inbound rows into due chat sources', () => {
    const legacyGroup = event('legacy-source', 'legacy group message', {
      chatId: 'oc-legacy-source',
      conversationKey: 'default:tenant:oc-legacy-source:main',
    });
    store.ingest(legacyGroup, null, 1_600_000_000_000);
    const databasePath = path.join(directory, 'state.sqlite3');
    store.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec('DROP TABLE chat_sources');
    legacy.exec('ALTER TABLE activities DROP COLUMN source_name');
    legacy.close();

    store = new Store(databasePath, quietLogger);
    const source = store.chatNameLookupCandidate(legacyGroup.chatId, Date.now());
    assert.ok(source);
    assert.equal(source.chatType, 'group');
    assert.equal(source.lookupStatus, 'PENDING');
    assert.equal(source.name, null);
    assert.equal(JSON.stringify(store.listActivities({ limit: 10 })).includes(legacyGroup.chatId), false);
  });

  it('does not persist raw event envelopes and blanks ignored content', () => {
    const accepted = event('raw', 'visible', { raw: { token: 'secret-sentinel' } });
    store.ingest(accepted);
    const acceptedRow = store.db.prepare('SELECT raw_json, content, status FROM inbound WHERE message_id = ?')
      .get(accepted.messageId);
    assert.equal(acceptedRow.raw_json, '{}');
    assert.equal(acceptedRow.content, 'visible');
    assert.equal(acceptedRow.status, 'DONE');

    const ignored = event('ignored', 'private ignored body', { raw: { app_secret: 'secret-sentinel' } });
    store.ingest(ignored, 'unsupported_message_type');
    const ignoredRow = store.db.prepare(`
      SELECT raw_json, content, mentions_json, status FROM inbound WHERE message_id = ?
    `).get(ignored.messageId);
    assert.deepEqual({ ...ignoredRow }, {
      raw_json: '{}',
      content: '',
      mentions_json: '[]',
      status: 'RULE_IGNORED',
    });
  });

  it('records message.received and message.ignored activities', () => {
    store.ingest(event('1', 'hello there'));
    store.ingest(event('2', 'private'), 'unsupported_message_type');
    const kinds = store.listActivities({ limit: 100 }).activities.map((a) => a.kind).sort();
    assert.deepEqual(kinds, ['message.ignored', 'message.received']);
    const serialized = JSON.stringify(store.listActivities({ limit: 100 }).activities);
    assert.equal(serialized.includes('private'), false);
  });

  it('stores one global session shared across chats and clears it durably', () => {
    assert.deepEqual(store.getGlobalSession(), {
      sessionId: null,
      policyHash: null,
      runtime: null,
      epoch: 0,
      syncedThroughSeq: 0,
      sessionReady: false,
    });
    store.setGlobalSession('thread-abc', 'a'.repeat(64));
    assert.deepEqual(store.getGlobalSession(), {
      sessionId: 'thread-abc',
      policyHash: 'a'.repeat(64),
      runtime: 'codex',
      epoch: 1,
      syncedThroughSeq: 0,
      sessionReady: true,
    });

    const databasePath = path.join(directory, 'state.sqlite3');
    store.close();
    store = new Store(databasePath, quietLogger);
    assert.equal(store.getGlobalSession().sessionId, 'thread-abc');
    store.clearGlobalSession();
    assert.equal(store.getGlobalSession().sessionId, null);
  });

  it('rolls back the complete global session tuple when a write fails', () => {
    store.setGlobalSession('stable-session', 'stable-policy', {
      runtime: 'claude',
      epoch: 3,
      syncedThroughSeq: 9,
      sessionReady: true,
    });
    const before = store.getGlobalSession();
    const statement = store.setMetaStatement;
    let writes = 0;
    store.setMetaStatement = {
      run(...args) {
        writes += 1;
        if (writes === 3) throw new Error('injected session tuple failure');
        return statement.run(...args);
      },
    };

    assert.throws(() => store.setGlobalSession('phantom-session', 'phantom-policy', {
      runtime: 'claude',
      epoch: 4,
      syncedThroughSeq: 0,
      sessionReady: false,
    }), /injected session tuple failure/);
    store.setMetaStatement = statement;
    assert.deepEqual(store.getGlobalSession(), before);
  });

  it('returns cross-chat DONE history tagged by chat, oldest first', () => {
    const a = event('a', 'from chat A', { conversationKey: 'default:tenant:oc-a:main', chatId: 'oc-a' });
    const b = event('b', 'from chat B', { conversationKey: 'default:tenant:oc-b:main', chatId: 'oc-b' });
    store.ingest(a, null, 1_000);
    store.ingest(b, null, 2_000);
    const history = store.history(30);
    assert.deepEqual(history.map((row) => row.chatId), ['oc-a', 'oc-b']);
    assert.equal(history.every((row) => row.direction === 'inbound'), true);
    assert.deepEqual(store.history(0), []);
  });

  it('cuts history off before a given seq so the current batch is not duplicated', () => {
    store.ingest(event('one', 'earlier message'), null, 1_000);
    const current = store.ingest(event('two', 'current message'), null, 2_000);
    const history = store.history(30, current.inbound.seq);
    assert.deepEqual(history.map((row) => row.text), ['earlier message']);
  });

  it('prunes old inbound but keeps the append-only activity ledger', () => {
    store.ingest(event('old', 'old body'), null, 1_000);
    const before = store.listActivities({ limit: 100 }).activities;
    const removed = store.prune(1_000, 10_000);
    assert.ok(removed.inbound > 0);
    assert.equal(store.stats().activities, before.length);
    assert.deepEqual(
      store.listActivities({ limit: 100 }).activities.map((item) => item.id),
      before.map((item) => item.id),
    );
  });
});
