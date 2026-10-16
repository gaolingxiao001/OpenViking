import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginWeixin } from '../../daemon/src/weixin/auth.mjs';
import { WeixinState } from '../../daemon/src/weixin/state.mjs';
import { bundledLarkCli } from '../../daemon/src/lark-cli-bin.mjs';
import { LarkCli } from './lark-cli.mjs';
import { createApp, inspectApp, missingScopes } from './lark-app.mjs';
import {
  allocatePort, instanceIdProblem, readManifest, suggestInstanceId, validateManifest, vikaHome, withInstance, writeManifest,
} from './manifest.mjs';
import { detectOpenViking, writeInstanceOvConfig } from './ov.mjs';
import { detectRuntimes, which } from './runtimes.mjs';
import { showQr } from './qr.mjs';
import { restartCommand, startCommand } from './control.mjs';

// `vika setup`: add one instance. Every question comes first, then the QR
// scans, then the manifest is written and the instance started. Nothing is
// saved until all scans succeed, so an aborted setup leaves the manifest as it was.

const PERMISSIONS = new URL('../../../permission.json', import.meta.url);

function resolveLarkCli(env) {
  const bundled = bundledLarkCli();
  return bundled === 'lark-cli' ? which('lark-cli', env) : bundled;
}

export function expandHome(value, homeDir = os.homedir()) {
  return value === '~' ? homeDir : value.replace(/^~(?=\/)/, homeDir);
}

export function larkScopes() {
  const { scopes } = JSON.parse(fs.readFileSync(PERMISSIONS, 'utf8'));
  return { tenant: scopes.tenant, user: scopes.user };
}

async function askPlan({ prompter, manifest, env, homeDir, runtimes, ov }) {
  const out = (text) => prompter.write(text);
  const id = await prompter.text('实例名称', {
    initial: suggestInstanceId(manifest),
    validate: (value) => instanceIdProblem(value, manifest),
  });
  const displayName = await prompter.text('机器人名字（也是飞书应用名，@它时用这个名字）', {
    initial: 'Vika',
    validate: (value) => (value.length > 40 ? '最多 40 个字符' : null),
  });
  const dataDir = path.join(vikaHome(env), 'data', id);
  const workspace = path.resolve(expandHome(await prompter.text('工作目录（agent 在这里读写文件）', {
    initial: path.join('~', 'vika-workspace', id),
    validate: (value) => {
      const resolved = path.resolve(expandHome(value, homeDir));
      if (resolved === homeDir) return '不要直接用 home 目录，换一个子目录';
      if (resolved.startsWith(`${vikaHome(env)}${path.sep}`)) return '不能放在 ~/.vika 里';
      return null;
    },
  }), homeDir));

  const runtimeIndex = runtimes.findIndex((runtime) => runtime.available);
  const runtime = await prompter.select('Agent 运行时', runtimes.map((runtime) => ({
    label: runtime.label, value: runtime, hint: runtime.note, disabled: !runtime.available,
  })), { initial: runtimeIndex });

  const connectors = await prompter.multiselect('接入哪些 IM', [
    { label: '飞书', value: 'lark' },
    { label: '微信', value: 'weixin' },
    { label: '邮箱', value: 'email', hint: '暂不支持在 setup 里配置，见 README', disabled: true },
  ], { initial: [0] });
  const channel = connectors.length > 1
    ? await prompter.select('主渠道（给你发通知用）', connectors.map((connector) => ({
      label: connector === 'lark' ? '飞书' : '微信', value: connector,
    })))
    : connectors[0];

  let useOv = false;
  if (ov?.usable) {
    useOv = await prompter.select('OpenViking（跨会话记忆）', [
      { label: '使用本机检测到的 OpenViking', value: true, hint: `${ov.url}${ov.user ? `  user=${ov.user}` : ''}` },
      { label: '跳过', value: false },
    ]);
  } else if (ov) {
    out(`  检测到 OpenViking（${ov.url}），但现在用不了：${ov.reason}。先跳过，以后可以重新运行 setup。\n`);
  } else {
    out('  没有检测到 OpenViking，跳过。以后装好 OV 后可以重新运行 setup。\n');
  }
  return { id, displayName, dataDir, workspace, runtime, connectors, channel, useOv };
}

// If the confirmation never arrives, the app may still exist: its App ID and
// App Secret (developer console → 凭证与基础信息) let setup carry on.
async function manualApp(prompter) {
  prompter.write('\n  在飞书开放平台打开刚创建的应用 →「凭证与基础信息」，复制下面两项：\n');
  const appId = await prompter.text('App ID', { validate: (value) => (/^cli_[0-9a-z]+$/.test(value) ? null : 'App ID 以 cli_ 开头') });
  const appSecret = await prompter.secret('App Secret');
  const brand = await prompter.select('租户', [{ label: '飞书', value: 'feishu' }, { label: 'Lark（国际版）', value: 'lark' }]);
  return { appId, appSecret, brand, ownerOpenId: null };
}

export async function registerApp({ plan, prompter, scopes, debug, register = null }) {
  const out = (text) => prompter.write(text);
  const controller = new AbortController();
  let waiting = null;
  let last = '等待扫码';
  const started = Date.now();
  const manual = prompter.watchKey('m');
  const tick = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    out(`\r\x1b[2K  ${last} ${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}（迟迟没有进展可以按 m 手动填写 App ID 和 Secret）`);
  };
  const created = createApp({
    name: plan.displayName,
    description: 'Vika：把本机的 coding agent 接进飞书',
    scopes,
    signal: controller.signal,
    ...(register ? { register } : {}),
    onQRCode: ({ url, expiresIn }) => {
      showQr(prompter.output, url, `第 1 次扫码：用飞书 App 扫码创建机器人应用（${Math.round(expiresIn / 60)} 分钟内有效）`);
      if (prompter.tty) waiting = setInterval(tick, 1000);
    },
    onStatus: (status) => {
      if (debug) out(`\n  [registration] ${status}\n`);
      if (status === 'domain_switched') out('\n  识别到国际版 Lark 租户\n');
      last = status === 'slow_down' ? '平台要求放慢轮询' : status === 'polling' ? '等待扫码确认' : last;
    },
  });
  try {
    const winner = await Promise.race([created.then((app) => ({ app })), manual.pressed.then((pressed) => ({ manual: pressed }))]);
    if (winner?.app) return winner.app;
    controller.abort();
    created.catch(() => {});
    if (waiting) { clearInterval(waiting); waiting = null; out('\n'); }
    return await manualApp(prompter);
  } finally {
    if (waiting) { clearInterval(waiting); out('\n'); }
    manual.stop();
  }
}

async function connectLark({ plan, prompter, larkCli, fetchImpl, profile, debug = false }) {
  const out = (text) => prompter.write(text);
  const scopes = larkScopes();
  out('\n── 飞书 ──\n');
  const app = await registerApp({ plan, prompter, scopes, debug });
  out(`  已创建应用 ${app.appId}\n`);
  const inspected = await inspectApp(app, { fetchImpl });
  const missing = missingScopes(scopes, inspected.granted);
  if (!inspected.online) out('  ⚠ 应用还没有上线版本，可能在等管理员审核；审核通过后机器人才能收消息。\n');
  if (missing.tenant.length || missing.user.length) {
    out(`  ⚠ 有 ${missing.tenant.length + missing.user.length} 个权限没开通，相关功能会不可用：${[...missing.tenant, ...missing.user].slice(0, 8).join('、')}${missing.tenant.length + missing.user.length > 8 ? ' 等' : ''}\n`);
  } else {
    out(`  权限核对通过：${scopes.tenant.length} 个机器人权限、${scopes.user.length} 个用户权限\n`);
  }
  await larkCli.configureProfile({ profile, ...app });
  const login = await larkCli.beginUserLogin({ profile, scopes: scopes.user });
  showQr(prompter.output, login.url, '第 2 次扫码：授权 Vika 以你的身份读消息（用于搜索和读历史）');
  await larkCli.finishUserLogin({ profile, deviceCode: login.deviceCode });
  const ownerOpenId = await larkCli.userOpenId({ profile });
  if (!ownerOpenId) throw new Error('lark-cli authorization finished without a user identity');
  if (app.ownerOpenId && ownerOpenId !== app.ownerOpenId) {
    out('  ⚠ 两次扫码的不是同一个飞书账号；机器人会把第 2 次扫码的人当作主人。\n');
  }
  out('  飞书已接好\n');
  return { profile, ownerOpenId };
}

async function connectWeixin({ plan, prompter }) {
  prompter.write('\n── 微信 ──\n');
  fs.mkdirSync(plan.dataDir, { recursive: true, mode: 0o700 });
  const state = new WeixinState(plan.dataDir);
  try {
    await loginWeixin({ state, readVerifyCode: (question) => prompter.text(question.replace(/：$/, '')) });
  } finally {
    state.close();
  }
}

function greet({ larkCliBin, profile, userId, text }) {
  return new LarkCli(larkCliBin).sendText({ profile, userId, text });
}

export async function setupCommand({
  prompter,
  env = process.env,
  homeDir = os.homedir(),
  fetchImpl = globalThis.fetch,
  detect = { runtimes: detectRuntimes, openViking: detectOpenViking },
  connect = { lark: connectLark, weixin: connectWeixin, greet },
  control = { start: startCommand, restart: restartCommand },
  allocate = allocatePort,
} = {}) {
  const out = (text) => prompter.write(text);
  out('Vika setup：给这台机器添加一个 agent 实例。\n\n');
  const { path: configPath, value: manifest } = readManifest(env);
  const [runtimes, ov] = await Promise.all([
    detect.runtimes({ env }),
    detect.openViking({ env, homeDir, fetchImpl }),
  ]);
  if (!runtimes.some((runtime) => runtime.available)) {
    out('没有可用的 agent 运行时：\n');
    for (const runtime of runtimes) out(`  ${runtime.label}：${runtime.note}\n`);
    return 1;
  }
  const plan = await askPlan({ prompter, manifest, env, homeDir, runtimes, ov });

  // The release's own lark-cli, unless the manifest or environment pins another.
  const larkCliBin = plan.connectors.includes('lark')
    ? (env.LARK_CLI_BIN || manifest?.env?.LARK_CLI_BIN || resolveLarkCli(env))
    : null;
  if (plan.connectors.includes('lark') && !larkCliBin) {
    out('\n找不到 lark-cli：这个安装不完整，重新运行安装脚本。\n');
    return 1;
  }

  // The whole instance is known before any scan, so a manifest the daemon
  // would reject fails here rather than after two QR codes.
  const ovConfig = plan.useOv ? path.join(vikaHome(env), 'ov', `${plan.id}.json`) : null;
  const agent = {
    id: plan.id,
    displayName: plan.displayName,
    channel: plan.channel,
    connectors: plan.connectors,
    ...(plan.connectors.includes('lark') ? { profile: `vika-${plan.id}` } : {}),
    port: await allocate(manifest),
    dataDir: plan.dataDir,
    workspace: plan.workspace,
    ...(ovConfig ? { ovConfig } : {}),
    model: plan.runtime.model,
  };
  const next = withInstance(manifest, agent,
    plan.runtime.binEnv && plan.runtime.bin ? { [plan.runtime.binEnv]: plan.runtime.bin } : {});
  validateManifest(configPath, next);

  out(`\n将添加实例 ${plan.id}：${plan.runtime.label}，${plan.connectors.map((c) => (c === 'lark' ? '飞书' : '微信')).join(' + ')}`
    + `，${plan.useOv ? '使用' : '不使用'} OpenViking\n  工作目录 ${plan.workspace}\n  数据目录 ${plan.dataDir}\n`);
  if (!await prompter.confirm('开始扫码？')) return 1;

  const lark = plan.connectors.includes('lark')
    ? await connect.lark({ plan, prompter, larkCli: new LarkCli(larkCliBin), fetchImpl, profile: agent.profile, debug: Boolean(env.VIKA_DEBUG) })
    : null;
  if (plan.connectors.includes('weixin')) await connect.weixin({ plan, prompter });
  if (ovConfig) writeInstanceOvConfig({ detected: ov, instanceId: plan.id, target: ovConfig });

  fs.mkdirSync(plan.workspace, { recursive: true, mode: 0o700 });
  writeManifest(configPath, next);
  out(`\n已写入 ${configPath}\n`);

  try {
    await control.start(plan.id, { env });
  } catch (error) {
    out(`\n配置已保存，但启动没有完成：${error.message}\n修好后运行 vika start ${plan.id}\n`);
    return 1;
  }
  // The instance is up. The shared Web (it routes to every instance, so it
  // restarts to pick this one up) and the updater are helpers: report, go on.
  for (const [action, target] of [['restart', 'web'], ['start', 'updater']]) {
    await control[action](target, { env }).catch((error) => {
      out(`  ⚠ vika-${target} 没有起来：${error.message}；之后运行 vika ${action} ${target}\n`);
    });
  }
  if (lark) {
    await connect.greet({
      larkCliBin,
      profile: lark.profile,
      userId: lark.ownerOpenId,
      text: `你好，我是 ${plan.displayName}，已经在你的电脑上跑起来了。直接给我发消息就行；把我拉进群，我也能参与群聊。`,
    }).catch((error) => out(`  打招呼的消息没发出去：${error.message}\n`));
  }
  out(`\n${plan.displayName}（${plan.id}）已就绪。\n`);
  return 0;
}
