import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { LarkDaemon } from '../src/daemon.mjs';
import { Store } from '../src/store.mjs';

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return this; },
};

function event(id, content = `message ${id}`, overrides = {}) {
  return {
    type: 'im.message.receive_v1',
    eventId: `evt-${id}`,
    messageId: `om-${id}`,
    conversationKey: `profile:tenant:oc-${id}:main`,
    chatId: `oc-${id}`,
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
    createTimeMs: 1_700_000_000_000,
    raw: {},
    ...overrides,
  };
}

function replyDecision(reply = 'agent answer') {
  return {
    action: 'reply',
    reasonCode: 'direct_request',
    deliveryMode: 'reply',
    reply,
  };
}

function lifecycleToOutbox(store, id, startAt = 1_700_000_000_000) {
  const inboundEvent = event(id);
  assert.equal(store.ingest(inboundEvent, null, startAt).inserted, true);
  const turn = store.claimBatch(inboundEvent.conversationKey, 20, startAt + 1);
  const created = store.createOutboxIfFresh(
    turn.id,
    replyDecision(`answer ${id}`),
    startAt + 2,
  );
  assert.equal(created.stale, false);
  return { inboundEvent, turn, outbox: created.outbox };
}

function request(port, pathname, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const call = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    call.on('error', reject);
    call.end();
  });
}

describe('activity store', { concurrency: false }, () => {
  let directory;
  let databasePath;
  let store;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-daemon-activity-'));
    databasePath = path.join(directory, 'state.sqlite3');
    store = new Store(databasePath, quietLogger);
  });

  afterEach(() => {
    try { store.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('records the live receive-to-send lifecycle exactly once without leaking private transport fields', () => {
    const now = 1_700_000_100_000;
    const inboundEvent = event('private', 'show this user-authored text', {
      conversationKey: 'profile:tenant:oc-private-secret:main',
      chatId: 'oc-private-secret',
      messageId: 'om-private-message',
      eventId: 'evt-private-event',
      raw: { token: 'raw-token-sentinel', body: 'raw-body-sentinel' },
    });

    assert.equal(store.ingest(inboundEvent, null, now).inserted, true);
    assert.equal(store.ingest(inboundEvent, null, now + 1).inserted, false);
    const turn = store.claimBatch(inboundEvent.conversationKey, 20, now + 2);
    const { outbox } = store.createOutboxIfFresh(
      turn.id,
      replyDecision('visible agent answer'),
      now + 3,
    );
    assert.equal(store.prepareOutboxAttempt(outbox.id, 5_000, now + 4).ready, true);
    assert.equal(store.markOutboxSent(outbox.id, 'om-private-remote', now + 5), true);
    assert.equal(store.markOutboxSent(outbox.id, 'om-replayed-remote', now + 6), false);
    assert.equal(store.prepareOutboxAttempt(outbox.id, 5_000, now + 7).ready, false);

    const feed = store.listActivities({ limit: 100 }).activities.reverse();
    assert.deepEqual(feed.map((activity) => activity.kind), [
      'message.received',
      'agent.started',
      'agent.decided',
      'delivery.queued',
      'delivery.attempt',
      'delivery.sent',
    ]);
    assert.equal(new Set(feed.map((activity) => activity.id)).size, feed.length);

    const privateOutbox = store.db.prepare(`
      SELECT idempotency_key, reply_to_message_id, remote_message_id FROM outbox WHERE id = ?
    `).get(outbox.id);
    const serialized = JSON.stringify(feed);
    for (const privateValue of [
      inboundEvent.conversationKey,
      inboundEvent.chatId,
      inboundEvent.messageId,
      inboundEvent.eventId,
      privateOutbox.idempotency_key,
      privateOutbox.reply_to_message_id,
      privateOutbox.remote_message_id,
      'raw-token-sentinel',
      'raw-body-sentinel',
    ]) {
      assert.equal(serialized.includes(privateValue), false, `public activity leaked ${privateValue}`);
    }
    for (const activity of feed) {
      assert.match(activity.conversationRef, /^[a-f0-9]{12}$/);
      assert.match(activity.sourceRef, /^[a-f0-9]{12}$/);
      assert.equal(activity.sourceType, 'group');
      for (const privateKey of [
        'conv_key',
        'conversationKey',
        'chatId',
        'messageId',
        'replyToMessageId',
        'remoteMessageId',
        'idempotencyKey',
        'raw',
        'token',
      ]) {
        assert.equal(Object.hasOwn(activity, privateKey), false);
        assert.equal(Object.hasOwn(activity.metadata, privateKey), false);
      }
    }

    store.recordActivity({
      eventKey: 'privacy:metadata-whitelist',
      kind: 'system.maintenance',
      summary: 'safe',
      metadata: {
        chatId: 'uuid-chat-sentinel',
        eventId: 'uuid-event-sentinel',
        conversationKey: 'uuid-conversation-sentinel',
        reasonCode: 'direct_request',
      },
    });
    const privacy = store.listActivities({ limit: 1 }).activities[0];
    assert.deepEqual(privacy.metadata, { reasonCode: 'direct_request' });
    assert.equal(JSON.stringify(privacy).includes('uuid-'), false);
  });

  it('groups main chat and thread activity under a stable private source reference', () => {
    const now = 1_700_000_150_000;
    const main = event('source-main', 'main message', {
      chatId: 'oc-shared-private-source',
      chatType: 'p2p',
      conversationKey: 'profile:tenant:oc-shared-private-source:main',
    });
    const thread = event('source-thread', 'thread message', {
      chatId: 'oc-shared-private-source',
      chatType: 'p2p',
      conversationKey: 'profile:tenant:oc-shared-private-source:thread:omt-private-thread',
      threadId: 'omt-private-thread',
    });
    const other = event('source-other', 'other message', {
      chatId: 'oc-other-private-source',
      conversationKey: 'profile:tenant:oc-other-private-source:main',
    });
    const mainResult = store.ingest(main, 'ambient', now);
    const threadResult = store.ingest(thread, 'ambient', now + 1);
    const otherResult = store.ingest(other, 'ambient', now + 2);

    const rows = store.listActivities({ limit: 20 }).activities;
    const byInbound = (seq, activityRows = rows) => (
      activityRows.find((row) => row.inboundSeq === seq)
    );
    const mainActivity = byInbound(mainResult.inbound.seq);
    const threadActivity = byInbound(threadResult.inbound.seq);
    const otherActivity = byInbound(otherResult.inbound.seq);
    assert.ok(mainActivity && threadActivity && otherActivity);
    assert.equal(mainActivity.sourceRef, threadActivity.sourceRef);
    assert.notEqual(mainActivity.conversationRef, threadActivity.conversationRef);
    assert.notEqual(mainActivity.sourceRef, otherActivity.sourceRef);
    assert.equal(mainActivity.sourceType, 'p2p');
    assert.equal(otherActivity.sourceType, 'group');
    assert.match(mainActivity.sourceRef, /^[a-f0-9]{12}$/);
    assert.equal(JSON.stringify(rows).includes('oc-shared-private-source'), false);

    const sourceRef = mainActivity.sourceRef;
    const removed = store.prune(1, now + 10);
    assert.ok(removed.inbound > 0);
    assert.equal(
      byInbound(mainResult.inbound.seq, store.listActivities({ limit: 20 }).activities).sourceRef,
      sourceRef,
    );
    store.close();
    store = new Store(databasePath, quietLogger);
    assert.equal(
      byInbound(mainResult.inbound.seq, store.listActivities({ limit: 20 }).activities).sourceRef,
      sourceRef,
    );
  });

  it('persists a resolved group name on old and new activity without exposing its chat id', () => {
    const now = 1_700_000_175_000;
    const chatId = 'oc-private-source-name-sentinel';
    const group = event('named-group', 'hello from the group', {
      chatId,
      conversationKey: `profile:tenant:${chatId}:main`,
    });
    const result = store.ingest(group, null, now);
    assert.equal(result.inserted, true);
    assert.equal(store.listActivities({ limit: 10 }).activities[0].sourceName, null);

    assert.equal(store.saveChatSourceName(chatId, '日常协作群', now + 86_400_000, now + 1), true);
    store.recordActivity({
      eventKey: 'named-group:after-resolution',
      kind: 'system.maintenance',
      conversationKey: group.conversationKey,
      sourceType: 'group',
      summary: 'after name resolution',
      occurredAtMs: now + 2,
    });
    let activities = store.listActivities({ limit: 10 }).activities;
    assert.equal(activities.every((activity) => activity.sourceName === '日常协作群'), true);
    assert.equal(JSON.stringify(activities).includes(chatId), false);

    store.close();
    store = new Store(databasePath, quietLogger);
    activities = store.listActivities({ limit: 10 }).activities;
    assert.equal(activities.every((activity) => activity.sourceName === '日常协作群'), true);
    assert.equal(JSON.stringify(activities).includes(chatId), false);
  });

  it('closes stale subscriber lifecycle rows so only the current listener is running', () => {
    for (let index = 1; index <= 3; index += 1) {
      store.closeRunningSubscriberActivities();
      store.recordActivity({
        eventKey: `run:${index}:subscriber-started`,
        kind: 'system.subscriber_started',
        status: 'RUNNING',
        summary: '正在接收飞书消息事件',
        occurredAtMs: index,
      }, index);
    }
    const rows = store.listActivities({ limit: 10 }).activities
      .filter((row) => row.kind === 'system.subscriber_started');
    assert.equal(rows.filter((row) => row.status === 'RUNNING').length, 1);
    assert.equal(rows.filter((row) => row.status === 'STOPPED').length, 2);
    assert.equal(rows.every((row) => row.sourceRef === 'system'), true);
  });

  it('assigns attention priority and durable status to ignored, silent, failed, retry, and uncertain paths', () => {
    const base = 1_700_000_200_000;

    const ignored = event('ignored', 'ignored-private-body');
    store.ingest(ignored, 'unsupported_message_type', base);

    const silentEvent = event('silent');
    store.ingest(silentEvent, null, base + 10);
    const silentTurn = store.claimBatch(silentEvent.conversationKey, 20, base + 11);
    assert.equal(store.completeSilent(silentTurn.id, {
      action: 'ignore',
      reasonCode: 'ack',
      deliveryMode: 'reply',
      reply: '',
    }, base + 12), true);

    const failedEvent = event('agent-failed');
    store.ingest(failedEvent, null, base + 20);
    const failedTurn = store.claimBatch(failedEvent.conversationKey, 20, base + 21);
    assert.equal(store.failTurn(failedTurn.id, 'Codex process exited', base + 22), true);

    const retry = lifecycleToOutbox(store, 'retry-failed', base + 30);
    store.prepareOutboxAttempt(retry.outbox.id, 5_000, base + 33);
    assert.equal(store.markOutboxFailure(retry.outbox.id, 'temporary failure', 2, base + 34), 'RETRY');
    store.prepareOutboxAttempt(retry.outbox.id, 5_000, base + 35);
    assert.equal(store.markOutboxFailure(retry.outbox.id, 'permanent failure', 2, base + 36), 'FAILED');

    const uncertain = lifecycleToOutbox(store, 'uncertain', base + 40);
    store.prepareOutboxAttempt(uncertain.outbox.id, 100, base + 43);
    const uncertainResult = store.prepareOutboxAttempt(uncertain.outbox.id, 100, base + 144);
    assert.equal(uncertainResult.ready, false);
    assert.equal(uncertainResult.uncertain, true);

    const activities = store.listActivities({ limit: 100 }).activities;
    const activity = (kind) => {
      const found = activities.find((candidate) => candidate.kind === kind);
      assert.ok(found, `missing ${kind}`);
      return found;
    };
    assert.deepEqual(
      ['severity', 'priority', 'status'].map((key) => activity('message.ignored')[key]),
      ['info', 20, 'RULE_IGNORED'],
    );
    assert.deepEqual(
      ['severity', 'priority', 'status'].map((key) => activity('agent.silent')[key]),
      ['info', 25, 'SILENT'],
    );
    assert.deepEqual(
      ['severity', 'priority', 'status'].map((key) => activity('agent.failed')[key]),
      ['error', 95, 'DEAD'],
    );
    assert.deepEqual(
      ['severity', 'priority', 'status'].map((key) => activity('delivery.retry')[key]),
      ['warn', 78, 'RETRY'],
    );
    assert.deepEqual(
      ['severity', 'priority', 'status'].map((key) => activity('delivery.failed')[key]),
      ['error', 100, 'FAILED'],
    );
    assert.deepEqual(
      ['severity', 'priority', 'status'].map((key) => activity('delivery.uncertain')[key]),
      ['error', 100, 'UNCERTAIN'],
    );
    assert.equal(JSON.stringify(activities).includes('ignored-private-body'), false);
    assert.equal(store.activityOverview(base + 200).attention, 3);
  });

  it('backfills a legacy database once and remains idempotent across repeated opens', () => {
    const lifecycle = lifecycleToOutbox(store, 'legacy', 1_600_000_000_000);
    store.prepareOutboxAttempt(lifecycle.outbox.id, 5_000, 1_600_000_000_003);
    store.markOutboxSent(lifecycle.outbox.id, 'om-legacy-remote', 1_600_000_000_004);
    store.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec('DROP TABLE activities');
    legacy.close();

    store = new Store(databasePath, quietLogger);
    const first = store.listActivities({ limit: 100 }).activities;
    const firstCount = store.stats().activities;
    assert.equal(firstCount, 5);
    assert.deepEqual(first.toReversed().map((item) => item.kind), [
      'message.received',
      'agent.started',
      'agent.decided',
      'delivery.queued',
      'delivery.sent',
    ]);
    assert.deepEqual(first.map((item) => item.kind).sort(), [
      'agent.decided',
      'agent.started',
      'delivery.queued',
      'delivery.sent',
      'message.received',
    ].sort());
    assert.equal(first.every((item) => item.metadata.backfilled === true), true);

    store.close();
    store = new Store(databasePath, quietLogger);
    assert.equal(store.stats().activities, firstCount);
    assert.deepEqual(
      store.listActivities({ limit: 100 }).activities.map((item) => item.id),
      first.map((item) => item.id),
    );

    store.close();
    store = new Store(databasePath, quietLogger);
    assert.equal(store.stats().activities, firstCount);
  });

  it('uses a stable keyset cursor when a newer activity arrives between pages', () => {
    for (let index = 1; index <= 5; index += 1) {
      assert.equal(store.recordActivity({
        eventKey: `manual:${index}`,
        kind: 'system.maintenance',
        summary: `old ${index}`,
        occurredAtMs: index,
      }, index), true);
    }
    const oldIds = store.db.prepare('SELECT id FROM activities ORDER BY id DESC')
      .all()
      .map((row) => Number(row.id));

    const firstPage = store.listActivities({ limit: 2 });
    assert.deepEqual(firstPage.activities.map((item) => item.id), oldIds.slice(0, 2));
    assert.equal(store.recordActivity({
      eventKey: 'manual:new-arrival',
      kind: 'system.ready',
      summary: 'new arrival',
      occurredAtMs: 10,
    }, 10), true);

    const seen = [...firstPage.activities.map((item) => item.id)];
    let cursor = firstPage.nextCursor;
    while (cursor !== null) {
      const page = store.listActivities({ limit: 2, beforeId: cursor });
      seen.push(...page.activities.map((item) => item.id));
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, oldIds);
    assert.equal(new Set(seen).size, oldIds.length);
  });

  it('keeps the append-only activity history when operational rows are pruned', () => {
    const lifecycle = lifecycleToOutbox(store, 'old', 1_000);
    store.prepareOutboxAttempt(lifecycle.outbox.id, 5_000, 1_003);
    store.markOutboxSent(lifecycle.outbox.id, 'om-old-remote', 1_004);
    const before = store.listActivities({ limit: 100 }).activities;

    const removed = store.prune(1_000, 10_000);
    assert.ok(removed.inbound > 0);
    assert.ok(removed.outbox > 0);
    assert.ok(removed.turns > 0);
    assert.equal(store.stats().activities, before.length);
    assert.deepEqual(
      store.listActivities({ limit: 100 }).activities.map((item) => item.id),
      before.map((item) => item.id),
    );
  });
});

describe('daemon activity API', { concurrency: false }, () => {
  let directory;
  let daemon;
  let port;

  beforeEach(async () => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-daemon-activity-http-'));
    daemon = new LarkDaemon({
      projectDir,
      host: '127.0.0.1',
      port: 0,
    }, quietLogger);
    daemon.store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
    daemon.lark = { subscriptionRunning: true };
    daemon.ready = true;
    daemon.store.recordActivity({
      eventKey: 'http:test',
      kind: 'system.ready',
      summary: 'dashboard is ready',
      conversationKey: 'profile:tenant:oc-http-private:main',
      status: 'READY',
    });
    await daemon.startHttpServer();
    port = daemon.httpServer.address().port;
  });

  afterEach(async () => {
    if (daemon?.httpServer?.listening) {
      await new Promise((resolve) => daemon.httpServer.close(resolve));
    }
    try { daemon?.store?.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('serves only the private activity API and health endpoints with strict response headers', async () => {
    const page = await request(port, '/');
    assert.equal(page.status, 404);

    const css = await request(port, '/activity.css');
    assert.equal(css.status, 404);
    const javascript = await request(port, '/activity.js');
    assert.equal(javascript.status, 404);

    const api = await request(port, '/api/activity?limit=1');
    assert.equal(api.status, 200);
    assert.match(api.headers['content-type'], /^application\/json/);
    assert.equal(api.headers['cache-control'], 'no-store');
    assert.match(api.headers['content-security-policy'], /default-src 'self'/);
    assert.equal(api.headers['x-content-type-options'], 'nosniff');
    assert.equal(api.headers['referrer-policy'], 'no-referrer');
    const payload = JSON.parse(api.body);
    assert.equal(payload.service.ready, true);
    assert.equal(payload.service.subscriber, 'running');
    assert.equal(payload.activities.length, 1);
    assert.equal(payload.activities[0].kind, 'system.ready');
    assert.match(payload.activities[0].conversationRef, /^[a-f0-9]{12}$/);
    assert.equal(api.body.includes('profile:tenant:oc-http-private:main'), false);
  });

  it('rejects invalid queries, path traversal, non-loopback hosts, and cross-origin requests', async () => {
    for (const pathname of [
      '/api/activity?limit=0',
      '/api/activity?limit=1000',
      '/api/activity?before=nope',
      '/api/activity?limit=1&limit=2',
      '/api/activity?unknown=1',
    ]) {
      const response = await request(port, pathname);
      assert.equal(response.status, 400, pathname);
      assert.equal(response.headers['cache-control'], 'no-store');
    }

    assert.equal((await request(port, '/%2e%2e/package.json')).status, 404);
    assert.equal((await request(port, '/', { headers: { host: 'example.test' } })).status, 403);
    assert.equal((await request(port, '/', {
      headers: { origin: `http://localhost:${port}` },
    })).status, 403);
    const method = await request(port, '/', { method: 'POST' });
    assert.equal(method.status, 405);
    assert.equal(method.headers.allow, 'GET');
  });

  it('returns a private 500 without stopping the daemon when an API read fails', async () => {
    const original = daemon.store.listActivities;
    daemon.store.listActivities = () => { throw new Error('private database detail'); };
    const failed = await request(port, '/api/activity');
    assert.equal(failed.status, 500);
    assert.deepEqual(JSON.parse(failed.body), { error: 'internal_error' });
    assert.equal(failed.body.includes('private database detail'), false);
    assert.equal(daemon.ready, true);

    daemon.store.listActivities = original.bind(daemon.store);
    const ready = await request(port, '/ready');
    assert.equal(ready.status, 200);
  });
});
