#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';

// The `vika` command. Each subcommand loads only what it needs, so `setup`
// and `help` work before any manifest exists.

const USAGE = `用法：vika <命令>

  setup                       添加一个 agent 实例（扫码接飞书/微信）
  start [实例|web|updater]    启动本机已安装的版本；不写实例时启动全部
  stop [实例|web|updater]     停止
  restart [实例|web|updater]  重启
  status                      查看各进程状态
  logs <实例>                 查看日志
  login <lark|weixin> <实例>  重新授权某个 IM
  upgrade <实例|all>          升级到最新版本
  autostart <enable|disable>  开机自动启动（不需要 sudo）
  pi [参数...]                打开内置的 Pi（例如用 /login 登录模型）
`;

async function main([command, ...args]) {
  switch (command) {
    case 'setup': {
      const [{ setupCommand }, { Prompter }] = await Promise.all([import('../src/setup.mjs'), import('../src/prompt.mjs')]);
      const prompter = new Prompter();
      try {
        return await setupCommand({ prompter });
      } finally {
        prompter.close();
      }
    }
    case 'start':
    case 'stop':
    case 'restart': {
      if (args.length > 1) break;
      const control = await import('../src/control.mjs');
      return control[`${command}Command`](args[0]);
    }
    case 'status': {
      if (args.length) break;
      const { statusCommand } = await import('../src/control.mjs');
      return statusCommand();
    }
    case 'logs': {
      if (args.length !== 1) break;
      const { logsCommand } = await import('../src/control.mjs');
      return logsCommand(args[0]);
    }
    case 'login': {
      const [{ loginCommand }, { Prompter }] = await Promise.all([import('../src/login.mjs'), import('../src/prompt.mjs')]);
      const prompter = new Prompter();
      try {
        return await loginCommand(args, { prompter });
      } finally {
        prompter.close();
      }
    }
    case 'upgrade': {
      const { upgradeCommand } = await import('../src/upgrade.mjs');
      return upgradeCommand(args);
    }
    case 'autostart': {
      const { autostartCommand } = await import('../src/autostart.mjs');
      return autostartCommand(args);
    }
    case 'pi': {
      const { managedPiBin } = await import('../../daemon/src/pi-runtime.mjs');
      const child = spawn(process.execPath, [managedPiBin(), ...args], { stdio: 'inherit' });
      return new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 0)));
    }
    case '--version':
    case 'version': {
      // An installed release says what it is in release.json; a checkout has package.json.
      const root = new URL('../../../', import.meta.url);
      const release = fs.existsSync(new URL('release.json', root))
        ? JSON.parse(fs.readFileSync(new URL('release.json', root), 'utf8'))
        : { version: JSON.parse(fs.readFileSync(new URL('package.json', root), 'utf8')).version };
      process.stdout.write(`vika ${release.version}${release.platform ? ` (${release.platform})` : ''}\n`);
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return 0;
    default:
      break;
  }
  process.stderr.write(USAGE);
  return 2;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.name === 'PromptAborted' ? '已取消' : error.message}\n`);
  process.exitCode = 1;
}
