import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Prompter } from '../src/prompt.mjs';
import { larkScopes, setupCommand } from '../src/setup.mjs';

const RUNTIMES = [
  { id: 'codex', label: 'Codex', model: 'codex:', bin: '/opt/codex/bin/codex', binEnv: 'CODEX_BIN', available: true, note: '已登录' },
  { id: 'claude', label: 'Claude Code', model: 'claude:', bin: null, binEnv: 'CLAUDE_BIN', available: false, note: '未安装' },
  { id: 'pi', label: 'Pi（内置）', model: 'pi', bin: null, binEnv: null, available: true, note: 'ok' },
];

function harness(t, answers, { ov = null, runtimes = RUNTIMES, failStart = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vika-setup-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const input = new PassThrough();
  input.end(answers.map((line) => `${line}\n`).join(''));
  const output = new PassThrough();
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  const calls = [];
  const options = {
    prompter: new Prompter({ input, output }),
    env: { HOME: home, PATH: '', LARK_CLI_BIN: '/opt/lark/bin/lark-cli' },
    homeDir: home,
    detect: { runtimes: async () => runtimes, openViking: async () => ov },
    connect: {
      lark: async ({ plan, profile }) => { calls.push(['lark', plan.id, profile]); return { profile, ownerOpenId: 'ou_owner' }; },
      weixin: async ({ plan }) => { calls.push(['weixin', plan.dataDir]); },
      greet: async (message) => { calls.push(['greet', message.userId]); },
    },
    control: {
      start: async (target) => { calls.push(['start', target]); if (failStart) throw new Error('pm2 is not installed'); },
      restart: async (target) => { calls.push(['restart', target]); },
    },
    allocate: async () => 3738,
  };
  return { home, options, calls, written: () => written, manifest: () => JSON.parse(fs.readFileSync(path.join(home, '.vika', 'config.json'), 'utf8')) };
}

test('a first setup: Feishu + Weixin, Codex, OpenViking; scans run only after every answer, then it starts', async (t) => {
  const ovSource = path.join(os.tmpdir(), `vika-ov-source-${process.pid}.conf`);
  fs.writeFileSync(ovSource, JSON.stringify({ url: 'https://ov.example', api_key: 'k' }));
  t.after(() => fs.rmSync(ovSource, { force: true }));
  const ov = { configPath: ovSource, url: 'https://ov.example', usable: true, user: 'amy', authMode: 'api_key', reason: null };
  //            id  name    workspace  runtime IMs    channel OV   confirm
  const h = harness(t, ['', '小V', '',       '1',    '1,2', '2',    '1', 'y'], { ov });
  assert.equal(await setupCommand(h.options), 0);

  const manifest = h.manifest();
  assert.equal(manifest.defaultInstance, 'primary');
  // lark-cli comes with the release; only the runtime the user installed is pinned.
  assert.deepEqual(manifest.env, { CODEX_BIN: '/opt/codex/bin/codex' });
  assert.deepEqual(manifest.agents, [{
    id: 'primary',
    displayName: '小V',
    channel: 'weixin',
    connectors: ['lark', 'weixin'],
    profile: 'vika-primary',
    port: 3738,
    dataDir: path.join(h.home, '.vika', 'data', 'primary'),
    workspace: path.join(h.home, 'vika-workspace', 'primary'),
    ovConfig: path.join(h.home, '.vika', 'ov', 'primary.json'),
    model: 'codex:',
  }]);
  assert.equal(JSON.parse(fs.readFileSync(manifest.agents[0].ovConfig, 'utf8')).actor_peer_id, 'primary');
  assert.ok(fs.statSync(manifest.agents[0].workspace).isDirectory());
  assert.deepEqual(h.calls, [
    ['lark', 'primary', 'vika-primary'],
    ['weixin', path.join(h.home, '.vika', 'data', 'primary')],
    ['start', 'primary'],
    ['restart', 'web'],
    ['start', 'updater'],
    ['greet', 'ou_owner'],
  ]);
});

test('a second instance keeps the shared env and the default instance', async (t) => {
  const h = harness(t, ['', '', '', '3', '1', 'y']);
  assert.equal(await setupCommand(h.options), 0);
  const second = harness(t, ['', 'Second', '', '3', '1', 'y']);
  fs.mkdirSync(path.join(second.home, '.vika'), { recursive: true });
  fs.copyFileSync(path.join(h.home, '.vika', 'config.json'), path.join(second.home, '.vika', 'config.json'));
  second.options.allocate = async () => 3739;
  assert.equal(await setupCommand(second.options), 0);
  const manifest = second.manifest();
  assert.deepEqual(manifest.agents.map(({ id, model, port }) => [id, model, port]), [['primary', 'pi', 3738], ['agent2', 'pi', 3739]]);
  assert.deepEqual(manifest.env, {});
  assert.equal(manifest.defaultInstance, 'primary');
});

test('declining before the scans writes nothing; a Weixin-only instance has no profile and no lark-cli need', async (t) => {
  const declined = harness(t, ['', '', '', '1', '2', 'n']);
  assert.equal(await setupCommand(declined.options), 1);
  assert.equal(fs.existsSync(path.join(declined.home, '.vika', 'config.json')), false);
  assert.deepEqual(declined.calls, []);

  const weixin = harness(t, ['wx', '', '', '1', '2', 'y']);
  weixin.options.env.LARK_CLI_BIN = '';
  assert.equal(await setupCommand(weixin.options), 0);
  const [agent] = weixin.manifest().agents;
  assert.equal(agent.profile, undefined);
  assert.equal(agent.channel, 'weixin');
  assert.match(weixin.written(), /没有检测到 OpenViking/);
  assert.deepEqual(weixin.calls.map(([kind]) => kind), ['weixin', 'start', 'restart', 'start']);
});

test('setup stops early when no runtime can run, and reports a start failure after saving', async (t) => {
  const none = harness(t, [], { runtimes: RUNTIMES.map((runtime) => ({ ...runtime, available: false })) });
  assert.equal(await setupCommand(none.options), 1);
  assert.match(none.written(), /没有可用的 agent 运行时/);

  const webDown = harness(t, ['', '', '', '1', '1', 'y']);
  webDown.options.control.restart = async () => { throw new Error('port 3737 is in use'); };
  assert.equal(await setupCommand(webDown.options), 0);
  assert.match(webDown.written(), /vika-web 没有起来：port 3737 is in use/);
  assert.deepEqual(webDown.calls.map(([kind]) => kind), ['lark', 'start', 'start', 'greet']);

  const failing = harness(t, ['', '', '', '1', '1', 'y'], { failStart: true });
  assert.equal(await setupCommand(failing.options), 1);
  assert.equal(failing.manifest().agents.length, 1);
  assert.match(failing.written(), /配置已保存，但启动没有完成：pm2 is not installed/);
});

test('setup asks for the full permission.json scope set', () => {
  const scopes = larkScopes();
  assert.ok(scopes.tenant.includes('im:message.group_msg'));
  assert.ok(scopes.user.includes('im:message.group_msg:get_as_user'));
  assert.ok(scopes.tenant.length > 100 && scopes.user.length > 100);
});

test('the vika command prints usage, and upgrade lists the configured targets', () => {
  const bin = fileURLToPath(new URL('../bin/vika.mjs', import.meta.url));
  const help = spawnSync(process.execPath, [bin, 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /vika <命令>[\s\S]*setup[\s\S]*upgrade/);
  const unknown = spawnSync(process.execPath, [bin, 'nope'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  const upgrade = spawnSync(process.execPath, [bin, 'upgrade'], {
    encoding: 'utf8',
    env: { ...process.env, VIKA_UPDATER_TARGETS_JSON: JSON.stringify({
      sally: { app: 'vika-sally', readyUrl: 'http://127.0.0.1:3740/ready', upgradeSharedWeb: false },
    }) },
  });
  assert.equal(upgrade.status, 2);
  assert.equal(upgrade.stderr, 'usage: vika upgrade <sally|all>\n');
});

test('when the scan confirmation never arrives, m switches to typing the App ID and Secret', async () => {
  const { PassThrough } = await import('node:stream');
  const { registerApp } = await import('../src/setup.mjs');
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.resume();
  const prompter = new Prompter({ input, output });
  let polls = 0;
  let aborted = false;
  // A registration whose confirmation never arrives, until setup gives up on it.
  const register = (options) => new Promise((_resolve, reject) => {
    options.onQRCodeReady({ url: 'https://open.feishu.cn/page/launcher?user_code=A', expireIn: 600 });
    const timer = setInterval(() => { polls += 1; options.onStatusChange({ status: 'polling' }); }, 2);
    options.signal.addEventListener('abort', () => { clearInterval(timer); aborted = true; reject({ code: 'abort', description: 'aborted' }); });
  });
  const typing = (async () => {
    while (polls < 2) await new Promise((resolve) => setTimeout(resolve, 5));
    for (const key of ['m']) input.write(key);
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write('cli_abc123\r');
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write('the-secret\r');
    await new Promise((resolve) => setTimeout(resolve, 20));
    input.write('\r');
  })();
  const app = await registerApp({ plan: { displayName: 'Vika' }, prompter, scopes: { tenant: [], user: [] }, register });
  await typing;
  assert.equal(aborted, true, 'the abandoned registration stops polling');
  assert.deepEqual(app, { appId: 'cli_abc123', appSecret: 'the-secret', brand: 'feishu', ownerOpenId: null });
});
