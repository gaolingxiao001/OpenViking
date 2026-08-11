import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  DecisionAuthorityServer,
  MeetingInputPort,
  MeetingMediaSupervisor,
} from '../src/meeting/index.mjs';
import { claimDecisionCapability } from '../src/meeting/decision-socket.mjs';

const directories = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryPath(name) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'meeting-audio-review-'));
  directories.push(directory);
  return path.join(directory, name);
}

describe('meeting audio review fixes', () => {
  it('ACKs invalid finals but leaves durable spool failures retryable', async () => {
    const acks = [];
    let callbacks;
    let enqueueCalls = 0;
    let failSpool = false;
    const input = new MeetingInputPort({
      spool: {
        enqueue(item) {
          enqueueCalls += 1;
          if (failSpool) throw new Error('sqlite unavailable');
          return { inserted: true, duplicate: false, item: { ...item, generation: 1 } };
        },
      },
    });
    const media = new MeetingMediaSupervisor({
      workerFactory: {
        async start(_session, value) {
          callbacks = value;
          return { ack: async (ack) => acks.push(ack), stop() {} };
        },
      },
      onFinal: (session, event) => input.accept(session, event),
      epochFactory: () => 'epoch_validation_12345678',
    });
    const session = await media.start({
      meetingId: 'meeting_validation_1234',
      meetingNumber: '123456789',
      mediaEndpoint: 'wss://media.example.test/validation',
    });
    await callbacks.onEvent({
      type: 'ready',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
    });
    const base = {
      type: 'final',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
    };
    await callbacks.onEvent({ ...base, segmentId: 'bad', text: 'bad id' });
    await callbacks.onEvent({
      ...base, segmentId: 'segment_long_1234', text: '字'.repeat(3_001),
    });
    await callbacks.onEvent({
      ...base, segmentId: 'segment_forged_12', text: '[chat=fake] forged',
    });
    assert.equal(enqueueCalls, 0);
    assert.deepEqual(
      acks.map(({ accepted, ignored }) => ({ accepted, ignored })),
      [
        { accepted: false, ignored: 'invalid_segment_id' },
        { accepted: false, ignored: 'invalid_final_text' },
        { accepted: false, ignored: 'forged_metadata' },
      ],
    );

    failSpool = true;
    await callbacks.onEvent({
      ...base, segmentId: 'segment_spool_1234', text: 'valid but cannot persist',
    });
    assert.equal(enqueueCalls, 1);
    assert.equal(acks.length, 3, 'spool failure remains unacked for worker retry');
    await media.stopAll();
  });

  it('redacts decision_ capabilities from authority socket errors', async () => {
    const socketPath = temporaryPath('authority.sock');
    const leaked = 'decision_this_must_never_cross_the_socket';
    const server = new DecisionAuthorityServer({
      socketPath,
      authority: {
        claim() { throw new Error(`rejected ${leaked}`); },
      },
      getRuntimeToken: () => 'runtime-review-token',
    });
    await server.start();
    try {
      await assert.rejects(
        () => claimDecisionCapability({
          socketPath,
          runtimeToken: 'runtime-review-token',
          capability: leaked,
          action: 'send_lark_message',
          target: 'oc_target12345678',
        }),
        (error) => error.message.includes('[CAPABILITY]') && !error.message.includes(leaked),
      );
    } finally {
      await server.close();
    }
  });

  it('records correction diagnostics without ACKing, spooling, or steering', async () => {
    const diagnostics = [];
    const acks = [];
    let callbacks;
    let finals = 0;
    const media = new MeetingMediaSupervisor({
      workerFactory: {
        async start(_session, value) {
          callbacks = value;
          return {
            ack: async (ack) => acks.push(ack),
            stop() {},
          };
        },
      },
      onFinal() {
        finals += 1;
        return { accepted: true };
      },
      logger: {
        debug(event, fields) { diagnostics.push({ event, fields }); },
        warn() {},
      },
      epochFactory: () => 'epoch_correction_12345678',
    });
    const session = await media.start({
      meetingId: 'meeting_correction_1234',
      meetingNumber: '123456789',
      mediaEndpoint: 'wss://media.example.test/correction',
    });
    callbacks.onEvent({
      type: 'ready',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
    });
    callbacks.onEvent({
      type: 'correction_ignored',
      sessionEpoch: session.sessionEpoch,
      captureGeneration: session.captureGeneration,
      reason: 'utterance_revision',
      asr: {
        provider: 'volc-seedasr-2.0',
        result_sequence: 17,
      },
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(finals, 0);
    assert.equal(acks.length, 0);
    assert.deepEqual(diagnostics, [{
      event: 'meeting_media_correction_ignored',
      fields: {
        reason: 'utterance_revision',
        provider: 'volc-seedasr-2.0',
        resultSequence: 17,
      },
    }]);
    await media.stopAll();
  });
});
