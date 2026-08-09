import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createUpdaterServer, upgradeTarget } from '../src/server.mjs';

async function fixtureRelease() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lark-updater-test-'));
  const base = path.join(root, 'lark-daemon');
  const release = path.join(base, 'releases', '0.4.0-test');
  await mkdir(release, { recursive: true });
  await writeFile(path.join(release, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  await writeFile(path.join(release, 'ecosystem.sally.config.cjs'), 'module.exports = {};\n');
  await symlink(release, path.join(base, 'current'));
  return { root, release, releaseLink: path.join(base, 'current') };
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
    pm2Bin: '/fake/pm2',
    execFileImpl: async (command, args) => {
      calls.push({ command, args });
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
  });

  assert.equal(result.app, 'lark-daemon-sally');
  assert.equal(result.release, fixture.release);
  assert.deepEqual(calls, [
    {
      command: '/fake/pm2',
      args: [
        'startOrReload',
        path.join(fixture.release, 'ecosystem.sally.config.cjs'),
        '--only',
        'lark-daemon-sally',
        '--update-env',
      ],
    },
    { command: '/fake/pm2', args: ['jlist'] },
    { command: '/fake/pm2', args: ['save'] },
  ]);
});

test('upgradeTarget rejects an online app that still points at an old release', async () => {
  const fixture = await fixtureRelease();
  const oldEntry = path.join(fixture.root, 'old-release', 'packages', 'daemon', 'src', 'main.mjs');
  await mkdir(path.dirname(oldEntry), { recursive: true });
  await writeFile(oldEntry, '');

  await assert.rejects(
    upgradeTarget('zayn', {
      releaseLink: fixture.releaseLink,
      execFileImpl: async (_command, args) => ({
        stdout: args[0] === 'jlist'
          ? JSON.stringify([{
            name: 'lark-daemon',
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
    'lark-daemon-sally is ready on /release/current\n',
  );
});
