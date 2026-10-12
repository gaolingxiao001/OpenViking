import assert from 'node:assert/strict';
import { chatEvent } from './event-fixture.mjs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createLogger } from '../src/logger.mjs';
import { LarkDaemon } from '../src/daemon.mjs';
import { Harness } from '../src/harness.mjs';
import { startMockEnv, textMessage } from './mock-env.mjs';

describe('daemon event path (mock env)', { concurrency: false }, () => {
  it('persists a raw event and steers the formatted line into the codex app-server', async () => {
    const env = await startMockEnv();
    try {
      assert.equal(env.config.meetingAudio, null);
      env.receive(textMessage({ messageId: 'om-e2e', text: '请回复我' }));
      await env.waitForCodexInput(/om-e2e/);

      const delivered = env.codexInput();
      assert.equal(delivered.length, 1);
      assert.match(delivered[0].text, /\[chat=oc-e2e source=lark msg=om-e2e time=.* from=ou-e2e\] 请回复我/);

      assert.equal(env.daemon.store.stats().inbound.DONE, 1);
      // No outbox rows are ever created in steer mode.
      assert.equal(env.daemon.store.stats().outbox.PENDING, undefined);
      assert.equal(env.daemon.store.stats().outbox.SENT, undefined);

      const global = env.daemon.store.getGlobalSession();
      assert.equal(global.sessionId, 'thread-mock');
      assert.match(global.policyHash, /^[a-f0-9]{64}$/);
    } finally {
      await env.stop();
    }
  });

  it('expands a mention placeholder to the visible target name', async () => {
    const env = await startMockEnv();
    try {
      env.receive(textMessage({
        messageId: 'om-other-bot',
        chatId: 'oc-group',
        chatType: 'group',
        text: '@_user_1 飞书CLI',
        mentions: [{
          key: '@_user_1',
          name: '吴郑啸的DevBox飞书 CLI',
          id: { open_id: 'ou_devbox12345678' },
        }],
      }));
      await env.waitForCodexInput(/om-other-bot/);

      const delivered = env.codexInput().find((entry) => /om-other-bot/.test(entry.text));
      assert.match(delivered.text, /@吴郑啸的DevBox飞书 CLI 飞书CLI/);
      assert.doesNotMatch(delivered.text, /@_user_1/);
      assert.doesNotMatch(delivered.text, /\[mentions:/);
    } finally {
      await env.stop();
    }
  });

  it('deduplicates a redelivered event instead of waking the model twice', async () => {
    const env = await startMockEnv();
    try {
      const message = textMessage({ messageId: 'om-dup', text: '只处理一次' });
      env.receive(message);
      await env.waitForCodexInput(/om-dup/);
      env.receive(message);
      // A later distinct message proves the duplicate was already ignored by
      // the time delivery continued.
      env.receive(textMessage({ messageId: 'om-after-dup', text: '后一条' }));
      await env.waitForCodexInput(/om-after-dup/);

      const deliveries = env.codexInput().filter((entry) => /om-dup/.test(entry.text));
      assert.equal(deliveries.length, 1);
      assert.equal(env.daemon.store.stats().inbound.DONE, 2);
    } finally {
      await env.stop();
    }
  });

  it('batches an idle group burst into a single model turn', async () => {
    const env = await startMockEnv();
    try {
      env.receive(textMessage({
        messageId: 'om-burst-1', chatId: 'oc-group', chatType: 'group', text: '第一条',
      }));
      env.receive(textMessage({
        messageId: 'om-burst-2', chatId: 'oc-group', chatType: 'group', text: '第二条',
      }));
      await env.waitForCodexInput(/om-burst-2/);

      const bursts = env.codexInput().filter((entry) => /om-burst/.test(entry.text));
      assert.equal(bursts.length, 1);
      assert.match(bursts[0].text, /om-burst-1[\s\S]*om-burst-2/);
    } finally {
      await env.stop();
    }
  });

  it('replies a failure notice to the sender when a codex turn fails', async () => {
    const env = await startMockEnv({
      codex: {
        behavior: 'fail',
        failBlob: JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: "Unsupported value: 'minimal' is not supported." },
          status: 400,
        }),
      },
    });
    try {
      env.receive(textMessage({ messageId: 'om-fail', text: 'hi' }));
      await env.waitForReply(/处理失败/);

      const reply = env.replies().at(-1).join(' ');
      assert.match(reply, /om-fail/);                       // replies to the failed message
      assert.match(reply, /处理失败/);
      assert.match(reply, /Unsupported value/);             // unwrapped API error, not [object Object]
      assert.doesNotMatch(reply, /object Object/);
    } finally {
      await env.stop();
    }
  });

  it('answers a slash command through the outbox without waking codex', async () => {
    const env = await startMockEnv();
    try {
      env.receive(textMessage({ messageId: 'om-cmd', text: '/h' }));
      await env.waitForReply(/可用命令/);

      const reply = env.replies().at(-1).join(' ');
      assert.match(reply, /om-cmd/);          // quote-replies the command message
      assert.match(reply, /可用命令/);         // help text body
      assert.match(reply, /thread-mock/);      // reports the current session id
      assert.equal(env.codexInput().length, 0); // codex never woke up
      assert.equal(env.daemon.store.stats().inbound.RULE_IGNORED, 1);
      // The daemon's own reply goes through the same outbox as agent deliveries.
      assert.match(reply, /--idempotency-key ld_[a-f0-9]{40}/);
      await env.waitFor(() => env.daemon.store.stats().outbox.SENT === 1);
      assert.deepEqual(env.daemon.store.stats().outbox, { SENT: 1 });
      const journal = env.daemon.store.cognitionJournal().filter((item) => item.kind === 'outbound');
      assert.deepEqual(journal.map((item) => [item.status, item.messageId]), [['COMMITTED', 'om-mock-out']]);
    } finally {
      await env.stop();
    }
  });

  it('delivers meeting insertText items over the same submit seam as chat', async () => {
    const env = await startMockEnv();
    try {
      const result = env.daemon.meeting.insertText({
        text: '[meeting-audio meeting=vc-e2e] 大家好，先同步一下进度',
        scope: { kind: 'meeting' },
      });
      assert.equal(result.accepted, true);
      await env.waitForCodexInput(/meeting-audio meeting=vc-e2e/);
      assert.match(env.codexInput().at(-1).text, /先同步一下进度/);
    } finally {
      await env.stop();
    }
  });

  it('injects the OpenViking identity into the conversation policy codex sees', async () => {
    const env = await startMockEnv({
      identity: '# Zayn\n- e2e identity fixture marker: zircon-e2e-7742',
    });
    try {
      const spawns = env.codexSpawnArgs();
      assert.equal(spawns.length, 1);
      const instructions = spawns[0].find((argument) => argument.startsWith('developer_instructions='));
      assert.ok(instructions, 'codex is spawned with developer_instructions');
      assert.match(instructions, /OpenViking identity/);
      assert.match(instructions, /zircon-e2e-7742/);
      assert.match(instructions, /viking:\/\/user\/e2e-user\/identity\.md/);
    } finally {
      await env.stop();
    }
  });
});

describe('ingress barrier', () => {
  it('answers /help immediately while a model turn is active', async () => {
    const daemon = new LarkDaemon(
      { dataDir: os.tmpdir(), lockPath: path.join(os.tmpdir(), 'unused-lark-daemon-test.lock') },
      createLogger('error', { test: 'command-idle-barrier' }),
    );
    const order = [];
    daemon.agentRuntime = {
      runtime: 'codex',
      threadId: 'thread-active',
      model: 'gpt-5.6-sol',
      effort: 'medium',
      turnInProgress: true,
      async whenIdle() { throw new Error('/help must not wait for the model'); },
      async snapshot() {
        return {
          runtime: this.runtime,
          session: { id: this.threadId, connected: true },
          model: this.model,
          effort: this.effort,
          work: { working: true, connected: true, queued: 0, switching: false },
          models: [],
        };
      },
      submit() { order.push('following-inbound'); return { accepted: true }; },
    };
    daemon.store = {
      appendCognitionJournal(entry) { order.push(`journal:${entry.kind}`); },
      recordActivity() { return true; },
    };
    daemon.actions = {
      async replyToEvent() { order.push('command-reply'); return { ok: true }; },
    };
    const harness = new Harness({
      config: {},
      store: daemon.store,
      logger: createLogger('error', { test: 'command-idle-barrier' }),
      recordActivity: () => true,
      runtime: daemon.agentRuntime,
      onSlashCommand: (command, event, inbound) => daemon.handleSlashCommand(command, event, inbound),
    });
    const event = chatEvent({
      chatId: 'oc_command123456',
      threadId: null,
      messageId: 'om_command123456',
      senderId: 'ou_sender123456',
      content: '/help',
      conversationKey: 'profile:tenant:oc_command123456:main',
      chatType: 'p2p',
    });

    const command = harness.enqueueIngress(
      () => daemon.handleSlashCommand({ name: 'help', arg: '' }, event, { seq: 1 }),
    );
    const following = harness.enqueueIngress(() => daemon.agentRuntime.submit([{ text: 'next', seq: 2 }]));
    await Promise.all([command, following]);
    assert.deepEqual(order, ['journal:control', 'command-reply', 'following-inbound']);
  });
});

describe('/model immediate switch', () => {
  it('executes /model without waiting for the stuck active turn', async () => {
    const daemon = new LarkDaemon(
      { dataDir: os.tmpdir(), lockPath: path.join(os.tmpdir(), 'unused-lark-daemon-model.lock') },
      createLogger('error', { test: 'model-no-wait' }),
    );
    const order = [];
    daemon.agentRuntime = {
      runtime: 'codex',
      threadId: 'th-stuck',
      model: '',
      effort: 'medium',
      turnInProgress: true,
      // A stuck turn: /model must never block behind this.
      whenIdle() { order.push('wait-idle'); return new Promise(() => {}); },
      async snapshot() {
        return {
          runtime: this.runtime,
          session: { id: this.threadId, connected: true },
          model: this.model,
          effort: this.effort,
          work: { working: true, connected: true, queued: 0, switching: false },
          capabilities: { effortControl: 'selectable' },
          models: [],
        };
      },
      async transition(request) {
        order.push(`setModel:${request.selector}`);
        return { ok: true, runtimeChanged: false, model: request.selector, threadId: 'th-fresh' };
      },
    };
    daemon.store = {
      appendCognitionJournal() {},
      recordActivity() { return true; },
    };
    const replies = [];
    daemon.actions = {
      async replyToEvent(event, text) { replies.push({ messageId: event.messageId, text }); return { ok: true }; },
    };
    const event = chatEvent({
      chatId: 'oc_model123456',
      threadId: null,
      messageId: 'om_model123456',
      senderId: 'ou_sender123456',
      content: '/model gpt-x',
      conversationKey: 'profile:tenant:oc_model123456:main',
      chatType: 'p2p',
    });

    await daemon.handleSlashCommand({ name: 'model', arg: 'gpt-x' }, event, { seq: 1 });
    assert.deepEqual(order, ['setModel:gpt-x']);
    assert.equal(replies.length, 1);
    assert.match(replies[0].text, /已切到 gpt-x，已开启新会话：th-fresh/);
  });
});
