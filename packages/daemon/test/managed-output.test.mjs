import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LarkDaemon } from '../src/daemon.mjs';
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
    const daemon = new LarkDaemon({
      lockPath: path.join(directory, 'daemon.lock'),
      larkCliBin: cliPath,
      profile: 'test-profile',
      projectDir: directory,
      databasePath,
      sendTimeoutMs: 5_000,
      maxReplyChars: 30_000,
      dryRun: false,
      tempDir: path.join(directory, 'tmp'),
    }, quietLogger);
    daemon.store = store;
    daemon.liveness = { touch() {}, async onDeliverySucceeded() {} };
    try {
      const result = await daemon.deliverManagedAgentOutput({
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

      const replay = await daemon.deliverManagedAgentOutput({
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
      await assert.rejects(() => daemon.deliverManagedAgentOutput({
        inboundSeqs: [first.seq],
        text: 'managed answer',
        eventId: 'sevt-managed-final',
        runtime: 'volc',
        authorityToken: 'runtime-token',
        sessionId: 'sesn-managed123456',
        cognitionEpoch: 1,
      }), /already attempted \(PENDING\)/);
      store.db.prepare("UPDATE cognition_journal SET status = 'UNCERTAIN' WHERE kind = 'outbound'").run();
      const uncertain = await daemon.deliverManagedAgentOutput({
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
      const stale = await daemon.deliverManagedAgentOutput({
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
      const fenced = await daemon.deliverManagedAgentOutput({
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
