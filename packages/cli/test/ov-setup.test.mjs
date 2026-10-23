import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { configureOpenViking, discoverOpenViking, saveOVConnection } from '../src/ov-setup.mjs';
import { detectOpenViking, HOSTED_OV_URL, LOCAL_OV_URL, savedOVConfigPath } from '../src/ov.mjs';
import { Prompter } from '../src/prompt.mjs';
import { setLanguage } from '../src/i18n.mjs';

function fixture(t, answers) {
  setLanguage('en');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vika-ov-form-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const input = new PassThrough();
  input.end(answers.join('\n') + '\n');
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const prompter = new Prompter({ input, output });
  t.after(() => prompter.close());
  return { home, options: { prompter, env: { HOME: home }, homeDir: home }, text: () => text };
}

const remote = 'https://ov.example:9443';
function fetchOV({ local = false, key = 'test-secret', calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (url.startsWith(LOCAL_OV_URL)) {
      if (!local) throw new Error('offline');
      return Response.json({ status: 'ok', auth_mode: 'dev', result: [] });
    }
    assert.ok(url.startsWith(remote));
    if (url.endsWith('/health')) return Response.json({ status: 'ok', auth_mode: 'api_key' });
    return init.headers['X-API-Key'] === key
      ? Response.json({ status: 'ok', result: [] })
      : Response.json({ status: 'error', message: 'sensitive server details' }, { status: 401 });
  };
}

test('manual remote URL, custom port and hidden credentials are available when nothing is detected', async (t) => {
  const h = fixture(t, ['3', remote, '1', 'test-secret', 'team', 'owner', 'worker']);
  const calls = [];
  const result = await configureOpenViking({ ...h.options, fetchImpl: fetchOV({ calls }) });
  assert.deepEqual(result.config, { url: remote, api_key: 'test-secret', account: 'team', user: 'owner', agent: 'worker' });
  assert.equal(result.usable, true);
  assert.ok(calls.some(({ url, headers }) => url === `${remote}/api/v1/system/status`
    && headers['X-API-Key'] === 'test-secret' && headers['X-OpenViking-Account'] === 'team'));
  assert.match(h.text(), /Enter or edit the address and credentials/);
  assert.match(h.text(), /Choose an OV configuration file/);
  assert.doesNotMatch(h.text(), /test-secret|sensitive server details/);
  assert.deepEqual(fs.readdirSync(h.home), [], 'selecting a connection does not save it');
});

// The hosted service checks the key even on /health and reports the key's user.
function fetchHosted({ key = 'hosted-key', user = 'Vika-Nvidia', calls = [] } = {}) {
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    if (url.startsWith(LOCAL_OV_URL)) throw new Error('offline');
    assert.ok(url.startsWith(HOSTED_OV_URL));
    if (init.headers['X-API-Key'] !== key) return Response.json({ status: 'error', message: 'sensitive' }, { status: 401 });
    if (url.endsWith('/health')) return Response.json({ status: 'ok', auth_mode: 'api_key', user_id: user });
    return Response.json({ status: 'ok', result: { initialized: true, user } });
  };
}

test('the hosted service needs only an API key, and the instance keeps the user that key logs in as', async (t) => {
  const h = fixture(t, ['2', 'hosted-key']);
  const calls = [];
  const result = await configureOpenViking({ ...h.options, fetchImpl: fetchHosted({ calls }) });
  assert.deepEqual(result.config, { url: HOSTED_OV_URL, api_key: 'hosted-key', user: 'Vika-Nvidia' });
  assert.equal(result.user, 'Vika-Nvidia');
  assert.ok(calls.some(({ url }) => url === `${HOSTED_OV_URL}/api/v1/system/status`));
  assert.match(h.text(), /OpenViking Service on Volcengine\s+API key only/);
  assert.doesNotMatch(h.text(), /Account \(optional|hosted-key/);
});

test('a rejected hosted key says so and can be replaced', async (t) => {
  const h = fixture(t, ['2', 'wrong-key', '2', '2', 'hosted-key']);
  const result = await configureOpenViking({ ...h.options, fetchImpl: fetchHosted() });
  assert.equal(result.config.api_key, 'hosted-key');
  assert.match(h.text(), /OpenViking rejected the API key \(HTTP 401\)/);
  assert.match(h.text(), /Keep the configured key/);
  assert.doesNotMatch(h.text(), /wrong-key|hosted-key|sensitive/);
});

test('a manual connection to another server does not inherit the detected Account and User', async (t) => {
  const answers = ['3', remote, '1', 'test-secret', '', '', ''];
  for (const [form, expected] of [
    [answers, { url: remote, api_key: 'test-secret' }],
    // The same server keeps them, as defaults to confirm.
    [['3', '', '2', '', '', ''], { url: LOCAL_OV_URL, account: 'team', user: 'owner' }],
  ]) {
    const h = fixture(t, form);
    fs.mkdirSync(path.join(h.home, '.openviking'));
    fs.writeFileSync(path.join(h.home, '.openviking', 'ovcli.conf'), JSON.stringify({ url: LOCAL_OV_URL, account: 'team', user: 'owner' }));
    const local = fetchOV();
    const result = await configureOpenViking({ ...h.options, fetchImpl: async (url, init) => (url.startsWith(LOCAL_OV_URL)
      ? Response.json({ status: 'ok', auth_mode: 'trusted', result: [] })
      : local(url, init)) });
    assert.deepEqual(result.config, expected);
  }
});

test('an API key server replaces a stale configured identity with the one the key logs in as', async (t) => {
  const h = fixture(t, ['4', '~/remote.json']);
  fs.writeFileSync(path.join(h.home, 'remote.json'), JSON.stringify({ url: remote, api_key: 'test-secret', account: 'team', user: 'stale' }));
  const result = await configureOpenViking({ ...h.options, fetchImpl: async (url, init) => {
    if (url.startsWith(LOCAL_OV_URL)) throw new Error('offline');
    if (url.endsWith('/health')) return Response.json({ status: 'ok', auth_mode: 'api_key' });
    assert.equal(init.headers['X-API-Key'], 'test-secret');
    return Response.json({ status: 'ok', result: { initialized: true, user: 'amy' } });
  } });
  assert.deepEqual(result.config, { url: remote, api_key: 'test-secret', user: 'amy' });
  // Without a reported user nothing is guessed: the configured one is not shown as the key's.
  const unknown = await detectOpenViking({ env: h.options.env, homeDir: h.home, configPath: path.join(h.home, 'remote.json'),
    fetchImpl: async (url) => (url.endsWith('/health') ? Response.json({ status: 'ok', auth_mode: 'api_key' }) : Response.json({ status: 'ok', result: [] })) });
  assert.equal(unknown.user, null);
});

test('a healthy discovery still offers manual entry and accepts a different connection', async (t) => {
  const h = fixture(t, ['3', remote, '1', 'test-secret', '', '', '']);
  const result = await configureOpenViking({ ...h.options, fetchImpl: fetchOV({ local: true }) });
  assert.equal(result.url, remote);
  assert.match(h.text(), /Use the local default address \(no credentials\)\s+http:\/\/127\.0\.0\.1:1933 · ready/);
  assert.match(h.text(), /Enter or edit the address and credentials/);
});

test('discovery lists each config source once, with addresses and failed checks', async (t) => {
  const h = fixture(t, []);
  const preferred = path.join(h.home, 'instance.json');
  fs.writeFileSync(preferred, JSON.stringify({ url: remote, api_key: 'test-secret' }));
  fs.mkdirSync(path.join(h.home, '.openviking'));
  fs.writeFileSync(path.join(h.home, '.openviking', 'ovcli.conf'), JSON.stringify({ url: remote, api_key: 'wrong' }));
  const entries = await discoverOpenViking({ ...h.options, preferredConfigPath: preferred,
    env: { HOME: h.home, OPENVIKING_CLI_CONFIG_FILE: preferred },
    fetchImpl: fetchOV() });
  assert.equal(entries.length, 3);
  assert.deepEqual(entries.map(({ usable }) => usable), [true, false, false]);
  assert.equal(entries[0].url, remote);
});

test('a shared config the instance already copied is not offered again; one that would change something is', async (t) => {
  const h = fixture(t, []);
  const shared = { url: remote, api_key: 'test-secret', account: 'team', user: 'owner', plugin: { recall: false } };
  const current = path.join(h.home, 'asd.json');
  fs.writeFileSync(current, JSON.stringify({ ...shared, url: `${remote}/`, actor_peer_id: 'asd' }));
  fs.mkdirSync(path.join(h.home, '.openviking'));
  const cli = path.join(h.home, '.openviking', 'ovcli.conf');
  fs.writeFileSync(cli, JSON.stringify(shared));
  const labels = async () => (await discoverOpenViking({ ...h.options, preferredConfigPath: current, fetchImpl: fetchOV() }))
    .map(({ label }) => label);
  assert.deepEqual(await labels(), ['Keep the current connection', 'Use the local default address (no credentials)']);
  fs.writeFileSync(cli, JSON.stringify({ ...shared, plugin: { recall: true } }));
  assert.deepEqual(await labels(), ['Keep the current connection', 'Use the OpenViking CLI’s config', 'Use the local default address (no credentials)']);
});

test('the menu says where each connection goes, who it logs in as, or why it cannot be used', async (t) => {
  const h = fixture(t, ['1']);
  fs.mkdirSync(path.join(h.home, '.openviking'));
  fs.writeFileSync(path.join(h.home, '.openviking', 'ovcli.conf'), JSON.stringify({ url: remote, api_key: 'wrong' }));
  fs.mkdirSync(path.dirname(savedOVConfigPath(h.home)), { recursive: true });
  fs.writeFileSync(savedOVConfigPath(h.home), JSON.stringify({ url: remote, api_key: 'test-secret' }));
  const result = await configureOpenViking({ ...h.options, fetchImpl: async (url, init) => {
    if (url.startsWith(LOCAL_OV_URL)) throw new Error('offline');
    if (url.endsWith('/health')) return Response.json({ status: 'ok', auth_mode: 'api_key' });
    return init.headers['X-API-Key'] === 'test-secret'
      ? Response.json({ status: 'ok', result: { initialized: true, user: 'amy' } })
      : Response.json({ status: 'error' }, { status: 401 });
  } });
  assert.equal(result.user, 'amy');
  const menu = h.text();
  assert.match(menu, /1\) Use the connection entered in setup last time\s+https:\/\/ov\.example:9443 · user=amy · ready/);
  assert.match(menu, /2\) Use the OpenViking CLI’s config\s+https:\/\/ov\.example:9443 · OpenViking is running, but authentication .*HTTP 401/);
  assert.match(menu, /3\) Use the local default address \(no credentials\)\s+http:\/\/127\.0\.0\.1:1933 · OpenViking is unavailable/);
  assert.doesNotMatch(menu, /ovcli\.conf|ov-connection\.json|test-secret|wrong/, 'paths and keys stay off the menu');
});

test('a configured local connection is checked with its identity without an anonymous duplicate', async (t) => {
  const h = fixture(t, ['1']);
  fs.mkdirSync(path.join(h.home, '.openviking'));
  const config = { url: `${LOCAL_OV_URL}/`, account: 'team', user: 'owner' };
  fs.writeFileSync(path.join(h.home, '.openviking', 'ovcli.conf'), JSON.stringify(config));
  const calls = [];
  const result = await configureOpenViking({ ...h.options, fetchImpl: async (url, init) => {
    calls.push(url);
    assert.equal(init.headers['X-OpenViking-Account'], 'team');
    assert.equal(init.headers['X-OpenViking-User'], 'owner');
    return Response.json({ status: 'ok', auth_mode: 'trusted', result: [] });
  } });
  assert.equal(result.usable, true);
  assert.equal(calls.length, 4, 'discovery and the selected config each check health and identity');
  assert.match(h.text(), /Use the OpenViking CLI’s config\s+http:\/\/127\.0\.0\.1:1933 · user=owner · ready/);
  assert.doesNotMatch(h.text(), /local default address|HTTP 400/);
  assert.match(h.text(), /Enter or edit the address and credentials/);
});

test('an unconfigured Trusted server is shown as running and can be completed manually', async (t) => {
  const h = fixture(t, ['3', '', '2', 'team', 'owner', '']);
  const result = await configureOpenViking({ ...h.options, fetchImpl: async (url, init) => {
    if (url.endsWith('/health')) return Response.json({ status: 'ok', auth_mode: 'trusted' });
    return init.headers['X-OpenViking-Account'] && init.headers['X-OpenViking-User']
      ? Response.json({ status: 'ok', result: [] })
      : Response.json({ status: 'error', message: 'private server details' }, { status: 400 });
  } });
  assert.equal(result.usable, true);
  assert.deepEqual(result.config, { url: LOCAL_OV_URL, account: 'team', user: 'owner' });
  assert.match(h.text(), /OpenViking is running; Trusted mode requires Account and User/);
  assert.doesNotMatch(h.text(), /unavailable|HTTP 400|private server details/);
});

test('failed credentials can be edited and retried without leaking keys or server bodies', async (t) => {
  const h = fixture(t, ['3', remote, '1', 'wrong-secret', '', '', '',
    '3', '', '2', 'test-secret', '', '', '']);
  const result = await configureOpenViking({ ...h.options, fetchImpl: fetchOV() });
  assert.equal(result.usable, true);
  assert.match(h.text(), /HTTP 401/);
  assert.doesNotMatch(h.text(), /wrong-secret|test-secret|sensitive server details/);
});

test('a configuration file can be imported after an invalid path; cancellation saves nothing', async (t) => {
  const h = fixture(t, ['4', '~/missing.json', '4', '~/remote.json']);
  fs.writeFileSync(path.join(h.home, 'remote.json'), JSON.stringify({ url: remote, api_key: 'test-secret', plugin: { memory: true } }));
  const result = await configureOpenViking({ ...h.options, fetchImpl: fetchOV() });
  assert.equal(result.configPath, path.join(h.home, 'remote.json'));
  assert.deepEqual(result.config.plugin, { memory: true });
  assert.match(h.text(), /Cannot read the OV configuration/);
  const cancel = fixture(t, ['6']);
  await assert.rejects(configureOpenViking({ ...cancel.options, fetchImpl: fetchOV() }), { name: 'PromptAborted' });
  assert.deepEqual(fs.readdirSync(cancel.home), []);
});

test('a typed connection is kept privately for the next instance; a file new instances find anyway is not copied', async (t) => {
  const h = fixture(t, []);
  const saved = saveOVConnection({ usable: true, configPath: null, config: {
    url: remote, api_key: 'test-secret', account: 'team', user: 'owner', actor_peer_id: 'primary', agent_id: 'old',
  } }, h.options);
  assert.equal(saved, savedOVConfigPath(h.home));
  assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(saved, 'utf8')), { url: remote, api_key: 'test-secret', account: 'team', user: 'owner' });
  const detected = await detectOpenViking({ env: h.options.env, homeDir: h.home, fetchImpl: fetchOV() });
  assert.equal(detected.configPath, saved);
  assert.equal(detected.usable, true);

  const cli = path.join(h.home, '.openviking', 'ovcli.conf');
  fs.mkdirSync(path.dirname(cli));
  fs.writeFileSync(cli, JSON.stringify({ url: remote, api_key: 'rotated' }));
  const before = fs.readFileSync(saved, 'utf8');
  assert.equal(saveOVConnection({ usable: true, configPath: cli }, h.options), null);
  assert.equal(fs.readFileSync(saved, 'utf8'), before, 'a copy of ovcli.conf would go stale when its key rotates');
});
