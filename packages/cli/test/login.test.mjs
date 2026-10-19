import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { loginCommand } from '../src/login.mjs';
import { Prompter } from '../src/prompt.mjs';

function agent(home, id, overrides = {}) {
  return {
    id, displayName: id.toUpperCase(), channel: 'lark', connectors: ['lark'], profile: `vika-${id}`,
    port: 3738, dataDir: path.join(home, '.vika', 'data', id), workspace: path.join(home, 'ws', id), model: 'codex:',
    ...overrides,
  };
}

function machine(t, agents, { answers = [], tty = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vika-login-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const list = agents(home);
  if (list.length) {
    fs.mkdirSync(path.join(home, '.vika'), { recursive: true });
    fs.writeFileSync(path.join(home, '.vika', 'config.json'),
      JSON.stringify({ version: 1, defaultInstance: list[0].id, env: {}, agents: list }));
  }
  const input = new PassThrough();
  if (tty) { input.isTTY = true; input.setRawMode = () => {}; } else input.end(answers.map((line) => `${line}\n`).join(''));
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  const calls = [];
  const options = {
    prompter: new Prompter({ input, output }),
    env: { HOME: home, PATH: '', LARK_CLI_BIN: '/opt/lark-cli' },
    connect: {
      weixin: async ({ plan }) => { calls.push(['weixin', plan.id]); },
      email: async ({ fixed, taken }) => { calls.push(['email', fixed?.address ?? null, taken]); return { ...fixed, password: 'new' }; },
    },
    control: { restart: async (id) => { calls.push(['restart', id]); } },
  };
  const manifest = () => JSON.parse(fs.readFileSync(path.join(home, '.vika', 'config.json'), 'utf8'));
  return { home, input, options, calls, written: () => written, manifest };
}

test('login renews what an instance has; connecting a new IM is setup\'s', async (t) => {
  const m = machine(t, (home) => [agent(home, 'haha', { channel: 'weixin', connectors: ['weixin'], profile: undefined })]);
  const before = fs.readFileSync(path.join(m.home, '.vika', 'config.json'), 'utf8');
  assert.equal(await loginCommand(['weixin'], m.options), 0);
  assert.deepEqual(m.calls, [['weixin', 'haha']]);
  // A new login is a new conversation: the owner writes first again.
  assert.match(m.written(), /最后一步：在微信里先给机器人发一句话/);
  assert.equal(fs.readFileSync(path.join(m.home, '.vika', 'config.json'), 'utf8'), before, 'the manifest is untouched');

  await assert.rejects(loginCommand(['lark'], m.options), /还没有实例接飞书；要接入，运行 vika setup 修改实例/);
  await assert.rejects(loginCommand(['email', 'haha'], m.options), /实例 haha 没有接邮箱；要接入，运行 vika setup，选择修改 haha/);
});

test('a mailbox password is renewed for the mailbox chosen, and the instance restarts', async (t) => {
  const file = (home, id) => path.join(home, '.vika', 'email', 'wx', `${id}.json`);
  const m = machine(t, (home) => {
    for (const [id, address] of [['email-gmail', 'me@gmail.com'], ['email-qq', 'me@qq.com']]) {
      fs.mkdirSync(path.dirname(file(home, id)), { recursive: true });
      fs.writeFileSync(file(home, id), JSON.stringify({ address, password: 'old', imap: { host: 'i', port: 993 }, smtp: { host: 's', port: 465 } }), { mode: 0o600 });
    }
    return [agent(home, 'wx', { channel: 'weixin', connectors: ['weixin', 'email'], profile: undefined,
      emailAccounts: [{ id: 'email-gmail', config: file(home, 'email-gmail') }, { id: 'email-qq', config: file(home, 'email-qq') }] })];
  }, { answers: ['2'] });
  assert.equal(await loginCommand(['email'], m.options), 0);
  assert.deepEqual(m.calls, [['email', 'me@qq.com', ['me@gmail.com']], ['restart', 'wx']]);
  assert.equal(JSON.parse(fs.readFileSync(file(m.home, 'email-qq'), 'utf8')).password, 'new');
  assert.equal(JSON.parse(fs.readFileSync(file(m.home, 'email-gmail'), 'utf8')).password, 'old');
  assert.match(m.written(), /更新哪个邮箱的密码[\s\S]*的邮箱 me@qq\.com 已更新/);
});

test('with several instances it asks which one, among those that have the IM', async (t) => {
  const three = (home) => [agent(home, 'alpha', { channel: 'weixin', connectors: ['weixin'], profile: undefined }),
    agent(home, 'beta', { port: 3739 }), agent(home, 'gamma', { port: 3740, channel: 'weixin', connectors: ['weixin'], profile: undefined })];
  const piped = machine(t, three);
  await assert.rejects(loginCommand(['weixin'], piped.options), /有多个实例[\s\S]*alpha\s+ALPHA\s+微信[\s\S]*gamma/);
  await assert.rejects(loginCommand(['weixin', 'delta'], piped.options), /没有叫 delta 的实例/);
  assert.deepEqual(piped.calls, []);

  const terminal = machine(t, three, { tty: true });
  setTimeout(() => terminal.input.write('\x1b[B\r'), 20);
  assert.equal(await loginCommand(['weixin'], terminal.options), 0);
  assert.deepEqual(terminal.calls[0], ['weixin', 'gamma'], 'beta has no Weixin, so the second choice is gamma');
});

test('usage, and nothing to renew before setup', async (t) => {
  const empty = machine(t, () => []);
  await assert.rejects(loginCommand(['weixin'], empty.options), /先运行 vika setup/);
  assert.equal(await loginCommand(['setup'], empty.options), 2);
  assert.match(empty.written(), /用法：vika login <lark\|weixin\|email\|telegram> \[实例\]\n  登录过期或改了密码后重新授权；要接入新的 IM，运行 vika setup 修改实例/);
});

test('Telegram login stops the poller before verification and restarts with the new key', async (t) => {
  const m = machine(t, (home) => [agent(home, 'wa', { channel: 'telegram', connectors: ['telegram'], profile: undefined })]);
  m.options.control.stop = async (id) => { m.calls.push(['stop', id]); };
  m.options.connect.telegram = async ({ plan }) => { m.calls.push(['telegram', plan.id]); };
  assert.equal(await loginCommand(['telegram'], m.options), 0);
  assert.deepEqual(m.calls, [['stop', 'wa'], ['telegram', 'wa'], ['restart', 'wa']]);
});

test('failed Telegram verification resumes the existing instance and reports the failure', async (t) => {
  const m = machine(t, (home) => [agent(home, 'wa', { channel: 'telegram', connectors: ['telegram'], profile: undefined })]);
  m.options.control.stop = async (id) => { m.calls.push(['stop', id]); };
  m.options.connect.telegram = async () => { throw new Error('invalid API key'); };
  await assert.rejects(loginCommand(['telegram'], m.options), /invalid API key/);
  assert.deepEqual(m.calls, [['stop', 'wa'], ['restart', 'wa']]);
});
