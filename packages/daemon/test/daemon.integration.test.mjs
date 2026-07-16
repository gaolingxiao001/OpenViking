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
});
