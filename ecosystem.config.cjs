'use strict';

const path = require('node:path');
const {
  getDeploymentConfig,
  loadDeploymentEnv,
  updaterTargetsFor,
} = require('./deployment-config.cjs');

const releaseDir = __dirname;
const daemonDir = path.join(releaseDir, 'packages', 'daemon');
const webDir = path.join(releaseDir, 'packages', 'web');
const updaterDir = path.join(releaseDir, 'packages', 'updater');
const executablePath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

const common = Object.freeze({
  interpreter: '/opt/homebrew/bin/node',
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
  const env = loadDeploymentEnv(releaseDir, sourceEnv);
  const homeDir = env.HOME;
  if (!homeDir || !path.isAbsolute(homeDir)) throw new Error('HOME must be an absolute path');
  const baseDir = path.join(homeDir, '.local', 'lib', 'lark-daemon');
  const shareDir = path.join(homeDir, '.local', 'share');
  const inheritedPath = env.PATH || '';
  const instance = getDeploymentConfig(env);
  const updaterTargets = updaterTargetsFor(instance);

  const daemonApp = {
    ...common,
    name: `lark-daemon-${instance.id}`,
    script: path.join(daemonDir, 'src', 'main.mjs'),
    cwd: daemonDir,
    restart_delay: 2000,
    min_uptime: '30s',
    max_restarts: 10,
    kill_timeout: 30000,
    listen_timeout: 30000,
    env: defined({
      NODE_ENV: 'production',
      LARK_DAEMON_INSTANCE_ID: instance.id,
      LARK_DAEMON_UPGRADE_TARGET: instance.id,
      LARK_DAEMON_HOST: '127.0.0.1',
      LARK_DAEMON_PORT: String(instance.port),
      LARK_DAEMON_PROFILE: instance.profile,
      LARKSUITE_CLI_PROFILE: instance.profile,
      LARK_DAEMON_AGENT_NAME: instance.label,
      LARK_DAEMON_DATA_DIR: instance.dataDir,
      LARK_DAEMON_WORKSPACE: instance.workspace,
      LARK_DAEMON_CODEX_MODEL: instance.model,
      OPENVIKING_CLI_CONFIG_FILE: instance.ovConfig,
      OPENVIKING_CREDENTIAL_SOURCE: 'cli',
      OPENVIKING_MEMORY_ENABLED: '1',
      OPENVIKING_AUTO_RECALL: '0',
      OPENVIKING_AUTO_CAPTURE: '1',
      OPENVIKING_AUTO_COMMIT_ON_COMPACT: '1',
      OPENVIKING_RECALL_PEER_SCOPE: 'actor',
      PATH: `${executablePath}:${inheritedPath}`,
    }),
  };

  const webTargets = [{
    id: instance.id,
    label: instance.label,
    host: '127.0.0.1',
    port: instance.port,
  }];

  return {
    apps: [
      daemonApp,
      {
        ...common,
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
          LARK_WEB_HOST: '127.0.0.1',
          LARK_WEB_PORT: '3737',
          LARK_WEB_DEFAULT_INSTANCE: instance.id,
          LARK_WEB_INSTANCES: JSON.stringify(webTargets),
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
          NODE_ENV: 'production',
          LARK_UPDATER_TARGETS_JSON: JSON.stringify(updaterTargets),
          LARK_UPDATER_RELEASE_LINK: path.join(baseDir, 'current'),
          LARK_UPDATER_GIT_DIR: path.join(baseDir, 'upstream.git'),
          LARK_UPDATER_REMOTE_URL: 'https://github.com/ZaynJarvis/lark-daemon.git',
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
