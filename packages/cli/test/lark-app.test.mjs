import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { CALLBACKS, EVENTS, createApp, encodeAddons, inspectApp, missingScopes } from '../src/lark-app.mjs';

const SCOPES = { tenant: ['im:message:send_as_bot', 'im:message.group_msg'], user: ['search:message'] };

function decodeAddons(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(zlib.gunzipSync(Buffer.from(base64, 'base64')).toString('utf8'));
}

// A registration endpoint that answers begin, then each poll in turn.
function registrationServer(polls) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const params = Object.fromEntries(new URLSearchParams(init.body));
    calls.push({ url, params });
    const body = params.action === 'begin'
      ? { device_code: 'dev-1', verification_uri_complete: 'https://open.feishu.cn/page/launcher?user_code=ABCD', interval: 1, expires_in: 600 }
      : polls.shift();
    return { status: body.error ? 400 : 200, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
}

const instant = { sleep: async () => {} };

test('one scan creates the app: the QR link carries the full request, the poll returns the credentials', async () => {
  const { calls, fetchImpl } = registrationServer([
    { error: 'authorization_pending' },
    { error: 'slow_down' },
    { client_id: 'cli_new', client_secret: 'secret', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' } },
  ]);
  const shown = [];
  const statuses = [];
  const app = await createApp({
    name: 'Vika', description: 'desc', scopes: SCOPES, fetchImpl, ...instant,
    onQRCode: (qr) => shown.push(qr), onStatus: (status) => statuses.push(status),
  });
  assert.deepEqual(app, { appId: 'cli_new', appSecret: 'secret', brand: 'feishu', ownerOpenId: 'ou_owner' });
  assert.deepEqual(calls[0].params, {
    action: 'begin', archetype: 'PersonalAgent', auth_method: 'client_secret', request_user_info: 'open_id',
  });
  assert.equal(calls[0].url, 'https://accounts.feishu.cn/oauth/v1/app/registration');
  assert.ok(calls.slice(1).every(({ params }) => params.action === 'poll' && params.device_code === 'dev-1'));
  assert.deepEqual(statuses, ['slow_down']);

  const url = new URL(shown[0].url);
  assert.equal(url.searchParams.get('user_code'), 'ABCD');
  assert.equal(url.searchParams.get('createOnly'), 'true');
  assert.equal(url.searchParams.get('name'), 'Vika');
  assert.deepEqual(decodeAddons(url.searchParams.get('addons')), {
    scopes: SCOPES, events: { items: { tenant: EVENTS } }, callbacks: { items: CALLBACKS },
  });
});

test('a Lark tenant finishes on the Lark accounts host', async () => {
  const { calls, fetchImpl } = registrationServer([
    { error: 'authorization_pending', user_info: { tenant_brand: 'lark' } },
    { client_id: 'cli_lark', client_secret: 'secret', user_info: { open_id: 'ou_x', tenant_brand: 'lark' } },
  ]);
  const app = await createApp({ scopes: SCOPES, fetchImpl, ...instant, onQRCode() {} });
  assert.equal(app.brand, 'lark');
  assert.equal(calls.at(-1).url, 'https://accounts.larksuite.com/oauth/v1/app/registration');
});

test('a refused or expired scan fails with the platform reason', async () => {
  const denied = registrationServer([{ error: 'access_denied', error_description: 'user cancelled' }]);
  await assert.rejects(createApp({ scopes: SCOPES, fetchImpl: denied.fetchImpl, ...instant, onQRCode() {} }),
    { code: 'access_denied', message: 'user cancelled' });

  let clock = 0;
  const pending = registrationServer(Array.from({ length: 5 }, () => ({ error: 'authorization_pending' })));
  await assert.rejects(createApp({
    scopes: SCOPES, fetchImpl: pending.fetchImpl, onQRCode() {},
    now: () => clock, sleep: async () => { clock += 300_000; },
  }), { code: 'expired_token' });
});

test('encodes addons the way the platform expects: gzip, base64url, no padding', () => {
  const encoded = encodeAddons({ scopes: { tenant: ['a'], user: [] } });
  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.deepEqual(decodeAddons(encoded), { scopes: { tenant: ['a'], user: [] } });
});

test('reads back what the app was granted and names what is missing', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.authorization });
    if (url.endsWith('/tenant_access_token/internal')) return { json: async () => ({ code: 0, tenant_access_token: 't-1' }) };
    if (url.includes('/applications/me')) {
      return { json: async () => ({ code: 0, data: { app: {
        online_version_id: 'oav_1', unaudit_version_id: '',
        scopes: [{ scope: 'im:message:send_as_bot', token_types: ['tenant'] }, { scope: 'search:message', token_types: ['user'] }],
      } } }) };
    }
    return { json: async () => ({ code: 0, bot: { activate_status: 2, app_name: 'Vika' } }) };
  };
  const inspected = await inspectApp({ appId: 'cli_1', appSecret: 's', brand: 'feishu' }, { fetchImpl });
  assert.equal(inspected.online, true);
  assert.equal(inspected.pendingReview, false);
  assert.equal(inspected.botActive, true);
  assert.ok(calls.slice(1).every(({ auth }) => auth === 'Bearer t-1'));
  assert.deepEqual(missingScopes(SCOPES, inspected.granted), { tenant: ['im:message.group_msg'], user: [] });
});
