const API = '/api/activity';
const LIMIT = 100;
const ACTIVE = new Set(['QUEUED', 'RUNNING', 'OUTBOX_PENDING', 'PENDING', 'SENDING', 'RETRY']);
const SENT = new Set(['SENT', 'DRY_RUN']);
const SILENT = new Set(['SILENT', 'IGNORED', 'RULE_IGNORED']);
const STALE = new Set(['STALE', 'CANCELLED_STALE']);
const TERMINAL = new Set([
  ...SENT, ...SILENT, ...STALE, 'DEAD', 'FAILED', 'SEND_FAILED', 'UNCERTAIN', 'INTERRUPTED',
]);

const kindLabels = {
  'message.received': '收到消息',
  'message.ignored': '规则忽略',
  'message.expired': '消息已过期',
  'message.duplicate': '重复消息',
  'agent.started': '开始判断',
  'agent.decided': '决定回复',
  'agent.silent': '保持静默',
  'agent.stale': '暂缓回复',
  'agent.failed': '判断失败',
  'agent.interrupted': '判断被中断',
  'agent.session_rotated': '会话已更新',
  'delivery.queued': '等待发送',
  'delivery.attempt': '正在发送',
  'delivery.sent': '已回复',
  'delivery.dry_run': '模拟发送完成',
  'delivery.retry': '等待重试',
  'delivery.failed': '回复发送失败',
  'delivery.uncertain': '发送结果不确定',
  'delivery.cancelled': '暂缓发送',
  'system.starting': '守护进程启动',
  'system.preflight_ok': '命令行检查通过',
  'system.subscriber_started': '飞书监听已启动',
  'system.ready': '守护进程就绪',
  'system.recovery': '恢复未完成任务',
  'system.event_dropped': '事件未处理',
  'system.persist_failed': '事件落库失败',
  'system.worker_failed': '会话处理失败',
  'system.subscriber_exit': '飞书监听意外退出',
  'system.startup_failed': '守护进程启动失败',
  'system.maintenance': '状态清理完成',
  'system.stopping': '守护进程停止中',
  'system.stopped': '守护进程已停止',
};

const reasonLabels = {
  direct_request: '明确请求', continuation: '有效续聊', useful_intervention: '增量价值',
  ack: '确认或致谢', ambient: '背景聊天', already_answered: '已有回答',
  unsupported: '暂不支持', unsafe: '不适合执行',
};

const state = {
  rows: new Map(), service: {}, overview: {}, nextCursor: null,
  initialized: false, loading: false, loadingOlder: false,
  filter: 'all', query: '', hideText: false, fetchedAt: 0,
};

const $ = (selector) => document.querySelector(selector);
const dom = {
  service: $('#service-status'), serviceText: $('#service-status-text'), updated: $('#last-updated'),
  current: $('#current-state'), subscriber: $('#subscriber-value'), queue: $('#queue-value'),
  uptime: $('#uptime-value'), received: $('#received-count'), sent: $('#sent-count'),
  silent: $('#silent-count'), attention: $('#attention-count'), search: $('#activity-search'),
  privacy: $('#privacy-toggle'), filters: $('#filters'), notice: $('#connection-notice'),
  attentionSection: $('#attention-section'), attentionBadge: $('#attention-badge'),
  attentionList: $('#attention-list'), activeSection: $('#active-section'),
  activeBadge: $('#active-badge'), activeList: $('#active-list'), todaySection: $('#today-section'),
  todayBadge: $('#today-badge'), todayList: $('#today-list'), recent: $('#recent-days'),
  olderSection: $('#older-section'), olderSummary: $('#older-summary'), olderList: $('#older-list'),
  lowSection: $('#low-signal-section'), lowSummary: $('#low-signal-summary'),
  lowList: $('#low-signal-list'), empty: $('#empty-state'), loadOlder: $('#load-older'),
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function activity(raw) {
  if (!raw || raw.id === undefined) return null;
  return {
    id: String(raw.id), kind: String(raw.kind || 'unknown'), category: String(raw.category || 'system'),
    severity: String(raw.severity || 'info').toLowerCase(), priority: number(raw.priority),
    title: String(raw.title || ''), summary: String(raw.summary || ''),
    conversationRef: String(raw.conversationRef || ''),
    turnId: raw.turnId == null ? null : String(raw.turnId),
    inboundSeq: raw.inboundSeq == null ? null : String(raw.inboundSeq),
    outboxId: raw.outboxId == null ? null : String(raw.outboxId),
    status: String(raw.status || '').toUpperCase(),
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {},
    createdAtMs: number(raw.createdAtMs) || Date.now(),
  };
}

function eventOrder(a, b) {
  return a.createdAtMs - b.createdAtMs || Number(a.id) - Number(b.id);
}

function buildStories() {
  const rows = [...state.rows.values()].sort(eventOrder);
  const seqToTurn = new Map();
  for (const row of rows) {
    if (!row.turnId) continue;
    const seqs = [row.inboundSeq, ...(Array.isArray(row.metadata.inboundSeqs) ? row.metadata.inboundSeqs : [])];
    for (const seq of seqs) if (seq != null) seqToTurn.set(String(seq), row.turnId);
  }

  const groups = new Map();
  for (const row of rows) {
    const turn = row.turnId || seqToTurn.get(row.inboundSeq);
    const key = turn ? `turn:${turn}` : `activity:${row.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  return [...groups].map(([key, events]) => {
    events.sort(eventOrder);
    const latest = events.at(-1);
    const priority = Math.max(...events.map((item) => item.priority));
    const status = [...events].reverse()
      .find((item) => ACTIVE.has(item.status) || TERMINAL.has(item.status))?.status
      || latest.status;
    const attention = events.some((item) => item.severity === 'error' || item.priority >= 85);
    const active = !attention && ACTIVE.has(status);
    const low = !attention && !active && (
      latest.category === 'system' || latest.kind === 'message.ignored'
      || latest.kind === 'agent.silent' || latest.priority <= 15
    );
    let tone = 'neutral';
    if (attention) tone = 'attention';
    else if (active) tone = 'active';
    else if (SENT.has(status) || ['delivery.sent', 'delivery.dry_run'].includes(latest.kind)) tone = 'sent';
    else if (SILENT.has(status) || latest.kind === 'agent.silent') tone = 'silent';
    else if (STALE.has(status) || ['agent.stale', 'delivery.cancelled'].includes(latest.kind)) tone = 'stale';
    return { key, events, latest, priority, status, attention, active, low, tone, at: latest.createdAtMs };
  }).sort((a, b) => b.at - a.at);
}

function storyMeta(story, key) {
  for (const row of [...story.events].reverse()) {
    if (row.metadata[key] !== undefined && row.metadata[key] !== null) return String(row.metadata[key]);
  }
  return '';
}

function storyInput(story) {
  const values = story.events.filter((row) => row.kind === 'message.received').map((row) => row.summary);
  return [...new Set(values.filter(Boolean))].join('\n');
}

function storyOutput(story) {
  const rows = [...story.events].reverse();
  return rows.find((row) => ['delivery.sent', 'delivery.dry_run'].includes(row.kind))?.summary
    || rows.find((row) => row.kind === 'agent.decided')?.summary || '';
}

function text(value) {
  return state.hideText && value ? '正文已隐藏' : value;
}

function clock(ms, seconds = false) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit', minute: '2-digit', ...(seconds ? { second: '2-digit' } : {}), hour12: false,
  }).format(new Date(ms));
}

function exact(ms) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date(ms));
}

function dayNumber(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

function dayKey(ms) {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function storyLabel(story) {
  if (story.attention) return '需要处理';
  if (story.active) return '进行中';
  if (story.tone === 'sent') return '已回复';
  if (story.tone === 'silent') return '静默';
  if (story.tone === 'stale') return '已暂缓';
  if (story.latest.category === 'system') return '系统';
  if (story.latest.kind === 'message.ignored') return '已忽略';
  return '';
}

function technicalData(story) {
  return story.events.map((row) => ({
    id: row.id, kind: row.kind, status: row.status || undefined,
    at: new Date(row.createdAtMs).toISOString(), conversationRef: row.conversationRef || undefined,
    turnId: row.turnId, inboundSeq: row.inboundSeq, outboxId: row.outboxId,
    summary: state.hideText && row.summary ? '[正文已隐藏]' : row.summary,
    metadata: row.metadata,
  }));
}

function storyCard(story) {
  const details = el('details', 'story');
  details.dataset.storyKey = story.key;
  details.dataset.tone = story.tone;
  const summary = el('summary');
  const heading = el('div', 'story-heading-row');
  const titleWrap = el('div');
  const titleLine = el('div', 'story-title-line');
  titleLine.append(el('span', 'story-title', story.latest.title || kindLabels[story.latest.kind] || story.latest.kind));
  const label = storyLabel(story);
  if (label) titleLine.append(el('span', 'story-chip', label));
  titleWrap.append(titleLine);

  const notes = [];
  const chat = storyMeta(story, 'chatType');
  const mode = storyMeta(story, 'deliveryMode');
  const reason = storyMeta(story, 'reasonCode');
  if (chat) notes.push(chat === 'p2p' ? '私聊' : chat === 'group' ? '群聊' : chat);
  if (mode) notes.push({ chat: '直接发送', reply: '普通引用', thread: 'Thread' }[mode] || mode);
  if (reason) notes.push(reasonLabels[reason] || reason);
  if (notes.length) titleWrap.append(el('div', 'story-subtitle', notes.join(' · ')));

  const time = el('time', 'story-time', clock(story.at));
  time.dateTime = new Date(story.at).toISOString();
  time.title = exact(story.at);
  heading.append(titleWrap, time);
  summary.append(heading);

  const preview = el('div', 'story-preview');
  const input = storyInput(story);
  const output = storyOutput(story);
  const addPreview = (mark, value) => {
    if (!value) return;
    const line = el('div', 'preview-line');
    line.append(el('span', 'direction', mark), el('span', 'preview-text', text(value)));
    preview.append(line);
  };
  addPreview('“', input);
  addPreview('→', output && output !== input ? output : '');
  if (!input && !output) addPreview('·', story.latest.summary);
  if (preview.childElementCount) summary.append(preview);
  details.append(summary);

  const body = el('div', 'story-body');
  const stages = el('ol', 'stage-list');
  for (const row of story.events) {
    const stage = el('li', 'stage');
    const stageTime = el('time', 'stage-time', clock(row.createdAtMs, true));
    stageTime.dateTime = new Date(row.createdAtMs).toISOString();
    const copy = el('div');
    copy.append(el('div', 'stage-title', row.title || kindLabels[row.kind] || row.kind));
    if (row.summary) copy.append(el('div', 'stage-summary', text(row.summary)));
    stage.append(stageTime, copy);
    stages.append(stage);
  }
  body.append(stages);
  const tech = el('details', 'technical-details');
  tech.append(el('summary', '', '技术信息'), el('pre', '', JSON.stringify(technicalData(story), null, 2)));
  body.append(tech);
  details.append(body);
  return details;
}

function renderList(container, stories) {
  const fragment = document.createDocumentFragment();
  stories.forEach((story) => fragment.append(storyCard(story)));
  container.replaceChildren(fragment);
}

function matches(story) {
  if (state.filter === 'attention' && !story.attention) return false;
  if (state.filter === 'replied' && story.tone !== 'sent') return false;
  if (state.filter === 'silent' && story.tone !== 'silent' && story.latest.kind !== 'message.ignored') return false;
  if (state.filter === 'system' && story.latest.category !== 'system' && story.latest.kind !== 'message.ignored') return false;
  if (!state.query) return true;
  return JSON.stringify(story.events).toLocaleLowerCase().includes(state.query);
}

function openStories() {
  return new Set([...document.querySelectorAll('.story[open]')].map((node) => node.dataset.storyKey));
}

function dayFold(stories, difference) {
  const details = el('details', 'fold-section');
  details.dataset.foldKey = dayKey(stories[0].at);
  details.open = Boolean(state.query) || state.filter !== 'all';
  const label = difference === 1 ? '昨天' : new Intl.DateTimeFormat('zh-CN', {
    month: 'long', day: 'numeric', weekday: 'short',
  }).format(new Date(stories[0].at));
  const summary = el('summary');
  summary.append(el('span', '', label), el('span', 'section-meta', `${stories.length} 条`));
  const list = el('div', 'story-list');
  renderList(list, stories);
  details.append(summary, list);
  return details;
}

function render() {
  const opened = openStories();
  const stories = buildStories().filter(matches);
  const attention = [], active = [], regular = [], low = [];
  for (const story of stories) {
    if (story.attention) attention.push(story);
    else if (story.active) active.push(story);
    else if (story.low) low.push(story);
    else regular.push(story);
  }
  attention.sort((a, b) => b.priority - a.priority || b.at - a.at);
  active.sort((a, b) => b.priority - a.priority || b.at - a.at);

  renderList(dom.attentionList, attention);
  dom.attentionSection.hidden = !attention.length;
  dom.attentionBadge.textContent = attention.length;
  renderList(dom.activeList, active);
  dom.activeSection.hidden = !active.length;
  dom.activeBadge.textContent = active.length;

  const today = [], days = new Map(), older = [];
  const todayNumber = dayNumber(Date.now());
  for (const story of regular) {
    const difference = todayNumber - dayNumber(story.at);
    if (difference <= 0) today.push(story);
    else if (difference <= 7) {
      const key = dayKey(story.at);
      if (!days.has(key)) days.set(key, { difference, stories: [] });
      days.get(key).stories.push(story);
    } else older.push(story);
  }
  renderList(dom.todayList, today);
  dom.todaySection.hidden = !today.length;
  dom.todayBadge.textContent = today.length ? `${today.length} 条` : '';
  dom.recent.replaceChildren(...[...days.values()]
    .sort((a, b) => a.difference - b.difference)
    .map((group) => dayFold(group.stories, group.difference)));

  renderList(dom.olderList, older);
  dom.olderSection.hidden = !older.length;
  dom.olderSummary.textContent = `${older.length} 条`;
  renderList(dom.lowList, low);
  dom.lowSection.hidden = !low.length;
  dom.lowSummary.textContent = `${low.length} 条`;
  if (state.query || state.filter !== 'all') dom.olderSection.open = true;
  if (state.query || ['system', 'silent'].includes(state.filter)) dom.lowSection.open = true;

  const count = attention.length + active.length + regular.length + low.length;
  dom.empty.hidden = count > 0;
  if (!count && state.initialized) {
    dom.empty.querySelector('h2').textContent = state.query || state.filter !== 'all' ? '没有匹配的活动' : '还没有活动';
    dom.empty.querySelector('p').textContent = state.query || state.filter !== 'all'
      ? '换个关键词，或切回“全部”查看。' : '给 Zayn 发一条飞书消息，它会出现在这里。';
  }
  dom.loadOlder.hidden = !state.nextCursor;
  document.querySelectorAll('.story').forEach((node) => { if (opened.has(node.dataset.storyKey)) node.open = true; });
}

function overview(key) { return number(state.overview[key]); }

function serviceDisplay(offline = false) {
  if (offline) {
    dom.service.dataset.state = 'offline';
    dom.serviceText.textContent = '连接异常';
    dom.current.textContent = '无法连接 daemon';
    return;
  }
  const subscriber = state.service.subscriber === 'running';
  const mode = state.service.ready && subscriber ? 'ready' : subscriber ? 'starting' : 'offline';
  dom.service.dataset.state = mode;
  dom.serviceText.textContent = mode === 'ready' ? '正在监听' : mode === 'starting' ? '正在启动' : '订阅已停止';
  dom.current.textContent = overview('attention') ? `${overview('attention')} 项需要处理`
    : overview('active') ? `正在处理 ${overview('active')} 项` : state.service.ready ? '空闲' : '正在启动';
  dom.subscriber.textContent = subscriber ? '运行中' : '已停止';
  dom.queue.textContent = overview('queued');
  const seconds = number(state.service.uptimeSeconds);
  dom.uptime.textContent = seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h`;
  dom.received.textContent = overview('receivedToday');
  dom.sent.textContent = overview('sentToday');
  dom.silent.textContent = overview('silentToday');
  dom.attention.textContent = overview('attention');
  dom.updated.textContent = '刚刚';
  dom.updated.title = exact(state.fetchedAt);
}

async function request(before) {
  const url = new URL(API, location.origin);
  url.searchParams.set('limit', LIMIT);
  if (before) url.searchParams.set('before', before);
  const response = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload.activities)) throw new Error('活动接口格式不正确');
  return { ...payload, activities: payload.activities.map(activity).filter(Boolean) };
}

function applyPayload(payload) {
  state.service = payload.service || {};
  state.overview = payload.overview || {};
  state.fetchedAt = Date.now();
  dom.notice.hidden = true;
  serviceDisplay();
}

async function refresh(initial = false) {
  if (state.loading || document.hidden) return;
  state.loading = true;
  try {
    const payload = await request();
    applyPayload(payload);
    let changed = initial;
    for (const row of payload.activities) {
      if (!state.rows.has(row.id)) changed = true;
      state.rows.set(row.id, row);
    }
    if (!state.initialized) state.nextCursor = payload.nextCursor || null;
    state.initialized = true;
    if (changed) render();
  } catch (error) {
    dom.notice.textContent = `页面暂时连不上 lark-daemon：${error.message}`;
    dom.notice.hidden = false;
    serviceDisplay(true);
    state.initialized = true;
    render();
  } finally {
    state.loading = false;
  }
}

async function loadOlder() {
  if (!state.nextCursor || state.loadingOlder) return;
  state.loadingOlder = true;
  dom.loadOlder.disabled = true;
  dom.loadOlder.textContent = '正在加载…';
  try {
    const payload = await request(state.nextCursor);
    applyPayload(payload);
    payload.activities.forEach((row) => state.rows.set(row.id, row));
    state.nextCursor = payload.nextCursor || null;
    render();
  } catch (error) {
    dom.notice.textContent = `加载失败：${error.message}`;
    dom.notice.hidden = false;
  } finally {
    state.loadingOlder = false;
    dom.loadOlder.disabled = false;
    dom.loadOlder.textContent = '加载更早';
  }
}

function selectFilter(value) {
  state.filter = value;
  dom.filters.querySelectorAll('[data-filter]').forEach((button) => {
    button.setAttribute('aria-pressed', String(button.dataset.filter === value));
  });
  render();
}

dom.filters.addEventListener('click', (event) => {
  const button = event.target.closest('[data-filter]');
  if (button) selectFilter(button.dataset.filter);
});
document.querySelectorAll('[data-filter-target]').forEach((button) => {
  button.addEventListener('click', () => selectFilter(button.dataset.filterTarget));
});
dom.search.addEventListener('input', () => {
  state.query = dom.search.value.trim().toLocaleLowerCase();
  render();
});
dom.privacy.addEventListener('click', () => {
  state.hideText = !state.hideText;
  dom.privacy.setAttribute('aria-pressed', String(state.hideText));
  dom.privacy.textContent = state.hideText ? '显示正文' : '隐藏正文';
  render();
});
dom.loadOlder.addEventListener('click', loadOlder);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => { if (!document.hidden) refresh(); }, 5_000);
refresh(true);
