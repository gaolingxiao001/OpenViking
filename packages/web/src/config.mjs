import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
export const moduleDir = path.resolve(sourceDir, '..');
export const publicDir = path.join(moduleDir, 'public');

function intEnv(name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || String(value) !== raw.trim()
    || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function enumEnv(name, fallback, allowed) {
  const value = process.env[name] || fallback;
  if (!allowed.includes(value)) {
    throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

function assertLoopbackHost(name, host) {
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error(`${name} must be a loopback address`);
  }
}

export function getConfig() {
  const host = process.env.LARK_WEB_HOST || '127.0.0.1';
  const port = intEnv('LARK_WEB_PORT', 3737, { min: 1, max: 65535 });
  const daemonHost = process.env.LARK_WEB_DAEMON_HOST || '127.0.0.1';
  const daemonPort = intEnv('LARK_WEB_DAEMON_PORT', 3738, { min: 1, max: 65535 });
  assertLoopbackHost('LARK_WEB_HOST', host);
  assertLoopbackHost('LARK_WEB_DAEMON_HOST', daemonHost);
  if (port === daemonPort) {
    throw new Error('LARK_WEB_PORT and LARK_WEB_DAEMON_PORT must be different');
  }

  return {
    host,
    port,
    daemonHost,
    daemonPort,
    publicDir,
    upstreamTimeoutMs: intEnv('LARK_WEB_DAEMON_TIMEOUT_MS', 3_000, { min: 100, max: 30_000 }),
    shutdownTimeoutMs: intEnv('LARK_WEB_SHUTDOWN_TIMEOUT_MS', 5_000, { min: 1_000, max: 30_000 }),
    logLevel: enumEnv('LARK_WEB_LOG_LEVEL', 'info', ['debug', 'info', 'warn', 'error']),
  };
}

export function publicConfig(config) {
  return {
    host: config.host,
    port: config.port,
    daemonHost: config.daemonHost,
    daemonPort: config.daemonPort,
    upstreamTimeoutMs: config.upstreamTimeoutMs,
  };
}
