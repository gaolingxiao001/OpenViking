'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSTANCE_ID = /^[a-z][a-z0-9-]{0,31}$/;

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

function getDeploymentConfig(env) {
  const id = required(env, 'LARK_DAEMON_INSTANCE_ID');
  if (!INSTANCE_ID.test(id) || id === 'all') {
    throw new Error(`LARK_DAEMON_INSTANCE_ID must match ${INSTANCE_ID} and cannot be all`);
  }
  const profile = required(env, 'LARK_DAEMON_PROFILE');
  const cliProfile = required(env, 'LARKSUITE_CLI_PROFILE');
  if (profile !== cliProfile) {
    throw new Error('LARK_DAEMON_PROFILE must match LARKSUITE_CLI_PROFILE');
  }
  const port = Number(required(env, 'LARK_DAEMON_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('LARK_DAEMON_PORT must be an integer between 1 and 65535');
  }
  return Object.freeze({
    id,
    label: (env.LARK_DAEMON_AGENT_NAME || id).trim() || id,
    profile,
    port,
    dataDir: absolutePath(env, 'LARK_DAEMON_DATA_DIR'),
    workspace: absolutePath(env, 'LARK_DAEMON_WORKSPACE'),
    ...(typeof env.LARK_DAEMON_CODEX_MODEL === 'string' && env.LARK_DAEMON_CODEX_MODEL.trim()
      ? { model: env.LARK_DAEMON_CODEX_MODEL.trim() }
      : {}),
    ...(typeof env.OPENVIKING_CLI_CONFIG_FILE === 'string' && env.OPENVIKING_CLI_CONFIG_FILE.trim()
      ? { ovConfig: absolutePath(env, 'OPENVIKING_CLI_CONFIG_FILE') }
      : {}),
  });
}

function updaterTargetsFor(instance) {
  return {
    [instance.id]: {
      app: `lark-daemon-${instance.id}`,
      readyUrl: `http://127.0.0.1:${instance.port}/ready`,
      upgradeSharedWeb: true,
    },
  };
}

module.exports = {
  getDeploymentConfig,
  loadDeploymentEnv,
  updaterTargetsFor,
};
