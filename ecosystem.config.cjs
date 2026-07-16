const path = require('node:path');

const projectDir = __dirname;
const daemonDir = path.join(projectDir, 'packages', 'daemon');
const webDir = path.join(projectDir, 'packages', 'web');
const homebrewPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

module.exports = {
  apps: [
    {
      name: 'lark-daemon',
      script: path.join(daemonDir, 'src', 'main.mjs'),
      cwd: daemonDir,
      interpreter: '/opt/homebrew/bin/node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 2000,
      min_uptime: '30s',
      max_restarts: 10,
      wait_ready: true,
      kill_timeout: 30000,
      listen_timeout: 30000,
      time: false,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        LARK_DAEMON_HOST: '127.0.0.1',
        LARK_DAEMON_PORT: '3738',
        PATH: `${homebrewPath}:${process.env.PATH || ''}`,
      },
    },
    {
      name: 'lark-web',
      script: path.join(webDir, 'src', 'main.mjs'),
      cwd: webDir,
      interpreter: '/opt/homebrew/bin/node',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      restart_delay: 1000,
      min_uptime: '10s',
      max_restarts: 10,
      wait_ready: true,
      kill_timeout: 5000,
      listen_timeout: 10000,
      time: false,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        LARK_WEB_HOST: '127.0.0.1',
        LARK_WEB_PORT: '3737',
        LARK_WEB_DAEMON_HOST: '127.0.0.1',
        LARK_WEB_DAEMON_PORT: '3738',
        PATH: `${homebrewPath}:${process.env.PATH || ''}`,
      },
    },
  ],
};
