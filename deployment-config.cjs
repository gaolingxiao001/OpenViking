'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSTANCE_ID = /^[a-z][a-z0-9-]{0,31}$/;
// `all` is the upgrade target for every instance; vika-web and vika-updater
// are the shared control-plane pm2 apps, so these ids cannot name an instance.
const RESERVED_INSTANCE_IDS = Object.freeze(['all', 'web', 'updater']);
const CONTROL_ENV_MAX_BYTES = 262_144;
const DEPLOYMENT_MANIFEST_MAX_BYTES = 1_048_576;
const TOP_LEVEL_FIELDS = Object.freeze(['version', 'defaultInstance', 'env', 'agents']);
const DAEMON_ENV_FIELDS = Object.freeze([
  'TEAM_TASK_BOARD_URL',
  'LARK_CLI_BIN',
  'CODEX_BIN',
  'TRAEX_BIN',
  'TRAECLI_BIN',
  'CLAUDE_BIN',
  'PI_BIN',
  'VIKA_WEIXIN_ALLOW_FROM',
  'VIKA_WEIXIN_LONG_POLL_TIMEOUT_MS',
  'VIKA_LOG_LEVEL',
  'VIKA_DRY_RUN',
  'VIKA_IGNORED_SENDER_IDS',
  'VIKA_SEND_TIMEOUT_MS',
  'VIKA_SHUTDOWN_TIMEOUT_MS',
  'VIKA_MAX_REPLY_CHARS',
  'VIKA_MAX_EVENT_BYTES',
  'VIKA_MAX_EVENT_AGE_MS',
  'VIKA_IDLE_REACTION_AFTER_MS',
  'VIKA_OV_IDENTITY',
  'VIKA_RETENTION_MS',
  'VIKA_CODEX_EFFORT',
  'VIKA_TRAEX_EFFORT',
  'VIKA_CLAUDE_EFFORT',
  'VIKA_CLAUDE_MODEL',
  'VIKA_PI_EFFORT',
  'VIKA_PI_MODEL',
  'VIKA_VOLC_SESSION_ID',
  'VIKA_VOLC_ENVIRONMENT_ID',
  'VIKA_VOLC_BASE_URL',
  'VIKA_VOLC_REQUEST_TIMEOUT_MS',
  'VIKA_VOLC_STREAM_IDLE_TIMEOUT_MS',
  'FALLBACK_MODEL',
  'VIKA_COGNITION_MAX_CHARS',
  'VIKA_HISTORY_LIMIT',
]);
// Secrets may flow from the operator environment into daemon/updater PM2
// processes, but are deliberately excluded from the deployment manifest.
const DAEMON_SECRET_ENV_FIELDS = Object.freeze([
  'ARK_API_KEY',
  // Read key of the private test release bucket; drop with downloadHeaders.
  'VIKA_TOS_ACCESS_KEY',
]);
const DAEMON_PROCESS_ENV_FIELDS = Object.freeze([
  ...DAEMON_ENV_FIELDS,
  ...DAEMON_SECRET_ENV_FIELDS,
]);
const AGENT_FIELDS = Object.freeze([
  'id',
  'displayName',
  'channel',
  'connectors',
  'profile',
  'port',
  'dataDir',
  'workspace',
  'ovConfig',
  'model',
  'volcSessionId',
  'volcEnvironmentId',
  'meetingAudio',
  'emailConfig',
]);

const MEETING_AUDIO_FIELDS = Object.freeze(['targetChatId', 'asrConfigFile', 'pythonCommand']);

function resolveDeploymentManifestPath(env = process.env) {
  const override = typeof env.VIKA_CONFIG === 'string'
    ? env.VIKA_CONFIG.trim()
    : '';
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new Error('VIKA_CONFIG must be an absolute path');
    }
    return path.normalize(override);
  }
  const home = typeof env.HOME === 'string' ? env.HOME.trim() : '';
  if (!home || !path.isAbsolute(home)) throw new Error('HOME must be an absolute path');
  return path.join(path.normalize(home), '.vika', 'config.json');
}

// Secrets (DAEMON_SECRET_ENV_FIELDS) are deliberately kept out of config.json
// so they never land in a file meant to be inspected/versioned. This sibling file
// is the deterministic fallback: whoever runs `pm2 restart`/`vika upgrade`
// no longer needs the secret exported in their own shell for it to take effect.
function resolveSecretsFilePath(env = process.env) {
  const override = typeof env.VIKA_SECRETS_FILE === 'string'
    ? env.VIKA_SECRETS_FILE.trim()
    : '';
  if (override) {
    if (!path.isAbsolute(override)) {
      throw new Error('VIKA_SECRETS_FILE must be an absolute path');
    }
    return path.normalize(override);
  }
  const home = typeof env.HOME === 'string' ? env.HOME.trim() : '';
  if (!home || !path.isAbsolute(home)) return null;
  return path.join(path.normalize(home), '.vika', 'secrets.env');
}

function loadSecretsFile(env = process.env) {
  const secretsPath = resolveSecretsFilePath(env);
  if (!secretsPath) return {};
  let raw;
  try { raw = fs.readFileSync(secretsPath, 'utf8'); } catch { return {}; }
  const allowed = new Set(DAEMON_SECRET_ENV_FIELDS);
  const result = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!allowed.has(key)) continue;
    result[key] = trimmed.slice(eq + 1).trim();
  }
  return result;
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

function optionalManifestString(value, name) {
  if (value === undefined || value === null) return null;
  return manifestString(value, name);
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
  if (!INSTANCE_ID.test(id) || RESERVED_INSTANCE_IDS.includes(id)) {
    throw new Error(`${label}.id must match ${INSTANCE_ID} and cannot be ${RESERVED_INSTANCE_IDS.join(', ')}`);
  }
  if (!Number.isSafeInteger(value.port) || value.port < 1 || value.port > 65535) {
    throw new Error(`${label}.port must be an integer between 1 and 65535`);
  }
  let meetingAudio = null;
  if (value.meetingAudio !== undefined && value.meetingAudio !== null) {
    if (typeof value.meetingAudio !== 'object' || Array.isArray(value.meetingAudio)) {
      throw new Error(`${label}.meetingAudio must be an object`);
    }
    assertKnownFields(value.meetingAudio, MEETING_AUDIO_FIELDS, `${label}.meetingAudio`);
    meetingAudio = Object.freeze({
      pythonCommand: manifestAbsolutePath(
        value.meetingAudio.pythonCommand,
        `${label}.meetingAudio.pythonCommand`,
      ),
      asrConfigFile: manifestAbsolutePath(
        value.meetingAudio.asrConfigFile,
        `${label}.meetingAudio.asrConfigFile`,
      ),
    });
  }
  const model = manifestString(value.model, `${label}.model`);
  let connectors = null;
  if (value.connectors !== undefined) {
    if (!Array.isArray(value.connectors) || value.connectors.length === 0) {
      throw new Error(`${label}.connectors must be a non-empty array`);
    }
    connectors = [...new Set(value.connectors.map((connector, connectorIndex) => (
      manifestString(connector, `${label}.connectors[${connectorIndex}]`, { maxLength: 64 })
    )))];
    if (connectors.length !== value.connectors.length
      || connectors.some((connector) => !['lark', 'weixin', 'email'].includes(connector))) {
      throw new Error(`${label}.connectors must contain unique lark, weixin or email values`);
    }
  }
  // The primary IM: where notices to the owner go. A mailbox is never one.
  const channel = value.channel === undefined
    ? (connectors?.find((connector) => connector !== 'email') ?? 'lark')
    : manifestString(value.channel, `${label}.channel`);
  if (!['lark', 'weixin'].includes(channel)) {
    throw new Error(`${label}.channel must be lark or weixin`);
  }
  connectors ??= [channel];
  if (!connectors.includes(channel)) {
    throw new Error(`${label}.connectors must include ${label}.channel`);
  }
  const volcSessionId = optionalManifestString(value.volcSessionId, `${label}.volcSessionId`);
  const volcEnvironmentId = optionalManifestString(
    value.volcEnvironmentId,
    `${label}.volcEnvironmentId`,
  );
  if (Boolean(volcSessionId) !== Boolean(volcEnvironmentId)) {
    throw new Error(`${label}.volcSessionId and ${label}.volcEnvironmentId must be configured together`);
  }
  if (model === 'ark' && !volcSessionId) {
    throw new Error(`${label} using ark must configure volcSessionId and volcEnvironmentId`);
  }
  if (connectors.includes('weixin') && model === 'ark') {
    throw new Error(`${label} using the weixin connector cannot use the ark runtime`);
  }
  if (meetingAudio && !connectors.includes('lark')) {
    throw new Error(`${label}.meetingAudio requires the lark connector`);
  }
  const emailConfig = value.emailConfig === undefined || value.emailConfig === null
    ? null
    : manifestAbsolutePath(value.emailConfig, `${label}.emailConfig`);
  if (connectors.includes('email') !== Boolean(emailConfig)) {
    throw new Error(`${label}.emailConfig and the email connector must be configured together`);
  }
  if (connectors.includes('email') && model === 'ark') {
    throw new Error(`${label} using the email connector cannot use the ark runtime`);
  }
  // The lark-cli profile belongs to the lark connector; other instances have none.
  if (!connectors.includes('lark') && value.profile !== undefined) {
    throw new Error(`${label}.profile is only used by the lark connector`);
  }
  return Object.freeze({
    id,
    displayName: manifestString(value.displayName, `${label}.displayName`, { maxLength: 40 }),
    channel,
    connectors: Object.freeze(connectors),
    profile: connectors.includes('lark') ? manifestString(value.profile, `${label}.profile`) : null,
    port: value.port,
    dataDir: manifestAbsolutePath(value.dataDir, `${label}.dataDir`),
    workspace: manifestAbsolutePath(value.workspace, `${label}.workspace`),
    // OpenViking is optional; without it the instance keeps no cross-session memory.
    ovConfig: value.ovConfig === undefined || value.ovConfig === null
      ? null
      : manifestAbsolutePath(value.ovConfig, `${label}.ovConfig`),
    model,
    volcSessionId,
    volcEnvironmentId,
    meetingAudio,
    emailConfig,
  });
}

function assertUniqueAgentFields(agents) {
  for (const field of [
    'id',
    'profile',
    'port',
    'dataDir',
    'workspace',
    'ovConfig',
    'volcSessionId',
    'volcEnvironmentId',
  ]) {
    const seen = new Set();
    for (const agent of agents) {
      if (agent[field] === null) continue;
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
  const secrets = loadSecretsFile(sourceEnv);
  return Object.freeze(Object.fromEntries(DAEMON_PROCESS_ENV_FIELDS.flatMap((key) => {
    if (typeof sourceEnv[key] === 'string') return [[key, sourceEnv[key]]];
    if (Object.hasOwn(deployment.env, key)) return [[key, deployment.env[key]]];
    if (Object.hasOwn(secrets, key)) return [[key, secrets[key]]];
    return [];
  })));
}

function deploymentDaemonEnvOverrides(sourceEnv = process.env) {
  const secrets = loadSecretsFile(sourceEnv);
  return Object.freeze(Object.fromEntries(DAEMON_PROCESS_ENV_FIELDS.flatMap((key) => {
    if (typeof sourceEnv[key] === 'string') return [[key, sourceEnv[key]]];
    if (Object.hasOwn(secrets, key)) return [[key, secrets[key]]];
    return [];
  })));
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

// The OPENVIKING_* env an instance hands its runtimes. Without OV the memory
// plugins a user installed globally are switched off, so they do not write
// into the user's default OV space.
function openVikingAgentEnv(agent) {
  if (!agent.ovConfig) return { OPENVIKING_MEMORY_ENABLED: '0' };
  return {
    OPENVIKING_CLI_CONFIG_FILE: agent.ovConfig,
    OPENVIKING_CREDENTIAL_SOURCE: 'cli',
    OPENVIKING_MEMORY_ENABLED: '1',
    OPENVIKING_AUTO_RECALL: '0',
    OPENVIKING_AUTO_CAPTURE: '1',
    OPENVIKING_AUTO_COMMIT_ON_COMPACT: '1',
    OPENVIKING_RECALL_PEER_SCOPE: 'actor',
  };
}

function applyDeploymentAgentEnv(env, deployment, requestedId) {
  const id = requestedId || (typeof env.VIKA_INSTANCE_ID === 'string'
    ? env.VIKA_INSTANCE_ID.trim()
    : '') || deployment.defaultInstance;
  const agent = selectDeploymentAgent(deployment, id);
  Object.assign(env, {
    VIKA_INSTANCE_ID: agent.id,
    VIKA_UPGRADE_TARGET: agent.id,
    VIKA_AGENT_NAME: agent.displayName,
    VIKA_PORT: String(agent.port),
    VIKA_DATA_DIR: agent.dataDir,
    VIKA_WORKSPACE: agent.workspace,
    VIKA_MODEL: agent.model,
  });
  if (agent.profile) {
    env.VIKA_LARK_PROFILE = agent.profile;
    env.LARKSUITE_CLI_PROFILE = agent.profile;
  } else {
    delete env.VIKA_LARK_PROFILE;
    delete env.LARKSUITE_CLI_PROFILE;
  }
  Object.assign(env, openVikingAgentEnv(agent));
  if (!agent.ovConfig) delete env.OPENVIKING_CLI_CONFIG_FILE;
  env.VIKA_CHANNEL = agent.channel;
  env.VIKA_CONNECTORS_JSON = JSON.stringify(agent.connectors);
  if (agent.emailConfig) env.VIKA_EMAIL_CONFIG_FILE = agent.emailConfig;
  else delete env.VIKA_EMAIL_CONFIG_FILE;
  if (agent.volcSessionId) {
    env.VIKA_VOLC_SESSION_ID = agent.volcSessionId;
    env.VIKA_VOLC_ENVIRONMENT_ID = agent.volcEnvironmentId;
  } else {
    delete env.VIKA_VOLC_SESSION_ID;
    delete env.VIKA_VOLC_ENVIRONMENT_ID;
  }
  if (agent.meetingAudio) {
    Object.assign(env, {
      VIKA_MEETING_AUDIO_ENABLED: 'true',
      VIKA_MEETING_AUDIO_WORKER_COMMAND: agent.meetingAudio.pythonCommand,
      VIKA_MEETING_AUDIO_WORKER_ARGS_JSON: JSON.stringify([
        path.join(__dirname, 'packages', 'daemon', 'worker', 'meeting_asr_worker.py'),
        '--worker-dir',
        path.join(__dirname, 'meeting-asr'),
      ]),
      VIKA_MEETING_AUDIO_WORKER_CWD: __dirname,
      VIKA_MEETING_AUDIO_ASR_CONFIG_FILE: agent.meetingAudio.asrConfigFile,
    });
  } else {
    for (const key of [
      'VIKA_MEETING_AUDIO_ENABLED',
      'VIKA_MEETING_AUDIO_TARGET_CHAT_ID',
      'VIKA_MEETING_AUDIO_WORKER_COMMAND',
      'VIKA_MEETING_AUDIO_WORKER_ARGS_JSON',
      'VIKA_MEETING_AUDIO_WORKER_CWD',
      'VIKA_MEETING_AUDIO_ASR_CONFIG_FILE',
    ]) delete env[key];
  }
  return agent;
}

function updaterTargetsFor(deployment) {
  const upgradeSharedWeb = deployment.agents.length === 1;
  return Object.fromEntries(deployment.agents.map((agent) => [
    agent.id,
    {
      app: `vika-${agent.id}`,
      readyUrl: `http://127.0.0.1:${agent.port}/ready`,
      upgradeSharedWeb,
    },
  ]));
}

module.exports = {
  AGENT_FIELDS,
  INSTANCE_ID,
  RESERVED_INSTANCE_IDS,
  CONTROL_ENV_MAX_BYTES,
  DAEMON_ENV_FIELDS,
  DAEMON_SECRET_ENV_FIELDS,
  DEPLOYMENT_MANIFEST_MAX_BYTES,
  TOP_LEVEL_FIELDS,
  applyDeploymentAgentEnv,
  applyDeploymentDaemonEnv,
  deploymentDaemonEnvOverrides,
  loadDeploymentManifest,
  loadSecretsFile,
  openVikingAgentEnv,
  resolveDeploymentManifestPath,
  resolveSecretsFilePath,
  resolvedDeploymentDaemonEnv,
  selectDeploymentAgent,
  updaterTargetsFor,
};
