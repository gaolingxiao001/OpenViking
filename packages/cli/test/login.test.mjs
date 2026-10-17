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

function machine(t, agents, { answers = [], tty = false, mailboxes = [] } = {}) {
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
      lark: async ({ plan, profile }) => { calls.push(['lark', plan.id, profile]); return { profile, ownerOpenId: 'ou_owner' }; },
      weixin: async ({ plan }) => { calls.push(['weixin', plan.id, plan.dataDir]); },
      email: async ({ fixed, taken }) => {
        calls.push(['email', fixed?.address ?? null, taken]);
        return fixed ? { ...fixed, password: 'new' }
          : { address: mailboxes.shift(), password: 'p', imap: { host: 'imap.x.com', port: 993 }, smtp: { host: 'smtp.x.com', port: 465 } };
      },
      greet: async ({ userId }) => { calls.push(['greet', userId]); },
    },
    control: { restart: async (id) => { calls.push(['restart', id]); } },
  };
  const manifest = () => JSON.parse(fs.readFileSync(path.join(home, '.vika', 'config.json'), 'utf8'));
  return { home, input, options, calls, written: () => written, manifest };
}

test('Weixin added later: the only instance is used without naming it, then restarted with it', async (t) => {
  const m = machine(t, (home) => [agent(home, 'haha')]);
  assert.equal(await loginCommand(['weixin'], m.options), 0);
  assert.deepEqual(m.calls, [['weixin', 'haha', path.join(m.home, '.vika', 'data', 'haha')], ['restart', 'haha']]);
  const [updated] = m.manifest().agents;
  assert.deepEqual(updated.connectors, ['lark', 'weixin']);
  assert.equal(updated.channel, 'lark', 'the primary IM stays');
  assert.match(m.written(), /还没有接微信，现在接入/);

  // The second time it is a new login, not another connector.
  m.calls.length = 0;
  assert.equal(await loginCommand(['weixin'], m.options), 0);
  assert.deepEqual(m.calls, [['weixin', 'haha', path.join(m.home, '.vika', 'data', 'haha')]]);
  assert.deepEqual(m.manifest().agents[0].connectors, ['lark', 'weixin']);
});

test('Feishu added to a Weixin-only instance gets its own app, profile and a greeting', async (t) => {
  const m = machine(t, (home) => [agent(home, 'wx', { channel: 'weixin', connectors: ['weixin'], profile: undefined })]);
  assert.equal(await loginCommand(['lark', 'wx'], m.options), 0);
  assert.deepEqual(m.calls, [['lark', 'wx', 'vika-wx'], ['restart', 'wx'], ['greet', 'ou_owner']]);
  const [updated] = m.manifest().agents;
  assert.deepEqual([updated.connectors, updated.profile, updated.channel], [['weixin', 'lark'], 'vika-wx', 'weixin']);
});

test('mailboxes are added one by one, each in its own private file, and can be updated or removed', async (t) => {
  //                                                          add  update qq  remove qq  yes  remove 163  yes
  const m = machine(t, (home) => [agent(home, 'wx', { channel: 'weixin', connectors: ['weixin'], profile: undefined })],
    { mailboxes: ['1845679308@qq.com', 'l13241789920@163.com'], answers: ['1', '2', '4', 'y', '3', 'y'] });
  const file = (id) => path.join(m.home, '.vika', 'email', 'wx', `${id}.json`);
  const mailboxes = () => m.manifest().agents[0].emailAccounts;

  assert.equal(await loginCommand(['email'], m.options), 0);
  assert.deepEqual(m.calls, [['email', null, []], ['restart', 'wx']]);
  const [updated] = m.manifest().agents;
  assert.deepEqual([updated.connectors, updated.channel], [['weixin', 'email'], 'weixin']);
  assert.deepEqual(mailboxes(), [{ id: 'email-qq', config: file('email-qq') }]);
  assert.equal(fs.statSync(file('email-qq')).mode & 0o777, 0o600);
  // Replies are approved on a Feishu card, which a Weixin instance cannot show.
  assert.match(m.written(), /主 IM 是微信[\s\S]*还不能回邮件/);

  m.calls.length = 0;
  assert.equal(await loginCommand(['email'], m.options), 0);
  assert.deepEqual(m.calls, [['email', null, ['1845679308@qq.com']], ['restart', 'wx']]);
  assert.deepEqual(mailboxes().map(({ id }) => id), ['email-qq', 'email-163']);
  assert.match(m.written(), /已接入 1 个邮箱：1845679308@qq\.com[\s\S]*已接入邮箱 l13241789920@163\.com（email-163）/);

  // A new password for one mailbox asks for nothing else.
  m.calls.length = 0;
  assert.equal(await loginCommand(['email', 'wx'], m.options), 0);
  assert.deepEqual(m.calls, [['email', '1845679308@qq.com', ['l13241789920@163.com']], ['restart', 'wx']]);
  assert.equal(JSON.parse(fs.readFileSync(file('email-qq'), 'utf8')).password, 'new');

  assert.equal(await loginCommand(['email'], m.options), 0);
  assert.deepEqual(mailboxes(), [{ id: 'email-163', config: file('email-163') }]);
  assert.equal(fs.existsSync(file('email-qq')), false, 'the removed password is deleted');

  // The last one removed disconnects email altogether.
  assert.equal(await loginCommand(['email'], m.options), 0);
  assert.deepEqual([m.manifest().agents[0].connectors, m.manifest().agents[0].emailAccounts], [['weixin'], undefined]);
});

test('with several instances it asks which one, or names them when it cannot ask', async (t) => {
  const two = (home) => [agent(home, 'alpha'), agent(home, 'beta', { port: 3739 })];
  const piped = machine(t, two);
  await assert.rejects(loginCommand(['weixin'], piped.options), /有多个实例[\s\S]*alpha\s+ALPHA\s+飞书[\s\S]*beta/);
  await assert.rejects(loginCommand(['weixin', 'gamma'], piped.options), /没有叫 gamma 的实例/);
  assert.deepEqual(piped.calls, []);

  const terminal = machine(t, two, { tty: true });
  setTimeout(() => terminal.input.write('\x1b[B\r'), 20);
  assert.equal(await loginCommand(['weixin'], terminal.options), 0);
  assert.deepEqual(terminal.calls.map(([kind, id]) => [kind, id]), [['weixin', 'beta'], ['restart', 'beta']]);
});

test('a combination the daemon would reject fails before any scan, and nothing exists yet without setup', async (t) => {
  const ark = machine(t, (home) => [agent(home, 'ark', { model: 'ark', volcSessionId: 'sesn-seed12345678', volcEnvironmentId: 'env-12345678' })]);
  await assert.rejects(loginCommand(['weixin'], ark.options), /cannot use the ark runtime/);
  await assert.rejects(loginCommand(['email'], ark.options), /cannot use the ark runtime/);
  assert.deepEqual(ark.calls, []);

  const empty = machine(t, () => []);
  await assert.rejects(loginCommand(['weixin'], empty.options), /先运行 vika setup/);
  assert.equal(await loginCommand(['setup'], empty.options), 2);
  assert.match(empty.written(), /用法：vika login <lark\|weixin\|email> \[实例\]/);
});
