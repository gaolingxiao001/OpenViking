import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { managedPiBin } from '../../daemon/src/pi-runtime.mjs';
import { t } from './i18n.mjs';
import { probeAppServer } from './runtime-probe.mjs';

// Setup only checks the agent runtimes; installing and logging in to them is
// the user's business. Pi ships with Vika and reuses the user's ~/.pi/agent.

const execFile = promisify(execFileCallback);

export function which(command, env = process.env) {
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, command);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

async function run(execFileImpl, command, args, env) {
  try {
    const { stdout } = await execFileImpl(command, args, { env, timeout: 20_000 });
    return { ok: true, stdout: String(stdout) };
  } catch (error) {
    return { ok: false, stdout: String(error?.stdout ?? '') };
  }
}

// [{ id, label, model, bin, binEnv, available, note }], in the order setup offers them.
export async function detectRuntimes({ env = process.env, execFileImpl = execFile, piBin = managedPiBin(), probe = probeAppServer } = {}) {
  const runtimes = [];

  const codex = which('codex', env);
  const codexLogin = codex ? await run(execFileImpl, codex, ['login', 'status'], env) : null;
  runtimes.push({
    id: 'codex', label: 'Codex', model: 'codex:', bin: codex, binEnv: 'CODEX_BIN',
    available: Boolean(codexLogin?.ok),
    note: !codex ? t('未安装', 'not installed') : codexLogin.ok ? t('已登录', 'logged in') : t('未登录：先运行 codex login', 'not logged in: run codex login first'),
  });

  const claude = which('claude', env);
  const claudeStatus = claude ? await run(execFileImpl, claude, ['auth', 'status'], env) : null;
  let claudeLoggedIn = false;
  try { claudeLoggedIn = JSON.parse(claudeStatus?.stdout || '{}').loggedIn === true; } catch {}
  runtimes.push({
    id: 'claude', label: 'Claude Code', model: 'claude:', bin: claude, binEnv: 'CLAUDE_BIN',
    available: claudeLoggedIn,
    note: !claude ? t('未安装', 'not installed') : claudeLoggedIn ? t('已登录', 'logged in') : t('未登录：先运行 claude auth login', 'not logged in: run claude auth login first'),
  });

  const piModels = await run(execFileImpl, process.execPath, [piBin, '--list-models'], { ...env, PI_OFFLINE: '1' });
  const models = piModels.stdout.split('\n').slice(1).map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 2).map(([provider, model]) => `${provider}/${model}`);
  runtimes.push({
    id: 'pi', label: t('Pi（内置）', 'Pi (built in)'), model: 'pi', bin: null, binEnv: null,
    available: models.length > 0,
    note: models.length > 0 ? t(`用 ~/.pi/agent 里的 ${models[0]}`, `uses ${models[0]} from ~/.pi/agent`)
      : t('没有可用模型：运行 vika pi 后 /login，或编辑 ~/.pi/agent/models.json', 'no model yet: run vika pi and /login, or edit ~/.pi/agent/models.json'),
  });

  const traex = await detectTraex({ env, execFileImpl, probe });
  if (traex) runtimes.push(traex);
  return runtimes;
}

async function detectTraex({ env, execFileImpl, probe }) {
  // A configured binary is authoritative. Do not silently replace it with an
  // unrelated login/configuration from PATH when it fails verification.
  const explicit = env.TRAEX_BIN?.trim() || env.TRAECLI_BIN?.trim();
  const candidates = explicit ? [explicit] : [which('traex', env), which('traecli', env)].filter(Boolean);
  const seen = new Set();
  let best = null;
  for (const candidate of candidates) {
    const located = path.isAbsolute(candidate) || candidate.includes(path.sep) ? path.resolve(candidate) : which(candidate, env);
    let bin = located || candidate;
    let installed = false;
    try {
      if (located) {
        fs.accessSync(located, fs.constants.X_OK);
        installed = fs.statSync(located).isFile();
        if (installed) bin = fs.realpathSync(located);
      }
    } catch {}
    if (seen.has(bin)) continue;
    seen.add(bin);
    const result = {
      id: 'traex', label: 'TraeX', model: 'traex', bin, binEnv: 'TRAECLI_BIN',
      installed, protocolCompatible: false, loggedIn: false, available: false,
      note: t(`找不到可执行文件：${candidate}`, `Executable not found: ${candidate}`),
    };
    if (installed) {
      const protocol = await probe(bin, { env });
      result.protocolCompatible = protocol.compatible;
      if (!protocol.compatible) {
        result.note = t(`不支持 Vika 所需的 app-server 握手：${bin}；请安装或选择 TRAE CLI 2.0（保留 Coco 时用 traex）`,
          `Required app-server handshake failed: ${bin}; install/select TRAE CLI 2.0 (use traex when keeping Coco)`);
        if (protocol.reason) result.note += ` (${protocol.reason})`;
      } else {
        const login = await run(execFileImpl, bin, ['login', 'status'], env);
        result.loggedIn = login.ok;
        result.available = login.ok;
        result.note = login.ok ? t('协议兼容，已登录', 'Protocol compatible, logged in')
          : t(`协议兼容，但登录检查未通过：运行 ${bin} login`, `Protocol compatible, but login check failed: run ${bin} login`);
      }
    }
    if (result.available) return result;
    if (!best || result.protocolCompatible) best = result;
  }
  return best;
}
