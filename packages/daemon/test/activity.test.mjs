import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { LarkDaemon } from '../src/daemon.mjs';
import { startHttpApi } from '../src/http-api.mjs';
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

  it('records message.received once, deduplicated, without leaking private ids or raw fields', () => {
    const now = 1_700_000_100_000;
    const inbound = event('private', 'show this user-authored text', {
      conversationKey: 'profile:tenant:oc-private-secret:main',
      chatId: 'oc-private-secret',
      messageId: 'om-private-message',
      eventId: 'evt-private-event',
      raw: { token: 'raw-token-sentinel' },
    });
    assert.equal(store.ingest(inbound, null, now).inserted, true);
    assert.equal(store.ingest(inbound, null, now + 1).inserted, false);

    const feed = store.listActivities({ limit: 100 }).activities;
    assert.deepEqual(feed.map((a) => a.kind), ['message.received']);
    const received = feed[0];
    assert.equal(received.summary, 'show this user-authored text');
    assert.match(received.conversationRef, /^[a-f0-9]{12}$/);

    const serialized = JSON.stringify(feed);
    for (const secret of [
      inbound.conversationKey, inbound.chatId, inbound.messageId, inbound.eventId, 'raw-token-sentinel',
    ]) {
      assert.equal(serialized.includes(secret), false, `leaked ${secret}`);
    }

    store.recordActivity({
      eventKey: 'privacy:metadata-whitelist',
      kind: 'system.maintenance',
      summary: 'safe',
      metadata: {
        chatId: 'uuid-chat-sentinel',
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

  it('publishes compact tool metadata while keeping tool arguments and Lark ids private', () => {
    const incoming = event('tool-source', 'run a tool', {
      messageId: 'om-tool-target-private',
      chatId: 'oc-tool-chat-private',
      conversationKey: 'profile:tenant:oc-tool-chat-private:main',
    });
    const result = store.ingest(incoming, null, 1_700_000_180_000);
    assert.equal(store.inboundSeqForMessageId(incoming.messageId), result.inbound.seq);
    store.recordActivity({
      eventKey: 'codex:tool:completed',
      kind: 'agent.tool',
      turnId: 'turn-app-server-1',
      inboundSeq: result.inbound.seq,
      status: 'COMPLETED',
      summary: 'openviking · read_resource',
      metadata: {
        itemType: 'mcpToolCall',
        toolLabel: 'openviking · read_resource',
        toolName: 'read_resource',
        toolServer: 'openviking',
        toolStatus: 'completed',
        durationMs: 42,
        toolError: 'failed for viking://private/sentinel',
        arguments: { uri: 'viking://private/sentinel' },
      },
    }, 1_700_000_180_042);

    const tool = store.listActivities({ limit: 10 }).activities
      .find((activity) => activity.kind === 'agent.tool');
    assert.ok(tool);
    assert.equal(tool.turnId, 'turn-app-server-1');
    assert.equal(tool.sourceType, 'group');
    assert.deepEqual(tool.metadata, {
      durationMs: 42,
      itemType: 'mcpToolCall',
      toolLabel: 'openviking · read_resource',
      toolName: 'read_resource',
      toolServer: 'openviking',
      toolStatus: 'completed',
    });
    const serialized = JSON.stringify(tool);
    assert.doesNotMatch(serialized, /viking:\/\/private|om-tool-target|oc-tool-chat/);
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

  it('marks a filtered message ignored with its reason and blanks the body', () => {
    const ignored = event('ignored', 'ignored-private-body');
    store.ingest(ignored, 'unsupported_message_type', 1_700_000_200_000);
    const activities = store.listActivities({ limit: 100 }).activities;
    const found = activities.find((a) => a.kind === 'message.ignored');
    assert.ok(found);
    assert.deepEqual(
      ['severity', 'priority', 'status'].map((key) => found[key]),
      ['info', 20, 'RULE_IGNORED'],
    );
    assert.equal(JSON.stringify(activities).includes('ignored-private-body'), false);
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

  it('keeps the append-only activity history when inbound rows are pruned', () => {
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

  it('backfills inbound activities once and stays idempotent across reopens', () => {
    store.ingest(event('legacy', 'legacy body'), null, 1_600_000_000_000);
    store.close();

    const legacy = new DatabaseSync(databasePath);
    legacy.exec('DROP TABLE activities');
    legacy.close();

    store = new Store(databasePath, quietLogger);
    const first = store.listActivities({ limit: 100 }).activities;
    assert.deepEqual(first.map((item) => item.kind), ['message.received']);
    assert.equal(first.every((item) => item.metadata.backfilled === true), true);
    const firstCount = store.stats().activities;

    store.close();
    store = new Store(databasePath, quietLogger);
    assert.equal(store.stats().activities, firstCount);
    assert.deepEqual(
      store.listActivities({ limit: 100 }).activities.map((item) => item.id),
      first.map((item) => item.id),
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
    daemon.httpServer = await startHttpApi({
      config: daemon.config,
      store: daemon.store,
      logger: quietLogger,
      serviceSnapshot: (options) => daemon.serviceSnapshot(options),
    });
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
