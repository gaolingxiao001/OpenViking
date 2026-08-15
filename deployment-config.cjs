'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSTANCE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const CONTROL_ENV_MAX_BYTES = 262_144;
const DEPLOYMENT_MANIFEST_MAX_BYTES = 1_048_576;
const TOP_LEVEL_FIELDS = Object.freeze(['version', 'defaultInstance', 'env', 'agents']);
const DAEMON_ENV_FIELDS = Object.freeze([
  'TEAM_TASK_BOARD_URL',
  'LARK_CLI_BIN',
  'CODEX_BIN',
  'CLAUDE_BIN',
  'LARK_DAEMON_LOG_LEVEL',
  'LARK_DAEMON_DRY_RUN',
  'LARK_DAEMON_IGNORED_SENDER_IDS',
  'LARK_DAEMON_SEND_TIMEOUT_MS',
  'LARK_DAEMON_SHUTDOWN_TIMEOUT_MS',
  'LARK_DAEMON_MAX_REPLY_CHARS',
  'LARK_DAEMON_MAX_EVENT_BYTES',
  'LARK_DAEMON_MAX_EVENT_AGE_MS',
  'LARK_DAEMON_IDLE_REACTION_AFTER_MS',
  'LARK_DAEMON_RETENTION_MS',
  'LARK_DAEMON_CODEX_EFFORT',
  'LARK_DAEMON_CLAUDE_EFFORT',
  'LARK_DAEMON_CLAUDE_MODEL',
  'LARK_DAEMON_VOLC_SESSION_ID',
  'LARK_DAEMON_VOLC_BASE_URL',
  'LARK_DAEMON_VOLC_REQUEST_TIMEOUT_MS',
  'LARK_DAEMON_VOLC_STREAM_IDLE_TIMEOUT_MS',
  'FALLBACK_MODEL',
  'LARK_DAEMON_COGNITION_MAX_CHARS',
  'LARK_DAEMON_HISTORY_LIMIT',
]);
// Secrets may flow from the operator environment into daemon/updater PM2
// processes, but are deliberately excluded from the deployment manifest.
const DAEMON_SECRET_ENV_FIELDS = Object.freeze([
  'ARK_API_KEY',
]);
const DAEMON_PROCESS_ENV_FIELDS = Object.freeze([
  ...DAEMON_ENV_FIELDS,
  ...DAEMON_SECRET_ENV_FIELDS,
]);
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

function resolveDeploymentManifestPath(env = process.env) {
  const override = typeof env.LARK_DAEMON_DEPLOYMENT_MANIFEST === 'string'
    ? env.LARK_DAEMON_DEPLOYMENT_MANIFEST.trim()
    : '';
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new Error('LARK_DAEMON_DEPLOYMENT_MANIFEST must be an absolute path');
    }
    return path.normalize(override);
  }
  const home = typeof env.HOME === 'string' ? env.HOME.trim() : '';
  if (!home || !path.isAbsolute(home)) throw new Error('HOME must be an absolute path');
  return path.join(path.normalize(home), '.lark-daemon', 'deployment.json');
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

function parseDaemonEnv(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('deployment manifest env must be an object');
  }
  const allowed = new Set(DAEMON_ENV_FIELDS);
  const result = {};
  for (const [key, envValue] of Object.entries(value)) {
    if (!allowed.has(key)) throw new Error(`deployment manifest env field is not allowed: ${key}`);
    if (typeof envValue !== 'string') throw new Error(`deployment manifest env.${key} must be a string`);
    if (envValue.length > 4096 || /[\u0000-\u001f\u007f]/.test(envValue)) {
      throw new Error(`deployment manifest env.${key} is invalid`);
    }
    result[key] = envValue;
  }
  return Object.freeze(result);
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
  const manifestPath = resolveDeploymentManifestPath(env);
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
  const daemonEnv = parseDaemonEnv(value.env);
  const agents = value.agents.map(parseAgent);
  assertUniqueAgentFields(agents);
  assertIsolatedAgentStorage(agents);
  const deployment = Object.freeze({
    version: 1,
    defaultInstance,
    env: daemonEnv,
    agents: Object.freeze(agents),
    manifestPath,
  });
  selectDeploymentAgent(deployment);
  return deployment;
}

function resolvedDeploymentDaemonEnv(deployment, sourceEnv = process.env) {
  return Object.freeze(Object.fromEntries(DAEMON_PROCESS_ENV_FIELDS.flatMap((key) => {
    if (typeof sourceEnv[key] === 'string') return [[key, sourceEnv[key]]];
    if (Object.hasOwn(deployment.env, key)) return [[key, deployment.env[key]]];
    return [];
  })));
}

function deploymentDaemonEnvOverrides(sourceEnv = process.env) {
  return Object.freeze(Object.fromEntries(DAEMON_PROCESS_ENV_FIELDS.flatMap((key) => (
    typeof sourceEnv[key] === 'string' ? [[key, sourceEnv[key]]] : []
  ))));
}

function applyDeploymentDaemonEnv(env, deployment, sourceEnv = env) {
  Object.assign(env, resolvedDeploymentDaemonEnv(deployment, sourceEnv));
  return env;
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
    LARK_DAEMON_MODEL: agent.model,
    LARK_DAEMON_CODEX_MODEL: agent.model === 'ark' ? '' : agent.model,
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
  DAEMON_ENV_FIELDS,
  DAEMON_SECRET_ENV_FIELDS,
  DEPLOYMENT_MANIFEST_MAX_BYTES,
  TOP_LEVEL_FIELDS,
  applyDeploymentAgentEnv,
  applyDeploymentDaemonEnv,
  deploymentDaemonEnvOverrides,
  loadDeploymentManifest,
  resolveDeploymentManifestPath,
  resolvedDeploymentDaemonEnv,
  selectDeploymentAgent,
  updaterTargetsFor,
};
