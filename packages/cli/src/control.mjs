import { execFile as execFileCallback, spawn } from 'node:child_process';
import fs from 'node:fs';
import { realpath } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  appControlEnv,
  cleanPm2ControlEnv,
  isInside,
  pm2Processes,
  resolveRelease,
  startApp,
  verifyPm2App,
} from '../../updater/src/pm2.mjs';
import { SHARED_WEB, defaultReleaseLink, defaultSocketPath, loadTargets } from '../../updater/src/targets.mjs';
import { imList, loadInstances } from './instances.mjs';

// start / stop / restart / status / logs run the release already installed
// under ~/.vika/current. Nothing here fetches code or publishes a release.

const execFile = promisify(execFileCallback);
const UPDATER_APP = 'vika-updater';
// This command's own release (or source checkout); bin/pm2 runs its pinned pm2.
const RELEASE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export function pm2Defaults(env = process.env) {
  const releasePm2 = path.join(RELEASE_ROOT, 'bin', 'pm2');
  return {
    pm2Bin: env.PM2_BIN || (fs.existsSync(releasePm2) ? releasePm2 : 'pm2'),
    // Vika's own pm2 daemon, apart from any pm2 the user runs.
    pm2Env: cleanPm2ControlEnv({ ...env, PM2_HOME: env.PM2_HOME || path.join(env.HOME || '', '.vika', 'pm2') }),
  };
}

function defaults(options = {}) {
  const env = options.env ?? process.env;
  const pm2 = pm2Defaults(env);
  return {
    env,
    pm2Bin: options.pm2Bin ?? pm2.pm2Bin,
    execFileImpl: options.execFileImpl ?? execFile,
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    readyOptions: options.readyOptions,
    releaseLink: options.releaseLink ?? env.VIKA_UPDATER_RELEASE_LINK ?? defaultReleaseLink(),
    socketPath: options.socketPath ?? env.VIKA_UPDATER_SOCKET ?? defaultSocketPath(),
    pm2Env: options.pm2Env ?? pm2.pm2Env,
    stdout: options.stdout ?? process.stdout,
  };
}

// The apps a target names: one instance, `web`, `updater`, or (no target)
// every instance plus the shared Web and the updater.
export function appsFor(target, targets = loadTargets()) {
  const instances = Object.entries(targets).map(([id, spec]) => ({ id, ...spec }));
  const web = { id: 'web', ...SHARED_WEB };
  const updater = { id: 'updater', app: UPDATER_APP };
  if (target === undefined) return [...instances, web, updater];
  if (target === 'web') return [web];
  if (target === 'updater') return [updater];
  const instance = instances.find((spec) => spec.id === target);
  if (!instance) {
    throw new Error(`unknown instance ${target}; configured: ${[...instances.map((spec) => spec.id), 'web', 'updater'].join(', ')}`);
  }
  return [instance];
}

async function installedRelease(releaseLink) {
  if (!fs.existsSync(releaseLink)) {
    throw new Error(`no Vika release is installed at ${releaseLink}; run the installer first (install.sh)`);
  }
  const release = await resolveRelease(releaseLink);
  const configPath = await realpath(path.join(release, 'ecosystem.config.cjs'));
  if (!isInside(release, configPath)) throw new Error('ecosystem config resolves outside the release');
  return { release, configPath };
}

function updaterReady(socketPath) {
  return new Promise((resolve) => {
    const request = http.get({ socketPath, path: '/ready', timeout: 1500 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.once('timeout', () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

async function waitForUpdater(socketPath, { attempts = 30, intervalMs = 1000 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await updaterReady(socketPath)) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`updater did not become ready on ${socketPath}`);
}

async function startOne(spec, context) {
  const { release, configPath, pm2Bin, execFileImpl, fetchImpl, readyOptions, pm2Env, socketPath } = context;
  if (spec.app !== UPDATER_APP) {
    await startApp(spec, { release, configPath, pm2Bin, execFileImpl, fetchImpl, readyOptions, pm2Env });
    return;
  }
  await execFileImpl(pm2Bin, ['start', configPath, '--only', spec.app, '--update-env'], { timeout: 60_000, env: pm2Env });
  await verifyPm2App({ app: spec.app, release, pm2Bin, execFileImpl, pm2Env });
  await waitForUpdater(socketPath, readyOptions);
}

// Starts what is not running; an app that is online already is left alone.
export async function startCommand(target, options) {
  const context = defaults(options);
  const apps = appsFor(target, loadTargets(context.env));
  Object.assign(context, await installedRelease(context.releaseLink));
  const running = new Map((await pm2Processes(context)).map((processInfo) => [processInfo?.name, processInfo]));
  for (const spec of apps) {
    const current = running.get(spec.app);
    if (current?.pm2_env?.status === 'online') {
      context.stdout.write(`${spec.app} is already running\n`);
      continue;
    }
    if (current) {
      await context.execFileImpl(context.pm2Bin, ['delete', spec.app], { timeout: 30_000, env: appControlEnv(spec.app, context.pm2Env) });
    }
    await startOne(spec, context);
    context.stdout.write(`${spec.app} is ready\n`);
  }
  await context.execFileImpl(context.pm2Bin, ['save'], { timeout: 30_000, env: context.pm2Env });
  return 0;
}

export async function restartCommand(target, options) {
  const context = defaults(options);
  const apps = appsFor(target, loadTargets(context.env));
  Object.assign(context, await installedRelease(context.releaseLink));
  const running = new Set((await pm2Processes(context)).map((processInfo) => processInfo?.name));
  for (const spec of apps) {
    if (running.has(spec.app)) {
      await context.execFileImpl(context.pm2Bin, ['delete', spec.app], { timeout: 30_000, env: appControlEnv(spec.app, context.pm2Env) });
    }
    await startOne(spec, context);
    context.stdout.write(`${spec.app} is ready\n`);
  }
  await context.execFileImpl(context.pm2Bin, ['save'], { timeout: 30_000, env: context.pm2Env });
  return 0;
}

export async function stopCommand(target, options) {
  const context = defaults(options);
  const apps = appsFor(target, loadTargets(context.env));
  const running = new Set((await pm2Processes(context)).map((processInfo) => processInfo?.name));
  for (const spec of apps) {
    if (!running.has(spec.app)) continue;
    await context.execFileImpl(context.pm2Bin, ['stop', spec.app], { timeout: 30_000, env: context.pm2Env });
    context.stdout.write(`${spec.app} stopped\n`);
  }
  await context.execFileImpl(context.pm2Bin, ['save'], { timeout: 30_000, env: context.pm2Env });
  return 0;
}

async function ready(spec, context) {
  if (spec.app === UPDATER_APP) return updaterReady(context.socketPath);
  try {
    const response = await context.fetchImpl(spec.readyUrl, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function statusCommand(options) {
  const context = defaults(options);
  const apps = appsFor(undefined, loadTargets(context.env));
  const processes = new Map((await pm2Processes(context)).map((processInfo) => [processInfo?.name, processInfo]));
  let ims = new Map();
  try {
    ims = new Map((loadInstances(context.env)?.agents ?? []).map((agent) => [`vika-${agent.id}`, imList(agent.connectors)]));
  } catch {}
  const rows = [];
  for (const spec of apps) {
    const status = processes.get(spec.app)?.pm2_env?.status ?? 'not started';
    rows.push([spec.app, status, status === 'online' ? (await ready(spec, context) ? 'ready' : 'not ready') : '-', ims.get(spec.app) ?? '']);
  }
  const width = Math.max(...rows.map(([app]) => app.length));
  for (const [app, status, readiness, im] of rows) {
    context.stdout.write(`${app.padEnd(width)}  ${status.padEnd(11)}  ${readiness.padEnd(9)}  ${im}`.trimEnd() + '\n');
  }
  return 0;
}

export function logsCommand(target, options = {}) {
  const context = defaults(options);
  const [spec] = appsFor(target, loadTargets(context.env));
  const child = spawn(context.pm2Bin, ['logs', spec.app, '--lines', '100'], { stdio: 'inherit', env: context.pm2Env });
  return new Promise((resolve) => child.once('exit', (code) => resolve(code ?? 0)));
}
