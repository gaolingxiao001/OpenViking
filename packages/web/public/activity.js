/* Agent Activity —— 时间轴模式。
   数据：/api/activity（daemon activities 表），轮询增量合并。
   布局：上方全量详情卡片，下方多轨道时间轴（拖动回放 / 滚轮缩放 / 空白折叠 / 右键忽略）。 */
'use strict';

const INSTANCES_API = '/api/instances';
const ACTIVITY_API = '/api/activity';
const PAGE_LIMIT = 100;
const POLL_MS = 4000;
const MAX_ROWS = 5000;
const GAP_MIN_MS = 120_000;
const GAP_VIRTUAL_MS = 10_000; // 折叠缝在显示轴上的虚拟宽度
const MIN_SPAN = 1000;

const TRACKS = [
  { key: 'turn',     label: '回合' },
  { key: 'message',  label: '消息' },
  { key: 'agent',    label: '助手' },
  { key: 'delivery', label: '投递' },
  { key: 'command',  label: '命令' },
  { key: 'system',   label: '系统' },
];
const TRACK_LABEL = Object.fromEntries(TRACKS.map((t) => [t.key, t.label]));

const dom = {
  instance: document.getElementById('instance-select'),
  session: document.getElementById('session-select'),
  sessionPrev: document.getElementById('session-prev'),
  sessionNext: document.getElementById('session-next'),
  status: document.getElementById('service-status'),
  statusText: document.getElementById('service-status-text'),
  crumb: document.getElementById('crumb'),
  clock: document.getElementById('clock'),
  slider: document.getElementById('z-slider'),
  spanLabel: document.getElementById('span-label'),
  detail: document.getElementById('detail'),
  divider: document.getElementById('divider'),
  timeline: document.getElementById('timeline'),
  gutter: document.getElementById('gutter'),
  viewport: document.getElementById('viewport'),
  world: document.getElementById('world'),
  privacy: document.getElementById('privacy-toggle'),
  followLive: document.getElementById('follow-live'),
  loadOlder: document.getElementById('load-older'),
  counts: document.getElementById('counts'),
  notice: document.getElementById('connection-notice'),
};

const state = {
  instance: null,
  epoch: 'current',      // 'current' | number | null (all)
  currentEpoch: null,
  sessions: [],
  rows: new Map(),       // id -> activity row
  nextCursor: null,
  service: null,
  timer: null,
  filling: false,
};

// ---------- 小工具 ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtSpan(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}min`;
  return `${(ms / 3600000).toFixed(2)}h`;
}
function fmtDur(ms) {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m${Math.round((ms % 60000) / 1000)}s`;
  if (ms < 86400000) return `${(ms / 3600000).toFixed(1)}h`;
  return `${(ms / 86400000).toFixed(1)}d`;
}
function fmtDay(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function viewingHistorical() {
  return typeof state.epoch === 'number' && state.epoch !== state.currentEpoch;
}
function selectedSession() {
  if (state.epoch === null) return null;
  const epoch = state.epoch === 'current' ? state.currentEpoch : state.epoch;
  return state.sessions.find((session) => session.epoch === epoch) ?? null;
}

function lastInterestingMs(model) {
  for (let i = model.events.length - 1; i >= 0; i -= 1) {
    if (model.events[i].track !== 'system') return model.events[i].end || model.events[i].t;
  }
  return model.meta.endMs;
}

function frameSession(model) {
  if (viewingHistorical() || state.epoch === null) {
    spanMs = Math.max(total, MIN_SPAN);
    centerDisp = total / 2;
    followTail = false;
    return;
  }
  spanMs = DEFAULT_SPAN;
  const interesting = lastInterestingMs(model);
  if (model.meta.endMs - interesting <= DEFAULT_SPAN) {
    centerDisp = total;
    followTail = true;
  } else {
    centerDisp = realToDisp(interesting);
    followTail = false;
  }
}

// ---------- activity 行 → 时间轴模型 ----------
const KIND_TRACK = {
  message: 'message',
  agent: 'agent',
  delivery: 'delivery',
  command: 'command',
  system: 'system',
};

function eventTrack(row) {
  const kind = String(row.kind || '');
  if (kind.startsWith('command.')) return 'command';
  if (kind.startsWith('agent.')) return 'agent';
  if (kind.startsWith('message.')) return 'message';
  if (kind.startsWith('delivery.')) return 'delivery';
  return KIND_TRACK[row.category] || 'system';
}

function buildModel(rows) {
  const events = [];
  const turns = new Map();     // turnId -> { startMs, endMs }
  const deliveries = new Map(); // outboxId -> queued event

  for (const row of rows) {
    const t = row.createdAtMs;
    const track = eventTrack(row);
    const ok = row.severity !== 'error';
    const warn = row.severity === 'warning';

    if (row.kind === 'agent.turn_started' || row.kind === 'agent.turn_completed') {
      const key = row.turnId ?? row.id;
      const seg = turns.get(key) || { startMs: t, endMs: null };
      if (row.kind === 'agent.turn_started') seg.startMs = t;
      else seg.endMs = t;
      turns.set(key, seg);
      continue;
    }

    const meta = row.metadata && Object.keys(row.metadata).length
      ? JSON.stringify(row.metadata, null, 2)
      : '';
    const ev = {
      id: `a${row.id}`,
      t,
      end: null,
      track,
      kind: row.kind,
      title: row.title || row.kind,
      body: row.summary || '',
      output: meta,
      ok,
      warn,
      sourceName: row.sourceName || null,
      status: row.status || null,
    };
    if (row.kind === 'delivery.queued' && row.outboxId != null) {
      deliveries.set(row.outboxId, ev);
    } else if (row.kind === 'delivery.sent' && row.outboxId != null) {
      const start = deliveries.get(row.outboxId);
      if (start) { start.end = t; deliveries.delete(row.outboxId); }
    }
    events.push(ev);
  }

  events.sort((a, b) => a.t - b.t);

  const gaps = [];
  for (let i = 1; i < events.length; i++) {
    if (events[i].t - events[i - 1].t > GAP_MIN_MS) {
      gaps.push({ startMs: events[i - 1].t, endMs: events[i].t });
    }
  }

  const startMs = events.length ? events[0].t : Date.now();
  const endMs = events.length ? events[events.length - 1].t : startMs + 1;
  return {
    meta: { startMs, endMs },
    events,
    gaps,
    turns: [...turns.values()].sort((a, b) => a.startMs - b.startMs),
  };
}

// ---------- 时间轴视口状态 ----------
let S = null;
let tmap = { segs: [], gapSegs: [], totalDisp: 1 };
let total = 1;
let DEFAULT_SPAN = 60000;
let centerDisp = 0;
let spanMs = 60000;
let selectedId = null;
let blocks = [];
let blockById = new Map();
let gutterByTrack = new Map();
let ignoredIds = new Set();
let ignoredTracks = new Set();
let visibleIdx = [];
let cardEls = [];
let activeIdx = -1;
let followTail = true;

const pxPerMs = () => dom.viewport.clientWidth / spanMs;
const t2x = (t) => realToDisp(t) * pxPerMs();

function buildTimeMap(startMs, endMs, gaps) {
  const segs = [], gapSegs = [];
  let d = 0, cur = startMs;
  for (const g of gaps) {
    if (g.startMs > cur) { segs.push({ r0: cur, r1: g.startMs, d0: d }); d += g.startMs - cur; }
    gapSegs.push({ r0: g.startMs, r1: g.endMs, d0: d });
    d += GAP_VIRTUAL_MS;
    cur = Math.max(cur, g.endMs);
  }
  if (cur < endMs) { segs.push({ r0: cur, r1: endMs, d0: d }); d += endMs - cur; }
  return { segs, gapSegs, totalDisp: Math.max(1, d) };
}
function realToDisp(t) {
  for (const s of tmap.segs) { if (t <= s.r1) return s.d0 + Math.max(0, t - s.r0); }
  return tmap.totalDisp;
}
function dispToReal(d) {
  for (const s of tmap.segs) { if (d < s.d0 + (s.r1 - s.r0)) return s.r0 + (d - s.d0); }
  for (const g of tmap.gapSegs) { if (d < g.d0 + GAP_VIRTUAL_MS) return d - g.d0 < GAP_VIRTUAL_MS / 2 ? g.r0 : g.r1; }
  return S ? S.meta.endMs : 0;
}

// ---------- 时间轴 DOM ----------
function buildTimeline() {
  dom.world.replaceChildren();
  dom.gutter.replaceChildren();
  blockById = new Map();
  gutterByTrack = new Map();
  const laneEls = new Map();

  const gRuler = document.createElement('div');
  gRuler.className = 'gcell ruler';
  gRuler.textContent = 'TIME';
  dom.gutter.appendChild(gRuler);
  const ruler = document.createElement('div');
  ruler.id = 'ruler';
  dom.world.appendChild(ruler);

  for (const tr of TRACKS) {
    const g = document.createElement('div');
    g.className = `gcell t-${tr.key}`;
    g.textContent = tr.label;
    if (tr.key !== 'turn') {
      g.classList.add('ignorable');
      g.title = `右键忽略/恢复「${tr.label}」轨道`;
      g.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        toggleIgnoreTrack(tr.key);
      });
    }
    dom.gutter.appendChild(g);
    gutterByTrack.set(tr.key, g);
    const lane = document.createElement('div');
    lane.className = 'lane';
    lane.dataset.lane = tr.key;
    dom.world.appendChild(lane);
    laneEls.set(tr.key, lane);
  }

  for (const g of S.gaps) {
    for (const target of [ruler, ...laneEls.values()]) {
      const el = document.createElement('div');
      el.className = 'gap';
      el.dataset.vgap = '1';
      el.dataset.t0 = g.startMs; el.dataset.t1 = g.endMs;
      el.textContent = `✂ ${fmtSpan(g.endMs - g.startMs)}`;
      target.appendChild(el);
    }
  }

  for (const tn of S.turns) {
    const el = document.createElement('div');
    el.className = 'blk b-turn';
    el.dataset.t0 = tn.startMs; el.dataset.t1 = tn.endMs || tn.startMs;
    el.textContent = '▶ 回合';
    laneEls.get('turn').appendChild(el);
  }

  for (const ev of S.events) {
    const el = document.createElement('div');
    const isSeg = ev.end != null && ev.end > ev.t;
    el.className = `blk${isSeg ? '' : ' pt'} b-${ev.track}${ev.ok === false ? ' bad' : ''}${ev.warn ? ' warn' : ''}`;
    el.dataset.t0 = ev.t; el.dataset.t1 = isSeg ? ev.end : ev.t;
    el.dataset.eid = ev.id;
    el.textContent = ev.title;
    el.title = `${fmtClock(ev.t)}  [${TRACK_LABEL[ev.track] || ev.track}] ${ev.title}\n右键忽略此条`;
    laneEls.get(ev.track).appendChild(el);
    blockById.set(ev.id, el);
    el._ev = ev;
    el.addEventListener('click', () => {
      if (dragMoved) return;
      selectedId = ev.id;
      followTail = false;
      centerDisp = realToDisp(ev.end != null ? (ev.t + ev.end) / 2 : ev.t);
      render();
    });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  blocks = [...dom.world.querySelectorAll('.blk, .gap')];
}

// ---------- 忽略 ----------
function isIgnored(ev) {
  return ignoredTracks.has(ev.track) || ignoredIds.has(ev.id);
}
function rebuildVisible() {
  visibleIdx = [];
  for (let i = 0; i < S.events.length; i++) {
    if (!isIgnored(S.events[i])) visibleIdx.push(i);
  }
}
function applyIgnoreState() {
  for (const el of blockById.values()) {
    if (el._ev) el.classList.toggle('ignored', isIgnored(el._ev));
  }
  cardEls.forEach((card, j) => card.classList.toggle('hidden', isIgnored(S.events[j])));
  for (const [key, g] of gutterByTrack) g.classList.toggle('ignored', ignoredTracks.has(key));
  rebuildVisible();
  updateCounts();
  render();
}
function toggleIgnoreEvent(id) {
  if (ignoredIds.has(id)) ignoredIds.delete(id); else ignoredIds.add(id);
  applyIgnoreState();
}
function toggleIgnoreTrack(track) {
  if (ignoredTracks.has(track)) ignoredTracks.delete(track); else ignoredTracks.add(track);
  applyIgnoreState();
}
dom.viewport.addEventListener('contextmenu', (e) => {
  const blk = e.target.closest('.blk');
  if (!blk || !blk.dataset.eid) return;
  e.preventDefault();
  toggleIgnoreEvent(blk.dataset.eid);
});

// ---------- 布局 ----------
function layout() {
  const k = pxPerMs();
  for (const el of blocks) {
    const t0 = +el.dataset.t0, t1 = +el.dataset.t1;
    el.style.left = t2x(t0) + 'px';
    let w = 0;
    if (el.dataset.vgap) w = GAP_VIRTUAL_MS * k;
    else if (t1 > t0) w = (realToDisp(t1) - realToDisp(t0)) * k;
    if (w > 0) {
      el.style.width = Math.max(4, w) + 'px';
      el.classList.toggle('tiny', w < 44);
    }
  }
  dom.world.style.width = total * k + 'px';
  drawRuler();
}

function drawRuler() {
  const ruler = document.getElementById('ruler');
  ruler.querySelectorAll('.tick').forEach((n) => n.remove());
  const steps = [500, 1000, 2000, 5000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000, 21600000];
  const k = pxPerMs();
  const step = steps.find((s) => s * k >= 96) || steps[steps.length - 1];
  const v0 = centerDisp - spanMs / 2, v1 = centerDisp + spanMs / 2;
  for (const s of tmap.segs) {
    if (s.d0 + (s.r1 - s.r0) < v0 || s.d0 > v1) continue;
    for (let t = Math.ceil(s.r0 / step) * step; t <= s.r1; t += step) {
      const d = s.d0 + (t - s.r0);
      if (d < v0 || d > v1) continue;
      const el = document.createElement('div');
      el.className = 'tick';
      el.style.left = t2x(t) + 'px';
      const lbl = document.createElement('span');
      lbl.className = 'lbl';
      lbl.textContent = fmtClock(t);
      el.appendChild(lbl);
      ruler.appendChild(el);
    }
  }
}

function applyPan() {
  dom.world.style.transform = `translateX(${dom.viewport.clientWidth / 2 - centerDisp * pxPerMs()}px)`;
}

// ---------- 详情面板（全量渲染） ----------
function nearestIdx(t) {
  const evs = S.events;
  const idx = visibleIdx;
  if (!idx.length) return -1;
  let lo = 0, hi = idx.length - 1, best = idx[0], bd = Infinity;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const evI = idx[mid];
    const d = Math.abs(evs[evI].t - t);
    if (d < bd) { bd = d; best = evI; }
    if (evs[evI].t < t) lo = mid + 1; else hi = mid - 1;
  }
  return best;
}

function buildDetail() {
  const frag = document.createDocumentFragment();
  cardEls = S.events.map((ev, j) => {
    const card = document.createElement('div');
    card.className = `card c-${ev.track}${ev.ok === false ? ' sev-error' : ''}`;
    card.dataset.t = ev.t;
    card.dataset.idx = j;

    const head = document.createElement('div');
    head.className = 'chead';
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = TRACK_LABEL[ev.track] || ev.track;
    const kind = document.createElement('span');
    kind.className = 'kind-label';
    kind.textContent = ev.kind;
    const ts = document.createElement('span');
    ts.className = 'ts';
    ts.textContent = fmtClock(ev.t);
    head.append(chip, kind, ts);
    if (ev.sourceName) {
      const src = document.createElement('span');
      src.className = 'src';
      src.textContent = `@ ${ev.sourceName}`;
      head.appendChild(src);
    }
    if (ev.end != null && ev.end > ev.t) {
      const dur = document.createElement('span');
      dur.className = 'dur';
      dur.textContent = '⏱ ' + fmtDur(ev.end - ev.t);
      head.appendChild(dur);
    }

    const body = document.createElement('div');
    body.className = 'body';
    body.textContent = ev.body ? `${ev.title}\n${ev.body}` : ev.title;
    card.append(head, body);

    if (ev.output) {
      const details = document.createElement('details');
      details.className = 'meta';
      const summary = document.createElement('summary');
      summary.textContent = 'METADATA';
      const out = document.createElement('pre');
      out.className = 'code output';
      out.textContent = ev.output;
      details.append(summary, out);
      card.append(details);
    }
    card.addEventListener('click', () => {
      followTail = false;
      centerDisp = realToDisp(ev.t);
      render();
    });
    frag.appendChild(card);
    return card;
  });
  dom.detail.replaceChildren(frag);
  activeIdx = -1;
}

function setActiveCard(i) {
  if (i === activeIdx) return;
  if (activeIdx >= 0 && cardEls[activeIdx]) cardEls[activeIdx].classList.remove('active');
  if (cardEls[i]) cardEls[i].classList.add('active');
  activeIdx = i;
}

let syncingDetail = false;
function syncDetailToPlayhead() {
  if (!cardEls.length) return;
  const i = nearestIdx(dispToReal(centerDisp));
  if (i < 0) return;
  setActiveCard(i);
  const el = cardEls[i];
  const r = el.getBoundingClientRect();
  const dr = dom.detail.getBoundingClientRect();
  syncingDetail = true;
  dom.detail.scrollTop += (r.top + r.height / 2) - (dr.top + dr.height / 2);
  setTimeout(() => (syncingDetail = false), 80);
}

// 详情 → 时间轴 反向同步
let scrollRaf = 0;
dom.detail.addEventListener('scroll', () => {
  if (syncingDetail || !S || !S.events.length || scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0;
    const dr = dom.detail.getBoundingClientRect();
    const mid = dr.top + dr.height / 2;
    let best = null, bd = Infinity;
    for (const card of dom.detail.querySelectorAll('.card:not(.hidden)')) {
      const r = card.getBoundingClientRect();
      const d = Math.abs(r.top + r.height / 2 - mid);
      if (d < bd) { bd = d; best = card; }
    }
    if (!best) return;
    const t = +best.dataset.t;
    if (!Number.isNaN(t)) {
      followTail = false;
      centerDisp = realToDisp(t);
      setActiveCard(+best.dataset.idx);
      render(false);
    }
  });
});

// ---------- 渲染 ----------
function renderSelection() {
  dom.world.querySelectorAll('.blk.selected').forEach((n) => n.classList.remove('selected'));
  if (selectedId) {
    const el = dom.world.querySelector(`[data-eid="${selectedId}"]`);
    if (el) el.classList.add('selected');
  }
}

let raf = 0;
let wantDetail = true;
function render(withDetail = true) {
  wantDetail = wantDetail || withDetail;
  if (raf || !S) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    const doDetail = wantDetail;
    wantDetail = false;
    spanMs = clamp(spanMs, MIN_SPAN, Math.max(total, MIN_SPAN));
    centerDisp = clamp(centerDisp, 0, total);
    layout();
    applyPan();
    if (doDetail) syncDetailToPlayhead();
    renderSelection();
    updateFollowButton();
    dom.clock.textContent = fmtClock(dispToReal(centerDisp));
    dom.spanLabel.textContent = fmtSpan(spanMs);
    dom.slider.value = String(Math.round(spanToSlider(spanMs)));
  });
}

function spanToSlider(span) {
  const t = (Math.log(span) - Math.log(MIN_SPAN)) / (Math.log(Math.max(total, MIN_SPAN + 1)) - Math.log(MIN_SPAN));
  return (1 - clamp(t, 0, 1)) * 1000;
}
function sliderToSpan(v) {
  const t = 1 - v / 1000;
  return Math.exp(Math.log(MIN_SPAN) + t * (Math.log(Math.max(total, MIN_SPAN + 1)) - Math.log(MIN_SPAN)));
}

function updateCounts() {
  if (!S) return;
  const ignored = S.events.length - visibleIdx.length;
  const session = selectedSession();
  const scope = state.epoch === null ? '全部' : viewingHistorical() ? '历史会话' : '本会话';
  const remaining = session && session.activityCount > state.rows.size
    ? session.activityCount - state.rows.size
    : 0;
  dom.counts.textContent = [
    `${S.events.length} 条${scope}事件`,
    remaining ? `还可加载 ${remaining}` : null,
    S.gaps.length ? `折叠 ${S.gaps.length} 段空白` : null,
    ignored ? `已忽略 ${ignored}` : null,
  ].filter(Boolean).join(' · ');
  if (remaining > 0) {
    dom.loadOlder.textContent = `加载更早（${remaining}）`;
  } else {
    dom.loadOlder.textContent = '加载更早';
  }
}

// ---------- 模型装配（支持轮询增量下的视图保持） ----------
function setModel(model, { preserve }) {
  S = model;
  tmap = buildTimeMap(S.meta.startMs, S.meta.endMs, S.gaps);
  total = tmap.totalDisp;
  DEFAULT_SPAN = Math.min(total, 10 * 60 * 1000);
  if (!preserve) frameSession(model);
  else if (followTail) centerDisp = total;
  buildTimeline();
  buildDetail();
  rebuildVisible();
  applyIgnoreStateShallow();
  document.body.classList.add('loaded');
  updateCounts();
  const session = selectedSession();
  const scope = state.epoch === null
    ? '全部会话'
    : session
      ? (session.current ? '当前会话' : '历史会话')
      : '会话';
  dom.crumb.textContent = `${scope} · ${S.events.length} 条 · ${fmtSpan(S.meta.endMs - S.meta.startMs)}`;
  render();
}

// 轮询重建后恢复忽略样式（不触发再次 render 循环）
function applyIgnoreStateShallow() {
  for (const el of blockById.values()) {
    if (el._ev && isIgnored(el._ev)) el.classList.add('ignored');
  }
  cardEls.forEach((card, j) => {
    if (isIgnored(S.events[j])) card.classList.add('hidden');
  });
  for (const [key, g] of gutterByTrack) g.classList.toggle('ignored', ignoredTracks.has(key));
}

// ---------- 数据层 ----------
function epochFromUrl() {
  const value = new URL(window.location.href).searchParams.get('epoch');
  if (value === 'all') return null;
  if (value && /^[1-9]\d{0,8}$/.test(value)) return Number(value);
  return 'current';
}

function syncUrl() {
  const url = new URL(window.location.href);
  if (state.instance) url.searchParams.set('instance', state.instance);
  else url.searchParams.delete('instance');
  if (state.epoch === null) url.searchParams.set('epoch', 'all');
  else if (typeof state.epoch === 'number') url.searchParams.set('epoch', String(state.epoch));
  else url.searchParams.delete('epoch');
  history.replaceState(null, '', url);
}

function sessionLabel(session) {
  const d = new Date(session.startMs);
  const when = `${d.getMonth() + 1}月${d.getDate()}日`;
  if (session.current) {
    const runtime = session.runtime ? `${session.runtime} · ` : '';
    return `当前 · ${runtime}${when}至今`;
  }
  return `${when} · ${session.activityCount} 条`;
}

function sessionTitle(session) {
  const range = session.endMs
    ? `${fmtDay(session.startMs)} – ${fmtDay(session.endMs)}`
    : `${fmtDay(session.startMs)} 至今`;
  return `${range} · ${session.activityCount} 条`;
}

function renderSessions() {
  const selected = state.epoch === null
    ? 'all'
    : String(state.epoch === 'current' ? (state.currentEpoch ?? '') : state.epoch);
  const fragment = document.createDocumentFragment();
  for (const session of state.sessions) {
    const option = document.createElement('option');
    option.value = String(session.epoch);
    option.textContent = sessionLabel(session);
    option.title = sessionTitle(session);
    fragment.appendChild(option);
  }
  const all = document.createElement('option');
  all.value = 'all';
  all.textContent = '全部会话';
  fragment.appendChild(all);
  dom.session.replaceChildren(fragment);
  if ([...dom.session.options].some((option) => option.value === selected)) {
    dom.session.value = selected;
  } else if (state.sessions.length) {
    dom.session.value = String(state.sessions[0].epoch);
  }
  dom.session.disabled = false;
  const epochs = state.sessions.map((session) => session.epoch);
  const index = epochs.indexOf(Number(dom.session.value));
  const viewingAll = state.epoch === null;
  dom.sessionPrev.disabled = viewingAll || index < 0 || index >= epochs.length - 1;
  dom.sessionNext.disabled = viewingAll || index <= 0;
  document.body.classList.toggle('historical', viewingHistorical());
}

function applySessions(sessions) {
  const previousCurrent = state.currentEpoch;
  state.sessions = Array.isArray(sessions) ? sessions : [];
  const current = state.sessions.find((session) => session.current);
  state.currentEpoch = current ? current.epoch : null;
  if (typeof state.epoch === 'number' && !state.sessions.some((session) => session.epoch === state.epoch)) {
    state.epoch = 'current';
  }
  if (state.epoch === 'current' && previousCurrent != null
    && state.currentEpoch != null && previousCurrent !== state.currentEpoch) {
    state.rows.clear();
    state.nextCursor = null;
  }
  renderSessions();
}

function updateFollowButton() {
  if (viewingHistorical()) {
    dom.followLive.hidden = false;
    dom.followLive.textContent = '回到当前会话';
    return;
  }
  if (!followTail && S) {
    dom.followLive.hidden = false;
    dom.followLive.textContent = '回到最新';
    return;
  }
  dom.followLive.hidden = true;
}

function activityUrl() {
  const url = new URL(ACTIVITY_API, window.location.origin);
  url.searchParams.set('limit', String(PAGE_LIMIT));
  if (state.instance) url.searchParams.set('instance', state.instance);
  if (state.epoch === 'current') url.searchParams.set('epoch', 'current');
  else if (typeof state.epoch === 'number') url.searchParams.set('epoch', String(state.epoch));
  return url;
}

async function fetchPage(before) {
  const url = activityUrl();
  if (before != null) url.searchParams.set('before', String(before));
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function mergeRows(list) {
  let added = 0;
  for (const row of list || []) {
    if (!state.rows.has(row.id)) { state.rows.set(row.id, row); added++; }
  }
  if (state.rows.size > MAX_ROWS) {
    const sorted = [...state.rows.keys()].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - MAX_ROWS; i++) state.rows.delete(sorted[i]);
  }
  return added;
}

function rebuildFromRows(preserve) {
  const rows = [...state.rows.values()].sort((a, b) => a.createdAtMs - b.createdAtMs);
  setModel(buildModel(rows), { preserve });
}

function updateService(service) {
  if (!service) return;
  state.service = service;
  const ok = service.ready;
  dom.status.classList.toggle('ok', Boolean(ok) && !viewingHistorical());
  dom.status.classList.toggle('bad', !ok);
  if (!ok) {
    dom.statusText.textContent = '服务未就绪';
    return;
  }
  if (viewingHistorical()) {
    dom.statusText.textContent = '历史会话 · 不跟随实时';
    return;
  }
  dom.statusText.textContent = `就绪 · 订阅 ${service.subscriber || '—'} · 运行 ${fmtDur((service.uptimeSeconds || 0) * 1000)}`;
}

async function refreshLatest() {
  try {
    const data = await fetchPage(null);
    dom.notice.hidden = true;
    applySessions(data.sessions);
    updateService(data.service);
    state.nextCursor = data.nextCursor ?? state.nextCursor;
    const added = mergeRows(data.activities);
    if (!S && state.rows.size) rebuildFromRows(false);
    else if (added > 0) rebuildFromRows(true);
    else updateFollowButton();
    dom.loadOlder.hidden = !state.nextCursor;
    updateCounts();
  } catch (error) {
    dom.status.classList.add('bad');
    dom.statusText.textContent = '连接失败';
    dom.notice.hidden = false;
    dom.notice.textContent = `无法连接 daemon：${error.message}`;
  }
}

async function loadOlder({ silent = false } = {}) {
  if (state.nextCursor == null) return 0;
  dom.loadOlder.disabled = true;
  try {
    const data = await fetchPage(state.nextCursor);
    applySessions(data.sessions);
    state.nextCursor = data.nextCursor ?? null;
    const added = mergeRows(data.activities);
    if (added > 0 && !silent) {
      followTail = false;
      rebuildFromRows(true);
    }
    return added;
  } catch (error) {
    dom.notice.hidden = false;
    dom.notice.textContent = `加载更早失败：${error.message}`;
    return 0;
  } finally {
    dom.loadOlder.hidden = state.nextCursor == null;
    dom.loadOlder.disabled = false;
    if (!silent) updateCounts();
  }
}

async function fillOlder() {
  if (state.filling) return;
  state.filling = true;
  try {
    let added = 0;
    while (state.nextCursor != null && state.rows.size < MAX_ROWS) {
      added += await loadOlder({ silent: true });
    }
    if (added > 0) rebuildFromRows(false);
    else updateCounts();
  } finally {
    state.filling = false;
    dom.loadOlder.hidden = state.nextCursor == null;
  }
}

function resetView() {
  state.rows.clear();
  state.nextCursor = null;
  S = null;
  ignoredIds = new Set();
  ignoredTracks = new Set();
  selectedId = null;
}

async function selectSession(value) {
  if (value === 'all') state.epoch = null;
  else if (value === 'current') state.epoch = 'current';
  else {
    const epoch = Number(value);
    state.epoch = epoch === state.currentEpoch ? 'current' : epoch;
  }
  resetView();
  followTail = !viewingHistorical();
  syncUrl();
  renderSessions();
  await refreshLatest();
  if (state.epoch !== null) await fillOlder();
}

function stepSession(delta) {
  if (state.epoch === null || !state.sessions.length) return;
  const epochs = state.sessions.map((session) => session.epoch);
  const current = state.epoch === 'current' ? state.currentEpoch : state.epoch;
  const index = epochs.indexOf(current);
  const next = epochs[index + delta];
  if (next == null) return;
  void selectSession(String(next));
}

function startPolling() {
  clearInterval(state.timer);
  state.timer = setInterval(refreshLatest, POLL_MS);
}

// ---------- 实例切换 ----------
async function loadInstances() {
  try {
    const data = await (await fetch(INSTANCES_API, { headers: { accept: 'application/json' } })).json();
    dom.instance.replaceChildren();
    for (const inst of data.instances) {
      const opt = document.createElement('option');
      opt.value = inst.id;
      opt.textContent = inst.label;
      dom.instance.appendChild(opt);
    }
    const fromUrl = new URL(window.location.href).searchParams.get('instance');
    state.instance = data.instances.some((i) => i.id === fromUrl) ? fromUrl : data.defaultInstance;
    state.epoch = epochFromUrl();
    dom.instance.value = state.instance;
    dom.instance.disabled = false;
  } catch {
    dom.statusText.textContent = '实例列表读取失败';
  }
}

dom.instance.addEventListener('change', () => {
  state.instance = dom.instance.value;
  state.epoch = 'current';
  resetView();
  followTail = true;
  syncUrl();
  void refreshLatest();
});

dom.session.addEventListener('change', () => {
  void selectSession(dom.session.value);
});
dom.sessionPrev.addEventListener('click', () => stepSession(1));
dom.sessionNext.addEventListener('click', () => stepSession(-1));

// ---------- 交互：平移 / 缩放 ----------
let dragging = false, dragMoved = false, dragX = 0;
dom.viewport.addEventListener('pointerdown', (e) => {
  dragging = true; dragMoved = false; dragX = e.clientX;
  dom.viewport.classList.add('dragging');
  dom.viewport.setPointerCapture(e.pointerId);
});
dom.viewport.addEventListener('pointermove', (e) => {
  if (!dragging || !S) return;
  const dx = e.clientX - dragX;
  if (Math.abs(dx) > 3) { dragMoved = true; followTail = false; }
  dragX = e.clientX;
  centerDisp -= dx / pxPerMs();
  render();
});
const endDrag = () => {
  dragging = false;
  dom.viewport.classList.remove('dragging');
  setTimeout(() => (dragMoved = false), 0);
};
dom.viewport.addEventListener('pointerup', endDrag);
dom.viewport.addEventListener('pointercancel', endDrag);

dom.viewport.addEventListener('wheel', (e) => {
  if (!S) return;
  e.preventDefault();
  if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) { centerDisp += e.deltaX / pxPerMs(); followTail = false; }
  else spanMs *= Math.pow(1.0018, e.deltaY);
  render();
}, { passive: false });

document.getElementById('z-in').addEventListener('click', () => { spanMs /= 1.6; render(); });
document.getElementById('z-out').addEventListener('click', () => { spanMs *= 1.6; render(); });
document.getElementById('z-def').addEventListener('click', () => { spanMs = DEFAULT_SPAN; render(); });
document.getElementById('z-fit').addEventListener('click', () => {
  if (S) { spanMs = total; centerDisp = total / 2; followTail = false; render(); }
});
dom.slider.addEventListener('input', () => { spanMs = sliderToSpan(+dom.slider.value); render(); });

window.addEventListener('keydown', (e) => {
  if (!S || e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === '+' || e.key === '=') { spanMs /= 1.6; render(); }
  else if (e.key === '-') { spanMs *= 1.6; render(); }
  else if (e.key === '0') { spanMs = DEFAULT_SPAN; render(); }
  else if (e.key === '9') { spanMs = total; centerDisp = total / 2; followTail = false; render(); }
  else if (e.key === 'ArrowLeft') { centerDisp -= spanMs * 0.08; followTail = false; render(); }
  else if (e.key === 'ArrowRight') { centerDisp += spanMs * 0.08; render(); }
  else if (e.key === 'i') {
    const i = nearestIdx(dispToReal(centerDisp));
    if (i >= 0) toggleIgnoreEvent(S.events[i].id);
  } else if (e.key === '[') stepSession(1);
  else if (e.key === ']') stepSession(-1);
  else if (e.key === 'l' || e.key === 'L') dom.followLive.click();
});

window.addEventListener('resize', () => render());

// ---------- 分隔条 ----------
{
  let on = false, y0 = 0, h0 = 0;
  dom.divider.addEventListener('pointerdown', (e) => {
    on = true; y0 = e.clientY; h0 = dom.timeline.offsetHeight;
    dom.divider.setPointerCapture(e.pointerId);
  });
  dom.divider.addEventListener('pointermove', (e) => {
    if (!on) return;
    dom.timeline.style.flexBasis = clamp(h0 + (y0 - e.clientY), 140, window.innerHeight - 200) + 'px';
    render();
  });
  dom.divider.addEventListener('pointerup', () => (on = false));
}

// ---------- 隐私开关 ----------
dom.privacy.addEventListener('click', () => {
  const on = document.body.classList.toggle('privacy');
  dom.privacy.setAttribute('aria-pressed', String(on));
  dom.privacy.textContent = on ? '显示正文' : '隐藏正文';
});

// ---------- 回到最新 / 当前会话 ----------
dom.followLive.addEventListener('click', () => {
  if (viewingHistorical()) {
    void selectSession('current');
    return;
  }
  followTail = true;
  if (S) {
    centerDisp = total;
    render();
  }
});

// ---------- 加载更早 ----------
dom.loadOlder.addEventListener('click', () => { void loadOlder(); });

// ---------- 启动 ----------
(async () => {
  await loadInstances();
  await refreshLatest();
  if (state.epoch !== null) await fillOlder();
  startPolling();
})();
