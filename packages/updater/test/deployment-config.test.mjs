import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  applyDeploymentAgentEnv,
  loadDeploymentManifest,
  selectDeploymentAgent,
} = require('../../../deployment-config.cjs');

function validManifest() {
  return {
    version: 1,
    defaultInstance: 'beta',
    agents: [
      {
        id: 'alpha',
        displayName: 'Alpha',
        profile: 'cli_alpha',
        port: 3738,
        dataDir: '/srv/lark-daemon/data/alpha',
        workspace: '/srv/lark-daemon/workspaces/alpha',
        ovConfig: '/srv/lark-daemon/ov/alpha.json',
        model: 'gpt-5.6-sol',
      },
      {
        id: 'beta',
        displayName: 'Beta',
        profile: 'cli_beta',
        port: 3740,
        dataDir: '/srv/lark-daemon/data/beta',
        workspace: '/srv/lark-daemon/workspaces/beta',
        ovConfig: '/srv/lark-daemon/ov/beta.json',
        model: 'gpt-5.6-sol',
      },
      {
        id: 'gamma',
        displayName: 'Gamma',
        profile: 'cli_gamma',
        port: 3741,
        dataDir: '/srv/lark-daemon/data/gamma',
        workspace: '/srv/lark-daemon/workspaces/gamma',
        ovConfig: '/srv/lark-daemon/ov/gamma.json',
        model: 'gpt-5.6-sol',
      },
    ],
  };
}

function withManifest(value, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-deployment-'));
  const manifestPath = path.join(directory, 'deployment.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(value, null, 2)}\n`);
  try {
    return callback(manifestPath);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('loads any number of agents from one absolute deployment manifest', () => {
  withManifest(validManifest(), (manifestPath) => {
    const deployment = loadDeploymentManifest({
      LARK_DAEMON_DEPLOYMENT_MANIFEST: manifestPath,
    });

    assert.equal(deployment.version, 1);
    assert.equal(deployment.defaultInstance, 'beta');
    assert.deepEqual(deployment.agents.map(({ id }) => id), ['alpha', 'beta', 'gamma']);
    assert.equal(selectDeploymentAgent(deployment).id, 'beta');
    assert.equal(selectDeploymentAgent(deployment, 'gamma').profile, 'cli_gamma');
  });
});

test('foreground selection defaults to defaultInstance and pins every identity boundary', () => {
  withManifest(validManifest(), (manifestPath) => {
    const env = { LARK_DAEMON_DEPLOYMENT_MANIFEST: manifestPath };
    const deployment = loadDeploymentManifest(env);
    applyDeploymentAgentEnv(env, deployment);

    assert.deepEqual({
      id: env.LARK_DAEMON_INSTANCE_ID,
      target: env.LARK_DAEMON_UPGRADE_TARGET,
      name: env.LARK_DAEMON_AGENT_NAME,
      profile: env.LARK_DAEMON_PROFILE,
      cliProfile: env.LARKSUITE_CLI_PROFILE,
      port: env.LARK_DAEMON_PORT,
      dataDir: env.LARK_DAEMON_DATA_DIR,
      workspace: env.LARK_DAEMON_WORKSPACE,
      ovConfig: env.OPENVIKING_CLI_CONFIG_FILE,
      model: env.LARK_DAEMON_CODEX_MODEL,
    }, {
      id: 'beta',
      target: 'beta',
      name: 'Beta',
      profile: 'cli_beta',
      cliProfile: 'cli_beta',
      port: '3740',
      dataDir: '/srv/lark-daemon/data/beta',
      workspace: '/srv/lark-daemon/workspaces/beta',
      ovConfig: '/srv/lark-daemon/ov/beta.json',
      model: 'gpt-5.6-sol',
    });
  });
});

test('rejects unknown and missing manifest fields instead of guessing', () => {
  const cases = [
    {
      name: 'unknown top-level field',
      mutate: (manifest) => { manifest.instances = []; },
      error: /unknown deployment manifest field: instances/,
    },
    {
      name: 'unknown agent field',
      mutate: (manifest) => { manifest.agents[0].alias = 'old-name'; },
      error: /unknown agents\[0\] field: alias/,
    },
    {
      name: 'missing agent field',
      mutate: (manifest) => { delete manifest.agents[0].ovConfig; },
      error: /agents\[0\]\.ovConfig is required/,
    },
    {
      name: 'display name too long for Web routing',
      mutate: (manifest) => { manifest.agents[0].displayName = 'x'.repeat(41); },
      error: /agents\[0\]\.displayName is invalid/,
    },
  ];

  for (const fixture of cases) {
    const manifest = validManifest();
    fixture.mutate(manifest);
    withManifest(manifest, (manifestPath) => {
      assert.throws(
        () => loadDeploymentManifest({ LARK_DAEMON_DEPLOYMENT_MANIFEST: manifestPath }),
        fixture.error,
        fixture.name,
      );
    });
  }
});

test('rejects duplicate agent identities, endpoints, and storage boundaries', () => {
  const cases = [
    ['id', (manifest) => { manifest.agents[1].id = 'alpha'; }, /duplicate agent id: alpha/],
    ['profile', (manifest) => { manifest.agents[1].profile = 'cli_alpha'; }, /duplicate agent profile: cli_alpha/],
    ['port', (manifest) => { manifest.agents[1].port = 3738; }, /duplicate agent port: 3738/],
    [
      'dataDir',
      (manifest) => { manifest.agents[1].dataDir = '/srv/lark-daemon/data/alpha'; },
      /duplicate agent dataDir: \/srv\/lark-daemon\/data\/alpha/,
    ],
    [
      'workspace',
      (manifest) => { manifest.agents[1].workspace = '/srv/lark-daemon/workspaces/alpha'; },
      /duplicate agent workspace: \/srv\/lark-daemon\/workspaces\/alpha/,
    ],
    [
      'ovConfig',
      (manifest) => { manifest.agents[1].ovConfig = '/srv/lark-daemon/ov/alpha.json'; },
      /duplicate agent ovConfig: \/srv\/lark-daemon\/ov\/alpha\.json/,
    ],
  ];

  for (const [name, mutate, error] of cases) {
    const manifest = validManifest();
    mutate(manifest);
    withManifest(manifest, (manifestPath) => {
      assert.throws(
        () => loadDeploymentManifest({ LARK_DAEMON_DEPLOYMENT_MANIFEST: manifestPath }),
        error,
        name,
      );
    });
  }
});

test('rejects invalid defaults, relative paths, and overlapping agent storage', () => {
  const cases = [
    [
      'missing default',
      (manifest) => { manifest.defaultInstance = 'missing'; },
      /deployment instance is not configured: missing/,
    ],
    [
      'relative dataDir',
      (manifest) => { manifest.agents[0].dataDir = 'data/alpha'; },
      /agents\[0\]\.dataDir must be an absolute path/,
    ],
    [
      'cross-agent overlap',
      (manifest) => { manifest.agents[1].workspace = '/srv/lark-daemon/data/alpha/nested'; },
      /agent storage paths overlap: agents\[0\]\.dataDir and agents\[1\]\.workspace/,
    ],
    [
      'same-agent overlap',
      (manifest) => { manifest.agents[0].workspace = '/srv/lark-daemon/data/alpha/work'; },
      /agent storage paths overlap: agents\[0\]\.dataDir and agents\[0\]\.workspace/,
    ],
  ];

  for (const [name, mutate, error] of cases) {
    const manifest = validManifest();
    mutate(manifest);
    withManifest(manifest, (manifestPath) => {
      assert.throws(
        () => loadDeploymentManifest({ LARK_DAEMON_DEPLOYMENT_MANIFEST: manifestPath }),
        error,
        name,
      );
    });
  }
});
