import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from './i18n.mjs';

// OpenViking is optional in setup. Look where the OV installer and `ov` CLI
// look: OPENVIKING_CLI_CONFIG_FILE, then ~/.openviking/ovcli.conf, then a
// local server on the default port. GET /health needs no credentials and
// reports auth_mode; with credentials it also reports who the key belongs to.

export const LOCAL_OV_URL = 'http://127.0.0.1:1933';

function readConfig(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function credentialHeaders(config) {
  const headers = {};
  if (config.api_key) headers['X-API-Key'] = config.api_key;
  if (config.account) headers['X-OpenViking-Account'] = config.account;
  if (config.user) headers['X-OpenViking-User'] = config.user;
  return headers;
}

async function health(url, headers, fetchImpl) {
  try {
    const response = await fetchImpl(`${url.replace(/\/$/, '')}/health`, {
      headers, signal: AbortSignal.timeout(3_000), redirect: 'error',
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.status !== 'ok') return { ok: false, reason: t(`健康检查返回 HTTP ${response.status}`, `its health check says HTTP ${response.status}`) };
    return { ok: true, authMode: body.auth_mode ?? null, user: body.user_id ?? null, version: body.version ?? null };
  } catch (error) {
    return { ok: false, reason: error?.name === 'TimeoutError' ? t('3 秒内没有响应', 'no answer within 3 seconds') : t('连不上', 'cannot connect') };
  }
}

// { configPath, url, usable, user, authMode, reason } or null when nothing is there.
export async function detectOpenViking({ env = process.env, homeDir = os.homedir(), fetchImpl = globalThis.fetch } = {}) {
  const candidates = [env.OPENVIKING_CLI_CONFIG_FILE, path.join(homeDir, '.openviking', 'ovcli.conf')]
    .map((value) => String(value || '').trim()).filter(Boolean);
  for (const configPath of candidates) {
    const config = readConfig(configPath);
    if (!config) continue;
    const url = String(config.url || LOCAL_OV_URL);
    const probe = await health(url, credentialHeaders(config), fetchImpl);
    return {
      configPath, url, usable: probe.ok,
      user: probe.user ?? config.user ?? null,
      authMode: probe.authMode ?? null,
      reason: probe.ok ? null : probe.reason,
    };
  }
  const local = await health(LOCAL_OV_URL, {}, fetchImpl);
  if (!local.ok) return null;
  // Without a config file only a dev-mode server is usable: it takes no key.
  return {
    configPath: null, url: LOCAL_OV_URL, usable: local.authMode === 'dev',
    user: null, authMode: local.authMode,
    reason: local.authMode === 'dev' ? null : t('需要凭据：先用 OpenViking 的安装程序生成 ~/.openviking/ovcli.conf',
      'it needs credentials: create ~/.openviking/ovcli.conf with the OpenViking installer'),
  };
}

// The instance's own copy: the user's connection plus actor_peer_id = the
// instance id, the agent identity OV keeps memories under (created on first use).
export function writeInstanceOvConfig({ detected, instanceId, target }) {
  const source = detected.configPath ? readConfig(detected.configPath) ?? {} : { url: detected.url };
  const config = { ...source, actor_peer_id: instanceId };
  delete config.agent_id;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}
