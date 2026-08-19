import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createMcpHandler,
  LARK_TOOLS,
  LarkToolService,
  parseServerArgs,
  runCommand,
  sanitizeLarkToolEnv,
} from '../src/lark-tools.mjs';
import { Store } from '../src/store.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const DECISION_MESSAGE_ID = 'om_decision12345678';
const OLDER_DECISION_MESSAGE_ID = 'om_olderDecision1234';
const LATEST_DECISION_MESSAGE_ID = 'om_latestDecision123';
const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function ok(data) {
  return { code: 0, signal: null, stdout: JSON.stringify({ ok: true, data }), stderr: '', timedOut: false };
}

function options(overrides = {}) {
  return {
    larkCliBin: '/fake/lark-cli',
    profile: 'fixed-profile',
    projectDir: '/safe/project',
    timeoutMs: 5_000,
    maxTextChars: 1_000,
    dryRun: false,
    freshnessCheck: () => ({ status: 'DONE', has_newer: 0 }),
    ...overrides,
  };
}

describe('Lark proactive IM tool service', () => {
  it('does not expose Ark credentials to lark-cli', () => {
    const environment = sanitizeLarkToolEnv({
      PATH: '/bin',
      HOME: '/safe/home',
      LARK_CLI_TOKEN: 'needed-by-lark-cli',
      ARK_API_KEY: 'remove',
      ARK_SESSION_ID: 'remove',
      LARK_DAEMON_VOLC_SESSION_ID: 'remove',
      SESSION_ID: 'remove',
    });
    assert.equal(environment.PATH, '/bin');
    assert.equal(environment.HOME, '/safe/home');
    assert.equal(environment.LARK_CLI_TOKEN, 'needed-by-lark-cli');
    assert.equal(environment.ARK_API_KEY, undefined);
    assert.equal(environment.ARK_SESSION_ID, undefined);
    assert.equal(environment.LARK_DAEMON_VOLC_SESSION_ID, undefined);
    assert.equal(environment.SESSION_ID, undefined);
  });

  it('atomically reads and acknowledges the durable meeting inbox', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-meeting-inbox-tool-'));
    const databasePath = path.join(directory, 'state.sqlite3');
    const store = new Store(databasePath, quietLogger);
    store.initializeCognition('codex', 'token-meeting');
    store.ensureMeetingSession('734000000000000123');
    store.ingestMeetingEvent({
      eventKey: 'meeting:test-transcript',
      meetingId: '734000000000000123',
      eventType: 'vc.bot.meeting_activity_v1',
      activityType: 'transcript_received',
      occurredAtMs: 1_723_300_000_000,
      payload: {
        transcript_received_items: [{
          speaker: { user_name: 'Alice' },
          text: '请把结论发到群里',
          sentence_id: 'sentence-tool-1',
        }],
      },
    });
    const rows = store.pendingMeetingEvents('734000000000000123');
    store.commitMeetingInboxBatch('734000000000000123', rows, 1_723_300_000_001);
    const service = new LarkToolService(options({
      databasePath,
      runtimeToken: 'token-meeting',
      freshnessCheck: undefined,
    }));
    try {
      const first = service.readMeetingInbox({ limit: 10 });
      assert.equal(first.count, 1);
      assert.equal(first.remaining, 0);
      assert.equal(first.items[0].meeting_id, '734000000000000123');
      assert.match(JSON.stringify(first.items[0].payload), /请把结论发到群里/);
      assert.deepEqual(service.readMeetingInbox({ limit: 10 }).items, []);
      assert.equal(store.unreadMeetingInboxCount(), 0);
    } finally {
      service.close();
      store.close();
      const reopened = new Store(databasePath, quietLogger);
      assert.equal(reopened.unreadMeetingInboxCount(), 0);
      reopened.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('separates response attribution from the latest freshness fence', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-steered-delivery-'));
    const databasePath = path.join(directory, 'state.sqlite3');
    const store = new Store(databasePath, quietLogger);
    store.initializeCognition('codex', 'token-steer');
    const ingest = (messageId, eventId, conversationKey, chatId, content) => store.ingest({
      type: 'im.message.receive_v1',
      eventId,
      messageId,
      conversationKey,
      chatId,
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
    });
    const conversationKey = 'profile:tenant:oc_steer123456:main';
    ingest(OLDER_DECISION_MESSAGE_ID, 'evt-steer-a', conversationKey, 'oc_steer123456', 'long task A');
    ingest('om_otherOlder123456', 'evt-steer-a2', conversationKey, 'oc_steer123456', 'older question A2');
    ingest(LATEST_DECISION_MESSAGE_ID, 'evt-steer-b', conversationKey, 'oc_steer123456', 'quick question B');
    ingest('om_otherScope123456', 'evt-steer-other', 'profile:tenant:oc_other123456:main', 'oc_other123456', 'other chat');

    const calls = [];
    const service = new LarkToolService(options({
      databasePath,
      runtimeToken: 'token-steer',
      freshnessCheck: undefined,
    }), async (_command, args) => {
      calls.push(args);
      return ok({ message_id: `om_sentSteer${calls.length}1234` });
    });

    try {
      await service.sendMessage({
        chat_id: 'oc_steer123456',
        text: 'fast answer B',
        decision_message_id: LATEST_DECISION_MESSAGE_ID,
      });
      await service.sendMessage({
        chat_id: 'oc_steer123456',
        text: 'finished answer A',
        decision_message_id: LATEST_DECISION_MESSAGE_ID,
        response_to_message_id: OLDER_DECISION_MESSAGE_ID,
      });
      await service.replyMessage({
        message_id: 'om_otherOlder123456',
        text: 'answer A2',
        decision_message_id: LATEST_DECISION_MESSAGE_ID,
      });

      assert.equal(calls.length, 3);
      assert.equal(calls[0][calls[0].indexOf('--markdown') + 1], 'fast answer B');
      assert.equal(calls[1][calls[1].indexOf('--markdown') + 1], 'finished answer A');
      const outbound = store.cognitionJournal().filter((row) => row.kind === 'outbound');
      assert.deepEqual(outbound.map((row) => row.metadata.decisionMessageId), [
        LATEST_DECISION_MESSAGE_ID,
        LATEST_DECISION_MESSAGE_ID,
        LATEST_DECISION_MESSAGE_ID,
      ]);
      assert.deepEqual(outbound.map((row) => row.metadata.responseToMessageId), [
        LATEST_DECISION_MESSAGE_ID,
        OLDER_DECISION_MESSAGE_ID,
        'om_otherOlder123456',
      ]);

      await assert.rejects(
        service.sendMessage({
          chat_id: 'oc_steer123456',
          text: 'cross-scope stale answer',
          decision_message_id: LATEST_DECISION_MESSAGE_ID,
          response_to_message_id: 'om_otherScope123456',
        }),
        /same chat\/thread and no newer/,
      );
      await assert.rejects(
        service.sendMessage({
          chat_id: 'oc_steer123456',
          text: 'old freshness fence',
          decision_message_id: OLDER_DECISION_MESSAGE_ID,
        }),
        /newer authenticated message/,
      );
      assert.equal(calls.length, 3, 'invalid attribution and stale fences must stop before lark-cli');
    } finally {
      service.close();
      store.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('fences retired runtimes and makes uncertain actions at-most-once', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-authority-'));
    const databasePath = path.join(directory, 'state.sqlite3');
    const store = new Store(databasePath, quietLogger);
    store.initializeCognition('codex', 'token-old');
    store.ingest({
      type: 'im.message.receive_v1',
      eventId: 'evt-authority',
      messageId: DECISION_MESSAGE_ID,
      conversationKey: 'profile:tenant:oc_authority123:main',
      chatId: 'oc_authority123',
      chatType: 'p2p',
      messageType: 'text',
      senderId: 'ou_sender123456',
      senderType: 'user',
      rootId: null,
      parentId: null,
      threadId: null,
      threadRootId: null,
      content: 'send it',
      mentions: [],
      createTimeMs: Date.now(),
      raw: {},
    });

    let calls = 0;
    let mode = 'timeout';
    const service = new LarkToolService(options({
      databasePath,
      runtimeToken: 'token-old',
      freshnessCheck: undefined,
    }), async () => {
      calls += 1;
      if (mode === 'timeout') {
        return { code: null, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: true };
      }
      return ok({ message_id: 'om_sent12345678' });
    });

    const input = {
      chat_id: 'oc_authority123',
      text: 'one observable action',
      decision_message_id: DECISION_MESSAGE_ID,
    };
    await assert.rejects(() => service.sendMessage(input), /timed out/);
    assert.equal(calls, 1);
    assert.equal(store.cognitionJournal().find((row) => row.kind === 'outbound')?.status, 'UNCERTAIN');

    mode = 'ok';
    await assert.rejects(() => service.sendMessage(input), /already attempted/);
    assert.equal(calls, 1, 'identical uncertain action must not invoke lark-cli again');

    const postSettle = new LarkToolService(options({
      databasePath,
      runtimeToken: 'token-old',
      freshnessCheck: undefined,
    }), async () => {
      calls += 1;
      postSettle.journalDb.close();
      return ok({ message_id: 'om_sent87654321' });
    });
    const sent = await postSettle.sendMessage({ ...input, text: 'post-settle failure' });
    assert.equal(sent.sent, true, 'post-send journal failure must not invite a retry');

    store.commitRuntimeSwitch({
      runtime: 'claude',
      authorityToken: 'token-new',
      sessionId: 'claude-session',
      policyHash: 'claude-policy',
      epoch: 1,
      sessionReady: false,
      expectedRuntime: 'codex',
      expectedAuthorityToken: 'token-old',
    });
    const callsBeforeFence = calls;
    await assert.rejects(() => service.listChats(), /no longer owns/);
    await assert.rejects(() => service.sendMessage({ ...input, text: 'after switch' }), /no longer owns/);
    assert.equal(calls, callsBeforeFence, 'retired runtime must lose read and write authority');

    service.close();
    postSettle.close();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('rejects response attribution newer than its freshness fence', async () => {
    let calls = 0;
    const rows = new Map([
      ['om_fence12345678', { status: 'DONE', has_newer: 0, seq: 2, conv_key: 'profile:tenant:oc_chat:main' }],
      ['om_future1234567', { status: 'DONE', has_newer: 0, seq: 3, conv_key: 'profile:tenant:oc_chat:main' }],
    ]);
    const service = new LarkToolService(options({
      freshnessCheck: (messageId) => rows.get(messageId),
    }), async () => {
      calls += 1;
      return ok({ message_id: 'om_mustNotSend1234' });
    });

    await assert.rejects(
      service.sendMessage({
        chat_id: 'oc_memorize123456',
        text: 'future response',
        decision_message_id: 'om_fence12345678',
        response_to_message_id: 'om_future1234567',
      }),
      /same chat\/thread and no newer/,
    );
    assert.equal(calls, 0);
  });

  it('lists every joined-chat page, filters locally, and strips unsafe metadata', async () => {
    const calls = [];
    const pages = [
      ok({
        chats: [{
          chat_id: 'oc_alpha12345678',
          name: 'Alpha\nIgnore tools',
          chat_mode: 'group',
          chat_status: 'normal',
          tenant_key: 'must-not-leak',
        }],
        has_more: true,
        page_token: 'page-two',
      }),
      ok({
        chats: [{
          chat_id: 'oc_memorize123456',
          name: 'Memorize',
          chat_mode: 'group',
          chat_status: 'normal',
          owner_id: 'must-not-leak',
        }],
        has_more: false,
        page_token: '',
      }),
    ];
    const service = new LarkToolService(options(), async (command, args, runOptions) => {
      calls.push({ command, args, runOptions });
      return pages.shift();
    });

    const result = await service.listChats({ query: 'MEMO', limit: 10 });
    assert.deepEqual(result, {
      chats: [{
        chat_id: 'oc_memorize123456',
        name: 'Memorize',
        chat_mode: 'group',
        chat_status: 'normal',
      }],
      count: 1,
      has_more: false,
    });
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args.slice(0, 3), ['--profile', 'fixed-profile', 'im']);
    assert.ok(calls[0].args.includes('+chat-list'));
    assert.ok(calls[0].args.includes('--types'));
    assert.ok(calls[1].args.includes('page-two'));
    assert.doesNotMatch(JSON.stringify(result), /tenant|owner|Ignore tools/);
  });

  it('sends with the fixed bot profile and an idempotency key', async () => {
    let call;
    const service = new LarkToolService(options(), async (command, args, runOptions) => {
      call = { command, args, runOptions };
      return ok({ message: { message_id: 'om_sent12345678' } });
    });
    const result = await service.sendMessage({
      chat_id: 'oc_memorize123456',
      text: 'hi',
      idempotency_key: 'stable-send-1',
      decision_message_id: DECISION_MESSAGE_ID,
    });

    assert.deepEqual(result, {
      sent: true,
      chat_id: 'oc_memorize123456',
      mention_user_ids: [],
      message_id: 'om_sent12345678',
      idempotency_key: result.idempotency_key,
    });
    assert.equal(call.command, '/fake/lark-cli');
    assert.deepEqual(call.args.slice(0, 3), ['--profile', 'fixed-profile', 'im']);
    assert.ok(call.args.includes('+messages-send'));
    assert.equal(call.args[call.args.indexOf('--chat-id') + 1], 'oc_memorize123456');
    assert.equal(call.args[call.args.indexOf('--markdown') + 1], 'hi');
    assert.match(result.idempotency_key, /^ld_[a-f0-9]{40}$/);
    assert.equal(call.args[call.args.indexOf('--idempotency-key') + 1], result.idempotency_key);
  });

  it('sends markdown as a rich post instead of plain text', async () => {
    let call;
    const service = new LarkToolService(options(), async (command, args, runOptions) => {
      call = { command, args, runOptions };
      return ok({ message_id: 'om_sent12345678' });
    });
    await service.sendMessage({
      chat_id: 'oc_memorize123456',
      markdown: '**bold** [link](https://example.com)',
      decision_message_id: DECISION_MESSAGE_ID,
    });
    assert.ok(call.args.includes('--markdown'));
    assert.ok(!call.args.includes('--text'));
    assert.equal(call.args[call.args.indexOf('--markdown') + 1], '**bold** [link](https://example.com)');
  });

  it('rejects sends that provide both text and markdown, or neither', async () => {
    const service = new LarkToolService(options(), async () => ok({ message_id: 'om_sent12345678' }));
    await assert.rejects(
      () => service.sendMessage({
        chat_id: 'oc_memorize123456',
        text: 'hi',
        markdown: '**hi**',
        decision_message_id: DECISION_MESSAGE_ID,
      }),
      /provide only markdown/,
    );
    await assert.rejects(
      () => service.sendMessage({ chat_id: 'oc_memorize123456', decision_message_id: DECISION_MESSAGE_ID }),
      /markdown must not be empty/,
    );
  });

  it('replies with markdown as a rich post instead of plain text', async () => {
    let args;
    const service = new LarkToolService(options(), async (_command, invokedArgs) => {
      args = invokedArgs;
      return ok({ message_id: 'om_sent12345678' });
    });
    await service.replyMessage({
      message_id: 'om_target1234567',
      markdown: '- one\n- two',
      decision_message_id: DECISION_MESSAGE_ID,
    });
    assert.ok(args.includes('--markdown'));
    assert.ok(!args.includes('--text'));
    assert.equal(args[args.indexOf('--markdown') + 1], '- one\n- two');
  });

  it('downloads, base64-encodes, and cleans up a viewed image', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-image-'));
    try {
      let call;
      const service = new LarkToolService(options({ tempDir }), async (command, args, runOptions) => {
        call = { command, args, runOptions };
        const outputFlagIndex = args.indexOf('--output');
        const savedPath = path.join(runOptions.cwd, `${args[outputFlagIndex + 1]}.jpg`);
        fs.writeFileSync(savedPath, Buffer.from('fake-jpeg-bytes'));
        return ok({ saved_path: savedPath, size_bytes: 15 });
      });
      const result = await service.viewImage({
        message_id: 'om_target1234567',
        image_key: 'img_v3_abc123456',
      });
      assert.equal(result.message_id, 'om_target1234567');
      assert.equal(result.image_key, 'img_v3_abc123456');
      assert.equal(result.mime_type, 'image/jpeg');
      assert.equal(Buffer.from(result.base64, 'base64').toString(), 'fake-jpeg-bytes');
      assert.ok(call.args.includes('+messages-resources-download'));
      assert.equal(call.args[call.args.indexOf('--message-id') + 1], 'om_target1234567');
      assert.equal(call.args[call.args.indexOf('--file-key') + 1], 'img_v3_abc123456');
      assert.equal(call.runOptions.cwd, tempDir);
      assert.equal(fs.readdirSync(tempDir).length, 0, 'the downloaded file must not be left on disk');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects a viewImage call with a malformed image_key', async () => {
    const service = new LarkToolService(options({ tempDir: '/tmp/unused' }), async () => ok({}));
    await assert.rejects(
      () => service.viewImage({ message_id: 'om_target1234567', image_key: 'not-a-key' }),
      /full img_ Lark image key/,
    );
  });

  it('neutralizes mass-mention markup before a proactive send', async () => {
    let args;
    const service = new LarkToolService(options(), async (_command, invokedArgs) => {
      args = invokedArgs;
      return ok({ message_id: 'om_sent12345678' });
    });
    await service.sendMessage({
      chat_id: 'oc_memorize123456',
      text: 'hello <at user_id="all">all</at>',
      decision_message_id: DECISION_MESSAGE_ID,
    });
    const sentText = args[args.indexOf('--markdown') + 1];
    assert.equal(sentText, 'hello 所有人');
    assert.doesNotMatch(sentText, /user_id|<at/i);
  });

  it('renders validated user mentions for sends and replies', async () => {
    const calls = [];
    const service = new LarkToolService(options(), async (_command, args) => {
      calls.push(args);
      return ok({ message_id: 'om_sent12345678' });
    });
    const mentionUserId = 'ou_hermes12345678';
    const sent = await service.sendMessage({
      chat_id: 'oc_memorize123456',
      text: 'please handle this',
      mention_user_ids: [mentionUserId, mentionUserId],
      decision_message_id: DECISION_MESSAGE_ID,
    });
    const replied = await service.replyMessage({
      message_id: 'om_target1234567',
      text: 'please follow up',
      mention_user_ids: [mentionUserId],
      decision_message_id: DECISION_MESSAGE_ID,
    });

    assert.deepEqual(sent.mention_user_ids, [mentionUserId]);
    assert.deepEqual(replied.mention_user_ids, [mentionUserId]);
    assert.equal(
      calls[0][calls[0].indexOf('--markdown') + 1],
      `<at user_id="${mentionUserId}"></at> please handle this`,
    );
    assert.equal(
      calls[1][calls[1].indexOf('--markdown') + 1],
      `<at user_id="${mentionUserId}"></at> please follow up`,
    );
    await assert.rejects(
      () => service.sendMessage({ chat_id: 'oc_memorize123456', text: 'hi', mention_user_ids: ['Hermes'] }),
      /full ou_/,
    );
  });

  it('resolves mention_names through the chat roster and caches the fetch', async () => {
    let memberCalls = 0;
    const calls = [];
    const service = new LarkToolService(options(), async (_command, args) => {
      calls.push(args);
      if (args.includes('+chat-members-list')) {
        memberCalls += 1;
        assert.equal(args[args.indexOf('--chat-id') + 1], 'oc_memorize123456');
        return ok({
          users: [
            { name: 'Zayn', open_id: 'ou_zayn12345678' },
            { name: '张 三', open_id: 'ou_zhang1234567' },
          ],
          bots: [],
        });
      }
      return ok({ message_id: 'om_sent12345678' });
    });
    const sent = await service.sendMessage({
      chat_id: 'oc_memorize123456',
      text: 'please handle this',
      mention_names: ['Zayn', '张_三'],
      decision_message_id: DECISION_MESSAGE_ID,
    });
    assert.deepEqual(sent.mention_user_ids, ['ou_zayn12345678', 'ou_zhang1234567']);
    const sendArgs = calls.find((args) => args.includes('+messages-send'));
    assert.match(
      sendArgs[sendArgs.indexOf('--markdown') + 1],
      /^<at user_id="ou_zayn12345678"><\/at> <at user_id="ou_zhang1234567"><\/at> please handle this$/,
    );
    // Second send within the TTL reuses the cached roster.
    await service.sendMessage({
      chat_id: 'oc_memorize123456',
      text: 'again',
      mention_names: ['zayn'],
      decision_message_id: DECISION_MESSAGE_ID,
    });
    assert.equal(memberCalls, 1);
  });

  it('substitutes an inline "@Name" occurrence in place instead of only prefixing every mention', async () => {
    const calls = [];
    const service = new LarkToolService(options(), async (_command, args) => {
      calls.push(args);
      if (args.includes('+chat-members-list')) {
        return ok({
          users: [
            { name: 'Zayn', open_id: 'ou_zayn12345678' },
            { name: '张 三', open_id: 'ou_zhang1234567' },
          ],
          bots: [],
        });
      }
      return ok({ message_id: 'om_sent12345678' });
    });
    const sent = await service.sendMessage({
      chat_id: 'oc_memorize123456',
      markdown: '#1 @Zayn owns this\n\n#2 @张_三 owns that',
      mention_names: ['Zayn', '张_三'],
      decision_message_id: DECISION_MESSAGE_ID,
    });
    // The outbound mention_user_ids field is unaffected: both are still real
    // Lark mentions on the message, just placed where the text put them.
    assert.deepEqual(sent.mention_user_ids, ['ou_zayn12345678', 'ou_zhang1234567']);
    const sendArgs = calls.find((args) => args.includes('+messages-send'));
    const rendered = sendArgs[sendArgs.indexOf('--markdown') + 1];
    assert.equal(
      rendered,
      '#1 <at user_id="ou_zayn12345678"></at> owns this\n\n#2 <at user_id="ou_zhang1234567"></at> owns that',
    );
    // No leftover ids to prefix, since every resolved name was referenced inline.
    assert.ok(!rendered.startsWith('<at'));
  });

  it('still prefixes a resolved mention that the text never references inline', async () => {
    const service = new LarkToolService(options(), async (_command, args) => {
      if (args.includes('+chat-members-list')) {
        return ok({ users: [{ name: 'Zayn', open_id: 'ou_zayn12345678' }], bots: [] });
      }
      return ok({ message_id: 'om_sent12345678' });
    });
    const sent = await service.sendMessage({
      chat_id: 'oc_memorize123456',
      text: 'no inline mention of that person here',
      mention_names: ['Zayn'],
      decision_message_id: DECISION_MESSAGE_ID,
    });
    assert.deepEqual(sent.mention_user_ids, ['ou_zayn12345678']);
  });

  it('resolves reply mention_names via the target chat and rejects unknown chats', async () => {
    const service = new LarkToolService(
      options({ dryRun: true, chatLookup: (messageId) => (messageId === 'om_target1234567' ? 'oc_memorize123456' : null) }),
      async (_command, args) => {
        assert.ok(args.includes('+chat-members-list'));
        return ok({ users: [{ name: 'Zayn', open_id: 'ou_zayn12345678' }], bots: [] });
      },
    );
    const replied = await service.replyMessage({
      message_id: 'om_target1234567',
      text: 'ping',
      mention_names: ['Zayn'],
      decision_message_id: DECISION_MESSAGE_ID,
    });
    assert.deepEqual(replied.mention_user_ids, ['ou_zayn12345678']);

    const noChat = new LarkToolService(options({ dryRun: true, chatLookup: () => null }), async () => {
      throw new Error('must not fetch a roster without a chat');
    });
    await assert.rejects(
      () => noChat.replyMessage({
        message_id: 'om_target1234567',
        text: 'ping',
        mention_names: ['Zayn'],
        decision_message_id: DECISION_MESSAGE_ID,
      }),
      /target chat is unknown/,
    );
  });

  it('rejects unknown and ambiguous mention_names with clear errors', async () => {
    let memberCalls = 0;
    const service = new LarkToolService(options({ dryRun: true }), async (_command, args) => {
      assert.ok(args.includes('+chat-members-list'));
      memberCalls += 1;
      return ok({
        users: [
          { name: 'Alex', open_id: 'ou_alexone123456' },
          { name: 'alex', open_id: 'ou_alextwo123456' },
        ],
        bots: [],
      });
    });
    await assert.rejects(
      () => service.sendMessage({
        chat_id: 'oc_memorize123456',
        text: 'hi',
        mention_names: ['Ghost'],
        decision_message_id: DECISION_MESSAGE_ID,
      }),
      /unknown member name.*Ghost.*exactly as it appears/s,
    );
    assert.equal(memberCalls, 2); // one forced refresh before failing
    await assert.rejects(
      () => service.sendMessage({
        chat_id: 'oc_memorize123456',
        text: 'hi',
        mention_names: ['Alex'],
        decision_message_id: DECISION_MESSAGE_ID,
      }),
      (error) => /ambiguous/.test(error.message)
        && /ou_alexone123456/.test(error.message)
        && /ou_alextwo123456/.test(error.message),
    );
  });

  it('rejects guessed IDs, empty text, oversized text, and CLI failures', async () => {
    const service = new LarkToolService(options({ maxTextChars: 3 }), async () => ({
      code: 2,
      signal: null,
      stdout: JSON.stringify({ ok: false, error: { message: 'permission denied token=secret-value' } }),
      stderr: '',
      timedOut: false,
    }));
    await assert.rejects(() => service.sendMessage({ chat_id: 'oc_short', text: 'hi' }), /full oc_/);
    await assert.rejects(() => service.sendMessage({ chat_id: 'oc_memorize123456', text: ' ' }), /must not be empty/);
    await assert.rejects(() => service.sendMessage({ chat_id: 'oc_memorize123456', text: 'long' }), /character limit/);
    await assert.rejects(
      () => service.sendMessage({ chat_id: 'oc_memorize123456', text: 'hey', decision_message_id: DECISION_MESSAGE_ID }),
      (error) => /permission denied/.test(error.message) && !/secret-value/.test(error.message),
    );
  });

  it('does not invoke lark-cli when daemon dry-run is enabled', async () => {
    let invoked = false;
    const service = new LarkToolService(options({ dryRun: true }), async () => {
      invoked = true;
      return ok({ message_id: 'must-not-exist' });
    });
    const result = await service.sendMessage({ chat_id: 'oc_memorize123456', text: 'hi', decision_message_id: DECISION_MESSAGE_ID });
    assert.equal(invoked, false);
    assert.equal(result.sent, false);
    assert.equal(result.dry_run, true);
    assert.equal(result.message_id, null);
  });

  it('blocks stale actions in the exact accepted chat/thread and fails closed when state is unreadable', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-freshness-'));
    const databasePath = path.join(directory, 'state.sqlite3');
    const db = new DatabaseSync(databasePath);
    db.exec(`
      CREATE TABLE inbound(
        seq INTEGER PRIMARY KEY,
        message_id TEXT NOT NULL UNIQUE,
        conv_key TEXT NOT NULL,
        status TEXT NOT NULL
      );
      INSERT INTO inbound VALUES
        (1, '${DECISION_MESSAGE_ID}', 'profile:tenant:oc_chat:main', 'DONE'),
        (2, 'om_bot_filtered1234', 'profile:tenant:oc_chat:main', 'RULE_IGNORED'),
        (3, 'om_other_thread1234', 'profile:tenant:oc_chat:thread:omt_other', 'DONE');
    `);
    let calls = 0;
    const service = new LarkToolService(
      options({ databasePath, freshnessCheck: undefined }),
      async () => {
        calls += 1;
        return ok({ message_id: 'om_sent12345678' });
      },
    );
    const unreadable = new LarkToolService(
      options({ databasePath: path.join(directory, 'missing.sqlite3'), freshnessCheck: undefined }),
      async () => { throw new Error('must not send'); },
    );

    try {
      await service.sendMessage({
        chat_id: 'oc_memorize123456',
        text: 'still current',
        decision_message_id: DECISION_MESSAGE_ID,
      });
      assert.equal(calls, 1, 'filtered bot events and another thread must not stale the action');
      await assert.rejects(
        service.sendMessage({
          chat_id: 'oc_memorize123456',
          text: 'bot-sourced draft',
          decision_message_id: 'om_bot_filtered1234',
        }),
        /not an accepted daemon-authenticated inbound/,
      );

      db.exec("INSERT INTO inbound VALUES (4, 'om_newer_user12345', 'profile:tenant:oc_chat:main', 'DONE')");
      await assert.rejects(
        service.replyMessage({
          message_id: 'om_target1234567',
          text: 'old draft',
          decision_message_id: DECISION_MESSAGE_ID,
        }),
        /newer authenticated message.*same chat\/thread/,
      );
      await assert.rejects(
        service.reactToMessage({
          message_id: 'om_target1234567',
          emoji_type: 'OK',
          decision_message_id: DECISION_MESSAGE_ID,
        }),
        /newer authenticated message/,
      );
      assert.equal(calls, 1, 'stale actions must stop before lark-cli');

      await assert.rejects(
        unreadable.sendMessage({
          chat_id: 'oc_memorize123456',
          text: 'blind send',
          decision_message_id: DECISION_MESSAGE_ID,
        }),
        /freshness could not be verified/,
      );
    } finally {
      service.close();
      unreadable.close();
      db.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('reacts with the fixed bot profile and structured reaction payload', async () => {
    let call;
    const service = new LarkToolService(options(), async (command, args, runOptions) => {
      call = { command, args, runOptions };
      return ok({ reaction_id: 'reaction_12345678' });
    });
    const result = await service.reactToMessage({
      message_id: 'om_target1234567',
      emoji_type: 'THUMBSUP',
      decision_message_id: DECISION_MESSAGE_ID,
    });

    assert.deepEqual(result, {
      reacted: true,
      message_id: 'om_target1234567',
      emoji_type: 'THUMBSUP',
      reaction_id: 'reaction_12345678',
    });
    assert.equal(call.command, '/fake/lark-cli');
    assert.deepEqual(call.args.slice(0, 6), ['--profile', 'fixed-profile', 'im', 'reactions', 'create', '--as']);
    assert.equal(call.args[call.args.indexOf('--params') + 1], '{"message_id":"om_target1234567"}');
    assert.equal(call.args[call.args.indexOf('--data') + 1], '{"reaction_type":{"emoji_type":"THUMBSUP"}}');
    await assert.rejects(() => service.reactToMessage({ message_id: 'om_short', emoji_type: 'OK' }), /full om_/);
    await assert.rejects(() => service.reactToMessage({ message_id: 'om_target1234567', emoji_type: 'thumbs up' }), /valid Lark/);
    const mixedCase = await service.reactToMessage({ message_id: 'om_target1234567', emoji_type: 'OnIt', decision_message_id: DECISION_MESSAGE_ID });
    assert.equal(mixedCase.emoji_type, 'OnIt');
  });

  it('keeps temporary OnIt in sidecar memory and clears it on the next final delivery in the same scope', async () => {
    const scopeA = 'profile:tenant:oc_scopeA123456:main';
    const scopeB = 'profile:tenant:oc_scopeB123456:main';
    const rows = new Map([
      ['om_scopeAdecision123', { status: 'DONE', has_newer: 0, seq: 1, conv_key: scopeA }],
      ['om_scopeBdecision123', { status: 'DONE', has_newer: 0, seq: 1, conv_key: scopeB }],
    ]);
    const calls = [];
    let reactionCount = 0;
    const service = new LarkToolService(options({
      freshnessCheck: (messageId) => rows.get(messageId),
    }), async (_command, args) => {
      calls.push(args);
      if (args.includes('create') && args.includes('reactions')) {
        reactionCount += 1;
        return ok({ reaction_id: `reaction_${reactionCount}` });
      }
      if (args.includes('+messages-send')) return ok({ message_id: 'om_sentFinal123456' });
      return ok({});
    });

    const temporary = await service.reactToMessage({
      message_id: 'om_scopeAtarget1234',
      emoji_type: 'OnIt',
      temporary: true,
      decision_message_id: 'om_scopeAdecision123',
    });
    assert.equal(temporary.tracked, true);
    assert.equal(service.temporaryReactions.size, 1);

    // A final delivery in another chat/thread must not clear scope A.
    await service.sendMessage({
      chat_id: 'oc_scopeB12345678',
      text: 'other scope',
      decision_message_id: 'om_scopeBdecision123',
    });
    assert.equal(service.temporaryReactions.size, 1);
    assert.equal(calls.filter((args) => args.includes('delete')).length, 0);

    // A final reaction is still a final delivery, so it removes the working one.
    await service.reactToMessage({
      message_id: 'om_scopeAfinal1234',
      emoji_type: 'OK',
      decision_message_id: 'om_scopeAdecision123',
    });
    assert.equal(service.temporaryReactions.size, 0);
    const deletion = calls.find((args) => args.includes('delete'));
    assert.ok(deletion);
    assert.equal(deletion[deletion.indexOf('--message-id') + 1], 'om_scopeAtarget1234');
    assert.equal(deletion[deletion.indexOf('--reaction-id') + 1], 'reaction_1');

    await assert.rejects(
      service.reactToMessage({
        message_id: 'om_scopeAtarget5678',
        emoji_type: 'OK',
        temporary: true,
        decision_message_id: 'om_scopeAdecision123',
      }),
      /must use the OnIt emoji/,
    );
    await service.close();
  });

  it('does not turn successful final delivery into a failure when temporary reaction cleanup fails', async () => {
    const scope = 'profile:tenant:oc_cleanup123456:main';
    const calls = [];
    const service = new LarkToolService(options({
      freshnessCheck: () => ({ status: 'DONE', has_newer: 0, seq: 1, conv_key: scope }),
    }), async (_command, args) => {
      calls.push(args);
      if (args.includes('delete')) {
        return { code: 1, signal: null, stdout: '', stderr: 'cleanup failed', timedOut: false };
      }
      if (args.includes('create')) return ok({ reaction_id: 'reaction_cleanup' });
      return ok({ message_id: 'om_sentCleanup1234' });
    });

    await service.reactToMessage({
      message_id: 'om_cleanupTarget123',
      emoji_type: 'OnIt',
      temporary: true,
      decision_message_id: DECISION_MESSAGE_ID,
    });
    const sent = await service.sendMessage({
      chat_id: 'oc_cleanup12345678',
      text: 'finished',
      decision_message_id: DECISION_MESSAGE_ID,
    });
    assert.equal(sent.sent, true);
    assert.equal(service.temporaryReactions.size, 0);
    assert.equal(calls.filter((args) => args.includes('delete')).length, 1);
    await service.close();
  });

  it('terminates the whole lark-cli process group on timeout', { skip: process.platform === 'win32' }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-tools-timeout-'));
    const wrapper = path.join(directory, 'wrapper.mjs');
    const pidFile = path.join(directory, 'child.pid');
    fs.writeFileSync(wrapper, `#!/usr/bin/env node
      import { spawn } from 'node:child_process';
      import fs from 'node:fs';
      const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(process.argv[2], String(child.pid));
      setInterval(() => {}, 1000);
    `, { mode: 0o700 });

    try {
      const startedAt = Date.now();
      const result = await runCommand(wrapper, [pidFile], { cwd: directory, timeoutMs: 1_000 });
      assert.equal(result.timedOut, true);
      assert.ok(Date.now() - startedAt >= 2_800, 'timeout should wait for SIGKILL escalation before returning');
      const descendantPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      const deadline = Date.now() + 4_000;
      let alive = true;
      while (alive && Date.now() < deadline) {
        try { process.kill(descendantPid, 0); } catch (error) {
          if (error.code === 'ESRCH') alive = false;
          else throw error;
        }
        if (alive) await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (alive) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch {}
      }
      assert.equal(alive, false, 'descendant should not survive a wrapper timeout');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('Lark proactive IM MCP protocol', () => {
  it('advertises the narrow tools and serves the tool calls', async () => {
    const service = {
      async listChats() {
        return { chats: [{ chat_id: 'oc_memorize123456', name: 'Memorize', chat_mode: 'group', chat_status: 'normal' }], count: 1, has_more: false };
      },
      async listChatMessages() {
        return { chat_id: 'oc_memorize123456', as: 'bot', messages: [{ message_id: 'om_target1234567', chat_id: '', msg_type: 'text', create_time: '1', sender: { id: 'ou_person123456', name: 'Ada' }, content: 'hello' }], count: 1, has_more: false };
      },
      async searchMessages() {
        return { query: 'deploy', messages: [{ message_id: 'om_found1234567', chat_id: 'oc_elsewhere1234', msg_type: 'text', create_time: '1', sender: { id: 'ou_person123456', name: 'Ada' }, content: 'deploy done' }], count: 1, has_more: true };
      },
      async listThreadMessages() {
        return { thread_id: 'omt_topic1234567', as: 'bot', messages: [{ message_id: 'om_inthread12345', chat_id: '', msg_type: 'text', create_time: '1', sender: { id: 'ou_person123456', name: 'Ada' }, content: 'thread reply' }], count: 1, has_more: false };
      },
      readMeetingInbox() {
        return { items: [], count: 0, remaining: 0, acknowledged_at_ms: 1 };
      },
      async sendMessage() {
        return { sent: true, chat_id: 'oc_memorize123456', message_id: 'om_sent12345678', idempotency_key: 'key' };
      },
      async replyMessage() {
        return { sent: true, reply_to_message_id: 'om_target1234567', reply_in_thread: true, message_id: 'om_reply12345678', idempotency_key: 'key' };
      },
      async reactToMessage() {
        return { reacted: true, message_id: 'om_target1234567', emoji_type: 'OK', reaction_id: 'reaction_12345678' };
      },
      async retractMessage() {
        return { retracted: true, message_id: 'om_sent12345678' };
      },
    };
    const handle = createMcpHandler(service);
    const initialized = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(initialized.result.serverInfo.name, 'lark-daemon-im');
    const listed = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const toolNames = ['list_lark_chats', 'list_lark_chat_messages', 'search_lark_messages', 'list_lark_thread_messages', 'read_meeting_inbox', 'send_lark_message', 'reply_lark_message', 'react_to_lark_message', 'retract_lark_message', 'view_lark_image'];
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), toolNames);
    assert.deepEqual(LARK_TOOLS.map((tool) => tool.name), toolNames);
    for (const name of ['send_lark_message', 'reply_lark_message', 'react_to_lark_message']) {
      const tool = listed.result.tools.find((candidate) => candidate.name === name);
      assert.ok(tool.inputSchema.properties.response_to_message_id);
      assert.ok(tool.inputSchema.required.includes('decision_message_id'));
      assert.ok(!tool.inputSchema.required.includes('response_to_message_id'));
    }
    assert.equal(
      listed.result.tools.find((candidate) => candidate.name === 'react_to_lark_message')
        .inputSchema.properties.temporary.type,
      'boolean',
    );
    const chats = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_lark_chats', arguments: { query: 'memo' } } });
    assert.match(chats.result.content[0].text, /Memorize.*oc_memorize123456/);
    const messages = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_lark_chat_messages', arguments: { chat_id: 'oc_memorize123456' } } });
    assert.match(messages.result.content[0].text, /Ada.*hello/);
    const searched = await handle({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'search_lark_messages', arguments: { query: 'deploy' } } });
    assert.match(searched.result.content[0].text, /om_found1234567.*chat_id=oc_elsewhere1234.*deploy done/);
    assert.match(searched.result.content[0].text, /More results exist/);
    const threaded = await handle({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'list_lark_thread_messages', arguments: { thread_id: 'omt_topic1234567' } } });
    assert.match(threaded.result.content[0].text, /omt_topic1234567[\s\S]*thread reply/);
    const inbox = await handle({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'read_meeting_inbox', arguments: {} } });
    assert.equal(inbox.result.structuredContent.remaining, 0);
    const sent = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'send_lark_message', arguments: { chat_id: 'oc_memorize123456', markdown: 'hi', decision_message_id: DECISION_MESSAGE_ID } } });
    assert.equal(sent.result.structuredContent.sent, true);
    const replied = await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'reply_lark_message', arguments: { message_id: 'om_target1234567', markdown: 'hi', reply_in_thread: true, decision_message_id: DECISION_MESSAGE_ID } } });
    assert.equal(replied.result.structuredContent.sent, true);
    assert.match(replied.result.content[0].text, /om_target1234567/);
    const reacted = await handle({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'react_to_lark_message', arguments: { message_id: 'om_target1234567', emoji_type: 'OK', decision_message_id: DECISION_MESSAGE_ID } } });
    assert.equal(reacted.result.structuredContent.reacted, true);
    assert.match(reacted.result.content[0].text, /Reacted OK/);
    const retracted = await handle({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'retract_lark_message', arguments: { message_id: 'om_sent12345678' } } });
    assert.equal(retracted.result.structuredContent.retracted, true);
    assert.match(retracted.result.content[0].text, /Retracted/);
  });

  it('lists recent messages and builds the retract lark-cli invocation', async () => {
    const calls = [];
    const service = new LarkToolService(
      { larkCliBin: '/fake/lark-cli', profile: 'p', projectDir: '/tmp', timeoutMs: 5_000, maxTextChars: 50, dryRun: false, freshnessCheck: () => ({ status: 'DONE', has_newer: 0 }) },
      async (_bin, args) => {
        calls.push(args);
        const data = args.includes('+chat-messages-list')
          ? { messages: [{ message_id: 'om_target1234567', msg_type: 'text', create_time: '1', sender: { id: 'ou_person123456', name: 'Ada' }, content: 'hello' }], has_more: false }
          : {};
        return { code: 0, signal: null, stdout: JSON.stringify({ ok: true, data }), stderr: '', timedOut: false };
      },
    );
    const listed = await service.listChatMessages({ chat_id: 'oc_memorize123456', limit: 5 });
    assert.equal(listed.messages[0].message_id, 'om_target1234567');
    assert.match(calls[0].join(' '), /\+chat-messages-list.*--as bot.*--page-size 5/);
    const retracted = await service.retractMessage({ message_id: 'om_sent12345678' });
    assert.equal(retracted.retracted, true);
    assert.match(calls[1].join(' '), /messages delete.*message_id.*om_sent12345678/);
    await assert.rejects(service.retractMessage({ message_id: 'om_short' }), /full om_/);
    const asUser = await service.listChatMessages({ chat_id: 'oc_memorize123456', as: 'user' });
    assert.equal(asUser.as, 'user');
    assert.match(calls[2].join(' '), /\+chat-messages-list.*--as user/);
  });

  it('builds search and thread lark-cli invocations with validated inputs', async () => {
    const calls = [];
    const service = new LarkToolService(
      { larkCliBin: '/fake/lark-cli', profile: 'p', projectDir: '/tmp', timeoutMs: 5_000, maxTextChars: 50, dryRun: false, freshnessCheck: () => ({ status: 'DONE', has_newer: 0 }) },
      async (_bin, args) => {
        calls.push(args);
        const data = { messages: [{ message_id: 'om_found1234567', chat_id: 'oc_elsewhere1234', msg_type: 'text', create_time: '1', sender: { id: 'ou_person123456', name: 'Ada' }, content: 'deploy done' }], has_more: false };
        return { code: 0, signal: null, stdout: JSON.stringify({ ok: true, data }), stderr: '', timedOut: false };
      },
    );
    const found = await service.searchMessages({ query: 'deploy', chat_id: 'oc_memorize123456', start: '2026-07-17T00:00:00+08:00', limit: 5 });
    assert.equal(found.messages[0].chat_id, 'oc_elsewhere1234');
    const rendered = calls[0].join(' ');
    assert.match(rendered, /\+messages-search.*--as user.*--query deploy.*--page-size 5/);
    assert.match(rendered, /--chat-id oc_memorize123456.*--start 2026-07-17T00:00:00\+08:00/);
    await assert.rejects(service.searchMessages({ query: '' }), /must not be empty/);
    await assert.rejects(service.searchMessages({ query: 'x', start: 'yesterday' }), /ISO 8601/);
    await assert.rejects(service.searchMessages({ query: 'x', chat_id: 'oc_short' }), /full oc_/);

    const thread = await service.listThreadMessages({ thread_id: 'omt_topic1234567', as: 'user', limit: 10 });
    assert.equal(thread.as, 'user');
    assert.equal(thread.messages[0].message_id, 'om_found1234567');
    assert.match(calls[1].join(' '), /\+threads-messages-list.*--as user.*--thread omt_topic1234567.*--page-size 10/);
    await assert.rejects(service.listThreadMessages({ thread_id: 'oc_notathread123' }), /full omt_/);
  });

  it('validates reply ids and builds the reply lark-cli invocation', async () => {
    const calls = [];
    const service = new LarkToolService(
      { larkCliBin: '/fake/lark-cli', profile: 'p', projectDir: '/tmp', timeoutMs: 5_000, maxTextChars: 50, dryRun: false, freshnessCheck: () => ({ status: 'DONE', has_newer: 0 }) },
      async (_bin, args) => {
        calls.push(args);
        return { code: 0, signal: null, stdout: JSON.stringify({ ok: true, data: { message_id: 'om_new123456789' } }), stderr: '', timedOut: false };
      },
    );
    await assert.rejects(service.replyMessage({ message_id: 'om_short', text: 'hi' }), /full om_/);
    await assert.rejects(service.replyMessage({ message_id: 'om_target1234567', text: '' }), /must not be empty/);
    const result = await service.replyMessage({ message_id: 'om_target1234567', text: 'hello', reply_in_thread: true, decision_message_id: DECISION_MESSAGE_ID });
    assert.equal(result.sent, true);
    assert.equal(result.message_id, 'om_new123456789');
    const rendered = calls[0].join(' ');
    assert.match(rendered, /\+messages-reply/);
    assert.match(rendered, /--message-id om_target1234567/);
    assert.match(rendered, /--reply-in-thread/);
  });

  it('returns tool failures as MCP errors without breaking the session', async () => {
    const handle = createMcpHandler({
      async listChats() { throw new Error('network token=secret-value'); },
    });
    const response = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_lark_chats', arguments: {} } });
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /network/);
    assert.doesNotMatch(response.result.content[0].text, /secret-value/);
  });

  it('requires a fixed profile and validates numeric limits at startup', () => {
    assert.throws(() => parseServerArgs([]), /profile is required/);
    const token = ['--runtime-token', 'runtime-test'];
    assert.throws(() => parseServerArgs(['--profile', 'p', ...token, '--timeout-ms', '3']), /at least 1000/);
    assert.throws(() => parseServerArgs(['--profile', 'p', ...token, '--dry-run', 'maybe']), /true or false/);
    assert.equal(parseServerArgs(['--profile', 'p', ...token]).profile, 'p');
    assert.equal(parseServerArgs(['--profile', 'p', ...token, '--dry-run', 'true']).dryRun, true);
    assert.equal(
      parseServerArgs(['--profile', 'p', ...token, '--database-path', '/tmp/freshness.sqlite3']).databasePath,
      '/tmp/freshness.sqlite3',
    );
    assert.equal(
      parseServerArgs(['--profile', 'p', ...token, '--temp-dir', '/tmp/lark-media']).tempDir,
      '/tmp/lark-media',
    );
  });

  it('serves newline-delimited JSON-RPC over stdio', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-tools-stdio-'));
    const fakeLark = path.join(directory, 'fake-lark.mjs');
    fs.writeFileSync(fakeLark, `#!/usr/bin/env node
      console.log(JSON.stringify({ ok: true, data: {
        chats: [{ chat_id: 'oc_fixture12345678', name: 'Fixture Chat', chat_mode: 'group', chat_status: 'normal' }],
        has_more: false,
        page_token: ''
      } }));
    `, { mode: 0o700 });
    const serverPath = path.resolve(testDir, '..', 'src', 'lark-tools.mjs');
    const child = spawn(process.execPath, [
      serverPath,
      '--lark-cli-bin', fakeLark,
      '--profile', 'fixture-profile',
      '--project-dir', directory,
      '--timeout-ms', '5000',
      '--max-text-chars', '1000',
      '--runtime-token', 'runtime-test',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const responses = [];
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line) responses.push(JSON.parse(line));
      }
    });
    const waitFor = async (count) => {
      const deadline = Date.now() + 5_000;
      while (responses.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(responses.length >= count, `expected ${count} MCP responses, got ${responses.length}`);
    };

    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_lark_chats', arguments: {} } })}\n`);
      await waitFor(3);
      assert.equal(responses[0].result.serverInfo.name, 'lark-daemon-im');
      assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['list_lark_chats', 'list_lark_chat_messages', 'search_lark_messages', 'list_lark_thread_messages', 'read_meeting_inbox', 'send_lark_message', 'reply_lark_message', 'react_to_lark_message', 'retract_lark_message', 'view_lark_image']);
      assert.match(responses[2].result.content[0].text, /Fixture Chat/);
    } finally {
      child.stdin.end();
      child.kill('SIGTERM');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
