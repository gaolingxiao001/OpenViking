import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(testDir, '..', 'public');
const [html, css, js] = await Promise.all([
  readFile(path.join(publicDir, 'index.html'), 'utf8'),
  readFile(path.join(publicDir, 'activity.css'), 'utf8'),
  readFile(path.join(publicDir, 'activity.js'), 'utf8'),
]);

test('页面骨架是时间轴模式：详情区 + 分隔条 + 多轨道区 + 播放头', () => {
  for (const id of ['detail', 'divider', 'timeline', 'gutter', 'viewport', 'world', 'playhead']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="z-def"[^>]*>默认</);
  assert.match(html, /id="z-fit"[^>]*>全览</);
  assert.match(html, /id="clock"/);
});

test('保留实例切换、会话选择与隐私开关', () => {
  assert.match(html, /id="instance-select"/);
  assert.match(html, /id="session-select"/);
  assert.match(html, /id="session-prev"/);
  assert.match(html, /id="session-next"/);
  assert.match(html, /id="follow-live"/);
  assert.match(html, /id="privacy-toggle"/);
  assert.match(js, /const INSTANCES_API = '\/api\/instances'/);
  assert.match(js, /url\.searchParams\.set\('instance', state\.instance\)/);
  assert.match(js, /url\.searchParams\.set\('epoch'/);
  assert.match(js, /function selectSession\(/);
  assert.match(js, /function stepSession\(/);
  assert.match(js, /dom\.instance\.addEventListener\('change'/);
  assert.match(js, /dom\.session\.addEventListener\('change'/);
  assert.match(js, /state\.rows\.clear\(\)/);
  assert.match(js, /history\.replaceState/);
  assert.match(js, /classList\.toggle\('privacy'\)/);
  assert.match(css, /body\.privacy \.card \.body/);
  assert.match(css, /\.session-picker/);
});

test('activity 行按 category 映射到六条轨道，命令 kind 单独进命令轨', () => {
  assert.match(js, /message: 'message'/);
  assert.match(js, /agent: 'agent'/);
  assert.match(js, /delivery: 'delivery'/);
  assert.match(js, /command: 'command'/);
  assert.match(js, /system: 'system'/);
  assert.match(js, /function eventTrack\(/);
  assert.match(js, /startsWith\('command\.'\)/);
  assert.match(js, /startsWith\('agent\.'\)/);
  for (const label of ['回合', '消息', '助手', '投递', '命令', '系统']) {
    assert.match(js, new RegExp(`label: '${label}'`));
  }
});

test('回合与投递配对成时间段，空白折叠', () => {
  assert.match(js, /row\.kind === 'agent\.turn_started'/);
  assert.match(js, /row\.kind === 'delivery\.queued'/);
  assert.match(js, /deliveries\.set\(row\.outboxId, ev\)/);
  assert.match(js, /GAP_MIN_MS = 120_000/);
  assert.match(js, /GAP_VIRTUAL_MS = 10_000/);
  assert.match(js, /function buildTimeMap\(/);
  assert.match(js, /function realToDisp\(/);
  assert.match(js, /function dispToReal\(/);
});

test('详情区全量渲染，双向同步，忽略功能齐备', () => {
  assert.match(js, /function buildDetail\(\)/);
  assert.match(js, /createElement\('details'\)/);
  assert.match(js, /cardEls = S\.events\.map/); // 全量，不再切片
  assert.match(js, /function syncDetailToPlayhead\(\)/);
  assert.match(js, /dom\.detail\.addEventListener\('scroll'/);
  assert.match(js, /querySelectorAll\('\.card:not\(\.hidden\)'\)/);
  assert.match(js, /contextmenu/);
  assert.match(js, /function toggleIgnoreTrack\(/);
  assert.match(js, /function toggleIgnoreEvent\(/);
  assert.match(css, /\.blk\.ignored/);
  assert.match(css, /\.card\.hidden/);
  assert.match(css, /\.gcell\.ignored/);
});

test('轮询增量合并并尽量保持视图，支持加载更早', () => {
  assert.match(js, /POLL_MS = 4000/);
  assert.match(js, /setInterval\(refreshLatest, POLL_MS\)/);
  assert.match(js, /state\.rows\.has\(row\.id\)/);
  assert.match(js, /rebuildFromRows\(true\)/);
  assert.match(js, /followTail/);
  assert.match(js, /url\.searchParams\.set\('before', String\(before\)\)/);
  assert.match(html, /id="load-older"/);
});

test('渲染层只用安全 DOM API', () => {
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test('时间轴视觉规格：轨道高度与扁平配色', () => {
  assert.match(css, /\.lane \{[^}]*height: 52px/s);
  assert.match(css, /\.blk \{[^}]*border-radius: 8px/s);
  assert.match(css, /\.b-message \{[^}]*var\(--teal\)/s);
  assert.match(css, /\.b-agent \{[^}]*var\(--coral\)/s);
  assert.match(css, /\.b-delivery \{[^}]*var\(--sky\)/s);
  assert.match(css, /\.b-command \{[^}]*var\(--sunny\)/s);
  assert.match(css, /\.b-system \{[^}]*var\(--gray\)/s);
  assert.match(css, /\.b-turn \{[^}]*var\(--mint\)/s);
});
