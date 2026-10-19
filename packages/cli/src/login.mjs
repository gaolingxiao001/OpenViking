import { bundledLarkCli } from '../../daemon/src/lark-cli-bin.mjs';
import { restartCommand } from './control.mjs';
import { askEmail, mailboxesOf, writeEmailAccount } from './email.mjs';
import { IM_LABELS, chooseInstance, loadInstances } from './instances.mjs';
import { LarkCli } from './lark-cli.mjs';
import { showScan } from './qr.mjs';
import { which } from './runtimes.mjs';
import { WEIXIN_FIRST_MESSAGE, connectWeixin, larkScopes } from './setup.mjs';

// `vika login <lark|weixin|email> [instance]`: authorize again what an
// instance already has, after a login expired or a password changed.
// Connecting something new is `vika setup` (change the instance). The
// instance may be left out when there is only one, and is chosen otherwise.

const USAGE = '用法：vika login <lark|weixin|email> [实例]\n'
  + '  登录过期或改了密码后重新授权；要接入新的 IM，运行 vika setup 修改实例。只有一个实例时可以不写实例名。\n';

function larkCliBin(env, deployment) {
  const bundled = bundledLarkCli();
  return env.LARK_CLI_BIN || deployment.env?.LARK_CLI_BIN || (bundled === 'lark-cli' ? which('lark-cli', env) : bundled);
}

async function restart({ agent, prompter, env, control }) {
  try {
    await control.restart(agent.id, { env });
    return true;
  } catch (error) {
    prompter.write(`\n配置已更新，但实例没能重启：${error.message}\n修好后运行 vika restart ${agent.id}\n`);
    return false;
  }
}

export async function loginCommand([connector, requested, ...extra], {
  prompter,
  env = process.env,
  connect = { weixin: connectWeixin, email: askEmail },
  control = { restart: restartCommand },
} = {}) {
  if (!['lark', 'weixin', 'email'].includes(connector) || extra.length) {
    prompter.write(USAGE);
    return 2;
  }
  const label = IM_LABELS[connector];
  const deployment = loadInstances(env);
  if (!deployment) throw new Error('还没有任何实例：先运行 vika setup');
  const named = requested && deployment.agents.find((agent) => agent.id === requested);
  if (named && !named.connectors.includes(connector)) {
    throw new Error(`实例 ${requested} 没有接${label}；要接入，运行 vika setup，选择修改 ${requested}`);
  }
  // Only the instances that have it can renew it.
  const having = { ...deployment, agents: deployment.agents.filter((agent) => agent.connectors.includes(connector)) };
  if (having.agents.length === 0) throw new Error(`还没有实例接${label}；要接入，运行 vika setup 修改实例`);
  const agent = await chooseInstance({ deployment: having, requested, prompter, question: `重新授权哪个实例的${label}` });

  if (connector === 'weixin') {
    await connect.weixin({ plan: agent, prompter });
    // A new login starts a new conversation: the owner writes first again.
    prompter.write(`运行中的实例会在下次重连时用上新的登录，不用重启。\n\n最后一步：${WEIXIN_FIRST_MESSAGE}\n`);
    return 0;
  }
  if (connector === 'email') {
    // Each mailbox's Connector reads its account file when it starts.
    const mailboxes = mailboxesOf(agent);
    const shown = (mailbox) => mailbox.address ?? mailbox.id;
    const mailbox = mailboxes.length === 1 ? mailboxes[0] : await prompter.select('更新哪个邮箱的密码',
      mailboxes.map((candidate) => ({ label: shown(candidate), value: candidate })));
    const account = await connect.email({ prompter, fixed: mailbox.account,
      taken: mailboxes.filter((other) => other !== mailbox).map((other) => other.address).filter(Boolean) });
    writeEmailAccount(mailbox.config, account);
    if (!await restart({ agent, prompter, env, control })) return 1;
    prompter.write(`\n${agent.displayName}（${agent.id}）的邮箱 ${account.address} 已更新。\n`);
    return 0;
  }
  const bin = larkCliBin(env, deployment);
  if (!bin) throw new Error('找不到 lark-cli：这个安装不完整，重新运行安装脚本');
  const larkCli = new LarkCli(bin);
  const login = await larkCli.beginUserLogin({ profile: agent.profile, scopes: larkScopes().user });
  const scan = showScan(prompter, {
    url: login.url, where: '飞书', title: `扫码重新授权 ${agent.displayName}（${agent.profile}）以你的身份读消息`, label: '等待授权',
  });
  try {
    await larkCli.finishUserLogin({ profile: agent.profile, deviceCode: login.deviceCode });
  } finally {
    scan.stop();
  }
  prompter.success(`${agent.profile} 已重新授权；运行中的实例会自动用上新的登录`);
  return 0;
}
