import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { publishLatestRelease } from '../src/publisher.mjs';
import { cleanPm2ControlEnv, createUpdaterServer, upgradeTarget } from '../src/server.mjs';

async function fixtureRelease() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lark-updater-test-'));
  const base = path.join(root, 'lark-daemon');
  const release = path.join(base, 'releases', '0.4.0-test');
  await mkdir(release, { recursive: true });
  await writeFile(path.join(release, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  await symlink(release, path.join(base, 'current'));
  return { root, release, releaseLink: path.join(base, 'current') };
}

function useFixtureRelease(fixture) {
  return async () => ({
    release: fixture.release,
    commit: '1111111111111111111111111111111111111111',
    published: false,
  });
}

function post(socketPath, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request({
      socketPath,
      path: '/v1/upgrade',
      method: 'POST',
      headers: { 'content-length': Buffer.byteLength(payload) },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }));
    });
    request.once('error', reject);
    request.end(payload);
  });
}

test('upgradeTarget only runs the allowlisted Sally app from current release', async () => {
  const fixture = await fixtureRelease();
  const calls = [];
  const daemonEntry = path.join(fixture.release, 'packages', 'daemon', 'src', 'main.mjs');
  await mkdir(path.dirname(daemonEntry), { recursive: true });
  await writeFile(daemonEntry, '');
  const result = await upgradeTarget('sally', {
    releaseLink: fixture.releaseLink,
    publishReleaseImpl: useFixtureRelease(fixture),
    pm2Bin: '/fake/pm2',
    execFileImpl: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[0] === 'jlist') {
        return {
          stdout: JSON.stringify([{
            name: 'lark-daemon-sally',
            pm2_env: { status: 'online', pm_exec_path: daemonEntry },
          }]),
        };
      }
      return { stdout: '' };
    },
    fetchImpl: async () => ({ ok: true }),
    readyOptions: { attempts: 1, intervalMs: 0 },
    pm2Env: { HOME: '/safe-home', PATH: '/safe-bin' },
  });

  assert.equal(result.app, 'lark-daemon-sally');
  assert.equal(result.release, fixture.release);
  assert.deepEqual(calls, [
    {
      command: '/fake/pm2',
      args: [
        'startOrReload',
        path.join(fixture.release, 'ecosystem.config.cjs'),
        '--only',
        'lark-daemon-sally',
        '--update-env',
      ],
      options: {
        timeout: 60_000,
        env: { HOME: '/safe-home', PATH: '/safe-bin' },
      },
    },
    {
      command: '/fake/pm2',
      args: ['jlist'],
      options: {
        timeout: 30_000,
        env: { HOME: '/safe-home', PATH: '/safe-bin' },
      },
    },
    {
      command: '/fake/pm2',
      args: ['save'],
      options: {
        timeout: 30_000,
        env: { HOME: '/safe-home', PATH: '/safe-bin' },
      },
    },
  ]);
});

test('upgrade all rolls both daemons and the shared web from one ecosystem config', async () => {
  const fixture = await fixtureRelease();
  const daemonEntry = path.join(fixture.release, 'packages', 'daemon', 'src', 'main.mjs');
  const webEntry = path.join(fixture.release, 'packages', 'web', 'src', 'main.mjs');
  await mkdir(path.dirname(daemonEntry), { recursive: true });
  await mkdir(path.dirname(webEntry), { recursive: true });
  await writeFile(daemonEntry, '');
  await writeFile(webEntry, '');
  const calls = [];
  const fetches = [];
  const processes = [
    { name: 'lark-daemon-zayn', pm2_env: { status: 'online', pm_exec_path: daemonEntry } },
    { name: 'lark-daemon-sally', pm2_env: { status: 'online', pm_exec_path: daemonEntry } },
    { name: 'lark-web', pm2_env: { status: 'online', pm_exec_path: webEntry } },
    { name: 'lark-web-sally', pm2_env: { status: 'online', pm_exec_path: webEntry } },
  ];
  const result = await upgradeTarget('all', {
    releaseLink: fixture.releaseLink,
    publishReleaseImpl: useFixtureRelease(fixture),
    pm2Bin: '/fake/pm2',
    execFileImpl: async (_command, args) => {
      calls.push(args);
      return { stdout: args[0] === 'jlist' ? JSON.stringify(processes) : '' };
    },
    fetchImpl: async (url) => { fetches.push(url); return { ok: true }; },
    readyOptions: { attempts: 1, intervalMs: 0 },
  });

  assert.deepEqual(result.apps, ['lark-daemon-zayn', 'lark-daemon-sally', 'lark-web']);
  assert.deepEqual(
    calls.filter((args) => args[0] === 'startOrReload').map((args) => [args[1], args[3]]),
    [
      [path.join(fixture.release, 'ecosystem.config.cjs'), 'lark-daemon-zayn'],
      [path.join(fixture.release, 'ecosystem.config.cjs'), 'lark-daemon-sally'],
      [path.join(fixture.release, 'ecosystem.config.cjs'), 'lark-web'],
    ],
  );
  assert.ok(calls.some((args) => args[0] === 'delete' && args[1] === 'lark-web-sally'));
  assert.deepEqual(fetches, [
    'http://127.0.0.1:3738/ready',
    'http://127.0.0.1:3740/ready',
    'http://127.0.0.1:3737/ready',
  ]);
  assert.deepEqual(calls.at(-1), ['save']);
});

test('first Zayn upgrade replaces the exact legacy PM2 name', async () => {
  const fixture = await fixtureRelease();
  const daemonEntry = path.join(fixture.release, 'packages', 'daemon', 'src', 'main.mjs');
  await mkdir(path.dirname(daemonEntry), { recursive: true });
  await writeFile(daemonEntry, '');
  let jlistCalls = 0;
  const calls = [];
  await upgradeTarget('zayn', {
    releaseLink: fixture.releaseLink,
    publishReleaseImpl: useFixtureRelease(fixture),
    execFileImpl: async (_command, args) => {
      calls.push(args);
      if (args[0] !== 'jlist') return { stdout: '' };
      jlistCalls += 1;
      return { stdout: JSON.stringify(jlistCalls === 1
        ? [{ name: 'lark-daemon', pm2_env: { status: 'online', pm_exec_path: '/old/main.mjs' } }]
        : [{ name: 'lark-daemon-zayn', pm2_env: { status: 'online', pm_exec_path: daemonEntry } }]) };
    },
    fetchImpl: async () => ({ ok: true }),
    readyOptions: { attempts: 1, intervalMs: 0 },
  });

  assert.deepEqual(calls.map((args) => args[0]), [
    'jlist', 'stop', 'startOrReload', 'jlist', 'delete', 'save',
  ]);
  assert.deepEqual(calls[1], ['stop', 'lark-daemon']);
  assert.deepEqual(calls[4], ['delete', 'lark-daemon']);
});

test('failed first Zayn upgrade restores the stopped legacy process', async () => {
  const fixture = await fixtureRelease();
  const daemonEntry = path.join(fixture.release, 'packages', 'daemon', 'src', 'main.mjs');
  await mkdir(path.dirname(daemonEntry), { recursive: true });
  await writeFile(daemonEntry, '');
  let jlistCalls = 0;
  let fetchCalls = 0;
  const calls = [];
  await assert.rejects(upgradeTarget('zayn', {
    releaseLink: fixture.releaseLink,
    publishReleaseImpl: useFixtureRelease(fixture),
    execFileImpl: async (_command, args) => {
      calls.push(args);
      if (args[0] !== 'jlist') return { stdout: '' };
      jlistCalls += 1;
      return { stdout: JSON.stringify(jlistCalls === 1
        ? [{ name: 'lark-daemon', pm2_env: { status: 'online', pm_exec_path: '/old/main.mjs' } }]
        : [{ name: 'lark-daemon-zayn', pm2_env: { status: 'online', pm_exec_path: daemonEntry } }]) };
    },
    fetchImpl: async () => ({ ok: (fetchCalls += 1) > 1, status: 503 }),
    readyOptions: { attempts: 1, intervalMs: 0 },
  }), /did not become ready/);

  assert.ok(calls.some((args) => args[0] === 'delete' && args[1] === 'lark-daemon-zayn'));
  assert.ok(calls.some((args) => args[0] === 'restart' && args[1] === 'lark-daemon'));
  assert.ok(!calls.some((args) => args[0] === 'save'));
});

test('PM2 control commands discard metadata inherited from a managed caller', () => {
  assert.deepEqual(cleanPm2ControlEnv({
    HOME: '/safe-home',
    PATH: '/safe-bin',
    PM2_HOME: '/safe-pm2',
    LANG: 'C.UTF-8',
    name: 'lark-daemon',
    pm_id: '28',
    pm_exec_path: '/old/release/main.mjs',
    cwd: '/old/release',
    LARK_DAEMON_PROFILE: 'secret-profile',
  }), {
    HOME: '/safe-home',
    PATH: '/safe-bin',
    PM2_HOME: '/safe-pm2',
    LANG: 'C.UTF-8',
  });
});

test('upgradeTarget rejects an online app that still points at an old release', async () => {
  const fixture = await fixtureRelease();
  const oldEntry = path.join(fixture.root, 'old-release', 'packages', 'daemon', 'src', 'main.mjs');
  await mkdir(path.dirname(oldEntry), { recursive: true });
  await writeFile(oldEntry, '');

  await assert.rejects(
    upgradeTarget('zayn', {
      releaseLink: fixture.releaseLink,
      publishReleaseImpl: useFixtureRelease(fixture),
      execFileImpl: async (_command, args) => ({
        stdout: args[0] === 'jlist'
          ? JSON.stringify([{
            name: 'lark-daemon-zayn',
            pm2_env: { status: 'online', pm_exec_path: oldEntry },
          }])
          : '',
      }),
      fetchImpl: async () => ({ ok: true }),
      readyOptions: { attempts: 1, intervalMs: 0 },
    }),
    /outside the current release/,
  );
});

test('upgradeTarget rejects arbitrary targets before running PM2', async () => {
  let called = false;
  await assert.rejects(
    upgradeTarget('anything', { execFileImpl: async () => { called = true; } }),
    /target must be one of/,
  );
  assert.equal(called, false);
});

test('upgradeTarget rejects inherited object property names as targets', async () => {
  await assert.rejects(upgradeTarget('toString'), /target must be one of/);
});

test('upgradeTarget shares the deploy lock with deploy.sh', async () => {
  const fixture = await fixtureRelease();
  await mkdir(path.join(path.dirname(fixture.releaseLink), 'deploy.lock'));
  let called = false;
  await assert.rejects(
    upgradeTarget('sally', {
      releaseLink: fixture.releaseLink,
      execFileImpl: async () => { called = true; },
    }),
    /another lark-daemon deploy or upgrade is running/,
  );
  assert.equal(called, false);
});

test('upgradeTarget publishes upstream before rolling the target', async () => {
  const fixture = await fixtureRelease();
  const daemonEntry = path.join(fixture.release, 'packages', 'daemon', 'src', 'main.mjs');
  await mkdir(path.dirname(daemonEntry), { recursive: true });
  await writeFile(daemonEntry, '');
  const order = [];
  const result = await upgradeTarget('sally', {
    releaseLink: fixture.releaseLink,
    publishReleaseImpl: async ({ baseDir }) => {
      order.push(['publish', baseDir]);
      return {
        release: fixture.release,
        commit: '2222222222222222222222222222222222222222',
        published: true,
      };
    },
    execFileImpl: async (_command, args) => {
      order.push(['pm2', args[0]]);
      return {
        stdout: args[0] === 'jlist'
          ? JSON.stringify([{
            name: 'lark-daemon-sally',
            pm2_env: { status: 'online', pm_exec_path: daemonEntry },
          }])
          : '',
      };
    },
    fetchImpl: async () => ({ ok: true }),
    readyOptions: { attempts: 1, intervalMs: 0 },
  });

  assert.deepEqual(order[0], ['publish', path.dirname(fixture.releaseLink)]);
  assert.equal(order[1][0], 'pm2');
  assert.equal(result.commit, '2222222222222222222222222222222222222222');
  assert.equal(result.published, true);
});

test('publisher fetches trusted main, validates once, and reuses the same commit', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lark-publisher-test-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const baseDir = path.join(root, 'installed');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'package.json'), '{"name":"fixture","version":"1.2.3"}\n');
  await writeFile(path.join(source, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  const git = async (...args) => new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd: source, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString('utf8').trim());
      else reject(new Error(Buffer.concat(stderr).toString('utf8')));
    });
  });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await git('add', '.');
  await git('commit', '-m', 'initial');
  await git('clone', '--bare', source, remote);
  await mkdir(baseDir, { recursive: true });
  await writeFile(path.join(baseDir, 'env'), 'LARK_DAEMON_TEST=1\n', { mode: 0o600 });
  let validations = 0;
  const options = {
    baseDir,
    remoteUrl: remote,
    remoteBranch: 'main',
    now: () => new Date('2026-08-09T20:00:00Z'),
    validateReleaseImpl: async (release) => {
      validations += 1;
      assert.equal(await readFile(path.join(release, 'ecosystem.config.cjs'), 'utf8'), 'module.exports = {};\n');
      assert.equal(await realpath(path.join(release, '.env')), path.join(baseDir, 'env'));
    },
  };

  const first = await publishLatestRelease(options);
  const second = await publishLatestRelease(options);
  assert.equal(first.published, true);
  assert.equal(second.published, false);
  assert.equal(second.release, first.release);
  assert.equal(second.commit, first.commit);
  assert.equal(validations, 1);
  assert.equal(await realpath(path.join(baseDir, 'current')), first.release);
  const metadata = JSON.parse(await readFile(path.join(first.release, '.lark-release.json'), 'utf8'));
  assert.equal(metadata.commit, first.commit);
  assert.equal(metadata.remoteUrl, remote);
});

test('publisher advances current and keeps the prior release as rollback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lark-publisher-rollback-test-'));
  const source = path.join(root, 'source');
  const remote = path.join(root, 'remote.git');
  const baseDir = path.join(root, 'installed');
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'package.json'), '{"name":"fixture","version":"1.2.3"}\n');
  await writeFile(path.join(source, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  const runGit = (cwd, args) => new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(Buffer.concat(stderr).toString('utf8')))));
  });
  await runGit(source, ['init', '-b', 'main']);
  await runGit(source, ['config', 'user.email', 'test@example.com']);
  await runGit(source, ['config', 'user.name', 'Test']);
  await runGit(source, ['add', '.']);
  await runGit(source, ['commit', '-m', 'initial']);
  await runGit(root, ['clone', '--bare', source, remote]);
  await mkdir(baseDir, { recursive: true });
  await writeFile(path.join(baseDir, 'env'), 'LARK_DAEMON_TEST=1\n');
  let tick = 0;
  let failValidation = false;
  const options = {
    baseDir,
    remoteUrl: remote,
    validateReleaseImpl: async () => {
      if (failValidation) throw new Error('fixture validation failed');
    },
    now: () => new Date(tick === 0 ? '2026-08-09T20:00:00Z' : '2026-08-09T20:01:00Z'),
  };
  const first = await publishLatestRelease(options);
  tick += 1;
  await writeFile(path.join(source, 'change.txt'), 'next\n');
  await runGit(source, ['add', '.']);
  await runGit(source, ['commit', '-m', 'next']);
  await runGit(source, ['push', remote, 'main']);
  failValidation = true;
  await assert.rejects(publishLatestRelease(options), /fixture validation failed/);
  assert.equal(await realpath(path.join(baseDir, 'current')), first.release);
  failValidation = false;
  const second = await publishLatestRelease(options);

  assert.equal(second.published, true);
  assert.notEqual(second.commit, first.commit);
  assert.equal(await realpath(path.join(baseDir, 'current')), second.release);
  assert.equal(await realpath(path.join(baseDir, 'rollback')), first.release);
});

test('server accepts one allowlisted upgrade over its private socket', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lark-updater-socket-test-'));
  const socketPath = path.join(root, 'updater.sock');
  const calls = [];
  const updater = await createUpdaterServer({
    socketPath,
    upgrade: async (target) => {
      calls.push(target);
      return { target, app: `lark-daemon-${target}`, release: '/release', status: 'ready' };
    },
  });
  t.after(() => updater.close());

  const response = await post(socketPath, { target: 'sally' });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['sally']);
  assert.equal(response.body.status, 'ready');
});

test('request body timeout does not abort a long-running upgrade response', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lark-updater-socket-test-'));
  const socketPath = path.join(root, 'updater.sock');
  const updater = await createUpdaterServer({
    socketPath,
    requestBodyTimeoutMs: 10,
    upgrade: async (target) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { target, app: 'lark-daemon-sally', release: '/release/current', status: 'ready' };
    },
  });
  t.after(() => updater.close());

  const response = await post(socketPath, { target: 'sally' });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ready');
});

test('client disconnect does not cancel an upgrade already owned by the updater', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lark-updater-disconnect-test-'));
  const socketPath = path.join(root, 'updater.sock');
  let markStarted;
  let finishUpgrade;
  let markCompleted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const finish = new Promise((resolve) => { finishUpgrade = resolve; });
  const completed = new Promise((resolve) => { markCompleted = resolve; });
  const updater = await createUpdaterServer({
    socketPath,
    upgrade: async (target) => {
      markStarted();
      await finish;
      markCompleted(target);
      return { target, app: 'lark-daemon-zayn', release: '/release/current', status: 'ready' };
    },
  });
  t.after(() => updater.close());

  const payload = JSON.stringify({ target: 'zayn' });
  const request = http.request({
    socketPath,
    path: '/v1/upgrade',
    method: 'POST',
    headers: { 'content-length': Buffer.byteLength(payload) },
  });
  request.once('error', () => {});
  request.end(payload);
  await started;
  request.destroy();
  finishUpgrade();

  assert.equal(await completed, 'zayn');
});

test('server rejects a non-allowlisted target without calling upgrade', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lark-updater-reject-test-'));
  const socketPath = path.join(root, 'updater.sock');
  let called = false;
  const updater = await createUpdaterServer({
    socketPath,
    upgrade: async () => { called = true; },
  });
  t.after(() => updater.close());

  const response = await post(socketPath, { target: '../../oops' });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /target must be one of/);
  assert.equal(called, false);
});

test('server serializes upgrade requests', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lark-updater-busy-test-'));
  const socketPath = path.join(root, 'updater.sock');
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const updater = await createUpdaterServer({
    socketPath,
    upgrade: async (target) => {
      await firstGate;
      return { target, app: 'lark-daemon', release: '/release', status: 'ready' };
    },
  });
  t.after(() => updater.close());

  const first = post(socketPath, { target: 'zayn' });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await post(socketPath, { target: 'sally' });
  assert.equal(second.status, 409);
  releaseFirst();
  assert.equal((await first).status, 200);
});

test('a second updater cannot unlink the live updater socket', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lark-updater-owner-test-'));
  const socketPath = path.join(root, 'updater.sock');
  const first = await createUpdaterServer({
    socketPath,
    upgrade: async (target) => ({ target, status: 'ready' }),
  });
  t.after(() => first.close());

  await assert.rejects(
    createUpdaterServer({ socketPath, upgrade: async () => ({}) }),
    /already listening/,
  );
  const response = await post(socketPath, { target: 'zayn' });
  assert.equal(response.status, 200);
});

test('CLI upgrade command reaches the updater over the Unix socket', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lark-updater-cli-test-'));
  const socketPath = path.join(root, 'updater.sock');
  const updater = await createUpdaterServer({
    socketPath,
    upgrade: async (target) => ({
      target,
      app: 'lark-daemon-sally',
      release: '/release/current',
      status: 'ready',
    }),
  });
  t.after(() => updater.close());

  const bin = fileURLToPath(new URL('../bin/lark-daemon.mjs', import.meta.url));
  const child = spawn(process.execPath, [bin, 'upgrade', 'sally'], {
    env: { ...process.env, LARK_UPDATER_SOCKET: socketPath },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(exitCode, 0, Buffer.concat(stderr).toString('utf8'));
  assert.equal(
    Buffer.concat(stdout).toString('utf8'),
    'lark-daemon-sally is ready (/release/current)\n',
  );
});
