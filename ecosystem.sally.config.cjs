const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

// Copy to ecosystem.<name>.config.cjs and only change these values.
const bot = 'sally';
const profile = 'sally';
const webPort = '3739';
const daemonPort = '3740';
const model = 'gpt-5.6-sol';

const release = path.join(os.homedir(), '.local', 'lib', 'lark-daemon', 'current');
const auth = JSON.parse(execFileSync('/opt/homebrew/bin/lark-cli', [
  '--profile', profile, 'auth', 'status', '--json', '--verify',
], { encoding: 'utf8' }));
const owner = auth.identities?.user?.openId || '';
if (!/^ou_[A-Za-z0-9_-]{8,}$/.test(owner)) throw new Error(`${bot} OAuth is not ready`);

const daemonDir = path.join(release, 'packages', 'daemon');
const webDir = path.join(release, 'packages', 'web');
const dataDir = path.join(os.homedir(), '.local', 'share', `lark-daemon-${bot}`);
const workspace = path.join(os.homedir(), 'Documents', `lark-daemon-${bot}-workspace`);

const common = {
  interpreter: process.execPath,
  exec_mode: 'fork',
  instances: 1,
  autorestart: true,
  wait_ready: true,
  time: false,
  merge_logs: true,
  env: {
    NODE_ENV: 'production',
    PATH: `/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${process.env.PATH || ''}`,
  },
};

module.exports = {
  apps: [
    {
      ...common,
      name: `lark-daemon-${bot}`,
      script: path.join(daemonDir, 'src', 'main.mjs'),
      cwd: daemonDir,
      restart_delay: 2000,
      min_uptime: '30s',
      max_restarts: 10,
      kill_timeout: 30000,
      listen_timeout: 30000,
      env: {
        ...common.env,
        LARK_DAEMON_HOST: '127.0.0.1',
        LARK_DAEMON_PORT: daemonPort,
        LARK_DAEMON_PROFILE: profile,
        LARK_DAEMON_OWNER_OPEN_IDS: owner,
        LARK_DAEMON_DATA_DIR: dataDir,
        LARK_DAEMON_WORKSPACE: workspace,
        LARK_DAEMON_CODEX_MODEL: model,
      },
    },
    {
      ...common,
      name: `lark-web-${bot}`,
      script: path.join(webDir, 'src', 'main.mjs'),
      cwd: webDir,
      restart_delay: 1000,
      min_uptime: '10s',
      max_restarts: 10,
      kill_timeout: 5000,
      listen_timeout: 10000,
      env: {
        ...common.env,
        LARK_WEB_HOST: '127.0.0.1',
        LARK_WEB_PORT: webPort,
        LARK_WEB_DAEMON_HOST: '127.0.0.1',
        LARK_WEB_DAEMON_PORT: daemonPort,
      },
    },
  ],
};
