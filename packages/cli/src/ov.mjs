import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { t } from './i18n.mjs';
import { OVConnection, OVUnavailableError, readOVConfig } from '../../daemon/src/ov-connection.mjs';

// An explicit instance or environment config is authoritative. Never fall back
// to another identity when that config is missing, invalid, or unavailable.

export const LOCAL_OV_URL = 'http://127.0.0.1:1933';
// Volcengine's hosted OpenViking Service, the address `ov config` uses for it.
export const HOSTED_OV_URL = 'https://api.vikingdb.cn-beijing.volces.com/openviking';

export const savedOVConfigPath = (homeDir = os.homedir()) => path.join(homeDir, '.vika', 'ov-connection.json');

export async function detectOpenViking({ env = process.env, homeDir = os.homedir(), fetchImpl = globalThis.fetch, configPath, config: suppliedConfig } = {}) {
  const defaultPath = path.join(homeDir, '.openviking', 'ovcli.conf');
  const savedPath = savedOVConfigPath(homeDir);
  const selected = suppliedConfig ? null : configPath ?? ((env.OPENVIKING_CLI_CONFIG_FILE || '').trim()
    || (fs.existsSync(savedPath) ? savedPath : null) || (fs.existsSync(defaultPath) ? defaultPath : null));
  let config;
  let connection;
  let health;
  try {
    config = suppliedConfig ?? (selected ? readOVConfig(selected) : { url: LOCAL_OV_URL });
    connection = new OVConnection(config, { fetch: fetchImpl, timeoutMs: 3_000 });
    // Keep health separate so missing credentials don't look like a dead server.
    health = await connection.json('/health');
    const user = await connection.authenticate();
    if (!selected && !suppliedConfig && health.auth_mode !== 'dev') {
      return { configPath: null, url: connection.url, usable: false, user: null, authMode: health.auth_mode ?? null,
        reason: t('OpenViking 服务已启动，请配置身份信息和凭据', 'OpenViking is running; configure identity and credentials') };
    }
    // Under an API key the configured user is not who the server sees.
    return { configPath: selected, url: connection.url, usable: true,
      user: user ?? health.user_id ?? (health.auth_mode === 'api_key' ? null : config.user) ?? null,
      authMode: health.auth_mode ?? null, reason: null };
  } catch (error) {
    let reason;
    if (!(error instanceof OVUnavailableError)) {
      reason = t('OpenViking 配置文件缺失或格式无效', 'the OpenViking configuration file is missing or invalid');
    } else if (health && error.httpStatus === 400 && health.auth_mode === 'trusted' && (!config.account || !config.user)) {
      reason = t('OpenViking 服务已启动；Trusted 模式需要填写 Account 和 User，请手动配置或指定配置文件',
        'OpenViking is running; Trusted mode requires Account and User. Configure them manually or choose a configuration file');
    } else if (health && [401, 403].includes(error.httpStatus)) {
      reason = t(`OpenViking 服务已启动，但认证或权限检查失败（HTTP ${error.httpStatus}），请检查凭据和身份配置`,
        `OpenViking is running, but authentication or authorization failed (HTTP ${error.httpStatus}); check credentials and identity`);
    } else if (!health && [401, 403].includes(error.httpStatus)) {
      // The hosted service checks the key before it answers /health.
      reason = t(`OpenViking 拒绝了 API Key（HTTP ${error.httpStatus}），请检查 API Key 是否填写正确`,
        `OpenViking rejected the API key (HTTP ${error.httpStatus}); check that it is entered correctly`);
    } else if (health) {
      reason = error.httpStatus
        ? t(`OpenViking 健康检查通过，但身份检查失败（HTTP ${error.httpStatus}），请检查服务和配置`,
          `OpenViking health check passed, but the identity check failed (HTTP ${error.httpStatus}); check the service and configuration`)
        : t('OpenViking 健康检查通过，但身份检查没有完成（连不上、超时或服务还在初始化），请重试',
          'OpenViking health check passed, but the identity check did not finish (unreachable, timed out, or still starting); retry');
    } else {
      reason = error.httpStatus
        ? t(`OpenViking 健康检查失败（HTTP ${error.httpStatus}），请检查服务和配置`,
          `OpenViking health check failed (HTTP ${error.httpStatus}); check the service and configuration`)
        : t('OpenViking 服务不可用或 3 秒内未响应', 'OpenViking is unavailable or did not respond within 3 seconds');
    }
    return { configPath: selected, url: connection?.url ?? '', usable: false, user: null, authMode: health?.auth_mode ?? null,
      reason };
  }
}

// The instance's own copy: the user's connection plus actor_peer_id = the
// instance id, the agent identity OV keeps memories under (created on first use).
export function writeInstanceOvConfig({ detected, instanceId, target, exclusive = false }) {
  const source = detected.config ?? (detected.configPath ? readOVConfig(detected.configPath) : { url: detected.url });
  const config = { ...source, actor_peer_id: instanceId };
  delete config.agent_id;
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (exclusive) {
    fs.writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return target;
  }
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
  return target;
}
