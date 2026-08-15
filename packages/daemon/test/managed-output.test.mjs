import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { ManagedAgentOutputPort } from '../src/runtime-output.mjs';
import { Store } from '../src/store.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function inbound(messageId, eventId, content = 'question') {
  return {
    type: 'im.message.receive_v1',
    eventId,
    messageId,
    conversationKey: 'default:tenant:oc_managed123456:main',
    chatId: 'oc_managed123456',
    chatType: 'p2p',
    messageType: 'text',
    senderId: 'ou_sender123456',
    senderType: 'user',
    rootId: null,
    parentId: null,
    threadId: null,
    threadRootId: null,
    content,
    mentions: [],
    createTimeMs: Date.now(),
    raw: {},
  };
}

describe('managed-agent local Lark delivery', { concurrency: false }, () => {
  it('bridges managed text tool calls and supplies protected delivery metadata locally', async () => {
    const calls = [];
    const deliveries = [];
    const service = {
      async listChats() { return { chats: [], count: 0, has_more: false }; },
      async replyMessage(args) {
        calls.push(args);
        return { sent: true, message_id: 'om_bridge_reply123', reply_to_message_id: args.message_id };
      },
      assertFreshDecision() {},
      async close() {},
    };
    const output = new ManagedAgentOutputPort({
      config: {
        larkCliBin: '/fake/lark-cli',
        profile: 'test-profile',
        projectDir: '/tmp',
        databasePath: '/tmp/fake.sqlite3',
        sendTimeoutMs: 5_000,
        maxReplyChars: 30_000,
        dryRun: false,
        tempDir: '/tmp',
      },
      store: {
        getCognitionState: () => ({ runtime: 'volc', authorityToken: 'runtime-token', epoch: 3 }),
        getGlobalSession: () => ({ runtime: 'volc', sessionId: 'sesn-bridge123', epoch: 3 }),
        inboundBySeq: () => ({ messageId: 'om_decision123456', conversationKey: 'chat-a' }),
      },
      logger: quietLogger,
      liveness: { touch() {}, async onDeliverySucceeded(info) { deliveries.push(info); } },
      serviceFactory: () => service,
    });
    const common = {
      inboundSeqs: [9],
      eventId: 'evt-agent-decision',
      runtime: 'volc',
      authorityToken: 'runtime-token',
      sessionId: 'sesn-bridge123',
      cognitionEpoch: 3,
    };

    const read = await output.callTool({
      ...common,
      callId: 'read_1',
      name: 'list_lark_chats',
      arguments: { limit: 5 },
    });
    assert.equal(read.ok, true);
    assert.equal(read.terminal, false);

    const reply = await output.callTool({
      ...common,
      callId: 'reply_1',
      name: 'reply_lark_message',
      arguments: { message_id: 'om_target12345678', text: 'answer' },
    });
    assert.equal(reply.ok, true);
    assert.equal(reply.terminal, true);
    assert.equal(calls[0].decision_message_id, 'om_decision123456');
    assert.equal(calls[0].response_to_message_id, 'om_decision123456');
    assert.match(calls[0].idempotency_key, /^bridge_[a-f0-9]{48}$/);
    assert.deepEqual(deliveries, [{ inboundSeqs: [9], mode: 'lark' }]);
  });

  it('freshness-fences a bridged retraction before the destructive MCP call', async () => {
    const checked = [];
    const retracted = [];
    const output = new ManagedAgentOutputPort({
      config: {
        larkCliBin: '/fake/lark-cli',
        profile: 'test-profile',
        projectDir: '/tmp',
        databasePath: '/tmp/fake.sqlite3',
        sendTimeoutMs: 5_000,
        maxReplyChars: 30_000,
        dryRun: false,
        tempDir: '/tmp',
      },
      store: {
        getCognitionState: () => ({ runtime: 'volc', authorityToken: 'runtime-token', epoch: 3 }),
        getGlobalSession: () => ({ runtime: 'volc', sessionId: 'sesn-bridge123', epoch: 3 }),
        inboundBySeq: () => ({ messageId: 'om_decision123456', conversationKey: 'chat-a' }),
      },
      logger: quietLogger,
      liveness: { touch() {}, async onDeliverySucceeded() {} },
      serviceFactory: () => ({
        assertFreshDecision(messageId) { checked.push(messageId); },
        async retractMessage(args) {
          retracted.push(args.message_id);
          return { retracted: true, message_id: args.message_id };
        },
        async close() {},
      }),
    });

    const result = await output.callTool({
      inboundSeqs: [9],
      callId: 'retract_1',
      name: 'retract_lark_message',
      arguments: { message_id: 'om_target12345678' },
      eventId: 'evt-agent-decision',
      runtime: 'volc',
      authorityToken: 'runtime-token',
      sessionId: 'sesn-bridge123',
      cognitionEpoch: 3,
    });

    assert.equal(result.ok, true);
    assert.equal(result.terminal, true);
    assert.deepEqual(checked, ['om_decision123456']);
    assert.deepEqual(retracted, ['om_target12345678']);
  });

  it('ends a stale bridged retraction without executing it', async () => {
    let retractCalls = 0;
    const output = new ManagedAgentOutputPort({
      config: {
        larkCliBin: '/fake/lark-cli',
        profile: 'test-profile',
        projectDir: '/tmp',
        databasePath: '/tmp/fake.sqlite3',
        sendTimeoutMs: 5_000,
        maxReplyChars: 30_000,
        dryRun: false,
        tempDir: '/tmp',
      },
      store: {
        getCognitionState: () => ({ runtime: 'volc', authorityToken: 'runtime-token', epoch: 3 }),
        getGlobalSession: () => ({ runtime: 'volc', sessionId: 'sesn-bridge123', epoch: 3 }),
        inboundBySeq: () => ({ messageId: 'om_decision123456', conversationKey: 'chat-a' }),
      },
      logger: quietLogger,
      serviceFactory: () => ({
        assertFreshDecision() {
          throw new Error('Delivery blocked: a newer authenticated message arrived in the same chat/thread.');
        },
        async retractMessage() { retractCalls += 1; },
        async close() {},
      }),
    });

    const result = await output.callTool({
      inboundSeqs: [9],
      callId: 'retract_1',
      name: 'retract_lark_message',
      arguments: { message_id: 'om_target12345678' },
      eventId: 'evt-agent-decision',
      runtime: 'volc',
      authorityToken: 'runtime-token',
      sessionId: 'sesn-bridge123',
      cognitionEpoch: 3,
    });

    assert.deepEqual(result, {
      accepted: true,
      ok: false,
      terminal: true,
      suppressed: true,
      reason: 'newer_inbound',
    });
    assert.equal(retractCalls, 0);
  });

  it('uses the authority/freshness journal and blocks a stale cloud response', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-managed-output-'));
    const databasePath = path.join(directory, 'state.sqlite3');
    const cliPath = path.join(directory, 'fake-lark.mjs');
    const logPath = path.join(directory, 'calls.jsonl');
    fs.writeFileSync(cliPath, `#!/usr/bin/env node
      import fs from 'node:fs';
      fs.appendFileSync(process.env.FAKE_MANAGED_LARK_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
      console.log(JSON.stringify({ message_id: 'om_managedreply123' }));
    `, { mode: 0o700 });
    const previousLog = process.env.FAKE_MANAGED_LARK_LOG;
    process.env.FAKE_MANAGED_LARK_LOG = logPath;
    const store = new Store(databasePath, quietLogger);
    store.initializeCognition('volc', 'runtime-token');
    store.setGlobalSession('sesn-managed123456', 'policy-managed', {
      runtime: 'volc',
      epoch: 1,
      syncedThroughSeq: 0,
    });
    const first = store.ingest(inbound('om_managedfirst123', 'evt-managed-first')).inbound;
    const output = new ManagedAgentOutputPort({
      config: {
      larkCliBin: cliPath,
      profile: 'test-profile',
      projectDir: directory,
      databasePath,
      sendTimeoutMs: 5_000,
      maxReplyChars: 30_000,
      dryRun: false,
      tempDir: path.join(directory, 'tmp'),
      },
      store,
      logger: quietLogger,
      liveness: { touch() {}, async onDeliverySucceeded() {} },
    });
    try {
      const result = await output.deliver({
        inboundSeqs: [first.seq],
        text: 'managed answer',
        eventId: 'sevt-managed-final',
        runtime: 'volc',
        authorityToken: 'runtime-token',
        sessionId: 'sesn-managed123456',
        cognitionEpoch: 1,
      });
      assert.equal(result.accepted, true);
      assert.equal(result.delivered, true);
      const args = JSON.parse(fs.readFileSync(logPath, 'utf8').trim());
      assert.ok(args.includes('+messages-reply'));
      assert.equal(args[args.indexOf('--message-id') + 1], 'om_managedfirst123');
      const outbound = store.cognitionJournal().find((row) => row.kind === 'outbound');
      assert.equal(outbound.status, 'COMMITTED');
      assert.equal(outbound.text, 'managed answer');

      const replay = await output.deliver({
        inboundSeqs: [first.seq],
        text: 'managed answer',
        eventId: 'sevt-managed-final',
        runtime: 'volc',
        authorityToken: 'runtime-token',
        sessionId: 'sesn-managed123456',
        cognitionEpoch: 1,
      });
      assert.equal(replay.accepted, true);
      assert.equal(replay.reason, 'delivery_already_committed');
      assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 1);

      store.db.prepare("UPDATE cognition_journal SET status = 'PENDING' WHERE kind = 'outbound'").run();
      await assert.rejects(() => output.deliver({
        inboundSeqs: [first.seq],
        text: 'managed answer',
        eventId: 'sevt-managed-final',
        runtime: 'volc',
        authorityToken: 'runtime-token',
        sessionId: 'sesn-managed123456',
        cognitionEpoch: 1,
      }), /already attempted \(PENDING\)/);
      store.db.prepare("UPDATE cognition_journal SET status = 'UNCERTAIN' WHERE kind = 'outbound'").run();
      const uncertain = await output.deliver({
        inboundSeqs: [first.seq],
        text: 'managed answer',
        eventId: 'sevt-managed-final',
        runtime: 'volc',
        authorityToken: 'runtime-token',
        sessionId: 'sesn-managed123456',
        cognitionEpoch: 1,
      });
      assert.equal(uncertain.accepted, true);
      assert.equal(uncertain.uncertain, true);
      assert.equal(uncertain.reason, 'delivery_uncertain');
      store.db.prepare("UPDATE cognition_journal SET status = 'COMMITTED' WHERE kind = 'outbound'").run();

      store.ingest(inbound('om_managednewer123', 'evt-managed-newer', 'correction'));
      const stale = await output.deliver({
          inboundSeqs: [first.seq],
          text: 'stale answer',
          eventId: 'sevt-managed-stale',
          runtime: 'volc',
          authorityToken: 'runtime-token',
          sessionId: 'sesn-managed123456',
          cognitionEpoch: 1,
        });
      assert.equal(stale.accepted, true);
      assert.equal(stale.suppressed, true);
      assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 1);

      store.initializeCognition('codex', 'replacement-token');
      const fenced = await output.deliver({
        inboundSeqs: [first.seq],
        text: 'late answer',
        eventId: 'sevt-managed-late',
        runtime: 'volc',
        authorityToken: 'runtime-token',
        sessionId: 'sesn-managed123456',
        cognitionEpoch: 1,
      });
      assert.equal(fenced.accepted, true);
      assert.equal(fenced.reason, 'stale_authority');
      assert.equal(fs.readFileSync(logPath, 'utf8').trim().split('\n').length, 1);
    } finally {
      store.close();
      if (previousLog === undefined) delete process.env.FAKE_MANAGED_LARK_LOG;
      else process.env.FAKE_MANAGED_LARK_LOG = previousLog;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
