import zlib from 'node:zlib';

// Create a Feishu/Lark bot app by QR scan, then read back what it was
// granted. This is the device flow of the official app registration endpoint
// (the one @larksuiteoapi/node-sdk's registerApp wraps), written against
// fetch so Vika needs no SDK. One scan creates, configures and publishes the
// app; the platform drops unknown scope names silently, so the caller must
// compare the granted scopes with the request.

const FEISHU_ACCOUNTS = 'https://accounts.feishu.cn';
const LARK_ACCOUNTS = 'https://accounts.larksuite.com';
const REGISTRATION_PATH = '/oauth/v1/app/registration';
const SOURCE = 'node-sdk/vika';

export const EVENTS = Object.freeze(['im.message.receive_v1']);
export const CALLBACKS = Object.freeze(['card.action.trigger']);

export class LarkRegistrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LarkRegistrationError';
    this.code = code;
  }
}

// Fixed by the platform: JSON -> gzip -> base64url without padding.
export function encodeAddons(addons) {
  return zlib.gzipSync(Buffer.from(JSON.stringify(addons), 'utf8')).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function openApiBase(brand) {
  return brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

async function registration(fetchImpl, base, params) {
  const response = await fetchImpl(`${base}${REGISTRATION_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(15_000),
  });
  // RFC 8628: pending, slow_down and failures come back as HTTP 400 with a JSON body.
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new LarkRegistrationError('invalid_response', `app registration returned HTTP ${response.status} without JSON`);
  }
}

// scopes: { tenant: [...], user: [...] }. onQRCode({ url, expiresIn }) shows
// the code. Resolves with { appId, appSecret, brand, ownerOpenId }.
export async function createApp({
  name,
  description,
  scopes,
  onQRCode,
  onStatus = () => {},
  // Every poll answer, for progress and VIKA_DEBUG; the secret is never in it.
  onPoll = () => {},
  signal = null,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now = () => Date.now(),
}) {
  let base = FEISHU_ACCOUNTS;
  const begin = await registration(fetchImpl, base, {
    action: 'begin',
    archetype: 'PersonalAgent',
    auth_method: 'client_secret',
    request_user_info: 'open_id',
  });
  if (!begin.device_code || !begin.verification_uri_complete) {
    throw new LarkRegistrationError(begin.error ?? 'begin_failed', begin.error_description ?? 'app registration did not start');
  }
  const url = new URL(begin.verification_uri_complete);
  url.searchParams.set('from', 'sdk');
  url.searchParams.set('source', SOURCE);
  url.searchParams.set('tp', 'sdk');
  if (name) url.searchParams.set('name', name);
  if (description) url.searchParams.set('desc', description);
  url.searchParams.set('addons', encodeAddons({
    scopes: { tenant: [...scopes.tenant], user: [...scopes.user] },
    events: { items: { tenant: [...EVENTS] } },
    callbacks: { items: [...CALLBACKS] },
  }));
  url.searchParams.set('createOnly', 'true');
  const expiresIn = begin.expires_in ?? 600;
  onQRCode({ url: url.toString(), expiresIn });

  const deadline = now() + expiresIn * 1000;
  let interval = (begin.interval ?? 5) * 1000;
  let switched = false;
  while (now() < deadline) {
    await sleep(interval);
    if (signal?.aborted) throw new LarkRegistrationError('aborted', 'app registration was abandoned');
    const poll = await registration(fetchImpl, base, { action: 'poll', device_code: begin.device_code });
    onPoll({ ...poll, ...(poll.client_secret ? { client_secret: '***' } : {}) });
    // A Lark (international) tenant finishes on the Lark accounts host.
    if (poll.user_info?.tenant_brand === 'lark' && !switched) {
      base = LARK_ACCOUNTS;
      switched = true;
      onStatus('domain_switched');
      continue;
    }
    if (poll.client_id && poll.client_secret) {
      return {
        appId: poll.client_id,
        appSecret: poll.client_secret,
        brand: poll.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu',
        ownerOpenId: poll.user_info?.open_id ?? null,
      };
    }
    if (poll.error === 'authorization_pending') continue;
    if (poll.error === 'slow_down') {
      interval += 5_000;
      onStatus('slow_down');
      continue;
    }
    throw new LarkRegistrationError(poll.error ?? 'unknown', poll.error_description ?? 'app registration failed');
  }
  throw new LarkRegistrationError('expired_token', 'the QR code expired before it was confirmed');
}

async function openApi(fetchImpl, brand, token, pathname) {
  const response = await fetchImpl(`${openApiBase(brand)}${pathname}`, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return response.json().catch(() => ({ code: -1, msg: `HTTP ${response.status} without JSON` }));
}

// What the new app actually got: online version, bot, and granted scopes.
export async function inspectApp({ appId, appSecret, brand }, { fetchImpl = globalThis.fetch } = {}) {
  const tokenResponse = await fetchImpl(`${openApiBase(brand)}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const token = await tokenResponse.json();
  if (token.code !== 0) throw new Error(`tenant_access_token failed: code=${token.code} ${token.msg ?? ''}`.trim());
  const info = await openApi(fetchImpl, brand, token.tenant_access_token, '/open-apis/application/v6/applications/me?lang=zh_cn');
  const bot = await openApi(fetchImpl, brand, token.tenant_access_token, '/open-apis/bot/v3/info');
  const app = info.data?.app;
  if (info.code !== 0 || !app) throw new Error(`reading the app failed: code=${info.code} ${info.msg ?? ''}`.trim());
  return {
    online: Boolean(app.online_version_id),
    pendingReview: Boolean(app.unaudit_version_id),
    botActive: bot.code === 0 && bot.bot?.activate_status === 2,
    botName: bot.bot?.app_name ?? null,
    granted: (app.scopes ?? []).map(({ scope, token_types: tokenTypes }) => ({ scope, tokenTypes: tokenTypes ?? [] })),
  };
}

// Requested scopes the platform did not grant, per token type.
export function missingScopes(scopes, granted) {
  const has = (scope, type) => granted.some((entry) => entry.scope === scope && entry.tokenTypes.includes(type));
  return {
    tenant: scopes.tenant.filter((scope) => !has(scope, 'tenant')),
    user: scopes.user.filter((scope) => !has(scope, 'user')),
  };
}
