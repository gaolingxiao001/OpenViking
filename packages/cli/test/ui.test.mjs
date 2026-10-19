import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { bannerLines, openingBanner, playBanner } from '../src/banner.mjs';
import { Prompter } from '../src/prompt.mjs';
import { opener, qrLines, showScan } from '../src/qr.mjs';
import { ansi256, box, colorDepth, mix, stripAnsi, width } from '../src/ui.mjs';

// A colour terminal of a given size, recording what is written.
function screen({ columns = 100, rows = 40, depth = 24 } = {}) {
  const output = new PassThrough();
  Object.assign(output, { isTTY: true, columns, rows, getColorDepth: () => depth });
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  return { output, written: () => written };
}

test('widths count CJK as two columns and escape codes as none', () => {
  assert.equal(width('abc'), 3);
  assert.equal(width('飞书 · 微信'), 11);
  assert.equal(width('\x1b[38;2;1;2;3m飞\x1b[0m'), 2);
  assert.equal(stripAnsi('\x1b[1mVIKA\x1b[22m'), 'VIKA');
});

test('colours fall back to 256 colours, and nothing without a terminal', () => {
  assert.equal(ansi256([255, 0, 0]), 196);
  assert.equal(ansi256([128, 128, 128]), 244);
  assert.deepEqual(mix([[0, 0, 0], [200, 100, 0]], 0.5), [100, 50, 0]);
  assert.equal(colorDepth(new PassThrough()), 1);
  assert.equal(colorDepth(screen({ depth: 8 }).output, { LC_TERMINAL: 'iTerm2' }), 24, 'iTerm2 over ssh still has truecolor');
});

test('a box lines up its borders whatever the text is', () => {
  const { output } = screen();
  const lines = stripAnsi(box(['机器人  小V · Codex', 'IM  飞书'], { output, title: '将添加实例 primary' })).split('\n');
  assert.equal(new Set(lines.map(width)).size, 1, lines.join('\n'));
});

test('every banner frame fits the terminal; a narrow one drops the wordmark', () => {
  for (const t of [0, 0.37, 1.2, 2.9, 7.5]) {
    const wide = bannerLines(t, { depth: 24, version: '0.4.0-cdb22789fc75', columns: 100 });
    assert.equal(wide.length, 17);
    assert.ok(wide.every((line) => width(line) <= 100), `t=${t}`);
    assert.ok(wide.some((line) => stripAnsi(line).includes('╚═══╝  ╚═╝╚═╝')));
    const narrow = bannerLines(t, { depth: 8, columns: 60 });
    assert.ok(narrow.every((line) => width(line) <= 46) && !narrow.some((line) => line.includes('██╗')));
  }
});

test('the boat rides the swell: it pitches both ways and rises and falls, never far', async () => {
  const { pose } = await import('../src/banner.mjs');
  const poses = Array.from({ length: 120 }, (_, index) => pose(index / 12));
  const degrees = poses.map(({ angle }) => (angle * 180) / Math.PI);
  assert.ok(Math.min(...degrees) < -3 && Math.max(...degrees) > 3, 'bow down and bow up');
  assert.ok(degrees.every((angle) => Math.abs(angle) < 6), 'a gentle sea');
  const rises = poses.map(({ rise }) => rise);
  assert.ok(Math.min(...rises) < -0.7 && Math.max(...rises) > 0.7 && rises.every((rise) => Math.abs(rise) < 2));
});

// A screen that keeps what was written where: cursor moves, save and
// restore, and colour, which is all the banner uses.
function emulator(rows, columns) {
  const grid = Array.from({ length: rows }, () => Array.from({ length: columns }, () => ' '));
  let row = 0;
  let column = 0;
  let saved = [0, 0];
  let sgr = '';
  const feed = (text) => {
    for (const match of text.matchAll(/\x1b\[\?\d+[hl]|\x1b\[(\d*)(?:;(\d*))?([HAGJK])|\x1b\[[0-9;]*m|\x1b([78])|\n|[\s\S]/gu)) {
      const [token, a, b, command, save] = match;
      if (token.startsWith('\x1b[?')) continue;
      if (command === 'H') { row = Number(a || 1) - 1; column = Number(b || 1) - 1; continue; }
      if (command === 'A') { row -= Number(a || 1); continue; }
      if (command === 'G') { column = Number(a || 1) - 1; continue; }
      if (command) continue;
      // Reset restores the same default colours as an untouched cell.
      if (token.endsWith('m') && token.startsWith('\x1b[')) { sgr = token === '\x1b[0m' ? '' : token; continue; }
      if (save === '7') { saved = [row, column]; continue; }
      if (save === '8') { [row, column] = saved; continue; }
      if (token === '\n') { row += 1; column = 0; continue; }
      grid[row][column] = `${sgr}${token}`;
      column += width(token);
    }
  };
  return { feed, grid };
}

test('drawing only what changed ends with the same screen as drawing the frame whole', async () => {
  const { painting } = await import('../src/banner.mjs');
  const { painter, bannerCells, render } = painting;
  for (const depth of [24, 8]) {
    const at = (frame) => bannerCells(frame / 14, { version: '1.0.0', columns: 100 });
    const live = emulator(17, 100);
    const paint = painter(depth, (row, column) => `\x1b[${row + 1};${column + 1}H`);
    for (let frame = 0; frame <= 56; frame += 1) live.feed(paint(at(frame)));
    const whole = emulator(17, 100);
    whole.feed(render(at(56), depth).map((line, index) => `\x1b[${index + 1};1H${line}`).join(''));
    const differ = [];
    live.grid.forEach((row, r) => row.forEach((cell, c) => { if (cell !== whole.grid[r][c] && !(cell === ' ' && whole.grid[r][c] === ' ')) differ.push([r, c, JSON.stringify(cell), JSON.stringify(whole.grid[r][c])]); }));
    assert.deepEqual(differ.slice(0, 5), [], `depth ${depth}`);
  }
});

test('no row of the banner reaches the last column, where a terminal would wrap', async () => {
  const { painting, miniLines } = await import('../src/banner.mjs');
  for (const columns of [46, 60, 78, 79, 80, 100]) {
    for (const t of [0, 1.3, 2.7]) {
      const widest = Math.max(...painting.bannerCells(t, { version: '0.4.0-3a941c53ad48', columns }).map((row) => row.reduce((sum, cell) => sum + width(cell.ch), 0)));
      assert.ok(widest < Math.max(columns, 47), `${columns} columns: ${widest}`);
      if (columns >= 50) assert.ok(miniLines(t, { columns }).every((line) => width(line) < columns));
    }
  }
});

test('a frame drawn over the last one never clears a row first', async () => {
  const { painting } = await import('../src/banner.mjs');
  const paint = painting.painter(24, (row, column) => `\x1b[${row + 1};${column + 1}H`);
  paint(painting.bannerCells(0, { columns: 100 }));
  const next = paint(painting.bannerCells(1 / 14, { columns: 100 }));
  assert.ok(next.length > 0);
  assert.doesNotMatch(next, /\x1b\[2?K/);
});

test('the banner is one plain title line on a terminal that is too small or has no colour', async () => {
  const small = screen({ columns: 40 });
  await playBanner({ output: small.output, input: new PassThrough(), env: {} });
  assert.equal(stripAnsi(small.written()).trim(), 'VIKA  把本机的 coding agent 带上船');
  const still = screen();
  await playBanner({ output: still.output, input: new PassThrough(), env: { VIKA_NO_ANIMATION: '1' } });
  assert.equal(stripAnsi(still.written()).split('\n').filter((line) => line.includes('╚═══╝  ╚═╝╚═╝')).length, 1, 'one frame, drawn once');
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('on a tall window the boat stays at the top and keeps sailing until released', async () => {
  const { output, written } = screen({ columns: 100, rows: 40 });
  const banner = await openingBanner({ output, input: new PassThrough(), env: {}, version: '1.0.0' });
  assert.match(written(), /\x1b\[19;40r\x1b\[19;1H/, 'questions scroll below the 17-row scene');
  await pause(200);
  const frames = written().split('\x1b7').length - 1;
  assert.ok(frames >= 2, `redrawn while waiting (${frames} frames)`);
  banner.release();
  assert.ok(written().endsWith('\x1b7\x1b[r\x1b8'), 'the whole screen is the terminal\'s again');
  const after = written().length;
  await pause(150);
  assert.equal(written().length, after, 'no frames after release');
  banner.resume();
  assert.match(written().slice(after), /\x1b\[19;40r/);
  banner.release();
  banner.release();
  assert.equal(process.listenerCount('SIGINT'), 0);
});

test('on a short window the scene plays, then a small boat stays at the top', async () => {
  const { output, written } = screen({ columns: 100, rows: 26 });
  const banner = await openingBanner({ output, input: new PassThrough(), env: {}, durationMs: 50 });
  assert.match(stripAnsi(written()), /╚═══╝  ╚═╝╚═╝/, 'the full scene first');
  assert.match(written(), /\x1b\[4;26r/, 'then a two-row header');
  banner.release();
});

test('on a colour terminal an answered question folds into one line', async () => {
  const { output, written } = screen();
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const prompter = new Prompter({ input, output, env: {} });
  assert.equal(prompter.fancy, true);
  setImmediate(() => input.write('小V\r'));
  assert.equal(await prompter.text('机器人名字', { initial: 'Vika' }), '小V');
  setImmediate(() => input.write('\x1b[B\r'));
  assert.equal(await prompter.select('运行时', [{ label: 'Codex', value: 'codex' }, { label: 'Pi', value: 'pi' }]), 'pi');
  const plain = stripAnsi(written());
  assert.match(plain, /✔ 机器人名字 · 小V\n/);
  assert.match(plain, /✔ 运行时 · Pi\n/);
});

test('going back takes the screen back: below a pinned header the questions are drawn again from the record', () => {
  const { output, written } = screen();
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode() {} });
  const prompter = new Prompter({ input, output, env: {} });
  prompter.pageTop = () => 18;
  prompter.write('kept\n');
  const mark = prompter.mark();
  prompter.write('gone\n');
  prompter.rewind(mark);
  assert.ok(written().endsWith('\x1b[18;1H\x1b[Jkept\n'));
  assert.deepEqual(prompter.transcript, ['kept\n']);
  // Without a pinned header, the rows written since are cleared in place.
  prompter.pageTop = null;
  const later = prompter.mark();
  prompter.write('one\ntwo\n');
  prompter.rewind(later);
  assert.ok(written().endsWith('\r\x1b[2A\x1b[J'));
});

test('a code too big for the window waits for the window to grow, then draws itself', () => {
  const url = `https://open.feishu.cn/page/cli?addons=${'x'.repeat(1500)}`;
  const qrWidth = width(qrLines(url)[0]);
  assert.ok(qrWidth > 120, `Feishu-sized codes are wide (${qrWidth})`);
  const { output, written } = screen({ columns: 100, rows: 40 });
  const prompter = new Prompter({ input: new PassThrough(), output, env: {} });
  const scan = showScan(prompter, { url, title: '第 1 次扫码', env: {} });
  assert.match(stripAnsi(written()), /这个二维码要 \d+×\d+ 的终端，现在是 100×40/);
  assert.doesNotMatch(written(), /█/);
  Object.assign(output, { columns: 200, rows: 120 });
  output.emit('resize');
  assert.match(written(), /█/);
  scan.stop();
  assert.equal(output.listenerCount('resize'), 0);
});

test('a link opens in a browser only where there is a desktop', () => {
  assert.equal(opener({}, 'darwin'), 'open');
  assert.equal(opener({ DISPLAY: ':0' }, 'linux'), 'xdg-open');
  assert.equal(opener({}, 'linux'), null, 'a server over ssh');
});
