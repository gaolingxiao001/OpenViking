import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { LOCAL_OV_URL, detectOpenViking, writeInstanceOvConfig } from '../src/ov.mjs';
import { detectRuntimes, which } from '../src/runtimes.mjs';

function tempDir(t, prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function healthServer(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const answer = responses[url];
    if (!answer) throw new TypeError('fetch failed');
    return { ok: true, status: 200, json: async () => answer };
  };
  return { calls, fetchImpl };
}

test('OpenViking: the user config wins, its credentials prove who the user is', async (t) => {
  const home = tempDir(t, 'vika-ov-');
  fs.mkdirSync(path.join(home, '.openviking'));
  fs.writeFileSync(path.join(home, '.openviking', 'ovcli.conf'), JSON.stringify({
    url: 'https://ov.example', api_key: 'key-1', account: 'acme', plugin: { recall: true }, agent_id: 'legacy',
  }));
  const { calls, fetchImpl } = healthServer({
    'https://ov.example/health': { status: 'ok', auth_mode: 'api_key', user_id: 'amy', version: '0.4' },
  });
  const detected = await detectOpenViking({ env: {}, homeDir: home, fetchImpl });
  assert.deepEqual(detected, {
    configPath: path.join(home, '.openviking', 'ovcli.conf'), url: 'https://ov.example', usable: true,
    user: 'amy', authMode: 'api_key', reason: null,
  });
  assert.equal(calls[0].headers['X-API-Key'], 'key-1');
  assert.equal(calls[0].headers['X-OpenViking-Account'], 'acme');

  const target = path.join(home, '.vika', 'ov', 'primary.json');
  writeInstanceOvConfig({ detected, instanceId: 'primary', target });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), {
    url: 'https://ov.example', api_key: 'key-1', account: 'acme', plugin: { recall: true }, actor_peer_id: 'primary',
  });
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
});

test('OpenViking: a config whose server is down is reported, not offered', async (t) => {
  const home = tempDir(t, 'vika-ov-');
  const config = path.join(home, 'custom.conf');
  fs.writeFileSync(config, JSON.stringify({ url: 'https://down.example' }));
  const detected = await detectOpenViking({ env: { OPENVIKING_CLI_CONFIG_FILE: config }, homeDir: home, fetchImpl: healthServer({}).fetchImpl });
  assert.equal(detected.usable, false);
  assert.equal(detected.reason, 'unreachable');
});

test('OpenViking: without a config only a dev-mode local server is usable', async (t) => {
  const home = tempDir(t, 'vika-ov-');
  const dev = await detectOpenViking({ env: {}, homeDir: home, fetchImpl: healthServer({
    [`${LOCAL_OV_URL}/health`]: { status: 'ok', auth_mode: 'dev' },
  }).fetchImpl });
  assert.equal(dev.usable, true);
  const target = path.join(home, 'dev.json');
  writeInstanceOvConfig({ detected: dev, instanceId: 'primary', target });
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { url: LOCAL_OV_URL, actor_peer_id: 'primary' });

  const trusted = await detectOpenViking({ env: {}, homeDir: home, fetchImpl: healthServer({
    [`${LOCAL_OV_URL}/health`]: { status: 'ok', auth_mode: 'trusted' },
  }).fetchImpl });
  assert.equal(trusted.usable, false);
  assert.match(trusted.reason, /credentials/);
  assert.equal(await detectOpenViking({ env: {}, homeDir: home, fetchImpl: healthServer({}).fetchImpl }), null);
});

test('runtimes: installed and logged-in CLIs are offered, the rest say what is missing', async (t) => {
  const bin = tempDir(t, 'vika-bin-');
  for (const name of ['codex', 'claude']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(which('codex', { PATH: bin }), path.join(bin, 'codex'));
  assert.equal(which('traecli', { PATH: bin }), null);

  const execFileImpl = async (command, args) => {
    if (command.endsWith('codex')) return { stdout: 'Logged in using ChatGPT\n' };
    if (command.endsWith('claude')) return { stdout: JSON.stringify({ loggedIn: false }) };
    if (command === process.execPath && args.includes('--list-models')) {
      return { stdout: 'provider        model    context\nvolcengine-ark  ep-1     1M\n' };
    }
    throw new Error(`unexpected ${command}`);
  };
  const runtimes = await detectRuntimes({ env: { PATH: bin }, execFileImpl, piBin: '/managed/pi.js' });
  assert.deepEqual(runtimes.map(({ id, available, model }) => ({ id, available, model })), [
    { id: 'codex', available: true, model: 'codex:' },
    { id: 'claude', available: false, model: 'claude:' },
    { id: 'pi', available: true, model: 'pi' },
  ]);
  assert.equal(runtimes[0].bin, path.join(bin, 'codex'));
  assert.match(runtimes[1].note, /claude auth login/);
  assert.match(runtimes[2].note, /volcengine-ark\/ep-1/);
});

test('runtimes: a Pi with no model points the user at vika pi', async () => {
  const runtimes = await detectRuntimes({
    env: { PATH: '' }, piBin: '/managed/pi.js',
    execFileImpl: async () => ({ stdout: 'No models available.\n' }),
  });
  assert.deepEqual(runtimes.map(({ id, available }) => [id, available]), [['codex', false], ['claude', false], ['pi', false]]);
  assert.match(runtimes[2].note, /vika pi/);
});
