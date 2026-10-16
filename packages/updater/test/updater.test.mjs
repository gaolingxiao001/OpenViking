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
import { defaultValidateRelease, publishLatestRelease } from '../src/publisher.mjs';

process.env.VIKA_UPDATER_TARGETS_JSON = JSON.stringify({
  zayn: {
    app: 'vika-zayn',
    readyUrl: 'http://127.0.0.1:3738/ready',
    upgradeSharedWeb: false,
  },
  sally: {
    app: 'vika-sally',
    readyUrl: 'http://127.0.0.1:3740/ready',
    upgradeSharedWeb: false,
  },
});
const {
  cleanPm2ControlEnv,
  cleanWebPm2ControlEnv,
  createUpdaterServer,
  upgradeTarget,
} = await import('../src/server.mjs');

async function fixtureTempRoot(prefix) {
  return realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function fixtureRelease() {
  const root = await fixtureTempRoot('vika-updater-test-');
  const base = path.join(root, 'vika');
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

async function fixtureAppRelease(fixture, name, entryRelative) {
  const release = path.join(path.dirname(fixture.release), name);
  const entry = path.join(release, entryRelative);
  await mkdir(path.dirname(entry), { recursive: true });
  await writeFile(entry, '');
  await writeFile(path.join(release, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  return { release, entry, config: path.join(release, 'ecosystem.config.cjs') };
}

function replacePm2Harness({ app, initialEntry, entriesByConfig }) {
  let activeEntry = initialEntry;
  const events = [];

  return {
    events,
    get activeEntry() { return activeEntry; },
    execFileImpl: async (_command, args) => {
      events.push(['pm2', ...args]);
      const [operation] = args;
      if (operation === 'jlist') {
        return {
          stdout: JSON.stringify(activeEntry ? [{
            name: app,
            pm2_env: { status: 'online', pm_exec_path: activeEntry },
          }] : []),
        };
      }
      if (operation === 'delete') {
        assert.equal(args[1], app);
        activeEntry = null;
        return { stdout: '' };
      }
      if (operation === 'start' || operation === 'startOrReload') {
        const nextEntry = entriesByConfig.get(args[1]);
        assert.ok(nextEntry, `unexpected ecosystem config: ${args[1]}`);
        assert.deepEqual(args.slice(2), ['--only', app, '--update-env']);
        // Model PM2's problematic behavior: startOrReload preserves the old
        // pm_exec_path when an app with the same name already exists.
        if (operation === 'start' || !activeEntry) activeEntry = nextEntry;
        return { stdout: '' };
      }
      if (operation === 'save') return { stdout: '' };
      throw new Error(`unexpected PM2 operation: ${operation}`);
    },
  };
}

async function fixtureBootstrapUpdater({ failCurrentReady = false } = {}) {
  const root = await fixtureTempRoot('vika-updater-bootstrap-test-');
  const home = path.join(root, 'home');
  const fakeBin = path.join(root, 'bin');
  const base = path.join(home, '.vika');
  const oldRelease = path.join(base, 'releases', '0.4.0-old');
  const currentRelease = path.join(base, 'releases', '0.4.0-current');
  const updaterRelative = path.join('packages', 'updater', 'src', 'main.mjs');
  const oldEntry = path.join(oldRelease, updaterRelative);
  const currentEntry = path.join(currentRelease, updaterRelative);
  for (const [release, entry] of [[oldRelease, oldEntry], [currentRelease, currentEntry]]) {
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, '');
    await writeFile(path.join(release, 'ecosystem.config.cjs'), 'module.exports = {};\n');
  }
  await mkdir(fakeBin, { recursive: true });
  await symlink(currentRelease, path.join(base, 'current'));
  await writeFile(path.join(home, 'pm2-state.json'), JSON.stringify([{
    name: 'vika-updater',
    pm2_env: { status: 'online', pm_exec_path: oldEntry },
  }]));
  if (failCurrentReady) await writeFile(path.join(home, 'fail-current-ready'), '1\n');

  await writeFile(path.join(fakeBin, 'pm2'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
const statePath = path.join(home, 'pm2-state.json');
const eventsPath = path.join(home, 'events.jsonl');
const [operation, ...args] = process.argv.slice(2);
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = (state) => fs.writeFileSync(statePath, JSON.stringify(state));
fs.writeFileSync(path.join(home, 'pm2-env.json'), JSON.stringify({
  manifest: process.env.VIKA_CONFIG,
  logLevel: process.env.VIKA_LOG_LEVEL,
  arkApiKey: process.env.ARK_API_KEY,
  volcSessionId: process.env.VIKA_VOLC_SESSION_ID,
  volcStreamIdleTimeoutMs: process.env.VIKA_VOLC_STREAM_IDLE_TIMEOUT_MS,
  profile: process.env.VIKA_LARK_PROFILE,
}));
fs.appendFileSync(eventsPath, JSON.stringify(['pm2', operation, ...args]) + '\\n');
if (operation === 'jlist') {
  process.stdout.write(JSON.stringify(readState()));
} else if (operation === 'delete') {
  writeState(readState().filter((row) => row.name !== args[0]));
} else if (operation === 'start' || operation === 'startOrReload') {
  const config = fs.realpathSync(args[0]);
  const app = args[args.indexOf('--only') + 1];
  const nextEntry = path.join(path.dirname(config), 'packages', 'updater', 'src', 'main.mjs');
  const state = readState();
  const existing = state.find((row) => row.name === app);
  if (operation === 'start' || !existing) {
    writeState([
      ...state.filter((row) => row.name !== app),
      { name: app, pm2_env: { status: 'online', pm_exec_path: nextEntry } },
    ]);
  }
} else if (operation !== 'save') {
  process.stderr.write('unexpected fake pm2 operation: ' + operation + '\\n');
  process.exitCode = 2;
}
`, { mode: 0o755 });

  await writeFile(path.join(fakeBin, 'curl'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const home = process.env.HOME;
const state = JSON.parse(fs.readFileSync(path.join(home, 'pm2-state.json'), 'utf8'));
const row = state.find((item) => item.name === 'vika-updater');
const entry = row?.pm2_env?.pm_exec_path || '';
fs.appendFileSync(path.join(home, 'events.jsonl'), JSON.stringify(['ready', entry]) + '\\n');
if (!entry) process.exit(22);
const current = fs.realpathSync(path.join(home, '.vika', 'current'));
const activeRelease = entry.slice(0, -${JSON.stringify(`/${updaterRelative}`)}.length);
if (fs.existsSync(path.join(home, 'fail-current-ready')) && activeRelease === current) process.exit(22);
`, { mode: 0o755 });
  await writeFile(path.join(fakeBin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  return {
    home,
    oldRelease,
    currentRelease,
    oldEntry,
    currentEntry,
    async run(extraEnv = {}) {
      const script = fileURLToPath(new URL('../../../scripts/bootstrap-updater.sh', import.meta.url));
      const child = spawn('/bin/bash', [script], {
        env: {
          HOME: home,
          USER: 'test',
          LOGNAME: 'test',
          LANG: 'C.UTF-8',
          PATH: `${fakeBin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdout = [];
      const stderr = [];
      child.stdout.on('data', (chunk) => stdout.push(chunk));
      child.stderr.on('data', (chunk) => stderr.push(chunk));
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      const eventsText = await readFile(path.join(home, 'events.jsonl'), 'utf8');
      return {
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        events: eventsText.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)),
        state: JSON.parse(await readFile(path.join(home, 'pm2-state.json'), 'utf8')),
        pm2Env: JSON.parse(await readFile(path.join(home, 'pm2-env.json'), 'utf8')),
      };
    },
  };
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

test('upgradeTarget cold-starts only the allowlisted Sally app from current release', async () => {
  const fixture = await fixtureRelease();
  const calls = [];
  let jlistCalls = 0;
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
        jlistCalls += 1;
        return {
          stdout: JSON.stringify(jlistCalls === 1 ? [] : [{
            name: 'vika-sally',
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

  assert.equal(result.app, 'vika-sally');
  assert.equal(result.release, fixture.release);
  assert.deepEqual(calls, [
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
      args: [
        'start',
        path.join(fixture.release, 'ecosystem.config.cjs'),
        '--only',
        'vika-sally',
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
    { name: 'vika-zayn', pm2_env: { status: 'online', pm_exec_path: daemonEntry } },
    { name: 'vika-sally', pm2_env: { status: 'online', pm_exec_path: daemonEntry } },
    { name: 'vika-web', pm2_env: { status: 'online', pm_exec_path: webEntry } },
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

  assert.deepEqual(result.apps, ['vika-zayn', 'vika-sally', 'vika-web']);
  assert.deepEqual(
    calls.filter((args) => args[0] === 'start').map((args) => [args[1], args[3]]),
    [
      [path.join(fixture.release, 'ecosystem.config.cjs'), 'vika-zayn'],
      [path.join(fixture.release, 'ecosystem.config.cjs'), 'vika-sally'],
      [path.join(fixture.release, 'ecosystem.config.cjs'), 'vika-web'],
    ],
  );
  assert.ok(!calls.some((args) => args[0] === 'startOrReload'));
  for (const app of ['vika-zayn', 'vika-sally', 'vika-web']) {
    assert.ok(calls.some((args) => args[0] === 'delete' && args[1] === app));
  }
  assert.deepEqual(fetches, [
    'http://127.0.0.1:3738/ready',
    'http://127.0.0.1:3740/ready',
    'http://127.0.0.1:3737/ready',
  ]);
  assert.deepEqual(calls.at(-1), ['save']);
});

test('upgrade all removes only stale daemon apps owned by the managed releases directory', async () => {
  const fixture = await fixtureRelease();
  const daemonEntry = path.join(fixture.release, 'packages', 'daemon', 'src', 'main.mjs');
  const webEntry = path.join(fixture.release, 'packages', 'web', 'src', 'main.mjs');
  const foreignEntry = path.join(fixture.root, 'foreign', 'main.mjs');
  for (const entry of [daemonEntry, webEntry, foreignEntry]) {
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, '');
  }
  let processes = [
    { name: 'vika-zayn', pm2_env: { status: 'online', pm_exec_path: daemonEntry } },
    { name: 'vika-sally', pm2_env: { status: 'online', pm_exec_path: daemonEntry } },
    { name: 'vika-web', pm2_env: { status: 'online', pm_exec_path: webEntry } },
    { name: 'vika-retired', pm2_env: { status: 'online', pm_exec_path: daemonEntry } },
    { name: 'vika-foreign', pm2_env: { status: 'online', pm_exec_path: foreignEntry } },
    { name: 'unrelated-service', pm2_env: { status: 'online', pm_exec_path: daemonEntry } },
  ];
  const deleted = [];

  const result = await upgradeTarget('all', {
    releaseLink: fixture.releaseLink,
    publishReleaseImpl: useFixtureRelease(fixture),
    pm2Bin: '/fake/pm2',
    execFileImpl: async (_command, args) => {
      const [operation] = args;
      if (operation === 'jlist') return { stdout: JSON.stringify(processes) };
      if (operation === 'delete') {
        deleted.push(args[1]);
        processes = processes.filter((row) => row.name !== args[1]);
        return { stdout: '' };
      }
      if (operation === 'start') {
        const app = args[3];
        processes.push({
          name: app,
          pm2_env: {
            status: 'online',
            pm_exec_path: app === 'vika-web' ? webEntry : daemonEntry,
          },
        });
        return { stdout: '' };
      }
      if (operation === 'save') return { stdout: '' };
      throw new Error(`unexpected PM2 operation: ${operation}`);
    },
    fetchImpl: async () => ({ ok: true }),
    readyOptions: { attempts: 1, intervalMs: 0 },
  });

  assert.deepEqual(result.removedApps, ['vika-retired']);
  assert.ok(deleted.includes('vika-retired'));
  assert.ok(!deleted.includes('vika-foreign'));
  assert.ok(!deleted.includes('unrelated-service'));
  assert.ok(processes.some((row) => row.name === 'vika-foreign'));
  assert.ok(processes.some((row) => row.name === 'unrelated-service'));
});

test('PM2 control commands discard metadata inherited from a managed caller', () => {
  assert.deepEqual(cleanPm2ControlEnv({
    HOME: '/safe-home',
    PATH: '/safe-bin',
    PM2_HOME: '/safe-pm2',
    LANG: 'C.UTF-8',
    name: 'vika',
    pm_id: '28',
    pm_exec_path: '/old/release/main.mjs',
    cwd: '/old/release',
    VIKA_LARK_PROFILE: 'secret-profile',
    VIKA_CONFIG: '/safe-home/custom/config.json',
    VIKA_LOG_LEVEL: 'debug',
    ARK_API_KEY: 'system-only-secret',
    TEAM_TASK_BOARD_URL: '',
  }), {
    HOME: '/safe-home',
    PATH: '/safe-bin',
    PM2_HOME: '/safe-pm2',
    LANG: 'C.UTF-8',
    VIKA_CONFIG: '/safe-home/custom/config.json',
    VIKA_LOG_LEVEL: 'debug',
    ARK_API_KEY: 'system-only-secret',
    TEAM_TASK_BOARD_URL: '',
  });
});

test('upgradeTarget replaces an app whose PM2 exec path belongs to an old release', async () => {
  const fixture = await fixtureRelease();
  const entryRelative = path.join('packages', 'daemon', 'src', 'main.mjs');
  const previous = await fixtureAppRelease(fixture, '0.4.0-previous', entryRelative);
  const currentEntry = path.join(fixture.release, entryRelative);
  await mkdir(path.dirname(currentEntry), { recursive: true });
  await writeFile(currentEntry, '');
  const currentConfig = path.join(fixture.release, 'ecosystem.config.cjs');
  const pm2 = replacePm2Harness({
    app: 'vika-sally',
    initialEntry: previous.entry,
    entriesByConfig: new Map([
      [currentConfig, currentEntry],
      [previous.config, previous.entry],
    ]),
  });

  const result = await upgradeTarget('sally', {
    releaseLink: fixture.releaseLink,
    publishReleaseImpl: useFixtureRelease(fixture),
    execFileImpl: pm2.execFileImpl,
    fetchImpl: async (url) => {
      pm2.events.push(['ready', url, pm2.activeEntry]);
      return { ok: true };
    },
    readyOptions: { attempts: 1, intervalMs: 0 },
  });

  assert.equal(result.status, 'ready');
  assert.equal(pm2.activeEntry, currentEntry);
  assert.deepEqual(pm2.events, [
    ['pm2', 'jlist'],
    ['pm2', 'delete', 'vika-sally'],
    ['pm2', 'start', currentConfig, '--only', 'vika-sally', '--update-env'],
    ['pm2', 'jlist'],
    ['ready', 'http://127.0.0.1:3740/ready', currentEntry],
    ['pm2', 'save'],
  ]);
});

test('failed replacement restores the app from the release that owned its old exec path', async () => {
  const fixture = await fixtureRelease();
  const entryRelative = path.join('packages', 'daemon', 'src', 'main.mjs');
  const previous = await fixtureAppRelease(fixture, '0.4.0-previous', entryRelative);
  const currentEntry = path.join(fixture.release, entryRelative);
  await mkdir(path.dirname(currentEntry), { recursive: true });
  await writeFile(currentEntry, '');
  const currentConfig = path.join(fixture.release, 'ecosystem.config.cjs');
  const pm2 = replacePm2Harness({
    app: 'vika-sally',
    initialEntry: previous.entry,
    entriesByConfig: new Map([
      [currentConfig, currentEntry],
      [previous.config, previous.entry],
    ]),
  });

  await assert.rejects(upgradeTarget('sally', {
    releaseLink: fixture.releaseLink,
    publishReleaseImpl: useFixtureRelease(fixture),
    execFileImpl: pm2.execFileImpl,
    fetchImpl: async (url) => {
      pm2.events.push(['ready', url, pm2.activeEntry]);
      return { ok: pm2.activeEntry === previous.entry, status: 503 };
    },
    readyOptions: { attempts: 1, intervalMs: 0 },
  }), /did not become ready/);

  assert.equal(pm2.activeEntry, previous.entry);
  assert.deepEqual(pm2.events.filter((event) => event[1] !== 'save'), [
    ['pm2', 'jlist'],
    ['pm2', 'delete', 'vika-sally'],
    ['pm2', 'start', currentConfig, '--only', 'vika-sally', '--update-env'],
    ['pm2', 'jlist'],
    ['ready', 'http://127.0.0.1:3740/ready', currentEntry],
    ['pm2', 'delete', 'vika-sally'],
    ['pm2', 'start', previous.config, '--only', 'vika-sally', '--update-env'],
    ['ready', 'http://127.0.0.1:3740/ready', previous.entry],
  ]);
});

test('web upgrade and old-release rollback never inherit Ark credentials from PM2 control', async () => {
  const fixture = await fixtureRelease();
  const daemonEntry = path.join(fixture.release, 'packages', 'daemon', 'src', 'main.mjs');
  const webEntry = path.join(fixture.release, 'packages', 'web', 'src', 'main.mjs');
  const previous = await fixtureAppRelease(
    fixture,
    '0.4.0-previous-web',
    path.join('packages', 'web', 'src', 'main.mjs'),
  );
  await mkdir(path.dirname(daemonEntry), { recursive: true });
  await mkdir(path.dirname(webEntry), { recursive: true });
  await writeFile(daemonEntry, '');
  await writeFile(webEntry, '');

  const active = new Map([['vika-web', previous.entry]]);
  const starts = [];
  const pm2Env = {
    HOME: '/safe-home',
    PATH: '/safe-bin',
    ARK_API_KEY: 'sentinel-key',
    ARK_SESSION_ID: 'sentinel-ark-session',
    VOLCENGINE_API_KEY: 'sentinel-volc-key',
    VIKA_VOLC_SESSION_ID: 'sentinel-seed',
    SESSION_ID: 'sentinel-generic-session',
  };
  const execFileImpl = async (_command, args, options) => {
    const [operation] = args;
    if (operation === 'jlist') {
      return {
        stdout: JSON.stringify([...active].map(([name, entry]) => ({
          name,
          pm2_env: { status: 'online', pm_exec_path: entry },
        }))),
      };
    }
    if (operation === 'delete') {
      active.delete(args[1]);
      return { stdout: '' };
    }
    if (operation === 'start') {
      const app = args[3];
      const entry = app === 'vika-web'
        ? (args[1] === previous.config ? previous.entry : webEntry)
        : daemonEntry;
      active.set(app, entry);
      starts.push({ app, config: args[1], env: options.env });
      return { stdout: '' };
    }
    if (operation === 'save') return { stdout: '' };
    throw new Error(`unexpected PM2 operation: ${operation}`);
  };

  await assert.rejects(upgradeTarget('all', {
    releaseLink: fixture.releaseLink,
    publishReleaseImpl: useFixtureRelease(fixture),
    pm2Env,
    execFileImpl,
    fetchImpl: async (url) => ({
      ok: !url.endsWith(':3737/ready') || active.get('vika-web') === previous.entry,
      status: 503,
    }),
    readyOptions: { attempts: 1, intervalMs: 0 },
  }), /did not become ready/);

  const webStarts = starts.filter(({ app }) => app === 'vika-web');
  assert.deepEqual(webStarts.map(({ config }) => config), [
    path.join(fixture.release, 'ecosystem.config.cjs'),
    previous.config,
  ]);
  for (const { env } of webStarts) {
    assert.deepEqual(env, { HOME: '/safe-home', PATH: '/safe-bin' });
  }
  assert.ok(starts.some(({ app, env }) => app.startsWith('vika-')
    && env.ARK_API_KEY === 'sentinel-key'));
  assert.deepEqual(cleanWebPm2ControlEnv(pm2Env), {
    HOME: '/safe-home',
    PATH: '/safe-bin',
  });
});

test('bootstrap replaces the updater from the exact current release config and verifies readiness', async () => {
  const fixture = await fixtureBootstrapUpdater();
  const result = await fixture.run({
    VIKA_CONFIG: '/custom/config.json',
    VIKA_LOG_LEVEL: 'debug',
    ARK_API_KEY: 'system-only-secret',
    VIKA_VOLC_SESSION_ID: 'seed-session-ref',
    VIKA_VOLC_STREAM_IDLE_TIMEOUT_MS: '120000',
    VIKA_LARK_PROFILE: 'must-not-pass',
  });
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(result.state, [{
    name: 'vika-updater',
    pm2_env: { status: 'online', pm_exec_path: fixture.currentEntry },
  }]);
  assert.deepEqual(result.pm2Env, {
    manifest: '/custom/config.json',
    logLevel: 'debug',
    arkApiKey: 'system-only-secret',
    volcSessionId: 'seed-session-ref',
    volcStreamIdleTimeoutMs: '120000',
  });

  const pm2Events = result.events.filter((event) => event[0] === 'pm2');
  assert.deepEqual(pm2Events.map((event) => event[1]), [
    'jlist', 'delete', 'start', 'jlist', 'save',
  ]);
  assert.deepEqual(pm2Events[1], ['pm2', 'delete', 'vika-updater']);
  assert.deepEqual(pm2Events[2], [
    'pm2',
    'start',
    path.join(fixture.currentRelease, 'ecosystem.config.cjs'),
    '--only',
    'vika-updater',
    '--update-env',
  ]);
  const readyIndexes = result.events
    .map((event, index) => [event, index])
    .filter(([event]) => event[0] === 'ready')
    .map(([, index]) => index);
  assert.ok(readyIndexes.length > 0);
  assert.ok(readyIndexes.every((index) => result.events[index][1] === fixture.currentEntry));
  assert.ok(!pm2Events.some((event) => event[1] === 'startOrReload'));
});

test('failed bootstrap restores and verifies the updater from its old exec release', async () => {
  const fixture = await fixtureBootstrapUpdater({ failCurrentReady: true });
  const result = await fixture.run();
  assert.notEqual(result.code, 0);
  assert.deepEqual(result.state, [{
    name: 'vika-updater',
    pm2_env: { status: 'online', pm_exec_path: fixture.oldEntry },
  }]);

  const pm2Events = result.events.filter((event) => event[0] === 'pm2');
  assert.ok(!pm2Events.some((event) => event[1] === 'startOrReload'));
  assert.deepEqual(
    pm2Events.filter((event) => event[1] === 'delete').map((event) => event[2]),
    ['vika-updater', 'vika-updater'],
  );
  assert.deepEqual(
    pm2Events.filter((event) => event[1] === 'start').map((event) => event[2]),
    [
      path.join(fixture.currentRelease, 'ecosystem.config.cjs'),
      path.join(fixture.oldRelease, 'ecosystem.config.cjs'),
    ],
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
    /another vika deploy or upgrade is running/,
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
            name: 'vika-sally',
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

test('release preparation installs locked dependencies and verifies managed Pi before testing', async () => {
  const calls = [];
  const buildEnv = { PATH: '/fixture/bin', HOME: '/fixture/home' };
  await defaultValidateRelease('/releases/pending', {
    npmBin: 'npm', buildEnv,
    execFileImpl: async (bin, args, options) => { calls.push({ bin, args, options }); },
  });
  assert.deepEqual(calls.map(({ args }) => args), [
    ['ci', '--no-audit', '--no-fund'], ['run', 'check:pi'], ['test'], ['run', 'check'],
  ]);
  assert.ok(calls.every(({ bin, options }) => bin === 'npm'
    && options.cwd === '/releases/pending' && options.env === buildEnv));
  const failed = [];
  await assert.rejects(defaultValidateRelease('/releases/pending', {
    npmBin: 'npm', buildEnv,
    execFileImpl: async (_bin, args) => { failed.push(args); throw new Error('install failed'); },
  }), /install failed/);
  assert.deepEqual(failed, [['ci', '--no-audit', '--no-fund']]);
});

test('publisher fetches trusted main, validates once, and reuses the same commit', async () => {
  const root = await fixtureTempRoot('lark-publisher-test-');
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
  await git('init');
  await git('checkout', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await git('add', '.');
  await git('commit', '-m', 'initial');
  await git('clone', '--bare', source, remote);
  await mkdir(baseDir, { recursive: true });
  let validations = 0;
  const options = {
    baseDir,
    remoteUrl: remote,
    remoteBranch: 'main',
    now: () => new Date('2026-08-09T20:00:00Z'),
    validateReleaseImpl: async (release) => {
      validations += 1;
      assert.equal(await readFile(path.join(release, 'ecosystem.config.cjs'), 'utf8'), 'module.exports = {};\n');
      await assert.rejects(readFile(path.join(release, '.env')), { code: 'ENOENT' });
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

  const aliasedBaseDir = path.join(root, 'installed-alias');
  await symlink(baseDir, aliasedBaseDir);
  const viaAlias = await publishLatestRelease({
    ...options,
    baseDir: aliasedBaseDir,
    mirrorDir: path.join(baseDir, 'upstream.git'),
  });
  assert.equal(viaAlias.published, false);
  assert.equal(viaAlias.release, first.release);
});

test('publisher advances current and keeps the prior release as rollback', async () => {
  const root = await fixtureTempRoot('lark-publisher-rollback-test-');
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
  await runGit(source, ['init']);
  await runGit(source, ['checkout', '-b', 'main']);
  await runGit(source, ['config', 'user.email', 'test@example.com']);
  await runGit(source, ['config', 'user.name', 'Test']);
  await runGit(source, ['add', '.']);
  await runGit(source, ['commit', '-m', 'initial']);
  await runGit(root, ['clone', '--bare', source, remote]);
  await mkdir(baseDir, { recursive: true });
  await writeFile(path.join(baseDir, 'env'), 'VIKA_TEST=1\n');
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
  const root = await fixtureTempRoot('vika-updater-socket-test-');
  const socketPath = path.join(root, 'updater.sock');
  const calls = [];
  const updater = await createUpdaterServer({
    socketPath,
    upgrade: async (target) => {
      calls.push(target);
      return { target, app: `vika-${target}`, release: '/release', status: 'ready' };
    },
  });
  t.after(() => updater.close());

  const response = await post(socketPath, { target: 'sally' });
  assert.equal(response.status, 200);
  assert.deepEqual(calls, ['sally']);
  assert.equal(response.body.status, 'ready');
});

test('request body timeout does not abort a long-running upgrade response', async (t) => {
  const root = await fixtureTempRoot('vika-updater-socket-test-');
  const socketPath = path.join(root, 'updater.sock');
  const updater = await createUpdaterServer({
    socketPath,
    requestBodyTimeoutMs: 10,
    upgrade: async (target) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return { target, app: 'vika-sally', release: '/release/current', status: 'ready' };
    },
  });
  t.after(() => updater.close());

  const response = await post(socketPath, { target: 'sally' });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'ready');
});

test('client disconnect does not cancel an upgrade already owned by the updater', async (t) => {
  // Keep the Unix socket path below macOS's sockaddr_un limit. os.tmpdir()
  // already expands to a long /private/var/folders path on developer Macs.
  const root = await fixtureTempRoot('lud-');
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
      return { target, app: 'vika-zayn', release: '/release/current', status: 'ready' };
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
  const root = await fixtureTempRoot('vika-updater-reject-test-');
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
  const root = await fixtureTempRoot('vika-updater-busy-test-');
  const socketPath = path.join(root, 'updater.sock');
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const updater = await createUpdaterServer({
    socketPath,
    upgrade: async (target) => {
      await firstGate;
      return { target, app: 'vika', release: '/release', status: 'ready' };
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
  const root = await fixtureTempRoot('vika-updater-owner-test-');
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
  const root = await fixtureTempRoot('vika-updater-cli-test-');
  const socketPath = path.join(root, 'updater.sock');
  const updater = await createUpdaterServer({
    socketPath,
    upgrade: async (target) => ({
      target,
      app: 'vika-sally',
      release: '/release/current',
      status: 'ready',
    }),
  });
  t.after(() => updater.close());

  const bin = fileURLToPath(new URL('../../cli/bin/vika.mjs', import.meta.url));
  const child = spawn(process.execPath, [bin, 'upgrade', 'sally'], {
    env: {
      ...process.env,
      VIKA_UPDATER_SOCKET: socketPath,
      VIKA_UPDATER_TARGETS_JSON: JSON.stringify({
        sally: {
          app: 'vika-sally',
          readyUrl: 'http://127.0.0.1:3740/ready',
          upgradeSharedWeb: false,
        },
      }),
    },
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
    'vika-sally is ready (/release/current)\n',
  );
});
