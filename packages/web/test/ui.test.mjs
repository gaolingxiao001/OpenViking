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

test('activity UI renders one transcript and labels only incoming messages with their source', () => {
  assert.match(js, /raw\.sourceRef/);
  assert.match(js, /sourceName: raw\.sourceName/);
  assert.match(js, /const sourceName = lastValue\(events, \(row\) => row\.sourceName\)/);
  assert.match(html, /id="transcript" class="transcript"/);
  assert.match(js, /renderTranscript\(dom\.transcript, recent/);
  assert.doesNotMatch(js, /function groupSources\(/);
  assert.doesNotMatch(js, /function sourceSection\(/);
  assert.match(js, /if \(story\.sourceName\) return story\.sourceName/);
  assert.match(js, /return '未命名群聊'/);
  assert.match(js, /direction === 'incoming' && !source\.isSystem/);
  assert.match(js, /el\('span', 'source-label'/);
  assert.doesNotMatch(js, /direction === 'outgoing'[\s\S]{0,160}source-label/);
  assert.match(html, /id="older-records"[^>]*hidden/);
  assert.match(html, />更早记录</);
});

test('message transcript uses incoming and outgoing bubbles with a blue agent reply', () => {
  assert.match(js, /for \(const input of inputs\) addMessage\('incoming', input\.text, input\)/);
  assert.match(js, /for \(const output of outputs\) addMessage\('outgoing', output\)/);
  assert.match(js, /`message-row \$\{direction\}`/);
  assert.match(css, /\.message-row\.incoming\s*\{[^}]*justify-content: flex-start/s);
  assert.match(css, /\.message-row\.outgoing\s*\{[^}]*justify-content: flex-end/s);
  assert.match(css, /\.message-column\s*\{[^}]*max-width: 76%/s);
  assert.match(css, /@media \(max-width: 460px\)[\s\S]*\.message-column\s*\{[^}]*max-width: 88%/s);
  assert.match(css, /\.agent-message\s*\{[^}]*background: var\(--blue\)[^}]*color: #fff/s);
});

test('each incoming event gets its own bubble and its own source label', () => {
  assert.match(js, /function storyInputs\(story\)/);
  assert.match(js, /\.filter\(\(row\) => INPUT_KINDS\.has\(row\.kind\) && row\.summary\)/);
  assert.match(js, /text: row\.summary/);
  assert.match(js, /sourceName: row\.sourceName \|\| story\.sourceName/);
  assert.match(js, /sourceType: row\.sourceType \|\| row\.metadata\.chatType \|\| story\.sourceType/);
  assert.match(js, /function messageRow\(source, direction, value\)/);
  assert.match(js, /sourceDisplayName\(source\)/);
  assert.doesNotMatch(js, /\[\.\.\.new Set\(values\)\]\.join/);
});

test('outgoing text keeps every Lark send while deduplicating legacy delivery copies', () => {
  assert.match(js, /'agent\.tool': '工具调用'/);
  assert.match(js, /function storyOutputs\(story\)/);
  assert.match(js, /row\.kind === 'agent\.tool' && row\.metadata\.deliveryMode && REPLIED\.has\(row\.status\)/);
  assert.match(js, /outputs\.push\(row\.summary\)/);
  assert.match(js, /const legacyKey = row\.outboxId \|\| row\.summary/);
  assert.match(js, /if \(seenLegacy\.has\(legacyKey\)\) continue/);
  assert.match(js, /if \(toolTexts\.has\(row\.summary\)\) continue/);
  assert.match(js, /const note = rows\.find\(\(row\) => row\.kind === 'agent\.note'\)/);
  assert.match(js, /const decision = rows\.find\(\(row\) => row\.kind === 'agent\.decided'\)/);
  assert.match(js, /return \[note\?\.summary \|\| decision\?\.summary \|\| ''\]\.filter\(Boolean\)/);
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

test('expanded details do not repeat message bodies and keep only decisions, tools, and diagnostics', () => {
  assert.match(js, /function eventIsTool\(row\)/);
  assert.match(js, /function eventIsDiagnostic\(row\)/);
  assert.match(js, /function operationalEvents\(story\)/);
  assert.match(js, /operationalEvents\(story\)/);
  assert.match(js, /addFact\('判断'/);
  assert.match(js, /addFact\('发送'/);
  assert.match(js, /addFact\('状态'/);
  assert.doesNotMatch(js, /addFact\('记录'/);
  assert.doesNotMatch(js, /for \(const row of story\.events\) \{[\s\S]{0,500}stage-summary/);
  assert.doesNotMatch(js, /summary: state\.hideText && row\.summary/);
  assert.match(js, /const stageTitle = eventIsTool\(row\)[\s\S]*row\.metadata\.toolLabel/);
  assert.match(js, /const stageSummary = eventIsTool\(row\)[\s\S]*isFailure\(row\) \? '调用失败' : ''/);
  assert.match(js, /!visibleTexts\.has\(stageSummary\)/);
  assert.match(js, /stageSummary !== stageTitle/);
});

test('incoming messages without an agent reply collapse even when there is only one', () => {
  assert.match(js, /const INPUT_KINDS = new Set\(\['message\.received', 'message\.ignored', 'message\.duplicate'\]\)/);
  assert.match(js, /\.filter\(\(row\) => INPUT_KINDS\.has\(row\.kind\) && row\.summary\)/);
  assert.match(js, /function isQuietIncoming\(story\)/);
  assert.match(js, /function compactTranscript\(stories\)/);
  assert.match(js, /runType === 'quiet-incoming'[\s\S]*\? run\.length > 0/);
  assert.match(js, /\? 'quiet-incoming'/);
  assert.match(js, /el\('details', 'quiet-incoming-fold'\)/);
  assert.match(js, /`\$\{quietIncomingCount\(batch\.stories\)\} 条未回复消息`/);
  assert.match(js, /compactTranscript\(stories\)/);
  assert.match(js, /Boolean\(state\.query\) \|\| state\.filter === 'ignore'/);
  assert.match(js, /operationalEvents\(story\)\.length === 0/);
  assert.match(css, /\.quiet-incoming-fold\s*>\s*summary/);
});

test('routine system chatter folds while tools and diagnostics stay in the transcript', () => {
  assert.match(js, /function isRoutineSystem\(story\)/);
  assert.match(js, /story\.isSystem && !story\.failed/);
  assert.match(js, /operationalEvents\(story\)\.length === 0/);
  assert.match(js, /\? 'system-activity'/);
  assert.match(js, /function systemActivityFold\(batch, openedFolds\)/);
  assert.match(js, /el\('details', 'system-activity-fold'\)/);
  assert.match(js, /`\$\{batch\.stories\.length\} 条系统记录`/);
  assert.match(js, /state\.filter === 'system'/);
  assert.match(js, /function shouldDisplayStory\(story\)/);
  assert.match(js, /!isRoutineSystem\(story\)/);
  assert.match(js, /filter\(shouldDisplayStory\)/);
  assert.match(css, /\.system-activity-fold\s*>\s*summary/);
});

test('small viewport rules prevent page overflow and keep filters scrollable', () => {
  assert.match(css, /html\s*\{[^}]*overflow-x: hidden/s);
  assert.match(css, /body\s*\{[^}]*overflow-x: hidden/s);
  assert.match(css, /\.filter-list\s*\{[^}]*overflow-x: auto/s);
  assert.match(css, /\.technical-details pre\s*\{[^}]*max-width: 100%[^}]*overflow: auto/s);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*scroll-behavior: auto/);
});

test('renderer uses safe DOM APIs only', () => {
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(js, /node\.textContent = String\(value\)/);
});
