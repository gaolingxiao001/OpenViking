import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginWeixin } from '../../daemon/src/weixin/auth.mjs';
import { sendWeixinMessage } from '../../daemon/src/weixin/send.mjs';
import { WeixinState } from '../../daemon/src/weixin/state.mjs';
import { bundledLarkCli } from '../../daemon/src/lark-cli-bin.mjs';
import { LarkCli } from './lark-cli.mjs';
import { createApp, inspectApp, missingScopes } from './lark-app.mjs';
import {
  allocatePort, instanceIdProblem, readManifest, suggestInstanceId, validateManifest, vikaHome, withChangedInstance,
  withInstance, writeManifest,
} from './manifest.mjs';
import { detectOpenViking, writeInstanceOvConfig } from './ov.mjs';
import { detectRuntimes, which } from './runtimes.mjs';
import { showQr } from './qr.mjs';
import { restartCommand, startCommand } from './control.mjs';
import { askEmail, emailAccountPath, emailInstanceId, mailboxesOf, writeEmailAccount } from './email.mjs';
import { IM_LABELS, PRIMARY_MEANING, connectorsOf, imList } from './instances.mjs';

// `vika setup`: add an instance, or change one. Every question comes first
// (when changing, each defaults to what the instance has now), then the QR
// scans, then the manifest is written and the instance (re)started. Nothing
// is saved until all scans succeed, so an aborted setup leaves things as they were.
// It is also the one place that connects an IM; `vika login` only renews.

const PERMISSIONS = new URL('../../../permission.json', import.meta.url);

function resolveLarkCli(env) {
  const bundled = bundledLarkCli();
  return bundled === 'lark-cli' ? which('lark-cli', env) : bundled;
}

export function expandHome(value, homeDir = os.homedir()) {
  return value === '~' ? homeDir : value.replace(/^~(?=\/)/, homeDir);
}

function shortenHome(value, homeDir) {
  return value.startsWith(`${homeDir}${path.sep}`) ? path.join('~', path.relative(homeDir, value)) : value;
}

export function larkScopes() {
  const { scopes } = JSON.parse(fs.readFileSync(PERMISSIONS, 'utf8'));
  return { tenant: scopes.tenant, user: scopes.user };
}

const IM_CHOICES = [
  { label: '飞书', value: 'lark' },
  { label: '微信', value: 'weixin' },
  { label: '邮箱', value: 'email', hint: 'IMAP/SMTP；新邮件提醒和回信确认发到主渠道' },
];

// Which instance to change, or a new one.
async function chooseTarget(prompter, manifest) {
  const agents = manifest?.agents ?? [];
  if (agents.length === 0) return null;
  return prompter.select('要做什么', [
    { label: '新建一个实例', value: null },
    ...agents.map((agent) => ({
      label: `修改 ${agent.displayName}（${agent.id}）`, hint: imList(connectorsOf(agent), agent.emailAccounts?.length), value: agent,
    })),
  ]);
}

// Every question but the mailboxes. `current` is the instance being changed.
async function askPlan({ prompter, manifest, env, homeDir, runtimes, ov, current = null }) {
  const out = (text) => prompter.write(text);
  const id = current?.id ?? await prompter.text('实例名称', {
    initial: suggestInstanceId(manifest),
    validate: (value) => instanceIdProblem(value, manifest),
  });
  const hasLark = current && connectorsOf(current).includes('lark');
  const displayName = await prompter.text(hasLark
    ? '机器人名字（已经建好的飞书应用名不会跟着改）'
    : '机器人名字（也是飞书应用名，@它时用这个名字）', {
    initial: current?.displayName ?? 'Vika',
    validate: (value) => (value.length > 40 ? '最多 40 个字符' : null),
  });
  const dataDir = current?.dataDir ?? path.join(vikaHome(env), 'data', id);
  const workspace = path.resolve(expandHome(await prompter.text('工作目录（agent 在这里读写文件）', {
    initial: current ? shortenHome(current.workspace, homeDir) : path.join('~', 'vika-workspace', id),
    validate: (value) => {
      const resolved = path.resolve(expandHome(value, homeDir));
      if (resolved === homeDir) return '不要直接用 home 目录，换一个子目录';
      if (resolved.startsWith(`${vikaHome(env)}${path.sep}`)) return '不能放在 ~/.vika 里';
      return null;
    },
  }), homeDir));

  // A runtime that is no longer detected stays selectable as it is.
  const kept = current && !runtimes.some((runtime) => runtime.available && runtime.model === current.model)
    ? [{ label: `保持现在的（${current.model}）`, model: current.model, available: true, note: '', kept: true }] : [];
  const choices = [...kept, ...runtimes];
  const runtimeIndex = Math.max(0, choices.findIndex((runtime) => runtime.available && (!current || runtime.model === current.model)));
  const runtime = await prompter.select('Agent 运行时', choices.map((runtime) => ({
    label: runtime.label, value: runtime, hint: runtime.note, disabled: !runtime.available,
  })), { initial: runtimeIndex });

  const had = current ? connectorsOf(current) : ['lark'];
  let connectors;
  for (;;) {
    connectors = await prompter.multiselect('接入哪些 IM', IM_CHOICES,
      { initial: IM_CHOICES.map(({ value }, index) => (had.includes(value) || (value === 'email' && current?.emailAccounts?.length) ? index : -1)).filter((index) => index >= 0) });
    if (connectors.some((connector) => connector !== 'email')) break;
    out('  邮箱不能单独接：新邮件提醒和回信确认要发到飞书或微信，再选一个。\n');
  }

  // The primary IM is its own question: Feishu unless it is left out.
  const ims = connectors.filter((connector) => connector !== 'email');
  const preferred = [current?.channel, 'lark'].find((im) => ims.includes(im)) ?? ims[0];
  let channel = preferred;
  if (ims.length > 1) {
    channel = await prompter.select(`主渠道：${PRIMARY_MEANING}`,
      ims.map((connector) => ({ label: IM_LABELS[connector], value: connector })), { initial: ims.indexOf(preferred) });
  } else {
    out(`  主渠道是${IM_LABELS[channel]}：${PRIMARY_MEANING}。\n`);
  }

  // 'keep' leaves the instance's OpenViking config as it is.
  let useOv = false;
  if (current?.ovConfig) {
    useOv = await prompter.select('OpenViking（跨会话记忆）', [
      { label: '继续使用', value: 'keep' },
      { label: '不用了', value: false },
    ]);
  } else if (ov?.usable) {
    useOv = await prompter.select('OpenViking（跨会话记忆）', [
      { label: '使用本机检测到的 OpenViking', value: true, hint: `${ov.url}${ov.user ? `  user=${ov.user}` : ''}` },
      { label: '跳过', value: false },
    ], { initial: current ? 1 : 0 });
  } else if (ov) {
    out(`  检测到 OpenViking（${ov.url}），但现在用不了：${ov.reason}。先跳过，以后可以重新运行 setup。\n`);
  } else {
    out('  没有检测到 OpenViking，跳过。以后装好 OV 后可以重新运行 setup。\n');
  }
  return { id, displayName, dataDir, workspace, runtime, connectors, channel, useOv };
}

// The mailboxes after this setup: new ones asked here, an instance's own
// changed from a menu until done. Accounts are written only at the end.
async function planMailboxes({ prompter, env, id, current, connect }) {
  const kept = current ? mailboxesOf(current) : [];
  const added = [];
  const updated = new Map();
  const removed = [];
  const addresses = () => [...kept.map((mailbox) => mailbox.address), ...added.map(({ account }) => account.address)].filter(Boolean);
  const add = async () => {
    const account = await connect.email({ prompter, taken: addresses() });
    const mailboxId = emailInstanceId(account.address, [...kept, ...added].map((mailbox) => mailbox.id));
    added.push({ id: mailboxId, config: emailAccountPath(env, id, mailboxId), account });
  };
  if (kept.length === 0) {
    do await add(); while (await prompter.confirm('再接一个邮箱？', false));
  } else {
    for (;;) {
      const shown = (mailbox) => mailbox.address ?? mailbox.id;
      const choice = await prompter.select(`邮箱（已接入：${[...kept.map(shown), ...added.map(({ account }) => account.address)].join('、')}）`, [
        { label: '不改了', value: { kind: 'done' } },
        { label: '再接一个邮箱', value: { kind: 'add' } },
        ...kept.map((mailbox) => ({ label: `更新 ${shown(mailbox)} 的密码`, value: { kind: 'update', mailbox } })),
        ...kept.map((mailbox) => ({ label: `移除 ${shown(mailbox)}`, value: { kind: 'remove', mailbox } })),
      ]);
      if (choice.kind === 'done') break;
      if (choice.kind === 'add') await add();
      if (choice.kind === 'update') {
        updated.set(choice.mailbox.id, { mailbox: choice.mailbox, account: await connect.email({ prompter, fixed: choice.mailbox.account,
          taken: addresses().filter((address) => address !== choice.mailbox.address) }) });
      }
      if (choice.kind === 'remove') {
        kept.splice(kept.indexOf(choice.mailbox), 1);
        updated.delete(choice.mailbox.id);
        removed.push(choice.mailbox);
      }
    }
  }
  return {
    list: [...kept, ...added].map(({ id: mailboxId, config }) => ({ id: mailboxId, config })),
    write: [...added, ...updated.values()].map(({ config, mailbox, account }) => ({ config: config ?? mailbox.config, account })),
    removed,
    added: added.map(({ account }) => account.address),
    updated: [...updated.values()].map(({ account }) => account.address),
  };
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

export async function connectLark({ plan, prompter, larkCli, fetchImpl, profile, debug = false }) {
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

export async function connectWeixin({ plan, prompter }) {
  prompter.write('\n── 微信 ──\n');
  fs.mkdirSync(plan.dataDir, { recursive: true, mode: 0o700 });
  const state = new WeixinState(plan.dataDir);
  try {
    await loginWeixin({ state, readVerifyCode: (question) => prompter.text(question.replace(/：$/, '')) });
  } finally {
    state.close();
  }
  prompter.write('  微信已接好\n');
}

export function greet({ larkCliBin, profile, userId, text }) {
  return new LarkCli(larkCliBin).sendText({ profile, userId, text });
}

// The bot's first Weixin message to its owner, the account that scanned.
export async function greetWeixin({ dataDir, text }) {
  const state = new WeixinState(dataDir);
  try {
    await sendWeixinMessage({ state, to: state.account()?.userId, content: { type: 'markdown', text },
      idempotencyKey: `vika-greeting-${randomUUID()}` });
  } finally {
    state.close();
  }
}

// What the bot says when an IM is newly connected; on the primary IM, also
// that it reaches the owner there.
function greeting(im, { name, newInstance, primary }) {
  const hello = newInstance
    ? (im === 'lark'
      ? `你好，我是 ${name}，已经在你的电脑上跑起来了。直接给我发消息就行；把我拉进群，我也能参与群聊。`
      : `你好，我是 ${name}，已经在你的电脑上跑起来了。直接在微信里给我发消息就行。`)
    : `你好，我是 ${name}，现在也能在${IM_LABELS[im]}里找到我了。`;
  return primary ? `${hello}以后我主动找你的消息（比如新邮件提醒、待你确认的邮件回复）会发到这里。` : hello;
}

export async function setupCommand({
  prompter,
  env = process.env,
  homeDir = os.homedir(),
  fetchImpl = globalThis.fetch,
  detect = { runtimes: detectRuntimes, openViking: detectOpenViking },
  connect = { lark: connectLark, weixin: connectWeixin, email: askEmail, greet, greetWeixin },
  control = { start: startCommand, restart: restartCommand },
  allocate = allocatePort,
} = {}) {
  const out = (text) => prompter.write(text);
  out('Vika setup：添加或修改这台机器上的 agent 实例。\n\n');
  const { path: configPath, value: manifest } = readManifest(env);
  const [runtimes, ov] = await Promise.all([
    detect.runtimes({ env }),
    detect.openViking({ env, homeDir, fetchImpl }),
  ]);
  const current = await chooseTarget(prompter, manifest);
  if (!current && !runtimes.some((runtime) => runtime.available)) {
    out('没有可用的 agent 运行时：\n');
    for (const runtime of runtimes) out(`  ${runtime.label}：${runtime.note}\n`);
    return 1;
  }
  const plan = await askPlan({ prompter, manifest, env, homeDir, runtimes, ov, current });
  const before = current ? connectorsOf(current) : [];
  const newIms = plan.connectors.filter((connector) => connector !== 'email' && !before.includes(connector));

  // The release's own lark-cli, unless the manifest or environment pins another.
  const larkCliBin = plan.connectors.includes('lark')
    ? (env.LARK_CLI_BIN || manifest?.env?.LARK_CLI_BIN || resolveLarkCli(env))
    : null;
  if (newIms.includes('lark') && !larkCliBin) {
    out('\n找不到 lark-cli：这个安装不完整，重新运行安装脚本。\n');
    return 1;
  }

  // The whole instance is known before any scan, so a manifest the daemon
  // would reject fails here rather than after two QR codes.
  const ovConfig = plan.useOv === 'keep' ? current.ovConfig
    : plan.useOv ? path.join(vikaHome(env), 'ov', `${plan.id}.json`) : null;
  const wantsEmail = plan.connectors.includes('email');
  const build = (emailAccounts) => {
    const agent = {
      ...(current ?? {}),
      id: plan.id,
      displayName: plan.displayName,
      channel: plan.channel,
      connectors: plan.connectors,
      dataDir: plan.dataDir,
      workspace: plan.workspace,
      model: plan.runtime.model,
    };
    if (plan.connectors.includes('lark')) agent.profile = current?.profile ?? `vika-${plan.id}`;
    else delete agent.profile;
    if (ovConfig) agent.ovConfig = ovConfig;
    else delete agent.ovConfig;
    if (emailAccounts.length) agent.emailAccounts = emailAccounts;
    else delete agent.emailAccounts;
    return agent;
  };
  const port = current ? current.port : await allocate(manifest);
  const pinned = plan.runtime.binEnv && plan.runtime.bin ? { [plan.runtime.binEnv]: plan.runtime.bin } : {};
  const manifestWith = (agent) => (current ? withChangedInstance(manifest, agent, pinned) : withInstance(manifest, { ...agent, port }, pinned));
  // A stand-in mailbox until they are known; their names come from the addresses.
  const standIn = current?.emailAccounts?.length ? current.emailAccounts : [{ id: 'email-check', config: emailAccountPath(env, plan.id, 'check') }];
  validateManifest(configPath, manifestWith(build(wantsEmail ? standIn : [])));

  // Mailboxes are checked now (no scan), and saved with the manifest.
  const mailboxes = wantsEmail ? await planMailboxes({ prompter, env, id: plan.id, current, connect })
    : { list: [], write: [], removed: current ? mailboxesOf(current) : [], added: [], updated: [] };
  if (wantsEmail && mailboxes.list.length === 0) plan.connectors = plan.connectors.filter((connector) => connector !== 'email');
  const agent = build(mailboxes.list);
  const next = manifestWith(agent);
  validateManifest(configPath, next);

  if (current) {
    const changes = describeChanges(current, agent, mailboxes, homeDir);
    if (changes.length === 0) {
      out('\n没有改动。\n');
      return 0;
    }
    out(`\n将修改 ${current.displayName}（${current.id}）：\n${changes.map((change) => `  ${change}\n`).join('')}`);
  } else {
    const addresses = mailboxes.added.length ? `（${mailboxes.added.join('、')}）` : '';
    out(`\n将添加实例 ${plan.id}：${plan.runtime.label}，${imList(plan.connectors)}${addresses}，主渠道${IM_LABELS[plan.channel]}`
      + `，${ovConfig ? '使用' : '不使用'} OpenViking\n  工作目录 ${plan.workspace}\n  数据目录 ${plan.dataDir}\n`);
  }
  if (!await prompter.confirm(newIms.length ? '开始扫码？' : current ? '保存并重启这个实例？' : '保存并启动？')) return 1;

  const lark = newIms.includes('lark')
    ? await connect.lark({ plan, prompter, larkCli: new LarkCli(larkCliBin), fetchImpl, profile: agent.profile, debug: Boolean(env.VIKA_DEBUG) })
    : null;
  if (newIms.includes('weixin')) await connect.weixin({ plan, prompter });
  if (ovConfig && plan.useOv === true) writeInstanceOvConfig({ detected: ov, instanceId: plan.id, target: ovConfig });
  for (const { config, account } of mailboxes.write) writeEmailAccount(config, account);

  fs.mkdirSync(plan.workspace, { recursive: true, mode: 0o700 });
  writeManifest(configPath, next);
  for (const mailbox of mailboxes.removed) fs.rmSync(mailbox.config, { force: true });
  out(`\n已写入 ${configPath}\n`);

  try {
    await (current ? control.restart : control.start)(plan.id, { env });
  } catch (error) {
    out(`\n配置已保存，但${current ? '重启' : '启动'}没有完成：${error.message}\n修好后运行 vika ${current ? 'restart' : 'start'} ${plan.id}\n`);
    return 1;
  }
  if (!current) {
    // The instance is up. The shared Web (it routes to every instance, so it
    // restarts to pick this one up) and the updater are helpers: report, go on.
    for (const [action, target] of [['restart', 'web'], ['start', 'updater']]) {
      await control[action](target, { env }).catch((error) => {
        out(`  ⚠ vika-${target} 没有起来：${error.message}；之后运行 vika ${action} ${target}\n`);
      });
    }
  }
  const hello = (im) => greeting(im, { name: plan.displayName, newInstance: !current, primary: im === plan.channel });
  if (lark) {
    await connect.greet({ larkCliBin, profile: lark.profile, userId: lark.ownerOpenId, text: hello('lark') })
      .catch((error) => out(`  飞书打招呼的消息没发出去：${error.message}\n`));
  }
  if (newIms.includes('weixin')) {
    await connect.greetWeixin({ dataDir: plan.dataDir, text: hello('weixin') })
      .catch((error) => out(`  微信打招呼的消息没发出去：${error.message}\n`));
  }
  out(`\n${plan.displayName}（${plan.id}）${current ? '已更新' : '已就绪'}。\n`);
  return 0;
}

// What a change to an instance does, one line each, for the confirmation.
function describeChanges(before, after, mailboxes, homeDir) {
  const changes = [];
  const was = connectorsOf(before);
  if (before.displayName !== after.displayName) changes.push(`机器人名字：${before.displayName} → ${after.displayName}`);
  if (before.workspace !== after.workspace) {
    changes.push(`工作目录：${shortenHome(before.workspace, homeDir)} → ${shortenHome(after.workspace, homeDir)}（模型会开一次新的会话）`);
  }
  if (before.model !== after.model) changes.push(`运行时：${before.model} → ${after.model}`);
  for (const im of ['lark', 'weixin']) {
    if (!was.includes(im) && after.connectors.includes(im)) changes.push(`接入${IM_LABELS[im]}（需要扫码）`);
    if (was.includes(im) && !after.connectors.includes(im)) changes.push(`不再接${IM_LABELS[im]}`);
  }
  if ((before.channel ?? was[0]) !== after.channel) changes.push(`主渠道：${IM_LABELS[before.channel ?? was[0]]} → ${IM_LABELS[after.channel]}`);
  for (const address of mailboxes.added) changes.push(`接入邮箱 ${address}`);
  for (const address of mailboxes.updated) changes.push(`更新邮箱 ${address} 的密码`);
  for (const mailbox of mailboxes.removed) changes.push(`移除邮箱 ${mailbox.address ?? mailbox.id}（删掉保存的密码）`);
  if (Boolean(before.ovConfig) !== Boolean(after.ovConfig)) changes.push(after.ovConfig ? '开始使用 OpenViking' : '不再使用 OpenViking');
  return changes;
}
