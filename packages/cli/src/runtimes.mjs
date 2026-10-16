import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { managedPiBin } from '../../daemon/src/pi-runtime.mjs';

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
export async function detectRuntimes({ env = process.env, execFileImpl = execFile, piBin = managedPiBin() } = {}) {
  const runtimes = [];

  const codex = which('codex', env);
  const codexLogin = codex ? await run(execFileImpl, codex, ['login', 'status'], env) : null;
  runtimes.push({
    id: 'codex', label: 'Codex', model: 'codex:', bin: codex, binEnv: 'CODEX_BIN',
    available: Boolean(codexLogin?.ok),
    note: !codex ? '未安装' : codexLogin.ok ? '已登录' : '未登录：先运行 codex login',
  });

  const claude = which('claude', env);
  const claudeStatus = claude ? await run(execFileImpl, claude, ['auth', 'status'], env) : null;
  let claudeLoggedIn = false;
  try { claudeLoggedIn = JSON.parse(claudeStatus?.stdout || '{}').loggedIn === true; } catch {}
  runtimes.push({
    id: 'claude', label: 'Claude Code', model: 'claude:', bin: claude, binEnv: 'CLAUDE_BIN',
    available: claudeLoggedIn,
    note: !claude ? '未安装' : claudeLoggedIn ? '已登录' : '未登录：先运行 claude auth login',
  });

  const piModels = await run(execFileImpl, process.execPath, [piBin, '--list-models'], { ...env, PI_OFFLINE: '1' });
  const models = piModels.stdout.split('\n').slice(1).map((line) => line.trim().split(/\s+/))
    .filter((columns) => columns.length >= 2).map(([provider, model]) => `${provider}/${model}`);
  runtimes.push({
    id: 'pi', label: 'Pi（内置）', model: 'pi', bin: null, binEnv: null,
    available: models.length > 0,
    note: models.length > 0 ? `用 ~/.pi/agent 里的 ${models[0]}` : '没有可用模型：运行 vika pi 后 /login，或编辑 ~/.pi/agent/models.json',
  });

  const traex = which('traecli', env);
  if (traex) {
    runtimes.push({
      id: 'traex', label: 'TraeX', model: 'traex', bin: traex, binEnv: 'TRAECLI_BIN',
      available: true, note: '已安装',
    });
  }
  return runtimes;
}
