import { bundledLarkCli } from '../../daemon/src/lark-cli-bin.mjs';
import { restartCommand } from './control.mjs';
import { IM_LABELS, chooseInstance, loadInstances } from './instances.mjs';
import { LarkCli } from './lark-cli.mjs';
import { readManifest, validateManifest, withConnector, writeManifest } from './manifest.mjs';
import { showQr } from './qr.mjs';
import { which } from './runtimes.mjs';
import { connectLark, connectWeixin, greet, larkScopes } from './setup.mjs';

// `vika login <lark|weixin> [instance]`: connect an IM to an instance, or
// authorize it again after a login expired. The instance may be left out
// when there is only one, and is chosen from a list otherwise. Connecting a
// new IM is the same scan as in setup, then the instance restarts with it.

function larkCliBin(env, deployment) {
  const bundled = bundledLarkCli();
  return env.LARK_CLI_BIN || deployment.env?.LARK_CLI_BIN || (bundled === 'lark-cli' ? which('lark-cli', env) : bundled);
}

async function reauthorize({ connector, agent, deployment, prompter, env, connect }) {
  if (connector === 'weixin') {
    await connect.weixin({ plan: agent, prompter });
    prompter.write('运行中的实例会在下次重连时用上新的登录，不用重启。\n');
    return 0;
  }
  const bin = larkCliBin(env, deployment);
  if (!bin) throw new Error('找不到 lark-cli：这个安装不完整，重新运行安装脚本');
  const larkCli = new LarkCli(bin);
  const login = await larkCli.beginUserLogin({ profile: agent.profile, scopes: larkScopes().user });
  showQr(prompter.output, login.url, `扫码重新授权 ${agent.displayName}（${agent.profile}）以你的身份读消息`);
  await larkCli.finishUserLogin({ profile: agent.profile, deviceCode: login.deviceCode });
  prompter.write(`${agent.profile} 已重新授权；运行中的实例会自动用上新的登录\n`);
  return 0;
}

export async function loginCommand([connector, requested, ...extra], {
  prompter,
  env = process.env,
  fetchImpl = globalThis.fetch,
  connect = { lark: connectLark, weixin: connectWeixin, greet },
  control = { restart: restartCommand },
} = {}) {
  if (!['lark', 'weixin'].includes(connector) || extra.length) {
    prompter.write('用法：vika login <lark|weixin> [实例]\n  接入一个 IM，或在登录过期后重新授权；只有一个实例时可以不写实例名。\n');
    return 2;
  }
  const label = IM_LABELS[connector];
  const deployment = loadInstances(env);
  const agent = await chooseInstance({ deployment, requested, prompter, question: `给哪个实例${label === '飞书' ? '接飞书' : '接微信'}` });
  if (agent.connectors.includes(connector)) {
    return reauthorize({ connector, agent, deployment, prompter, env, connect });
  }

  // A new IM for this instance: check the manifest the daemon would load
  // before the scan, write it only after the scan succeeded.
  const { path: configPath, value: manifest } = readManifest(env);
  const profile = connector === 'lark' ? `vika-${agent.id}` : undefined;
  const next = withConnector(manifest, agent.id, connector, profile ? { profile } : {});
  validateManifest(configPath, next);
  prompter.write(`实例 ${agent.id}（${agent.displayName}）还没有接${label}，现在接入；完成后会重启这个实例。\n`);
  let lark = null;
  if (connector === 'lark') {
    const bin = larkCliBin(env, deployment);
    if (!bin) throw new Error('找不到 lark-cli：这个安装不完整，重新运行安装脚本');
    lark = await connect.lark({ plan: agent, prompter, larkCli: new LarkCli(bin), fetchImpl, profile, debug: Boolean(env.VIKA_DEBUG) });
    lark.bin = bin;
  } else {
    await connect.weixin({ plan: agent, prompter });
  }
  writeManifest(configPath, next);
  try {
    await control.restart(agent.id, { env });
  } catch (error) {
    prompter.write(`\n配置已更新，但实例没能重启：${error.message}\n修好后运行 vika restart ${agent.id}\n`);
    return 1;
  }
  if (lark) {
    await connect.greet({
      larkCliBin: lark.bin, profile, userId: lark.ownerOpenId,
      text: `你好，我是 ${agent.displayName}，现在也能在飞书里找到我了。`,
    }).catch((error) => prompter.write(`  打招呼的消息没发出去：${error.message}\n`));
  }
  prompter.write(`\n${agent.displayName}（${agent.id}）已接入${label}。\n`);
  return 0;
}
