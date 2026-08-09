import { execFile as execFileCallback } from 'node:child_process';
import { chmod, lstat, mkdir, realpath, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import { defaultReleaseLink, defaultSocketPath, getTarget } from './targets.mjs';

const execFile = promisify(execFileCallback);
const MAX_BODY_BYTES = 4096;

function writeJson(response, statusCode, body) {
  const text = JSON.stringify(body);
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('request body must be JSON');
  }
}

async function waitUntilReady(url, fetchImpl, {
  attempts = 30,
  intervalMs = 1000,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return;
      lastError = new Error(`ready endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error(`daemon did not become ready: ${lastError?.message || 'unknown error'}`);
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

export async function verifyPm2App({ app, release, pm2Bin, execFileImpl }) {
  const result = await execFileImpl(pm2Bin, ['jlist'], { timeout: 30_000 });
  let processes;
  try {
    processes = JSON.parse(result?.stdout || '[]');
  } catch {
    throw new Error('pm2 jlist returned invalid JSON');
  }
  const matches = processes.filter((processInfo) => processInfo?.name === app);
  if (matches.length !== 1) throw new Error(`expected exactly one PM2 app named ${app}`);
  const [processInfo] = matches;
  if (processInfo.pm2_env?.status !== 'online') throw new Error(`${app} is not online`);
  const execPath = await realpath(processInfo.pm2_env?.pm_exec_path || '');
  if (!isInside(release, execPath)) {
    throw new Error(`${app} is running outside the current release`);
  }
  return processInfo;
}

export async function resolveRelease(releaseLink) {
  const link = path.resolve(releaseLink);
  const release = await realpath(link);
  const releasesRoot = path.join(path.dirname(link), 'releases');
  if (!isInside(releasesRoot, release)) {
    throw new Error(`current release must resolve inside ${releasesRoot}`);
  }
  return release;
}

export async function upgradeTarget(target, {
  releaseLink = process.env.LARK_UPDATER_RELEASE_LINK || defaultReleaseLink(),
  pm2Bin = process.env.PM2_BIN || 'pm2',
  execFileImpl = execFile,
  fetchImpl = globalThis.fetch,
  readyOptions,
} = {}) {
  const spec = getTarget(target);
  const release = await resolveRelease(releaseLink);
  const configPath = await realpath(path.join(release, spec.config));
  if (!isInside(release, configPath)) throw new Error('ecosystem config resolves outside the release');

  await execFileImpl(pm2Bin, [
    'startOrReload',
    configPath,
    '--only',
    spec.app,
    '--update-env',
  ], { timeout: 60_000 });
  await verifyPm2App({ app: spec.app, release, pm2Bin, execFileImpl });
  await waitUntilReady(spec.readyUrl, fetchImpl, readyOptions);
  await execFileImpl(pm2Bin, ['save'], { timeout: 30_000 });

  return { target, app: spec.app, release, status: 'ready' };
}

async function removeStaleSocket(socketPath) {
  const info = await lstat(socketPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) return;
  if (!info.isSocket()) throw new Error(`refusing to replace non-socket path: ${socketPath}`);
  const stale = await new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy();
      reject(new Error(`updater is already listening on ${socketPath}`));
    });
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error(`updater socket is busy: ${socketPath}`));
    });
    socket.once('error', (error) => {
      if (error?.code === 'ECONNREFUSED' || error?.code === 'ENOENT') resolve(true);
      else reject(error);
    });
  });
  if (!stale) return;
  const confirmed = await lstat(socketPath).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!confirmed) return;
  if (
    !confirmed.isSocket()
    || confirmed.dev !== info.dev
    || confirmed.ino !== info.ino
    || (typeof process.getuid === 'function' && confirmed.uid !== process.getuid())
  ) {
    throw new Error(`updater socket changed during stale check: ${socketPath}`);
  }
  await rm(socketPath);
}

export async function createUpdaterServer({
  socketPath = process.env.LARK_UPDATER_SOCKET || defaultSocketPath(),
  upgrade = upgradeTarget,
} = {}) {
  let activeTarget = null;
  const server = http.createServer(async (request, response) => {
    request.setTimeout(5000, () => request.destroy(new Error('request body timed out')));
    if (request.method === 'GET' && request.url === '/ready') {
      writeJson(response, 200, { status: 'ready', activeTarget });
      return;
    }
    if (request.method !== 'POST' || request.url !== '/v1/upgrade') {
      writeJson(response, 404, { error: 'not found' });
      return;
    }
    if (activeTarget) {
      writeJson(response, 409, { error: `upgrade already running for ${activeTarget}` });
      return;
    }
    activeTarget = 'pending';
    let body;
    try {
      body = await readJsonBody(request);
      getTarget(body.target);
    } catch (error) {
      writeJson(response, 400, { error: error.message });
      activeTarget = null;
      return;
    }
    activeTarget = body.target;
    try {
      const result = await upgrade(body.target);
      writeJson(response, 200, result);
    } catch (error) {
      writeJson(response, 502, { error: error.message });
    } finally {
      activeTarget = null;
    }
  });

  const resolvedSocketPath = path.resolve(socketPath);
  await mkdir(path.dirname(resolvedSocketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(resolvedSocketPath);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(resolvedSocketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(resolvedSocketPath, 0o600);
  const socketIdentity = await lstat(resolvedSocketPath);

  return {
    server,
    socketPath: resolvedSocketPath,
    async close() {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      const current = await lstat(resolvedSocketPath).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (current?.isSocket() && current.dev === socketIdentity.dev && current.ino === socketIdentity.ino) {
        await rm(resolvedSocketPath);
      }
    },
  };
}
