import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { LarkDaemon } from '../src/daemon.mjs';
import {
  FlyReferenceRing,
  GenericDecisionAuthority,
  LiveSpool,
  MeetingAdapter,
  MeetingAudioCoordinator,
  MeetingGenerationClock,
  MeetingInputPort,
  MeetingMediaSupervisor,
  MeetingRuntimeAdapter,
  StdioMeetingWorkerFactory,
} from '../src/meeting/index.mjs';
import { Store } from '../src/store.mjs';
import { normalizeLarkEvent } from '../src/connectors/lark-events.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function envelope(type, id, event, atMs = Date.now()) {
  return normalizeLarkEvent({
    schema: '2.0',
    header: { event_id: id, event_type: type, tenant_key: 'tenant', create_time: String(atMs) },
    event,
  }).data.meeting;
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
}

describe('meeting audio runtime vertical slice', () => {
  let directory;
  let store;
  let spool;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-audio-runtime-'));
    store = new Store(path.join(directory, 'main.sqlite3'), quietLogger);
    spool = new LiveSpool(path.join(directory, 'meeting-audio.sqlite3'));
  });

  afterEach(() => {
    try { spool.close(); } catch {}
    try { store.close(); } catch {}
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('runs join → final spool → target-free start/steer → receipt settlement without polluting MeetingStore', async () => {
    const runtimeToken = 'runtime_token_12345678';
    const generations = new MeetingGenerationClock();
    const flyReferences = new FlyReferenceRing();
    const authority = new GenericDecisionAuthority({
      runtimeToken,
      getCurrentGeneration: (epoch) => generations.current(epoch),
      getLatestLarkSeq: () => 0,
    });
    const deliveries = [];
    const modes = [];
    const runtime = {
      turnInProgress: false,
      submit(items) {
        modes.push(this.turnInProgress ? 'steer' : 'start');
        this.turnInProgress = true;
        deliveries.push(...items);
        return { accepted: true };
      },
    };
    const runtimeAdapter = new MeetingRuntimeAdapter({
      spool,
      generationClock: generations,
      flyReferences,
      runtime,
      submitIngress: async (action) => await action(),
      flushBufferedIngress() {},
      logger: quietLogger,
    });
    runtimeAdapter.start();

    let workerHandlers;
    let workerStarts = 0;
    let workerStops = 0;
    const workerAcks = [];
    const input = new MeetingInputPort({
      spool,
      onReady: (item) => runtimeAdapter.onReady(item),
    });
    let coordinator;
    const media = new MeetingMediaSupervisor({
      workerFactory: {
        async start(session, handlers) {
          workerStarts += 1;
          workerHandlers = handlers;
          assert.match(session.mediaEndpoint, /^wss:\/\//);
          return {
            ack: async (ack) => workerAcks.push(ack),
            stop: async () => { workerStops += 1; },
          };
        },
      },
      onFinal: (session, event) => input.accept(session, event),
      onUnavailable: (session) => coordinator.onUnavailable(session),
      epochFactory: () => 'epoch_runtime_12345678',
      logger: quietLogger,
    });
    coordinator = new MeetingAudioCoordinator({
      media,
      flyReferences,
      authority,
      generationClock: generations,
      mediaEndpointProvider: async () => 'wss://media.example.test/short-lived-token',
      onSessionClosed: (closedSession) => spool.retireSession(closedSession.sessionEpoch),
      logger: quietLogger,
    });
    const inbox = [];
    const adapter = new MeetingAdapter({
      store: store.meetings,
      lark: {
        async joinMeeting() {
          return { data: { meeting: { id: 'meeting_runtime_1234', meeting_no: '123456789' } } };
        },
        async listMeetingEvents() { return { data: { events: [] } }; },
      },
      logger: quietLogger,
      batchDelayMs: 60_000,
      onInboxReady: (batch) => inbox.push(batch),
      onJoined: (session) => coordinator.onJoined(session),
      onEnding: (event) => coordinator.onEnding(event),
      onFlyTranscript: (event) => coordinator.observeFlyTranscript(event),
    });

    await adapter.handleEvent(envelope('vc.bot.meeting_invited_v1', 'invite-runtime', {
      meeting: { id: 'meeting_runtime_1234', meeting_no: '123456789' },
    }));
    assert.equal(workerStarts, 1);
    const session = media.activeSession('meeting_runtime_1234');
    await workerHandlers.onEvent({
      type: 'ready',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
    });

    await adapter.handleEvent(envelope('vc.bot.meeting_activity_v1', 'fly-runtime', {
      meeting_activity_items: [{
        meeting: { id: 'meeting_runtime_1234', meeting_no: '123456789' },
        activity_event_type: 'transcript_received',
        transcript_received_items: [{
          sentence_id: 'fly-runtime-1',
          text: 'Fly-only context',
          // Fly is delayed context for an older segment; it should be attached
          // to the next local ASR trigger even though audio windows do not overlap.
          start_time_ms: 100,
          end_time_ms: 200,
        }],
      }],
    }));
    await tick();
    assert.equal(deliveries.length, 0, 'Fly reference alone never starts or steers a turn');

    const final = async (segmentId, segmentSeq, text) => {
      await workerHandlers.onEvent({
        type: 'final',
        sessionEpoch: session.sessionEpoch,
        captureGeneration: session.captureGeneration,
        segmentId,
        segmentSeq,
        text,
        audioStartMs: 1_000 + segmentSeq * 100,
        audioEndMs: 1_080 + segmentSeq * 100,
      });
      await tick();
    };
    await final('segment_runtime_0001', 1, 'first local final');
    await final('segment_runtime_0002', 2, 'second local final');
    assert.deepEqual(modes, ['start', 'steer']);
    assert.equal(deliveries.length, 2);
    assert.match(deliveries[0].text, /Fly-only context/);
    assert.match(deliveries[0].text, /source=local_asr no_source=true/);
    assert.match(deliveries[0].text, /speaker=unknown/);
    assert.doesNotMatch(deliveries[0].text, /target_chat=/);
    assert.doesNotMatch(deliveries[0].text, /decision_capability=/);
    assert.doesNotMatch(deliveries[1].text, /target_chat=/);
    assert.doesNotMatch(deliveries[1].text, /decision_capability=/);
    assert.deepEqual(spool.stats(), {
      pending: 0,
      inflight: 2,
      consumed: 0,
      items: 2,
      sessions: 1,
    });
    assert.equal(workerAcks.length, 2, 'worker finals are ACKed after durable spool commit');
    assert.equal(store.stats().meetingEvents, 0, 'local ASR never enters the normal meeting database');

    runtimeAdapter.onTurnSucceeded({ receiptIds: deliveries.map((item) => item.receiptId) });
    assert.equal(spool.stats().consumed, 2);
    assert.equal(authority.stats().active, 0, 'ASR ingress never mints delivery authority');

    const stranded = spool.enqueue({
      sessionEpoch: session.sessionEpoch,
      segmentId: 'segment_runtime_stranded',
      meetingId: session.meetingId,
      text: 'must not replay after meeting end',
      speaker: 'unknown',
      final: true,
    }).item;
    spool.claim({ sessionEpoch: session.sessionEpoch, limit: 1 });

    await adapter.handleEvent(envelope('vc.bot.meeting_ended_v1', 'end-runtime', {
      meeting_id: 'meeting_runtime_1234',
      meeting_no: '123456789',
    }));
    assert.equal(workerStops, 1);
    assert.equal(media.activeSession('meeting_runtime_1234'), null);
    assert.equal(authority.stats().active, 0);
    assert.equal(spool.get(stranded.inputId).status, 'inflight');
    spool.release(stranded.inputId);
    const deliveryCountAtEnd = deliveries.length;
    assert.equal(await runtimeAdapter._drain(), null);
    assert.equal(deliveries.length, deliveryCountAtEnd + 1, 'accepted pre-stop input remains durable');
    assert.equal(
      flyReferences.snapshot({ meetingId: 'meeting_runtime_1234' }).length,
      1,
      'meeting end keeps volatile Fly references until their TTL expires',
    );

    const inboxBeforeOtherMeeting = inbox.length;
    await adapter.handleEvent(envelope('vc.bot.meeting_activity_v1', 'chat-runtime', {
      meeting_activity_items: [{
        meeting: { id: 'meeting_other_1234', meeting_no: '987654321' },
        activity_event_type: 'chat_message_received',
        chat_message_received_items: [{ message_id: 'chat-item-runtime', text: 'normal meeting chat' }],
      }],
    }));
    await adapter.flushMeeting('meeting_other_1234', { all: true });
    assert.equal(
      inbox.length,
      inboxBeforeOtherMeeting + 1,
      'non-transcript meeting input keeps the existing inbox route',
    );

    runtimeAdapter.stop();
    await coordinator.stop();
    await adapter.stop();
  });

  it('keeps joined ownership and applies bounded exponential worker restart', async () => {
    const handlers = [];
    const timers = [];
    let epoch = 0;
    const revoked = [];
    const closed = [];
    const generations = new MeetingGenerationClock();
    const authority = new GenericDecisionAuthority({
      runtimeToken: 'runtime_crash_12345678',
      getCurrentGeneration: (sessionEpoch) => generations.current(sessionEpoch),
    });
    const revokeSession = authority.revokeSession.bind(authority);
    authority.revokeSession = (sessionEpoch) => {
      revoked.push(sessionEpoch);
      return revokeSession(sessionEpoch);
    };
    let coordinator;
    const media = new MeetingMediaSupervisor({
      workerFactory: {
        async start(_session, callbacks) {
          handlers.push(callbacks);
          return { ack() {}, stop() {} };
        },
      },
      onFinal() {},
      onUnavailable: (session, reason) => coordinator.onUnavailable(session, reason),
      onState: (session) => coordinator?.onMediaState(session),
      epochFactory: () => `epoch_crash_${++epoch}_12345678`,
    });
    coordinator = new MeetingAudioCoordinator({
      media,
      flyReferences: new FlyReferenceRing(),
      authority,
      targetChatId: 'oc_target12345678',
      generationClock: generations,
      mediaEndpointProvider: async () => 'wss://media.example.test/crash',
      onSessionClosed: (session, reason) => closed.push({ session, reason }),
      restartBaseDelayMs: 10,
      restartMaxDelayMs: 20,
      restartMaxAttempts: 3,
      sessionCloseGraceMs: 1_000,
      setTimer(callback, delay) {
        const timer = { callback, delay, cleared: false, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimer: (timer) => { timer.cleared = true; },
    });
    await coordinator.onJoined({
      meetingId: 'meeting_crash_1234',
      meetingNumber: '123456789',
    });
    await handlers[0].onEvent({
      type: 'ready', sessionEpoch: 'epoch_crash_1_12345678', captureGeneration: 1,
    });
    generations.observe('epoch_crash_1_12345678', 1);
    const stale = authority.issue({
      sessionEpoch: 'epoch_crash_1_12345678',
      generation: 1,
      decisionKey: 'decision_before_crash',
      action: 'send_lark_message',
      target: 'oc_target12345678',
    }).capability;
    await handlers[0].onExit({ code: 1 });
    await tick();
    assert.ok(coordinator.activeJoinedSession('meeting_crash_1234'));
    assert.equal(media.state('meeting_crash_1234'), null);
    assert.deepEqual(timers.filter((timer) => timer.delay < 1_000).map((timer) => timer.delay), [10]);

    timers.filter((timer) => timer.delay < 1_000).at(-1).callback();
    await tick();
    assert.equal(
      media.activeSession('meeting_crash_1234').sessionEpoch,
      'epoch_crash_2_12345678',
    );
    assert.throws(() => authority.claim(stale, {
      runtimeToken: 'runtime_crash_12345678',
      action: 'send_lark_message',
      target: 'oc_target12345678',
    }), /unknown|revoked/);

    for (const expectedDelay of [20, 20]) {
      await handlers.at(-1).onExit({ code: 1 });
      await tick();
      assert.equal(timers.filter((timer) => timer.delay < 1_000).at(-1).delay, expectedDelay);
      timers.filter((timer) => timer.delay < 1_000).at(-1).callback();
      await tick();
    }
    await handlers.at(-1).onExit({ code: 1 });
    await tick();
    assert.equal(handlers.length, 4, 'initial worker plus three bounded restarts');
    assert.deepEqual(timers.filter((timer) => timer.delay < 1_000).map((timer) => timer.delay), [10, 20, 20]);
    assert.equal(revoked.length, 4, 'each crashed worker epoch is revoked before replacement');
    assert.equal(closed[0].reason.reason, 'worker_exit');
    await coordinator.stop();
  });

  it('resets the restart budget once per successful replacement LIVE transition', async () => {
    const handlers = [];
    const timers = [];
    let epoch = 0;
    let coordinator;
    const media = new MeetingMediaSupervisor({
      workerFactory: {
        async start(_session, callbacks) {
          handlers.push(callbacks);
          return { ack() {}, stop() {} };
        },
      },
      onFinal() {},
      onUnavailable: (session, reason) => coordinator.onUnavailable(session, reason),
      onState: (session) => coordinator?.onMediaState(session),
      epochFactory: () => `epoch_live_reset_${++epoch}_12345678`,
    });
    coordinator = new MeetingAudioCoordinator({
      media,
      flyReferences: new FlyReferenceRing(),
      authority: { revokeSession() {} },
      targetChatId: 'oc_target12345678',
      generationClock: new MeetingGenerationClock(),
      mediaEndpointProvider: async () => 'wss://media.example.test/live-reset',
      onSessionClosed() {},
      restartBaseDelayMs: 10,
      restartMaxDelayMs: 100,
      restartMaxAttempts: 1,
      setTimer(callback, delay) {
        const timer = { callback, delay, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimer() {},
    });
    await coordinator.onJoined({
      meetingId: 'meeting_live_reset_1234',
      meetingNumber: '123456789',
    });

    for (let cycle = 0; cycle < 6; cycle += 1) {
      const session = media.activeSession('meeting_live_reset_1234');
      await handlers[cycle].onEvent({
        type: 'ready',
        sessionEpoch: session.sessionEpoch,
        captureGeneration: session.captureGeneration,
      });
      await tick();
      assert.equal(coordinator.activeJoinedSession(session.meetingId).restartAttempts, 0);
      assert.equal(
        coordinator.onMediaState({ ...session, state: 'LIVE' }),
        false,
        'a duplicate LIVE state for the same worker epoch does not reset again',
      );

      await handlers[cycle].onExit({ code: 1 });
      await tick();
      assert.equal(coordinator.activeJoinedSession(session.meetingId).restartAttempts, 1);
      const timer = timers.at(-1);
      assert.equal(timer.delay, 10);
      timer.callback();
      await tick();
    }

    assert.equal(handlers.length, 7, 'six crash → LIVE cycles all receive a replacement worker');
    assert.deepEqual(timers.slice(-6).map((timer) => timer.delay), [10, 10, 10, 10, 10, 10]);
    await coordinator.stop();
  });

  it('restarts a degraded media worker without waiting on its own event task', async () => {
    const handlers = [];
    const timers = [];
    let stops = 0;
    let epoch = 0;
    let coordinator;
    const media = new MeetingMediaSupervisor({
      workerFactory: {
        async start(_session, callbacks) {
          handlers.push(callbacks);
          return {
            ack() {},
            async stop() { stops += 1; },
          };
        },
      },
      onFinal() {},
      onUnavailable: (session, reason) => coordinator.onUnavailable(session, reason),
      onState: (session) => coordinator?.onMediaState(session),
      epochFactory: () => `epoch_degraded_${++epoch}_12345678`,
      logger: quietLogger,
    });
    coordinator = new MeetingAudioCoordinator({
      media,
      flyReferences: new FlyReferenceRing(),
      authority: { revokeSession() {} },
      generationClock: new MeetingGenerationClock(),
      mediaEndpointProvider: async () => 'wss://media.example.test/degraded',
      onSessionClosed() {},
      restartBaseDelayMs: 10,
      restartMaxDelayMs: 100,
      restartMaxAttempts: 2,
      setTimer(callback, delay) {
        const timer = { callback, delay, unref() {} };
        timers.push(timer);
        return timer;
      },
      clearTimer() {},
      logger: quietLogger,
    });
    const session = await coordinator.onJoined({
      meetingId: 'meeting_degraded_1234',
      meetingNumber: '123456789',
    });
    handlers[0].onEvent({
      type: 'ready',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
    });
    await tick();
    handlers[0].onEvent({
      type: 'degraded',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
      reason: 'media_stream_closed',
    });
    await tick();
    await tick();

    assert.equal(stops, 1);
    assert.equal(media.state(session.meetingId), null);
    assert.equal(timers.at(-1).delay, 10);
    timers.at(-1).callback();
    await tick();
    assert.equal(handlers.length, 2, 'the replacement worker starts after degradation');
    await coordinator.stop();
  });

  it('uses one credential-stripped stdio worker process per meeting session', async () => {
    const children = [];
    const spawnOptions = [];
    const commands = [];
    const diagnostics = [];
    const spawn = (_command, _args, options) => {
      spawnOptions.push(options);
      const child = new EventEmitter();
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.exitCode = null;
      child.stdin.on('data', (chunk) => {
        for (const line of String(chunk).trim().split('\n')) {
          if (!line) continue;
          const command = JSON.parse(line);
          commands.push(command);
          if (command.command === 'stop') {
            queueMicrotask(() => {
              child.exitCode = 0;
              child.emit('exit', 0, null);
            });
          }
        }
      });
      children.push(child);
      return child;
    };
    const factory = new StdioMeetingWorkerFactory({
      command: '/usr/bin/python3',
      args: ['worker.py'],
      env: {
        PATH: '/usr/bin',
        SECRET_TOKEN: 'must-not-leak',
        GITHUB_TOKEN: 'must-not-leak',
        LARK_DAEMON_PROFILE: 'must-not-leak',
        FEISHU_APP_SECRET: 'must-not-leak',
      },
      spawn,
      logger: {
        debug(event, fields) { diagnostics.push({ level: 'debug', event, fields }); },
        warn(event, fields) { diagnostics.push({ level: 'warn', event, fields }); },
      },
    });
    const events = [];
    const exits = [];
    const session = {
      meetingId: 'meeting_stdio_1234',
      meetingNumber: '123456789',
      sessionEpoch: 'epoch_stdio_12345678',
      captureGeneration: 1,
      mediaEndpoint: 'wss://media.example.test/short-token',
    };
    const first = await factory.start(session, {
      onEvent: (event) => events.push(event),
      onExit: (event) => exits.push(event),
    });
    assert.equal(children.length, 1);
    assert.equal(spawnOptions[0].env.LARK_DAEMON_PROFILE, undefined);
    assert.equal(spawnOptions[0].env.FEISHU_APP_SECRET, undefined);
    assert.equal(spawnOptions[0].env.SECRET_TOKEN, undefined);
    assert.equal(spawnOptions[0].env.GITHUB_TOKEN, undefined);
    assert.equal(commands[0].command, 'start');
    assert.equal(commands[0].media_endpoint, session.mediaEndpoint);
    children[0].stdout.write(`${JSON.stringify({
      v: 1,
      type: 'transcript.final',
      session_epoch: session.sessionEpoch,
      capture_generation: 1,
      event_id: 'segment_stdio_1234',
      text: 'stdio final',
    })}\n`);
    await tick();
    assert.equal(events[0].type, 'final');
    children[0].stdout.write(`${JSON.stringify({
      v: 1,
      type: 'health',
      session_epoch: session.sessionEpoch,
      capture_generation: 1,
      audio: 'healthy',
      asr: 'healthy',
      last_audio_at_ms: 1_786_730_000_000,
      audio_samples: 120_000,
      audio_peak: 321,
      audio_rms: 12.5,
      audio_nonzero_ratio: 0.25,
    })}\n`);
    await tick();
    assert.deepEqual(events[1], {
      type: 'health',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: 1,
      segmentId: undefined,
      segmentSeq: undefined,
      text: undefined,
      audioStartMs: null,
      audioEndMs: null,
      audio: 'healthy',
      asr: 'healthy',
      reason: undefined,
      lastAudioAtMs: 1_786_730_000_000,
      audioSamples: 120_000,
      audioPeak: 321,
      audioRms: 12.5,
      audioNonzeroRatio: 0.25,
    });
    await first.ack({
      sessionEpoch: session.sessionEpoch,
      captureGeneration: 1,
      segmentId: 'segment_stdio_1234',
    });
    assert.equal(commands.at(-1).command, 'ack');
    await first.stop({ reason: 'meeting_ended' });
    assert.equal(commands.at(-1).command, 'stop');
    assert.equal(exits.length, 0, 'a requested logical stop is not reported as a crash');

    const second = await factory.start({
      ...session,
      meetingId: 'meeting_stdio_5678',
      sessionEpoch: 'epoch_stdio_87654321',
    }, { onEvent() {}, onExit() {} });
    assert.equal(children.length, 2, 'the next meeting gets a fresh isolated process');
    await second.stop({ reason: 'test_complete' });

    const unexpectedExits = [];
    await factory.start({
      ...session,
      meetingId: 'meeting_stdio_9012',
      sessionEpoch: 'epoch_stdio_11223344',
    }, { onEvent() {}, onExit: (event) => unexpectedExits.push(event) });
    children[2].stderr.write('media websocket closed\n');
    children[2].emit('exit', 2, null);
    await tick();
    assert.deepEqual(unexpectedExits, [{
      reason: 'process_exit',
      code: 2,
      signal: null,
      stderrBytes: 23,
    }]);
    assert.deepEqual(diagnostics.at(-1), {
      level: 'warn',
      event: 'meeting_worker_exited',
      fields: {
        code: 2,
        signal: null,
        stderr: 'media websocket closed',
        stderrBytes: 23,
      },
    });
  });

  it('accepts both definite and fallback-final POC transcript events', () => {
    const workerPath = fileURLToPath(new URL('../worker/meeting_asr_worker.py', import.meta.url));
    const script = `
import importlib.util, types
spec = importlib.util.spec_from_file_location("meeting_asr_worker", ${JSON.stringify(workerPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
assert module.is_final_result(types.SimpleNamespace(kind="definite", text="a"))
assert module.is_final_result(types.SimpleNamespace(kind="final", text="fallback"))
assert not module.is_final_result(types.SimpleNamespace(kind="partial", text="no"))
`;
    const result = spawnSync('python3', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it('surfaces a failed ASR sender and never deadlocks on a full audio queue', () => {
    const workerPath = fileURLToPath(new URL('../worker/meeting_asr_worker.py', import.meta.url));
    const script = `
import asyncio, importlib.util, types
spec = importlib.util.spec_from_file_location("meeting_asr_worker", ${JSON.stringify(workerPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Recorder:
    def __init__(self): self.events = []
    def emit(self, event_type, session, **fields):
        value = {"type": event_type, **fields}
        self.events.append(value)
        return value

class FakeWebsockets:
    async def connect(self, *args, **kwargs): return object()

class ProviderError(RuntimeError):
    code = 450000

def build_worker(backend_type, byteview_type, queue_size=1):
    worker = module.MeetingAsrWorker.__new__(module.MeetingAsrWorker)
    worker.VolcStreamingASRClient = backend_type
    worker.ByteViewClient = byteview_type
    worker.websockets = FakeWebsockets()
    worker.config = {"volc_audio_queue_size": queue_size}
    worker.api_key = "not-a-real-key"
    worker.protocol = Recorder()
    worker.session = {
        "session_epoch": "epoch_worker_test_12345678",
        "capture_generation": 1,
        "meeting_id": "meeting_worker_test_1234",
        "meeting_no": "123456789",
        "media_endpoint": "wss://media.example.test/token",
    }
    worker.stop_event = asyncio.Event()
    worker.pending_finals = {}
    worker.final_utterances = module.FinalUtteranceGate()
    worker.segment_seq = 0
    worker.last_audio_at_ms = None
    worker.audio_window_samples = 0
    worker.audio_window_nonzero = 0
    worker.audio_window_peak = 0
    worker.audio_window_sum_squares = 0
    worker._observe_audio = lambda pcm: None
    worker._resample = lambda pcm: pcm
    return worker

class BaseBackend:
    last = None
    def __init__(self, *args, **kwargs):
        type(self).last = self
        self.audio_origin_at = None
        self.request_id = "provider-request"
        self.aborted = False
        self.finished = False
    async def start(self, callback): self.callback = callback
    async def abort(self): self.aborted = True
    async def finish(self): self.finished = True

class FailedBackend(BaseBackend):
    async def feed_pcm(self, pcm): raise ProviderError("secret detail")

class FailedByteView:
    def __init__(self, **kwargs): self.ws = None
    async def create_session(self, **kwargs): pass
    async def listen(self, on_audio):
        await on_audio(b"\\x01\\x00")
        await asyncio.Event().wait()
    async def close(self): pass

class WedgedBackend(BaseBackend):
    async def feed_pcm(self, pcm): await asyncio.Event().wait()

class OverflowByteView:
    def __init__(self, **kwargs): self.ws = None
    async def create_session(self, **kwargs): pass
    async def listen(self, on_audio):
        await on_audio(b"\\x01\\x00")
        await on_audio(b"\\x02\\x00")
        await asyncio.Event().wait()
    async def close(self): pass

async def verify():
    failed = build_worker(FailedBackend, FailedByteView)
    await asyncio.wait_for(failed.run_session(), timeout=0.5)
    assert [event.get("reason") for event in failed.protocol.events if event["type"] == "degraded"] == ["ProviderError_450000"]
    assert FailedBackend.last.aborted and not FailedBackend.last.finished

    overflow = build_worker(WedgedBackend, OverflowByteView)
    await asyncio.wait_for(overflow.run_session(), timeout=0.5)
    assert [event.get("reason") for event in overflow.protocol.events if event["type"] == "degraded"] == ["audio_queue_overflow"]
    assert WedgedBackend.last.aborted and not WedgedBackend.last.finished

asyncio.run(verify())
`;
    const result = spawnSync('python3', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it('loads the legacy private setup ASR token without putting it in worker env', () => {
    const workerPath = fileURLToPath(new URL('../worker/meeting_asr_worker.py', import.meta.url));
    const script = `
import importlib.util, pathlib, tempfile, yaml
spec = importlib.util.spec_from_file_location("meeting_asr_worker", ${JSON.stringify(workerPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as directory:
    path = pathlib.Path(directory) / ".setup.md"
    path.write_text("Zayn:\\nignored\\n\\nASR:\\nprivate-token\\n", encoding="utf-8")
    config = module.load_private_config(path, yaml)
    assert config == {"doubao_api_key": "private-token"}
`;
    const result = spawnSync('python3', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it('steers once for a second-pass correction without text-deduping later speech', () => {
    const workerPath = fileURLToPath(new URL('../worker/meeting_asr_worker.py', import.meta.url));
    const script = `
import importlib.util, types
spec = importlib.util.spec_from_file_location("meeting_asr_worker", ${JSON.stringify(workerPath)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
clock = [10.0]
gate = module.FinalUtteranceGate(now=lambda: clock[0])

first = types.SimpleNamespace(
    index=1, start_ms=100, end_ms=900, sequence=10, text="重复文本")
same_text_correction = types.SimpleNamespace(
    index=1, start_ms=100, end_ms=900, sequence=11, text="重复文本")
changed_text_correction = types.SimpleNamespace(
    index=1, start_ms=120, end_ms=920, sequence=12, text="修正文本")
later_same_words = types.SimpleNamespace(
    index=2, start_ms=1500, end_ms=2200, sequence=13, text="重复文本")

assert gate.accept(first, "provider-request-1", "meeting-epoch", 1100, 1900)["accepted"]
assert not gate.accept(
    same_text_correction, "provider-request-1", "meeting-epoch", 1100, 1900
)["accepted"]
assert not gate.accept(
    changed_text_correction, "provider-request-1", "meeting-epoch", 1120, 1920
)["accepted"]
assert gate.accept(
    later_same_words, "provider-request-1", "meeting-epoch", 2500, 3200
)["accepted"]

# Provider request ids change on reconnect, but absolute media time stays in
# the meeting session scope and still identifies the correction.
assert not gate.accept(
    first, "provider-request-2", "meeting-epoch", 1100, 1900
)["accepted"]
assert gate.accept(
    first, "provider-request-2", "meeting-epoch", 4100, 4900
)["accepted"]

# With no provider identity/range, only an exact immediate correction is
# suppressed. The same real phrase remains valid after the short window.
unknown_a = types.SimpleNamespace(sequence=20, text="好")
unknown_b = types.SimpleNamespace(sequence=21, text="好")
assert gate.accept(unknown_a, "provider-request-3")["accepted"]
clock[0] = 11.0
duplicate = gate.accept(unknown_b, "provider-request-3")
assert not duplicate["accepted"]
assert duplicate["reason"] == "unkeyed_immediate_text_revision"
clock[0] = 13.1
assert gate.accept(unknown_b, "provider-request-3")["accepted"]
`;
    const result = spawnSync('python3', ['-c', script], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    assert.equal(result.status, 0, result.stderr);
  });

  it('closes the meeting plugin before stopping the model runtime', async () => {
    const order = [];
    const daemon = new LarkDaemon({
      dataDir: directory,
      lockPath: path.join(directory, 'unused.lock'),
      shutdownTimeoutMs: 100,
    }, quietLogger);
    daemon.recordSystemActivity = () => false;
    daemon.connectors = { async pauseSubscriptions() { order.push('lark-stop'); }, async stop() {} };
    let releaseIngress;
    const ingressBarrier = new Promise((resolve) => { releaseIngress = resolve; });
    daemon.harness = {
      ingressBarrier,
      stop() { order.push('burst-stop'); },
    };
    daemon.meeting = {
      async stop({ drainIngress }) {
        order.push('plugin-stop-start');
        queueMicrotask(() => {
          order.push('ingress-drained');
          releaseIngress();
        });
        await drainIngress();
        order.push('plugin-stop-done');
      },
    };
    daemon.agentRuntime = { async stop() { order.push('model-stop'); } };
    daemon.registry = { async stopAll() { order.push('registry-stop'); } };
    daemon.store = { close() { order.push('store-close'); } };
    daemon.lock = { release() { order.push('lock-release'); } };
    const priorExitCode = process.exitCode;
    try {
      await daemon.shutdown('test', 0);
    } finally {
      process.exitCode = priorExitCode;
    }
    const index = (event) => order.indexOf(event);
    assert.ok(index('plugin-stop-start') < index('ingress-drained'));
    assert.ok(index('ingress-drained') < index('plugin-stop-done'));
    assert.ok(index('plugin-stop-done') < index('model-stop'));
  });

  it('settles successful, failed, and abandoned target-free ingress receipts safely', async () => {
    const generations = new MeetingGenerationClock();
    const deliveries = [];
    const adapter = new MeetingRuntimeAdapter({
      spool,
      generationClock: generations,
      flyReferences: new FlyReferenceRing(),
      runtime: {
        submit(items) {
          deliveries.push(...items);
          return { accepted: true };
        },
      },
      submitIngress: async (action) => await action(),
      retryMs: 1,
      logger: quietLogger,
    });
    const enqueue = (sessionEpoch, segmentId, text) => spool.enqueue({
      sessionEpoch,
      segmentId,
      meetingId: 'meeting_settlement_1234',
      text,
      speaker: 'unknown',
      audioStartMs: 1,
      audioEndMs: 2,
      final: true,
    }).item;
    const settleTick = async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await tick();
    };

    // A successful turn, including a silent decision, consumes its durable input.
    const silent = enqueue('epoch_silent_12345678', 'segment_silent_1234', 'silent decision');
    adapter.onReady(silent);
    await tick();
    assert.doesNotMatch(deliveries.at(-1).text, /target_chat=|decision_capability=/);
    adapter.onTurnSucceeded({ receiptIds: [silent.inputId] });
    assert.equal(spool.get(silent.inputId).status, 'consumed');

    // Failures and abandonment release the same ingress receipt for retry. Any
    // Lark send is an independently fenced Agent action, not ASR adapter state.
    const retried = enqueue('epoch_retry_12345678', 'segment_retry_12345', 'retry decision');
    adapter.onReady(retried);
    await tick();
    const firstRetryText = deliveries.at(-1).text;
    const firstRetryDeliveryCount = deliveries.length;
    adapter.onTurnFailed({ receiptIds: [retried.inputId] });
    assert.equal(spool.get(retried.inputId).status, 'pending');
    await settleTick();
    assert.equal(deliveries.length, firstRetryDeliveryCount + 1);
    assert.equal(deliveries.at(-1).text, firstRetryText);
    assert.equal(spool.get(retried.inputId).status, 'inflight');
    adapter.onTurnAbandoned({ receiptIds: [retried.inputId] });
    await settleTick();
    assert.equal(deliveries.length, firstRetryDeliveryCount + 2);
    assert.equal(deliveries.at(-1).text, firstRetryText);
    adapter.onTurnSucceeded({ receiptIds: [retried.inputId] });
    assert.equal(spool.get(retried.inputId).status, 'consumed');
    adapter.stop();
  });

  it('drains durable backlogs beyond one claim batch and releases an unsubmitted tail', async () => {
    const generations = new MeetingGenerationClock();
    const deliveries = [];
    const runtime = {
      submit(items) {
        deliveries.push(...items);
        return { accepted: true };
      },
    };
    const adapter = new MeetingRuntimeAdapter({
      spool,
      generationClock: generations,
      flyReferences: new FlyReferenceRing(),
      runtime,
      submitIngress: async (action) => await action(),
      retryMs: 7,
      logger: quietLogger,
    });
    const enqueueMany = (sessionEpoch, count) => Array.from({ length: count }, (_, index) => (
      spool.enqueue({
        sessionEpoch,
        segmentId: `segment_${sessionEpoch}_${String(index).padStart(4, '0')}`,
        meetingId: 'meeting_backlog_1234',
        text: `backlog final ${index}`,
        speaker: 'unknown',
        final: true,
      }).item
    ));

    const backlog = enqueueMany('epoch_backlog_12345678', 101);
    assert.equal(await adapter._drain(), null);
    assert.equal(deliveries.length, 101);
    assert.equal(spool.stats().inflight, 101);
    adapter.onTurnSucceeded({ receiptIds: backlog.map((item) => item.inputId) });

    const rejected = enqueueMany('epoch_rejected_12345678', 3);
    runtime.submit = () => ({ accepted: false, reason: 'busy' });
    assert.equal(await adapter._drain(), 7);
    assert.deepEqual(rejected.map((item) => spool.get(item.inputId).status), [
      'pending',
      'pending',
      'pending',
    ]);
    assert.equal(spool.stats().inflight, 0, 'unsubmitted items do not wait for lease expiry');
    adapter.stop();
  });
});
