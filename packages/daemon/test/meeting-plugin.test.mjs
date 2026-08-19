import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MeetingPlugin } from '../src/meeting/plugin.mjs';
import { formatMeetingInput, MeetingRuntimeAdapter } from '../src/meeting/runtime-adapter.mjs';

const quietLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return this; },
};

describe('MeetingPlugin text insert', () => {
  it('submits ASR text as an ordinary harness item', () => {
    const submitted = [];
    const plugin = new MeetingPlugin({
      config: {},
      store: {},
      lark: {},
      logger: quietLogger,
      registry: {},
    });
    plugin.attachHarness({
      runtime: {
        submit(items) {
          submitted.push(items);
          return { accepted: true, disposition: 'enqueued' };
        },
      },
      enqueueIngress: async (action) => action(),
    });

    const result = plugin.insertText({
      text: '[meeting-audio meeting=m1] 现在开始',
      receiptId: 'in-1',
      scope: { kind: 'meeting', meetingId: 'm1' },
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(submitted, [[{
      text: '[meeting-audio meeting=m1] 现在开始',
      seq: null,
      receiptId: 'in-1',
      scope: { kind: 'meeting', meetingId: 'm1' },
    }]]);
  });

  it('lets the runtime adapter insert through the plugin seam', () => {
    const inserted = [];
    const adapter = new MeetingRuntimeAdapter({
      spool: {
        claim({ limit }) {
          assert.ok(limit > 0);
          return [{
            inputId: 'asr-1',
            sessionEpoch: 'ep-1',
            generation: 1,
            input: { meetingId: 'm1', text: 'hello', speaker: 'unknown' },
          }];
        },
        release() {},
        consume() {},
      },
      generationClock: { observe() {} },
      flyReferences: { snapshot() { return []; } },
      insertText(item) {
        inserted.push(item);
        return { accepted: true };
      },
      submitIngress: async (action) => action(),
    });
    return adapter._drain().then(() => {
      assert.equal(inserted.length, 1);
      assert.equal(inserted[0].receiptId, 'asr-1');
      assert.match(inserted[0].text, /\[meeting-audio /);
      assert.match(inserted[0].text, /hello/);
      assert.equal(inserted[0].scope.kind, 'meeting');
    });
  });

  it('closes claim authority after draining ingress', async () => {
    const order = [];
    const plugin = new MeetingPlugin({
      config: {},
      store: {},
      lark: {},
      logger: quietLogger,
      registry: {},
    });
    plugin.inbox = { stop() { order.push('inbox-stop'); } };
    plugin.audio = {
      runtime: { stop() { order.push('runtime-drain-stop'); } },
      authority: { revokeAll() { order.push('authority-revoked'); } },
      server: { async close() { order.push('claim-socket-closed'); } },
      coordinator: { async stop() { order.push('media-stop'); } },
      spool: { close() { order.push('spool-close'); } },
    };
    plugin.adapter = { async stop() { order.push('meeting-stop'); } };
    await plugin.stop({
      drainIngress: async () => { order.push('ingress-drained'); },
    });
    const index = (event) => order.indexOf(event);
    assert.ok(index('runtime-drain-stop') < index('ingress-drained'));
    assert.ok(index('ingress-drained') < index('authority-revoked'));
    assert.ok(index('authority-revoked') < index('claim-socket-closed'));
    assert.ok(index('claim-socket-closed') < index('meeting-stop'));
    assert.ok(index('meeting-stop') < index('media-stop'));
    assert.ok(index('media-stop') < index('spool-close'));
  });
});

describe('meeting audio line', () => {
  it('formats a final as one text line', () => {
    const line = formatMeetingInput({
      sessionEpoch: 'ep',
      generation: 2,
      inputId: 'in-9',
      input: { meetingId: 'mid', text: '现在开始会议', speaker: 'unknown' },
    });
    assert.match(line, /^\[meeting-audio /);
    assert.match(line, /现在开始会议$/);
  });
});
