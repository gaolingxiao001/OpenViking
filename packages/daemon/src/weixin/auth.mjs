import { fetchLoginQr, pollLoginQr, DEFAULT_WEIXIN_API_BASE_URL } from './api.mjs';

const LOGIN_TIMEOUT_MS = 8 * 60_000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function readLine(prompt) {
  process.stdout.write(prompt);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let input = '';
    const onData = (chunk) => {
      input += chunk;
      const index = input.indexOf('\n');
      if (index < 0) return;
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(input.slice(0, index).trim());
    };
    process.stdin.on('data', onData);
  });
}

async function displayQr(value) {
  try {
    const module = await import('qrcode-terminal');
    const qr = module.default ?? module;
    qr.generate(value, { small: true });
  } catch {
    process.stdout.write('终端二维码组件不可用，请打开下面的链接后扫码。\n');
  }
  process.stdout.write(`${value}\n`);
}

function redirectedBaseUrl(host) {
  if (typeof host !== 'string' || !host.trim()) return null;
  const candidate = host.includes('://') ? host : `https://${host}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== 'https:') throw new Error('Weixin login redirect must use HTTPS');
  return parsed.origin;
}

export async function loginWeixin({ state, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const existing = state.account();
  let apiBaseUrl = existing?.baseUrl || DEFAULT_WEIXIN_API_BASE_URL;
  let qr = await fetchLoginQr({ localTokens: existing?.token ? [existing.token] : [] });
  if (!qr?.qrcode || !qr?.qrcode_img_content) throw new Error('Weixin QR endpoint returned no QR code');
  process.stdout.write('用手机微信扫描以下二维码并确认授权：\n');
  await displayQr(qr.qrcode_img_content);

  const deadline = Date.now() + timeoutMs;
  let scanned = false;
  let verifyCode = null;
  while (Date.now() < deadline) {
    const status = await pollLoginQr({ qrcode: qr.qrcode, verifyCode, apiBaseUrl });
    verifyCode = null;
    if (status.status === 'wait') {
      await delay(1_000);
      continue;
    }
    if (status.status === 'scaned') {
      if (!scanned) process.stdout.write('已扫码，请在手机上确认。\n');
      scanned = true;
      await delay(1_000);
      continue;
    }
    if (status.status === 'need_verifycode') {
      verifyCode = await readLine('请输入微信显示的验证码：');
      if (!/^\d{4,8}$/.test(verifyCode)) throw new Error('验证码格式无效');
      continue;
    }
    if (status.status === 'verify_code_blocked') {
      throw new Error('验证码错误次数过多，请稍后重新扫码');
    }
    if (status.status === 'scaned_but_redirect') {
      apiBaseUrl = redirectedBaseUrl(status.redirect_host) ?? apiBaseUrl;
      await delay(1_000);
      continue;
    }
    if (status.status === 'expired') {
      qr = await fetchLoginQr({ localTokens: existing?.token ? [existing.token] : [] });
      if (!qr?.qrcode || !qr?.qrcode_img_content) throw new Error('Weixin QR refresh returned no QR code');
      scanned = false;
      process.stdout.write('二维码已刷新，请重新扫码：\n');
      await displayQr(qr.qrcode_img_content);
      continue;
    }
    if (status.status === 'binded_redirect') {
      if (!existing?.token) throw new Error('微信端显示已绑定，但本地没有可用凭证');
      process.stdout.write(`本地已有微信账号 ${existing.accountId} 的凭证，无需重复绑定。\n`);
      return existing;
    }
    if (status.status === 'confirmed') {
      if (!status.bot_token || !status.ilink_bot_id) {
        throw new Error('Weixin login confirmation did not include account credentials');
      }
      const account = state.saveAccount({
        accountId: status.ilink_bot_id,
        token: status.bot_token,
        baseUrl: status.baseurl || apiBaseUrl,
        userId: status.ilink_user_id || null,
      });
      process.stdout.write(`微信连接成功：${account.accountId}\n`);
      return account;
    }
    throw new Error(`Unsupported Weixin login status: ${status.status ?? 'unknown'}`);
  }
  throw new Error('微信扫码登录超时，请重新执行登录命令');
}
