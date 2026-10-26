import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appsFor, restartCommand, startCommand, statusCommand, stopCommand } from '../src/control.mjs';

const TARGETS = JSON.stringify({
  alpha: { app: 'vika-alpha', readyUrl: 'http://127.0.0.1:3738/ready', upgradeSharedWeb: false },
  beta: { app: 'vika-beta', readyUrl: 'http://127.0.0.1:3739/ready', upgradeSharedWeb: false },
});

// ~/.vika with one installed release and a fake pm2 that tracks app state.
function fixture(t, online = []) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vika-control-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const release = path.join(home, '.vika', 'releases', '0.4.0-test');
  fs.mkdirSync(path.join(release, 'packages', 'daemon', 'src'), { recursive: true });
  fs.writeFileSync(path.join(release, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  const script = path.join(release, 'packages', 'daemon', 'src', 'main.mjs');
  fs.writeFileSync(script, '');
  const releaseLink = path.join(home, '.vika', 'current');
  fs.symlinkSync(release, releaseLink);
  const apps = new Map(online.map((name) => [name, 'online']));
  const commands = [];
  const execFileImpl = async (bin, args) => {
    commands.push(args.join(' '));
    const [verb] = args;
    if (verb === 'jlist') {
      return { stdout: JSON.stringify([...apps].map(([name, status]) => ({ name, pm2_env: { status, pm_exec_path: script } }))) };
    }
    if (verb === 'start') apps.set(args[3], 'online');
    if (verb === 'stop') apps.set(args[1], 'stopped');
    if (verb === 'delete') apps.delete(args[1]);
    return { stdout: '' };
  };
  const ready = [];
  const fetchImpl = async (url) => { ready.push(url); return { ok: true }; };
  let output = '';
  const options = {
    env: { VIKA_UPDATER_TARGETS_JSON: TARGETS, HOME: home }, releaseLink, execFileImpl, fetchImpl,
    pm2Bin: 'pm2', socketPath: path.join(home, '.vika', 'updater.sock'), readyOptions: { attempts: 1, intervalMs: 1 },
    stdout: { write: (text) => { output += text; } },
  };
  return { options, commands, ready, apps, output: () => output };
}

test('a target names one instance, the Web, the updater, or everything', () => {
  const targets = JSON.parse(TARGETS);
  assert.deepEqual(appsFor('beta', targets).map(({ app }) => app), ['vika-beta']);
  assert.deepEqual(appsFor(undefined, targets).map(({ app }) => app), ['vika-alpha', 'vika-beta', 'vika-web', 'vika-updater']);
  assert.deepEqual(appsFor('web', targets).map(({ app }) => app), ['vika-web']);
  assert.throws(() => appsFor('gamma', targets), /unknown instance gamma/);
});

test('start runs the installed release and leaves online apps alone; nothing is fetched or published', async (t) => {
  const f = fixture(t, ['vika-alpha']);
  assert.equal(await startCommand(undefined, { ...f.options, socketPath: '/nonexistent.sock' }).catch((error) => error.message),
    'updater did not become ready on /nonexistent.sock');
  assert.deepEqual(f.commands.filter((command) => command.startsWith('start')), [
    `start ${fs.realpathSync(path.join(path.dirname(f.options.releaseLink), 'releases', '0.4.0-test', 'ecosystem.config.cjs'))} --only vika-beta --update-env`,
    `start ${fs.realpathSync(path.join(path.dirname(f.options.releaseLink), 'releases', '0.4.0-test', 'ecosystem.config.cjs'))} --only vika-web --update-env`,
    `start ${fs.realpathSync(path.join(path.dirname(f.options.releaseLink), 'releases', '0.4.0-test', 'ecosystem.config.cjs'))} --only vika-updater --update-env`,
  ]);
  assert.match(f.output(), /vika-alpha 已经在运行/);
  assert.deepEqual(f.ready, ['http://127.0.0.1:3739/ready', 'http://127.0.0.1:3737/ready']);
});

test('restart replaces a running app; stop leaves a stopped app; both save the pm2 list', async (t) => {
  const f = fixture(t, ['vika-alpha']);
  await restartCommand('alpha', f.options);
  assert.deepEqual(f.commands.filter((command) => !command.startsWith('jlist')).map((command) => command.split(' ')[0]),
    ['delete', 'start', 'save']);
  await stopCommand('alpha', f.options);
  assert.equal(f.apps.get('vika-alpha'), 'stopped');
  assert.equal(f.commands.at(-1), 'save');
});

test('start explains when no release is installed', async (t) => {
  const f = fixture(t);
  fs.rmSync(f.options.releaseLink);
  await assert.rejects(startCommand('alpha', f.options), /no Vika release is installed/);
});

test('start tolerates PM2 launching before the process becomes online', async (t) => {
  const f = fixture(t);
  let launching = true;
  const base = f.options.execFileImpl;
  f.options.execFileImpl = async (bin, args) => {
    if (args[0] === 'jlist' && f.apps.has('vika-alpha') && launching) {
      launching = false;
      return { stdout: JSON.stringify([{
        name: 'vika-alpha',
        pm2_env: { status: 'one-launch-status', pm_exec_path: path.join(fs.realpathSync(f.options.releaseLink), 'packages', 'daemon', 'src', 'main.mjs') },
      }]) };
    }
    return base(bin, args);
  };
  await startCommand('alpha', { ...f.options, readyOptions: { attempts: 2, intervalMs: 1 } });
  assert.equal(f.apps.get('vika-alpha'), 'online');
});

test('status lists every app with its pm2 state and readiness', async (t) => {
  const f = fixture(t, ['vika-alpha']);
  await statusCommand(f.options);
  assert.match(f.output(), /vika-alpha\s+运行中\s+就绪/);
  assert.match(f.output(), /vika-beta\s+未启动\s+-/);
  assert.match(f.output(), /vika-updater\s+未启动/);
});

test('status names the manifest settings this version ignores', async (t) => {
  const f = fixture(t);
  const home = f.options.env.HOME;
  fs.writeFileSync(path.join(home, '.vika', 'config.json'), JSON.stringify({
    version: 1,
    defaultInstance: 'alpha',
    env: { VIKA_COGNITION_MAX_CHARS: '120000' },
    agents: [{
      id: 'alpha', displayName: 'Alpha', profile: 'vika-alpha', port: 3738, model: 'codex',
      dataDir: path.join(home, 'data'), workspace: path.join(home, 'workspace'), ovConfig: path.join(home, 'ov.json'),
    }],
  }));
  await statusCommand(f.options);
  assert.match(f.output(), /vika-alpha\s+未启动/);
  assert.match(f.output(), /已忽略.*config\.json 删掉：env\.VIKA_COGNITION_MAX_CHARS/);
});
