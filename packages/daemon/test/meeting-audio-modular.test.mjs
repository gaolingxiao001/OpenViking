import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MeetingAdapter } from '../src/meeting/adapter.mjs';
import { MeetingAudioCoordinator, MeetingGenerationClock } from '../src/meeting/live-coordinator.mjs';
import { MeetingInputPort } from '../src/meeting/input-port.mjs';
import { MeetingMediaSupervisor } from '../src/meeting/media-supervisor.mjs';
import { Store } from '../src/store.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function envelope(type, id, event, atMs = Date.now()) {
  return {
    schema: '2.0',
    header: { event_id: id, event_type: type, tenant_key: 'tenant', create_time: String(atMs) },
    event,
  };
}

describe('modular meeting audio lifecycle', () => {
  let directory;
  let store;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-audio-modular-'));
    store = new Store(path.join(directory, 'state.sqlite3'), quietLogger);
  });

  afterEach(() => {
    try { store.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('joins once, starts a media-only worker, diverts Fly transcript, and stops before end flush', async () => {
    let handlers;
    let workerStops = 0;
    const acks = [];
    const workerFactory = {
      async start(_session, value) {
        handlers = value;
        return {
          ack: async (ack) => acks.push(ack),
          stop: async () => {
            workerStops += 1;
            await handlers.onEvent({
              type: 'final',
              sessionEpoch: 'epoch_test_12345678',
              captureGeneration: 1,
              segmentId: 'segment_flush1234',
              segmentSeq: 2,
              text: 'final emitted while draining',
            });
          },
        };
      },
    };
    const committed = [];
    const known = new Map();
    const spool = {
      enqueue(item) {
        const key = `${item.sessionEpoch}:${item.segmentId}`;
        if (known.has(key)) return { inserted: false, duplicate: true, item: known.get(key) };
        const stored = { ...item, generation: committed.length + 1 };
        committed.push(stored);
        known.set(key, stored);
        return { inserted: true, duplicate: false, item: stored };
      },
    };
    const ready = [];
    const generations = new MeetingGenerationClock();
    const input = new MeetingInputPort({
      spool,
      onReady: (item) => {
        generations.observe(item.sessionEpoch, item.generation);
        ready.push(item);
      },
    });
    const references = [];
    const flyReferences = {
      observe: (reference) => references.push(reference),
      clear() {},
    };
    let coordinator;
    const closeTimers = [];
    const revoked = [];
    const media = new MeetingMediaSupervisor({
      workerFactory,
      onFinal: (session, event) => input.accept(session, event),
      onUnavailable: (session) => coordinator.onUnavailable(session),
      epochFactory: () => 'epoch_test_12345678',
      logger: quietLogger,
    });
    coordinator = new MeetingAudioCoordinator({
      media,
      flyReferences,
      authority: { revokeSession: (epoch) => revoked.push(epoch) },
      targetChatId: 'oc_target12345678',
      generationClock: generations,
      mediaEndpointProvider: async () => 'wss://media.example.test/session-token',
      sessionCloseGraceMs: 100,
      setTimer(callback, delay) {
        const timer = { callback, delay, unref() {} };
        closeTimers.push(timer);
        return timer;
      },
      clearTimer() {},
      logger: quietLogger,
    });
    const joins = [];
    const adapter = new MeetingAdapter({
      store: store.meetings,
      lark: {
        async joinMeeting(value) {
          joins.push(value);
          return { data: { meeting: { id: 'meeting_12345678', meeting_no: '123456789' } } };
        },
        async listMeetingEvents() { return { data: { events: [], has_more: false } }; },
      },
      logger: quietLogger,
      batchDelayMs: 60_000,
      onJoined: (session) => coordinator.onJoined(session),
      onEnding: (event) => coordinator.onEnding(event),
      onFlyTranscript: (event) => coordinator.observeFlyTranscript(event),
    });
    const invite = envelope('vc.bot.meeting_invited_v1', 'invite-1', {
      meeting: { id: 'meeting_12345678', meeting_no: '123456789' },
      call_id: 'call-1',
    });
    await adapter.handleEvent(invite);
    await adapter.handleEvent(invite);
    assert.equal(joins.length, 1);
    const session = media.activeSession('meeting_12345678');
    assert.equal(session.state, 'STARTING');

    await handlers.onEvent({
      type: 'ready',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
    });
    await handlers.onEvent({
      type: 'partial',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
      text: 'do not commit',
    });
    await handlers.onEvent({
      type: 'final',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
      segmentId: 'segment_12345678',
      segmentSeq: 1,
      text: 'local final',
      audioStartMs: 100,
      audioEndMs: 200,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(committed.length, 1);
    assert.equal(ready.length, 1);
    assert.equal(acks.length, 1, 'worker is acked only after spool enqueue returns');

    await handlers.onEvent({
      type: 'final',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
      segmentId: 'segment_12345678',
      segmentSeq: 1,
      text: 'retry must not replace text',
      audioStartMs: 100,
      audioEndMs: 200,
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(committed.length, 1);
    assert.equal(ready.length, 1, 'duplicate final never wakes runtime again');
    assert.equal(generations.current(session.sessionEpoch), 1);
    assert.equal(acks.length, 2, 'duplicate is still acked so worker can drop its WAL copy');

    await adapter.handleEvent(envelope('vc.bot.meeting_activity_v1', 'fly-1', {
      meeting_activity_items: [{
        meeting: { id: 'meeting_12345678', meeting_no: '123456789' },
        activity_event_type: 'transcript_received',
        transcript_received_items: [{ sentence_id: 'fly-sentence-1', text: 'Fly reference' }],
      }],
    }));
    assert.equal(references.length, 1);
    assert.equal(store.stats().meetingEvents, 0, 'Fly transcript stays out of MeetingStore');

    await adapter.handleEvent(envelope('vc.bot.meeting_ended_v1', 'end-1', {
      meeting_id: 'meeting_12345678',
      meeting_no: '123456789',
    }));
    assert.equal(workerStops, 1);
    assert.equal(media.activeSession('meeting_12345678'), null);
    assert.equal(committed.length, 2, 'worker flush final is durably accepted while draining');
    assert.equal(ready.length, 2, 'worker flush final is delivered once');
    assert.equal(acks.length, 3, 'worker flush final is acked after durable enqueue');
    assert.equal(revoked.length, 0, 'the draining final keeps bounded decision authority');
    assert.equal(closeTimers.length, 1);

    await handlers.onEvent({
      type: 'final',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
      segmentId: 'segment_late1234',
      text: 'late final',
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(committed.length, 2, 'late generation final is rejected after stop');
    closeTimers[0].callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(revoked, [session.sessionEpoch], 'authority is revoked after the grace bound');
    await adapter.stop();
  });

  it('keeps meeting membership across a daemon stop', async () => {
    store.meetings.upsertMeetingInvite({
      sessionKey: 'call:daemon-restart',
      meetingNumber: '987654321',
      callId: 'daemon-restart',
      eventId: 'invite-daemon-restart',
    });
    store.meetings.markMeetingJoining('call:daemon-restart');
    store.meetings.markMeetingJoined('call:daemon-restart', {
      meetingId: 'meeting_daemon_restart',
      meetingNumber: '987654321',
    });
    let leaves = 0;
    const adapter = new MeetingAdapter({
      store: store.meetings,
      lark: {
        async leaveMeeting() { leaves += 1; },
      },
      logger: quietLogger,
    });
    await adapter.stop();
    assert.equal(leaves, 0);
    assert.equal(store.meetings.activeMeetingSessions().length, 1);
  });
});
