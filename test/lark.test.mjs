import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkClient } from '../src/lark.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

function harness() {
  const calls = [];
  const registry = {
    async run(command, args) {
      calls.push({ command, args });
      return {
        code: 0,
        timedOut: false,
        stdout: JSON.stringify({ message_id: 'om-outbound' }),
        stderr: '',
      };
    },
  };
  const client = new LarkClient({
    profile: 'test-profile',
    larkCliBin: '/fake/lark-cli',
    projectDir: '/tmp',
    sendTimeoutMs: 1_000,
    dryRun: false,
  }, registry, quietLogger);
  return { client, calls };
}

function outbox(deliveryMode) {
  return {
    id: 1,
    deliveryMode,
    replyToMessageId: 'om-source',
    targetChatId: 'oc-current',
    body: 'hello',
    idempotencyKey: 'idempotency-1',
  };
}

describe('Lark outbound routing', () => {
  it('sends a normal message reply without opening a thread', async () => {
    const { client, calls } = harness();
    await client.sendOutbound(outbox('reply'));
    const args = calls[0].args;
    assert.ok(args.includes('+messages-reply'));
    assert.ok(args.includes('--message-id'));
    assert.ok(!args.includes('--reply-in-thread'));
    assert.ok(!args.includes('--chat-id'));
  });

  it('adds reply-in-thread for thread delivery', async () => {
    const { client, calls } = harness();
    await client.sendOutbound(outbox('thread'));
    const args = calls[0].args;
    assert.ok(args.includes('+messages-reply'));
    assert.ok(args.includes('--message-id'));
    assert.ok(args.includes('--reply-in-thread'));
  });

  it('sends an unquoted message directly to the current chat', async () => {
    const { client, calls } = harness();
    await client.sendOutbound(outbox('chat'));
    const args = calls[0].args;
    assert.ok(args.includes('+messages-send'));
    assert.ok(args.includes('--chat-id'));
    assert.ok(!args.includes('--message-id'));
    assert.ok(!args.includes('--reply-in-thread'));
    assert.ok(args.includes('idempotency-1'));
  });
});
