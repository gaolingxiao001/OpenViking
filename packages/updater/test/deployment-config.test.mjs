import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  applyDeploymentAgentEnv,
  applyDeploymentDaemonEnv,
  loadDeploymentManifest,
  resolveDeploymentManifestPath,
  selectDeploymentAgent,
} = require('../../../deployment-config.cjs');

function validManifest() {
  return {
    version: 1,
    defaultInstance: 'beta',
    env: {
      LARK_DAEMON_LOG_LEVEL: 'info',
      LARK_DAEMON_DRY_RUN: 'false',
      TEAM_TASK_BOARD_URL: '',
    },
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
        meetingAudio: {
          targetChatId: 'oc_target12345678',
          pythonCommand: '/usr/bin/python3',
          asrConfigFile: '/srv/lark-daemon/secrets/alpha-asr.yaml',
        },
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
    assert.deepEqual(deployment.env, {
      LARK_DAEMON_LOG_LEVEL: 'info',
      LARK_DAEMON_DRY_RUN: 'false',
      TEAM_TASK_BOARD_URL: '',
    });
    assert.deepEqual(deployment.agents.map(({ id }) => id), ['alpha', 'beta', 'gamma']);
    assert.equal(selectDeploymentAgent(deployment).id, 'beta');
    assert.equal(selectDeploymentAgent(deployment, 'gamma').profile, 'cli_gamma');
    assert.deepEqual(selectDeploymentAgent(deployment, 'alpha').meetingAudio, {
      targetChatId: 'oc_target12345678',
      pythonCommand: '/usr/bin/python3',
      asrConfigFile: '/srv/lark-daemon/secrets/alpha-asr.yaml',
    });
    assert.equal(selectDeploymentAgent(deployment, 'beta').meetingAudio, null);
  });
});

test('defaults the manifest path under HOME and accepts an explicit absolute override', () => {
  assert.equal(
    resolveDeploymentManifestPath({ HOME: '/Users/test' }),
    '/Users/test/.lark-daemon/deployment.json',
  );
  assert.equal(resolveDeploymentManifestPath({
    HOME: '/Users/test',
    LARK_DAEMON_DEPLOYMENT_MANIFEST: '/srv/lark/deployment.json',
  }), '/srv/lark/deployment.json');
  assert.throws(
    () => resolveDeploymentManifestPath({ HOME: 'relative' }),
    /HOME must be an absolute path/,
  );
});

test('system environment overrides manifest daemon env while agent identity stays pinned', () => {
  withManifest(validManifest(), (manifestPath) => {
    const env = {
      HOME: '/Users/test',
      LARK_DAEMON_DEPLOYMENT_MANIFEST: manifestPath,
      LARK_DAEMON_LOG_LEVEL: 'debug',
      LARK_DAEMON_PORT: '9999',
      LARK_DAEMON_PROFILE: 'wrong',
    };
    const deployment = loadDeploymentManifest(env);
    applyDeploymentDaemonEnv(env, deployment);
    applyDeploymentAgentEnv(env, deployment, 'alpha');

    assert.equal(env.LARK_DAEMON_LOG_LEVEL, 'debug');
    assert.equal(env.LARK_DAEMON_DRY_RUN, 'false');
    assert.equal(env.TEAM_TASK_BOARD_URL, '');
    assert.equal(env.LARK_DAEMON_PORT, '3738');
    assert.equal(env.LARK_DAEMON_PROFILE, 'cli_alpha');
  });
});

test('manifest env accepts only string values from the daemon-wide allowlist', () => {
  const cases = [
    ['reserved identity', 'LARK_DAEMON_PROFILE', 'cli_wrong', /env field is not allowed: LARK_DAEMON_PROFILE/],
    ['reserved control plane', 'LARK_UPDATER_SOCKET', '/tmp/wrong', /env field is not allowed: LARK_UPDATER_SOCKET/],
    ['unknown key', 'UNRELATED_SETTING', 'value', /env field is not allowed: UNRELATED_SETTING/],
    ['non-string', 'LARK_DAEMON_HISTORY_LIMIT', 30, /env\.LARK_DAEMON_HISTORY_LIMIT must be a string/],
  ];
  for (const [name, key, value, error] of cases) {
    const manifest = validManifest();
    manifest.env[key] = value;
    withManifest(manifest, (manifestPath) => {
      assert.throws(() => loadDeploymentManifest({
        LARK_DAEMON_DEPLOYMENT_MANIFEST: manifestPath,
      }), error, name);
    });
  }
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
      name: 'missing daemon env',
      mutate: (manifest) => { delete manifest.env; },
      error: /deployment manifest env must be an object/,
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
