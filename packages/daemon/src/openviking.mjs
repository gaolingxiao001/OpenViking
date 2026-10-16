import fs from 'node:fs';

// OpenViking stays outside the daemon process except for an opt-in start-time
// identity read over OV HTTP. Agents still reach the rest through skill and
// MCP tools.

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

// identity.md first. A missing file falls through to the next URI; any other
// failure is the caller's to report.
export async function loadOpenVikingIdentity(config = {}, { client, env = process.env } = {}) {
  const user = openVikingUserId(config, env);
  const uris = openVikingIdentityUris(user);
  for (const uri of uris) {
    let content;
    try {
      content = await client.read(uri, 0, -1);
    } catch (error) {
      if (error.httpStatus === 404) continue;
      throw error;
    }
    const text = typeof content === 'string' ? content.trim() : '';
    if (text) return { user, uri, text };
  }
  return { user, uri: uris[0] ?? '', text: '' };
}
