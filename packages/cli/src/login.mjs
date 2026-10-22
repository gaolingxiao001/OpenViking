import { bundledLarkCli } from '../../daemon/src/lark-cli-bin.mjs';
import { restartCommand, stopCommand } from './control.mjs';
import { connectTelegram } from './telegram.mjs';
import { connectQQ } from './qq.mjs';
import { connectSlack } from './slack.mjs';
import { askEmail, mailboxesOf, writeEmailAccount } from './email.mjs';
import { t } from './i18n.mjs';
import { IM_LABELS, chooseInstance, loadInstances } from './instances.mjs';
import { LarkCli } from './lark-cli.mjs';
import { LarkRegistrationError, grantedUserScopes, lacksAny, readApp } from './lark-app.mjs';
import { showScan } from './qr.mjs';
import { which } from './runtimes.mjs';
import { connectWeixin, larkScopes, registerApp, reportApp, weixinFirstMessage } from './setup.mjs';

// `vika login <lark|weixin|email|telegram|slack|qq> [instance]`: authorize again what an
// instance already has, after a login expired or a password changed. For
// Feishu/Lark it first checks the app has what Vika needs, and an owner or
// administrator of the app can add what it lacks with one scan.
// Connecting something new is `vika setup` (change the instance). The
// instance may be left out when there is only one, and is chosen otherwise.

const usage = () => t(
  '用法：vika login <lark|weixin|email|telegram|slack|qq> [实例]\n'
  + '  登录过期或改了密码后重新授权；要接入新的 IM，运行 vika setup 修改实例。只有一个实例时可以不写实例名。\n',
  'Usage: vika login <lark|weixin|email|telegram|slack|qq> [instance]\n'
  + '  Authorize again after a login expired or a password changed; to connect a new IM, change the instance with vika setup. With one instance the name can be left out.\n',
);

function larkCliBin(env, deployment) {
  const bundled = bundledLarkCli();
  return env.LARK_CLI_BIN || deployment.env?.LARK_CLI_BIN || (bundled === 'lark-cli' ? which('lark-cli', env) : bundled);
}

// The app as its bot reads it, then what it lacks; one `update` scan adds
// that, the platform's confirm page showing the change. Resolves with what
// was read last, or null when the app's settings cannot be read.
async function completeApp({ agent, prompter, larkCli, scopes, register }) {
  const read = async () => {
    const spinning = prompter.spin(t('核对应用的权限和事件', 'Checking the app\'s permissions and events'));
    try {
      const app = await readApp((pathname, query) => larkCli.get({ profile: agent.profile, pathname, query }));
      spinning.succeed(t(`应用 ${app.appId} 已读取`, `Read the app ${app.appId}`));
      return app;
    } catch (error) {
      spinning.warn(t(`读不到应用的配置，跳过核对：${error.message}`, `The app's settings could not be read, so they are not checked: ${error.message}`));
      return null;
    }
  };
  const inspected = await read();
  if (!inspected || !lacksAny(reportApp(prompter, scopes, inspected))) return inspected;
  // The confirm page withdraws a version under review before publishing its
  // own, and the approval starts over: not by default.
  if (inspected.pendingReview) {
    prompter.warn(t('应用有一个版本正在审核：扫码补齐时，飞书会先撤回它再提交新版本，审批要重新排队。',
      'A version of the app is under review: adding what is missing withdraws it first and submits a new one, so the approval starts over.'));
  }
  if (!await prompter.confirm(t('扫码把缺的补上？要你是这个应用的所有者或管理员', 'Scan to add what is missing? You need to own or administer the app'),
    !inspected.pendingReview)) {
    return inspected;
  }
  let updated;
  try {
    updated = await registerApp({ plan: agent, prompter, scopes, mode: 'update', appId: inspected.appId, ...(register ? { register } : {}) });
  } catch (error) {
    if (!(error instanceof LarkRegistrationError)) throw error;
    prompter.warn(t(`应用没有更新（${error.code}）：${error.message}`, `The app was not updated (${error.code}): ${error.message}`));
    return inspected;
  }
  if (!updated) {
    prompter.info(t('跳过了，应用没有改动', 'Skipped; the app is unchanged'));
    return inspected;
  }
  prompter.success(t('平台已确认', 'The platform confirmed it'));
  const after = await read();
  if (after) reportApp(prompter, scopes, after);
  return after ?? inspected;
}

async function restart({ agent, prompter, env, control }) {
  try {
    await control.restart(agent.id, { env });
    return true;
  } catch (error) {
    prompter.write(t(`\n配置已更新，但实例没能重启：${error.message}\n修好后运行 vika restart ${agent.id}\n`,
      `\nSaved, but the instance did not restart: ${error.message}\nOnce that is fixed, run vika restart ${agent.id}\n`));
    return false;
  }
}

export async function loginCommand([connector, requested, ...extra], {
  prompter,
  env = process.env,
  connect = { weixin: connectWeixin, telegram: connectTelegram, slack: connectSlack, qq: connectQQ, email: askEmail },
  control = { restart: restartCommand, stop: stopCommand },
} = {}) {
  if (!['lark', 'weixin', 'email', 'telegram', 'slack', 'qq'].includes(connector) || extra.length) {
    prompter.write(usage());
    return 2;
  }
  const label = IM_LABELS[connector];
  const deployment = loadInstances(env);
  if (!deployment) throw new Error(t('还没有任何实例：先运行 vika setup', 'No instance yet: run vika setup first'));
  const named = requested && deployment.agents.find((agent) => agent.id === requested);
  if (named && !named.connectors.includes(connector)) {
    throw new Error(t(`实例 ${requested} 没有接${label}；要接入，运行 vika setup，选择修改 ${requested}`,
      `Instance ${requested} has no ${label}; to connect it, run vika setup and change ${requested}`));
  }
  // Only the instances that have it can renew it.
  const having = { ...deployment, agents: deployment.agents.filter((agent) => agent.connectors.includes(connector)) };
  if (having.agents.length === 0) throw new Error(t(`还没有实例接${label}；要接入，运行 vika setup 修改实例`, `No instance has ${label}; to connect it, change an instance with vika setup`));
  const agent = await chooseInstance({ deployment: having, requested, prompter, question: t(`重新授权哪个实例的${label}`, `Which instance's ${label} to authorize again`) });

  // Only one receiver at a time: the instance stops while the new tokens are checked.
  if (['telegram', 'slack', 'qq'].includes(connector)) {
    prompter.write(t(`验证新密钥时会暂时停止这个实例，避免同时接收 ${label} 消息；完成后重新启动。\n`,
      'The instance stops while the new credentials are checked, so nothing else receives its messages; it starts again afterwards.\n'));
    await control.stop(agent.id, { env });
    try { await connect[connector]({ plan: agent, prompter }); } catch (error) {
      await control.restart(agent.id, { env }).catch(() => {
        prompter.write(t(`实例没有恢复启动；请运行 vika restart ${agent.id}\n`, `The instance did not start again; run vika restart ${agent.id}\n`));
      });
      throw error;
    }
    if (!await restart({ agent, prompter, env, control })) return 1;
    prompter.write(t(`\n${agent.displayName}（${agent.id}）的 ${label} 已更新。\n`, `\n${label} is updated for ${agent.displayName} (${agent.id}).\n`));
    return 0;
  }

  if (connector === 'weixin') {
    await connect.weixin({ plan: agent, prompter });
    // A new login starts a new conversation: the owner writes first again.
    prompter.write(t(`运行中的实例会在下次重连时用上新的登录，不用重启。\n\n最后一步：${weixinFirstMessage()}\n`,
      `The running instance picks up the new login when it reconnects; no restart needed.\n\nLast step: ${weixinFirstMessage()}\n`));
    return 0;
  }
  if (connector === 'email') {
    // Each mailbox's Connector reads its account file when it starts.
    const mailboxes = mailboxesOf(agent);
    const shown = (mailbox) => mailbox.address ?? mailbox.id;
    const mailbox = mailboxes.length === 1 ? mailboxes[0] : await prompter.select(t('更新哪个邮箱的密码', 'Which mailbox has a new password'),
      mailboxes.map((candidate) => ({ label: shown(candidate), value: candidate })));
    const account = await connect.email({ prompter, fixed: mailbox.account,
      taken: mailboxes.filter((other) => other !== mailbox).map((other) => other.address).filter(Boolean) });
    writeEmailAccount(mailbox.config, account);
    if (!await restart({ agent, prompter, env, control })) return 1;
    prompter.write(t(`\n${agent.displayName}（${agent.id}）的邮箱 ${account.address} 已更新。\n`, `\nMailbox ${account.address} is updated for ${agent.displayName} (${agent.id}).\n`));
    return 0;
  }
  const bin = larkCliBin(env, deployment);
  if (!bin) throw new Error(t('找不到 lark-cli：这个安装不完整，重新运行安装脚本', 'lark-cli is missing: this install is incomplete, run the installer again'));
  const larkCli = new LarkCli(bin);
  const scopes = larkScopes();
  const inspected = await completeApp({ agent, prompter, larkCli, scopes, register: connect.register });
  const login = await larkCli.beginUserLogin({ profile: agent.profile, scopes: grantedUserScopes(scopes, inspected) });
  const scan = showScan(prompter, {
    url: login.url, where: IM_LABELS.lark, label: t('等待授权', 'Waiting for authorization'),
    title: t(`扫码重新授权 ${agent.displayName}（${agent.profile}）以你的身份读消息`, `Scan to let ${agent.displayName} (${agent.profile}) read messages as you again`),
  });
  try {
    await larkCli.finishUserLogin({ profile: agent.profile, deviceCode: login.deviceCode });
  } finally {
    scan.stop();
  }
  prompter.success(t(`${agent.profile} 已重新授权；运行中的实例会自动用上新的登录`, `${agent.profile} is authorized again; the running instance picks it up by itself`));
  return 0;
}
