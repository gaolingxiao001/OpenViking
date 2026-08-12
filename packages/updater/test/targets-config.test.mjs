import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-targets-'));
const manifestPath = path.join(directory, 'deployment.json');
fs.writeFileSync(manifestPath, `${JSON.stringify({
  version: 1,
  defaultInstance: 'beta',
  agents: ['alpha', 'beta', 'gamma'].map((id, index) => ({
    id,
    displayName: id.toUpperCase(),
    profile: `cli_${id}`,
    port: 3738 + index,
    dataDir: `/srv/lark-daemon/data/${id}`,
    workspace: `/srv/lark-daemon/workspaces/${id}`,
    ovConfig: `/srv/lark-daemon/ov/${id}.json`,
    model: 'gpt-5.6-sol',
  })),
}, null, 2)}\n`);
delete process.env.LARK_UPDATER_TARGETS_JSON;
process.env.LARK_DAEMON_DEPLOYMENT_MANIFEST = manifestPath;

const {
  TARGETS,
  UPGRADE_TARGETS,
  assertUpgradeTarget,
  shouldUpgradeSharedWeb,
} = await import('../src/targets.mjs');
after(() => fs.rmSync(directory, { recursive: true, force: true }));

test('updater derives every allowlisted target from the deployment manifest', () => {
  assert.deepEqual(UPGRADE_TARGETS, ['alpha', 'beta', 'gamma', 'all']);
  assert.deepEqual(TARGETS.beta, {
    app: 'lark-daemon-beta',
    config: 'ecosystem.config.cjs',
    readyUrl: 'http://127.0.0.1:3739/ready',
    upgradeSharedWeb: false,
  });
  assert.equal(assertUpgradeTarget('gamma'), 'gamma');
  assert.equal(shouldUpgradeSharedWeb('alpha'), false);
  assert.equal(shouldUpgradeSharedWeb('all'), true);
  assert.throws(() => assertUpgradeTarget('not-configured'), /alpha, beta, gamma, all/);
});

test('CLI usage lists the current manifest targets dynamically', () => {
  const bin = fileURLToPath(new URL('../bin/lark-daemon.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [bin], {
    env: {
      ...process.env,
      LARK_DAEMON_DEPLOYMENT_MANIFEST: manifestPath,
      LARK_UPDATER_TARGETS_JSON: '',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.equal(result.stderr, 'usage: lark-daemon upgrade <alpha|beta|gamma|all>\n');
});
