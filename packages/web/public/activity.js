const API = '/api/activity';
const LIMIT = 100;
const ACTIVE = new Set(['QUEUED', 'RUNNING', 'OUTBOX_PENDING', 'PENDING', 'SENDING', 'RETRY']);
const REPLIED = new Set(['SENT', 'DRY_RUN']);
const IGNORED = new Set(['SILENT', 'IGNORED', 'RULE_IGNORED']);
const STALE = new Set(['STALE', 'CANCELLED', 'CANCELLED_STALE', 'STOPPED']);
const FAILED = new Set(['DEAD', 'FAILED', 'SEND_FAILED', 'UNCERTAIN', 'INTERRUPTED', 'ERROR']);
const KNOWN_STATUS = new Set([...ACTIVE, ...REPLIED, ...IGNORED, ...STALE, ...FAILED]);

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
  'system.event_dropped': '事件未记录',
  'system.persist_failed': '事件落库失败',
  'system.worker_failed': '会话运行失败',
  'system.subscriber_exit': '飞书监听意外退出',
  'system.startup_failed': '守护进程启动失败',
  'system.maintenance': '状态清理完成',
  'system.stopping': '守护进程停止中',
  'system.stopped': '守护进程已停止',
};

const reasonLabels = {
  direct_request: '明确请求',
  continuation: '有效续聊',
  useful_intervention: '增量价值',
  ack: '确认或致谢',
  ambient: '背景聊天',
  already_answered: '已有回答',
  unsupported: '暂不支持',
  unsafe: '不适合执行',
};

const state = {
  rows: new Map(),
  service: {},
  overview: {},
  nextCursor: null,
  initialized: false,
  loading: false,
  loadingOlder: false,
  filter: 'all',
  query: '',
  hideText: false,
  fetchedAt: 0,
};

const $ = (selector) => document.querySelector(selector);
const dom = {
  service: $('#service-status'),
  serviceText: $('#service-status-text'),
  updated: $('#last-updated'),
  current: $('#current-state'),
  subscriber: $('#subscriber-value'),
  queue: $('#queue-value'),
  uptime: $('#uptime-value'),
  search: $('#activity-search'),
  privacy: $('#privacy-toggle'),
  filters: $('#filters'),
  notice: $('#connection-notice'),
  sourceList: $('#source-list'),
  olderSources: $('#older-sources'),
  olderSourcesSummary: $('#older-sources-summary'),
  olderSourceList: $('#older-source-list'),
  empty: $('#empty-state'),
  loadOlder: $('#load-older'),
};

function el(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value !== undefined) node.textContent = String(value);
  return node;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function activity(raw) {
  if (!raw || raw.id === undefined) return null;
  return {
    id: String(raw.id),
    kind: String(raw.kind || 'unknown'),
    category: String(raw.category || 'system'),
    severity: String(raw.severity || 'info').toLowerCase(),
    priority: number(raw.priority),
    title: String(raw.title || ''),
    summary: String(raw.summary || ''),
    sourceRef: raw.sourceRef == null ? '' : String(raw.sourceRef),
    sourceType: raw.sourceType == null ? '' : String(raw.sourceType).toLowerCase(),
    sourceName: raw.sourceName == null ? '' : String(raw.sourceName),
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

function lastValue(events, selector) {
  for (const row of [...events].reverse()) {
    const value = selector(row);
    if (value !== undefined && value !== null && value !== '') return String(value);
  }
  return '';
}

function isFailure(row) {
  return row.severity === 'error'
    || FAILED.has(row.status)
    || /(?:failed|uncertain|interrupted)$/.test(row.kind);
}

function buildStories() {
  const rows = [...state.rows.values()].sort(eventOrder);
  const seqToTurn = new Map();
  for (const row of rows) {
    if (!row.turnId) continue;
    const extraSeqs = Array.isArray(row.metadata.inboundSeqs) ? row.metadata.inboundSeqs : [];
    for (const seq of [row.inboundSeq, ...extraSeqs]) {
      if (seq !== null && seq !== undefined) seqToTurn.set(String(seq), row.turnId);
    }
  }

  const storyRows = new Map();
  for (const row of rows) {
    const turn = row.turnId || seqToTurn.get(row.inboundSeq);
    const key = turn ? `turn:${turn}` : `activity:${row.id}`;
    if (!storyRows.has(key)) storyRows.set(key, []);
    storyRows.get(key).push(row);
  }

  return [...storyRows].map(([key, events]) => {
    events.sort(eventOrder);
    const latest = events.at(-1);
    const status = lastValue(events, (row) => KNOWN_STATUS.has(row.status) ? row.status : '');
    const rawSourceRef = lastValue(events, (row) => row.sourceRef);
    const sourceType = lastValue(events, (row) => row.sourceType || row.metadata.chatType);
    const sourceName = lastValue(events, (row) => row.sourceName);
    const isSystem = !rawSourceRef || rawSourceRef === 'system' || sourceType === 'system';
    const sourceRef = isSystem ? '' : rawSourceRef;
    const failed = events.some(isFailure);
    const activeSystemListener = isSystem
      && latest.kind === 'system.subscriber_started'
      && status === 'RUNNING';
    const active = !failed && ACTIVE.has(status) && (!isSystem || activeSystemListener);
    const hasReply = events.some((row) => REPLIED.has(row.status)
      || row.kind === 'delivery.sent' || row.kind === 'delivery.dry_run');
    const hasIgnore = events.some((row) => IGNORED.has(row.status)
      || row.kind === 'message.ignored' || row.kind === 'agent.silent');
    const stale = STALE.has(status) || events.some((row) =>
      row.kind === 'agent.stale' || row.kind === 'delivery.cancelled' || row.kind === 'system.stopped');

    let tone = 'neutral';
    if (failed) tone = 'failed';
    else if (active) tone = 'active';
    else if (hasReply) tone = 'reply';
    else if (hasIgnore) tone = 'ignore';
    else if (stale) tone = 'stale';
    else if (isSystem) tone = 'system';

    return {
      key,
      events,
      latest,
      status,
      sourceRef,
      sourceType,
      sourceName,
      sourceKey: sourceRef ? `chat:${sourceRef}` : 'system',
      isSystem,
      failed,
      active,
      tone,
      at: latest.createdAtMs,
    };
  }).sort((a, b) => b.at - a.at);
}

function storyMeta(story, key) {
  return lastValue(story.events, (row) => row.metadata[key]);
}

function storyInput(story) {
  const values = story.events
    .filter((row) => row.kind === 'message.received')
    .map((row) => row.summary)
    .filter(Boolean);
  return [...new Set(values)].join('\n');
}

function storyOutput(story) {
  const rows = [...story.events].reverse();
  return rows.find((row) => row.kind === 'delivery.sent' || row.kind === 'delivery.dry_run')?.summary
    || rows.find((row) => row.kind === 'agent.decided')?.summary
    || '';
}

function displayText(value) {
  return state.hideText && value ? '正文已隐藏' : value;
}

function clock(ms, seconds = false) {
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
    hour12: false,
  }).format(new Date(ms));
}

function exact(ms) {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(ms));
}

function dayNumber(ms) {
  const date = new Date(ms);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000;
}

function isCurrentOrToday(story) {
  return story.active || dayNumber(story.at) >= dayNumber(Date.now());
}

function storyLabel(story) {
  if (story.tone === 'failed') return '失败';
  if (story.tone === 'active') return '进行中';
  if (story.tone === 'reply') return '已回复';
  if (story.tone === 'ignore') return '忽略';
  if (story.tone === 'stale') return story.status === 'STOPPED' ? '已停止' : '已暂缓';
  if (story.isSystem) return '系统';
  return '';
}

function technicalData(story) {
  return story.events.map((row) => ({
    id: row.id,
    kind: row.kind,
    status: row.status || undefined,
    at: new Date(row.createdAtMs).toISOString(),
    sourceRef: row.sourceRef || undefined,
    sourceType: row.sourceType || undefined,
    sourceName: row.sourceName || undefined,
    conversationRef: row.conversationRef || undefined,
    turnId: row.turnId,
    inboundSeq: row.inboundSeq,
    outboxId: row.outboxId,
    summary: state.hideText && row.summary ? '[正文已隐藏]' : row.summary,
    metadata: row.metadata,
  }));
}

function storyCard(story) {
  const details = el('details', 'story');
  details.dataset.storyKey = story.key;
  details.dataset.tone = story.tone;

  const summary = el('summary');
  const messages = el('div', 'message-stack');
  const input = storyInput(story);
  const output = storyOutput(story);
  const addMessage = (direction, value) => {
    if (!value) return;
    const line = el('div', `message-row ${direction}`);
    line.dataset.direction = direction;
    const bubbleClass = direction === 'outgoing'
      ? 'message-bubble agent-message'
      : direction === 'note'
        ? 'message-bubble note-message'
        : 'message-bubble';
    line.append(el('div', bubbleClass, displayText(value)));
    messages.append(line);
  };
  addMessage('incoming', input);
  addMessage('outgoing', output);
  if (!input && !output) addMessage('note', story.latest.summary);
  if (messages.childElementCount) summary.append(messages);

  const meta = el('div', 'turn-meta');
  const time = el('time', 'story-time', clock(story.at));
  time.dateTime = new Date(story.at).toISOString();
  time.title = exact(story.at);
  meta.append(time);
  const label = storyLabel(story);
  if (label) meta.append(el('span', 'turn-status', label));
  meta.append(el('span', 'turn-disclosure', '详情'));
  summary.append(meta);
  details.append(summary);

  const body = el('div', 'story-body');
  const facts = el('dl', 'turn-facts');
  const addFact = (labelText, value) => {
    if (!value) return;
    facts.append(el('dt', '', labelText), el('dd', '', value));
  };
  const mode = storyMeta(story, 'deliveryMode');
  const reason = storyMeta(story, 'reasonCode');
  addFact('记录', story.latest.title || kindLabels[story.latest.kind] || story.latest.kind);
  addFact('判断', reasonLabels[reason] || reason);
  addFact('发送', { chat: '直接发送', reply: '普通引用', thread: 'Thread' }[mode] || mode);
  if (facts.childElementCount) body.append(facts);

  const stages = el('ol', 'stage-list');
  for (const row of story.events) {
    const stage = el('li', 'stage');
    const stageTime = el('time', 'stage-time', clock(row.createdAtMs, true));
    stageTime.dateTime = new Date(row.createdAtMs).toISOString();
    const copy = el('div');
    copy.append(el('div', 'stage-title', row.title || kindLabels[row.kind] || row.kind));
    if (row.summary) copy.append(el('div', 'stage-summary', displayText(row.summary)));
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

function renderStoryList(container, stories) {
  const fragment = document.createDocumentFragment();
  for (const story of stories) fragment.append(storyCard(story));
  container.replaceChildren(fragment);
}

function matches(story) {
  if (state.filter === 'reply' && story.tone !== 'reply') return false;
  if (state.filter === 'ignore' && story.tone !== 'ignore') return false;
  if (state.filter === 'failed' && story.tone !== 'failed') return false;
  if (state.filter === 'system' && !story.isSystem) return false;
  if (!state.query) return true;
  const searchable = JSON.stringify({
    sourceName: story.sourceName,
    sourceRef: story.sourceRef,
    sourceType: story.sourceType,
    events: story.events,
  }).toLocaleLowerCase();
  return searchable.includes(state.query);
}

function groupSources(stories) {
  const grouped = new Map();
  for (const story of stories) {
    if (!grouped.has(story.sourceKey)) {
      grouped.set(story.sourceKey, {
        key: story.sourceKey,
        ref: story.sourceRef,
        type: story.sourceType,
        name: story.sourceName,
        isSystem: story.isSystem,
        stories: [],
        at: story.at,
      });
    }
    const group = grouped.get(story.sourceKey);
    group.stories.push(story);
    group.at = Math.max(group.at, story.at);
    if (!group.type && story.sourceType) group.type = story.sourceType;
    if (!group.name && story.sourceName) group.name = story.sourceName;
  }
  return [...grouped.values()].sort((a, b) => {
    if (a.isSystem !== b.isSystem) return a.isSystem ? 1 : -1;
    return b.at - a.at;
  });
}

function sourceDisplayName(group) {
  if (group.name) return group.name;
  if (group.isSystem) return '系统';
  if (group.type === 'p2p' || group.type === 'private') return '私聊';
  if (group.type === 'group' || group.type === 'group_chat') return '未命名群聊';
  return '聊天';
}

function sourceKind(group) {
  if (group.isSystem) return '系统记录';
  if (group.type === 'p2p' || group.type === 'private') return '私聊';
  if (group.type === 'group' || group.type === 'group_chat') return '群聊';
  return '聊天';
}

function sourceAvatar(group) {
  if (group.isSystem) return '系';
  if (group.type === 'p2p' || group.type === 'private') return '私';
  return '群';
}

function sourceSection(group, options = {}) {
  const section = el(group.isSystem ? 'details' : 'section',
    group.isSystem ? 'source-group system-source' : 'source-group');
  section.dataset.sourceKey = group.key;
  const heading = el(group.isSystem ? 'summary' : 'header', 'source-heading');
  const identity = el('div', 'source-identity');
  const copy = el('div', 'source-copy');
  copy.append(
    el('h2', 'source-title', sourceDisplayName(group)),
    el('div', 'source-subtitle', `${sourceKind(group)} · ${group.stories.length} 条`),
  );
  identity.append(el('span', 'source-avatar', sourceAvatar(group)), copy);
  const time = el('time', 'source-time', clock(group.at));
  time.dateTime = new Date(group.at).toISOString();
  time.title = exact(group.at);
  heading.append(identity, time);
  section.append(heading);
  if (group.isSystem) {
    section.open = options.openSources?.has(group.key)
      || state.filter === 'system'
      || Boolean(state.query)
      || Boolean(group.stories[0]?.failed);
  }

  const recent = options.allOld ? group.stories : group.stories.filter(isCurrentOrToday);
  const older = options.allOld ? [] : group.stories.filter((story) => !isCurrentOrToday(story));
  const list = el('div', 'story-list');
  renderStoryList(list, recent);
  section.append(list);

  if (older.length) {
    const fold = el('details', 'source-old');
    fold.dataset.foldKey = group.key;
    fold.open = options.openFolds?.has(group.key) || Boolean(state.query) || state.filter !== 'all';
    const summary = el('summary');
    summary.append(el('span', '', '更早'), el('span', 'section-meta', `${older.length} 条`));
    const oldList = el('div', 'story-list');
    renderStoryList(oldList, older);
    fold.append(summary, oldList);
    section.append(fold);
  }
  return section;
}

function openStoryKeys() {
  return new Set([...document.querySelectorAll('.story[open]')].map((node) => node.dataset.storyKey));
}

function openFoldKeys() {
  return new Set([...document.querySelectorAll('.source-old[open]')].map((node) => node.dataset.foldKey));
}

function openSourceKeys() {
  return new Set([...document.querySelectorAll('.system-source[open]')].map((node) => node.dataset.sourceKey));
}

function updateCurrentState(stories) {
  if (dom.service.dataset.state === 'offline') return;
  const active = stories.filter((story) => story.active).length;
  const failed = stories.filter((story) => story.failed).length;
  if (active) dom.current.textContent = `运行中 ${active}`;
  else if (failed) dom.current.textContent = `失败记录 ${failed}`;
  else dom.current.textContent = state.service.ready ? '空闲' : '正在启动';
}

function render() {
  const openedStories = openStoryKeys();
  const openedFolds = openFoldKeys();
  const openedSources = openSourceKeys();
  const olderSourcesWasOpen = dom.olderSources.open;
  const allStories = buildStories();
  const stories = allStories.filter(matches);
  const groups = groupSources(stories);
  const currentGroups = groups.filter((group) => group.stories.some(isCurrentOrToday));
  const oldGroups = groups.filter((group) => !group.stories.some(isCurrentOrToday));

  dom.sourceList.replaceChildren(...currentGroups.map((group) =>
    sourceSection(group, { openFolds: openedFolds, openSources: openedSources })));
  dom.olderSourceList.replaceChildren(...oldGroups.map((group) =>
    sourceSection(group, { allOld: true, openSources: openedSources })));
  dom.olderSources.hidden = oldGroups.length === 0;
  dom.olderSourcesSummary.textContent = oldGroups.length
    ? `${oldGroups.length} 个 · ${oldGroups.reduce((sum, group) => sum + group.stories.length, 0)} 条`
    : '';
  dom.olderSources.open = oldGroups.length > 0 && (
    olderSourcesWasOpen || Boolean(state.query) || state.filter !== 'all'
  );

  const count = stories.length;
  dom.empty.hidden = count > 0;
  if (!count && state.initialized) {
    const narrowed = Boolean(state.query) || state.filter !== 'all';
    dom.empty.querySelector('h2').textContent = narrowed ? '没有匹配的活动' : '还没有活动';
    dom.empty.querySelector('p').textContent = narrowed
      ? '换个关键词，或切回“全部”查看。'
      : '给 Zayn 发一条飞书消息，它会出现在这里。';
  }
  dom.loadOlder.hidden = !state.nextCursor;
  updateCurrentState(allStories);

  document.querySelectorAll('.story').forEach((node) => {
    if (openedStories.has(node.dataset.storyKey)) node.open = true;
  });
}

function overview(key) {
  return number(state.overview[key]);
}

function serviceDisplay(offline = false) {
  if (offline) {
    dom.service.dataset.state = 'offline';
    dom.serviceText.textContent = '连接异常';
    dom.current.textContent = '无法连接 daemon';
    dom.subscriber.textContent = '订阅 未知';
    return;
  }
  const subscriber = state.service.subscriber === 'running';
  const mode = state.service.ready && subscriber ? 'ready' : subscriber ? 'starting' : 'offline';
  dom.service.dataset.state = mode;
  dom.serviceText.textContent = mode === 'ready' ? '正在监听' : mode === 'starting' ? '正在启动' : '订阅已停止';
  if (mode === 'offline') dom.current.textContent = '订阅已停止';
  dom.subscriber.textContent = subscriber ? '订阅 运行中' : '订阅 已停止';
  dom.queue.textContent = `队列 ${overview('queued')}`;
  const seconds = number(state.service.uptimeSeconds);
  dom.uptime.textContent = seconds < 3600
    ? `运行 ${Math.floor(seconds / 60)}m`
    : `运行 ${Math.floor(seconds / 3600)}h`;
  dom.updated.textContent = '刚刚';
  dom.updated.dateTime = new Date(state.fetchedAt).toISOString();
  dom.updated.title = exact(state.fetchedAt);
}

async function request(before) {
  const url = new URL(API, location.origin);
  url.searchParams.set('limit', LIMIT);
  if (before) url.searchParams.set('before', before);
  const response = await fetch(url, {
    headers: { accept: 'application/json' },
    cache: 'no-store',
  });
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
      const previous = state.rows.get(row.id);
      if (!previous || JSON.stringify(previous) !== JSON.stringify(row)) changed = true;
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
    for (const row of payload.activities) state.rows.set(row.id, row);
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
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
setInterval(() => {
  if (!document.hidden) refresh();
}, 5_000);
refresh(true);
