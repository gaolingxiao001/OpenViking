// Local slash commands. A message whose text starts with '/' is reserved for the
// daemon: it is handled here deterministically and replied to directly — it never
// reaches codex. Any unambiguous prefix of a command name works (/h → /help,
// /m gpt-5.5 → /model gpt-5.5); effort levels match by prefix too.

import { CLAUDE_MODELS } from './claude.mjs';

// Static fallback only (offline); when connected, /effort validates against the
// current model's supportedReasoningEfforts from model/list.
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

const COMMANDS = ['new', 'help', 'status', 'model', 'effort'];

const MODEL_NAME = /^[A-Za-z0-9._:\/-]{1,64}$/;

// All candidates the token is a prefix of; an exact match wins outright so a
// short name can never be shadowed by a longer one added later.
export function matchPrefix(token, candidates) {
  if (!token) return [];
  if (candidates.includes(token)) return [token];
  return candidates.filter((name) => name.startsWith(token));
}

// Where slash commands are accepted: a private chat takes bare /commands. Group
// chats never do — the daemon has no reliable way to tell "@bot /cmd" apart from
// "@someone-else /cmd" (it doesn't track its own open_id), so any mention in a
// group used to be enough to trigger a command meant for a completely different
// person. Group /command support can come back once mentions are resolved
// against the bot's own id. Returns the parse candidate text, or null when the
// message is not eligible (it then flows to codex as a normal message).
export function commandCandidate(event) {
  const text = String(event.content ?? '').trim();
  if ((event.chatType ?? 'p2p') === 'p2p') return text;
  return null;
}

// null → not a command (does not start with '/'). Otherwise { name, arg } for a
// unique match, or { name: null, token, matches } for unknown/ambiguous input.
export function parseCommand(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;
  const [token = '', ...rest] = trimmed.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  const matches = matchPrefix(token.toLowerCase(), COMMANDS);
  if (matches.length === 1) return { name: matches[0], arg };
  return { name: null, arg, token, matches };
}

export function helpText(codex) {
  return [
    '可用命令（支持前缀匹配，如 /h、/m）：',
    '/new — 开启新会话，丢弃当前上下文',
    '/help — 显示帮助与当前状态',
    '/status — 查看模型是否在工作以及持续时间',
    '/model [名称] — 查看或切换模型，如 sonnet、gpt-5.6-sol',
    `/effort [档位] — 查看或切换推理档位（${EFFORT_LEVELS.join('/')}）`,
    '',
    `当前会话：${codex.threadId ?? '（未连接）'}`,
    `Runtime：${codex.runtime ?? 'codex'}`,
    `模型：${codex.model || '（默认）'}`,
    `推理档位：${codex.effort}`,
  ].join('\n');
}

function durationText(milliseconds) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes < 60) return remainder ? `${minutes} 分 ${remainder} 秒` : `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const minuteRemainder = minutes % 60;
  return minuteRemainder ? `${hours} 小时 ${minuteRemainder} 分` : `${hours} 小时`;
}

export function statusText(agent, nowMs = Date.now()) {
  const status = agent.workStatus ?? {
    working: Boolean(agent.turnInProgress),
    startedAtMs: null,
    connected: Boolean(agent.state?.connected ?? true),
    queued: agent.state?.queued ?? 0,
    switching: false,
  };
  let headline = '状态：空闲';
  if (status.switching) headline = '状态：正在切换 Runtime';
  else if (status.working) {
    headline = status.startedAtMs
      ? `状态：模型工作中，已持续 ${durationText(nowMs - status.startedAtMs)}`
      : '状态：模型工作中';
  } else if (!status.connected) headline = '状态：Runtime 未连接';
  const lines = [
    headline,
    `Runtime：${agent.runtime ?? 'codex'}`,
    `模型：${agent.model || '（默认）'}`,
  ];
  if ((status.queued ?? 0) > 0) lines.push(`排队消息：${status.queued}`);
  return lines.join('\n');
}

// Executes one parsed command against the codex agent. Returns { ok, text }; the
// caller replies with text and records ok as the activity status. Throws only on
// unexpected agent errors (rotate/apply failures), which the caller reports.
export async function executeCommand(command, codex) {
  if (!command.name) {
    const head = command.matches.length > 1
      ? `命令 /${command.token} 有歧义：${command.matches.map((name) => `/${name}`).join('、')}`
      : `未知命令：/${command.token}`;
    return { ok: false, text: `${head}\n\n${helpText(codex)}` };
  }

  if (command.name === 'help') return { ok: true, text: helpText(codex) };

  if (command.name === 'status') return { ok: true, text: statusText(codex) };

  if (command.name === 'new') {
    await codex.interruptTurn?.();
    const threadId = await codex.rotateSession({ resume: false });
    return {
      ok: true,
      text: threadId ? `已开启新会话：${threadId}` : '已清除会话，重连后将开启新会话',
    };
  }

  let models = [];
  try { models = (await codex.listModels?.()) ?? []; } catch { /* offline: no options */ }

  if (command.name === 'model') {
    const ids = models.map((model) => model.id);
    if (!command.arg) {
      const lines = [`当前模型：${codex.model || '（默认）'}`];
      if (ids.length > 0) lines.push(`可选：${ids.join('、')}`);
      lines.push('用法：/model <名称>（支持前缀匹配）');
      return { ok: true, text: lines.join('\n') };
    }
    const legacy = /^(claude|codex):(.*)$/.exec(command.arg);
    const providerHint = legacy?.[1] ?? null;
    const lookupName = legacy?.[2] ?? command.arg;
    if (!MODEL_NAME.test(command.arg) || (legacy && !lookupName)) {
      return { ok: false, text: lookupName ? `无效的模型名：${lookupName}` : '无效的模型名' };
    }
    let target = command.arg;
    if (ids.length > 0) {
      const candidates = providerHint === 'claude'
        ? ids.filter((id) => CLAUDE_MODELS.includes(id))
        : providerHint === 'codex'
          ? ids.filter((id) => !CLAUDE_MODELS.includes(id))
          : ids;
      const matches = matchPrefix(lookupName, candidates);
      if (matches.length > 1) return { ok: false, text: `模型名有歧义：${matches.join('、')}` };
      if (matches.length === 0) {
        // Claude cannot enumerate Codex models without starting a second
        // runtime. Any non-Claude direct name is therefore staged as Codex;
        // AgentRuntime validates its live model list before the switch commits.
        const requestedRuntime = providerHint
          ?? (CLAUDE_MODELS.includes(lookupName) ? 'claude' : 'codex');
        if (!(codex.runtime === 'claude' && requestedRuntime === 'codex')) {
          return { ok: false, text: `未找到模型：${lookupName}\n可选：${ids.join('、')}` };
        }
      } else {
        target = providerHint ? `${providerHint}:${matches[0]}` : matches[0];
      }
    }
    const applied = await codex.setModel(target);
    const displayTarget = applied?.model
      || target.replace(/^(?:claude|codex):/, '')
      || target;
    if (applied?.runtimeChanged) {
      return {
        ok: true,
        text: `已切到 ${displayTarget}。历史对话会接上；隐藏思考和未落盘的工具过程不会继承`,
      };
    }
    // Same-runtime switch also opens a fresh session (owner request: /m 之后
    // 直接 new session), so the reply reports the new thread instead of
    // promising continuity.
    return {
      ok: true,
      text: applied?.threadId
        ? `已切到 ${displayTarget}，已开启新会话：${applied.threadId}`
        : `已切到 ${displayTarget}，已开启新会话`,
    };
  }

  // effort: validate against what the current model actually supports — an
  // unsupported level (e.g. minimal on gpt-5.6) makes every turn fail with a 400.
  // Unknown current model → union across listed models; offline → static list.
  const current = models.find((model) => model.id === codex.model);
  const modelEfforts = current?.efforts?.length
    ? current.efforts
    : [...new Set(models.flatMap((model) => model.efforts ?? []))];
  const supported = modelEfforts.length > 0 ? modelEfforts : EFFORT_LEVELS;
  if (!command.arg) {
    return { ok: true, text: `当前推理档位：${codex.effort}\n可选：${supported.join('、')}` };
  }
  const levels = matchPrefix(command.arg.toLowerCase(), supported);
  if (levels.length !== 1) {
    const head = levels.length > 1
      ? `档位有歧义：${levels.join('、')}`
      : `不支持的档位：${command.arg}`;
    return { ok: false, text: `${head}\n可选：${supported.join('、')}` };
  }
  await codex.interruptTurn?.();
  codex.setEffort(levels[0]);
  const threadId = await codex.rotateSession({ resume: false });
  return {
    ok: true,
    text: threadId
      ? `已切换推理档位：${levels[0]}，并已开启新会话：${threadId}`
      : `已切换推理档位：${levels[0]}，已清除当前会话；重连后将开启新会话`,
  };
}
