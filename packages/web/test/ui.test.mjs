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

test('activity UI groups by opaque source and folds old and system activity', () => {
  assert.match(js, /raw\.sourceRef/);
  assert.match(js, /rawSourceRef === 'system'/);
  assert.match(js, /sourceKey: sourceRef \? `chat:\$\{sourceRef\}` : 'system'/);
  assert.match(js, /a\.isSystem !== b\.isSystem/);
  assert.match(html, /id="older-sources"[^>]*hidden/);
  assert.match(js, /className, 'source-old'|el\('details', 'source-old'\)/);
  assert.match(js, /'source-group system-source'/);
});

test('status color hierarchy keeps cards minimal and agent copy blue', () => {
  assert.match(css, /\.story\[data-tone="failed"\][^{]*\{[^}]*var\(--red-bg\)/s);
  assert.match(css, /\.story\[data-tone="active"\][^{]*\{[^}]*var\(--amber-bg\)/s);
  assert.match(css, /\.story\[data-tone="ignore"\][^{]*\{[^}]*var\(--surface\)/s);
  assert.doesNotMatch(css, /\.story\[data-tone="reply"\]\s*\{[^}]*background/s);
  assert.match(css, /\.agent-message\s*\{[^}]*background: var\(--blue\)/s);
  assert.match(js, /if \(failed\) tone = 'failed';[\s\S]*else if \(active\) tone = 'active';[\s\S]*else if \(hasReply\) tone = 'reply';/);
  assert.match(js, /latest\.kind === 'system\.subscriber_started'[\s\S]*status === 'RUNNING'/);
  assert.match(js, /'STOPPED'/);
});

test('renderer uses safe DOM APIs only', () => {
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(js, /node\.textContent = String\(value\)/);
});
