import { createRequire } from 'node:module';
import { loginWeixin } from '../../daemon/src/weixin/auth.mjs';
import { WeixinState } from '../../daemon/src/weixin/state.mjs';
import { LarkCli } from './lark-cli.mjs';
import { larkScopes } from './setup.mjs';
import { showQr } from './qr.mjs';
import { which } from './runtimes.mjs';
import { bundledLarkCli } from '../../daemon/src/lark-cli-bin.mjs';

// `vika login lark|weixin <instance>`: redo one IM's authorization for an
// instance that already exists, e.g. after a login expired. Only the
// instance's own entry in the manifest is read.

const require = createRequire(import.meta.url);
const { loadDeploymentManifest, selectDeploymentAgent } = require('../../../deployment-config.cjs');

export async function loginCommand([connector, id, ...extra], { env = process.env, output = process.stdout, prompter } = {}) {
  if (!['lark', 'weixin'].includes(connector) || !id || extra.length) {
    output.write('usage: vika login <lark|weixin> <instance>\n');
    return 2;
  }
  const deployment = loadDeploymentManifest(env);
  const agent = selectDeploymentAgent(deployment, id);
  if (!agent.connectors.includes(connector)) throw new Error(`instance ${id} does not use the ${connector} connector`);
  if (connector === 'weixin') {
    const state = new WeixinState(agent.dataDir);
    try {
      await loginWeixin({ state, ...(prompter ? { readVerifyCode: (question) => prompter.text(question.replace(/：$/, '')) } : {}) });
    } finally {
      state.close();
    }
    return 0;
  }
  const bundled = bundledLarkCli();
  const bin = env.LARK_CLI_BIN || deployment.env?.LARK_CLI_BIN || (bundled === 'lark-cli' ? which('lark-cli', env) : bundled);
  if (!bin) throw new Error('lark-cli is not installed');
  const larkCli = new LarkCli(bin);
  const login = await larkCli.beginUserLogin({ profile: agent.profile, scopes: larkScopes().user });
  showQr(output, login.url, `扫码授权 ${agent.displayName}（${agent.profile}）以你的身份读消息`);
  await larkCli.finishUserLogin({ profile: agent.profile, deviceCode: login.deviceCode });
  output.write(`${agent.profile} 已重新授权；运行中的实例会自动用上新的登录\n`);
  return 0;
}
