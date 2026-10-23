import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { OVConnection, readOVConfig } from '../../daemon/src/ov-connection.mjs';
import { availableInstanceOvConfig } from './manifest.mjs';
import { HOSTED_OV_URL, LOCAL_OV_URL, detectOpenViking, savedOVConfigPath, writeInstanceOvConfig } from './ov.mjs';
import { GoBack, PromptAborted } from './prompt.mjs';
import { t } from './i18n.mjs';

// Only display the address, never URL credentials or a query string.
function address(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/$/, '')}`;
  } catch { return t('地址未配置', 'no address configured'); }
}

function sourceConfig(detected) {
  return detected.config ?? (detected.configPath ? readOVConfig(detected.configPath) : { url: detected.url });
}

const canonical = (value) => (Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
    : value);

// Everything an instance copy takes from a config: all of it but the identity
// the copy replaces. Null for a file that cannot be read.
function connectionKey(configPath) {
  let config;
  try { config = { ...readOVConfig(configPath) }; } catch { return null; }
  delete config.actor_peer_id;
  delete config.agent_id;
  config.url = String(config.url ?? '').replace(/\/+$/, '');
  return JSON.stringify(canonical(config));
}

export async function discoverOpenViking({
  env = process.env, homeDir = env.HOME || os.homedir(), fetchImpl = globalThis.fetch,
  preferredConfigPath, detect = detectOpenViking,
} = {}) {
  const sources = [];
  const seen = new Set();
  const add = (configPath, label) => {
    if (!configPath || seen.has(configPath)) return;
    seen.add(configPath);
    sources.push({ configPath, label });
  };
  // Labels say what choosing does, not where a file lives.
  add(preferredConfigPath, t('保持现在的连接', 'Keep the current connection'));
  add((env.OPENVIKING_CLI_CONFIG_FILE || '').trim(),
    t('用环境变量 OPENVIKING_CLI_CONFIG_FILE 指的配置', 'Use the config OPENVIKING_CLI_CONFIG_FILE points to'));
  for (const [file, label] of [
    [savedOVConfigPath(homeDir), t('用上次在 setup 里填的连接', 'Use the connection entered in setup last time')],
    [path.join(homeDir, '.openviking', 'ovcli.conf'), t('用 OpenViking 命令行的配置', 'Use the OpenViking CLI’s config')],
  ]) if (fs.existsSync(file)) add(file, label);
  // Choosing either of two identical connections gives the instance the same
  // config (its own identity is kept), so only the first is offered.
  const keys = new Set();
  const unique = sources.filter(({ configPath }) => {
    const key = connectionKey(configPath);
    if (key === null) return true;
    if (keys.has(key)) return false;
    keys.add(key);
    return true;
  });
  // Only the instance being edited may contribute a private config.
  const candidates = await Promise.all(unique.map(async (source) => ({
    ...await detect({ env, homeDir, fetchImpl, ...source }), ...source,
  })));
  // A configured local connection already checks this service with its identity.
  // Probing it again without credentials produces misleading Trusted-mode errors.
  if (!candidates.some(({ url }) => url === LOCAL_OV_URL)) {
    const source = { label: t('用本机默认地址（不带凭据）', 'Use the local default address (no credentials)'), config: { url: LOCAL_OV_URL } };
    const result = await detect({ env, homeDir, fetchImpl, ...source });
    if (result.usable && result.authMode !== 'dev') {
      result.usable = false;
      result.reason = t('OpenViking 服务已启动，请配置身份信息和凭据', 'OpenViking is running; configure identity and credentials');
    }
    candidates.push({ ...result, ...source });
  }
  return candidates;
}

// Where it goes, who it logs in as, and whether it works or why not.
function describe(candidate) {
  const where = address(candidate.url || candidate.config?.url);
  if (!candidate.usable) return `${where} · ${candidate.reason ?? t('不可用', 'unavailable')}`;
  return `${where}${candidate.user ? ` · user=${candidate.user}` : ''} · ${t('可用', 'ready')}`;
}

async function manualConfig(prompter, previous = {}) {
  const config = { ...previous };
  delete config.api_key;
  config.url = await prompter.text(t('OpenViking URL（支持远端地址和自定义端口）', 'OpenViking URL (remote hosts and custom ports supported)'), {
    initial: previous.url ? address(previous.url) : LOCAL_OV_URL,
    validate: (url) => {
      try { new OVConnection({ url }); return null; } catch {
        return t('请输入有效的 http:// 或 https:// 地址；凭据请在后续步骤填写', 'Enter a valid http:// or https:// URL; enter credentials in the following steps');
      }
    },
  });
  // Never carry a credential or an identity to a different address without
  // the owner's input: another server's user would name a private area this
  // one refuses.
  const sameServer = config.url === previous.url;
  const credential = await prompter.select(t('API Key', 'API key'), [
    ...(previous.api_key && sameServer ? [{ label: t('保留已配置的密钥', 'Keep the configured key'), value: 'keep' }] : []),
    { label: t('输入 API Key', 'Enter an API key'), value: 'enter' },
    { label: t('服务不需要 API Key', 'The service does not require an API key'), value: 'none' },
  ]);
  if (credential === 'keep') config.api_key = previous.api_key;
  if (credential === 'enter') config.api_key = await prompter.secret(t('API Key（隐藏输入）', 'API key (hidden input)'));
  for (const [key, label] of [['account', 'Account'], ['user', 'User'], ['agent', 'Agent']]) {
    const value = await prompter.text(t(`${label}（可选；回车沿用默认值，输入 - 清空）`, `${label} (optional; Enter keeps the default, - clears it)`), {
      initial: sameServer ? previous[key] || '' : '',
    });
    if (value && value !== '-') config[key] = value;
    else delete config[key];
  }
  return config;
}

// The hosted service has one address and takes identity from the key alone.
async function hostedConfig(prompter, previous = {}) {
  const config = previous.url === HOSTED_OV_URL ? { ...previous } : { url: HOSTED_OV_URL };
  for (const key of ['api_key', 'account', 'user', 'agent']) delete config[key];
  const keep = previous.url === HOSTED_OV_URL && previous.api_key
    && await prompter.select(t('API Key', 'API key'), [
      { label: t('保留已配置的密钥', 'Keep the configured key'), value: true },
      { label: t('输入 API Key', 'Enter an API key'), value: false },
    ]);
  config.api_key = keep ? previous.api_key : await prompter.secret(
    t('API Key（OpenViking 控制台 → 用户管理 → API Key；隐藏输入）',
      'API key (OpenViking console → User management → API Key; hidden input)'));
  return config;
}

// An API key alone decides who a request runs as; the server ignores Account
// and User headers. Keep the user the key logs in as, which names the
// instance's private area (mail archive paths), instead of a typed or stale one.
function keyIdentity(config, result) {
  if (result.authMode !== 'api_key' || !result.user) return config;
  const { account: _account, ...rest } = config;
  return { ...rest, user: result.user };
}

// Always offer both manual entry and importing a file, even if discovery found
// a healthy connection. Failures return to the menu; nothing is persisted here.
// `canGoBack` lets ← leave the menu; `leaveTo` names where its last option goes
// back to, instead of quitting setup. `previous` is what the menu returned
// before, offered again when ← comes back to it.
export async function configureOpenViking({
  prompter, env = process.env, homeDir = env.HOME || os.homedir(), fetchImpl = globalThis.fetch,
  preferredConfigPath, detect = detectOpenViking, title = 'OpenViking', canGoBack = false, leaveTo = null, previous = null,
} = {}) {
  if (title) prompter.section(title);
  const options = { env, homeDir, fetchImpl, preferredConfigPath, detect };
  let candidates = await discoverOpenViking(options);
  let draft;
  try {
    draft = previous ? structuredClone(previous.config)
      : sourceConfig((preferredConfigPath && candidates.find((entry) => entry.configPath === preferredConfigPath))
        || candidates.find((entry) => entry.usable) || candidates[0]);
  } catch { draft = {}; }
  for (;;) {
    const before = { hosted: candidates.length, manual: candidates.length + 1, file: candidates.length + 2 }[previous?.via]
      ?? candidates.findIndex(({ label }) => label === previous?.via);
    const ready = candidates.findIndex(({ usable }) => usable);
    const choice = await prompter.select(t('选择 OpenViking 连接', 'Choose an OpenViking connection'), [
      ...candidates.map((candidate) => ({ label: candidate.label, hint: describe(candidate), value: candidate })),
      { label: t('火山引擎 OpenViking 托管服务', 'OpenViking Service on Volcengine'),
        hint: t('只需填写 API Key', 'API key only'), value: 'hosted' },
      { label: t('手动填写／修改地址和凭据', 'Enter or edit the address and credentials'), value: 'manual' },
      { label: t('指定 OV 配置文件', 'Choose an OV configuration file'), value: 'file' },
      { label: t('重新检测', 'Detect again'), value: 'retry' },
      { label: leaveTo ?? t('退出', 'Exit'), value: 'exit' },
    ], { back: canGoBack, initial: [before, ready].find((index) => index >= 0) ?? candidates.length });
    if (choice === 'exit') throw leaveTo ? new GoBack() : new PromptAborted();
    if (choice === 'retry') { candidates = await discoverOpenViking(options); continue; }
    try {
      let configPath = null;
      let config;
      let via = choice;
      if (choice === 'hosted') {
        draft = await hostedConfig(prompter, draft);
        config = draft;
      } else if (choice === 'manual') {
        draft = await manualConfig(prompter, draft);
        config = draft;
      } else if (choice === 'file') {
        const input = await prompter.text(t('OV 配置文件路径', 'OV configuration file path'), {
          initial: previous?.via === 'file' ? previous.configPath : undefined,
          validate: (value) => value ? null : t('请输入配置文件路径', 'Enter a configuration file path'),
        });
        configPath = path.resolve(input === '~' ? homeDir : input.replace(/^~(?=\/)/, homeDir));
        config = readOVConfig(configPath);
      } else {
        configPath = choice.configPath ?? null;
        config = sourceConfig(choice);
        via = choice.label;
      }
      const result = await detect({ env, homeDir, fetchImpl, config });
      if (!result?.usable) {
        prompter.warn(t(`OpenViking 验证失败：${result?.reason ?? '检查失败'}。请修改配置或重试。`,
          `OpenViking check failed: ${result?.reason ?? 'check failed'}. Edit the configuration or retry.`));
        continue;
      }
      prompter.success(t(`OpenViking 连接已验证：${address(result.url || config.url)}`, `OpenViking connection verified: ${address(result.url || config.url)}`));
      return { ...result, configPath, config: keyIdentity(structuredClone(config), result), via };
    } catch (error) {
      if (error instanceof PromptAborted) throw error;
      if (!(error instanceof GoBack)) prompter.warn(t('无法读取 OV 配置，请检查文件路径和 JSON 格式后重试。',
        'Cannot read the OV configuration; check the file path and JSON format, then retry.'));
    }
  }
}

// The connection offered to the next new instance. A file new instances find
// anyway is not copied: the copy would go stale and still be found first.
export function saveOVConnection(detected, { env = process.env, homeDir = env.HOME || os.homedir() } = {}) {
  const target = savedOVConfigPath(homeDir);
  const found = [(env.OPENVIKING_CLI_CONFIG_FILE || '').trim(), target, path.join(homeDir, '.openviking', 'ovcli.conf')];
  if (detected.configPath && found.includes(detected.configPath)) return null;
  const config = { ...sourceConfig(detected) };
  delete config.actor_peer_id;
  delete config.agent_id;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, target);
  } finally { fs.rmSync(temporary, { force: true }); }
  return target;
}

// A changed connection gets a new private file. Existing files are left intact
// until the caller saves the manifest; cancelling only removes pending files.
export async function prepareInstanceOpenViking({
  agent, detected, pending, env, homeDir, fetchImpl, detect = detectOpenViking, reserved = new Set(),
}) {
  if (agent.ovConfig && detected.configPath === agent.ovConfig) return agent.ovConfig;
  const target = availableInstanceOvConfig(env, agent.id, reserved);
  let actor = agent.id;
  try { actor = readOVConfig(agent.ovConfig).actor_peer_id || agent.id; } catch {}
  writeInstanceOvConfig({ detected, instanceId: actor, target, exclusive: true });
  pending.add(target);
  const checked = await detect({ env, homeDir, fetchImpl, configPath: target });
  if (!checked?.usable) throw new Error(t(`OpenViking（${agent.id}）不可用：${checked?.reason ?? '检查失败'}`,
    `OpenViking (${agent.id}) is unavailable: ${checked?.reason ?? 'check failed'}`));
  return target;
}
