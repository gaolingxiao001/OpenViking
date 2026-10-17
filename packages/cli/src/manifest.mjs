import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// Setup edits ~/.vika/config.json as plain JSON, and only ever saves a file
// that the daemon's own loader accepts.

const require = createRequire(import.meta.url);
const {
  INSTANCE_ID,
  RESERVED_INSTANCE_IDS,
  loadDeploymentManifest,
  resolveDeploymentManifestPath,
} = require('../../../deployment-config.cjs');

const WEB_PORT = 3737;
const FIRST_INSTANCE_PORT = 3738;

export function vikaHome(env = process.env) {
  return path.join(env.HOME || os.homedir(), '.vika');
}

export function manifestPath(env = process.env) {
  return resolveDeploymentManifestPath(env);
}

// The manifest as JSON, or null when there is none yet. A file that exists
// but does not load is an error: setup never overwrites a broken manifest.
export function readManifest(env = process.env) {
  const filePath = manifestPath(env);
  if (!fs.existsSync(filePath)) return { path: filePath, value: null };
  loadDeploymentManifest({ ...env, VIKA_CONFIG: filePath });
  return { path: filePath, value: JSON.parse(fs.readFileSync(filePath, 'utf8')) };
}

export function instanceIdProblem(id, manifest) {
  if (!INSTANCE_ID.test(id)) return '只能用小写字母、数字和 -，以字母开头，最多 32 个字符';
  if (RESERVED_INSTANCE_IDS.includes(id)) return `${RESERVED_INSTANCE_IDS.join('、')} 是保留名字`;
  if (manifest?.agents?.some((agent) => agent.id === id)) return `已经有叫 ${id} 的实例`;
  return null;
}

export function suggestInstanceId(manifest) {
  if (!manifest?.agents?.length) return 'primary';
  for (let index = 2; ; index += 1) {
    const id = `agent${index}`;
    if (!manifest.agents.some((agent) => agent.id === id)) return id;
  }
}

export function portIsFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function allocatePort(manifest, isFree = portIsFree) {
  const taken = new Set([WEB_PORT, ...(manifest?.agents ?? []).map((agent) => agent.port)]);
  for (let port = FIRST_INSTANCE_PORT; port < 65_535; port += 1) {
    if (!taken.has(port) && await isFree(port)) return port;
  }
  throw new Error('no free port for a new instance');
}

// The manifest with one more instance. `env` only fills keys that are not set
// yet: other instances share it, so setup never changes what they run with.
export function withInstance(manifest, agent, env = {}) {
  const next = manifest
    ? structuredClone(manifest)
    : { version: 1, defaultInstance: agent.id, env: {}, agents: [] };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && next.env[key] === undefined) next.env[key] = value;
  }
  next.agents.push(agent);
  return next;
}

function stage(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    loadDeploymentManifest({ VIKA_CONFIG: temporary, HOME: os.homedir() });
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return temporary;
}

// Throws what the daemon's loader would reject, without touching the file.
export function validateManifest(filePath, value) {
  fs.rmSync(stage(filePath, value), { force: true });
}

export function writeManifest(filePath, value) {
  const temporary = stage(filePath, value);
  if (fs.existsSync(filePath)) fs.copyFileSync(filePath, `${filePath}.bak`);
  fs.renameSync(temporary, filePath);
}

// The manifest with one more IM on an existing instance. An instance written
// before `connectors` existed has only its `channel`; that stays its primary IM.
export function withConnector(manifest, id, connector, fields = {}) {
  const next = structuredClone(manifest);
  const agent = next.agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`no instance ${id} in the manifest`);
  const connectors = agent.connectors ?? [agent.channel ?? 'lark'];
  if (connectors.includes(connector)) throw new Error(`instance ${id} already uses ${connector}`);
  agent.channel ??= connectors[0];
  agent.connectors = [...connectors, connector];
  Object.assign(agent, fields);
  return next;
}

// One more mailbox ({ id, config }) for an instance; the first one also
// connects the email connector.
export function withEmailAccount(manifest, id, mailbox) {
  const agent = manifest.agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`no instance ${id} in the manifest`);
  const next = (agent.connectors ?? []).includes('email') ? structuredClone(manifest) : withConnector(manifest, id, 'email');
  const target = next.agents.find((candidate) => candidate.id === id);
  target.emailAccounts = [...(target.emailAccounts ?? []), mailbox];
  return next;
}

// The last mailbox removed also disconnects the email connector.
export function withoutEmailAccount(manifest, id, mailboxId) {
  const next = structuredClone(manifest);
  const agent = next.agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`no instance ${id} in the manifest`);
  agent.emailAccounts = (agent.emailAccounts ?? []).filter((mailbox) => mailbox.id !== mailboxId);
  if (agent.emailAccounts.length === 0) {
    delete agent.emailAccounts;
    agent.connectors = (agent.connectors ?? []).filter((connector) => connector !== 'email');
  }
  return next;
}
