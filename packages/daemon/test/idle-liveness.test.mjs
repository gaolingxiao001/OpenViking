import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { IdleLivenessExtension } from '../src/extensions/idle-liveness.mjs';

function harness({ thresholdMs = 600_000, enabled = true } = {}) {
  let now = 0;
  const extension = new IdleLivenessExtension({
    thresholdMs,
    enabled,
    now: () => now,
  });
  return {
    extension,
    advance(ms) { now += ms; },
  };
}

describe('idle liveness UX hint', () => {
  it('offers a hint after the delivery idle threshold without creating a reaction', () => {
    const state = harness();
    state.advance(601_000);

    assert.deepEqual(
      state.extension.beforeInbound({}, { seq: 7 }),
      { idleForMs: 601_000 },
    );
  });

  it('does not consume the idle window when the model silently ignores a message', () => {
    const state = harness();
    state.advance(601_000);

    assert.deepEqual(state.extension.beforeInbound({}, { seq: 8 }), { idleForMs: 601_000 });
    state.advance(1_000);
    assert.deepEqual(state.extension.beforeInbound({}, { seq: 9 }), { idleForMs: 602_000 });

    assert.deepEqual(state.extension.beforeInbound({}, { seq: 10 }), { idleForMs: 602_000 });
  });

  it('resets only after a real delivery and skips hints while the model is busy', () => {
    const state = harness();
    state.advance(601_000);
    assert.equal(
      state.extension.beforeInbound({}, { seq: 11 }, { modelBusy: true }),
      null,
    );

    state.extension.touch();
    assert.equal(state.extension.beforeInbound({}, { seq: 12 }), null);
    state.advance(600_000);
    assert.deepEqual(state.extension.beforeInbound({}, { seq: 13 }), { idleForMs: 600_000 });
  });

  it('can be disabled without changing the delivery path', () => {
    const state = harness({ enabled: false });
    state.advance(1_000_000);
    assert.equal(state.extension.beforeInbound({}, { seq: 14 }), null);
  });
});
