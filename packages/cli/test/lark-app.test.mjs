import assert from 'node:assert/strict';
import test from 'node:test';
import { CALLBACKS, EVENTS, createApp, inspectApp, missingScopes } from '../src/lark-app.mjs';

const SCOPES = { tenant: ['im:message:send_as_bot', 'im:message.group_msg'], user: ['search:message'] };

test('one scan creates the app through the official SDK, with the full request', async () => {
  let options;
  const statuses = [];
  const shown = [];
  const app = await createApp({
    name: 'Vika', description: 'desc', scopes: SCOPES,
    onQRCode: (qr) => shown.push(qr), onStatus: (status) => statuses.push(status),
    register: async (given) => {
      options = given;
      given.onQRCodeReady({ url: 'https://open.feishu.cn/page/launcher?user_code=A', expireIn: 3600 });
      given.onStatusChange({ status: 'polling' });
      return { client_id: 'cli_new', client_secret: 'secret', user_info: { open_id: 'ou_owner', tenant_brand: 'feishu' } };
    },
  });
  assert.deepEqual(app, { appId: 'cli_new', appSecret: 'secret', brand: 'feishu', ownerOpenId: 'ou_owner' });
  assert.equal(options.source, 'vika');
  assert.equal(options.createOnly, true);
  assert.deepEqual(options.appPreset, { name: 'Vika', desc: 'desc' });
  assert.deepEqual(options.addons, { scopes: SCOPES, events: { items: { tenant: EVENTS } }, callbacks: { items: CALLBACKS } });
  assert.deepEqual(shown, [{ url: 'https://open.feishu.cn/page/launcher?user_code=A', expiresIn: 3600 }]);
  assert.deepEqual(statuses, ['polling']);
});

test('a Lark tenant is recognised, and platform refusals keep their code', async () => {
  const lark = await createApp({ scopes: SCOPES, onQRCode() {},
    register: async () => ({ client_id: 'cli_lark', client_secret: 's', user_info: { tenant_brand: 'lark' } }) });
  assert.equal(lark.brand, 'lark');
  await assert.rejects(createApp({ scopes: SCOPES, onQRCode() {},
    register: async () => { throw { code: 'access_denied', description: 'user cancelled' }; } }),
  { name: 'LarkRegistrationError', code: 'access_denied', message: 'user cancelled' });
  await assert.rejects(createApp({ scopes: SCOPES, onQRCode() {}, register: async () => ({ client_id: 'cli_x' }) }),
    { code: 'invalid_response' });
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
