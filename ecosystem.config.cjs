const os = require('node:os');
const path = require('node:path');

const releaseDir = __dirname;
const daemonDir = path.join(releaseDir, 'packages', 'daemon');
const webDir = path.join(releaseDir, 'packages', 'web');
const updaterDir = path.join(releaseDir, 'packages', 'updater');
const homeDir = os.homedir();
const baseDir = path.join(homeDir, '.local', 'lib', 'lark-daemon');
const shareDir = path.join(homeDir, '.local', 'share');
const executablePath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';
const inheritedPath = process.env.PATH || '';

// Both bot processes are built by this one template. Per-bot values are kept
// here so adding another bot does not require copying a second ecosystem file.
const bots = Object.freeze([
  Object.freeze({
    id: 'zayn',
    port: '3738',
    // This primary slot also adopts the legacy daemon. Keep its identity,
    // profile, workspace and SQLite paths in the persistent shared env so a
    // first updater rollout cannot silently fork the existing bot's state.
  }),
  Object.freeze({
    id: 'sally',
    agentName: '斯斯',
    port: '3740',
    profile: 'sally',
    dataDir: path.join(shareDir, 'lark-daemon-sally'),
    workspace: path.join(homeDir, 'Documents', 'lark-daemon-sally-workspace'),
    model: 'gpt-5.6-sol',
    ovConfig: path.join(homeDir, '.openviking', 'ovcli.conf.sally'),
  }),
]);

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

function daemonApp(bot) {
  return {
    ...common,
    name: `lark-daemon-${bot.id}`,
    script: path.join(daemonDir, 'src', 'main.mjs'),
    cwd: daemonDir,
    restart_delay: 2000,
    min_uptime: '30s',
    max_restarts: 10,
    kill_timeout: 30000,
    listen_timeout: 30000,
    env: defined({
      NODE_ENV: 'production',
      LARK_DAEMON_HOST: '127.0.0.1',
      LARK_DAEMON_PORT: bot.port,
      LARK_DAEMON_PROFILE: bot.profile,
      LARK_DAEMON_AGENT_NAME: bot.agentName,
      LARK_DAEMON_DATA_DIR: bot.dataDir,
      LARK_DAEMON_WORKSPACE: bot.workspace,
      LARK_DAEMON_CODEX_MODEL: bot.model,
      OPENVIKING_CLI_CONFIG_FILE: bot.ovConfig,
      OPENVIKING_CREDENTIAL_SOURCE: 'cli',
      OPENVIKING_MEMORY_ENABLED: '1',
      OPENVIKING_AUTO_RECALL: '0',
      OPENVIKING_AUTO_CAPTURE: '1',
      OPENVIKING_AUTO_COMMIT_ON_COMPACT: '1',
      OPENVIKING_RECALL_PEER_SCOPE: 'actor',
      PATH: `${executablePath}:${inheritedPath}`,
    }),
  };
}

const webTargets = bots.map((bot) => ({
  id: bot.id,
  label: bot.id === 'sally' ? '斯斯' : 'Zayn',
  host: '127.0.0.1',
  port: Number(bot.port),
}));

module.exports = {
  apps: [
    ...bots.map(daemonApp),
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
        LARK_WEB_DEFAULT_INSTANCE: 'zayn',
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
