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

  it('deduplicates event and message replay durably', () => {
    assert.equal(store.ingest(event('1')).inserted, true);
    assert.equal(store.ingest(event('1')).inserted, false);
    assert.equal(store.queuedConversationKeys().length, 1);

    store.close();
    store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    assert.equal(store.ingest(event('1')).inserted, false);
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
    const acceptedRow = store.db.prepare('SELECT raw_json, content FROM inbound WHERE message_id = ?')
      .get(accepted.messageId);
    assert.equal(acceptedRow.raw_json, '{}');
    assert.equal(acceptedRow.content, 'visible');

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

  it('applies queue caps atomically while retaining ignored IDs', () => {
    const limits = { perConversation: 1, total: 2 };
    assert.equal(store.ingest(event('1'), null, Date.now(), limits).filterReason, null);
    assert.equal(
      store.ingest(event('2'), null, Date.now(), limits).filterReason,
      'queue_conversation_full',
    );
    const other = event('3', 'other', { conversationKey: 'default:tenant:oc-other:main', chatId: 'oc-other' });
    assert.equal(store.ingest(other, null, Date.now(), limits).filterReason, null);
    const third = event('4', 'third', { conversationKey: 'default:tenant:oc-third:main', chatId: 'oc-third' });
    assert.equal(store.ingest(third, null, Date.now(), limits).filterReason, 'queue_total_full');
    assert.equal(store.stats().inbound.QUEUED, 2);
    assert.equal(store.stats().inbound.RULE_IGNORED, 2);
  });

  it('batches one conversation and creates one durable outbox row', () => {
    store.ingest(event('1'));
    store.ingest(event('2'));
    const turn = store.claimBatch(event('1').conversationKey, 20);
    assert.equal(turn.messages.length, 2);
    assert.equal(turn.targetMessageId, 'om-2');

    const created = store.createOutboxIfFresh(turn.id, {
      action: 'reply',
      reasonCode: 'direct_request',
      deliveryMode: 'reply',
      reply: 'answer',
    });
    assert.equal(created.stale, false);
    assert.equal(created.outbox.replyToMessageId, 'om-2');
    assert.equal(created.outbox.targetChatId, 'oc-chat');
    assert.equal(created.outbox.deliveryMode, 'reply');

    const prepared = store.prepareOutboxAttempt(created.outbox.id, 3_000_000);
    assert.equal(prepared.ready, true);
    assert.equal(prepared.outbox.idempotencyKey, created.outbox.idempotencyKey);
    store.markOutboxSent(created.outbox.id, 'om-agent');
    assert.equal(store.stats().outbox.SENT, 1);
  });

  it('uses agent-selected thread delivery from a group main chat', () => {
    const main = event('main-thread-request');
    store.ingest(main);
    const turn = store.claimBatch(main.conversationKey, 20);
    const { outbox } = store.createOutboxIfFresh(turn.id, {
      action: 'reply',
      reasonCode: 'continuation',
      deliveryMode: 'thread',
      reply: 'start a thread',
    });
    assert.equal(outbox.deliveryMode, 'thread');
    assert.equal(outbox.replyInThread, true);
  });

  it('keeps an existing Lark thread inside that thread', () => {
    const threaded = event('thread', 'thread message', {
      conversationKey: 'default:tenant:oc-chat:thread:omt-topic',
      threadId: 'omt-topic',
      threadRootId: 'om-root',
      rootId: 'om-root',
    });
    store.ingest(threaded);
    const turn = store.claimBatch(threaded.conversationKey, 20);
    const { outbox } = store.createOutboxIfFresh(turn.id, {
      action: 'reply',
      reasonCode: 'continuation',
      deliveryMode: 'reply',
      reply: 'thread answer',
    });
    assert.equal(outbox.deliveryMode, 'thread');
    assert.equal(outbox.replyInThread, true);
  });

  it('persists a standalone chat target selected by the agent', () => {
    const message = event('chat-route');
    store.ingest(message);
    const turn = store.claimBatch(message.conversationKey, 20);
    const { outbox } = store.createOutboxIfFresh(turn.id, {
      action: 'reply',
      reasonCode: 'direct_request',
      deliveryMode: 'chat',
      reply: 'standalone answer',
    });
    assert.equal(outbox.deliveryMode, 'chat');
    assert.equal(outbox.targetChatId, 'oc-chat');
    assert.equal(outbox.replyToMessageId, message.messageId);
    assert.equal(outbox.replyInThread, false);
  });

  it('withholds an old draft when a newer message arrives during a turn', () => {
    store.ingest(event('1'));
    const turn = store.claimBatch(event('1').conversationKey, 20);
    store.ingest(event('2', '不是，我的意思是第二种'));

    const created = store.createOutboxIfFresh(turn.id, {
      action: 'reply',
      reasonCode: 'direct_request',
      deliveryMode: 'reply',
      reply: 'old answer',
    });
    assert.equal(created.stale, true);
    assert.equal(store.pendingOutboxes().length, 0);
    assert.equal(store.getConversation(event('1').conversationKey).pendingDraft.reply, 'old answer');
    assert.equal(store.getConversation(event('1').conversationKey).pendingDraft.deliveryMode, 'reply');
    assert.equal(store.hasQueued(event('1').conversationKey), true);
  });

  it('does not claim unseen overflow messages as part of the freshness snapshot', () => {
    store.ingest(event('1'));
    store.ingest(event('2'));
    const turn = store.claimBatch(event('1').conversationKey, 1);
    const created = store.createOutboxIfFresh(turn.id, {
      action: 'reply',
      reasonCode: 'direct_request',
      deliveryMode: 'reply',
      reply: 'only saw the first message',
    });
    assert.equal(created.stale, true);
    assert.equal(store.hasQueued(event('1').conversationKey), true);
  });

  it('reuses the same idempotency key for a retry', () => {
    store.ingest(event('1'));
    const turn = store.claimBatch(event('1').conversationKey, 20);
    const { outbox } = store.createOutboxIfFresh(turn.id, {
      action: 'reply',
      reasonCode: 'direct_request',
      deliveryMode: 'reply',
      reply: 'answer',
    });
    const first = store.prepareOutboxAttempt(outbox.id, 3_000_000).outbox;
    assert.equal(store.markOutboxFailure(outbox.id, 'temporary', 3), 'RETRY');
    const second = store.prepareOutboxAttempt(outbox.id, 3_000_000).outbox;
    assert.equal(second.idempotencyKey, first.idempotencyKey);
    assert.equal(second.attemptCount, 2);
  });

  it('fails a turn only while it is running', () => {
    store.ingest(event('1'));
    const turn = store.claimBatch(event('1').conversationKey, 20);
    assert.equal(store.failTurn(turn.id, 'first failure'), true);
    assert.equal(store.failTurn(turn.id, 'must not overwrite'), false);
    const row = store.db.prepare('SELECT status, error FROM turns WHERE id = ?').get(turn.id);
    assert.deepEqual({ ...row }, { status: 'DEAD', error: 'first failure' });
  });

  it('never freshness-cancels an outbox already in SENDING', () => {
    store.ingest(event('1'));
    const turn = store.claimBatch(event('1').conversationKey, 20);
    const { outbox } = store.createOutboxIfFresh(turn.id, {
      action: 'reply',
      reasonCode: 'direct_request',
      deliveryMode: 'reply',
      reply: 'answer',
    });
    assert.equal(store.prepareOutboxAttempt(outbox.id, 3_000_000).ready, true);
    store.ingest(event('2', 'newer message'));
    assert.equal(store.cancelOutboxIfStale(outbox.id), false);
    const row = store.db.prepare('SELECT status FROM outbox WHERE id = ?').get(outbox.id);
    assert.equal(row.status, 'SENDING');
    assert.equal(store.getConversation(event('1').conversationKey).pendingDraft, null);
  });

  it('stores one global session shared across chats and clears it durably', () => {
    assert.deepEqual(store.getGlobalSession(), { sessionId: null, policyHash: null });
    store.setGlobalSession('session-abc', 'a'.repeat(64));
    assert.deepEqual(store.getGlobalSession(), { sessionId: 'session-abc', policyHash: 'a'.repeat(64) });

    const databasePath = path.join(directory, 'state.sqlite3');
    store.close();
    store = new Store(databasePath, quietLogger);
    assert.equal(store.getGlobalSession().sessionId, 'session-abc');
    store.clearGlobalSession();
    assert.equal(store.getGlobalSession().sessionId, null);
  });

  it('returns global cross-chat history tagged by chat for a reset session', () => {
    const a = event('a', 'from chat A', { conversationKey: 'default:tenant:oc-a:main', chatId: 'oc-a' });
    const b = event('b', 'from chat B', { conversationKey: 'default:tenant:oc-b:main', chatId: 'oc-b' });
    for (const message of [a, b]) {
      store.ingest(message);
      const turn = store.claimBatch(message.conversationKey, 20);
      const { outbox } = store.createOutboxIfFresh(turn.id, {
        action: 'reply', reasonCode: 'direct_request', deliveryMode: 'chat', reply: `answer ${message.chatId}`,
      });
      store.prepareOutboxAttempt(outbox.id, 3_000_000);
      store.markOutboxSent(outbox.id, `remote-${message.chatId}`);
    }
    const history = store.history(30);
    const chats = new Set(history.map((row) => row.chatId));
    assert.ok(chats.has('oc-a') && chats.has('oc-b'));
    const outbound = history.filter((row) => row.direction === 'outbound');
    assert.ok(outbound.length >= 2);
    assert.deepEqual(store.history(0), []);
  });

  it('migrates legacy reply_in_thread outboxes without changing idempotency keys', () => {
    const replyEvent = event('legacy-reply');
    store.ingest(replyEvent);
    const replyTurn = store.claimBatch(replyEvent.conversationKey, 20);
    const replyOutbox = store.createOutboxIfFresh(replyTurn.id, {
      action: 'reply',
      reasonCode: 'direct_request',
      deliveryMode: 'reply',
      reply: 'legacy reply',
    }).outbox;

    const threadEvent = event('legacy-thread', 'thread', {
      conversationKey: 'default:tenant:oc-thread:main',
      chatId: 'oc-thread',
    });
    store.ingest(threadEvent);
    const threadTurn = store.claimBatch(threadEvent.conversationKey, 20);
    const threadOutbox = store.createOutboxIfFresh(threadTurn.id, {
      action: 'reply',
      reasonCode: 'continuation',
      deliveryMode: 'thread',
      reply: 'legacy thread',
    }).outbox;

    const databasePath = path.join(directory, 'state.sqlite3');
    store.close();
    const legacy = new DatabaseSync(databasePath);
    legacy.exec('ALTER TABLE outbox DROP COLUMN delivery_mode');
    legacy.exec('ALTER TABLE outbox DROP COLUMN target_chat_id');
    legacy.close();

    store = new Store(databasePath, quietLogger);
    const rows = store.db.prepare(`
      SELECT idempotency_key, delivery_mode, target_chat_id FROM outbox ORDER BY id
    `).all();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      {
        idempotency_key: replyOutbox.idempotencyKey,
        delivery_mode: 'reply',
        target_chat_id: 'oc-chat',
      },
      {
        idempotency_key: threadOutbox.idempotencyKey,
        delivery_mode: 'thread',
        target_chat_id: 'oc-thread',
      },
    ]);
  });
});
