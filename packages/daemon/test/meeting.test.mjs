import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { cognitionHistoryPrefix } from '../src/cognition.mjs';
import { MeetingAdapter, normalizeMeetingEvent } from '../src/meeting.mjs';
import { Store } from '../src/store.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function envelope(type, id, event, atMs = Date.now()) {
  return {
    schema: '2.0',
    header: {
      event_id: id,
      event_type: type,
      tenant_key: 'tenant-test',
      create_time: String(atMs),
    },
    event,
  };
}

describe('TAT meeting adapter', () => {
  let directory;
  let store;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-meeting-test-'));
    store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
  });

  afterEach(() => {
    try { store.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('normalizes invite correlation fields without applying the IM schema', () => {
    const parsed = normalizeMeetingEvent(envelope('vc.bot.meeting_invited_v1', 'evt-invite', {
      meeting: { id: '734000000000000001', meeting_no: '123456789' },
      call_id: 'call-123',
    }));
    assert.equal(parsed.meetingNumber, '123456789');
    assert.equal(parsed.callId, 'call-123');
    assert.equal(parsed.meetingId, '734000000000000001');
  });

  it('auto-joins once and batches transcripts into the journal without a model turn', async () => {
    const joins = [];
    const lark = {
      async joinMeeting(input) {
        joins.push(input);
        return { ok: true, data: { meeting: { id: '734000000000000001', meeting_no: '123456789' } } };
      },
      async listMeetingEvents() { throw new Error('pull is recovery-only'); },
    };
    const adapter = new MeetingAdapter({
      store,
      lark,
      logger: quietLogger,
      batchDelayMs: 60_000,
    });
    const invite = envelope('vc.bot.meeting_invited_v1', 'evt-invite', {
      meeting: { id: '734000000000000001', meeting_no: '123456789' },
      call_id: 'call-123',
    });
    await adapter.handleEvent(invite);
    await adapter.handleEvent(invite); // duplicate delivery must not create a second visible join
    assert.deepEqual(joins, [{ meetingNumber: '123456789', callId: 'call-123' }]);

    await adapter.handleEvent(envelope('vc.bot.meeting_activity_v1', 'evt-a1', {
      meeting_activity_items: [{
        meeting: { id: '734000000000000001', meeting_no: '123456789' },
        activity_event_type: 'transcript_received',
        transcript_received_items: [{
          speaker: { id: 'ou-alice', user_name: 'Alice' },
          text: '第一句（partial）',
          sentence_id: 'sentence-1',
        }],
      }],
    }));
    await adapter.handleEvent(envelope('vc.bot.meeting_activity_v1', 'evt-a1-final', {
      meeting_activity_items: [{
        meeting: { id: '734000000000000001', meeting_no: '123456789' },
        activity_event_type: 'transcript_received',
        transcript_received_items: [{
          speaker: { id: 'ou-alice', user_name: 'Alice' },
          text: '第一句',
          sentence_id: 'sentence-1',
        }],
      }],
    }));
    await adapter.handleEvent(envelope('vc.bot.meeting_activity_v1', 'evt-a2', {
      meeting_activity_items: [{
        meeting: { id: '734000000000000001', meeting_no: '123456789' },
        activity_event_type: 'transcript_received',
        transcript_received_items: [{
          speaker: { id: 'ou-bob', user_name: 'Bob' },
          text: '第二句',
          sentence_id: 'sentence-2',
        }],
      }],
    }));
    await adapter.handleEvent(envelope('vc.bot.meeting_activity_v1', 'evt-a2', {
      meeting_activity_items: [{
        meeting: { id: '734000000000000001', meeting_no: '123456789' },
        activity_event_type: 'transcript_received',
        transcript_received_items: [{
          speaker: { id: 'ou-bob', user_name: 'Bob' },
          text: '第二句',
          sentence_id: 'sentence-2',
        }],
      }],
    }));

    assert.equal(store.stats().meetingEvents, 2);
    assert.equal(store.cognitionJournal().filter((row) => row.kind === 'meeting_context').length, 0);
    await adapter.flushMeeting('734000000000000001');
    const batches = store.cognitionJournal().filter((row) => row.kind === 'meeting_context');
    assert.equal(batches.length, 1);
    assert.match(batches[0].text, /Alice: 第一句/);
    assert.doesNotMatch(batches[0].text, /partial/);
    assert.match(batches[0].text, /Bob: 第二句/);

    // A meeting batch becomes catch-up context only when the next real IM message
    // starts a turn; the adapter itself has no runtime/delivery dependency.
    const inbound = store.ingest({
      eventId: 'evt-im',
      messageId: 'om-im',
      conversationKey: 'test:tenant:oc-chat:main',
      chatId: 'oc-chat',
      chatType: 'p2p',
      messageType: 'text',
      senderId: 'ou-user',
      senderType: 'user',
      rootId: null,
      parentId: null,
      threadId: null,
      threadRootId: null,
      content: '会议讲到哪了？',
      mentions: [],
      createTimeMs: Date.now(),
    }).inbound;
    const through = store.cognitionJournalBeforeInbound(inbound.seq);
    const prefix = cognitionHistoryPrefix(store, store.getCognitionState().epoch, through).text;
    assert.match(prefix, /kind=meeting_context/);
    assert.match(prefix, /第一句/);
    await adapter.stop();
  });

  it('uses a saved cursor only during restart recovery and persists recovered transcript', async () => {
    store.upsertMeetingInvite({
      sessionKey: 'call:recover',
      meetingNumber: '987654321',
      callId: 'recover',
      eventId: 'evt-recover-invite',
    });
    store.markMeetingJoining('call:recover');
    store.markMeetingJoined('call:recover', {
      meetingId: '734000000000000099',
      meetingNumber: '987654321',
    });
    store.updateMeetingProgress('734000000000000099', { pageToken: 'cursor-before' });
    const pulls = [];
    const adapter = new MeetingAdapter({
      store,
      logger: quietLogger,
      batchDelayMs: 60_000,
      lark: {
        async joinMeeting() { throw new Error('not expected'); },
        async listMeetingEvents(input) {
          pulls.push(input);
          return {
            ok: true,
            data: {
              events: [{
                event_type: 'transcript_received',
                event_time: '2026-08-10T12:00:00Z',
                payload: {
                  transcript_received_items: [{
                    speaker: { id: 'ou-carol', user_name: 'Carol' },
                    text: '恢复内容',
                    sentence_id: 'sentence-recovered',
                  }],
                },
              }],
              page_token: 'cursor-after',
              has_more: false,
            },
          };
        },
      },
    });
    await adapter.start();
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0].pageToken, 'cursor-before');
    await adapter.stop();
    assert.equal(store.meetingSessionById('734000000000000099').pageToken, 'cursor-after');
    assert.match(
      store.cognitionJournal().find((row) => row.kind === 'meeting_context').text,
      /恢复内容/,
    );
    assert.equal(
      store.cognitionJournal().find((row) => row.kind === 'meeting_context').atMs,
      Date.parse('2026-08-10T12:00:00Z'),
    );
  });

  it('merges an activity-created placeholder when join completion arrives', () => {
    store.upsertMeetingInvite({
      sessionKey: 'call:race',
      meetingNumber: '123456789',
      callId: 'race',
      eventId: 'evt-race',
    });
    store.markMeetingJoining('call:race');
    store.ensureMeetingSession('734000000000000777', {
      meetingNumber: '123456789',
      atMs: 100,
    });
    store.updateMeetingProgress('734000000000000777', {
      pageToken: 'cursor-from-push',
      eventAtMs: 200,
    });
    const joined = store.markMeetingJoined('call:race', {
      meetingId: '734000000000000777',
      meetingNumber: '123456789',
      atMs: 300,
    });
    assert.equal(joined.sessionKey, 'call:race');
    assert.equal(joined.pageToken, 'cursor-from-push');
    assert.equal(store.activeMeetingSessions().length, 1);
  });
});
