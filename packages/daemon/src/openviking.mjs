// Session transport lives in ov-session-context; agents use skill/MCP tools
// for every other memory operation.

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
