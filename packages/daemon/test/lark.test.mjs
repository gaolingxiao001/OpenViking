import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { LarkClient, SUBSCRIBED_EVENT_TYPES } from '../src/lark.mjs';
import { sanitizeNonArkChildEnv } from '../src/process-utils.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

describe('non-Ark child environment', () => {
  it('strips every Ark credential and session alias', () => {
    const environment = sanitizeNonArkChildEnv({
      PATH: '/bin',
      LARK_APP_ID: 'keep-for-lark',
      ARK_API_KEY: 'remove',
      ARK_SESSION_ID: 'remove',
      LARK_DAEMON_VOLC_SESSION_ID: 'remove',
      SESSION_ID: 'remove',
    });
    assert.equal(environment.PATH, '/bin');
    assert.equal(environment.LARK_APP_ID, 'keep-for-lark');
    assert.equal(environment.ARK_API_KEY, undefined);
    assert.equal(environment.ARK_SESSION_ID, undefined);
    assert.equal(environment.LARK_DAEMON_VOLC_SESSION_ID, undefined);
    assert.equal(environment.SESSION_ID, undefined);
  });
});

describe('Lark chat lookup', () => {
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

describe('Lark bot identity', () => {
  it('resolves the authenticated bot open_id instead of matching display names', async () => {
    const calls = [];
    const registry = {
      async run(command, args, options) {
        calls.push({ command, args, options });
        return {
          code: 0,
          timedOut: false,
          stdout: JSON.stringify({
            ok: true,
            identity: 'bot',
            data: { open_id: 'ou_zayn12345678', app_name: 'Zayn' },
          }),
          stderr: '',
        };
      },
    };
    const client = new LarkClient({
      profile: 'test-profile',
      larkCliBin: '/fake/lark-cli',
      projectDir: '/tmp',
    }, registry, quietLogger);
    assert.deepEqual(await client.getBotIdentity(), {
      openId: 'ou_zayn12345678',
      name: 'Zayn',
    });
    assert.deepEqual(calls[0].args, [
      '--profile', 'test-profile',
      'api', 'GET', '/open-apis/bot/v3/info',
      '--as', 'bot', '--json',
    ]);
  });

  it('rejects bot info without a valid open_id', async () => {
    const registry = {
      async run() {
        return { code: 0, timedOut: false, stdout: '{"ok":true,"data":{"bot":{}}}', stderr: '' };
      },
    };
    const client = new LarkClient({
      profile: 'test-profile',
      larkCliBin: '/fake/lark-cli',
      projectDir: '/tmp',
    }, registry, quietLogger);
    await assert.rejects(() => client.getBotIdentity(), /no valid open_id/);
  });
});

describe('Lark meeting transport', () => {
  it('subscribes to IM plus the three VC push event types', () => {
    assert.deepEqual(SUBSCRIBED_EVENT_TYPES, [
      'im.message.receive_v1',
      'vc.bot.meeting_invited_v1',
      'vc.bot.meeting_activity_v1',
      'vc.bot.meeting_ended_v1',
    ]);
  });

  it('uses application identity for invite-correlated joins and cursor recovery', async () => {
    const calls = [];
    const registry = {
      async run(command, args, options) {
        calls.push({ command, args, options });
        if (args.includes('+meeting-join')) {
          return {
            code: 0,
            timedOut: false,
            stdout: JSON.stringify({ ok: true, data: { meeting: { id: '734000000000000001' } } }),
            stderr: '',
          };
        }
        if (args.includes('/open-apis/vc/v1/realtime/endpoint')) {
          return {
            code: 0,
            timedOut: false,
            stdout: JSON.stringify({ ok: true, data: { websocket_url: 'wss://media.example.test/token' } }),
            stderr: '',
          };
        }
        if (args.includes('+meeting-leave')) {
          return {
            code: 0,
            timedOut: false,
            stdout: JSON.stringify({ ok: true, data: {} }),
            stderr: '',
          };
        }
        return {
          code: 0,
          timedOut: false,
          stdout: JSON.stringify({ ok: true, data: { events: [], page_token: 'next' } }),
          stderr: '',
        };
      },
    };
    const client = new LarkClient({
      profile: 'test-profile',
      larkCliBin: '/fake/lark-cli',
      projectDir: '/tmp',
      sendTimeoutMs: 5_000,
    }, registry, quietLogger);
    await client.joinMeeting({ meetingNumber: '123456789', callId: 'call-123' });
    await client.listMeetingEvents({ meetingId: '734000000000000001', pageToken: 'cursor' });
    assert.equal(
      await client.getMeetingRealtimeEndpoint('734000000000000001'),
      'wss://media.example.test/token',
    );
    await client.leaveMeeting('734000000000000001');
    assert.deepEqual(calls[0].args, [
      '--profile', 'test-profile', 'vc', '+meeting-join', '--as', 'bot',
      '--meeting-number', '123456789', '--call-id', 'call-123', '--format', 'json',
    ]);
    assert.deepEqual(calls[1].args, [
      '--profile', 'test-profile', 'vc', '+meeting-events', '--as', 'bot',
      '--meeting-id', '734000000000000001', '--page-token', 'cursor',
      '--page-all', '--format', 'json',
    ]);
    assert.deepEqual(calls[2].args, [
      '--profile', 'test-profile',
      'api', 'GET', '/open-apis/vc/v1/realtime/endpoint',
      '--as', 'bot', '--params', '{"meeting_id":"734000000000000001"}', '--json',
    ]);
    assert.deepEqual(calls[3].args, [
      '--profile', 'test-profile', 'vc', '+meeting-leave', '--as', 'bot',
      '--meeting-id', '734000000000000001', '--format', 'json',
    ]);
  });
});

describe('Lark subscriber process group', () => {
  async function waitUntilDead(pid, timeoutMs = 4_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch (error) {
        if (error.code === 'ESRCH') return true;
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  it('reaps leftover group members when the subscriber leader exits', {
    skip: process.platform === 'win32',
  }, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-subscriber-tree-'));
    const pidFile = path.join(directory, 'child.pid');
    const fakeLark = path.join(directory, 'fake-lark.mjs');
    fs.writeFileSync(fakeLark, `#!/usr/bin/env node
      import { spawn } from 'node:child_process';
      import fs from 'node:fs';
      const args = process.argv.slice(2);
      if (args.includes('event')) {
        const child = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        fs.writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
        setTimeout(() => process.exit(0), 50);
      } else {
        process.exit(0);
      }
    `, { mode: 0o700 });

    const unexpected = [];
    const client = new LarkClient({
      profile: 'test-profile',
      larkCliBin: fakeLark,
      projectDir: directory,
      maxEventBytes: 1_000_000,
    }, { register: (child) => child }, quietLogger);

    let descendantPid = 0;
    try {
      client.startSubscription(() => {}, (exit) => unexpected.push(exit));
      const deadline = Date.now() + 4_000;
      while (unexpected.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(unexpected.length, 1, 'subscriber leader should exit on its own');
      assert.ok(fs.existsSync(pidFile), 'leader must have spawned a descendant');
      descendantPid = Number.parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
      assert.equal(await waitUntilDead(descendantPid), true, 'descendant should die with the leader group');
    } finally {
      if (descendantPid) {
        try { process.kill(descendantPid, 'SIGKILL'); } catch {}
      }
      await client.stop();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
