// Local slash commands. A message whose text starts with '/' is reserved for the
// daemon: it is handled here deterministically and replied to directly — it never
// reaches codex. Any unambiguous prefix of a command name works (/h → /help,
// /m gpt-5.5 → /model gpt-5.5); effort levels match by prefix too.

// Static fallback only (offline); when connected, /effort validates against the
// current model's supportedReasoningEfforts from model/list.
export const EFFORT_LEVELS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'];

const COMMANDS = ['new', 'help', 'model', 'effort'];

const MODEL_NAME = /^[A-Za-z0-9._:\/-]{1,64}$/;

// All candidates the token is a prefix of; an exact match wins outright so a
// short name can never be shadowed by a longer one added later.
export function matchPrefix(token, candidates) {
  if (!token) return [];
  if (candidates.includes(token)) return [token];
  return candidates.filter((name) => name.startsWith(token));
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
    '/model [名称] — 查看或切换模型',
    `/effort [档位] — 查看或切换推理档位（${EFFORT_LEVELS.join('/')}）`,
    '',
    `当前会话：${codex.threadId ?? '（未连接）'}`,
    `模型：${codex.model || '（默认）'}`,
    `推理档位：${codex.effort}`,
  ].join('\n');
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

  if (command.name === 'new') {
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
    if (!MODEL_NAME.test(command.arg)) {
      return { ok: false, text: `无效的模型名：${command.arg}` };
    }
    let target = command.arg;
    if (ids.length > 0) {
      const matches = matchPrefix(command.arg, ids);
      if (matches.length > 1) return { ok: false, text: `模型名有歧义：${matches.join('、')}` };
      if (matches.length === 0) {
        return { ok: false, text: `未找到模型：${command.arg}\n可选：${ids.join('、')}` };
      }
      [target] = matches;
    }
    codex.setModel(target);
    return { ok: true, text: `已切换模型：${target}（下一轮生效，上下文保留）` };
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
  codex.setEffort(levels[0]);
  const threadId = await codex.rotateSession({ resume: false });
  return {
    ok: true,
    text: threadId
      ? `已切换推理档位：${levels[0]}，并已开启新会话：${threadId}`
      : `已切换推理档位：${levels[0]}，已清除当前会话；重连后将开启新会话`,
  };
}
