import { spawn } from 'node:child_process';
import qrcode from 'qrcode-terminal';
import { PALETTE, SYMBOLS, mix, width } from './ui.mjs';

// A code to scan, with the link as a fallback. Feishu's app-creation link
// carries the whole permission set (~1700 characters), which makes a code
// 139 columns by 71 rows: on a smaller terminal it would wrap and could not
// be scanned, so it is drawn only once the window is big enough, and drawn
// again by itself when the window is resized. A waiting line under it shows
// the time and the keys that work meanwhile.

export function qrLines(url) {
  let text = '';
  qrcode.generate(url, { small: true }, (code) => { text = code; });
  return text.replace(/\n+$/, '').split('\n');
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

// prompter: the setup Prompter. where: what to open the link in (飞书 / 微信).
// stopKey: a key that ends the wait (resolves `pressed` with true); `keys`
// are more keys with their labels and actions, e.g. { o: ['浏览器打开', fn] };
// onBack, when given, runs on ← or Esc (going back while nothing is made yet).
// Returns { pressed, status(label), say(text), stop() }.
export function showScan(prompter, {
  url, title, where = '飞书', label = '等待扫码', stopKey = null, stopLabel = '', keys = {}, onBack = null, env = process.env,
}) {
  const { output, s } = prompter;
  const lines = qrLines(url);
  const qrWidth = Math.max(...lines.map((line) => width(line)));
  const needRows = lines.length + 4;
  const fits = () => !output.isTTY || ((output.columns ?? 0) >= qrWidth && (output.rows ?? 0) >= needRows);
  const canOpen = Boolean(opener(env));
  const actions = { ...(canOpen ? { o: ['浏览器打开', () => { if (openUrl(url, { env })) say('已在浏览器打开，按页面提示确认'); }] } : {}), ...keys };

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
  const draw = () => { output.write(`\r\x1b[2K${line()}`); frame += 1; };
  const print = (text) => {
    if (ticker) output.write('\r\x1b[2K');
    output.write(text);
    if (ticker) draw();
  };
  function say(text) {
    print(prompter.fancy ? `  ${s.gray(SYMBOLS.info)} ${text}\n` : `  ${text}\n`);
  }

  const head = prompter.fancy ? `\n  ${s.accent('▣')} ${s.bold(title)}\n` : `\n${title}\n`;
  const code = `${lines.join('\n')}\n`;
  let shown = fits();
  output.write(head);
  if (shown) {
    output.write(code);
  } else {
    const size = `${output.columns ?? '?'}×${output.rows ?? '?'}`;
    const ask = `这个二维码要 ${qrWidth}×${needRows} 的终端，现在是 ${size}：缩小字体（⌘- 或 Ctrl -）或拉大窗口，二维码会自动出现`;
    output.write(prompter.fancy ? `  ${s.yellow(SYMBOLS.warn)} ${ask}\n` : `  ${ask}\n`);
  }
  const link = `扫不出来的话，在${where}里打开这个链接${canOpen ? '，或按 o 用浏览器打开' : ''}：`;
  output.write(prompter.fancy ? `  ${s.gray(link)}\n  ${s.underline(s.accent(url))}\n\n` : `${link}\n${url}\n\n`);

  const onResize = () => {
    if (shown || !fits()) return;
    shown = true;
    print(`${head}${code}`);
  };
  if (!shown) output.on?.('resize', onResize);

  let watch = { pressed: new Promise(() => {}), stop() {} };
  if (prompter.tty) {
    watch = prompter.watchKey(stopKey, { also: Object.fromEntries(Object.entries(actions).map(([key, [, run]]) => [key, run])), onBack });
    draw();
    ticker = setInterval(draw, prompter.fancy ? 90 : 1000);
  }
  return {
    pressed: watch.pressed,
    status(next) { current = next; if (ticker) draw(); },
    say,
    stop() {
      if (ticker) { clearInterval(ticker); ticker = null; output.write('\r\x1b[2K'); }
      output.off?.('resize', onResize);
      watch.stop();
    },
  };
}
