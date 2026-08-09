import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkClient } from '../src/lark.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe('Lark chat lookup', () => {
  it('adds the daemon liveness reaction directly through lark-cli', async () => {
    const calls = [];
    const registry = {
      async run(command, args, options) {
        calls.push({ command, args, options });
        return {
          code: 0,
          timedOut: false,
          stdout: JSON.stringify({ ok: true, data: { reaction_id: 'opaque-reaction-id' } }),
          stderr: '',
        };
      },
    };
    const client = new LarkClient({
      profile: 'test-profile',
      larkCliBin: '/fake/lark-cli',
      projectDir: '/tmp',
      sendTimeoutMs: 30_000,
      dryRun: false,
    }, registry, quietLogger);

    assert.deepEqual(await client.reactMessage('om_message123456', 'OnIt'), {
      reacted: true,
      reactionId: 'opaque-reaction-id',
    });
    assert.deepEqual(calls[0].args, [
      '--profile', 'test-profile',
      'im', 'reactions', 'create', '--as', 'bot',
      '--params', '{"message_id":"om_message123456"}',
      '--data', '{"reaction_type":{"emoji_type":"OnIt"}}',
      '--format', 'json',
    ]);
  });

  it('deletes the exact reaction token returned by Lark', async () => {
    const calls = [];
    const registry = {
      async run(command, args, options) {
        calls.push({ command, args, options });
        return { code: 0, timedOut: false, stdout: JSON.stringify({ ok: true }), stderr: '' };
      },
    };
    const client = new LarkClient({
      profile: 'test-profile',
      larkCliBin: '/fake/lark-cli',
      projectDir: '/tmp',
      sendTimeoutMs: 30_000,
      dryRun: false,
    }, registry, quietLogger);

    assert.deepEqual(
      await client.deleteReaction('om_message123456', 'opaque-reaction-id'),
      { deleted: true },
    );
    assert.deepEqual(calls[0].args, [
      '--profile', 'test-profile',
      'im', 'reactions', 'delete', '--as', 'bot',
      '--message-id', 'om_message123456',
      '--reaction-id', 'opaque-reaction-id',
      '--format', 'json',
    ]);
  });

  it('surfaces reaction delete failures without guessing remote state', async () => {
    const registry = {
      async run() {
        return { code: 1, timedOut: false, stdout: '', stderr: 'invalid reaction_id' };
      },
    };
    const client = new LarkClient({
      profile: 'test-profile',
      larkCliBin: '/fake/lark-cli',
      projectDir: '/tmp',
      sendTimeoutMs: 30_000,
      dryRun: false,
    }, registry, quietLogger);
    await assert.rejects(
      () => client.deleteReaction('om_message123456', 'opaque-reaction-id'),
      /invalid reaction_id/,
    );
  });

  it('gets a group name with the schema-verified bot chat command', async () => {
    const calls = [];
    const registry = {
      async run(command, args, options) {
        calls.push({ command, args, options });
        return {
          code: 0,
          timedOut: false,
          stdout: JSON.stringify({ data: { name: '项目讨论群' } }),
          stderr: '',
        };
      },
    };
    const client = new LarkClient({
      profile: 'test-profile',
      larkCliBin: '/fake/lark-cli',
      projectDir: '/tmp',
    }, registry, quietLogger);
    assert.equal(await client.getChatName('oc-private-chat'), '项目讨论群');
    assert.deepEqual(calls[0].args, [
      '--profile', 'test-profile',
      'im', 'chats', 'get',
      '--as', 'bot',
      '--chat-id', 'oc-private-chat',
      '--format', 'json',
    ]);
    assert.equal(calls[0].options.timeoutMs, 15_000);
  });

  it('surfaces chat lookup permission failures for daemon retry handling', async () => {
    const registry = {
      async run() {
        return { code: 1, timedOut: false, stdout: '', stderr: 'permission denied' };
      },
    };
    const client = new LarkClient({
      profile: 'test-profile',
      larkCliBin: '/fake/lark-cli',
      projectDir: '/tmp',
    }, registry, quietLogger);
    await assert.rejects(() => client.getChatName('oc-private-chat'), /permission denied/);
  });
});
