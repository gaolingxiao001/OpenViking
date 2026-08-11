import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LarkClient, SUBSCRIBED_EVENT_TYPES } from '../src/lark.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

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
