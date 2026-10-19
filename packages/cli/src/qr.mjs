import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PALETTE, SYMBOLS, colorDepth, mix, stripAnsi, width } from './ui.mjs';
import { qrMatrix, qrPng, terminalQr } from './qr-code.mjs';

// Feishu's permission-bearing link may be too large for a terminal. Always
// provide a private PNG that VS Code can preview, as well as a compact code
// when it fits. Print long links first so they cannot scroll the code away.

export function qrLines(url) {
  return terminalQr(qrMatrix(url));
}

// The program that opens a link on this machine's desktop; none on a server.
export function opener(env = process.env, platform = process.platform) {
  if (platform === 'darwin') return 'open';
  if (platform === 'linux' && (env.DISPLAY || env.WAYLAND_DISPLAY)) return 'xdg-open';
  return null;
}

export function openUrl(url, { env = process.env, platform = process.platform } = {}) {
  const program = opener(env, platform);
  if (!program) return false;
  try {
    spawn(program, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    return true;
  } catch {
    return false;
  }
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function oneLine(text, columns) {
  if (width(text) < columns) return text;
  let result = '';
  for (const character of stripAnsi(text)) {
    if (width(result + character) >= columns - 2) break;
    result += character;
  }
  return `${result}…`;
}

// prompter: the setup Prompter. where: what to open the link in (飞书 / 微信).
// stopKey: a key that ends the wait (resolves `pressed` with true); `keys`
// are more keys with their labels and actions, e.g. { o: ['浏览器打开', fn] };
// onBack, when given, runs on ← or Esc (going back while nothing is made yet).
// Returns { imagePath, pressed, status(label), say(text), stop() }.
export function showScan(prompter, {
  url, title, where = '飞书', label = '等待扫码', stopKey = null, stopLabel = '', keys = {}, onBack = null, env = process.env,
}) {
  const { output, s } = prompter;
  const matrix = qrMatrix(url);
  const lines = terminalQr(matrix, s.enabled ? colorDepth(output, env) : 1);
  const qrWidth = Math.max(...lines.map((line) => width(line)));
  const needRows = lines.length + 2;
  const fits = () => !output.isTTY || ((output.columns ?? 0) > qrWidth && (output.rows ?? 0) >= needRows);
  let imageDirectory, imagePath;
  const cleanupImage = () => {
    try { if (imageDirectory) fs.rmSync(imageDirectory, { recursive: true, force: true }); } catch { /* Best effort on exit. */ }
  };
  try {
    imageDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'vika-qr-'));
    imagePath = path.join(imageDirectory, 'scan.png');
    fs.writeFileSync(imagePath, qrPng(matrix), { mode: 0o600, flag: 'wx' });
    process.on('exit', cleanupImage);
  } catch { cleanupImage(); imageDirectory = null; imagePath = null; }
  const canOpen = Boolean(opener(env));
  const imageOpener = env.TERM_PROGRAM === 'vscode' || env.VSCODE_IPC_HOOK_CLI ? 'code' : opener(env);
  const actions = {
    ...(canOpen ? { o: ['浏览器打开', () => { if (openUrl(url, { env })) say('已在浏览器打开，按页面提示确认'); }] } : {}),
    ...(imagePath && imageOpener ? { i: ['查看二维码图片', () => {
      try {
        spawn(imageOpener, imageOpener === 'code' ? ['--reuse-window', imagePath] : [imagePath],
          { detached: true, stdio: 'ignore', env }).on('error', () => say('未能自动打开，请点击上方图片路径')).unref();
      } catch { say('未能自动打开，请点击上方图片路径'); }
    }] } : {}), ...keys,
  };

  let ticker = null;
  let frame = 0;
  let current = label;
  const started = Date.now();
  const hints = [...Object.entries(actions).map(([key, [text]]) => `${key} ${text}`), ...(stopKey ? [`${stopKey} ${stopLabel}`] : []),
    ...(onBack ? ['← 返回'] : [])];
  const line = () => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    if (!prompter.fancy) return `  ${current} ${clock}${hints.length ? `（${hints.map((hint) => `按 ${hint}`).join('，')}）` : ''}`;
    const glyph = s.paint(FRAMES[frame % FRAMES.length], mix(PALETTE.sail, frame / 24, { cycle: true }));
    const keysText = hints.map((hint) => `${s.bold(hint.split(' ')[0])} ${hint.split(' ').slice(1).join(' ')}`).join(s.gray(' · '));
    return `  ${glyph} ${current} ${s.gray(clock)}${hints.length ? `   ${s.gray('│')} ${keysText}` : ''}`;
  };
  const draw = () => { output.write(`\r\x1b[2K${oneLine(line(), output.columns || 80)}`); frame += 1; };
  const print = (text) => {
    if (ticker) output.write('\r\x1b[2K');
    output.write(text);
    if (ticker) draw();
  };
  function say(text) {
    print(prompter.fancy ? `  ${s.gray(SYMBOLS.info)} ${text}\n` : `  ${text}\n`);
  }

  const head = prompter.fancy ? `\n  ${s.accent('▣')} ${s.bold(title)}\n` : `\n${title}\n`;
  const code = `${lines.join('\r\n')}\r\n`;
  let shown = fits();
  output.write(head);
  const link = `扫不出来的话，在${where}里打开这个链接${canOpen ? '，或按 o 用浏览器打开' : ''}：`;
  output.write(prompter.fancy ? `  ${s.gray(link)}\n  ${s.underline(s.accent(url))}\n\n` : `${link}\n${url}\n\n`);
  if (imagePath) output.write(`二维码图片（VS Code 中按 Ctrl/⌘ 点击路径查看，扫码结束后自动删除）：\n${imagePath}\n\n`);
  const warning = () => {
    const size = `${output.columns ?? '?'}×${output.rows ?? '?'}`;
    return `终端二维码需要 ${qrWidth + 1}×${needRows}，现在是 ${size}；${imagePath ? '请打开上方二维码图片，或' : ''}缩小字体/拉大窗口，二维码会自动重绘\n`;
  };
  if (shown) {
    output.write(code);
  } else {
    output.write(warning());
  }

  const onResize = () => {
    const next = fits();
    if (next) print(code);
    else if (shown) print(warning());
    shown = next;
  };
  output.on?.('resize', onResize);

  let watch = { pressed: new Promise(() => {}), stop() {} };
  if (prompter.tty) {
    watch = prompter.watchKey(stopKey, { also: Object.fromEntries(Object.entries(actions).map(([key, [, run]]) => [key, run])), onBack });
    draw();
    ticker = setInterval(draw, prompter.fancy ? 90 : 1000);
  }
  return {
    imagePath,
    pressed: watch.pressed,
    status(next) { current = next; if (ticker) draw(); },
    say,
    stop() {
      if (ticker) { clearInterval(ticker); ticker = null; output.write('\r\x1b[2K'); }
      output.off?.('resize', onResize);
      watch.stop();
      process.off('exit', cleanupImage);
      cleanupImage();
    },
  };
}
