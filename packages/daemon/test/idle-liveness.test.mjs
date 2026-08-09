import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IdleLivenessExtension } from '../src/extensions/idle-liveness.mjs';

const quietLogger = { debug() {}, info() {}, warn() {}, error() {} };

function harness() {
  let now = 0;
  const journal = [];
  const activities = [];
  const created = [];
  const deleted = [];
  const store = {
    appendCognitionJournal(entry) { journal.push({ op: 'append', ...entry }); },
    settleCognitionJournal(key, status, options) {
      journal.push({ op: 'settle', key, status, options });
    },
  };
  const lark = {
    async reactMessage(messageId, emojiType) {
      created.push({ messageId, emojiType });
      return { reacted: true, reactionId: `opaque-${messageId}` };
    },
    async deleteReaction(messageId, reactionId) {
      deleted.push({ messageId, reactionId });
      return { deleted: true };
    },
  };
  const extension = new IdleLivenessExtension({
    thresholdMs: 600_000,
    lark,
    store,
    logger: quietLogger,
    recordActivity(kind, fields) { activities.push({ kind, ...fields }); },
    now: () => now,
  });
  return {
    extension,
    journal,
    activities,
    created,
    deleted,
    advance(ms) { now += ms; },
  };
}

function event(overrides = {}) {
  return {
    chatId: 'oc_idle12345678',
    threadId: null,
    messageId: 'om_idle12345678',
    chatType: 'p2p',
    conversationKey: 'profile:tenant:oc_idle12345678:main',
    mentions: [],
    ...overrides,
  };
}

describe('idle liveness UX extension', () => {
  it('holds an exact reaction token and removes it after any successful delivery', async () => {
    const state = harness();
    state.advance(601_000);

    assert.equal(await state.extension.beforeInbound(event(), { seq: 7 }), true);
    assert.deepEqual(state.created, [{ messageId: 'om_idle12345678', emojiType: 'OnIt' }]);
    assert.equal(state.extension.pending.size, 1);

    // A final reaction is a delivery too; the temporary OnIt is not retained.
    await state.extension.onDeliverySucceeded({ inboundSeqs: [7], mode: 'reaction' });
    assert.deepEqual(state.deleted, [{
      messageId: 'om_idle12345678',
      reactionId: 'opaque-om_idle12345678',
    }]);
    assert.equal(state.extension.pending.size, 0);

    // Turn completion races safely with the delivery callback.
    await state.extension.onTurnSettled({ inboundSeqs: [7] });
    assert.equal(state.deleted.length, 1);
    assert.equal(state.journal.filter((entry) => entry.kind === 'control').length, 0);
    assert.equal(state.journal.at(-1).status, 'CANCELLED');
    assert.ok(state.activities.some((entry) => entry.kind === 'system.liveness_cleared'));
  });

  it('cleans a silent or failed turn when its lifecycle settles', async () => {
    const state = harness();
    state.advance(601_000);
    await state.extension.beforeInbound(event(), { seq: 8 });

    await state.extension.onTurnSettled({ inboundSeqs: [8] });
    assert.equal(state.extension.pending.size, 0);
    assert.equal(state.deleted.length, 1);
  });

  it('does not react again inside the activity window or to ambient group traffic', async () => {
    const state = harness();
    state.advance(601_000);
    await state.extension.beforeInbound(event(), { seq: 9 });
    assert.equal(
      await state.extension.beforeInbound(event({ messageId: 'om_idle23456789' }), { seq: 10 }),
      false,
    );
    state.advance(601_000);
    assert.equal(await state.extension.beforeInbound(event({
      messageId: 'om_idle34567890',
      chatType: 'group',
    }), { seq: 11 }), false);
    assert.equal(state.created.length, 1);
    await state.extension.stop();
  });

  it('uses shutdown as a final cleanup fallback for an unfinished turn', async () => {
    const state = harness();
    state.advance(601_000);
    await state.extension.beforeInbound(event(), { seq: 12 });
    await state.extension.stop();
    assert.equal(state.deleted.length, 1);
    assert.equal(state.extension.pending.size, 0);
  });

  it('fences a slow create against shutdown and deletes the late token', async () => {
    let resolveCreate;
    const deleted = [];
    const extension = new IdleLivenessExtension({
      thresholdMs: 1,
      lark: {
        reactMessage() {
          return new Promise((resolve) => { resolveCreate = resolve; });
        },
        async deleteReaction(messageId, reactionId) { deleted.push({ messageId, reactionId }); },
      },
      store: {
        appendCognitionJournal() {},
        settleCognitionJournal() {},
      },
      logger: quietLogger,
      now: () => 2,
    });
    extension.lastActivityAtMs = 0;
    const create = extension.beforeInbound(event(), { seq: 13 });
    await new Promise((resolve) => setImmediate(resolve));
    const stop = extension.stop();
    resolveCreate({ reacted: true, reactionId: 'late-reaction-id' });
    assert.equal(await create, false);
    await stop;
    assert.deepEqual(deleted, [{
      messageId: 'om_idle12345678',
      reactionId: 'late-reaction-id',
    }]);
    assert.equal(extension.pending.size, 0);
  });
});
