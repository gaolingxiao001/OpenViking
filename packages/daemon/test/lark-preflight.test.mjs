import assert from 'node:assert/strict';
import { it } from 'node:test';
import { LarkClient } from '../src/lark.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

it('requires joined-chat discovery during strict CLI preflight', async () => {
  const calls = [];
  const registry = {
    async run(_command, args) {
      calls.push(args);
      if (args.includes('event')) return { code: 0, stdout: '--event-types --quiet', stderr: '' };
      if (args.includes('im')) return { code: 0, stdout: '+messages-reply +messages-send', stderr: '' };
      return { code: 0, stdout: 'ok', stderr: '' };
    },
  };
  const client = new LarkClient({
    profile: 'test-profile',
    larkCliBin: '/fake/lark-cli',
    projectDir: '/tmp',
    sendTimeoutMs: 1_000,
    strictCliPreflight: true,
  }, registry, quietLogger);
  await assert.rejects(() => client.preflight(), /missing \+chat-list/);
  assert.ok(calls.some((args) => args.includes('im')));
});
