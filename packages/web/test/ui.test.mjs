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

test('页面骨架：顶栏 + 压缩时间带 + 上下文流', () => {
  for (const id of ['strip', 'strip-track', 'feed', 'entries', 'live', 'load-older', 'follow-live']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(css, /\.strip-track \{[^}]*height: 36px/s);
});

test('保留实例切换、会话选择与隐私开关', () => {
  for (const id of ['instance-select', 'session-select', 'session-prev', 'session-next', 'privacy-toggle']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(js, /const INSTANCES_API = '\/api\/instances'/);
  assert.match(js, /url\.searchParams\.set\('instance', state\.instance\)/);
  assert.match(js, /url\.searchParams\.set\('epoch'/);
  assert.match(js, /history\.replaceState/);
  assert.match(js, /classList\.toggle\('privacy'\)/);
  assert.match(css, /body\.privacy \.txt/);
});

test('实时：每秒按 after 游标增量拉取，空会话不走 after', () => {
  assert.match(js, /POLL_MS = 1000/);
  assert.match(js, /fetchActivity\(state\.rows\.size \? \{ after: maxId\(\) \} : \{\}\)/);
  assert.match(js, /while \(data\.hasNewer && state\.rows\.size\)/);
  assert.match(js, /\{ before: state\.nextCursor \}/);
});

test('回合分组：消息按 inboundSeqs 归入回合，工具按 toolId 配对', () => {
  assert.match(js, /kind === 'agent\.turn_started'/);
  assert.match(js, /claim\(open, meta\.inboundSeqs\)/);
  assert.match(js, /tools\.get\(toolId\)/);
  assert.match(js, /LARK_DELIVERY = /);
  assert.match(js, /CLI_DELIVERY = /); // Pi/方舟经 bash 调 lark-cli 发消息，同样算输出
  assert.match(js, /模型实际收到/);
});

test('时间带折叠长空白并高亮视口内回合', () => {
  assert.match(js, /GAP_MS = 120_000/);
  assert.match(js, /function buildTimeMap\(/);
  assert.match(js, /IntersectionObserver/);
  assert.match(css, /\.strip \.bar\.inview/);
});

test('每轮输入/输出单独成区，系统事件进侧栏', () => {
  assert.match(js, /'io io-in'/);
  assert.match(js, /`io io-out/);
  assert.match(js, /kind\.startsWith\('system\.'\)\) \{ system\.push\(row\)/);
  assert.match(html, /id="system"/);
});

test('渲染层只用安全 DOM API', () => {
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});
