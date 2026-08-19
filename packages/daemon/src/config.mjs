import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const moduleDir = path.resolve(sourceDir, '..');
export const projectDir = path.resolve(moduleDir, '..', '..');

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

function jsonStringArrayEnv(name, fallback = []) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  let value;
  try { value = JSON.parse(raw); } catch {
    throw new Error(`${name} must be a JSON string array`);
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${name} must be a JSON string array`);
  }
  return value;
}

function assertLoopbackHost(host) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('LARK_DAEMON_HOST must be a loopback address');
  }
}

function privateRegularFileEnv(name) {
  const raw = (process.env[name] ?? '').trim();
  if (!raw || !path.isAbsolute(raw)) throw new Error(`${name} must be an absolute path`);
  const resolved = path.normalize(raw);
  const info = fs.lstatSync(resolved);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${name} must be a regular file`);
  if ((info.mode & 0o077) !== 0) throw new Error(`${name} must have mode 0600`);
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    throw new Error(`${name} must be owned by the daemon user`);
  }
  return resolved;
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
  const meetingAudioEnabled = boolEnv('LARK_DAEMON_MEETING_AUDIO_ENABLED', false);
  const daemonProfile = (process.env.LARK_DAEMON_PROFILE ?? '').trim();
  const cliProfile = (process.env.LARKSUITE_CLI_PROFILE ?? '').trim();
  if (daemonProfile && cliProfile && daemonProfile !== cliProfile) {
    throw new Error('LARK_DAEMON_PROFILE must match LARKSUITE_CLI_PROFILE');
  }
  const volcBaseUrl = (process.env.LARK_DAEMON_VOLC_BASE_URL
    || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  let parsedVolcBaseUrl;
  try { parsedVolcBaseUrl = new URL(volcBaseUrl); } catch {
    throw new Error('LARK_DAEMON_VOLC_BASE_URL must be a valid HTTPS URL');
  }
  if (parsedVolcBaseUrl.protocol !== 'https:') {
    throw new Error('LARK_DAEMON_VOLC_BASE_URL must be a valid HTTPS URL');
  }
  let meetingAudio = null;
  if (meetingAudioEnabled) {
    const workerCommand = (process.env.LARK_DAEMON_MEETING_AUDIO_WORKER_COMMAND ?? '').trim();
    if (!workerCommand) {
      throw new Error('LARK_DAEMON_MEETING_AUDIO_WORKER_COMMAND is required when meeting audio is enabled');
    }
    const asrConfigFile = privateRegularFileEnv('LARK_DAEMON_MEETING_AUDIO_ASR_CONFIG_FILE');
    const workerArgs = jsonStringArrayEnv('LARK_DAEMON_MEETING_AUDIO_WORKER_ARGS_JSON');
    if (workerArgs.includes('--config')) {
      throw new Error('LARK_DAEMON_MEETING_AUDIO_WORKER_ARGS_JSON must not contain --config; use LARK_DAEMON_MEETING_AUDIO_ASR_CONFIG_FILE');
    }
    meetingAudio = Object.freeze({
      workerCommand,
      asrConfigFile,
      workerArgs: Object.freeze([...workerArgs, '--config', asrConfigFile]),
      workerCwd: path.resolve(process.env.LARK_DAEMON_MEETING_AUDIO_WORKER_CWD || projectDir),
      spoolPath: path.join(dataDir, 'meeting-audio-spool.sqlite3'),
      authoritySocketPath: path.join(dataDir, 'meeting-audio-authority.sock'),
      capabilityTtlMs: intEnv('LARK_DAEMON_MEETING_AUDIO_CAPABILITY_TTL_MS', 120_000, {
        min: 5_000,
        max: 300_000,
      }),
      flyReferenceTtlMs: intEnv('LARK_DAEMON_MEETING_AUDIO_FLY_TTL_MS', 600_000, {
        min: 60_000,
        max: 3_600_000,
      }),
    });
  }

  return {
    projectDir,
    dataDir,
    databasePath: path.join(dataDir, 'lark-daemon.sqlite3'),
    lockPath: path.join(dataDir, 'daemon.lock'),
    tempDir: path.join(dataDir, 'tmp'),
    workspace,
    systemPromptPath: path.join(promptDir, 'system-prompt.md'),
    openVikingConfigPath: (process.env.OPENVIKING_CLI_CONFIG_FILE || '').trim(),
    harnessPromptPath: path.join(promptDir, 'harness.md'),
    openVikingPromptPath: path.join(promptDir, 'openviking.md'),
    meetingAudioPromptPath: path.join(promptDir, 'meeting-audio.md'),
    teamTaskBoardUrl: process.env.TEAM_TASK_BOARD_URL || '',
    agentName: process.env.LARK_DAEMON_AGENT_NAME || process.env.LARK_DAEMON_INSTANCE_ID || 'Agent',
    instanceId: process.env.LARK_DAEMON_INSTANCE_ID || '',
    upgradeTarget: process.env.LARK_DAEMON_UPGRADE_TARGET || process.env.LARK_DAEMON_INSTANCE_ID || '',
    larkToolServerPath: path.join(sourceDir, 'lark-tools.mjs'),
    larkCliBin: process.env.LARK_CLI_BIN || '/opt/homebrew/bin/lark-cli',
    codexBin: process.env.CODEX_BIN || '/opt/homebrew/bin/codex',
    claudeBin: process.env.CLAUDE_BIN || 'claude',
    initialModel: process.env.LARK_DAEMON_MODEL || process.env.LARK_DAEMON_CODEX_MODEL || '',
    codexModel: process.env.LARK_DAEMON_MODEL === 'ark'
      ? ''
      : process.env.LARK_DAEMON_CODEX_MODEL || '',
    codexEffort: enumEnv('LARK_DAEMON_CODEX_EFFORT', 'medium', ['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
    claudeModel: process.env.LARK_DAEMON_CLAUDE_MODEL || '',
    claudeEffort: enumEnv('LARK_DAEMON_CLAUDE_EFFORT', 'medium', ['low', 'medium', 'high', 'xhigh', 'max']),
    volcApiKey: process.env.ARK_API_KEY || '',
    volcSessionId: process.env.LARK_DAEMON_VOLC_SESSION_ID
      || process.env.ARK_SESSION_ID
      || process.env.SESSION_ID
      || '',
    volcBaseUrl,
    volcRequestTimeoutMs: intEnv('LARK_DAEMON_VOLC_REQUEST_TIMEOUT_MS', 30_000, {
      min: 1_000,
      max: 300_000,
    }),
    volcStreamIdleTimeoutMs: intEnv('LARK_DAEMON_VOLC_STREAM_IDLE_TIMEOUT_MS', 900_000, {
      min: 30_000,
      max: 3_600_000,
    }),
    // Codex model the daemon auto-switches to when a claude turn fails.
    fallbackModel: process.env.FALLBACK_MODEL || 'gpt-5.6-sol',
    host,
    port: intEnv('LARK_DAEMON_PORT', 3738, { min: 1, max: 65535 }),
    httpEnabled: boolEnv('LARK_DAEMON_HTTP_ENABLED', true),
    logLevel: enumEnv('LARK_DAEMON_LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),
    eventMode,
    profile: daemonProfile || cliProfile,
    ignoredSenderIds: csvEnv('LARK_DAEMON_IGNORED_SENDER_IDS'),
    sendTimeoutMs: intEnv('LARK_DAEMON_SEND_TIMEOUT_MS', 30_000, { min: 1_000 }),
    shutdownTimeoutMs: intEnv('LARK_DAEMON_SHUTDOWN_TIMEOUT_MS', 20_000, { min: 5_000, max: 25_000 }),
    maxReplyChars: intEnv('LARK_DAEMON_MAX_REPLY_CHARS', 30_000, { min: 100, max: 100_000 }),
    maxEventBytes: intEnv('LARK_DAEMON_MAX_EVENT_BYTES', 1_000_000, { min: 1_024, max: 10_000_000 }),
    maxEventAgeMs: intEnv('LARK_DAEMON_MAX_EVENT_AGE_MS', 86_400_000, { min: 60_000 }),
    idleReactionAfterMs: intEnv('LARK_DAEMON_IDLE_REACTION_AFTER_MS', 600_000, {
      min: 0,
      max: 604_800_000,
    }),
    historyLimit: intEnv('LARK_DAEMON_HISTORY_LIMIT', 30, { min: 0, max: 200 }),
    cognitionMaxChars: intEnv('LARK_DAEMON_COGNITION_MAX_CHARS', 120_000, { min: 10_000, max: 1_000_000 }),
    retentionMs: intEnv('LARK_DAEMON_RETENTION_MS', 7_776_000_000, { min: 86_400_000 }),
    dryRun: boolEnv('LARK_DAEMON_DRY_RUN', false),
    meetingAudio,
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
    dryRun: config.dryRun,
  };
}
