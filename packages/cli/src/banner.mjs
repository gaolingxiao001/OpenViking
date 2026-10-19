import { PromptAborted } from './prompt.mjs';
import {
  HIDE_CURSOR, PALETTE, RESET, SHOW_CURSOR, bgCode, colorDepth, fgCode, mix, onInterrupt, scale, styler, width,
} from './ui.mjs';

// The Vika banner: pixel art of a tall-rigged sailboat (OpenViking's sail)
// under a moon, on a moving sea, next to the VIKA wordmark. Every frame is
// drawn from the time t (seconds), so the animation is the same scene at any
// frame rate.

const SCENE_WIDTH = 46;
const SCENE_HEIGHT = 17;
// The wordmark's first row, so it sits beside the sails.
const WORDMARK_TOP = 4;

// "ANSI Shadow" letters.
const WORDMARK = [
  '██╗   ██╗██╗██╗  ██╗ █████╗ ',
  '██║   ██║██║██║ ██╔╝██╔══██╗',
  '██║   ██║██║█████╔╝ ███████║',
  '╚██╗ ██╔╝██║██╔═██╗ ██╔══██║',
  ' ╚████╔╝ ██║██║  ██╗██║  ██║',
  '  ╚═══╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝',
];

const TAGLINE = '把本机的 coding agent 带上船';
const SUBLINE = '飞书 · 微信 · Telegram · 邮箱';

function put(cells, x, y, ch, rgb) {
  if (y < 0 || y >= cells.length || x < 0 || x >= cells[0].length) return;
  cells[y][x] = { ch, rgb, bg: null };
}

// Text that may hold CJK: a two-column character blanks the cell after it.
function wide(cells, x, y, value, rgb) {
  let column = x;
  for (const ch of value) {
    put(cells, column, y, ch, rgb);
    if (width(ch) === 2) {
      put(cells, column + 1, y, '', null);
      column += 2;
    } else {
      column += 1;
    }
  }
}

// The scene is pixel art: each character cell holds two square pixels, the
// upper one drawn as the foreground of '▀' and the lower one as its
// background, so the boat can rise half a row at a time.
const W = SCENE_WIDTH;
const H = SCENE_HEIGHT * 2;

const COLORS = {
  mast: [238, 228, 216], boom: [200, 172, 148], rope: [168, 160, 190],
  rail: [248, 224, 186], stripe: [255, 170, 120], hull: [60, 54, 132], hullLit: [96, 86, 176], keel: [228, 98, 112],
  porthole: [255, 236, 186], moon: [255, 238, 186], star: [255, 250, 220], gull: [232, 236, 244],
  foam: [236, 250, 255], crest: [132, 222, 244], shallow: [46, 158, 232], deep: [20, 66, 156],
};

function canvas(columns = W, height = H) {
  return Array.from({ length: height }, () => new Array(columns).fill(null));
}

function dot(pixels, x, y, rgb) {
  if (y >= 0 && y < pixels.length && x >= 0 && x < pixels[0].length) pixels[y][x] = rgb;
}

// A sprite drawn from rows of letters; '.' is see-through.
function sprite(pixels, x, y, rows, colors) {
  rows.forEach((row, dy) => [...row].forEach((key, dx) => { if (colors[key]) dot(pixels, x + dx, y + dy, colors[key]); }));
}

const STARS = [[2, 3], [8, 10], [14, 2], [33, 1], [44, 11], [42, 17], [3, 16], [18, 6], [36, 9], [45, 4], [10, 20], [40, 22]];
const MOON = ['.mmm.', 'mm...', 'm....', 'mm...', '.mmm.'];
const GULL = [['g...g', '.g.g.', '..g..'], ['.....', 'gg.gg', '..g..']];

function sky(pixels, t) {
  STARS.forEach(([x, y], index) => {
    const glow = 0.5 + 0.5 * Math.sin(t * (1.1 + index * 0.31) + index * 2.3);
    if (glow > 0.25) dot(pixels, x, y, scale(COLORS.star, 0.35 + glow * 0.65));
  });
  sprite(pixels, 38, 1, MOON, { m: COLORS.moon });
  const gullX = Math.round(((t * 5 + 30) % 64) - 8);
  sprite(pixels, gullX, 7 + Math.round(Math.sin(t * 1.3) * 1.5), GULL[Math.floor(t * 5) % 2], { g: COLORS.gull });
}

// Sail cloth: the gradient flows slowly, the belly is lit, seams run across,
// and a band of light sweeps over it like wind.
function cloth(x, y, t, across, offset) {
  const base = mix(PALETTE.sail, (x - 6) / 40 + (H - y) / 70 + offset + t * 0.06, { cycle: true });
  const belly = 0.8 + 0.28 * Math.sin(Math.min(1, across) * Math.PI);
  const seam = (y % 4 === 0) ? 0.88 : 1;
  const sweep = Math.max(0, 1 - Math.abs(x * 0.8 + y - ((t * 16) % 70 - 10)) / 3);
  return mix([scale(base, belly * seam), [255, 255, 255]], sweep * 0.35);
}

const MAST_X = 24;
const STERN_X = 8;
const BOW_X = 43;
// Where the hull meets calm water: its row in the boat's own drawing, and
// the row of calm water in the scene.
const WATERLINE = 27;
const SEA_LEVEL = 27.4;

// The boat at rest, in its own frame; the scene tilts and lifts it with the
// sea (see place).
function boat(pixels, t) {
  const deck = 23;
  // Mast and a flag that flutters.
  for (let y = 2; y < deck; y += 1) dot(pixels, MAST_X, y, COLORS.mast);
  const flag = Math.floor(t * 6) % 3;
  sprite(pixels, MAST_X + 1, 1, [['ppp', 'pp.'], ['pp.', 'ppp'], ['ppp', '.pp']][flag], { p: PALETTE.pink });

  // Mainsail, aft of the mast: tall and narrow, its leech breathing in and
  // out with the wind.
  const billow = Math.sin(t * 1.6) * 0.7;
  for (let y = 3; y <= 20; y += 1) {
    const f = Math.pow((y - 3) / 17, 0.85);
    const reach = Math.max(0, Math.round((10 + billow) * f));
    for (let x = MAST_X - 1 - reach; x < MAST_X; x += 1) {
      const across = (MAST_X - x) / Math.max(1, reach + 1);
      dot(pixels, x, y, cloth(x, y, t, across, 0));
    }
  }
  for (let x = MAST_X - 12; x <= MAST_X; x += 1) dot(pixels, x, 21, COLORS.boom);

  // Jib, forward of the mast, up the forestay; the stay runs on to the bow.
  const stay = (y) => MAST_X + 1 + Math.round((y - 4) * 17 / 19);
  for (let y = 5; y <= 20; y += 1) {
    const luff = stay(y);
    for (let x = MAST_X + 2; x <= luff; x += 1) {
      const across = (x - MAST_X - 1) / Math.max(1, luff - MAST_X);
      dot(pixels, x, y, cloth(x, y, t, across, 0.35));
    }
  }
  for (let y = 21; y < deck; y += 1) dot(pixels, stay(y), y, COLORS.rope);

  // Hull, stern to a raked bow: cream rail, deep indigo topsides lit toward
  // the bow with three portholes, a thin peach boot stripe just above the
  // water, coral bottom below it.
  const lit = (x) => mix([COLORS.hull, COLORS.hullLit], (x - STERN_X) / 34);
  const rows = [
    [STERN_X, BOW_X - 1, () => COLORS.rail],
    [STERN_X, BOW_X - 2, lit],
    [STERN_X + 1, BOW_X - 3, lit],
    [STERN_X + 2, BOW_X - 5, () => COLORS.stripe],
    [STERN_X + 4, BOW_X - 7, () => COLORS.keel],
    [STERN_X + 7, BOW_X - 11, () => scale(COLORS.keel, 0.78)],
  ];
  rows.forEach(([left, right, color], dy) => {
    for (let x = left; x <= right; x += 1) dot(pixels, x, deck + dy, color(x));
  });
  for (const x of [25, 29, 33]) dot(pixels, x, deck + 1, COLORS.porthole);
  // The sheer: the rail lifts a little at the stern and more at the bow.
  for (const [x, dy] of [[STERN_X, -1], [BOW_X - 3, -1], [BOW_X - 2, -1], [BOW_X - 1, -1], [BOW_X, -2]]) dot(pixels, x, deck + dy, COLORS.rail);
}

// The swell the boat rides, as a rise above calm water in pixels: a long
// wave, about three hull lengths, so the water along the hull is close to a
// slope the boat can lie on, and a low shorter one; both run aft as the boat
// sails on. Ripples only texture the open water: next to the hull the
// surface is the swell alone, so the waterline runs clean.
function swell(x, t) {
  return 1.45 * Math.sin((x + t * 20) * 0.06) + 0.3 * Math.sin((x + t * 9) * 0.21 + 1.7);
}

function ripple(x, t) {
  const open = Math.min(1, Math.max(0, (STERN_X - 1 - x) / 4, (x - BOW_X - 1) / 4));
  return open * 0.45 * Math.sin((x * 1.7 - t * 3.1) * 0.5 + 1.3);
}

// How the boat lies on the swell: the line that best fits the water along
// the hull sets the pitch (bow up as a crest reaches it, bow down as the
// crest runs aft) and how high it rides. A boat answers the sea a moment
// late, and a little less than fully.
export function pose(t) {
  const lag = t - 0.12;
  const xs = [];
  for (let x = STERN_X; x <= BOW_X; x += 3) xs.push(x);
  const mean = xs.reduce((sum, x) => sum + x, 0) / xs.length;
  const level = xs.reduce((sum, x) => sum + swell(x, lag), 0) / xs.length;
  const slope = xs.reduce((sum, x) => sum + (x - mean) * (swell(x, lag) - level), 0)
    / xs.reduce((sum, x) => sum + (x - mean) ** 2, 0);
  return { angle: Math.atan(slope) * 0.9, rise: (level + slope * (MAST_X - mean)) * 0.9 };
}

// The boat's drawing, turned by the pitch about where its waterline meets
// the mast and lifted with the sea; nearest pixel, so lines stay crisp.
// Returns where the boat landed, for the water in front of it.
function place(pixels, drawing, { angle, rise }) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const pivot = SEA_LEVEL - rise;
  const placed = canvas();
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const dx = x - MAST_X;
      const dy = y - pivot;
      const color = drawing[Math.round(WATERLINE + sin * dx + cos * dy)]?.[Math.round(MAST_X + cos * dx - sin * dy)];
      if (color) {
        pixels[y][x] = color;
        placed[y][x] = color;
      }
    }
  }
  return placed;
}

// Where a point of the boat's drawing lands in the scene.
function landing({ angle, rise }, x, y) {
  const u = x - MAST_X;
  const v = y - WATERLINE;
  return [MAST_X + u * Math.cos(angle) + v * Math.sin(angle), SEA_LEVEL - rise - u * Math.sin(angle) + v * Math.cos(angle)];
}

const flicker = (x, t, rate = 7) => 0.5 + 0.5 * Math.sin(x * 2.7 + Math.floor(t * rate) * 1.9);

// The water behind the boat: the surface seen receding, a band a little
// paler and dimmer than the water in front, which the hull stands in front of.
function farSea(pixels, t, surface) {
  for (let x = 0; x < W; x += 1) {
    const near = Math.round(surface(x));
    const far = Math.round(surface(x) - 1.7 - 0.45 * Math.sin((x + t * 2.4) * 0.33 + 0.8));
    for (let y = far; y < near; y += 1) {
      const edge = y === far;
      dot(pixels, x, y, scale(edge ? mix([COLORS.crest, COLORS.foam], 0.2) : mix([COLORS.shallow, COLORS.crest], 0.4), 0.8));
    }
  }
}

// The water in front: it covers the hull below the waterline, where the hull
// shows through faintly and fades with depth; the hull shades the water
// under it; foam rims the hull where it cuts the surface, sprays at the bow
// when it comes down, and trails off the stern.
function nearSea(pixels, t, surface, placed, boatPose) {
  const bounds = { stern: landing(boatPose, STERN_X, WATERLINE)[0], bow: landing(boatPose, BOW_X, WATERLINE)[0] };
  for (let x = 0; x < W; x += 1) {
    const level = surface(x);
    const top = Math.round(level);
    const crest = level <= surface(x - 1) && level <= surface(x + 1);
    const shaded = placed.some((row, y) => y >= top - 1 && row[x]);
    for (let y = top; y < H; y += 1) {
      const depth = (y - top) / Math.max(1, H - top);
      let water = mix([COLORS.shallow, COLORS.deep], depth * 1.15);
      water = scale(water, (0.93 + 0.07 * Math.sin(x * 0.3 + t * 2 + y)) * (shaded && y > top ? 0.8 : 1));
      const hull = placed[y]?.[x];
      if (y === top) {
        // The surface runs on in front of the hull, catching a little of its
        // colour, with flecks of foam; foam gathers at bow and stern.
        const cut = hull || placed[y - 1]?.[x];
        const end = cut && (x < bounds.stern + 3 || x > bounds.bow - 3);
        if (!cut) water = crest ? COLORS.foam : COLORS.crest;
        else if (end || flicker(x, t, 5) > 0.82) water = mix([COLORS.crest, COLORS.foam], 0.55);
        else water = mix([COLORS.crest, cut], 0.3);
      } else if (hull) {
        water = mix([water, hull], [0, 0.4, 0.22, 0.1][Math.min(3, y - top)]);
      } else if (y <= top + 2 && Math.sin(x * 12.9898 + y * 78.233 + Math.floor(t * 5) * 3.7) > 0.93) {
        water = mix([water, COLORS.foam], 0.6);
      }
      dot(pixels, x, y, water);
    }
  }
  // Wake off the stern, drifting aft.
  const [sternX] = landing(boatPose, STERN_X, WATERLINE);
  for (let k = 1; k <= 6; k += 1) {
    const x = Math.round(sternX) - k;
    if (flicker(x + Math.floor(t * 6), t, 5) > 0.35 + k * 0.08) dot(pixels, x, Math.round(surface(x)), COLORS.foam);
  }
  // Spray at the bow, more as it comes down into the sea.
  const [bowX] = landing(boatPose, BOW_X, WATERLINE);
  const falling = pose(t - 0.15).angle - boatPose.angle;
  const x = Math.round(bowX) + 1;
  dot(pixels, x, Math.round(surface(x)), COLORS.foam);
  if (falling > 0.004 || flicker(x, t, 4) > 0.7) dot(pixels, x + 1, Math.round(surface(x + 1)) - 1, mix([COLORS.foam, COLORS.crest], 0.3));
  if (falling > 0.012) dot(pixels, x, Math.round(surface(x)) - 2, mix([COLORS.foam, COLORS.crest], 0.5));
}

// Cells for pixels: two per cell, as '▀' with a background, or '▄' / '█'
// when only one half or both halves share a colour.
function toCells(pixels) {
  return Array.from({ length: pixels.length / 2 }, (_, row) => pixels[row * 2].map((top, x) => {
    const bottom = pixels[row * 2 + 1][x];
    if (!top && !bottom) return { ch: ' ', rgb: null, bg: null };
    if (!top) return { ch: '▄', rgb: bottom, bg: null };
    if (!bottom) return { ch: '▀', rgb: top, bg: null };
    if (top.join() === bottom.join()) return { ch: '█', rgb: top, bg: null };
    return { ch: '▀', rgb: top, bg: bottom };
  }));
}

export function sceneFrame(t) {
  const pixels = canvas();
  sky(pixels, t);
  const surface = (x) => SEA_LEVEL - swell(x, t) - ripple(x, t);
  farSea(pixels, t, surface);
  const drawing = canvas();
  boat(drawing, t);
  const boatPose = pose(t);
  const placed = place(pixels, drawing, boatPose);
  nearSea(pixels, t, surface, placed, boatPose);
  return toCells(pixels);
}

// Cell rows as strings, a colour change only where the colour changes.
function render(rows, depth) {
  return rows.map((row) => {
    let line = '';
    let open = '';
    for (const cell of row) {
      const code = `${cell.rgb ? fgCode(cell.rgb, depth) : ''}${cell.bg ? bgCode(cell.bg, depth) : ''}`;
      if (code !== open) {
        line += `${open ? RESET : ''}${code}`;
        open = code;
      }
      line += cell.ch;
    }
    return `${line}${open ? RESET : ''}`.replace(/\s+$/, '');
  });
}

// Rows of the banner as strings, coloured for `depth`.
export function bannerLines(t, { depth = 24, version = '', columns = 80 } = {}) {
  const scene = sceneFrame(t);
  const withWordmark = columns >= SCENE_WIDTH + 4 + width(WORDMARK[0]);
  const rows = scene.map((row) => row.map((cell) => ({ ...cell })));
  if (withWordmark) {
    const x0 = SCENE_WIDTH + 2;
    const versionLine = version ? `v${version}` : '';
    const extra = Math.max(width(WORDMARK[0]), width(TAGLINE), width(SUBLINE), width(versionLine)) + 2;
    rows.forEach((row) => { for (let k = 0; k < extra; k += 1) row.push({ ch: ' ', rgb: null }); });
    WORDMARK.forEach((line, y) => {
      [...line].forEach((ch, x) => {
        if (ch === ' ') return;
        // A light sweep runs across the letters; the shadow strokes are darker.
        const sweep = Math.max(0, 1 - Math.abs(x - ((t * 14) % 60 - 10)) / 6);
        const base = mix(PALETTE.sail, x / 28 + y * 0.03 + t * 0.08, { cycle: true });
        const lit = mix([base, [255, 255, 255]], sweep * 0.6);
        rows[y + WORDMARK_TOP][x0 + x] = { ch, rgb: ch === '█' ? lit : scale(base, 0.62) };
      });
    });
    const below = WORDMARK_TOP + WORDMARK.length + 1;
    wide(rows, x0, below, TAGLINE, [235, 235, 245]);
    wide(rows, x0, below + 1, SUBLINE, PALETTE.dim);
    wide(rows, x0, below + 2, versionLine, scale(PALETTE.dim, 0.8));
  }
  return render(rows, depth);
}

export const BANNER_ROWS = SCENE_HEIGHT;

// The small header for a short window: VIKA, and a little boat sailing the
// width of a two-row strip of sea, over and over.
const MINI_BOAT = ['...sm....', '..ssmj...', '.sssmjj..', 'hhhhhhhhh'];

export function miniLines(t, { depth = 24, columns = 80 } = {}) {
  const strip = Math.max(20, Math.min(columns, 72) - 7);
  const pixels = canvas(strip, 4);
  [[3, 0], [17, 1], [30, 0], [44, 1], [58, 0]].forEach(([x, y], index) => {
    if (x < strip && Math.sin(t * (1.2 + index * 0.4) + index) > -0.2) dot(pixels, x, y, scale(COLORS.star, 0.7));
  });
  for (let x = 0; x < strip; x += 1) {
    const crest = Math.sin((x + t * 5) * 0.5) > 0.55;
    if (crest) dot(pixels, x, 2, COLORS.crest);
    dot(pixels, x, 3, crest ? COLORS.foam : mix([COLORS.shallow, COLORS.deep], 0.3 + 0.2 * Math.sin(x * 0.4 + t)));
  }
  const at = Math.round(((t * 4) % (strip + 12)) - 10);
  sprite(pixels, at, 0, MINI_BOAT, {
    s: mix(PALETTE.sail, at / strip + t * 0.1, { cycle: true }),
    j: mix(PALETTE.sail, at / strip + t * 0.1 + 0.35, { cycle: true }),
    m: COLORS.mast,
    h: COLORS.hullLit,
  });
  for (let k = 1; k <= 3; k += 1) if ((Math.floor(t * 8) + k) % 2) dot(pixels, at - k, 3, COLORS.foam);
  const rows = toCells(pixels);
  const sweep = (x) => Math.max(0, 1 - Math.abs(x - ((t * 3) % 8 - 2)) / 1.5);
  const label = [...'VIKA'].map((ch, x) => ({ ch, rgb: mix([mix(PALETTE.sail, x / 4 + t * 0.08, { cycle: true }), [255, 255, 255]], sweep(x) * 0.6), bg: null }));
  const blank = (n) => Array.from({ length: n }, () => ({ ch: ' ', rgb: null, bg: null }));
  return render([[...blank(1), ...label, ...blank(2), ...rows[0]], [...blank(7), ...rows[1]]], depth);
}

// The rows a pinned header leaves for setup's questions at the least: the
// tallest list (the change menu) and a line or two around it.
const MIN_QUESTION_ROWS = 13;

// Keeps a header at the top of the screen, redrawn about 14 times a second,
// while everything else scrolls in a region below it. Each frame saves the
// cursor, draws above the region and puts the cursor back, so the questions
// never notice. What was on screen goes to the scrollback first.
function pinHeader({ output, frame, fps = 14 }) {
  const rows = output.rows;
  const started = Date.now();
  const first = frame(0);
  const below = first.length + 2;
  const draw = (lines) => {
    output.write(`\x1b[?2026h\x1b7${lines.map((line, index) => `\x1b[${index + 1};1H\x1b[2K${line}`).join('')}\x1b8\x1b[?2026l`);
  };
  output.write(`${'\n'.repeat(rows)}\x1b[H`);
  draw(first);
  output.write(`\x1b[${below};${rows}r\x1b[${below};1H`);
  const timer = setInterval(() => draw(frame((Date.now() - started) / 1000)), 1000 / fps);
  timer.unref?.();
  let released = false;
  // The scroll region must never outlive setup: give the terminal back on
  // the way out, on Ctrl-C, and when the window changes size.
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(timer);
    unguard();
    process.off('exit', release);
    output.off?.('resize', release);
    output.write('\x1b7\x1b[r\x1b8');
  };
  const unguard = onInterrupt(release);
  process.on('exit', release);
  output.on?.('resize', release);
  return { release, top: below, get released() { return released; } };
}

// The banner for setup. On a window tall enough, the full scene stays at the
// top and keeps sailing while the questions are asked under it; on a shorter
// one the scene plays, then the small header stays. release() hands the
// whole screen back (a code to scan, another program, the end); resume()
// pins the header again, whichever fits the window by then; top() is the
// first row of the questions' region while a header is pinned.
export async function openingBanner({ output = process.stdout, input = process.stdin, env = process.env, version = '', durationMs } = {}) {
  const idle = { release() {}, resume() {}, top: () => null };
  const depth = colorDepth(output, env);
  const still = env.VIKA_NO_ANIMATION === '1' || Boolean(env.CI);
  if (depth < 8 || still || (output.columns ?? 0) < SCENE_WIDTH || (output.rows ?? 0) <= SCENE_HEIGHT + 2) {
    await playBanner({ output, input, env, version });
    return idle;
  }
  const fits = (height) => (output.rows ?? 0) >= height + 1 + MIN_QUESTION_ROWS;
  if (!fits(SCENE_HEIGHT)) await playBanner({ output, input, env, version, durationMs });
  let pinned = null;
  const handle = {
    release() {
      pinned?.release();
      pinned = null;
    },
    top() {
      return pinned && !pinned.released ? pinned.top : null;
    },
    resume() {
      if (pinned?.released) pinned = null;
      if (pinned || (output.columns ?? 0) < SCENE_WIDTH) return;
      const columns = output.columns;
      if (fits(SCENE_HEIGHT)) pinned = pinHeader({ output, frame: (t) => bannerLines(t, { depth, version, columns }) });
      else if (fits(2)) pinned = pinHeader({ output, frame: (t) => miniLines(t, { depth, columns }) });
    },
  };
  handle.resume();
  return handle;
}

// Plays the banner on a terminal for `durationMs` (or until a key; `loop`
// keeps going until one), then leaves the last frame. Without a colour
// terminal, or one too small, it prints a single title line instead.
export async function playBanner({
  output = process.stdout,
  input = process.stdin,
  env = process.env,
  version = '',
  durationMs = 2600,
  loop = false,
  fps = 14,
} = {}) {
  const depth = colorDepth(output, env);
  const columns = output.columns ?? 80;
  const animate = depth >= 8 && columns >= SCENE_WIDTH && (output.rows ?? 24) > SCENE_HEIGHT + 2;
  if (!animate) {
    const s = styler(output, env);
    output.write(`\n${s.bold(s.gradient('VIKA', PALETTE.sail))}  ${TAGLINE}${version ? s.gray(`  v${version}`) : ''}\n\n`);
    return;
  }
  const still = env.VIKA_NO_ANIMATION === '1' || env.CI;
  const draw = (t, first = false) => {
    const lines = bannerLines(t, { depth, version, columns });
    output.write(`${first ? '' : `\x1b[${lines.length}A`}${lines.map((line) => `\x1b[2K${line}`).join('\n')}\n`);
  };
  output.write(`\n${HIDE_CURSOR}`);
  const restore = () => output.write(SHOW_CURSOR);
  process.once('exit', restore);
  try {
    draw(0, true);
    if (still) return;
    let stop = false;
    let interrupted = false;
    const raw = Boolean(input?.isTTY && typeof input.setRawMode === 'function');
    const onData = (chunk) => {
      stop = true;
      if (String(chunk).includes('\x03')) interrupted = true;
    };
    if (raw) {
      input.setRawMode(true);
      input.resume();
      input.on('data', onData);
    }
    const started = Date.now();
    try {
      while (!stop && (loop || Date.now() - started < durationMs)) {
        await new Promise((resolve) => setTimeout(resolve, 1000 / fps));
        draw((Date.now() - started) / 1000);
      }
    } finally {
      if (raw) {
        input.off('data', onData);
        input.setRawMode(false);
        input.pause();
      }
    }
    if (interrupted) throw new PromptAborted();
  } finally {
    restore();
    process.off('exit', restore);
    output.write('\n');
  }
}
