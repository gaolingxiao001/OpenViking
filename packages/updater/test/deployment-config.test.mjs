import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  applyDeploymentAgentEnv,
  deploymentDaemonEnvOverrides,
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
      VIKA_LOG_LEVEL: 'info',
      VIKA_DRY_RUN: 'false',
      VIKA_TRAEX_EFFORT: 'medium',
      TEAM_TASK_BOARD_URL: '',
    },
    agents: [
      {
        id: 'alpha',
        displayName: 'Alpha',
        profile: 'cli_alpha',
        port: 3738,
        dataDir: '/srv/vika/data/alpha',
        workspace: '/srv/vika/workspaces/alpha',
        ovConfig: '/srv/vika/ov/alpha.json',
        model: 'gpt-5.6-sol',
        meetingAudio: {
          pythonCommand: '/usr/bin/python3',
          asrConfigFile: '/srv/vika/secrets/alpha-asr.yaml',
        },
      },
      {
        id: 'beta',
        displayName: 'Beta',
        profile: 'cli_beta',
        port: 3740,
        dataDir: '/srv/vika/data/beta',
        workspace: '/srv/vika/workspaces/beta',
        ovConfig: '/srv/vika/ov/beta.json',
        model: 'gpt-5.6-sol',
      },
      {
        id: 'gamma',
        displayName: 'Gamma',
        profile: 'cli_gamma',
        port: 3741,
        dataDir: '/srv/vika/data/gamma',
        workspace: '/srv/vika/workspaces/gamma',
        ovConfig: '/srv/vika/ov/gamma.json',
        model: 'gpt-5.6-sol',
      },
    ],
  };
}

function withManifest(value, callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-deployment-'));
  const manifestPath = path.join(directory, 'config.json');
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
      VIKA_CONFIG: manifestPath,
    });

    assert.equal(deployment.version, 1);
    assert.equal(deployment.defaultInstance, 'beta');
    assert.deepEqual(deployment.env, {
      VIKA_LOG_LEVEL: 'info',
      VIKA_DRY_RUN: 'false',
      VIKA_TRAEX_EFFORT: 'medium',
      TEAM_TASK_BOARD_URL: '',
    });
    assert.deepEqual(deployment.agents.map(({ id }) => id), ['alpha', 'beta', 'gamma']);
    assert.equal(selectDeploymentAgent(deployment).id, 'beta');
    assert.equal(selectDeploymentAgent(deployment, 'gamma').profile, 'cli_gamma');
    assert.deepEqual(selectDeploymentAgent(deployment, 'alpha').meetingAudio, {
      pythonCommand: '/usr/bin/python3',
      asrConfigFile: '/srv/vika/secrets/alpha-asr.yaml',
    });
    assert.equal(selectDeploymentAgent(deployment, 'beta').meetingAudio, null);
  });
});

test('defaults the manifest path under HOME and accepts an explicit absolute override', () => {
  assert.equal(
    resolveDeploymentManifestPath({ HOME: '/Users/test' }),
    '/Users/test/.vika/config.json',
  );
  assert.equal(resolveDeploymentManifestPath({
    HOME: '/Users/test',
    VIKA_CONFIG: '/srv/lark/config.json',
  }), '/srv/lark/config.json');
  assert.throws(
    () => resolveDeploymentManifestPath({ HOME: 'relative' }),
    /HOME must be an absolute path/,
  );
});

test('system environment overrides manifest daemon env while agent identity stays pinned', () => {
  withManifest(validManifest(), (manifestPath) => {
    const env = {
      HOME: '/Users/test',
      VIKA_CONFIG: manifestPath,
      VIKA_LOG_LEVEL: 'debug',
      ARK_API_KEY: 'system-only-secret',
      VIKA_PORT: '9999',
      VIKA_LARK_PROFILE: 'wrong',
    };
    const deployment = loadDeploymentManifest(env);
    applyDeploymentDaemonEnv(env, deployment);
    applyDeploymentAgentEnv(env, deployment, 'alpha');

    assert.equal(env.VIKA_LOG_LEVEL, 'debug');
    assert.equal(env.VIKA_DRY_RUN, 'false');
    assert.equal(env.TEAM_TASK_BOARD_URL, '');
    assert.equal(env.ARK_API_KEY, 'system-only-secret');
    assert.equal(env.VIKA_PORT, '3738');
    assert.equal(env.VIKA_LARK_PROFILE, 'cli_alpha');
  });
});

test('falls back to a secrets file for daemon-wide secrets missing from the environment', () => {
  withManifest(validManifest(), (manifestPath) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-secrets-'));
    const secretsPath = path.join(directory, 'secrets.env');
    fs.writeFileSync(secretsPath, '# comment\nARK_API_KEY=from-file-secret\nVIKA_TOS_ACCESS_KEY=bucket-read-key\nOTHER=ignored\n');
    try {
      const env = {
        HOME: '/Users/test',
        VIKA_CONFIG: manifestPath,
        VIKA_SECRETS_FILE: secretsPath,
      };
      const deployment = loadDeploymentManifest(env);
      applyDeploymentDaemonEnv(env, deployment);
      assert.equal(env.ARK_API_KEY, 'from-file-secret');
      // The updater downloads releases from the private test bucket with it.
      assert.equal(deploymentDaemonEnvOverrides(env).VIKA_TOS_ACCESS_KEY, 'bucket-read-key');
      assert.equal(env.OTHER, undefined);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

test('the environment still wins over the secrets file', () => {
  withManifest(validManifest(), (manifestPath) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lark-secrets-'));
    const secretsPath = path.join(directory, 'secrets.env');
    fs.writeFileSync(secretsPath, 'ARK_API_KEY=from-file-secret\n');
    try {
      const env = {
        HOME: '/Users/test',
        VIKA_CONFIG: manifestPath,
        VIKA_SECRETS_FILE: secretsPath,
        ARK_API_KEY: 'from-shell-env',
      };
      const deployment = loadDeploymentManifest(env);
      applyDeploymentDaemonEnv(env, deployment);
      assert.equal(env.ARK_API_KEY, 'from-shell-env');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

test('a missing secrets file is not an error', () => {
  withManifest(validManifest(), (manifestPath) => {
    const env = {
      HOME: '/Users/test',
      VIKA_CONFIG: manifestPath,
      VIKA_SECRETS_FILE: '/no/such/file/secrets.env',
    };
    const deployment = loadDeploymentManifest(env);
    applyDeploymentDaemonEnv(env, deployment);
    assert.equal(env.ARK_API_KEY, undefined);
  });
});

test('manifest env accepts only string values from the daemon-wide allowlist', () => {
  const cases = [
    ['reserved identity', 'VIKA_LARK_PROFILE', 'cli_wrong', /env field is not allowed: VIKA_LARK_PROFILE/],
    ['reserved control plane', 'VIKA_UPDATER_SOCKET', '/tmp/wrong', /env field is not allowed: VIKA_UPDATER_SOCKET/],
    ['system-only secret', 'ARK_API_KEY', 'must-not-live-in-manifest', /env field is not allowed: ARK_API_KEY/],
    ['removed Codex model', 'VIKA_CODEX_MODEL', 'gpt-5.6-sol', /env field is not allowed: VIKA_CODEX_MODEL/],
    ['unknown key', 'UNRELATED_SETTING', 'value', /env field is not allowed: UNRELATED_SETTING/],
    ['non-string', 'VIKA_HISTORY_LIMIT', 30, /env\.VIKA_HISTORY_LIMIT must be a string/],
  ];
  for (const [name, key, value, error] of cases) {
    const manifest = validManifest();
    manifest.env[key] = value;
    withManifest(manifest, (manifestPath) => {
      assert.throws(() => loadDeploymentManifest({
        VIKA_CONFIG: manifestPath,
      }), error, name);
    });
  }
});

test('foreground selection defaults to defaultInstance and pins every identity boundary', () => {
  withManifest(validManifest(), (manifestPath) => {
    const env = {
      VIKA_CONFIG: manifestPath,
      VIKA_VOLC_SESSION_ID: 'legacy-global-seed',
      VIKA_VOLC_ENVIRONMENT_ID: 'legacy-global-environment',
    };
    const deployment = loadDeploymentManifest(env);
    applyDeploymentAgentEnv(env, deployment);

    assert.deepEqual({
      id: env.VIKA_INSTANCE_ID,
      target: env.VIKA_UPGRADE_TARGET,
      name: env.VIKA_AGENT_NAME,
      profile: env.VIKA_LARK_PROFILE,
      cliProfile: env.LARKSUITE_CLI_PROFILE,
      port: env.VIKA_PORT,
      dataDir: env.VIKA_DATA_DIR,
      workspace: env.VIKA_WORKSPACE,
      ovConfig: env.OPENVIKING_CLI_CONFIG_FILE,
      model: env.VIKA_MODEL,
    }, {
      id: 'beta',
      target: 'beta',
      name: 'Beta',
      profile: 'cli_beta',
      cliProfile: 'cli_beta',
      port: '3740',
      dataDir: '/srv/vika/data/beta',
      workspace: '/srv/vika/workspaces/beta',
      ovConfig: '/srv/vika/ov/beta.json',
      model: 'gpt-5.6-sol',
    });
    assert.equal(env.VIKA_CODEX_MODEL, undefined);
    assert.equal(env.VIKA_VOLC_SESSION_ID, undefined);
    assert.equal(env.VIKA_VOLC_ENVIRONMENT_ID, undefined);
  });
});

test('pins Ark as a generic initial model without misconfiguring Codex', () => {
  const manifest = validManifest();
  manifest.agents[1].model = 'ark';
  manifest.agents[1].volcSessionId = 'sesn-beta-self-hosted';
  manifest.agents[1].volcEnvironmentId = 'env-beta-self-hosted';
  withManifest(manifest, (manifestPath) => {
    const env = { VIKA_CONFIG: manifestPath };
    const deployment = loadDeploymentManifest(env);
    applyDeploymentAgentEnv(env, deployment);
    assert.equal(env.VIKA_MODEL, 'ark');
    assert.equal(env.VIKA_CODEX_MODEL, undefined);
    assert.equal(env.VIKA_VOLC_SESSION_ID, 'sesn-beta-self-hosted');
    assert.equal(env.VIKA_VOLC_ENVIRONMENT_ID, 'env-beta-self-hosted');
  });
});

test('requires a complete per-agent self-hosted binding for Ark', () => {
  const cases = [
    [
      'missing binding',
      (agent) => { agent.model = 'ark'; },
      /using ark must configure volcSessionId and volcEnvironmentId/,
    ],
    [
      'partial binding',
      (agent) => { agent.volcSessionId = 'sesn-partial'; },
      /volcSessionId and agents\[1\]\.volcEnvironmentId must be configured together/,
    ],
  ];
  for (const [name, mutate, error] of cases) {
    const manifest = validManifest();
    mutate(manifest.agents[1]);
    withManifest(manifest, (manifestPath) => {
      assert.throws(
        () => loadDeploymentManifest({ VIKA_CONFIG: manifestPath }),
        error,
        name,
      );
    });
  }
});

test('connects a mailbox only together with its private account file', () => {
  const manifest = validManifest();
  manifest.agents[1].connectors = ['email', 'lark'];
  manifest.agents[1].emailConfig = '/srv/vika/secrets/beta-email.json';
  withManifest(manifest, (manifestPath) => {
    const env = { VIKA_CONFIG: manifestPath, VIKA_EMAIL_CONFIG_FILE: '/stale.json' };
    const deployment = loadDeploymentManifest(env);
    // A mailbox is never the primary IM, wherever it is listed.
    assert.equal(selectDeploymentAgent(deployment).channel, 'lark');
    applyDeploymentAgentEnv(env, deployment, 'beta');
    assert.equal(env.VIKA_CONNECTORS_JSON, '["email","lark"]');
    assert.equal(env.VIKA_EMAIL_CONFIG_FILE, '/srv/vika/secrets/beta-email.json');
    applyDeploymentAgentEnv(env, deployment, 'gamma');
    assert.equal(env.VIKA_EMAIL_CONFIG_FILE, undefined);
  });
  for (const mutate of [
    (agent) => { agent.connectors = ['lark', 'email']; },
    (agent) => { agent.emailConfig = '/srv/vika/secrets/beta-email.json'; },
  ]) {
    const broken = validManifest();
    mutate(broken.agents[1]);
    withManifest(broken, (manifestPath) => {
      assert.throws(() => loadDeploymentManifest({ VIKA_CONFIG: manifestPath }),
        /emailConfig and the email connector must be configured together/);
    });
  }
});

test('an instance runs without OpenViking, and without a profile when it has no lark connector', () => {
  const manifest = validManifest();
  delete manifest.agents[1].ovConfig;
  delete manifest.agents[2].ovConfig;
  manifest.agents[2].channel = 'weixin';
  manifest.agents[2].connectors = ['weixin'];
  delete manifest.agents[2].profile;
  withManifest(manifest, (manifestPath) => {
    const env = {
      VIKA_CONFIG: manifestPath,
      OPENVIKING_CLI_CONFIG_FILE: '/stale/ovcli.conf',
      VIKA_LARK_PROFILE: 'stale',
      LARKSUITE_CLI_PROFILE: 'stale',
    };
    const deployment = loadDeploymentManifest(env);
    assert.equal(selectDeploymentAgent(deployment, 'beta').ovConfig, null);
    applyDeploymentAgentEnv(env, deployment, 'alpha');
    assert.equal(env.OPENVIKING_CLI_CONFIG_FILE, '/srv/vika/ov/alpha.json');
    assert.equal(env.OPENVIKING_MEMORY_ENABLED, '1');
    // Without OV the user's own memory plugins are switched off for this instance.
    applyDeploymentAgentEnv(env, deployment, 'beta');
    assert.equal(env.OPENVIKING_CLI_CONFIG_FILE, undefined);
    assert.equal(env.OPENVIKING_MEMORY_ENABLED, '0');
    assert.equal(env.LARKSUITE_CLI_PROFILE, 'cli_beta');
    applyDeploymentAgentEnv(env, deployment, 'gamma');
    assert.equal(selectDeploymentAgent(deployment, 'gamma').profile, null);
    assert.equal(env.VIKA_LARK_PROFILE, undefined);
    assert.equal(env.LARKSUITE_CLI_PROFILE, undefined);
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
      mutate: (manifest) => { delete manifest.agents[0].profile; },
      error: /agents\[0\]\.profile is required/,
    },
    {
      name: 'profile on an instance without the lark connector',
      mutate: (manifest) => { manifest.agents[1].channel = 'weixin'; manifest.agents[1].connectors = ['weixin']; },
      error: /agents\[1\]\.profile is only used by the lark connector/,
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
        () => loadDeploymentManifest({ VIKA_CONFIG: manifestPath }),
        fixture.error,
        fixture.name,
      );
    });
  }
});

test('an instance id cannot take the name of a shared control-plane app', () => {
  for (const id of ['all', 'web', 'updater']) {
    const manifest = validManifest();
    manifest.agents[1].id = id;
    manifest.defaultInstance = 'alpha';
    withManifest(manifest, (manifestPath) => {
      assert.throws(() => loadDeploymentManifest({ VIKA_CONFIG: manifestPath }), /cannot be all, web, updater/, id);
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
      (manifest) => { manifest.agents[1].dataDir = '/srv/vika/data/alpha'; },
      /duplicate agent dataDir: \/srv\/vika\/data\/alpha/,
    ],
    [
      'workspace',
      (manifest) => { manifest.agents[1].workspace = '/srv/vika/workspaces/alpha'; },
      /duplicate agent workspace: \/srv\/vika\/workspaces\/alpha/,
    ],
    [
      'ovConfig',
      (manifest) => { manifest.agents[1].ovConfig = '/srv/vika/ov/alpha.json'; },
      /duplicate agent ovConfig: \/srv\/vika\/ov\/alpha\.json/,
    ],
  ];

  for (const [name, mutate, error] of cases) {
    const manifest = validManifest();
    mutate(manifest);
    withManifest(manifest, (manifestPath) => {
      assert.throws(
        () => loadDeploymentManifest({ VIKA_CONFIG: manifestPath }),
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
      (manifest) => { manifest.agents[1].workspace = '/srv/vika/data/alpha/nested'; },
      /agent storage paths overlap: agents\[0\]\.dataDir and agents\[1\]\.workspace/,
    ],
    [
      'same-agent overlap',
      (manifest) => { manifest.agents[0].workspace = '/srv/vika/data/alpha/work'; },
      /agent storage paths overlap: agents\[0\]\.dataDir and agents\[0\]\.workspace/,
    ],
  ];

  for (const [name, mutate, error] of cases) {
    const manifest = validManifest();
    mutate(manifest);
    withManifest(manifest, (manifestPath) => {
      assert.throws(
        () => loadDeploymentManifest({ VIKA_CONFIG: manifestPath }),
        error,
        name,
      );
    });
  }
});
