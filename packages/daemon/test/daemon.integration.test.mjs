import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { getConfig, projectDir } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { LarkDaemon } from '../src/daemon.mjs';

function executable(file, source) {
  fs.writeFileSync(file, `#!/usr/bin/env node\n${source}`, { mode: 0o700 });
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('timed out waiting for condition');
}

describe('daemon event path', { concurrency: false }, () => {
  it('persists a raw event and steers the formatted line into the codex app-server', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-daemon-e2e-'));
    const fakeLark = path.join(directory, 'fake-lark.mjs');
    const fakeCodex = path.join(directory, 'fake-codex.mjs');
    const codexLog = path.join(directory, 'codex-input.log');

    executable(fakeLark, `
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log('lark-cli 1.0.56'); process.exit(0); }
      if (args.includes('--help')) {
        console.log('--event-types --quiet +messages-reply +messages-send +chat-list');
        process.exit(0);
      }
      if (args.includes('doctor')) { console.log(JSON.stringify({ ok: true })); process.exit(0); }
      if (args.includes('event')) {
        setTimeout(() => console.log(process.env.FAKE_LARK_EVENT), 20);
        const timer = setInterval(() => {}, 1000);
        process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
        process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
      } else {
        console.log(JSON.stringify({ message_id: 'om-agent' }));
      }
    `);

    // Minimal codex app-server: newline-delimited JSON-RPC over stdio. Records every
    // turn/start input text to FAKE_CODEX_LOG so the test can assert delivery.
    executable(fakeCodex, `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const log = process.env.FAKE_CODEX_LOG;
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      const rl = readline.createInterface({ input: process.stdin });
      let turnSeq = 0;
      rl.on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.method === 'initialize') { send({ id: msg.id, result: {} }); return; }
        if (msg.method === 'initialized') { return; }
        if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
          send({ id: msg.id, result: { thread: { id: 'thread-test' } } });
          send({ method: 'thread/started', params: { thread: { id: 'thread-test' } } });
          return;
        }
        if (msg.method === 'turn/start') {
          const text = msg.params.input.map((part) => part.text).join('');
          fs.appendFileSync(log, text + '\\n');
          send({ id: msg.id, result: {} });
          const turnId = 'turn-' + (++turnSeq);
          send({ method: 'turn/started', params: { turn: { id: turnId } } });
          send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
          return;
        }
        if (msg.method === 'turn/steer') {
          const text = msg.params.input.map((part) => part.text).join('');
          fs.appendFileSync(log, text + '\\n');
          send({ id: msg.id, result: {} });
          return;
        }
      });
    `);

    const now = Date.now();
    const previousEvent = process.env.FAKE_LARK_EVENT;
    const previousLog = process.env.FAKE_CODEX_LOG;
    process.env.FAKE_CODEX_LOG = codexLog;
    process.env.FAKE_LARK_EVENT = JSON.stringify({
      schema: '2.0',
      header: {
        event_id: 'evt-e2e',
        event_type: 'im.message.receive_v1',
        tenant_key: 'tenant-e2e',
        create_time: String(now),
      },
      event: {
        sender: { sender_id: { open_id: 'ou-e2e' }, sender_type: 'user' },
        message: {
          message_id: 'om-e2e',
          chat_id: 'oc-e2e',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '请回复我' }),
          create_time: String(now),
        },
      },
    });

    const base = getConfig();
    const config = {
      ...base,
      projectDir,
      dataDir: path.join(directory, 'data'),
      databasePath: path.join(directory, 'data', 'state.sqlite3'),
      lockPath: path.join(directory, 'data', 'daemon.lock'),
      workspace: path.join(directory, 'workspace'),
      larkCliBin: fakeLark,
      codexBin: fakeCodex,
      profile: 'test-profile',
      port: 0,
      httpEnabled: false,
      logLevel: 'error',
    };
    const daemon = new LarkDaemon(config, createLogger('error', { test: 'e2e' }));
    try {
      await daemon.start();
      await waitFor(() => fs.existsSync(codexLog)
        && fs.readFileSync(codexLog, 'utf8').includes('[chat=oc-e2e msg=om-e2e'));

      const logged = fs.readFileSync(codexLog, 'utf8');
      assert.match(logged, /\[chat=oc-e2e msg=om-e2e time=.* from=ou-e2e\] 请回复我/);

      assert.equal(daemon.store.stats().inbound.DONE, 1);
      // No outbox rows are ever created in steer mode.
      assert.equal(daemon.store.stats().outbox.PENDING, undefined);
      assert.equal(daemon.store.stats().outbox.SENT, undefined);

      const global = daemon.store.getGlobalSession();
      assert.equal(global.sessionId, 'thread-test');
      assert.match(global.policyHash, /^[a-f0-9]{64}$/);
    } finally {
      await daemon.shutdown('test', 0);
      if (previousEvent === undefined) delete process.env.FAKE_LARK_EVENT;
      else process.env.FAKE_LARK_EVENT = previousEvent;
      if (previousLog === undefined) delete process.env.FAKE_CODEX_LOG;
      else process.env.FAKE_CODEX_LOG = previousLog;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('replies a failure notice to the sender when a codex turn fails', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-daemon-fail-'));
    const fakeLark = path.join(directory, 'fake-lark.mjs');
    const fakeCodex = path.join(directory, 'fake-codex.mjs');
    const replyLog = path.join(directory, 'reply.log');

    executable(fakeLark, `
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log('lark-cli 1.0.56'); process.exit(0); }
      if (args.includes('--help')) {
        console.log('--event-types --quiet +messages-reply +messages-send +chat-list');
        process.exit(0);
      }
      if (args.includes('doctor')) { console.log(JSON.stringify({ ok: true })); process.exit(0); }
      if (args.includes('+messages-reply')) {
        fs.appendFileSync(process.env.FAKE_REPLY_LOG, JSON.stringify(args) + '\\n');
        console.log(JSON.stringify({ ok: true, data: { message_id: 'om-fail-notice' } }));
        process.exit(0);
      }
      if (args.includes('event')) {
        setTimeout(() => console.log(process.env.FAKE_LARK_EVENT), 20);
        const timer = setInterval(() => {}, 1000);
        process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
        process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
      } else {
        console.log(JSON.stringify({ message_id: 'om-agent' }));
      }
    `);

    // Codex whose every turn fails with a wrapped API error blob.
    executable(fakeCodex, `
      import readline from 'node:readline';
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      const rl = readline.createInterface({ input: process.stdin });
      const blob = JSON.stringify({
        type: 'error',
        error: { type: 'invalid_request_error', message: "Unsupported value: 'minimal' is not supported." },
        status: 400,
      });
      rl.on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.method === 'initialize') { send({ id: msg.id, result: {} }); return; }
        if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
          send({ id: msg.id, result: { thread: { id: 'thread-test' } } });
          return;
        }
        if (msg.method === 'turn/start') {
          send({ id: msg.id, result: {} });
          send({ method: 'turn/started', params: { turn: { id: 'turn-1' } } });
          send({ method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'failed', error: { message: blob } } } });
        }
      });
    `);

    const now = Date.now();
    const previousEnv = {
      FAKE_LARK_EVENT: process.env.FAKE_LARK_EVENT,
      FAKE_REPLY_LOG: process.env.FAKE_REPLY_LOG,
    };
    process.env.FAKE_REPLY_LOG = replyLog;
    process.env.FAKE_LARK_EVENT = JSON.stringify({
      schema: '2.0',
      header: {
        event_id: 'evt-fail',
        event_type: 'im.message.receive_v1',
        tenant_key: 'tenant-e2e',
        create_time: String(now),
      },
      event: {
        sender: { sender_id: { open_id: 'ou-e2e' }, sender_type: 'user' },
        message: {
          message_id: 'om-fail',
          chat_id: 'oc-e2e',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: 'hi' }),
          create_time: String(now),
        },
      },
    });

    const base = getConfig();
    const config = {
      ...base,
      projectDir,
      dataDir: path.join(directory, 'data'),
      databasePath: path.join(directory, 'data', 'state.sqlite3'),
      lockPath: path.join(directory, 'data', 'daemon.lock'),
      workspace: path.join(directory, 'workspace'),
      larkCliBin: fakeLark,
      codexBin: fakeCodex,
      profile: 'test-profile',
      port: 0,
      httpEnabled: false,
      dryRun: false,
      logLevel: 'error',
    };
    const daemon = new LarkDaemon(config, createLogger('error', { test: 'fail-notice' }));
    try {
      await daemon.start();
      await waitFor(() => fs.existsSync(replyLog));

      const reply = fs.readFileSync(replyLog, 'utf8');
      assert.match(reply, /om-fail/);                       // replies to the failed message
      assert.match(reply, /处理失败/);
      assert.match(reply, /Unsupported value/);             // unwrapped API error, not [object Object]
      assert.doesNotMatch(reply, /object Object/);
    } finally {
      await daemon.shutdown('test', 0);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('answers a slash command directly through lark-cli without waking codex', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-daemon-cmd-'));
    const fakeLark = path.join(directory, 'fake-lark.mjs');
    const fakeCodex = path.join(directory, 'fake-codex.mjs');
    const codexLog = path.join(directory, 'codex-input.log');
    const replyLog = path.join(directory, 'reply.log');

    executable(fakeLark, `
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log('lark-cli 1.0.56'); process.exit(0); }
      if (args.includes('--help')) {
        console.log('--event-types --quiet +messages-reply +messages-send +chat-list');
        process.exit(0);
      }
      if (args.includes('doctor')) { console.log(JSON.stringify({ ok: true })); process.exit(0); }
      if (args.includes('+messages-reply')) {
        fs.appendFileSync(process.env.FAKE_REPLY_LOG, JSON.stringify(args) + '\\n');
        console.log(JSON.stringify({ ok: true, data: { message_id: 'om-cmd-reply' } }));
        process.exit(0);
      }
      if (args.includes('event')) {
        setTimeout(() => console.log(process.env.FAKE_LARK_EVENT), 20);
        const timer = setInterval(() => {}, 1000);
        process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
        process.on('SIGINT', () => { clearInterval(timer); process.exit(0); });
      } else {
        console.log(JSON.stringify({ message_id: 'om-agent' }));
      }
    `);

    executable(fakeCodex, `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const log = process.env.FAKE_CODEX_LOG;
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', (line) => {
        let msg;
        try { msg = JSON.parse(line); } catch { return; }
        if (msg.method === 'initialize') { send({ id: msg.id, result: {} }); return; }
        if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
          send({ id: msg.id, result: { thread: { id: 'thread-test' } } });
          return;
        }
        if (msg.method === 'turn/start' || msg.method === 'turn/steer') {
          const text = msg.params.input.map((part) => part.text).join('');
          fs.appendFileSync(log, text + '\\n');
          send({ id: msg.id, result: {} });
        }
      });
    `);

    const now = Date.now();
    const previousEnv = {
      FAKE_LARK_EVENT: process.env.FAKE_LARK_EVENT,
      FAKE_CODEX_LOG: process.env.FAKE_CODEX_LOG,
      FAKE_REPLY_LOG: process.env.FAKE_REPLY_LOG,
    };
    process.env.FAKE_CODEX_LOG = codexLog;
    process.env.FAKE_REPLY_LOG = replyLog;
    process.env.FAKE_LARK_EVENT = JSON.stringify({
      schema: '2.0',
      header: {
        event_id: 'evt-cmd',
        event_type: 'im.message.receive_v1',
        tenant_key: 'tenant-e2e',
        create_time: String(now),
      },
      event: {
        sender: { sender_id: { open_id: 'ou-e2e' }, sender_type: 'user' },
        message: {
          message_id: 'om-cmd',
          chat_id: 'oc-e2e',
          chat_type: 'p2p',
          message_type: 'text',
          content: JSON.stringify({ text: '/h' }),
          create_time: String(now),
        },
      },
    });

    const base = getConfig();
    const config = {
      ...base,
      projectDir,
      dataDir: path.join(directory, 'data'),
      databasePath: path.join(directory, 'data', 'state.sqlite3'),
      lockPath: path.join(directory, 'data', 'daemon.lock'),
      workspace: path.join(directory, 'workspace'),
      larkCliBin: fakeLark,
      codexBin: fakeCodex,
      profile: 'test-profile',
      port: 0,
      httpEnabled: false,
      dryRun: false,
      logLevel: 'error',
    };
    const daemon = new LarkDaemon(config, createLogger('error', { test: 'cmd' }));
    try {
      await daemon.start();
      await waitFor(() => fs.existsSync(replyLog));

      const reply = fs.readFileSync(replyLog, 'utf8');
      assert.match(reply, /om-cmd/);          // quote-replies the command message
      assert.match(reply, /可用命令/);         // help text body
      assert.match(reply, /thread-test/);      // reports the current session id
      assert.equal(fs.existsSync(codexLog), false); // codex never woke up
      assert.equal(daemon.store.stats().inbound.RULE_IGNORED, 1);
    } finally {
      await daemon.shutdown('test', 0);
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('answers /help immediately while a model turn is active', async () => {
    const daemon = new LarkDaemon(
      { lockPath: path.join(os.tmpdir(), 'unused-lark-daemon-test.lock') },
      createLogger('error', { test: 'command-idle-barrier' }),
    );
    const order = [];
    daemon.codex = {
      runtime: 'codex',
      threadId: 'thread-active',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      turnInProgress: true,
      async whenIdle() { throw new Error('/help must not wait for the model'); },
      deliver() { order.push('following-inbound'); },
    };
    daemon.store = {
      appendCognitionJournal(entry) { order.push(`journal:${entry.kind}`); },
      settleCognitionJournal() { order.push('journal:settled'); },
      recordActivity() { return true; },
    };
    daemon.lark = {
      async replyMessage() { order.push('command-reply'); },
    };
    daemon.liveness = {
      touch() { order.push('liveness:touch'); },
    };
    const event = {
      chatId: 'oc_command123456',
      threadId: null,
      messageId: 'om_command123456',
      senderId: 'ou_sender123456',
      content: '/help',
      conversationKey: 'profile:tenant:oc_command123456:main',
      chatType: 'p2p',
    };

    const command = daemon.enqueueIngress(
      () => daemon.handleSlashCommand({ name: 'help', arg: '' }, event, { seq: 1 }),
    );
    const following = daemon.enqueueIngress(() => daemon.codex.deliver('next', 2));
    await Promise.all([command, following]);
    assert.deepEqual(order, [
      'journal:control',
      'journal:outbound',
      'command-reply',
      'journal:settled',
      'liveness:touch',
      'following-inbound',
    ]);
  });

});

describe('/model immediate switch', () => {
  it('executes /model without waiting for the stuck active turn', async () => {
    const daemon = new LarkDaemon(
      { lockPath: path.join(os.tmpdir(), 'unused-lark-daemon-model.lock') },
      createLogger('error', { test: 'model-no-wait' }),
    );
    const order = [];
    daemon.codex = {
      runtime: 'codex',
      threadId: 'th-stuck',
      model: '',
      effort: 'medium',
      turnInProgress: true,
      // A stuck turn: /model must never block behind this.
      whenIdle() { order.push('wait-idle'); return new Promise(() => {}); },
      async listModels() { return []; },
      async setModel(model) {
        order.push(`setModel:${model}`);
        return { runtimeChanged: false, model, threadId: 'th-fresh' };
      },
    };
    daemon.store = {
      appendCognitionJournal() {},
      settleCognitionJournal() {},
      recordActivity() { return true; },
    };
    const replies = [];
    daemon.lark = { async replyMessage(messageId, text) { replies.push({ messageId, text }); } };
    const event = {
      chatId: 'oc_model123456',
      threadId: null,
      messageId: 'om_model123456',
      senderId: 'ou_sender123456',
      content: '/model gpt-x',
      conversationKey: 'profile:tenant:oc_model123456:main',
      chatType: 'p2p',
    };

    await daemon.handleSlashCommand({ name: 'model', arg: 'gpt-x' }, event, { seq: 1 });
    assert.deepEqual(order, ['setModel:gpt-x']);
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /已切到 gpt-x，已开启新会话：th-fresh/);
  });
});

describe('automatic claude fallback', () => {
  function makeFallbackDaemon({ runtime = 'claude', setModelError = null, fallbackModel } = {}) {
    const daemon = new LarkDaemon(
      {
        lockPath: path.join(os.tmpdir(), 'unused-lark-daemon-fallback.lock'),
        ...(fallbackModel === undefined ? { fallbackModel: 'gpt-5.6-sol' } : { fallbackModel }),
      },
      createLogger('error', { test: 'claude-fallback' }),
    );
    const calls = [];
    const delivered = [];
    const replies = [];
    const activities = [];
    daemon.codex = {
      runtime,
      async setModel(model) {
        calls.push(['setModel', model]);
        if (setModelError) throw setModelError;
        this.runtime = 'codex';
        return { runtimeChanged: true, runtime: 'codex', model };
      },
      deliverBatch(items) { delivered.push(items); return true; },
    };
    const inboundRows = {
      1: {
        seq: 1,
        messageId: 'om_failed_123456',
        chatId: 'oc_chat123456',
        threadId: null,
        conversationKey: 'profile:tenant:oc_chat123456:main',
        senderId: 'ou_sender123456',
        content: '帮我看下这个',
        createTimeMs: Date.UTC(2026, 7, 7, 10, 0),
        mentions: [],
      },
    };
    daemon.store = {
      inboundBySeq: (seq) => inboundRows[seq] ?? null,
      appendCognitionJournal() {},
      settleCognitionJournal() {},
      recordActivity(entry) { activities.push(entry); return true; },
    };
    daemon.lark = {
      async replyMessage(messageId, text) { replies.push({ messageId, text }); },
    };
    return { daemon, calls, delivered, replies, activities };
  }

  it('hard-switches to the fallback model, notifies the chat, and retries the failed turn', async () => {
    const { daemon, calls, delivered, replies, activities } = makeFallbackDaemon();
    assert.equal(
      await daemon.handleTurnFailure({ inboundSeqs: [1], error: 'Claude API exploded' }),
      true,
    );

    assert.deepEqual(calls, [['setModel', 'gpt-5.6-sol']]);
    assert.equal(replies.length, 1);
    assert.equal(replies[0].messageId, 'om_failed_123456');
    assert.match(replies[0].text, /因 Claude API exploded 报错，已自动切换到 gpt-5\.6-sol 重试/);
    assert.doesNotMatch(replies[0].text, /没有生成回复/); // no duplicate failure notice
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0][0].seq, 1);
    assert.match(delivered[0][0].text, /^\[chat=oc_chat123456 msg=om_failed_123456 .*\] 帮我看下这个$/);
    const fallback = activities.find((entry) => entry.kind === 'agent.fallback');
    assert.equal(fallback.status, 'SWITCHED');
    assert.equal(fallback.metadata.model, 'gpt-5.6-sol');
  });

  it('honours FALLBACK_MODEL from config', async () => {
    const { daemon, calls } = makeFallbackDaemon({ fallbackModel: 'gpt-6-luna' });
    await daemon.handleTurnFailure({ inboundSeqs: [1], error: 'boom' });
    assert.deepEqual(calls, [['setModel', 'gpt-6-luna']]);
  });

  it('never falls back from the codex runtime and sends the normal notice instead', async () => {
    const { daemon, calls, replies } = makeFallbackDaemon({ runtime: 'codex' });
    assert.equal(
      await daemon.handleTurnFailure({ inboundSeqs: [1], error: 'quota exceeded' }),
      false,
    );
    assert.equal(calls.length, 0);
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /处理失败/);
  });

  it('attempts only one automatic fallback per cooldown window', async () => {
    const { daemon, calls, replies } = makeFallbackDaemon();
    await daemon.handleTurnFailure({ inboundSeqs: [1], error: 'boom' });
    assert.equal(calls.length, 1);
    // The user switched back to claude, which fails again inside the cooldown.
    daemon.codex.runtime = 'claude';
    await daemon.handleTurnFailure({ inboundSeqs: [1], error: 'boom again' });
    assert.equal(calls.length, 1); // no second automatic switch
    assert.equal(replies.length, 2);
    assert.match(replies[1].text, /处理失败/);
    // After the cooldown expires the fallback becomes available again.
    daemon.lastFallbackAtMs = Date.now() - 6 * 60 * 1_000;
    await daemon.handleTurnFailure({ inboundSeqs: [1], error: 'boom again' });
    assert.equal(calls.length, 2);
  });

  it('falls through to the normal failure notice when the switch itself fails', async () => {
    const { daemon, calls, delivered, replies, activities } = makeFallbackDaemon({
      setModelError: new Error('codex is unavailable'),
    });
    await daemon.handleTurnFailure({ inboundSeqs: [1], error: 'boom' });
    assert.equal(calls.length, 1);
    assert.equal(delivered.length, 0);
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /处理失败/);
    const fallback = activities.find((entry) => entry.kind === 'agent.fallback');
    assert.equal(fallback.status, 'FAILED');
  });
});

describe('failure notice mute', () => {
  function makeDaemon(inboundRows) {
    const daemon = new LarkDaemon(
      { lockPath: path.join(os.tmpdir(), 'unused-lark-daemon-mute.lock') },
      createLogger('error', { test: 'failure-mute' }),
    );
    const replies = [];
    const activities = [];
    daemon.store = {
      inboundBySeq: (seq) => inboundRows[seq] ?? null,
      appendCognitionJournal() {},
      settleCognitionJournal() {},
      recordActivity(entry) { activities.push(entry); return true; },
    };
    daemon.lark = {
      async replyMessage(messageId, text) { replies.push({ messageId, text }); },
    };
    return { daemon, replies, activities };
  }

  const inbound = (seq, overrides = {}) => ({
    seq,
    messageId: `om_failed_${seq}`,
    chatId: 'oc_chat123456',
    threadId: null,
    conversationKey: 'profile:tenant:oc_chat123456:main',
    mentions: [],
    ...overrides,
  });

  it('mutes a repeat of the same error in the same conversation', async () => {
    const { daemon, replies, activities } = makeDaemon({ 1: inbound(1), 2: inbound(2) });
    await daemon.notifyTurnFailure({ inboundSeqs: [1], error: 'model exploded' });
    await daemon.notifyTurnFailure({ inboundSeqs: [2], error: 'model exploded' });
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /处理失败/);
    const notices = activities.filter((entry) => entry.kind === 'agent.failure_notice');
    assert.deepEqual(notices.map((entry) => entry.status), ['NOTIFYING', 'MUTED']);
  });

  it('notifies again when the error summary changes', async () => {
    const { daemon, replies } = makeDaemon({ 1: inbound(1), 2: inbound(2), 3: inbound(3) });
    await daemon.notifyTurnFailure({ inboundSeqs: [1], error: 'model exploded' });
    await daemon.notifyTurnFailure({ inboundSeqs: [2], error: 'quota exceeded' });
    assert.equal(replies.length, 2);
    assert.match(replies[1].text, /quota exceeded/);
    // The stored summary was updated: repeating the new error is now muted.
    await daemon.notifyTurnFailure({ inboundSeqs: [3], error: 'quota exceeded' });
    assert.equal(replies.length, 2);
  });

  it('re-notifies a persistent identical failure after the mute TTL expires', async () => {
    const { daemon, replies } = makeDaemon({ 1: inbound(1), 2: inbound(2) });
    await daemon.notifyTurnFailure({ inboundSeqs: [1], error: 'model exploded' });
    assert.equal(replies.length, 1);
    // Age the delivered mute past the 10-minute TTL.
    const key = 'profile:tenant:oc_chat123456:main';
    const mute = daemon.failureNoticeMutes.get(key);
    daemon.failureNoticeMutes.set(key, { ...mute, atMs: mute.atMs - 11 * 60 * 1_000 });
    await daemon.notifyTurnFailure({ inboundSeqs: [2], error: 'model exploded' });
    assert.equal(replies.length, 2);
  });

  it('resets the mute after a successful turn for that conversation', async () => {
    const { daemon, replies } = makeDaemon({ 1: inbound(1), 2: inbound(2), 3: inbound(3) });
    await daemon.notifyTurnFailure({ inboundSeqs: [1], error: 'model exploded' });
    daemon.handleTurnSuccess({ inboundSeqs: [2] });
    await daemon.notifyTurnFailure({ inboundSeqs: [3], error: 'model exploded' });
    assert.equal(replies.length, 2);
  });

  it('keeps the mute when the successful turn belongs to another conversation', async () => {
    const other = inbound(2, { conversationKey: 'profile:tenant:oc_other:main' });
    const { daemon, replies } = makeDaemon({ 1: inbound(1), 2: other, 3: inbound(3) });
    await daemon.notifyTurnFailure({ inboundSeqs: [1], error: 'model exploded' });
    daemon.handleTurnSuccess({ inboundSeqs: [2] });
    await daemon.notifyTurnFailure({ inboundSeqs: [3], error: 'model exploded' });
    assert.equal(replies.length, 1);
  });

  it('always notifies when an inbound message of the failed turn mentions the bot', async () => {
    const rows = {
      1: inbound(1),
      2: inbound(2, { mentions: [{ key: '@_user_1', name: 'Zayn', id: 'ou_bot123456' }] }),
    };
    const { daemon, replies, activities } = makeDaemon(rows);
    await daemon.notifyTurnFailure({ inboundSeqs: [1], error: 'model exploded' });
    await daemon.notifyTurnFailure({ inboundSeqs: [2], error: 'model exploded' });
    assert.equal(replies.length, 2);
    const notices = activities.filter((entry) => entry.kind === 'agent.failure_notice');
    assert.deepEqual(notices.map((entry) => entry.status), ['NOTIFYING', 'NOTIFYING']);
  });
});
