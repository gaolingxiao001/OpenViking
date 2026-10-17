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
import { EmailCancelled, askEmail, emailAccountPath, emailInstanceId, mailboxesOf, writeEmailAccount } from './email.mjs';
import { IM_LABELS, PRIMARY_MEANING, connectorsOf, imList } from './instances.mjs';

// `vika setup`: add an instance, or change one. A new instance is asked
// question by question; a change is a list of every setting with its current
// value, where the owner opens the ones to change and saves. Then the QR scans
// (only for a newly connected IM), then the manifest is written and the
// instance (re)started. Nothing is saved until all scans succeed, so an
// aborted setup leaves things as they were. It is also the one place that
// connects an IM; `vika login` only renews.

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

const ims = (state) => state.connectors.filter((connector) => connector !== 'email');

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

// A runtime that is no longer detected stays selectable as it is.
function keptRuntime(current, runtimes) {
  if (!current || runtimes.some((runtime) => runtime.available && runtime.model === current.model)) return null;
  return { label: `保持现在的（${current.model}）`, model: current.model, available: true, note: '', kept: true };
}

// The answers being put together: defaults for a new instance, or the
// instance's own values when changing one. Mailboxes change only at the end.
function initialState({ id, env, homeDir, current, runtimes, kept }) {
  const connectors = current ? [...connectorsOf(current)] : ['lark'];
  return {
    id,
    dataDir: current?.dataDir ?? path.join(vikaHome(env), 'data', id),
    displayName: current?.displayName ?? 'Vika',
    workspace: current?.workspace ?? path.join(homeDir, 'vika-workspace', id),
    runtime: kept ?? runtimes.find((runtime) => runtime.available && (!current || runtime.model === current.model)),
    connectors,
    channel: current?.channel ?? connectors[0],
    useOv: current?.ovConfig ? 'keep' : false,
    mail: { kept: current ? mailboxesOf(current) : [], added: [], updated: new Map(), removed: [] },
  };
}

const mailboxList = (state) => [...state.mail.kept, ...state.mail.added];
const addressOf = (mailbox) => mailbox.account?.address ?? mailbox.address ?? mailbox.id;

// What the mailbox changes come to, for the manifest, the files and the summary.
function mailPlan(state) {
  return {
    list: mailboxList(state).map(({ id, config }) => ({ id, config })),
    write: [...state.mail.added, ...state.mail.updated.values()].map(({ config, account }) => ({ config, account })),
    removed: state.mail.removed,
    added: state.mail.added.map(addressOf),
    updated: [...state.mail.updated.values()].map(addressOf),
  };
}

async function askName({ prompter, current }, state) {
  const hasLark = current && connectorsOf(current).includes('lark');
  state.displayName = await prompter.text(hasLark
    ? '机器人名字（已经建好的飞书应用名不会跟着改）'
    : '机器人名字（也是飞书应用名，@它时用这个名字）', {
    initial: state.displayName,
    validate: (value) => (value.length > 40 ? '最多 40 个字符' : null),
  });
}

async function askWorkspace({ prompter, env, homeDir }, state) {
  state.workspace = path.resolve(expandHome(await prompter.text('工作目录（agent 在这里读写文件）', {
    initial: shortenHome(state.workspace, homeDir),
    validate: (value) => {
      const resolved = path.resolve(expandHome(value, homeDir));
      if (resolved === homeDir) return '不要直接用 home 目录，换一个子目录';
      if (resolved.startsWith(`${vikaHome(env)}${path.sep}`)) return '不能放在 ~/.vika 里';
      return null;
    },
  }), homeDir));
}

async function askRuntime({ prompter, runtimes, kept }, state) {
  const choices = [...(kept ? [kept] : []), ...runtimes];
  state.runtime = await prompter.select('Agent 运行时', choices.map((runtime) => ({
    label: runtime.label, value: runtime, hint: runtime.note, disabled: !runtime.available,
  })), { initial: Math.max(0, choices.findIndex((runtime) => runtime.available && runtime.model === state.runtime?.model)) });
}

// A primary IM that was dropped moves to what is left, Feishu first.
function keepChannel({ out }, state) {
  if (ims(state).includes(state.channel)) return;
  const next = ims(state).includes('lark') ? 'lark' : ims(state)[0];
  out(`  主渠道原来是${IM_LABELS[state.channel]}，它不再接入，改成${IM_LABELS[next]}。\n`);
  state.channel = next;
}

function dropMailboxes(state) {
  state.mail.removed.push(...state.mail.kept);
  state.mail.kept = [];
  state.mail.added = [];
  state.mail.updated.clear();
}

// One more mailbox. In the change menu, giving up on it goes back to the list.
async function addMailbox({ prompter, env, connect, menu }, state) {
  let account;
  try {
    account = await connect.email({ prompter, taken: mailboxList(state).map(addressOf) });
  } catch (error) {
    if (menu && error instanceof EmailCancelled) return false;
    throw error;
  }
  const id = emailInstanceId(account.address, mailboxList(state).map((mailbox) => mailbox.id));
  state.mail.added.push({ id, config: emailAccountPath(env, state.id, id), account });
  return true;
}

async function addMailboxes(ctx, state) {
  do {
    if (!await addMailbox(ctx, state)) break;
  } while (await ctx.prompter.confirm('再接一个邮箱？', false));
  const has = mailboxList(state).length > 0;
  state.connectors = state.connectors.filter((connector) => connector !== 'email').concat(has ? ['email'] : []);
}

async function askIms(ctx, state) {
  let connectors;
  for (;;) {
    connectors = await ctx.prompter.multiselect('接入哪些 IM', IM_CHOICES,
      { initial: IM_CHOICES.map(({ value }, index) => (state.connectors.includes(value) ? index : -1)).filter((index) => index >= 0) });
    if (connectors.some((connector) => connector !== 'email')) break;
    ctx.out('  邮箱不能单独接：新邮件提醒和回信确认要发到飞书或微信，再选一个。\n');
  }
  const hadEmail = state.connectors.includes('email');
  state.connectors = connectors;
  if (hadEmail && !connectors.includes('email')) dropMailboxes(state);
  // When changing an instance, a newly ticked mailbox is connected right away.
  if (ctx.menu && !hadEmail && connectors.includes('email')) await addMailboxes(ctx, state);
  if (ctx.menu) keepChannel(ctx, state);
}

// The primary IM is its own question: Feishu unless it is left out.
async function askChannel({ prompter, out, menu }, state) {
  const choices = ims(state);
  if (choices.length > 1) {
    const preferred = [state.channel, 'lark'].find((im) => choices.includes(im)) ?? choices[0];
    state.channel = await prompter.select(`主渠道：${PRIMARY_MEANING}`,
      choices.map((connector) => ({ label: IM_LABELS[connector], value: connector })), { initial: choices.indexOf(preferred) });
    return;
  }
  state.channel = choices[0];
  out(`  主渠道是${IM_LABELS[state.channel]}：${PRIMARY_MEANING}。${menu ? '只接了一个 IM 时只能是它，要换先在「接入的 IM」里多接一个。' : ''}\n`);
}

// 'keep' leaves the instance's OpenViking config as it is.
async function askOv({ prompter, out, ov, current }, state) {
  if (current?.ovConfig) {
    state.useOv = await prompter.select('OpenViking（跨会话记忆）', [
      { label: '继续使用', value: 'keep' },
      { label: '不用了', value: false },
    ], { initial: state.useOv ? 0 : 1 });
  } else if (ov?.usable) {
    state.useOv = await prompter.select('OpenViking（跨会话记忆）', [
      { label: '使用本机检测到的 OpenViking', value: true, hint: `${ov.url}${ov.user ? `  user=${ov.user}` : ''}` },
      { label: current ? '不用' : '跳过', value: false },
    ], { initial: !current || state.useOv ? 0 : 1 });
  } else if (ov) {
    out(`  检测到 OpenViking（${ov.url}），但现在用不了：${ov.reason}。先跳过，以后可以重新运行 setup。\n`);
  } else {
    out('  没有检测到 OpenViking，跳过。以后装好 OV 后可以重新运行 setup。\n');
  }
}

// The instance's mailboxes, from a menu until done; none yet means adding.
async function askMailboxes(ctx, state) {
  if (mailboxList(state).length === 0) {
    await addMailboxes(ctx, state);
    return;
  }
  for (;;) {
    const kept = state.mail.kept;
    const choice = await ctx.prompter.select(`邮箱（已接入：${mailboxList(state).map(addressOf).join('、')}）`, [
      { label: '不改了', value: { kind: 'done' } },
      { label: '再接一个邮箱', value: { kind: 'add' } },
      ...kept.map((mailbox) => ({ label: `更新 ${addressOf(mailbox)} 的密码`, value: { kind: 'update', mailbox } })),
      ...mailboxList(state).map((mailbox) => ({ label: `移除 ${addressOf(mailbox)}`, value: { kind: 'remove', mailbox } })),
    ]);
    if (choice.kind === 'done') break;
    if (choice.kind === 'add') await addMailbox(ctx, state);
    if (choice.kind === 'update') {
      try {
        const account = await ctx.connect.email({ prompter: ctx.prompter, fixed: choice.mailbox.account,
          taken: mailboxList(state).filter((mailbox) => mailbox !== choice.mailbox).map(addressOf) });
        state.mail.updated.set(choice.mailbox.id, { config: choice.mailbox.config, account });
      } catch (error) {
        if (!(error instanceof EmailCancelled)) throw error;
      }
    }
    if (choice.kind === 'remove') {
      const { mailbox } = choice;
      if (kept.includes(mailbox)) {
        kept.splice(kept.indexOf(mailbox), 1);
        state.mail.updated.delete(mailbox.id);
        state.mail.removed.push(mailbox);
      } else {
        state.mail.added.splice(state.mail.added.indexOf(mailbox), 1);
      }
    }
  }
  if (mailboxList(state).length === 0) state.connectors = state.connectors.filter((connector) => connector !== 'email');
  else if (!state.connectors.includes('email')) state.connectors.push('email');
}

const SETTINGS = [
  { key: 'displayName', label: '机器人名字', ask: askName, shown: (state) => state.displayName },
  { key: 'workspace', label: '工作目录', ask: askWorkspace, shown: (state, { homeDir }) => shortenHome(state.workspace, homeDir) },
  { key: 'runtime', label: 'Agent 运行时', ask: askRuntime, shown: (state) => (state.runtime.kept ? state.runtime.model : state.runtime.label) },
  { key: 'ims', label: '接入的 IM', ask: askIms, shown: (state) => imList(state.connectors) },
  { key: 'channel', label: '主渠道', ask: askChannel, shown: (state) => IM_LABELS[state.channel] },
  { key: 'mailboxes', label: '邮箱', ask: askMailboxes,
    shown: (state) => (mailboxList(state).length ? mailboxList(state).map(addressOf).join('、') : '没有接') },
  { key: 'ov', label: 'OpenViking', ask: askOv, shown: (state) => (state.useOv ? '使用' : '不用') },
];

// CJK characters take two columns; labels are padded so the values line up.
function padded(label, width = 13) {
  const columns = [...label].reduce((sum, char) => sum + (char.charCodeAt(0) > 0x2e7f ? 2 : 1), 0);
  return `${label}${' '.repeat(Math.max(1, width - columns))}`;
}

// Changing an instance: every setting with its value; the owner opens the
// ones to change, then saves. Resolves with the state to save, or null.
async function editInstance(ctx, state, { describe, check }) {
  const { prompter, out, current } = ctx;
  const before = Object.fromEntries(SETTINGS.map(({ key, shown }) => [key, shown(state, ctx)]));
  let cursor = 0;
  for (;;) {
    const changes = describe(state);
    const changed = (key, value) => value !== before[key] || (key === 'mailboxes' && changes.some((line) => line.includes('邮箱')));
    const choice = await prompter.select(`修改 ${current.displayName}（${current.id}）：选一项回车修改，改好后选「保存」`, [
      ...SETTINGS.map(({ key, label, shown }, index) => {
        const value = shown(state, ctx);
        return { label: padded(label), hint: `${value}${changed(key, value) ? '（已改）' : ''}`, value: index };
      }),
      { label: changes.length ? `保存（${changes.length} 项改动）` : '保存', value: 'save' },
      { label: '放弃修改', value: 'quit' },
    ], { initial: cursor });
    if (choice === 'quit') {
      out('\n已放弃，没有保存任何改动。\n');
      return null;
    }
    if (choice === 'save') {
      if (changes.length === 0) {
        out('\n没有改动。\n');
        return null;
      }
      const problem = check(state);
      if (!problem) return state;
      out(`  这样改不行：${problem}\n`);
      continue;
    }
    cursor = choice;
    await SETTINGS[choice].ask(ctx, state);
  }
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
  const kept = keptRuntime(current, runtimes);
  const ctx = { prompter, out, env, homeDir, runtimes, ov, current, connect, kept, menu: Boolean(current) };
  const id = current?.id ?? await prompter.text('实例名称', {
    initial: suggestInstanceId(manifest),
    validate: (value) => instanceIdProblem(value, manifest),
  });
  const state = initialState({ id, env, homeDir, current, runtimes, kept });
  const port = current ? current.port : await allocate(manifest);

  // The instance as the manifest will hold it.
  const build = (emailAccounts = mailPlan(state).list) => {
    const agent = {
      ...(current ?? {}),
      id,
      displayName: state.displayName,
      channel: state.channel,
      connectors: state.connectors,
      dataDir: state.dataDir,
      workspace: state.workspace,
      model: state.runtime.model,
    };
    if (state.connectors.includes('lark')) agent.profile = current?.profile ?? `vika-${id}`;
    else delete agent.profile;
    const ovConfig = state.useOv === 'keep' ? current.ovConfig
      : state.useOv ? path.join(vikaHome(env), 'ov', `${id}.json`) : null;
    if (ovConfig) agent.ovConfig = ovConfig;
    else delete agent.ovConfig;
    if (emailAccounts.length) agent.emailAccounts = emailAccounts;
    else delete agent.emailAccounts;
    return agent;
  };
  const pinned = () => (state.runtime.binEnv && state.runtime.bin ? { [state.runtime.binEnv]: state.runtime.bin } : {});
  const manifestWith = (agent) => (current
    ? withChangedInstance(manifest, agent, pinned()) : withInstance(manifest, { ...agent, port }, pinned()));
  // The whole instance is known before any scan, so a manifest the daemon
  // would reject fails here rather than after two QR codes.
  const problem = (agent) => {
    try { validateManifest(configPath, manifestWith(agent)); return null; } catch (error) { return error.message; }
  };

  if (current) {
    const describe = () => describeChanges(current, build(), mailPlan(state), homeDir);
    if (!await editInstance(ctx, state, { describe, check: () => problem(build()) })) return 0;
    out(`\n将修改 ${current.displayName}（${current.id}）：\n${describe().map((change) => `  ${change}\n`).join('')}`);
  } else {
    for (const ask of [askName, askWorkspace, askRuntime, askIms, askChannel, askOv]) await ask(ctx, state);
    // A stand-in mailbox until they are known; their names come from the addresses.
    const wantsEmail = state.connectors.includes('email');
    const early = problem(build(wantsEmail ? [{ id: 'email-check', config: emailAccountPath(env, id, 'check') }] : []));
    if (early) throw new Error(early);
    if (wantsEmail) await addMailboxes(ctx, state);
    const late = problem(build());
    if (late) throw new Error(late);
    const addresses = mailPlan(state).added;
    out(`\n将添加实例 ${id}：${state.runtime.label}，${imList(state.connectors)}${addresses.length ? `（${addresses.join('、')}）` : ''}`
      + `，主渠道${IM_LABELS[state.channel]}，${state.useOv ? '使用' : '不使用'} OpenViking\n`
      + `  工作目录 ${state.workspace}\n  数据目录 ${state.dataDir}\n`);
  }
  const before = current ? connectorsOf(current) : [];
  const newIms = ims(state).filter((im) => !before.includes(im));
  if (!current && !await prompter.confirm(newIms.length ? '开始扫码？' : '保存并启动？')) return 1;

  // The release's own lark-cli, unless the manifest or environment pins another.
  const larkCliBin = state.connectors.includes('lark')
    ? (env.LARK_CLI_BIN || manifest?.env?.LARK_CLI_BIN || resolveLarkCli(env))
    : null;
  if (newIms.includes('lark') && !larkCliBin) {
    out('\n找不到 lark-cli：这个安装不完整，重新运行安装脚本。\n');
    return 1;
  }
  const agent = build();
  const plan = { id, displayName: state.displayName, dataDir: state.dataDir };
  const lark = newIms.includes('lark')
    ? await connect.lark({ plan, prompter, larkCli: new LarkCli(larkCliBin), fetchImpl, profile: agent.profile, debug: Boolean(env.VIKA_DEBUG) })
    : null;
  if (newIms.includes('weixin')) await connect.weixin({ plan, prompter });
  if (state.useOv === true) writeInstanceOvConfig({ detected: ov, instanceId: id, target: agent.ovConfig });
  const mail = mailPlan(state);
  for (const { config, account } of mail.write) writeEmailAccount(config, account);

  fs.mkdirSync(state.workspace, { recursive: true, mode: 0o700 });
  writeManifest(configPath, manifestWith(agent));
  for (const mailbox of mail.removed) fs.rmSync(mailbox.config, { force: true });
  out(`\n已写入 ${configPath}\n`);

  try {
    await (current ? control.restart : control.start)(id, { env });
  } catch (error) {
    out(`\n配置已保存，但${current ? '重启' : '启动'}没有完成：${error.message}\n修好后运行 vika ${current ? 'restart' : 'start'} ${id}\n`);
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
  const hello = (im) => greeting(im, { name: state.displayName, newInstance: !current, primary: im === state.channel });
  if (lark) {
    await connect.greet({ larkCliBin, profile: lark.profile, userId: lark.ownerOpenId, text: hello('lark') })
      .catch((error) => out(`  飞书打招呼的消息没发出去：${error.message}\n`));
  }
  if (newIms.includes('weixin')) {
    await connect.greetWeixin({ dataDir: state.dataDir, text: hello('weixin') })
      .catch((error) => out(`  微信打招呼的消息没发出去：${error.message}\n`));
  }
  out(`\n${state.displayName}（${id}）${current ? '已更新' : '已就绪'}。\n`);
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
  for (const mailbox of mailboxes.removed) changes.push(`移除邮箱 ${addressOf(mailbox)}（删掉保存的密码）`);
  if (Boolean(before.ovConfig) !== Boolean(after.ovConfig)) changes.push(after.ovConfig ? '开始使用 OpenViking' : '不再使用 OpenViking');
  return changes;
}
