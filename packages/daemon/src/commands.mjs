// Local slash commands. A message whose text starts with '/' is reserved for the
// daemon: it is handled here deterministically and replied to directly — it never
// reaches codex. Any unambiguous prefix of a command name works (/h → /help,
// /m gpt-5.5 → /model gpt-5.5); effort levels match by prefix too.

import {
  DEFAULT_RUNTIME_ID,
  getRuntimeDefinition,
  RUNTIME_ALIASES,
  RUNTIME_IDS,
  currentModelEntry,
  supportedModelEfforts,
  parseRuntimeModelSelector,
} from './runtime-catalog.mjs';

// Default vocabulary for callers; command validation uses current model metadata.
export const EFFORT_LEVELS = getRuntimeDefinition(DEFAULT_RUNTIME_ID).efforts;

const COMMANDS = ['new', 'help', 'status', 'runtime', 'model', 'effort'];

const MODEL_NAME = /^[A-Za-z0-9._:\/\[\]-]{1,256}$/;

function settingsAdjustmentText(result) {
  const lines = [];
  if (result.modelFallback) lines.push(`原模型 ${result.modelFallback.from} 已不可用，已恢复默认模型。`);
  if (result.effortChanged) lines.push(result.effort
    ? `推理档位已从 ${result.previousEffort || '未设置'} 调整为 ${result.effort}，以匹配目标模型。`
    : '目标模型不支持推理档位，已取消额外的 effort 配置。');
  return lines.length ? `\n${lines.join('\n')}` : '';
}

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
  if (event.kind !== 'message.created' || !event.chatId || !event.messageId
    || !event.replyRoute || !['text', 'post'].includes(event.messageType)) return null;
  const text = String(event.content ?? '').trim();
  if (event.chatType === 'p2p') return text;
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

export function helpText(snapshot) {
  const supportsEffort = snapshot.capabilities?.effortControl === 'selectable';
  const lines = [
    '可用命令（支持前缀匹配，如 /h、/m）：',
    '/new — 开启新会话，丢弃当前上下文',
    '/help — 显示帮助与当前状态',
    '/status — 查看模型是否在工作以及持续时间',
    '/runtime [名称] — 查看或切换 Runtime（可简写 /run）',
    '/model [名称] — 查看或切换当前 Runtime 的模型，保留会话',
  ];
  if (supportsEffort) lines.push('/effort [档位] — 查看或切换当前模型的推理档位，保留会话');
  else lines.push('/effort [档位] — 当前 Runtime 不支持 daemon 侧推理档位配置');
  lines.push(
    '',
    `当前会话：${snapshot.session?.id ?? snapshot.threadId ?? '（未连接）'}`,
    `Runtime：${snapshot.runtime ?? 'codex'}`,
    `模型：${snapshot.model || '（默认）'}`,
  );
  if (supportsEffort) lines.push(`推理档位：${snapshot.effort || '未设置'}`);
  return lines.join('\n');
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

export function statusText(snapshot, nowMs = Date.now()) {
  const status = snapshot.work ?? snapshot.workStatus ?? {
    working: Boolean(snapshot.turnInProgress),
    startedAtMs: null,
    connected: Boolean(snapshot.state?.connected ?? true),
    queued: snapshot.queued ?? snapshot.state?.queued ?? 0,
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
    `Runtime：${snapshot.runtime ?? 'codex'}`,
    `模型：${snapshot.model || '（默认）'}`,
  ];
  if ((status.queued ?? 0) > 0) lines.push(`排队消息：${status.queued}`);
  return lines.join('\n');
}

// Executes one parsed command against the codex agent. Returns { ok, text }; the
// caller replies with text and records ok as the activity status. Throws only on
// unexpected agent errors (rotate/apply failures), which the caller reports.
export async function executeCommand(command, runtime) {
  const cached = await runtime.snapshot({ catalog: 'cached' });
  if (!command.name) {
    const head = command.matches.length > 1
      ? `命令 /${command.token} 有歧义：${command.matches.map((name) => `/${name}`).join('、')}`
      : `未知命令：/${command.token}`;
    return { ok: false, text: `${head}\n\n${helpText(cached)}` };
  }

  if (command.name === 'help') return { ok: true, text: helpText(cached) };

  if (command.name === 'status') return { ok: true, text: statusText(cached) };

  if (command.name === 'new') {
    const result = await runtime.transition({ kind: 'new-session' });
    const threadId = result.threadId;
    return {
      ok: true,
      text: threadId ? `已开启新会话：${threadId}` : '已清除会话，重连后将开启新会话',
    };
  }

  if (command.name === 'runtime') {
    const options = RUNTIME_IDS.map((id) => id === 'volc' ? 'volc（ark）' : id).join('、');
    if (!command.arg) {
      return { ok: true, text: `当前 Runtime：${cached.runtime}\n可选：${options}\n用法：/runtime <名称>（可简写 /run）` };
    }
    const matches = matchPrefix(command.arg.toLowerCase(), Object.keys(RUNTIME_ALIASES));
    const targets = [...new Set(matches.map((alias) => RUNTIME_ALIASES[alias]))];
    if (targets.length !== 1) {
      return { ok: false, text: `未知或有歧义的 Runtime：${command.arg}\n可选：${options}` };
    }
    const applied = await runtime.transition({ kind: 'select-runtime', runtime: targets[0],
      expectedRuntime: cached.runtime, expectedRevision: cached.revision });
    if (applied.ok === false) return { ok: false, text: 'Runtime 已变更，请重试 /runtime' };
    const adjustment = settingsAdjustmentText(applied);
    return { ok: true, text: (applied.unchanged
      ? `当前已是 Runtime：${applied.runtime}（会话保留）`
      : `已切换 Runtime：${applied.runtime}。会尝试从 OV 接上历史对话；隐藏思考和未落盘的工具过程不会继承`) + adjustment };
  }

  let current = cached;
  try { current = await runtime.snapshot({ catalog: 'refresh' }); } catch { /* offline: cached options */ }
  const models = current.models ?? [];

  if (command.name === 'model') {
    const ids = [...new Set(models.flatMap((model) => [model.id, model.resolvedModel].filter(Boolean)))];
    if (!command.arg) {
      const selected = currentModelEntry(current);
      const resolved = selected?.resolvedModel || current.resolvedModel;
      const lines = [`Runtime：${current.runtime}`, `当前模型：${current.model || '（默认）'}`];
      if (resolved) lines.push(`实际模型：${resolved}`);
      if (models.length) {
        lines.push('可选：' + models.map((entry) => {
          const details = [entry.displayName, entry.resolvedModel]
            .filter((value) => value && value !== entry.id);
          return entry.id + (details.length ? `（${[...new Set(details)].join(' · ')}）` : '');
        }).join('、'));
      } else lines.push('模型列表暂不可用');
      lines.push('用法：/model <名称>（支持前缀匹配）；切换 Runtime 请用 /runtime');
      return { ok: true, text: lines.join('\n') };
    }
    const selector = parseRuntimeModelSelector(command.arg);
    const lookupName = selector.qualified ? selector.model : selector.raw;
    if (!MODEL_NAME.test(command.arg) || !lookupName) {
      return { ok: false, text: lookupName ? `无效的模型名：${lookupName}` : '无效的模型名' };
    }
    const namedRuntime = getRuntimeDefinition(command.arg);
    const foreignRuntime = selector.runtime || namedRuntime?.id;
    if (foreignRuntime && foreignRuntime !== current.runtime) {
      return { ok: false, text: `/model 只选择当前 Runtime（${current.runtime}）的模型；请先 /runtime ${foreignRuntime}` };
    }
    const matches = matchPrefix(lookupName, ids);
    if (matches.length > 1) return { ok: false, text: `模型名有歧义：${matches.join('、')}` };
    if (ids.length && !matches.length) {
      return { ok: false, text: `未找到模型：${lookupName}\n可选：${ids.join('、')}\n切换 Runtime 请用 /runtime` };
    }
    const target = matches[0] || lookupName;
    const applied = await runtime.transition({ kind: 'select-model', selector: target,
      expectedRuntime: current.runtime, expectedRevision: current.revision });
    if (applied.ok === false) return { ok: false, text: applied.reason === 'model-capabilities-unavailable'
      ? '暂时无法确认目标模型支持的推理档位，模型和档位均未修改，请稍后重试 /model'
      : '模型设置已变更，请重试 /model' };
    return { ok: true, text: (applied.unchanged
      ? `当前已是模型：${applied.model || target}（上下文保留）`
      : `已切到 ${applied.model || target}（下一轮生效，上下文保留）`) + settingsAdjustmentText(applied) };
  }

  const capabilities = current.capabilities ?? getRuntimeDefinition(current.runtime)?.capabilities;
  const effortControl = capabilities?.effortControl ?? 'unsupported';
  if (effortControl === 'unsupported') {
    return {
      ok: false,
      text: '当前 Runtime 不支持 daemon 侧 /effort 配置',
    };
  }
  if (effortControl === 'remote-managed') {
    return {
      ok: false,
      text: 'Ark managed agent 的推理档位由远端 Agent 配置管理，不能通过 /effort 修改',
    };
  }

  const supported = supportedModelEfforts(current);
  if (!supported.length) {
    const entry = currentModelEntry(current);
    const knownUnsupported = entry?.effortsKnown !== false && Array.isArray(entry?.efforts) && !entry.efforts.length;
    return { ok: !command.arg, text: knownUnsupported
      ? '当前模型不支持配置推理档位'
      : `当前推理档位：${current.effort || '未设置'}\n当前模型没有可用的推理档位信息，请稍后重试 /effort` };
  }
  if (!command.arg) {
    return { ok: true, text: `当前推理档位：${current.effort}\n可选：${supported.join('、')}` };
  }
  const levels = matchPrefix(command.arg.toLowerCase(), supported);
  if (levels.length !== 1) {
    const head = levels.length > 1
      ? `档位有歧义：${levels.join('、')}`
      : `不支持的档位：${command.arg}`;
    return { ok: false, text: `${head}\n可选：${supported.join('、')}` };
  }
  const applied = await runtime.transition({
    kind: 'select-effort',
    effort: levels[0],
    expectedRuntime: current.runtime,
    expectedRevision: current.revision,
  });
  if (applied.ok === false && ['runtime-changed', 'stale-snapshot'].includes(applied.reason)) {
    return {
      ok: false,
      text: 'Runtime 在命令排队期间已变更，请重试 /effort',
    };
  }
  if (applied.ok === false && applied.reason === 'remote-managed') {
    return {
      ok: false,
      text: '当前 Runtime 的推理档位由远端配置管理，不能通过 /effort 修改',
    };
  }
  if (applied.ok === false && applied.reason === 'unsupported-effort-control') {
    return {
      ok: false,
      text: '当前 Runtime 不支持 daemon 侧 /effort 配置',
    };
  }
  if (applied.ok === false) {
    return { ok: false, text: `不支持的档位：${levels[0]}` };
  }
  return {
    ok: true,
    text: applied.unchanged
      ? `当前已是推理档位：${levels[0]}（上下文保留）`
      : `已切换推理档位：${levels[0]}（下一轮生效，上下文保留）`,
  };
}
