import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createMcpHandler, LARK_TOOLS, LarkToolService, parseServerArgs, runCommand } from '../src/lark-tools.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));

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
    ...overrides,
  };
}

describe('Lark proactive IM tool service', () => {
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
    });

    assert.deepEqual(result, {
      sent: true,
      chat_id: 'oc_memorize123456',
      mention_user_ids: [],
      message_id: 'om_sent12345678',
      idempotency_key: 'stable-send-1',
    });
    assert.equal(call.command, '/fake/lark-cli');
    assert.deepEqual(call.args.slice(0, 3), ['--profile', 'fixed-profile', 'im']);
    assert.ok(call.args.includes('+messages-send'));
    assert.equal(call.args[call.args.indexOf('--chat-id') + 1], 'oc_memorize123456');
    assert.equal(call.args[call.args.indexOf('--text') + 1], 'hi');
    assert.equal(call.args[call.args.indexOf('--idempotency-key') + 1], 'stable-send-1');
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
    });
    const replied = await service.replyMessage({
      message_id: 'om_target1234567',
      text: 'please follow up',
      mention_user_ids: [mentionUserId],
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
      () => service.sendMessage({ chat_id: 'oc_memorize123456', text: 'hey' }),
      (error) => /permission denied/.test(error.message) && !/secret-value/.test(error.message),
    );
  });

  it('does not invoke lark-cli when daemon dry-run is enabled', async () => {
    let invoked = false;
    const service = new LarkToolService(options({ dryRun: true }), async () => {
      invoked = true;
      return ok({ message_id: 'must-not-exist' });
    });
    const result = await service.sendMessage({ chat_id: 'oc_memorize123456', text: 'hi' });
    assert.equal(invoked, false);
    assert.equal(result.sent, false);
    assert.equal(result.dry_run, true);
    assert.equal(result.message_id, null);
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
  it('advertises only the three narrow tools and serves the tool calls', async () => {
    const service = {
      async listChats() {
        return { chats: [{ chat_id: 'oc_memorize123456', name: 'Memorize', chat_mode: 'group', chat_status: 'normal' }], count: 1, has_more: false };
      },
      async sendMessage() {
        return { sent: true, chat_id: 'oc_memorize123456', message_id: 'om_sent12345678', idempotency_key: 'key' };
      },
      async replyMessage() {
        return { sent: true, reply_to_message_id: 'om_target1234567', reply_in_thread: true, message_id: 'om_reply12345678', idempotency_key: 'key' };
      },
    };
    const handle = createMcpHandler(service);
    const initialized = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    assert.equal(initialized.result.serverInfo.name, 'lark-daemon-im');
    const listed = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.deepEqual(listed.result.tools.map((tool) => tool.name), ['list_lark_chats', 'send_lark_message', 'reply_lark_message']);
    assert.deepEqual(LARK_TOOLS.map((tool) => tool.name), ['list_lark_chats', 'send_lark_message', 'reply_lark_message']);
    const chats = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_lark_chats', arguments: { query: 'memo' } } });
    assert.match(chats.result.content[0].text, /Memorize.*oc_memorize123456/);
    const sent = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'send_lark_message', arguments: { chat_id: 'oc_memorize123456', text: 'hi' } } });
    assert.equal(sent.result.structuredContent.sent, true);
    const replied = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'reply_lark_message', arguments: { message_id: 'om_target1234567', text: 'hi', reply_in_thread: true } } });
    assert.equal(replied.result.structuredContent.sent, true);
    assert.match(replied.result.content[0].text, /om_target1234567/);
  });

  it('validates reply ids and builds the reply lark-cli invocation', async () => {
    const calls = [];
    const service = new LarkToolService(
      { larkCliBin: '/fake/lark-cli', profile: 'p', projectDir: '/tmp', timeoutMs: 5_000, maxTextChars: 50, dryRun: false },
      async (_bin, args) => {
        calls.push(args);
        return { code: 0, signal: null, stdout: JSON.stringify({ ok: true, data: { message_id: 'om_new123456789' } }), stderr: '', timedOut: false };
      },
    );
    await assert.rejects(service.replyMessage({ message_id: 'om_short', text: 'hi' }), /full om_/);
    await assert.rejects(service.replyMessage({ message_id: 'om_target1234567', text: '' }), /must not be empty/);
    const result = await service.replyMessage({ message_id: 'om_target1234567', text: 'hello', reply_in_thread: true });
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
    assert.throws(() => parseServerArgs(['--profile', 'p', '--timeout-ms', '3']), /at least 1000/);
    assert.throws(() => parseServerArgs(['--profile', 'p', '--dry-run', 'maybe']), /true or false/);
    assert.equal(parseServerArgs(['--profile', 'p']).profile, 'p');
    assert.equal(parseServerArgs(['--profile', 'p', '--dry-run', 'true']).dryRun, true);
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
      assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['list_lark_chats', 'send_lark_message', 'reply_lark_message']);
      assert.match(responses[2].result.content[0].text, /Fixture Chat/);
    } finally {
      child.stdin.end();
      child.kill('SIGTERM');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
