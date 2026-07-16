import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkDaemon } from '../src/daemon.mjs';

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return this; },
};

function daemonHarness(source, getChatName) {
  const saved = [];
  const deferred = [];
  const daemon = new LarkDaemon({}, quietLogger);
  daemon.lark = { profile: 'test-profile', getChatName };
  daemon.store = {
    chatNameLookupCandidate(chatId) {
      return chatId === source.chatId ? source : null;
    },
    dueChatNameLookups() {
      return [source];
    },
    saveChatSourceName(...args) {
      saved.push(args);
      return true;
    },
    deferChatSourceName(...args) {
      deferred.push(args);
      return true;
    },
  };
  return { daemon, saved, deferred };
}

describe('non-blocking group name enrichment', () => {
  it('deduplicates an in-flight lookup and persists a successful result', async () => {
    const source = {
      chatId: 'oc-private-source',
      sourceRef: 'opaque-source',
      chatType: 'group',
      failureCount: 0,
    };
    let finish;
    let calls = 0;
    const { daemon, saved, deferred } = daemonHarness(source, () => {
      calls += 1;
      return new Promise((resolve) => { finish = resolve; });
    });

    assert.equal(daemon.scheduleChatNameLookup(source.chatId), true);
    assert.equal(daemon.scheduleChatNameLookup(source.chatId), false);
    assert.equal(calls, 1);
    const lookup = daemon.chatNameLookups.get(source.chatId);
    finish('研发同步群');
    await lookup;

    assert.equal(saved.length, 1);
    assert.equal(saved[0][0], source.chatId);
    assert.equal(saved[0][1], '研发同步群');
    assert.ok(saved[0][2] > saved[0][3]);
    assert.equal(deferred.length, 0);
    assert.equal(daemon.chatNameLookups.size, 0);
  });

  it('turns permission or network failure into bounded retry state', async () => {
    const source = {
      chatId: 'oc-retry-source',
      sourceRef: 'opaque-retry',
      chatType: 'group',
      failureCount: 2,
    };
    const { daemon, saved, deferred } = daemonHarness(source, async () => {
      throw new Error('permission denied');
    });
    const before = Date.now();
    assert.equal(daemon.scheduleChatNameLookup(source.chatId), true);
    await daemon.chatNameLookups.get(source.chatId);

    assert.equal(saved.length, 0);
    assert.equal(deferred.length, 1);
    assert.equal(deferred[0][0], source.chatId);
    assert.equal(deferred[0][1], 'RETRY');
    assert.ok(deferred[0][2] >= before + (20 * 60 * 1_000));
    assert.ok(deferred[0][2] <= before + (20 * 60 * 1_000) + 1_000);
  });

  it('scans due sources so migrated chats are retried without a new message', async () => {
    const source = {
      chatId: 'oc-migrated-source',
      sourceRef: 'opaque-migrated',
      chatType: 'group',
      failureCount: 0,
    };
    const { daemon, saved } = daemonHarness(source, async () => '历史群聊');
    daemon.refreshChatNames();
    await daemon.chatNameLookups.get(source.chatId);
    assert.equal(saved[0][1], '历史群聊');
  });
});
