'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSTANCE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const CONTROL_ENV_MAX_BYTES = 262_144;
const DEPLOYMENT_MANIFEST_MAX_BYTES = 1_048_576;
const TOP_LEVEL_FIELDS = Object.freeze(['version', 'defaultInstance', 'agents']);
const AGENT_FIELDS = Object.freeze([
  'id',
  'displayName',
  'profile',
  'port',
  'dataDir',
  'workspace',
  'ovConfig',
  'model',
]);

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const separator = trimmed.indexOf('=');
  if (separator <= 0) return null;
  const key = trimmed.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let value = trimmed.slice(separator + 1).trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

function loadDeploymentEnv(releaseDir, source = process.env) {
  const env = { ...source };
  const envFile = path.join(releaseDir, '.env');
  if (!fs.existsSync(envFile)) return env;
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (env[key] === undefined) env[key] = value;
  }
  return env;
}

function required(env, name) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  if (!value) throw new Error(`${name} is required for a managed deployment`);
  return value;
}

function absolutePath(env, name) {
  const value = required(env, name);
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  return path.normalize(value);
}

function assertKnownFields(value, allowed, label) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).find((name) => !allowedSet.has(name));
  if (unknown) throw new Error(`unknown ${label} field: ${unknown}`);
}

function manifestString(value, name, { maxLength = 128 } = {}) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`);
  const normalized = value.trim();
  if (normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} is invalid`);
  }
  return normalized;
}

function manifestAbsolutePath(value, name) {
  const normalized = manifestString(value, name, { maxLength: 4096 });
  if (!path.isAbsolute(normalized)) throw new Error(`${name} must be an absolute path`);
  return path.normalize(normalized);
}

function parseAgent(value, index) {
  const label = `agents[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  assertKnownFields(value, AGENT_FIELDS, label);
  const id = manifestString(value.id, `${label}.id`);
  if (!INSTANCE_ID.test(id) || id === 'all') {
    throw new Error(`${label}.id must match ${INSTANCE_ID} and cannot be all`);
  }
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error(`${label}.port must be an integer between 1 and 65535`);
  }
  return Object.freeze({
    id,
    displayName: manifestString(value.displayName, `${label}.displayName`, { maxLength: 40 }),
    profile: manifestString(value.profile, `${label}.profile`),
    port: value.port,
    dataDir: manifestAbsolutePath(value.dataDir, `${label}.dataDir`),
    workspace: manifestAbsolutePath(value.workspace, `${label}.workspace`),
    ovConfig: manifestAbsolutePath(value.ovConfig, `${label}.ovConfig`),
    model: manifestString(value.model, `${label}.model`),
  });
}

function assertUniqueAgentFields(agents) {
  for (const field of ['id', 'profile', 'port', 'dataDir', 'workspace', 'ovConfig']) {
    const seen = new Set();
    for (const agent of agents) {
      if (seen.has(agent[field])) throw new Error(`duplicate agent ${field}: ${agent[field]}`);
      seen.add(agent[field]);
    }
  }
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  if (relative === '') return true;
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return true;
  const reverse = path.relative(right, left);
  return !reverse.startsWith('..') && !path.isAbsolute(reverse);
}

function assertIsolatedAgentStorage(agents) {
  const paths = agents.flatMap((agent, index) => [
    { name: `agents[${index}].dataDir`, value: agent.dataDir },
    { name: `agents[${index}].workspace`, value: agent.workspace },
  ]);
  for (let leftIndex = 0; leftIndex < paths.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < paths.length; rightIndex += 1) {
      const left = paths[leftIndex];
      const right = paths[rightIndex];
      if (pathsOverlap(left.value, right.value)) {
        throw new Error(`agent storage paths overlap: ${left.name} and ${right.name}`);
      }
    }
  }
}

function loadDeploymentManifest(env) {
  const manifestPath = absolutePath(env, 'LARK_DAEMON_DEPLOYMENT_MANIFEST');
  let raw;
  try {
    raw = fs.readFileSync(manifestPath, 'utf8');
  } catch (error) {
    throw new Error(`cannot read deployment manifest ${manifestPath}: ${error.message}`);
  }
  if (Buffer.byteLength(raw) > DEPLOYMENT_MANIFEST_MAX_BYTES) {
    throw new Error(`deployment manifest exceeds ${DEPLOYMENT_MANIFEST_MAX_BYTES} bytes`);
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`deployment manifest must be valid JSON: ${manifestPath}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('deployment manifest must be an object');
  }
  assertKnownFields(value, TOP_LEVEL_FIELDS, 'deployment manifest');
  if (value.version !== 1) throw new Error('deployment manifest version must be 1');
  if (!Array.isArray(value.agents) || value.agents.length === 0) {
    throw new Error('deployment manifest agents must be a non-empty array');
  }
  const defaultInstance = manifestString(value.defaultInstance, 'deployment manifest defaultInstance');
  const agents = value.agents.map(parseAgent);
  assertUniqueAgentFields(agents);
  assertIsolatedAgentStorage(agents);
  const deployment = Object.freeze({
    version: 1,
    defaultInstance,
    agents: Object.freeze(agents),
    manifestPath,
  });
  selectDeploymentAgent(deployment);
  return deployment;
}

function selectDeploymentAgent(deployment, id = deployment.defaultInstance) {
  const agent = deployment.agents.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`deployment instance is not configured: ${id}`);
  return agent;
}

function applyDeploymentAgentEnv(env, deployment, requestedId) {
  const id = requestedId || (typeof env.LARK_DAEMON_INSTANCE_ID === 'string'
    ? env.LARK_DAEMON_INSTANCE_ID.trim()
    : '') || deployment.defaultInstance;
  const agent = selectDeploymentAgent(deployment, id);
  Object.assign(env, {
    LARK_DAEMON_INSTANCE_ID: agent.id,
    LARK_DAEMON_UPGRADE_TARGET: agent.id,
    LARK_DAEMON_AGENT_NAME: agent.displayName,
    LARK_DAEMON_PROFILE: agent.profile,
    LARKSUITE_CLI_PROFILE: agent.profile,
    LARK_DAEMON_PORT: String(agent.port),
    LARK_DAEMON_DATA_DIR: agent.dataDir,
    LARK_DAEMON_WORKSPACE: agent.workspace,
    OPENVIKING_CLI_CONFIG_FILE: agent.ovConfig,
    LARK_DAEMON_CODEX_MODEL: agent.model,
  });
  return agent;
}

function updaterTargetsFor(deployment) {
  const upgradeSharedWeb = deployment.agents.length === 1;
  return Object.fromEntries(deployment.agents.map((agent) => [
    agent.id,
    {
      app: `lark-daemon-${agent.id}`,
      readyUrl: `http://127.0.0.1:${agent.port}/ready`,
      upgradeSharedWeb,
    },
  ]));
}

module.exports = {
  AGENT_FIELDS,
  CONTROL_ENV_MAX_BYTES,
  DEPLOYMENT_MANIFEST_MAX_BYTES,
  TOP_LEVEL_FIELDS,
  applyDeploymentAgentEnv,
  loadDeploymentManifest,
  loadDeploymentEnv,
  selectDeploymentAgent,
  updaterTargetsFor,
};
