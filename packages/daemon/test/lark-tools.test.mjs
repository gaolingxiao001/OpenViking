import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, LARK_TOOLS, LarkToolService, parseServerArgs, runCommand } from '../src/lark-tools.mjs';
import { Store } from '../src/store.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const DECISION_MESSAGE_ID = 'om_decision12345678';
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
    assert.equal(call.args[call.args.indexOf('--text') + 1], 'hi');
    assert.match(result.idempotency_key, /^ld_[a-f0-9]{40}$/);
    assert.equal(call.args[call.args.indexOf('--idempotency-key') + 1], result.idempotency_key);
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
    const sentText = args[args.indexOf('--text') + 1];
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
      calls[0][calls[0].indexOf('--text') + 1],
      `<at user_id="${mentionUserId}"></at> please handle this`,
    );
    assert.equal(
      calls[1][calls[1].indexOf('--text') + 1],
      `<at user_id="${mentionUserId}"></at> please follow up`,
    );
    await assert.rejects(
      () => service.sendMessage({ chat_id: 'oc_memorize123456', text: 'hi', mention_user_ids: ['Hermes'] }),
      /full ou_/,
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
    const toolNames = ['list_lark_chats', 'list_lark_chat_messages', 'search_lark_messages', 'list_lark_thread_messages', 'send_lark_message', 'reply_lark_message', 'react_to_lark_message', 'retract_lark_message'];
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), toolNames);
    assert.deepEqual(LARK_TOOLS.map((tool) => tool.name), toolNames);
    const chats = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_lark_chats', arguments: { query: 'memo' } } });
    assert.match(chats.result.content[0].text, /Memorize.*oc_memorize123456/);
    const messages = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_lark_chat_messages', arguments: { chat_id: 'oc_memorize123456' } } });
    assert.match(messages.result.content[0].text, /Ada.*hello/);
    const searched = await handle({ jsonrpc: '2.0', id: 40, method: 'tools/call', params: { name: 'search_lark_messages', arguments: { query: 'deploy' } } });
    assert.match(searched.result.content[0].text, /om_found1234567.*chat_id=oc_elsewhere1234.*deploy done/);
    assert.match(searched.result.content[0].text, /More results exist/);
    const threaded = await handle({ jsonrpc: '2.0', id: 41, method: 'tools/call', params: { name: 'list_lark_thread_messages', arguments: { thread_id: 'omt_topic1234567' } } });
    assert.match(threaded.result.content[0].text, /omt_topic1234567[\s\S]*thread reply/);
    const sent = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'send_lark_message', arguments: { chat_id: 'oc_memorize123456', text: 'hi', decision_message_id: DECISION_MESSAGE_ID } } });
    assert.equal(sent.result.structuredContent.sent, true);
    const replied = await handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'reply_lark_message', arguments: { message_id: 'om_target1234567', text: 'hi', reply_in_thread: true, decision_message_id: DECISION_MESSAGE_ID } } });
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
      assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['list_lark_chats', 'list_lark_chat_messages', 'search_lark_messages', 'list_lark_thread_messages', 'send_lark_message', 'reply_lark_message', 'react_to_lark_message', 'retract_lark_message']);
      assert.match(responses[2].result.content[0].text, /Fixture Chat/);
    } finally {
      child.stdin.end();
      child.kill('SIGTERM');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
