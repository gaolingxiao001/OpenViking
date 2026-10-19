import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loginWeixin } from '../../daemon/src/weixin/auth.mjs';
import { WeixinState } from '../../daemon/src/weixin/state.mjs';
import { bundledLarkCli } from '../../daemon/src/lark-cli-bin.mjs';
import { managedPiBin } from '../../daemon/src/pi-runtime.mjs';
import { LarkCli } from './lark-cli.mjs';
import { createApp, inspectApp, missingScopes } from './lark-app.mjs';
import {
  WEB_PORT, allocatePort, instanceIdProblem, readManifest, suggestInstanceId, validateManifest, vikaCommand, vikaHome,
  withChangedInstance, withInstance, writeManifest,
} from './manifest.mjs';
import { detectOpenViking, writeInstanceOvConfig } from './ov.mjs';
import { detectRuntimes, which } from './runtimes.mjs';
import { showScan } from './qr.mjs';
import { restartCommand, startCommand } from './control.mjs';
import { autostartCommand, autostartEnabled } from './autostart.mjs';
import { openingBanner } from './banner.mjs';
import { box, padEnd, width } from './ui.mjs';
import { releaseInfo } from './version.mjs';
import { EmailCancelled, askEmail, emailAccountPath, emailInstanceId, mailboxesOf, writeEmailAccount } from './email.mjs';
import { GoBack } from './prompt.mjs';
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
  ], { back: false });
}

// Back to the first question, 要做什么: setup starts over from there.
class StartOver extends Error {}

// ← where a menu has a way out: the menu's answer instead of going back.
async function orElse(ask, menu, value) {
  try {
    return await ask();
  } catch (error) {
    if (menu && error instanceof GoBack) return value;
    throw error;
  }
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
    label: '机器人名字',
    initial: state.displayName,
    validate: (value) => (value.length > 40 ? '最多 40 个字符' : null),
  });
}

async function askWorkspace({ prompter, env, homeDir }, state) {
  state.workspace = path.resolve(expandHome(await prompter.text('工作目录（agent 在这里读写文件）', {
    label: '工作目录',
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
function keepChannel({ prompter }, state) {
  if (ims(state).includes(state.channel)) return;
  const next = ims(state).includes('lark') ? 'lark' : ims(state)[0];
  prompter.info(`主渠道原来是${IM_LABELS[state.channel]}，它不再接入，改成${IM_LABELS[next]}。`);
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
    if (menu && (error instanceof EmailCancelled || error instanceof GoBack)) return false;
    throw error;
  }
  const id = emailInstanceId(account.address, mailboxList(state).map((mailbox) => mailbox.id));
  state.mail.added.push({ id, config: emailAccountPath(env, state.id, id), account });
  return true;
}

async function addMailboxes(ctx, state) {
  do {
    if (!await addMailbox(ctx, state)) break;
  } while (await orElse(() => ctx.prompter.confirm('再接一个邮箱？', false), ctx.menu, false));
  const has = mailboxList(state).length > 0;
  state.connectors = state.connectors.filter((connector) => connector !== 'email').concat(has ? ['email'] : []);
}

async function askIms(ctx, state) {
  let connectors;
  for (;;) {
    connectors = await ctx.prompter.multiselect('接入哪些 IM', IM_CHOICES,
      { initial: IM_CHOICES.map(({ value }, index) => (state.connectors.includes(value) ? index : -1)).filter((index) => index >= 0) });
    if (connectors.some((connector) => connector !== 'email')) break;
    ctx.prompter.warn('邮箱不能单独接：新邮件提醒和回信确认要发到飞书或微信，再选一个。');
  }
  const hadEmail = state.connectors.includes('email');
  state.connectors = connectors;
  if (hadEmail && !connectors.includes('email')) dropMailboxes(state);
  // When changing an instance, a newly ticked mailbox is connected right away.
  if (ctx.menu && !hadEmail && connectors.includes('email')) await addMailboxes(ctx, state);
  if (ctx.menu) keepChannel(ctx, state);
}

// The primary IM is its own question: Feishu unless it is left out.
async function askChannel({ prompter, menu }, state) {
  const choices = ims(state);
  if (choices.length > 1) {
    const preferred = [state.channel, 'lark'].find((im) => choices.includes(im)) ?? choices[0];
    prompter.info(`主渠道：${PRIMARY_MEANING}。`);
    state.channel = await prompter.select('主渠道选哪个',
      choices.map((connector) => ({ label: IM_LABELS[connector], value: connector })), { initial: choices.indexOf(preferred), label: '主渠道' });
    return;
  }
  state.channel = choices[0];
  prompter.info(`主渠道是${IM_LABELS[state.channel]}：${PRIMARY_MEANING}。${menu ? '只接了一个 IM 时只能是它，要换先在「接入的 IM」里多接一个。' : ''}`);
}

// 'keep' leaves the instance's OpenViking config as it is.
async function askOv({ prompter, ov, current }, state) {
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
    prompter.info(`OpenViking（${ov.url}）现在用不了：${ov.reason}。先跳过，之后可以重新运行 setup。`);
  } else {
    prompter.info('没有检测到 OpenViking（跨会话记忆），跳过。以后装好 OV 后可以重新运行 setup。');
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
    const choice = await orElse(() => ctx.prompter.select(`邮箱（已接入：${mailboxList(state).map(addressOf).join('、')}）`, [
      { label: '不改了', value: { kind: 'done' } },
      { label: '再接一个邮箱', value: { kind: 'add' } },
      ...kept.map((mailbox) => ({ label: `更新 ${addressOf(mailbox)} 的密码`, value: { kind: 'update', mailbox } })),
      ...mailboxList(state).map((mailbox) => ({ label: `移除 ${addressOf(mailbox)}`, value: { kind: 'remove', mailbox } })),
    ], { label: '邮箱' }), ctx.menu, { kind: 'done' });
    if (choice.kind === 'done') break;
    if (choice.kind === 'add') await addMailbox(ctx, state);
    if (choice.kind === 'update') {
      try {
        const account = await ctx.connect.email({ prompter: ctx.prompter, fixed: choice.mailbox.account,
          taken: mailboxList(state).filter((mailbox) => mailbox !== choice.mailbox).map(addressOf) });
        state.mail.updated.set(choice.mailbox.id, { config: choice.mailbox.config, account });
      } catch (error) {
        if (!(error instanceof EmailCancelled || error instanceof GoBack)) throw error;
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
// The list stays in one place: before it is drawn again, the screen goes
// back to where it first was, so what a setting asked or said is gone and
// its new value shows in the list instead. `page` keeps that place, and the
// cursor, when the list is come back to from a code waiting to be scanned.
async function editInstance(ctx, state, { describe, check, before, page }) {
  const { prompter, out, current } = ctx;
  page.mark ??= prompter.mark();
  let notice = null;
  for (;;) {
    prompter.rewind(page.mark);
    if (notice) prompter.warn(notice);
    notice = null;
    const changes = describe(state);
    const changed = (key, value) => value !== before[key] || (key === 'mailboxes' && changes.some((line) => line.includes('邮箱')));
    let choice;
    try {
      choice = await prompter.select(`修改 ${current.displayName}（${current.id}）：选一项回车修改，改好后选「保存」`, [
        ...SETTINGS.map(({ key, label, shown }, index) => {
          const value = shown(state, ctx);
          return { label: padded(label), hint: `${value}${changed(key, value) ? '（已改）' : ''}`, value: index };
        }),
        { label: changes.length ? `保存（${changes.length} 项改动）` : '保存', value: 'save' },
        { label: '放弃修改', value: 'quit' },
      ], { initial: page.cursor ?? 0, label: `修改 ${current.displayName}` });
    } catch (error) {
      if (!(error instanceof GoBack)) throw error;
      // Back to 要做什么, unless that would drop changes nobody saved.
      if (changes.length === 0) throw new StartOver();
      notice = `有 ${changes.length} 项改动还没保存：选「保存」，或者「放弃修改」`;
      continue;
    }
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
      notice = `这样改不行：${problem}`;
      continue;
    }
    page.cursor = choice;
    // ← inside a setting leaves it as it was and comes back to the list.
    try {
      await SETTINGS[choice].ask(ctx, state);
    } catch (error) {
      if (!(error instanceof GoBack)) throw error;
    }
  }
}

// A new instance is asked step by step, in sections. ← goes back to the
// step that asked before (steps that only said something are passed over),
// and from the first question back to 要做什么 when there is one. A step
// returns DECLINED to stop the setup.
const DECLINED = Symbol('declined');

// `run` remembers the way through: the steps answered, and where on screen
// each began, so ← takes the screen back to how it was when that step was
// reached. From the scans, setup comes back in at the last step.
async function wizard(ctx, state, steps, run) {
  const { prompter } = ctx;
  run.answered ??= [];
  run.marks ??= [];
  const sectionOf = (index) => steps.slice(0, index + 1).reverse().find((candidate) => candidate.section)?.section ?? null;
  let index = run.at ?? 0;
  let shown = index > 0 ? sectionOf(index - 1) : null;
  const back = (to) => {
    prompter.rewind(run.marks[to]);
    shown = to > 0 ? sectionOf(to - 1) : null;
    index = to;
  };
  while (index < steps.length) {
    run.marks[index] = prompter.mark();
    const section = sectionOf(index);
    if (section && section !== shown) {
      prompter.section(section.title, section);
      shown = section;
    }
    const asked = prompter.asked;
    try {
      if (await steps[index].ask(ctx, state) === DECLINED) return DECLINED;
      if (prompter.asked !== asked) run.answered.push(index);
      index += 1;
    } catch (error) {
      if (!(error instanceof GoBack)) throw error;
      if (run.answered.length) back(run.answered.pop());
      else if (ctx.startOver) throw new StartOver();
      else back(index);
    }
  }
  return null;
}

// Back in at the last step (the confirmation), as it was before it was answered.
function returnToLast(prompter, steps, run) {
  run.answered.pop();
  run.at = steps.length - 1;
  prompter.rewind(run.marks[run.at], { whole: true });
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

// canGoBack: ← while the code waits stops the registration (nothing is made
// before the scan is confirmed) and rejects with GoBack.
export async function registerApp({ plan, prompter, scopes, debug, register = null, canGoBack = false }) {
  const controller = new AbortController();
  let scan = null;
  let wantManual;
  const manual = new Promise((resolve) => { wantManual = resolve; });
  let wantBack;
  const back = new Promise((resolve) => { wantBack = resolve; });
  const created = createApp({
    name: plan.displayName,
    description: 'Vika：把本机的 coding agent 接进飞书',
    scopes,
    signal: controller.signal,
    ...(register ? { register } : {}),
    onQRCode: ({ url, expiresIn }) => {
      scan?.stop();
      scan = showScan(prompter, {
        url,
        where: '飞书',
        title: `第 1 次扫码：用飞书 App 扫码，创建机器人应用（${Math.round(expiresIn / 60)} 分钟内有效）`,
        stopKey: 'm',
        stopLabel: '手动填 App ID',
        onBack: canGoBack ? () => wantBack() : null,
      });
      scan.pressed.then((pressed) => { if (pressed) wantManual(); });
    },
    onStatus: (status) => {
      if (debug) scan?.say(`[registration] ${status}`);
      if (status === 'domain_switched') scan?.say('识别到国际版 Lark 租户');
      if (status === 'polling') scan?.status('等待扫码确认');
      if (status === 'slow_down') scan?.status('平台要求放慢轮询，继续等待');
    },
  });
  try {
    const winner = await Promise.race([
      created.then((app) => ({ app })), manual.then(() => ({ manual: true })), back.then(() => ({ back: true })),
    ]);
    if (winner.app) return winner.app;
    controller.abort();
    created.catch(() => {});
    scan?.stop();
    scan = null;
    if (winner.back) throw new GoBack();
    return await manualApp(prompter);
  } finally {
    scan?.stop();
  }
}

// A step with a spinner: it ends in a tick, or a cross and the error.
async function step(prompter, text, run, done = text) {
  const spinning = prompter.spin(text);
  try {
    const result = await run();
    spinning.succeed(typeof done === 'function' ? done(result) : done);
    return result;
  } catch (error) {
    spinning.fail(text);
    throw error;
  }
}

export async function connectLark({ plan, prompter, larkCli, fetchImpl, profile, debug = false, canGoBack = false }) {
  const scopes = larkScopes();
  prompter.section('飞书');
  // Only the first code can be gone back from: once it is confirmed the app exists.
  const app = await registerApp({ plan, prompter, scopes, debug, canGoBack });
  prompter.success(`已创建应用 ${app.appId}`);
  const inspected = await step(prompter, '核对应用的权限和版本', () => inspectApp(app, { fetchImpl }), '应用信息已读取');
  const missing = missingScopes(scopes, inspected.granted);
  if (!inspected.online) prompter.warn('应用还没有上线版本，可能在等管理员审核；审核通过后机器人才能收消息，不用重新 setup。');
  if (missing.tenant.length || missing.user.length) {
    prompter.warn(`有 ${missing.tenant.length + missing.user.length} 个权限没开通，相关功能会不可用：${[...missing.tenant, ...missing.user].slice(0, 8).join('、')}${missing.tenant.length + missing.user.length > 8 ? ' 等' : ''}`);
  } else {
    prompter.success(`权限核对通过：${scopes.tenant.length} 个机器人权限、${scopes.user.length} 个用户权限`);
  }
  await larkCli.configureProfile({ profile, ...app });
  const login = await larkCli.beginUserLogin({ profile, scopes: scopes.user });
  const scan = showScan(prompter, {
    url: login.url, where: '飞书', title: '第 2 次扫码：授权 Vika 以你的身份读消息（用于搜索和读历史）', label: '等待授权',
  });
  try {
    await larkCli.finishUserLogin({ profile, deviceCode: login.deviceCode });
  } finally {
    scan.stop();
  }
  const ownerOpenId = await larkCli.userOpenId({ profile });
  if (!ownerOpenId) throw new Error('lark-cli authorization finished without a user identity');
  if (app.ownerOpenId && ownerOpenId !== app.ownerOpenId) {
    prompter.warn('两次扫码的不是同一个飞书账号；机器人会把第 2 次扫码的人当作主人。');
  }
  prompter.success('飞书已接好');
  return { profile, ownerOpenId };
}

// canGoBack: ← while the code waits stops the login before anything is bound
// and rejects with GoBack.
export async function connectWeixin({ plan, prompter, canGoBack = false }) {
  prompter.section('微信');
  fs.mkdirSync(plan.dataDir, { recursive: true, mode: 0o700 });
  const state = new WeixinState(plan.dataDir);
  const controller = new AbortController();
  let wantBack;
  const back = new Promise((resolve) => { wantBack = resolve; });
  let scan = null;
  const login = loginWeixin({
    state,
    signal: controller.signal,
    showQr: (value, { refreshed }) => {
      scan?.stop();
      scan = showScan(prompter, {
        url: value,
        where: '微信',
        title: refreshed ? '二维码过期了，换了一张：用手机微信扫码' : '用手机微信扫码，并在手机上确认',
        onBack: canGoBack ? () => wantBack() : null,
      });
    },
    say: (text) => {
      if (!scan) { prompter.info(text); return; }
      scan.say(text);
      if (/已扫码/.test(text)) scan.status('等待在手机上确认');
    },
    readVerifyCode: (question) => {
      scan?.stop();
      scan = null;
      return prompter.text(question.replace(/：$/, ''));
    },
  });
  try {
    if (await Promise.race([login.then(() => false), back.then(() => true)])) {
      // Let the login see it is stopped before its state closes.
      controller.abort();
      await login.catch(() => {});
      throw new GoBack();
    }
  } finally {
    scan?.stop();
    state.close();
  }
  prompter.success('微信已接好');
}

// No runtime can run yet: the built-in Pi logs in to a model right here,
// in Pi's own screen, and setup carries on when it quits.
export async function loginPi({ prompter, env }) {
  prompter.info('打开内置的 Pi：输入 /login 选模型提供方并登录，完成后输入 /quit 回到这里。');
  prompter.input.pause?.();
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [managedPiBin()], { stdio: 'inherit', env });
    child.once('exit', resolve);
    child.once('error', resolve);
  });
}

export function greet({ larkCliBin, profile, userId, text }) {
  return new LarkCli(larkCliBin).sendText({ profile, userId, text });
}

// Weixin delivers a bot's message only after the owner has written to it
// since the scan, so the bot cannot say hello first: the owner does.
export const WEIXIN_FIRST_MESSAGE = '在微信里给机器人发一句话（比如「你好」），它回复你就说明接好了。'
  + '在你发第一句话之前它没法主动找你：新邮件提醒、待你确认的邮件回复都发不到微信。';

// What the bot says on Feishu when it is newly connected; on the primary IM,
// also that it reaches the owner there.
function greeting({ name, newInstance, primary }) {
  const hello = newInstance
    ? `你好，我是 ${name}，已经在你的电脑上跑起来了。直接给我发消息就行；把我拉进群，我也能参与群聊。`
    : `你好，我是 ${name}，现在也能在飞书里找到我了。`;
  return primary ? `${hello}以后我主动找你的消息（比如新邮件提醒、待你确认的邮件回复）会发到这里。` : hello;
}

// What the machine offers, in one line, once the check is done.
function foundLine(runtimes, ov) {
  const ready = runtimes.filter((runtime) => runtime.available).map((runtime) => runtime.label);
  const memory = ov?.usable ? 'OpenViking 可用' : ov ? 'OpenViking 暂不可用' : '没有 OpenViking';
  return ready.length ? `找到 ${ready.join('、')} · ${memory}` : `还没有能用的 agent · ${memory}`;
}

// Until some runtime can run: say why each cannot, and offer to log the
// built-in Pi in to a model here. Resolves with the runtimes, or null to stop.
async function ensureRuntime({ prompter, env, detect, connect, live }, runtimes) {
  let detected = runtimes;
  while (!detected.some((runtime) => runtime.available)) {
    prompter.warn('没有可用的 agent 运行时：');
    const labelWidth = Math.max(...detected.map((runtime) => width(runtime.label)));
    for (const runtime of detected) prompter.write(`      ${padEnd(runtime.label, labelWidth)}  ${runtime.note}\n`);
    const later = `登录好其中一个后，重新运行 ${vikaCommand(env)} setup。`;
    if (!prompter.tty || !connect.pi) {
      prompter.info(later);
      return null;
    }
    const next = await prompter.select('现在怎么办', [
      { label: '用内置的 Pi，现在登录一个模型', value: 'pi', hint: '在 Pi 里输入 /login，登录后 /quit 回到这里' },
      { label: '先退出，我去登录 Codex 或 Claude Code', value: 'quit' },
    ], { back: false });
    if (next === 'quit') {
      prompter.info(later);
      return null;
    }
    // Pi takes the whole screen while it runs.
    live?.release();
    await connect.pi({ prompter, env });
    live?.resume();
    prompter.redraw();
    detected = await step(prompter, '再看一次有哪些 agent', () => detect.runtimes({ env }),
      (found) => (found.some((runtime) => runtime.available) ? `找到 ${found.filter((runtime) => runtime.available).map((runtime) => runtime.label).join('、')}` : '还是没有能用的 agent'));
  }
  return detected;
}

// Label/value rows: a box on a colour terminal, indented lines otherwise.
function table(prompter, title, rows) {
  const keyWidth = Math.max(...rows.map(([key]) => width(key)));
  if (prompter.fancy) {
    const lines = rows.map(([key, value]) => `${prompter.s.gray(padEnd(key, keyWidth))}  ${key ? value : prompter.s.gray(value)}`);
    prompter.write(`\n${box(lines, { output: prompter.output, env: prompter.env, title })}\n`);
    return;
  }
  prompter.write(`\n${title}：\n${rows.map(([key, value]) => `  ${padEnd(key, keyWidth)}  ${value}`).join('\n')}\n`);
}

const SCANS = { lark: 2, weixin: 1 };

// The boat sails above the whole setup on a colour terminal; whatever ends
// the setup, the terminal gets its whole screen back.
export async function setupCommand(options = {}) {
  const { prompter, env = process.env, banner = openingBanner } = options;
  const live = prompter.fancy ? await banner({ output: prompter.output, input: prompter.input, env, version: releaseInfo().version }) : null;
  // What the first pass learned (the detected agents), kept when ← goes all
  // the way back to 要做什么 and setup starts over.
  const memo = {};
  prompter.pageTop = () => live?.top() ?? null;
  try {
    for (;;) {
      try {
        return await setupFlow({ ...options, live, memo });
      } catch (error) {
        if (!(error instanceof StartOver)) throw error;
      }
    }
  } finally {
    prompter.navigable = false;
    prompter.pageTop = null;
    live?.release();
  }
}

async function setupFlow({
  prompter,
  env = process.env,
  homeDir = os.homedir(),
  fetchImpl = globalThis.fetch,
  detect = { runtimes: detectRuntimes, openViking: detectOpenViking },
  connect = { lark: connectLark, weixin: connectWeixin, email: askEmail, greet, pi: loginPi },
  control = { start: startCommand, restart: restartCommand, autostart: autostartCommand },
  allocate = allocatePort,
  live = null,
  memo = {},
}) {
  const out = (text) => prompter.write(text);
  const vika = vikaCommand(env);
  if (!memo.detected) {
    if (!prompter.fancy) out('Vika setup：添加或修改这台机器上的 agent 实例。\n\n');
    memo.detected = await step(prompter, '看看这台机器上有哪些 agent', () => Promise.all([
      detect.runtimes({ env }),
      detect.openViking({ env, homeDir, fetchImpl }),
    ]), ([found, memory]) => foundLine(found, memory));
    if (prompter.tty) prompter.info('随时可以按 ← 回到上一步，→ 沿用当前的值往下走。');
    memo.mark = prompter.mark();
  } else {
    prompter.rewind(memo.mark);
  }
  let [runtimes] = memo.detected;
  const [, ov] = memo.detected;
  const { path: configPath, value: manifest } = readManifest(env);
  // ← and → move between the questions, until the scans begin.
  prompter.navigable = prompter.tty;
  const current = await chooseTarget(prompter, manifest);
  if (!current) {
    runtimes = await ensureRuntime({ prompter, env, detect, connect, live }, runtimes);
    if (!runtimes) return 1;
    memo.detected = [runtimes, ov];
  }
  const kept = keptRuntime(current, runtimes);
  const others = manifest?.agents?.length > 0;
  const ctx = { prompter, out, env, homeDir, runtimes, ov, current, connect, kept, menu: Boolean(current), startOver: others };
  const state = initialState({ id: current?.id ?? suggestInstanceId(manifest), env, homeDir, current, runtimes, kept });
  const port = current ? current.port : await allocate(manifest);

  // The instance as the manifest will hold it.
  const build = (emailAccounts = mailPlan(state).list) => {
    const agent = {
      ...(current ?? {}),
      id: state.id,
      displayName: state.displayName,
      channel: state.channel,
      connectors: state.connectors,
      dataDir: state.dataDir,
      workspace: state.workspace,
      model: state.runtime.model,
    };
    if (state.connectors.includes('lark')) agent.profile = current?.profile ?? `vika-${state.id}`;
    else delete agent.profile;
    const ovConfig = state.useOv === 'keep' ? current.ovConfig
      : state.useOv ? path.join(vikaHome(env), 'ov', `${state.id}.json`) : null;
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

  // The first instance is simply `primary`; a second one needs a name, and
  // its directories follow the name until the workspace is changed.
  const askId = async () => {
    if (!others) return;
    const before = state.id;
    state.id = await prompter.text('实例名称（用在命令和目录里）', {
      label: '实例名称', initial: state.id, validate: (value) => instanceIdProblem(value, manifest),
    });
    state.dataDir = path.join(vikaHome(env), 'data', state.id);
    if (state.workspace === path.join(homeDir, 'vika-workspace', before)) state.workspace = path.join(homeDir, 'vika-workspace', state.id);
  };
  // The mailboxes once the rest is known: checked first with a stand-in,
  // since their names come from the addresses.
  const askMail = async () => {
    const wantsEmail = state.connectors.includes('email');
    const early = problem(build(wantsEmail ? [{ id: 'email-check', config: emailAccountPath(env, state.id, 'check') }] : []));
    if (early) throw new Error(early);
    if (wantsEmail) await askMailboxes(ctx, state);
    const late = problem(build());
    if (late) throw new Error(late);
  };
  const confirmNew = async () => {
    const addresses = mailPlan(state).added;
    table(prompter, `将添加实例 ${state.id}`, [
      ['机器人', `${state.displayName} · ${state.runtime.label}`],
      ['消息渠道', ims(state).length > 1 ? `${imList(ims(state))}，主渠道：${IM_LABELS[state.channel]}` : imList(ims(state))],
      ...(addresses.length ? [['邮箱', addresses.join('、')]] : []),
      ['记忆', state.useOv ? 'OpenViking' : '不使用 OpenViking'],
      ['工作目录', shortenHome(state.workspace, homeDir)],
      ['数据目录', shortenHome(state.dataDir, homeDir)],
    ]);
    if (ims(state).length) prompter.info(`接下来扫码：${ims(state).map((im) => `${IM_LABELS[im]} ${SCANS[im]} 次`).join('，')}；扫完才保存配置`);
    if (await prompter.confirm(ims(state).length ? '开始扫码？' : '保存并启动？')) return null;
    prompter.info(`什么都没保存；准备好了再运行 ${vika} setup。`);
    return DECLINED;
  };

  const steps = current ? [] : [
    { section: { title: '机器人', step: 1, total: 3 }, ask: askId }, { ask: askName }, { ask: askWorkspace }, { ask: askRuntime },
    { section: { title: '消息渠道和记忆', step: 2, total: 3 }, ask: askIms }, { ask: askChannel }, { ask: askOv }, { ask: askMail },
    { section: { title: '确认', step: 3, total: 3 }, ask: confirmNew },
  ];
  const run = {};
  const page = {};
  const original = current ? Object.fromEntries(SETTINGS.map(({ key, shown }) => [key, shown(state, ctx)])) : null;
  let newIms;
  let larkCliBin;
  let agent;
  let plan;
  let lark = null;
  // The questions, then the codes to scan. ← while a code waits to be
  // scanned comes back to the questions, as nothing exists yet; once a scan
  // is confirmed (a Feishu app made, a Weixin account bound) it cannot.
  for (;;) {
    prompter.navigable = prompter.tty;
    if (current) {
      const describe = () => describeChanges(current, build(), mailPlan(state), homeDir);
      if (!await editInstance(ctx, state, { describe, check: () => problem(build()), before: original, page })) return 0;
      out(`\n将修改 ${current.displayName}（${current.id}）：\n${describe().map((change) => `  ${change}\n`).join('')}`);
      const added = ims(state).filter((im) => !connectorsOf(current).includes(im));
      if (added.length) prompter.info(`接下来扫码：${added.map((im) => `${IM_LABELS[im]} ${SCANS[im]} 次`).join('，')}`);
    } else if (await wizard(ctx, state, steps, run) === DECLINED) {
      return 1;
    }
    prompter.navigable = false;
    const before = current ? connectorsOf(current) : [];
    newIms = ims(state).filter((im) => !before.includes(im));

    // The release's own lark-cli, unless the manifest or environment pins another.
    larkCliBin = state.connectors.includes('lark')
      ? (env.LARK_CLI_BIN || manifest?.env?.LARK_CLI_BIN || resolveLarkCli(env))
      : null;
    if (newIms.includes('lark') && !larkCliBin) {
      out('\n找不到 lark-cli：这个安装不完整，重新运行安装脚本。\n');
      return 1;
    }
    agent = build();
    plan = { id: state.id, displayName: state.displayName, dataDir: state.dataDir };
    // A code to scan needs the whole screen; the boat comes back afterwards.
    if (newIms.length) live?.release();
    try {
      lark = newIms.includes('lark')
        ? await connect.lark({
          plan, prompter, larkCli: new LarkCli(larkCliBin), fetchImpl, profile: agent.profile, debug: Boolean(env.VIKA_DEBUG), canGoBack: prompter.tty,
        })
        : null;
      if (newIms.includes('weixin')) await connect.weixin({ plan, prompter, canGoBack: prompter.tty && !lark });
      break;
    } catch (error) {
      if (!(error instanceof GoBack)) throw error;
      live?.resume();
      if (current) prompter.rewind(page.mark, { whole: true });
      else returnToLast(prompter, steps, run);
    }
  }
  live?.resume();
  const id = state.id;
  if (state.useOv === true) writeInstanceOvConfig({ detected: ov, instanceId: id, target: agent.ovConfig });
  const mail = mailPlan(state);
  for (const { config, account } of mail.write) writeEmailAccount(config, account);

  fs.mkdirSync(state.workspace, { recursive: true, mode: 0o700 });
  writeManifest(configPath, manifestWith(agent));
  for (const mailbox of mail.removed) fs.rmSync(mailbox.config, { force: true });

  prompter.section(current ? '重启' : '启动');
  prompter.success(`配置已写入 ${shortenHome(configPath, homeDir)}`);
  // pm2's own progress lines stay out of the way; the spinners say it.
  const quiet = { write() {} };
  const verb = current ? '重启' : '启动';
  try {
    await step(prompter, `${verb} ${state.displayName}（${id}）`,
      () => (current ? control.restart : control.start)(id, { env, stdout: quiet }), `${state.displayName}（${id}）在后台跑起来了`);
  } catch (error) {
    out(`\n配置已保存，但${verb}没有完成：${error.message}\n修好后运行 ${vika} ${current ? 'restart' : 'start'} ${id}\n`);
    return 1;
  }
  if (!current) {
    // The instance is up. The shared Web (it routes to every instance, so it
    // restarts to pick this one up) and the updater are helpers: report, go on.
    for (const [action, target, label] of [['restart', 'web', `控制台 http://127.0.0.1:${WEB_PORT}`], ['start', 'updater', '自动升级服务']]) {
      const spinning = prompter.spin(`启动${label}`);
      await control[action](target, { env, stdout: quiet }).then(
        () => spinning.succeed(label),
        (error) => spinning.warn(`vika-${target} 没有起来：${error.message}；之后运行 ${vika} ${action} ${target}`),
      );
    }
  }
  let greeted = false;
  if (lark) {
    const text = greeting({ name: state.displayName, newInstance: !current, primary: state.channel === 'lark' });
    const spinning = prompter.spin('在飞书里跟你打个招呼');
    await connect.greet({ larkCliBin, profile: lark.profile, userId: lark.ownerOpenId, text }).then(
      () => { greeted = true; spinning.succeed('已在飞书私聊里跟你打了招呼'); },
      (error) => spinning.warn(`飞书打招呼的消息没发出去：${error.message}`),
    );
  }
  if (!current && prompter.tty && control.autostart && !autostartEnabled({ homeDir })) await offerAutostart({ prompter, env, homeDir, control, vika });

  const next = [];
  if (lark) next.push(['飞书', greeted ? '私聊里它已经跟你打了招呼，直接回它' : `在飞书里搜「${state.displayName}」，给它发消息`]);
  if (newIms.includes('weixin')) next.push(['微信', '先给它发一句「你好」，它才能主动找你']);
  if (!current) {
    next.push(['控制台', `http://127.0.0.1:${WEB_PORT}  每一轮在做什么都在这里`]);
    if (env.SSH_CONNECTION) next.push(['', `远程机器：本地 ssh -L ${WEB_PORT}:127.0.0.1:${WEB_PORT} 再打开`]);
    next.push(['常用命令', 'vika status · vika logs · vika setup']);
  }
  const title = `${state.displayName}（${id}）${current ? '已更新' : '已就绪'}`;
  if (prompter.fancy) {
    table(prompter, title, next);
  } else {
    out(`\n${title}。\n${next.map(([key, value]) => `  ${key ? `${key}：` : ''}${value}\n`).join('')}`);
  }
  if (vika !== 'vika' && !current) prompter.info(`这个终端还找不到 vika：新开一个终端就行（安装时已加进 shell 配置），或先用 ${vika}`);
  if (newIms.includes('weixin')) {
    out(prompter.fancy ? `\n  ${prompter.s.yellow('▲')} ${prompter.s.bold('最后一步：')}${WEIXIN_FIRST_MESSAGE}\n` : `\n最后一步：${WEIXIN_FIRST_MESSAGE}\n`);
  }
  return 0;
}

// Starting at login is one question at the end of a first setup. A machine
// without a user service manager says so, and setup still succeeds.
async function offerAutostart({ prompter, env, homeDir, control, vika }) {
  if (!await prompter.confirm('开机后自动启动 Vika？', true)) {
    prompter.info(`之后想开：${vika} autostart enable`);
    return;
  }
  let said = '';
  await control.autostart(['enable'], { env, homeDir, output: { write: (text) => { said += text; } } }).then(
    () => {
      prompter.success('开机自启已开启');
      if (/loginctl/.test(said)) prompter.info('Linux 服务器上还要运行一次 loginctl enable-linger，否则退出登录后 Vika 会停。');
    },
    (error) => prompter.warn(`这台机器开不了开机自启：${String(error.message).split('\n')[0]}`),
  );
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
