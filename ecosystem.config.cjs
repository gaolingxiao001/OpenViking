'use strict';

const path = require('node:path');
const {
  CONTROL_ENV_MAX_BYTES,
  deploymentDaemonEnvOverrides,
  loadDeploymentManifest,
  openVikingAgentEnv,
  resolvedDeploymentDaemonEnv,
  updaterTargetsFor,
} = require('./deployment-config.cjs');

const releaseDir = __dirname;
const daemonDir = path.join(releaseDir, 'packages', 'daemon');
const webDir = path.join(releaseDir, 'packages', 'web');
const updaterDir = path.join(releaseDir, 'packages', 'updater');
const executablePath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

const common = Object.freeze({
  interpreter: process.execPath,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  wait_ready: true,
  time: false,
  merge_logs: true,
  filter_env: ['OPENVIKING_'],
});

function defined(values) {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function buildEcosystem(sourceEnv = process.env) {
  const homeDir = sourceEnv.HOME;
  if (!homeDir || !path.isAbsolute(homeDir)) throw new Error('HOME must be an absolute path');
  const baseDir = path.join(homeDir, '.local', 'lib', 'lark-daemon');
  const shareDir = path.join(homeDir, '.local', 'share');
  const inheritedPath = sourceEnv.PATH || '';
  const deployment = loadDeploymentManifest(sourceEnv);
  if (deployment.agents.some((agent) => agent.port === 3737)) {
    throw new Error('agent port 3737 conflicts with the shared Web port');
  }
  const updaterTargets = updaterTargetsFor(deployment);
  const updaterTargetsJson = JSON.stringify(updaterTargets);
  const sharedDaemonEnv = resolvedDeploymentDaemonEnv(deployment, sourceEnv);
  const systemDaemonEnvOverrides = deploymentDaemonEnvOverrides(sourceEnv);

  const daemonApps = deployment.agents.map((agent) => ({
    ...common,
    name: `lark-daemon-${agent.id}`,
    script: path.join(daemonDir, 'src', 'main.mjs'),
    cwd: daemonDir,
    restart_delay: 2000,
    min_uptime: '30s',
    max_restarts: 10,
    kill_timeout: 30000,
    listen_timeout: 30000,
    env: defined({
      ...sharedDaemonEnv,
      NODE_ENV: 'production',
      LARK_DAEMON_DEPLOYMENT_MANIFEST: deployment.manifestPath,
      LARK_DAEMON_INSTANCE_ID: agent.id,
      LARK_DAEMON_UPGRADE_TARGET: agent.id,
      LARK_DAEMON_HOST: '127.0.0.1',
      LARK_DAEMON_HTTP_ENABLED: 'true',
      LARK_DAEMON_CHANNEL: agent.channel,
      LARK_DAEMON_CONNECTORS_JSON: JSON.stringify(agent.connectors),
      LARK_DAEMON_EMAIL_CONFIG_FILE: agent.emailConfig || undefined,
      LARK_DAEMON_PORT: String(agent.port),
      // Empty for an instance without the lark connector, so a profile in
      // pm2's own environment cannot leak into it.
      LARK_DAEMON_PROFILE: agent.profile || '',
      LARKSUITE_CLI_PROFILE: agent.profile || '',
      LARK_DAEMON_AGENT_NAME: agent.displayName,
      LARK_DAEMON_DATA_DIR: agent.dataDir,
      LARK_DAEMON_WORKSPACE: agent.workspace,
      LARK_DAEMON_MODEL: agent.model,
      // Empty values deliberately override any legacy global seed. Managed
      // Agent identity must remain pinned to one daemon/profile instance.
      LARK_DAEMON_VOLC_SESSION_ID: agent.volcSessionId || '',
      LARK_DAEMON_VOLC_ENVIRONMENT_ID: agent.volcEnvironmentId || '',
      ...(agent.meetingAudio ? {
        LARK_DAEMON_MEETING_AUDIO_ENABLED: 'true',
        LARK_DAEMON_MEETING_AUDIO_WORKER_COMMAND: agent.meetingAudio.pythonCommand,
        LARK_DAEMON_MEETING_AUDIO_WORKER_ARGS_JSON: JSON.stringify([
          path.join(daemonDir, 'worker', 'meeting_asr_worker.py'),
          '--worker-dir',
          path.join(releaseDir, 'meeting-asr'),
        ]),
        LARK_DAEMON_MEETING_AUDIO_WORKER_CWD: releaseDir,
        LARK_DAEMON_MEETING_AUDIO_ASR_CONFIG_FILE: agent.meetingAudio.asrConfigFile,
      } : {}),
      ...openVikingAgentEnv(agent),
      PATH: `${executablePath}:${inheritedPath}`,
    }),
  }));

  const webTargets = deployment.agents.map((agent) => ({
    id: agent.id,
    label: agent.displayName,
    host: '127.0.0.1',
    port: agent.port,
  }));
  const webTargetsJson = JSON.stringify(webTargets);
  for (const [name, value] of [
    ['LARK_WEB_INSTANCES', webTargetsJson],
    ['LARK_UPDATER_TARGETS_JSON', updaterTargetsJson],
  ]) {
    if (Buffer.byteLength(value) > CONTROL_ENV_MAX_BYTES) {
      throw new Error(`${name} exceeds ${CONTROL_ENV_MAX_BYTES} bytes`);
    }
  }

  return {
    apps: [
      ...daemonApps,
      {
        ...common,
        filter_env: [
          ...common.filter_env,
          'ARK_',
          'VOLCENGINE_',
          'LARK_DAEMON_VOLC_',
          'SESSION_ID',
        ],
        name: 'lark-web',
        script: path.join(webDir, 'src', 'main.mjs'),
        cwd: webDir,
        restart_delay: 1000,
        min_uptime: '10s',
        max_restarts: 10,
        kill_timeout: 5000,
        listen_timeout: 10000,
        env: {
          NODE_ENV: 'production',
          LARK_WEB_HOST: '0.0.0.0',
          LARK_WEB_PORT: '3737',
          LARK_WEB_DEFAULT_INSTANCE: deployment.defaultInstance,
          LARK_WEB_INSTANCES: webTargetsJson,
          PATH: `${executablePath}:${inheritedPath}`,
        },
      },
      {
        ...common,
        name: 'lark-updater',
        script: path.join(updaterDir, 'src', 'main.mjs'),
        cwd: updaterDir,
        restart_delay: 1000,
        min_uptime: '10s',
        max_restarts: 10,
        kill_timeout: 5000,
        listen_timeout: 10000,
        env: {
          ...systemDaemonEnvOverrides,
          NODE_ENV: 'production',
          LARK_DAEMON_DEPLOYMENT_MANIFEST: deployment.manifestPath,
          LARK_UPDATER_TARGETS_JSON: updaterTargetsJson,
          LARK_UPDATER_RELEASE_LINK: path.join(baseDir, 'current'),
          LARK_UPDATER_GIT_DIR: path.join(baseDir, 'upstream.git'),
          LARK_UPDATER_REMOTE_URL: 'git@code.byted.org:data-arch/lark-daemon.git',
          LARK_UPDATER_REMOTE_BRANCH: 'main',
          LARK_UPDATER_SOCKET: path.join(shareDir, 'lark-daemon', 'updater.sock'),
          PATH: `${executablePath}:${inheritedPath}`,
        },
      },
    ],
  };
}

module.exports = {
  ...buildEcosystem(),
  buildEcosystem,
};
