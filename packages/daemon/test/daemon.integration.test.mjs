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
  it('persists a raw event, runs Codex, and commits one dry-run reply', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-daemon-e2e-'));
    const fakeLark = path.join(directory, 'fake-lark.mjs');
    const fakeCodex = path.join(directory, 'fake-codex.mjs');
    executable(fakeLark, `
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log('lark-cli 1.0.56'); process.exit(0); }
      if (args.includes('--help')) {
        console.log('--event-types --quiet +messages-reply +messages-send');
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
    executable(fakeCodex, `
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      if (args.includes('--version')) { console.log('codex-cli 0.test'); process.exit(0); }
      if (args.includes('login') && args.includes('status')) { console.log('Logged in using test'); process.exit(0); }
      if (args.includes('--help')) {
        console.log('--output-schema --output-last-message');
        process.exit(0);
      }
      process.stdin.resume();
      process.stdin.on('end', () => {
        const index = args.indexOf('--output-last-message');
        const output = args[index + 1];
        const decision = JSON.stringify({ action: 'reply', reason_code: 'direct_request', delivery_mode: 'chat', reply: '测试回复' });
        fs.writeFileSync(output, decision);
        console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));
        console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: decision } }));
      });
    `);

    const now = Date.now();
    const previousEvent = process.env.FAKE_LARK_EVENT;
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
      tempDir: path.join(directory, 'data', 'tmp'),
      workspace: path.join(directory, 'workspace'),
      larkCliBin: fakeLark,
      codexBin: fakeCodex,
      profile: 'test-profile',
      writeSenderIds: new Set(['ou-e2e']),
      port: 0,
      httpEnabled: false,
      debounceMs: 10,
      freshnessGraceMs: 10,
      codexTimeoutMs: 3_000,
      sendTimeoutMs: 1_000,
      dryRun: true,
      logLevel: 'error',
    };
    const daemon = new LarkDaemon(config, createLogger('error', { test: 'e2e' }));
    try {
      await daemon.start();
      await waitFor(() => daemon.store.stats().outbox.DRY_RUN === 1);
      assert.equal(daemon.store.stats().inbound.DONE, 1);
      const outbox = daemon.store.db.prepare('SELECT delivery_mode, target_chat_id FROM outbox').get();
      assert.deepEqual({ ...outbox }, { delivery_mode: 'chat', target_chat_id: 'oc-e2e' });
      const global = daemon.store.getGlobalSession();
      assert.equal(global.sessionId, 'thread-test');
      assert.match(global.policyHash, /^[a-f0-9]{64}$/);
    } finally {
      await daemon.shutdown('test', 0);
      if (previousEvent === undefined) delete process.env.FAKE_LARK_EVENT;
      else process.env.FAKE_LARK_EVENT = previousEvent;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
