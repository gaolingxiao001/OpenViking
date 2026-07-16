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

test('activity UI exposes the five compact filters without action-oriented failure copy', () => {
  for (const filter of ['all', 'reply', 'ignore', 'failed', 'system']) {
    assert.match(html, new RegExp(`data-filter="${filter}"`));
  }
  assert.doesNotMatch(`${html}\n${css}\n${js}`, /需要处理|需处理/);
  assert.match(js, /if \(story\.tone === 'failed'\) return '失败';/);
  assert.match(js, /if \(story\.tone === 'ignore'\) return '忽略';/);
});

test('activity UI groups by opaque source, prefers a stored chat name, and folds old content', () => {
  assert.match(js, /raw\.sourceRef/);
  assert.match(js, /sourceName: raw\.sourceName/);
  assert.match(js, /const sourceName = lastValue\(events, \(row\) => row\.sourceName\)/);
  assert.match(js, /name: story\.sourceName/);
  assert.match(js, /if \(group\.name\) return group\.name/);
  assert.match(js, /return '未命名群聊'/);
  assert.match(js, /sourceName: story\.sourceName/);
  assert.match(js, /rawSourceRef === 'system'/);
  assert.match(js, /sourceKey: sourceRef \? `chat:\$\{sourceRef\}` : 'system'/);
  assert.match(js, /a\.isSystem !== b\.isSystem/);
  assert.doesNotMatch(js, /el\('span', 'source-ref'/);
  assert.match(js, /sourceRef: row\.sourceRef \|\| undefined/);
  assert.match(html, /id="older-sources"[^>]*hidden/);
  assert.match(js, /className, 'source-old'|el\('details', 'source-old'\)/);
  assert.match(js, /'source-group system-source'/);
});

test('message transcript uses incoming and outgoing bubbles with a blue agent reply', () => {
  assert.match(js, /addMessage\('incoming', input\)/);
  assert.match(js, /addMessage\('outgoing', output\)/);
  assert.match(js, /`message-row \$\{direction\}`/);
  assert.match(css, /\.message-row\.incoming\s*\{[^}]*justify-content: flex-start/s);
  assert.match(css, /\.message-row\.outgoing\s*\{[^}]*justify-content: flex-end/s);
  assert.match(css, /\.message-bubble\s*\{[^}]*max-width: 76%/s);
  assert.match(css, /@media \(max-width: 460px\)[\s\S]*\.message-bubble\s*\{[^}]*max-width: 88%/s);
  assert.match(css, /\.agent-message\s*\{[^}]*background: var\(--blue\)[^}]*color: #fff/s);
});

test('status color is limited to lightweight status text and ignore stays neutral', () => {
  assert.match(css, /\.story\[data-tone="failed"\] \.turn-status\s*\{[^}]*color: var\(--red\)/s);
  assert.match(css, /\.story\[data-tone="active"\] \.turn-status\s*\{[^}]*color: var\(--amber\)/s);
  assert.match(css, /\.story\[data-tone="ignore"\] \.turn-status\s*\{[^}]*color: var\(--muted\)/s);
  assert.doesNotMatch(css, /\.story\[data-tone="(?:failed|active|ignore|reply)"\]\s*\{/);
  assert.match(js, /if \(failed\) tone = 'failed';[\s\S]*else if \(active\) tone = 'active';[\s\S]*else if \(hasReply\) tone = 'reply';/);
  assert.match(js, /latest\.kind === 'system\.subscriber_started'[\s\S]*status === 'RUNNING'/);
  assert.match(js, /'STOPPED'/);
});

test('native details keep summaries compact and reveal operational detail on demand', () => {
  assert.match(js, /const details = el\('details', 'story'\)/);
  assert.match(js, /const summary = el\('summary'\)/);
  assert.match(js, /el\('span', 'turn-disclosure', '详情'\)/);
  assert.match(js, /const body = el\('div', 'story-body'\)/);
  assert.match(js, /details\.append\(body\)/);
  assert.match(js, /document\.querySelectorAll\('\.story\[open\]'\)/);
  assert.match(js, /openedStories\.has\(node\.dataset\.storyKey\)/);
  assert.match(html, /<details class="runtime-details">/);
  assert.doesNotMatch(html, /<details class="runtime-details" open/);
});

test('small viewport rules prevent page overflow and keep filters scrollable', () => {
  assert.match(css, /html\s*\{[^}]*overflow-x: hidden/s);
  assert.match(css, /body\s*\{[^}]*overflow-x: hidden/s);
  assert.match(css, /\.filter-list\s*\{[^}]*overflow-x: auto/s);
  assert.match(css, /\.technical-details pre\s*\{[^}]*max-width: 100%[^}]*overflow: auto/s);
});

test('renderer uses safe DOM APIs only', () => {
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(js, /node\.textContent = String\(value\)/);
});
