import fs from 'node:fs';
import path from 'node:path';
import { verifyAccount } from '../../daemon/src/email/client.mjs';
import { vikaHome } from './manifest.mjs';
import { PromptAborted } from './prompt.mjs';

// The mailbox step of `vika setup` and `vika login email`: an address and the
// provider's client password, checked by logging in to IMAP and SMTP before
// anything is saved. A known provider needs no server names.

const NETEASE = { label: '网易邮箱', password: '授权码', where: '网页版邮箱 → 设置 → POP3/SMTP/IMAP，开启「IMAP/SMTP 服务」后生成' };

const PROVIDERS = [
  { domains: ['gmail.com', 'googlemail.com'], imap: 'imap.gmail.com', smtp: 'smtp.gmail.com',
    label: 'Gmail', password: '应用专用密码', where: '在 https://myaccount.google.com/apppasswords 生成，要先开启两步验证' },
  { domains: ['qq.com'], imap: 'imap.qq.com', smtp: 'smtp.qq.com',
    label: 'QQ 邮箱', password: '授权码', where: '网页版 QQ 邮箱的设置里开启「IMAP/SMTP 服务」后生成' },
  ...['163.com', '126.com', 'yeah.net'].map((domain) => ({ domains: [domain], imap: `imap.${domain}`, smtp: `smtp.${domain}`, ...NETEASE })),
];

// Mailboxes that take only OAuth, which the connector does not speak.
const OAUTH_ONLY = ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'];

export function emailAccountPath(env, id) {
  return path.join(vikaHome(env), 'email', `${id}.json`);
}

export function providerFor(address) {
  const domain = address.split('@')[1] ?? '';
  return PROVIDERS.find((provider) => provider.domains.includes(domain)) ?? null;
}

function addressProblem(value) {
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value)) return '邮箱地址不对';
  if (OAUTH_ONLY.includes(value.split('@')[1].toLowerCase())) return 'Outlook / Hotmail 只能用 OAuth 登录，暂时接不了，换一个邮箱';
  return null;
}

function portProblem(value) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? null : '端口是 1-65535 的整数';
}

async function servers(prompter, domain, previous) {
  const ask = async (kind, host, port) => ({
    host: await prompter.text(`${kind.toUpperCase()} 服务器`, { initial: host, validate: (value) => (value ? null : '不能为空') }),
    port: Number(await prompter.text(`${kind.toUpperCase()} 端口`, { initial: String(port), validate: portProblem })),
  });
  return {
    imap: await ask('imap', previous?.imap.host ?? `imap.${domain}`, previous?.imap.port ?? 993),
    smtp: await ask('smtp', previous?.smtp.host ?? `smtp.${domain}`, previous?.smtp.port ?? 465),
  };
}

// Why a login failed, in words that point at the usual cause.
function explain(error, provider) {
  const message = String(error?.message ?? error);
  if (/IMAP LOGIN failed|SMTP AUTH/.test(message)) {
    return `${message}\n  多半是密码不对：这里要填${provider?.password ?? '邮箱给第三方客户端用的专用密码'}，不是网页登录密码。`;
  }
  return message;
}

// Asks until both logins succeed. Resolves with the account file's content.
export async function askEmail({ prompter, previous = null, verify = verifyAccount }) {
  const out = (text) => prompter.write(text);
  out('\n── 邮箱 ──\n  只读收件箱（不会标已读、不移动、不删除）；回信要你确认后才发。\n');
  let last = previous;
  for (;;) {
    const address = (await prompter.text('邮箱地址', { initial: last?.address ?? '', validate: addressProblem })).toLowerCase();
    const provider = providerFor(address);
    const known = provider ? { imap: { host: provider.imap, port: 993 }, smtp: { host: provider.smtp, port: 465 } } : null;
    if (provider) out(`  ${provider.label}：密码处填${provider.password}，${provider.where}。\n`);
    else out('  不认识这个邮箱的服务器，需要手动填写；密码处填邮箱给第三方客户端用的专用密码（授权码），没有的话才是登录密码。\n');
    const hosts = known ?? await servers(prompter, address.split('@')[1], last?.address === address ? last : null);
    // A known provider's client password never has spaces; Gmail shows it in groups of four.
    const typed = await prompter.secret(provider?.password ?? '密码');
    const password = provider ? typed.replace(/\s+/g, '') : typed;
    const account = { address, password, ...hosts };
    out(`  正在登录 ${hosts.imap.host} 和 ${hosts.smtp.host}…\n`);
    try {
      const { idle } = await verify({ ...account, user: address });
      out(`  收信和发信都登录成功${idle ? '' : '（这个邮箱不推送新邮件，每分钟查一次）'}\n`);
      return account;
    } catch (error) {
      out(`  登录失败：${explain(error, provider)}\n`);
      last = account;
      if (!await prompter.confirm('重新输入？')) throw new PromptAborted();
    }
  }
}

// The account file is the only place the password lives: 0600, written whole.
export function writeEmailAccount(file, account) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(account, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

export function readEmailAccount(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value?.imap && value?.smtp ? value : null;
  } catch {
    return null;
  }
}

// Replies are approved on a Feishu card; another primary IM still gets notices.
export function emailChannelNote(channel) {
  return channel === 'lark' ? '' : '  主 IM 是微信：新邮件会通知到微信；回信暂时要在飞书卡片上确认，所以这个实例还不能回邮件。\n';
}
