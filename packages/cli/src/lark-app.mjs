import { registerApp } from '@larksuiteoapi/node-sdk';

// Create a Feishu/Lark bot app by QR scan, then read back what it was
// granted. Creation goes through the official SDK's registerApp (the device
// flow of the app registration endpoint): a hand-written client of the same
// endpoint saw every scan create the app while its poll stayed "pending", so
// the SDK's own HTTP client is the one that is known to complete. One scan
// creates, configures and publishes the app; the platform drops unknown scope
// names silently, so the caller compares the granted scopes with the request.

export const EVENTS = Object.freeze(['im.message.receive_v1']);
export const CALLBACKS = Object.freeze(['card.action.trigger']);

export class LarkRegistrationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LarkRegistrationError';
    this.code = code;
  }
}

export function openApiBase(brand) {
  return brand === 'lark' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

// scopes: { tenant: [...], user: [...] }. onQRCode({ url, expiresIn }) shows
// the code; onStatus gets polling / slow_down / domain_switched. Resolves with
// { appId, appSecret, brand, ownerOpenId }.
export async function createApp({
  name,
  description,
  scopes,
  onQRCode,
  onStatus = () => {},
  signal = undefined,
  register = registerApp,
}) {
  let result;
  try {
    result = await register({
      source: 'vika',
      createOnly: true,
      appPreset: { ...(name ? { name } : {}), ...(description ? { desc: description } : {}) },
      addons: {
        scopes: { tenant: [...scopes.tenant], user: [...scopes.user] },
        events: { items: { tenant: [...EVENTS] } },
        callbacks: { items: [...CALLBACKS] },
      },
      signal,
      onQRCodeReady: ({ url, expireIn }) => onQRCode({ url, expiresIn: expireIn }),
      onStatusChange: ({ status }) => onStatus(status),
    });
  } catch (error) {
    // The SDK rejects with a plain { code, description } for platform outcomes.
    if (error instanceof Error) throw error;
    throw new LarkRegistrationError(error?.code ?? 'unknown', error?.description ?? 'app registration failed');
  }
  if (!result?.client_id || !result?.client_secret) {
    throw new LarkRegistrationError('invalid_response', 'app registration returned no credentials');
  }
  return {
    appId: result.client_id,
    appSecret: result.client_secret,
    brand: result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu',
    ownerOpenId: result.user_info?.open_id ?? null,
  };
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
