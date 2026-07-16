const path = require('node:path');

const projectDir = __dirname;
const homebrewPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin';

module.exports = {
  apps: [
    {
      name: 'lark-daemon',
      script: path.join(projectDir, 'src/main.mjs'),
      cwd: projectDir,
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
        PATH: `${homebrewPath}:${process.env.PATH || ''}`,
      },
    },
  ],
};
