import { redactSensitive } from './logger.mjs';

const DEFINITIONS = Object.freeze({
  'message.received': { category: 'message', severity: 'info', priority: 55, title: '收到消息' },
  'message.duplicate': { category: 'message', severity: 'info', priority: 5, title: '重复事件' },
  'message.ignored': { category: 'message', severity: 'info', priority: 20, title: '规则忽略' },
  'message.expired': { category: 'message', severity: 'warn', priority: 85, title: '消息已过期' },
  'agent.turn_started': { category: 'agent', severity: 'info', priority: 60, title: '开始一轮' },
  'agent.turn_completed': { category: 'agent', severity: 'info', priority: 62, title: '完成一轮' },
  'agent.steered': { category: 'agent', severity: 'info', priority: 58, title: '中途追加' },
  'agent.note': { category: 'agent', severity: 'info', priority: 45, title: 'Agent 输出' },
  'agent.tool': { category: 'agent', severity: 'info', priority: 48, title: '工具调用' },
  'agent.started': { category: 'agent', severity: 'info', priority: 60, title: '开始判断' },
  'agent.decided': { category: 'agent', severity: 'info', priority: 65, title: '决定回复' },
  'agent.silent': { category: 'agent', severity: 'info', priority: 25, title: '保持静默' },
  'agent.stale': { category: 'agent', severity: 'warn', priority: 50, title: '暂缓回复' },
  'agent.failed': { category: 'agent', severity: 'error', priority: 95, title: '判断失败' },
  'agent.interrupted': { category: 'agent', severity: 'error', priority: 90, title: '判断被中断' },
  'agent.session_rotated': { category: 'agent', severity: 'info', priority: 12, title: '会话上下文已更新' },
  'agent.failure_notice': { category: 'agent', severity: 'warn', priority: 88, title: '已通知本轮失败' },
  'delivery.queued': { category: 'delivery', severity: 'info', priority: 60, title: '等待发送' },
  'delivery.attempt': { category: 'delivery', severity: 'info', priority: 60, title: '正在发送' },
  'delivery.sent': { category: 'delivery', severity: 'success', priority: 70, title: '已回复' },
  'delivery.dry_run': { category: 'delivery', severity: 'success', priority: 55, title: '模拟发送完成' },
  'delivery.retry': { category: 'delivery', severity: 'warn', priority: 78, title: '等待重试' },
  'delivery.failed': { category: 'delivery', severity: 'error', priority: 100, title: '回复发送失败' },
  'delivery.uncertain': { category: 'delivery', severity: 'error', priority: 100, title: '发送结果不确定' },
  'delivery.cancelled': { category: 'delivery', severity: 'warn', priority: 48, title: '暂缓发送' },
  'command.executed': { category: 'system', severity: 'info', priority: 58, title: '本机命令' },
  'command.reply_failed': { category: 'system', severity: 'error', priority: 95, title: '命令回复失败' },
  'system.starting': { category: 'system', severity: 'info', priority: 20, title: '守护进程启动' },
  'system.preflight_ok': { category: 'system', severity: 'success', priority: 25, title: '命令行检查通过' },
  'system.subscriber_started': { category: 'system', severity: 'success', priority: 30, title: '飞书监听已启动' },
  'system.ready': { category: 'system', severity: 'success', priority: 40, title: '守护进程就绪' },
  'system.recovery': { category: 'system', severity: 'warn', priority: 72, title: '恢复未完成任务' },
  'system.event_dropped': { category: 'system', severity: 'warn', priority: 65, title: '事件未处理' },
  'system.persist_failed': { category: 'system', severity: 'error', priority: 100, title: '事件落库失败' },
  'system.worker_failed': { category: 'system', severity: 'error', priority: 92, title: '会话处理失败' },
  'system.subscriber_exit': { category: 'system', severity: 'error', priority: 100, title: '飞书监听意外退出' },
  'system.startup_failed': { category: 'system', severity: 'error', priority: 100, title: '守护进程启动失败' },
  'system.maintenance': { category: 'system', severity: 'info', priority: 10, title: '状态清理完成' },
  'system.stopping': { category: 'system', severity: 'info', priority: 15, title: '守护进程停止中' },
  'system.stopped': { category: 'system', severity: 'info', priority: 15, title: '守护进程已停止' },
});

const SENSITIVE_KEY = /(?:authorization|api[_-]?key|token|secret|credential|password|cookie|session|idempotency|raw)/i;

export function activityDefinition(kind) {
  return DEFINITIONS[kind] ?? {
    category: 'system',
    severity: 'info',
    priority: 10,
    title: kind,
  };
}

export function activityPhase(kind) {
  if (kind.startsWith('message.')) return 10;
  if (kind === 'agent.started') return 20;
  if (['agent.decided', 'agent.silent'].includes(kind)) return 30;
  if (kind.startsWith('agent.')) return 35;
  if (kind === 'delivery.queued') return 40;
  if (kind === 'delivery.attempt') return 50;
  if (kind === 'delivery.retry') return 55;
  if (kind.startsWith('delivery.')) return 60;
  return 0;
}

export function cleanActivityText(value, limit = 4000) {
  const text = redactSensitive(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .trim();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function cleanMetadataValue(value, depth = 0) {
  if (value === null || value === undefined) return value ?? null;
  if (depth >= 4) return '[TRUNCATED]';
  if (typeof value === 'string') return cleanActivityText(value, 1000);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => cleanMetadataValue(item, depth + 1));
  if (typeof value === 'object') {
    const cleaned = {};
    for (const [key, child] of Object.entries(value).slice(0, 50)) {
      if (SENSITIVE_KEY.test(key)) continue;
      cleaned[key] = cleanMetadataValue(child, depth + 1);
    }
    return cleaned;
  }
  return cleanActivityText(String(value), 1000);
}

export function cleanActivityMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return cleanMetadataValue(value);
}

export function reasonLabel(reason) {
  const labels = {
    wrong_event_type: '不是消息事件',
    bot_message: '机器人自己的消息',
    ignored_sender: '发送者在忽略列表',
    unsupported_message_type: '暂不支持的消息类型',
    empty_content: '消息没有可处理的正文',
    stale_event: '消息到达时已经过旧',
    slash_command: '本机命令',
    queue_total_full: '本机消息队列已满',
    queue_conversation_full: '当前会话消息过多',
    queue_expired: '排队时间过长',
    direct_request: '明确请求',
    continuation: '有效续聊',
    useful_intervention: '可以提供增量价值',
    ack: '仅确认或致谢',
    ambient: '背景聊天',
    already_answered: '问题已经有人回答',
    unsupported: '能力暂不支持',
    unsafe: '不适合执行',
  };
  return labels[reason] ?? cleanActivityText(reason || '未说明原因', 120);
}
