import assert from 'node:assert/strict';
import test from 'node:test';

process.env.LARK_UPDATER_TARGETS_JSON = JSON.stringify({
  sisi: {
    app: 'lark-daemon-sisi',
    readyUrl: 'http://127.0.0.1:3738/ready',
    upgradeSharedWeb: true,
  },
});

const {
  TARGETS,
  UPGRADE_TARGETS,
  assertUpgradeTarget,
  shouldUpgradeSharedWeb,
} = await import('../src/targets.mjs');

test('updater exposes only the configured sisi instance', () => {
  assert.deepEqual(UPGRADE_TARGETS, ['sisi', 'all']);
  assert.deepEqual(TARGETS.sisi, {
    app: 'lark-daemon-sisi',
    config: 'ecosystem.config.cjs',
    readyUrl: 'http://127.0.0.1:3738/ready',
    upgradeSharedWeb: true,
  });
  assert.equal(assertUpgradeTarget('sisi'), 'sisi');
  assert.equal(shouldUpgradeSharedWeb('sisi'), true);
  assert.throws(() => assertUpgradeTarget('zayn'), /target must be one of: sisi, all/);
});
