import { spawnSync } from 'node:child_process';
import fs from 'node:fs';

// OpenViking stays outside the daemon process except for one start-time
// identity read. Agents still reach the rest through skill and MCP tools.

export function isOpenVikingEnvKey(name) {
  return typeof name === 'string' && name.startsWith('OPENVIKING_');
}

export function openVikingChildEnv(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment || {}).filter(([key]) => isOpenVikingEnvKey(key)),
  );
}

export function applyOpenVikingChildEnv(target, environment = process.env) {
  const next = { ...target };
  for (const key of Object.keys(next)) {
    if (isOpenVikingEnvKey(key)) delete next[key];
  }
  return Object.assign(next, openVikingChildEnv(environment));
}

export function openVikingConfigPath(config = {}, environment = process.env) {
  return String(config.openVikingConfigPath || environment.OPENVIKING_CLI_CONFIG_FILE || '').trim();
}

export function openVikingUserId(config = {}, environment = process.env) {
  const filePath = openVikingConfigPath(config, environment);
  if (!filePath) return '';
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return String(parsed.user || '').trim();
  } catch {
    return '';
  }
}

export function openVikingIdentityUris(user) {
  const id = String(user || '').trim();
  if (!id) return [];
  return [
    `viking://user/${id}/identity.md`,
    `viking://user/${id}/memories/identity.md`,
  ];
}

export function readOpenVikingResource(uri, {
  ovBin = 'ov',
  env = process.env,
  timeoutMs = 5_000,
} = {}) {
  if (!uri) return '';
  let result;
  try {
    result = spawnSync(ovBin, ['read', uri], {
      encoding: 'utf8',
      env,
      timeout: timeoutMs,
    });
  } catch {
    return '';
  }
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

export function loadOpenVikingIdentity(config = {}, options = {}) {
  const env = options.env || process.env;
  const user = openVikingUserId(config, env);
  const uris = openVikingIdentityUris(user);
  if (!uris.length) return { user: '', uri: '', text: '' };
  const read = options.readResource || readOpenVikingResource;
  for (const uri of uris) {
    const text = String(read(uri, { ...options, env }) || '').trim();
    if (text) return { user, uri, text };
  }
  return { user, uri: uris[0], text: '' };
}
