import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const moduleDir = path.resolve(sourceDir, '..');
export const projectDir = path.resolve(moduleDir, '..', '..');

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const index = trimmed.indexOf('=');
  if (index <= 0) return null;
  const key = trimmed.slice(0, index).trim();
  let value = trimmed.slice(index + 1).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return [key, value];
}

export function loadProjectEnv(envFile = path.join(projectDir, '.env')) {
  if (!fs.existsSync(envFile)) return;
  const content = fs.readFileSync(envFile, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    const [key, value] = parsed;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(raw.toLowerCase())) return false;
  throw new Error(`${name} must be a boolean`);
}

function csvEnv(name) {
  return new Set(
    (process.env[name] ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function enumEnv(name, fallback, allowed) {
  const value = process.env[name] || fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function assertLoopbackHost(host) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('LARK_DAEMON_HOST must be a loopback address');
  }
}

function pathsOverlap(left, right) {
  const relative = path.relative(left, right);
  if (relative === '') return true;
  if (!relative.startsWith('..') && !path.isAbsolute(relative)) return true;
  const reverse = path.relative(right, left);
  return !reverse.startsWith('..') && !path.isAbsolute(reverse);
}

export function getConfig() {
  const dataDir = path.resolve(
    process.env.LARK_DAEMON_DATA_DIR || path.join(os.homedir(), '.local', 'share', 'lark-daemon'),
  );
  const workspace = path.resolve(
    process.env.LARK_DAEMON_WORKSPACE
      || path.join(os.homedir(), 'Documents', 'work', 'lark-agent-workspace'),
  );
  const host = process.env.LARK_DAEMON_HOST || '127.0.0.1';
  assertLoopbackHost(host);
  const eventMode = enumEnv('LARK_DAEMON_EVENT_MODE', 'raw', ['raw', 'compact']);
  if (eventMode !== 'raw') {
    throw new Error('LARK_DAEMON_EVENT_MODE must be raw; compact events omit security and thread fields');
  }
  const promptDir = path.join(moduleDir, 'agent');
  if (pathsOverlap(workspace, projectDir)) {
    throw new Error('LARK_DAEMON_WORKSPACE must not overlap the running daemon directory');
  }
  if (pathsOverlap(workspace, dataDir)) {
    throw new Error('LARK_DAEMON_WORKSPACE must not overlap LARK_DAEMON_DATA_DIR');
  }

  return {
    projectDir,
    dataDir,
    databasePath: path.join(dataDir, 'lark-daemon.sqlite3'),
    lockPath: path.join(dataDir, 'daemon.lock'),
    tempDir: path.join(dataDir, 'tmp'),
    workspace,
    systemPromptPath: path.join(promptDir, 'system-prompt.md'),
    responseSchemaPath: path.join(promptDir, 'response.schema.json'),
    larkCliBin: process.env.LARK_CLI_BIN || '/opt/homebrew/bin/lark-cli',
    codexBin: process.env.CODEX_BIN || '/opt/homebrew/bin/codex',
    codexModel: process.env.LARK_DAEMON_CODEX_MODEL || '',
    codexEffort: enumEnv('LARK_DAEMON_CODEX_EFFORT', 'medium', ['minimal', 'low', 'medium', 'high', 'xhigh']),
    host,
    port: intEnv('LARK_DAEMON_PORT', 3738, { min: 1, max: 65535 }),
    httpEnabled: boolEnv('LARK_DAEMON_HTTP_ENABLED', true),
    logLevel: enumEnv('LARK_DAEMON_LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),
    eventMode,
    profile: process.env.LARK_DAEMON_PROFILE || '',
    ignoredSenderIds: csvEnv('LARK_DAEMON_IGNORED_SENDER_IDS'),
    allowedMessageTypes: csvEnv('LARK_DAEMON_ALLOWED_MESSAGE_TYPES').size > 0
      ? csvEnv('LARK_DAEMON_ALLOWED_MESSAGE_TYPES')
      : new Set(['text', 'post']),
    debounceMs: intEnv('LARK_DAEMON_DEBOUNCE_MS', 750, { min: 0, max: 30_000 }),
    freshnessGraceMs: intEnv('LARK_DAEMON_FRESHNESS_GRACE_MS', 600, { min: 0, max: 30_000 }),
    codexTimeoutMs: intEnv('LARK_DAEMON_CODEX_TIMEOUT_MS', 1_200_000, { min: 10_000 }),
    sendTimeoutMs: intEnv('LARK_DAEMON_SEND_TIMEOUT_MS', 30_000, { min: 1_000 }),
    shutdownTimeoutMs: intEnv('LARK_DAEMON_SHUTDOWN_TIMEOUT_MS', 20_000, { min: 5_000, max: 25_000 }),
    maxReplyChars: intEnv('LARK_DAEMON_MAX_REPLY_CHARS', 30_000, { min: 100, max: 100_000 }),
    maxEventBytes: intEnv('LARK_DAEMON_MAX_EVENT_BYTES', 1_000_000, { min: 1_024, max: 10_000_000 }),
    maxEventAgeMs: intEnv('LARK_DAEMON_MAX_EVENT_AGE_MS', 86_400_000, { min: 60_000 }),
    maxBatchSize: intEnv('LARK_DAEMON_MAX_BATCH_SIZE', 20, { min: 1, max: 100 }),
    maxQueuedPerConversation: intEnv('LARK_DAEMON_MAX_QUEUED_PER_CONVERSATION', 50, { min: 1, max: 1_000 }),
    maxQueuedTotal: intEnv('LARK_DAEMON_MAX_QUEUED_TOTAL', 500, { min: 1, max: 10_000 }),
    maxQueuedAgeMs: intEnv('LARK_DAEMON_MAX_QUEUED_AGE_MS', 600_000, { min: 60_000, max: 86_400_000 }),
    historyLimit: intEnv('LARK_DAEMON_HISTORY_LIMIT', 30, { min: 0, max: 200 }),
    retentionMs: intEnv('LARK_DAEMON_RETENTION_MS', 7_776_000_000, { min: 86_400_000 }),
    sendRetries: intEnv('LARK_DAEMON_SEND_RETRIES', 3, { min: 1, max: 10 }),
    uncertainAfterMs: intEnv('LARK_DAEMON_IDEMPOTENCY_WINDOW_MS', 3_300_000, { min: 60_000, max: 3_600_000 }),
    replyFormat: enumEnv('LARK_DAEMON_REPLY_FORMAT', 'text', ['text']),
    strictCliPreflight: boolEnv('LARK_DAEMON_STRICT_CLI_PREFLIGHT', true),
    dryRun: boolEnv('LARK_DAEMON_DRY_RUN', false),
  };
}

export function publicConfig(config) {
  return {
    projectDir: config.projectDir,
    dataDir: config.dataDir,
    workspace: config.workspace,
    host: config.host,
    port: config.port,
    httpEnabled: config.httpEnabled,
    eventMode: config.eventMode,
    debounceMs: config.debounceMs,
    freshnessGraceMs: config.freshnessGraceMs,
    dryRun: config.dryRun,
    maxQueuedPerConversation: config.maxQueuedPerConversation,
    maxQueuedTotal: config.maxQueuedTotal,
  };
}
