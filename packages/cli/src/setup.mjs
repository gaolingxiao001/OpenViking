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
  WEB_PORT, allocatePort, availableInstanceOvConfig, instanceIdProblem, readManifest, suggestInstanceId, validateManifest, vikaCommand, vikaHome,
  withChangedInstance, withInstance, writeManifest,
} from './manifest.mjs';
import { detectOpenViking, writeInstanceOvConfig } from './ov.mjs';
import { configureOpenViking, prepareInstanceOpenViking, saveOVConnection } from './ov-setup.mjs';
import { detectRuntimes, which } from './runtimes.mjs';
import { showScan } from './qr.mjs';
import { restartCommand, startCommand } from './control.mjs';
import { autostartCommand, autostartEnabled } from './autostart.mjs';
import { openingBanner } from './banner.mjs';
import { box, padEnd, width } from './ui.mjs';
import { LANGUAGES, languageChoice, list, saveLanguage, setLanguage, t } from './i18n.mjs';
import { releaseInfo } from './version.mjs';
import { EmailCancelled, askEmail, emailAccountPath, emailInstanceId, mailboxesOf, writeEmailAccount } from './email.mjs';
import { GoBack } from './prompt.mjs';
import { IM_LABELS, connectorsOf, imList, primaryMeaning } from './instances.mjs';
import { connectTelegram } from './telegram.mjs';
import { connectSlack } from './slack.mjs';

// `vika setup`: add an instance, or change one. A new instance is asked
// question by question; a change is a list of every setting with its current
// value, where the owner opens the ones to change and saves. Then the QR scans
// (only for a newly connected IM), then the manifest is written and the
// instance (re)started. A new instance's OV config is prepared and checked
// before IM setup, then removed on cancellation until its manifest is saved.
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

const imChoices = () => [
  { label: IM_LABELS.lark, value: 'lark' },
  { label: IM_LABELS.weixin, value: 'weixin' },
  { label: IM_LABELS.email, value: 'email',
    hint: t('IMAP/SMTP；新邮件提醒和回信确认发到主渠道', 'IMAP/SMTP; new-mail alerts and reply approvals go to the primary channel') },
  { label: 'Telegram', value: 'telegram',
    hint: t('官方 Bot API；需要 @BotFather 创建 Bot 和 token', 'official Bot API; needs a bot and its token from @BotFather') },
  { label: 'Slack', value: 'slack',
    hint: t('工作区里自建的 Slack App（Socket Mode）；需要粘贴两个 token', 'an app in your own Slack workspace (Socket Mode); paste two tokens') },
];

// IMs connected by pasting tokens rather than scanning a code.
const TOKEN_IMS = ['telegram', 'slack'];

const ims = (state) => state.connectors.filter((connector) => connector !== 'email');

// Which instance to change, or a new one.
async function chooseTarget(prompter, manifest) {
  const agents = manifest?.agents ?? [];
  if (agents.length === 0) return null;
  return prompter.select(t('要做什么', 'What to do'), [
    { label: t('新建一个实例', 'Add an instance'), value: null },
    ...agents.map((agent) => ({
      label: t(`修改 ${agent.displayName}（${agent.id}）`, `Change ${agent.displayName} (${agent.id})`), hint: imList(connectorsOf(agent), agent.emailAccounts?.length), value: agent,
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
  return { label: t(`保持现在的（${current.model}）`, `Keep the current one (${current.model})`), model: current.model, available: true, note: '', kept: true };
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
    ovConfig: current?.ovConfig,
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
    ? t('机器人名字（已经建好的飞书应用名不会跟着改）', 'Bot name (the Feishu/Lark app made before keeps its name)')
    : t('机器人名字（也是飞书应用名，@它时用这个名字）', 'Bot name (also the Feishu/Lark app name, to @mention it by)'), {
    label: t('机器人名字', 'Bot name'),
    initial: state.displayName,
    validate: (value) => (value.length > 40 ? t('最多 40 个字符', 'At most 40 characters') : null),
  });
}

async function askWorkspace({ prompter, env, homeDir }, state) {
  state.workspace = path.resolve(expandHome(await prompter.text(t('工作目录（agent 在这里读写文件）', 'Workspace (where the agent reads and writes files)'), {
    label: t('工作目录', 'Workspace'),
    initial: shortenHome(state.workspace, homeDir),
    validate: (value) => {
      const resolved = path.resolve(expandHome(value, homeDir));
      if (resolved === homeDir) return t('不要直接用 home 目录，换一个子目录', 'Not the home directory itself; use a folder inside it');
      if (resolved.startsWith(`${vikaHome(env)}${path.sep}`)) return t('不能放在 ~/.vika 里', 'Not inside ~/.vika');
      return null;
    },
  }), homeDir));
}

async function askRuntime({ prompter, runtimes, kept }, state) {
  const choices = [...(kept ? [kept] : []), ...runtimes];
  state.runtime = await prompter.select(t('Agent 运行时', 'Agent runtime'), choices.map((runtime) => ({
    label: runtime.label, value: runtime, hint: runtime.note, disabled: !runtime.available,
  })), { initial: Math.max(0, choices.findIndex((runtime) => runtime.available && runtime.model === state.runtime?.model)) });
}

// What a step says besides asking. A new instance's steps stay on screen;
// the change list is drawn again after each setting, so there it shows
// above the list.
function note(ctx, text) {
  if (ctx.menu) ctx.notes.push(text);
  else ctx.prompter.info(text);
}

// A primary IM that was dropped moves to what is left, Feishu first.
function keepChannel(ctx, state) {
  if (ims(state).includes(state.channel)) return;
  const next = ims(state).includes('lark') ? 'lark' : ims(state)[0];
  note(ctx, t(`主渠道原来是${IM_LABELS[state.channel]}，它不再接入，改成${IM_LABELS[next]}`,
    `The primary channel was ${IM_LABELS[state.channel]}, which is no longer connected; it is now ${IM_LABELS[next]}`));
  state.channel = next;
}

function dropMailboxes(state) {
  state.mail.removed.push(...state.mail.kept);
  state.mail.kept = [];
  state.mail.added = [];
  state.mail.updated.clear();
}

// One more mailbox. In the change menu, giving up on it goes back to the list.
async function addMailbox({ prompter, env, connect, menu, checkOV }, state) {
  let account;
  await checkOV();
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
  } while (await orElse(() => ctx.prompter.confirm(t('再接一个邮箱？', 'Add another mailbox?'), false), ctx.menu, false));
  const has = mailboxList(state).length > 0;
  state.connectors = state.connectors.filter((connector) => connector !== 'email').concat(has ? ['email'] : []);
}

async function askIms(ctx, state) {
  let connectors;
  for (;;) {
    const choices = imChoices();
    connectors = await ctx.prompter.multiselect(t('接入哪些 IM', 'Which IMs to connect'), choices,
      { initial: choices.map(({ value }, index) => (state.connectors.includes(value) ? index : -1)).filter((index) => index >= 0) });
    if (connectors.some((connector) => connector !== 'email')) break;
    ctx.prompter.warn(t('邮箱不能单独接：新邮件提醒和回信确认要发到飞书、微信、Telegram 或 Slack，再选一个。',
      'Email cannot be the only one: its alerts and reply approvals go to Feishu/Lark, WeChat, Telegram or Slack, so pick one of those too.'));
  }
  const hadEmail = state.connectors.includes('email');
  state.connectors = connectors;
  if (hadEmail && !connectors.includes('email')) dropMailboxes(state);
  // When changing an instance, a newly ticked mailbox is connected right away.
  if (ctx.menu && !hadEmail && connectors.includes('email')) await addMailboxes(ctx, state);
  if (ctx.menu) keepChannel(ctx, state);
}

// The primary IM is its own question, Feishu unless it is left out; with a
// single IM there is nothing to ask.
async function askChannel(ctx, state) {
  const choices = ims(state);
  if (choices.length > 1) {
    const preferred = [state.channel, 'lark'].find((im) => choices.includes(im)) ?? choices[0];
    state.channel = await ctx.prompter.select(t(`主渠道（${primaryMeaning()}）`, `Primary channel (${primaryMeaning()})`),
      choices.map((connector) => ({ label: IM_LABELS[connector], value: connector })),
      { initial: choices.indexOf(preferred), label: t('主渠道', 'Primary channel') });
    return;
  }
  state.channel = choices[0];
  if (ctx.menu) {
    note(ctx, t(`只接了${IM_LABELS[state.channel]}，主渠道只能是它；要换，先在「接入的 IM」里多接一个`,
      `Only ${IM_LABELS[state.channel]} is connected, so it is the primary channel; to change that, connect another IM first`));
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
    const addresses = list(mailboxList(state).map(addressOf));
    const choice = await orElse(() => ctx.prompter.select(t(`邮箱（已接入：${addresses}）`, `Mailboxes (connected: ${addresses})`), [
      { label: t('不改了', 'Done'), value: { kind: 'done' } },
      { label: t('再接一个邮箱', 'Add a mailbox'), value: { kind: 'add' } },
      ...kept.map((mailbox) => ({ label: t(`更新 ${addressOf(mailbox)} 的密码`, `New password for ${addressOf(mailbox)}`), value: { kind: 'update', mailbox } })),
      ...mailboxList(state).map((mailbox) => ({ label: t(`移除 ${addressOf(mailbox)}`, `Remove ${addressOf(mailbox)}`), value: { kind: 'remove', mailbox } })),
    ], { label: t('邮箱', 'Mailboxes') }), ctx.menu, { kind: 'done' });
    if (choice.kind === 'done') break;
    if (choice.kind === 'add') await addMailbox(ctx, state);
    if (choice.kind === 'update') {
      await ctx.checkOV();
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
  { key: 'displayName', label: () => t('机器人名字', 'Bot name'), ask: askName, shown: (state) => state.displayName },
  { key: 'workspace', label: () => t('工作目录', 'Workspace'), ask: askWorkspace, shown: (state, { homeDir }) => shortenHome(state.workspace, homeDir) },
  { key: 'runtime', label: () => t('Agent 运行时', 'Agent runtime'), ask: askRuntime,
    shown: (state) => (state.runtime.kept ? state.runtime.model : state.runtime.label) },
  { key: 'ims', label: () => t('接入的 IM', 'Connected IMs'), ask: askIms, shown: (state) => imList(state.connectors) },
  { key: 'channel', label: () => t('主渠道', 'Primary channel'), ask: askChannel, shown: (state) => IM_LABELS[state.channel] },
  { key: 'mailboxes', label: () => t('邮箱', 'Mailboxes'), ask: askMailboxes,
    shown: (state) => (mailboxList(state).length ? list(mailboxList(state).map(addressOf)) : t('没有接', 'none')) },
  { key: 'ovConfig', label: () => 'OpenViking', ask: (ctx) => ctx.editOV(),
    shown: (state, { homeDir }) => shortenHome(state.ovConfig, homeDir) },
];

const mailChanged = (state) => state.mail.added.length + state.mail.updated.size + state.mail.removed.length > 0;

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
    for (const text of ctx.notes.splice(0)) prompter.info(text);
    notice = null;
    const changes = describe(state);
    const changed = (key, value) => value !== before[key] || (key === 'mailboxes' && mailChanged(state));
    const labels = SETTINGS.map(({ label }) => label());
    const labelWidth = Math.max(...labels.map((label) => width(label))) + 2;
    const name = t(`修改 ${current.displayName}（${current.id}）`, `Change ${current.displayName} (${current.id})`);
    let choice;
    try {
      choice = await prompter.select(name, [
        ...SETTINGS.map(({ key, shown }, index) => {
          const value = shown(state, ctx);
          return { label: padEnd(labels[index], labelWidth), hint: `${value}${changed(key, value) ? t('（已改）', ' (changed)') : ''}`, value: index };
        }),
        { label: changes.length ? t(`保存（${changes.length} 项改动）`, `Save (${changes.length} ${changes.length === 1 ? 'change' : 'changes'})`) : t('保存', 'Save'), value: 'save' },
        { label: t('放弃修改', 'Discard changes'), value: 'quit' },
      ], { initial: page.cursor ?? 0, label: name });
    } catch (error) {
      if (!(error instanceof GoBack)) throw error;
      // Back to 要做什么, unless that would drop changes nobody saved.
      if (changes.length === 0) throw new StartOver();
      notice = t(`有 ${changes.length} 项改动还没保存：选「保存」，或者「放弃修改」`,
        `${changes.length} unsaved ${changes.length === 1 ? 'change' : 'changes'}: choose Save, or Discard changes`);
      continue;
    }
    if (choice === 'quit') {
      out(t('\n已放弃，没有保存任何改动。\n', '\nDiscarded; nothing was saved.\n'));
      return null;
    }
    if (choice === 'save') {
      if (changes.length === 0) {
        out(t('\n没有改动。\n', '\nNothing changed.\n'));
        return null;
      }
      const problem = check(state);
      if (!problem) return state;
      notice = t(`这样改不行：${problem}`, `That will not work: ${problem}`);
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
  prompter.write(t('\n  在飞书开放平台打开刚创建的应用 →「凭证与基础信息」，复制下面两项：\n',
    '\n  In the Feishu/Lark developer console, open the app just created → Credentials & Basic Info, and copy these two:\n'));
  const appId = await prompter.text('App ID', { validate: (value) => (/^cli_[0-9a-z]+$/.test(value) ? null : t('App ID 以 cli_ 开头', 'An App ID starts with cli_')) });
  const appSecret = await prompter.secret('App Secret');
  const brand = await prompter.select(t('租户', 'Tenant'), [
    { label: t('飞书', 'Feishu'), value: 'feishu' }, { label: t('Lark（国际版）', 'Lark (international)'), value: 'lark' },
  ]);
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
    description: t('Vika：把本机的 coding agent 接进飞书', 'Vika: the coding agent on your computer, in Feishu/Lark'),
    scopes,
    signal: controller.signal,
    ...(register ? { register } : {}),
    onQRCode: ({ url, expiresIn }) => {
      scan?.stop();
      scan = showScan(prompter, {
        url,
        where: IM_LABELS.lark,
        title: t(`第 1 次扫码：用飞书 App 扫码，创建机器人应用（${Math.round(expiresIn / 60)} 分钟内有效）`,
          `Scan 1 of 2: scan with the Feishu/Lark app to create the bot app (valid for ${Math.round(expiresIn / 60)} minutes)`),
        stopKey: 'm',
        stopLabel: t('手动填 App ID', 'enter the App ID by hand'),
        onBack: canGoBack ? () => wantBack() : null,
      });
      scan.pressed.then((pressed) => { if (pressed) wantManual(); });
    },
    onStatus: (status) => {
      if (debug) scan?.say(`[registration] ${status}`);
      if (status === 'domain_switched') scan?.say(t('识别到国际版 Lark 租户', 'This is a Lark (international) tenant'));
      if (status === 'polling') scan?.status(t('等待扫码确认', 'Waiting for the scan to be confirmed'));
      if (status === 'slow_down') scan?.status(t('平台要求放慢轮询，继续等待', 'Asked to poll more slowly; still waiting'));
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
  prompter.section(IM_LABELS.lark);
  // Only the first code can be gone back from: once it is confirmed the app exists.
  const app = await registerApp({ plan, prompter, scopes, debug, canGoBack });
  prompter.success(t(`已创建应用 ${app.appId}`, `Created the app ${app.appId}`));
  const inspected = await step(prompter, t('核对应用的权限和版本', 'Checking the app\'s permissions and version'),
    () => inspectApp(app, { fetchImpl }), t('应用信息已读取', 'App checked'));
  const missing = missingScopes(scopes, inspected.granted);
  if (!inspected.online) {
    prompter.warn(t('应用还没有上线版本，可能在等管理员审核；审核通过后机器人才能收消息，不用重新 setup。',
      'The app has no live version yet, perhaps awaiting admin approval; the bot gets messages once it is approved, with no need to run setup again.'));
  }
  const absent = [...missing.tenant, ...missing.user];
  if (absent.length) {
    const some = list(absent.slice(0, 8));
    prompter.warn(t(`有 ${absent.length} 个权限没开通，相关功能会不可用：${some}${absent.length > 8 ? ' 等' : ''}`,
      `${absent.length} permissions are not granted, so what needs them will not work: ${some}${absent.length > 8 ? ', …' : ''}`));
  } else {
    prompter.success(t(`权限核对通过：${scopes.tenant.length} 个机器人权限、${scopes.user.length} 个用户权限`,
      `Permissions check out: ${scopes.tenant.length} bot and ${scopes.user.length} user scopes`));
  }
  await larkCli.configureProfile({ profile, ...app });
  const login = await larkCli.beginUserLogin({ profile, scopes: scopes.user });
  const scan = showScan(prompter, {
    url: login.url, where: IM_LABELS.lark, label: t('等待授权', 'Waiting for authorization'),
    title: t('第 2 次扫码：授权 Vika 以你的身份读消息（用于搜索和读历史）', 'Scan 2 of 2: let Vika read messages as you (for search and history)'),
  });
  try {
    await larkCli.finishUserLogin({ profile, deviceCode: login.deviceCode });
  } finally {
    scan.stop();
  }
  const ownerOpenId = await larkCli.userOpenId({ profile });
  if (!ownerOpenId) throw new Error('lark-cli authorization finished without a user identity');
  if (app.ownerOpenId && ownerOpenId !== app.ownerOpenId) {
    prompter.warn(t('两次扫码的不是同一个飞书账号；机器人会把第 2 次扫码的人当作主人。',
      'The two scans came from different Feishu/Lark accounts; the bot takes the second as its owner.'));
  }
  prompter.success(t('飞书已接好', 'Feishu/Lark is connected'));
  return { profile, ownerOpenId };
}

// canGoBack: ← while the code waits stops the login before anything is bound
// and rejects with GoBack.
// The login's errors and status lines, in this run's language.
function weixinError(error) {
  const text = {
    weixin_bad_verify_code: t('验证码格式无效', 'That verification code is malformed'),
    weixin_verify_code_blocked: t('验证码错误次数过多，请稍后重新扫码', 'Too many wrong codes; scan again later'),
    weixin_bound_elsewhere: t('微信端显示已绑定，但本地没有可用凭证', 'WeChat says this account is bound, but there are no credentials here'),
    weixin_login_timeout: t('微信扫码登录超时，请重新运行', 'The WeChat login timed out; run it again'),
  }[error?.code];
  return text ? Object.assign(new Error(text), { code: error.code }) : error;
}

export async function connectWeixin({ plan, prompter, canGoBack = false }) {
  prompter.section(IM_LABELS.weixin);
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
        where: IM_LABELS.weixin,
        title: refreshed ? t('二维码过期了，换了一张：用手机微信扫码', 'The code expired, here is a new one: scan it with WeChat on your phone')
          : t('用手机微信扫码，并在手机上确认', 'Scan with WeChat on your phone, then confirm there'),
        onBack: canGoBack ? () => wantBack() : null,
      });
    },
    // `connected` is left to the line that follows the scan.
    say: (text, { kind, accountId } = {}) => {
      if (kind === 'connected') return;
      const said = {
        scanned: t('已扫码，请在手机上确认', 'Scanned; confirm on your phone'),
        'already-bound': t(`本地已有微信账号 ${accountId} 的凭证，无需重复绑定`, `WeChat account ${accountId} is bound here already`),
      }[kind] ?? text;
      if (!scan) { prompter.info(said); return; }
      scan.say(said);
      if (kind === 'scanned') scan.status(t('等待在手机上确认', 'Waiting for you to confirm on the phone'));
    },
    readVerifyCode: () => {
      scan?.stop();
      scan = null;
      return prompter.text(t('微信显示的验证码', 'The code WeChat shows'));
    },
  }).catch((error) => { throw weixinError(error); });
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
  prompter.success(t('微信已接好', 'WeChat is connected'));
}

// No runtime can run yet: the built-in Pi logs in to a model right here,
// in Pi's own screen, and setup carries on when it quits.
export async function loginPi({ prompter, env }) {
  prompter.info(t('打开内置的 Pi：输入 /login 选模型提供方并登录，完成后输入 /quit 回到这里。',
    'Opening the built-in Pi: type /login to pick a model provider and log in, then /quit to come back here.'));
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
export const weixinFirstMessage = () => t(
  '在微信里先给机器人发一句话（比如「你好」）：在那之前它没法主动找你，新邮件提醒也发不到微信。',
  'Send the bot a message on WeChat first (say "hi"): until then it cannot reach you there, not even with new-mail alerts.',
);

// What the bot says on Feishu when it is newly connected; on the primary IM,
// also that it reaches the owner there.
function greeting({ name, newInstance, primary }) {
  const hello = newInstance
    ? t(`你好，我是 ${name}，已经在你的电脑上跑起来了。直接给我发消息就行；把我拉进群，我也能参与群聊。`,
      `Hi, I'm ${name}, now running on your computer. Just message me here; add me to a group and I can join in there too.`)
    : t(`你好，我是 ${name}，现在也能在飞书里找到我了。`, `Hi, I'm ${name}; you can reach me here too now.`);
  return primary
    ? `${hello}${t('以后我主动找你的消息（比如新邮件提醒、待你确认的邮件回复）会发到这里。',
      ' When I need to reach you on my own (new-mail alerts, replies waiting for your OK), it will be here.')}`
    : hello;
}

const found = (labels) => t(`找到 ${list(labels)}`, `Found ${list(labels)}`);

// What the machine offers, in one line, once the check is done.
function foundLine(runtimes) {
  const ready = runtimes.filter((runtime) => runtime.available).map((runtime) => runtime.label);
  return ready.length ? found(ready) : t('还没有能用的 agent', 'No usable agent yet');
}

// Until some runtime can run: say why each cannot, and offer to log the
// built-in Pi in to a model here. Resolves with the runtimes, or null to stop.
async function ensureRuntime({ prompter, env, detect, connect, live }, runtimes) {
  let detected = runtimes;
  while (!detected.some((runtime) => runtime.available)) {
    prompter.warn(t('没有可用的 agent 运行时：', 'No agent runtime can run yet:'));
    const labelWidth = Math.max(...detected.map((runtime) => width(runtime.label)));
    for (const runtime of detected) prompter.write(`      ${padEnd(runtime.label, labelWidth)}  ${runtime.note}\n`);
    const later = t(`登录好其中一个后，重新运行 ${vikaCommand(env)} setup。`, `Log in to one of them, then run ${vikaCommand(env)} setup again.`);
    if (!prompter.tty || !connect.pi) {
      prompter.info(later);
      return null;
    }
    const next = await prompter.select(t('现在怎么办', 'What now'), [
      { label: t('用内置的 Pi，现在登录一个模型', 'Use the built-in Pi and log in to a model now'), value: 'pi',
        hint: t('在 Pi 里输入 /login，登录后 /quit 回到这里', 'type /login in Pi, then /quit to come back') },
      { label: t('先退出，我去登录 Codex 或 Claude Code', 'Quit; I will log in to Codex or Claude Code'), value: 'quit' },
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
    detected = await step(prompter, t('再看一次有哪些 agent', 'Looking for agents again'), () => detect.runtimes({ env }),
      (again) => (again.some((runtime) => runtime.available)
        ? found(again.filter((runtime) => runtime.available).map((runtime) => runtime.label)) : t('还是没有能用的 agent', 'Still no usable agent')));
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
  prompter.write(`\n${title}${t('：', ':')}\n${rows.map(([key, value]) => `  ${padEnd(key, keyWidth)}  ${value}`).join('\n')}\n`);
}

const SCANS = { lark: 2, weixin: 1 };

function connectionSteps(prompter, connectors, { saving = false } = {}) {
  if (!connectors.length) return;
  const telegram = connectors.some((im) => TOKEN_IMS.includes(im));
  const steps = connectors.map((im) => (im === 'telegram'
    ? t('Telegram Bot token + Start 绑定', 'Telegram bot token + Start')
    : im === 'slack' ? t('Slack 建 App + 两个 token + 私聊口令绑定', 'Slack app + two tokens + a code in a direct message')
      : t(`${IM_LABELS[im]} ${SCANS[im]} 次`, `${IM_LABELS[im]} ${SCANS[im]} ${SCANS[im] === 1 ? 'scan' : 'scans'}`)));
  prompter.info(t(
    `接下来${telegram ? '接入' : '扫码'}：${steps.join('，')}${saving ? `；${telegram ? '全部验证成功' : '扫完'}才保存实例` : ''}`,
    `Next, ${telegram ? 'connecting' : 'scanning'}: ${steps.join(', ')}${saving ? `; the instance is saved after ${telegram ? 'all of it checks out' : 'the scans are done'}` : ''}`,
  ));
}

// The language comes first, before the boat even, as everything after it
// is said in it. Chinese unless chosen; on a terminal whose locale is not
// Chinese it is asked (see i18n.mjs), and kept for later commands when the
// owner chose it here.
async function chooseLanguage({ prompter, env, flag }) {
  const choice = languageChoice({ env, flag });
  setLanguage(choice.language);
  if (choice.settled ? !choice.explicit : !prompter.tty) return;
  const codes = Object.keys(LANGUAGES);
  const chosen = choice.settled ? choice.language : await prompter.select('Language / 语言',
    codes.map((code) => ({ label: LANGUAGES[code], value: code })), { initial: codes.indexOf(choice.language), back: false });
  setLanguage(chosen);
  saveLanguage(chosen, env);
}

// The boat sails above the whole setup on a colour terminal; whatever ends
// the setup, the terminal gets its whole screen back.
export async function setupCommand(options = {}) {
  const { prompter, env = process.env, banner = openingBanner, lang = null } = options;
  await chooseLanguage({ prompter, env, flag: lang });
  const live = prompter.fancy ? await banner({ output: prompter.output, input: prompter.input, env, version: releaseInfo().version }) : null;
  // What the first pass learned (the detected agents), kept when ← goes all
  // the way back to 要做什么 and setup starts over.
  const memo = {};
  prompter.pageTop = () => live?.top() ?? null;
  try {
    for (;;) {
      const pendingOV = new Set();
      try {
        return await setupFlow({ ...options, live, memo, pendingOV });
      } catch (error) {
        if (!(error instanceof StartOver)) throw error;
      } finally {
        for (const file of pendingOV) fs.rmSync(file, { force: true });
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
  configureOV = configureOpenViking,
  connect = { lark: connectLark, weixin: connectWeixin, telegram: connectTelegram, slack: connectSlack, email: askEmail, greet, pi: loginPi },
  control = { start: startCommand, restart: restartCommand, autostart: autostartCommand },
  allocate = allocatePort,
  live = null,
  memo = {},
  pendingOV = new Set(),
}) {
  const out = (text) => prompter.write(text);
  const vika = vikaCommand(env);
  if (!memo.runtimes) {
    if (!prompter.fancy) out(t('Vika setup：添加或修改这台机器上的 agent 实例。\n\n', 'Vika setup: add or change the agent instances on this machine.\n\n'));
    memo.runtimes = await step(prompter, t('看看这台机器上有哪些 agent', 'Looking for agents on this machine'),
      () => detect.runtimes({ env }), foundLine);
    memo.mark = prompter.mark();
  } else {
    prompter.rewind(memo.mark);
  }
  let runtimes = memo.runtimes;
  // The connection this run chose (a new instance's, or a changed one), kept
  // for the next instance once the manifest is saved.
  let ov = null;
  const { path: configPath, value: manifest } = readManifest(env);
  // ← and → move between the questions, until the scans begin.
  prompter.navigable = prompter.tty;
  const current = await chooseTarget(prompter, manifest);
  if (!current) {
    runtimes = await ensureRuntime({ prompter, env, detect, connect, live }, runtimes);
    if (!runtimes) return 1;
    memo.runtimes = runtimes;
  }
  const kept = keptRuntime(current, runtimes);
  const others = manifest?.agents?.length > 0;
  const ctx = { prompter, out, env, homeDir, runtimes, current, connect, kept, menu: Boolean(current), startOver: others, notes: [] };
  const state = initialState({ id: current?.id ?? suggestInstanceId(manifest), env, homeDir, current, runtimes, kept });
  const port = current ? current.port : await allocate(manifest);
  ctx.editOV = async () => {
    const detected = await configureOV({ prompter, env, homeDir, fetchImpl, detect: detect.openViking,
      preferredConfigPath: state.ovConfig, title: `OpenViking · ${current.id}`, canGoBack: true,
      leaveTo: t('返回实例设置', 'Back to instance settings') });
    const pending = new Set();
    try {
      const target = await prepareInstanceOpenViking({
        agent: { ...current, ovConfig: state.ovConfig }, detected, pending, env, homeDir, fetchImpl,
        detect: detect.openViking, reserved: new Set(manifest.agents.map(({ ovConfig }) => ovConfig)),
      });
      if (target !== state.ovConfig && pendingOV.has(state.ovConfig)) {
        fs.rmSync(state.ovConfig, { force: true });
        pendingOV.delete(state.ovConfig);
      }
      for (const file of pending) pendingOV.add(file);
      pending.clear();
      if (target !== state.ovConfig) ov = detected;
      state.ovConfig = target;
    } finally {
      for (const file of pending) fs.rmSync(file, { force: true });
    }
  };
  // The instance's own OV config, written for this name and this connection;
  // going back to change either writes it again.
  let prepared = null;
  const checkOV = async () => {
    const checked = await detect.openViking({ env, homeDir, fetchImpl, configPath: state.ovConfig });
    if (!checked?.usable) {
      throw new Error(t(`OpenViking（${state.id}）不可用：${checked?.reason ?? '检查失败'}。请恢复服务后再接入 IM。`,
        `OpenViking (${state.id}) is unavailable: ${checked?.reason ?? 'check failed'}. Restore the service before connecting IMs.`));
    }
    return checked;
  };
  ctx.checkOV = checkOV;
  const prepareOV = () => step(prompter, t('准备并验证实例的 OpenViking 配置', 'Preparing and checking this instance’s OpenViking config'), async () => {
    if (prepared?.id !== state.id || prepared?.ov !== ov) {
      for (const file of pendingOV) fs.rmSync(file, { force: true });
      pendingOV.clear();
      state.ovConfig = availableInstanceOvConfig(env, state.id, new Set(manifest?.agents.map(({ ovConfig }) => ovConfig)));
      writeInstanceOvConfig({ detected: ov, instanceId: state.id, target: state.ovConfig, exclusive: true });
      pendingOV.add(state.ovConfig);
      prepared = { id: state.id, ov };
    }
    await checkOV();
  }, t('OpenViking 已就绪，接下来接入 IM', 'OpenViking is ready; next, connect your IMs'));
  // The section heading comes from the wizard; ← goes back to 要做什么, if there was a choice.
  const chooseOV = async () => {
    ov = await configureOV({ prompter, env, homeDir, fetchImpl, detect: detect.openViking, title: null, canGoBack: others, previous: ov });
  };

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
    agent.ovConfig = state.ovConfig;
    agent.ovAutoRecall = current?.ovAutoRecall ?? false;
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
    state.id = await prompter.text(t('实例名称（用在命令和目录里）', 'Instance name (used in commands and folders)'), {
      label: t('实例名称', 'Instance name'), initial: state.id, validate: (value) => instanceIdProblem(value, manifest),
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
    const channels = ims(state).length > 1
      ? t(`${imList(ims(state))}，主渠道：${IM_LABELS[state.channel]}`, `${imList(ims(state))}; primary: ${IM_LABELS[state.channel]}`)
      : imList(ims(state));
    table(prompter, t(`将添加实例 ${state.id}`, `New instance ${state.id}`), [
      [t('机器人', 'Bot'), `${state.displayName} · ${state.runtime.label}`],
      [t('消息渠道', 'Channels'), channels],
      ...(addresses.length ? [[t('邮箱', 'Email'), list(addresses)]] : []),
      [t('记忆', 'Memory'), 'OpenViking'],
      [t('工作目录', 'Workspace'), shortenHome(state.workspace, homeDir)],
      [t('数据目录', 'Data'), shortenHome(state.dataDir, homeDir)],
    ]);
    connectionSteps(prompter, ims(state), { saving: true });
    const go = ims(state).some((im) => TOKEN_IMS.includes(im)) ? t('开始接入？', 'Start connecting?')
      : ims(state).length ? t('开始扫码？', 'Start scanning?') : t('保存并启动？', 'Save and start?');
    if (await prompter.confirm(go)) return null;
    prompter.info(t(`什么都没保存；准备好了再运行 ${vika} setup。`, `Nothing was saved; run ${vika} setup when you are ready.`));
    return DECLINED;
  };

  const steps = current ? [] : [
    { section: { title: t('OpenViking 记忆', 'OpenViking memory'), step: 1, total: 4 }, ask: chooseOV },
    { section: { title: t('机器人', 'Bot'), step: 2, total: 4 }, ask: askId }, { ask: askName }, { ask: askWorkspace }, { ask: askRuntime },
    { ask: prepareOV },
    { section: { title: t('消息渠道', 'Channels'), step: 3, total: 4 }, ask: askIms }, { ask: askChannel }, { ask: askMail },
    { section: { title: t('确认', 'Confirm'), step: 4, total: 4 }, ask: confirmNew },
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
  // scanned comes back to the questions; its pending OV config can still be
  // removed. Once a scan is confirmed (an app made, an account bound) it cannot.
  for (;;) {
    prompter.navigable = prompter.tty;
    if (current) {
      const describe = () => describeChanges(current, build(), mailPlan(state), homeDir);
      if (!await editInstance(ctx, state, { describe, check: () => problem(build()), before: original, page })) return 0;
      out(`\n${t(`将修改 ${current.displayName}（${current.id}）：`, `Changing ${current.displayName} (${current.id}):`)}\n${describe().map((change) => `  ${change}\n`).join('')}`);
      const added = ims(state).filter((im) => !connectorsOf(current).includes(im));
      connectionSteps(prompter, added);
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
      out(t('\n找不到 lark-cli：这个安装不完整，重新运行安装脚本。\n', '\nlark-cli is missing: this install is incomplete, run the installer again.\n'));
      return 1;
    }
    agent = build();
    plan = { id: state.id, displayName: state.displayName, dataDir: state.dataDir };
    // Answers and mailbox setup can take a while: check again before the
    // first QR scan or bot token, using the actual instance identity.
    if (newIms.length) await checkOV();
    // A code to scan needs the whole screen; the boat comes back afterwards.
    if (newIms.length) live?.release();
    try {
      lark = newIms.includes('lark')
        ? await connect.lark({
          plan, prompter, larkCli: new LarkCli(larkCliBin), fetchImpl, profile: agent.profile, debug: Boolean(env.VIKA_DEBUG), canGoBack: prompter.tty,
        })
        : null;
      let bound = Boolean(lark);
      if (newIms.includes('weixin')) {
        await connect.weixin({ plan, prompter, canGoBack: prompter.tty && !bound });
        bound = true;
      }
      if (newIms.includes('telegram')) {
        await connect.telegram({ plan, prompter, fetchImpl, canGoBack: prompter.tty && !bound });
        bound = true;
      }
      if (newIms.includes('slack')) await connect.slack({ plan, prompter, fetchImpl, canGoBack: prompter.tty && !bound });
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
  const mail = mailPlan(state);
  for (const { config, account } of mail.write) writeEmailAccount(config, account);

  fs.mkdirSync(state.workspace, { recursive: true, mode: 0o700 });
  writeManifest(configPath, manifestWith(agent));
  pendingOV.delete(agent.ovConfig);
  if (ov && agent.ovConfig !== current?.ovConfig) saveOVConnection(ov, { env, homeDir });
  for (const mailbox of mail.removed) fs.rmSync(mailbox.config, { force: true });

  prompter.section(current ? t('重启', 'Restart') : t('启动', 'Start'));
  prompter.success(t(`配置已写入 ${shortenHome(configPath, homeDir)}`, `Saved ${shortenHome(configPath, homeDir)}`));
  // pm2's own progress lines stay out of the way; the spinners say it.
  const quiet = { write() {} };
  const command = current ? 'restart' : 'start';
  try {
    await step(prompter, t(`${current ? '重启' : '启动'} ${state.displayName}（${id}）`, `${current ? 'Restarting' : 'Starting'} ${state.displayName} (${id})`),
      () => control[command](id, { env, stdout: quiet }),
      t(`${state.displayName}（${id}）在后台跑起来了`, `${state.displayName} (${id}) is running in the background`));
  } catch (error) {
    out(t(`\n配置已保存，但${current ? '重启' : '启动'}没有完成：${error.message}\n修好后运行 ${vika} ${command} ${id}\n`,
      `\nSaved, but the ${command} did not finish: ${error.message}\nOnce that is fixed, run ${vika} ${command} ${id}\n`));
    return 1;
  }
  if (!current) {
    // The instance is up. The shared Web (it routes to every instance, so it
    // restarts to pick this one up) and the updater are helpers: report, go on.
    for (const [action, target, label] of [
      ['restart', 'web', t(`控制台 http://127.0.0.1:${WEB_PORT}`, `Console http://127.0.0.1:${WEB_PORT}`)],
      ['start', 'updater', t('自动升级服务', 'Auto-upgrade service')],
    ]) {
      const spinning = prompter.spin(t(`启动${label}`, `Starting the ${label.toLowerCase()}`));
      await control[action](target, { env, stdout: quiet }).then(
        () => spinning.succeed(label),
        (error) => spinning.warn(t(`vika-${target} 没有起来：${error.message}；之后运行 ${vika} ${action} ${target}`,
          `vika-${target} did not start: ${error.message}; later, run ${vika} ${action} ${target}`)),
      );
    }
  }
  let greeted = false;
  if (lark) {
    const text = greeting({ name: state.displayName, newInstance: !current, primary: state.channel === 'lark' });
    const spinning = prompter.spin(t('在飞书里跟你打个招呼', 'Saying hello on Feishu/Lark'));
    await connect.greet({ larkCliBin, profile: lark.profile, userId: lark.ownerOpenId, text }).then(
      () => { greeted = true; spinning.succeed(t('已在飞书私聊里跟你打了招呼', 'Said hello in your Feishu/Lark chat')); },
      (error) => spinning.warn(t(`飞书打招呼的消息没发出去：${error.message}`, `The hello on Feishu/Lark did not go out: ${error.message}`)),
    );
  }
  if (!current && prompter.tty && control.autostart && !autostartEnabled({ homeDir })) await offerAutostart({ prompter, env, homeDir, control, vika });

  // What to do next, one line per thing; on Weixin the owner has to write first.
  const next = [];
  if (lark) {
    next.push([IM_LABELS.lark, greeted ? t('私聊里它已经跟你打了招呼，直接回它', 'It said hello in your chat; just reply')
      : t(`在飞书里搜「${state.displayName}」，给它发消息`, `Search for "${state.displayName}" and message it`)]);
  }
  if (newIms.includes('weixin')) {
    next.push([IM_LABELS.weixin, t('先给它发一句「你好」，在那之前它没法主动找你', 'Say "hi" to it first; until then it cannot reach you')]);
  }
  if (newIms.includes('telegram')) next.push(['Telegram', t('在刚绑定的 Bot 私聊中发一条任务', 'Message the bot you just bound')]);
  if (newIms.includes('slack')) {
    next.push(['Slack', t('私聊机器人发任务；要它参与频道，在频道里 /invite 它；命令前加个空格（ /new）',
      'Message the bot directly; /invite it to channels it should join; put a space before commands ( /new)')]);
  }
  if (!current) {
    next.push([t('控制台', 'Console'), t(`http://127.0.0.1:${WEB_PORT}  每一轮在做什么都在这里`, `http://127.0.0.1:${WEB_PORT}  what every turn did`)]);
    if (env.SSH_CONNECTION) {
      next.push(['', t(`远程机器：本地 ssh -L ${WEB_PORT}:127.0.0.1:${WEB_PORT} 再打开`, `Remote machine: ssh -L ${WEB_PORT}:127.0.0.1:${WEB_PORT} first, then open it`)]);
    }
    next.push([t('常用命令', 'Commands'), 'vika status · vika logs · vika setup']);
  }
  const title = t(`${state.displayName}（${id}）${current ? '已更新' : '已就绪'}`, `${state.displayName} (${id}) is ${current ? 'updated' : 'ready'}`);
  if (prompter.fancy) {
    table(prompter, title, next);
  } else {
    out(`\n${title}${t('。', '.')}\n${next.map(([key, value]) => `  ${key ? `${key}${t('：', ': ')}` : ''}${value}\n`).join('')}`);
  }
  if (vika !== 'vika' && !current) {
    prompter.info(t(`这个终端还找不到 vika：新开一个终端就行（安装时已加进 shell 配置），或先用 ${vika}`,
      `This terminal does not know vika yet: open a new one (the installer added it to your shell setup), or use ${vika} for now`));
  }
  return 0;
}

// Starting at login is one question at the end of a first setup. A machine
// without a user service manager says so, and setup still succeeds.
async function offerAutostart({ prompter, env, homeDir, control, vika }) {
  if (!await prompter.confirm(t('开机后自动启动 Vika？', 'Start Vika when this computer starts?'), true)) {
    prompter.info(t(`之后想开：${vika} autostart enable`, `To turn it on later: ${vika} autostart enable`));
    return;
  }
  let said = '';
  await control.autostart(['enable'], { env, homeDir, output: { write: (text) => { said += text; } } }).then(
    () => {
      prompter.success(t('开机自启已开启', 'Autostart is on'));
      if (/loginctl/.test(said)) {
        prompter.info(t('Linux 服务器上还要运行一次 loginctl enable-linger，否则退出登录后 Vika 会停。',
          'On a Linux server, also run loginctl enable-linger once, or Vika stops when you log out.'));
      }
    },
    (error) => prompter.warn(t(`这台机器开不了开机自启：${String(error.message).split('\n')[0]}`, `Autostart is not available here: ${String(error.message).split('\n')[0]}`)),
  );
}

// What a change to an instance does, one line each, for the confirmation.
function describeChanges(before, after, mailboxes, homeDir) {
  const changes = [];
  const was = connectorsOf(before);
  if (before.ovConfig !== after.ovConfig) changes.push(t('更新 OpenViking 连接', 'Update the OpenViking connection'));
  if (before.displayName !== after.displayName) changes.push(`${t('机器人名字：', 'Bot name: ')}${before.displayName} → ${after.displayName}`);
  if (before.workspace !== after.workspace) {
    const move = `${shortenHome(before.workspace, homeDir)} → ${shortenHome(after.workspace, homeDir)}`;
    changes.push(t(`工作目录：${move}（模型会开一次新的会话）`, `Workspace: ${move} (the model starts a new session)`));
  }
  if (before.model !== after.model) changes.push(`${t('运行时：', 'Runtime: ')}${before.model} → ${after.model}`);
  for (const im of ['lark', 'weixin', 'telegram', 'slack']) {
    if (!was.includes(im) && after.connectors.includes(im)) {
      changes.push(im === 'telegram' ? t(`接入${IM_LABELS[im]}（需要 Bot token 和 Start 绑定）`, `Connect ${IM_LABELS[im]} (needs a bot token and Start)`)
        : im === 'slack' ? t(`接入${IM_LABELS[im]}（需要建 App、两个 token 和私聊口令绑定）`, `Connect ${IM_LABELS[im]} (needs an app, two tokens and a code)`)
          : t(`接入${IM_LABELS[im]}（需要扫码）`, `Connect ${IM_LABELS[im]} (needs a scan)`));
    }
    if (was.includes(im) && !after.connectors.includes(im)) changes.push(t(`不再接${IM_LABELS[im]}`, `Disconnect ${IM_LABELS[im]}`));
  }
  if ((before.channel ?? was[0]) !== after.channel) {
    changes.push(`${t('主渠道：', 'Primary channel: ')}${IM_LABELS[before.channel ?? was[0]]} → ${IM_LABELS[after.channel]}`);
  }
  for (const address of mailboxes.added) changes.push(t(`接入邮箱 ${address}`, `Add mailbox ${address}`));
  for (const address of mailboxes.updated) changes.push(t(`更新邮箱 ${address} 的密码`, `New password for ${address}`));
  for (const mailbox of mailboxes.removed) {
    changes.push(t(`移除邮箱 ${addressOf(mailbox)}（删掉保存的密码）`, `Remove mailbox ${addressOf(mailbox)} (its saved password is deleted)`));
  }
  return changes;
}
