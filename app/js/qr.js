// QR code encoder — byte mode, error-correction level M, versions 1–15.
// Zero dependencies and no DOM at module level: the tables below ARE the
// spec (ISO/IEC 18004), everything else is arithmetic over them.
// Version 15-M holds 412 bytes; our payloads are sync URLs of ~250 chars.

const MAX_VERSION = 15;
const QUIET = 4; // quiet zone in modules — the spec's minimum for a scanner

// Block structure per version (index = version - 1) at EC level M:
// [ecCodewordsPerBlock, group1Blocks, group1DataCodewords,
//  group2Blocks, group2DataCodewords]. Group 2 blocks always carry exactly
// one data codeword more than group 1 blocks — that is why interleaving
// needs the column walk below rather than a flat concat.
const BLOCKS_M = [
  [10, 1, 16, 0, 0],   //  1 — 16 data codewords total
  [16, 1, 28, 0, 0],   //  2
  [26, 1, 44, 0, 0],   //  3
  [18, 2, 32, 0, 0],   //  4
  [24, 2, 43, 0, 0],   //  5
  [16, 4, 27, 0, 0],   //  6
  [18, 4, 31, 0, 0],   //  7
  [22, 2, 38, 2, 39],  //  8
  [22, 3, 36, 2, 37],  //  9
  [26, 4, 43, 1, 44],  // 10
  [30, 1, 50, 4, 51],  // 11
  [22, 6, 36, 2, 37],  // 12
  [22, 8, 37, 1, 38],  // 13 — 334 data codewords, 331 payload bytes
  [24, 4, 40, 5, 41],  // 14
  [24, 5, 41, 5, 42],  // 15
];

// Row/column centres of the alignment patterns (index = version - 1).
const ALIGN = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
  [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
];

// The eight data masks, keyed by mask id. Applied to data modules only.
const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

// ---------------------------------------------------------------- GF(256)

// QR's field is GF(2^8) modulo x^8 + x^4 + x^3 + x^2 + 1 (0x11D), generator 2.
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
}

// Field multiplication (exported for the logic tests).
export function gfMul(a, b) {
  return a && b ? GF_EXP[GF_LOG[a] + GF_LOG[b]] : 0;
}

// Generator polynomial for `n` EC codewords: (x - a^0)(x - a^1)...(x - a^n-1),
// coefficients highest degree first.
function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j];                        // the x term
      next[j + 1] ^= gfMul(g[j], GF_EXP[i]);  // the a^i term
    }
    g = next;
  }
  return g;
}

// Reed-Solomon remainder = the EC codewords for one block (exported for the
// logic tests, which pin it against the published "HELLO WORLD" 1-M vector).
export function rsEcCodewords(data, ecLen) {
  const gen = rsGenerator(ecLen);
  const rem = new Uint8Array(data.length + ecLen);
  rem.set(data);
  for (let i = 0; i < data.length; i++) {
    const factor = rem[i];
    if (!factor) continue; // gen[0] is 1, so this step always clears rem[i]
    for (let j = 0; j < gen.length; j++) rem[i + j] ^= gfMul(gen[j], factor);
  }
  return Array.from(rem.subarray(data.length));
}

// ----------------------------------------------------------------- coding

function dataCodewords(version) {
  const [, b1, d1, b2, d2] = BLOCKS_M[version - 1];
  return b1 * d1 + b2 * d2;
}

// Byte-mode payload capacity: the header costs 4 mode bits plus a character
// count indicator that widens from 8 to 16 bits at version 10.
function byteCapacity(version) {
  return Math.floor((dataCodewords(version) * 8 - 4 - countBits(version)) / 8);
}

function countBits(version) {
  return version < 10 ? 8 : 16;
}

function pickVersion(byteLen) {
  for (let v = 1; v <= MAX_VERSION; v++) if (byteCapacity(v) >= byteLen) return v;
  throw new Error('qr-overflow');
}

// Mode + length header, payload, terminator, then the spec's alternating
// pad bytes 0xEC/0x11 (11101100 / 00010001). They are prescribed rather than
// zero-filled precisely because their bit pattern is busy: a tail of zeros
// would read as one large light block and skew the masking penalties.
function encodeData(bytes, version) {
  const capacity = dataCodewords(version) * 8;
  const bits = [];
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };

  put(0b0100, 4); // byte mode
  put(bytes.length, countBits(version));
  bytes.forEach((b) => put(b, 8));

  for (let i = 0; i < 4 && bits.length < capacity; i++) bits.push(0); // terminator
  while (bits.length % 8) bits.push(0);

  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | bits[i + j];
    words.push(w);
  }
  // The alternation starts at 0xEC every time — it is the order of the pad
  // run that matters, not the parity of the codeword index.
  for (let i = 0; words.length < dataCodewords(version); i++) {
    words.push(i % 2 ? 0x11 : 0xec);
  }
  return words;
}

// Split into blocks, append each block's EC codewords, then interleave both
// halves column-wise: a burst of damage then hits every block a little
// instead of destroying one block entirely.
function interleave(words, version) {
  const [ecLen, b1, d1, b2, d2] = BLOCKS_M[version - 1];
  const blocks = [];
  let at = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    const data = words.slice(at, at + len);
    at += len;
    blocks.push({ data, ec: rsEcCodewords(data, ecLen) });
  }

  const out = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    blocks.forEach((b) => { if (i < b.data.length) out.push(b.data[i]); });
  }
  for (let i = 0; i < ecLen; i++) blocks.forEach((b) => out.push(b.ec[i]));
  return out;
}

// -------------------------------------------------------------- placement

function formatValue(mask) {
  // 5 data bits = EC level (M is 0b00) << 3 | mask id, then BCH(15,5) with
  // generator 0x537, XOR-masked with 0x5412 so an all-zero format is not
  // an all-light area.
  const data = (0b00 << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return (((data << 10) | rem) ^ 0x5412) & 0x7fff;
}

function versionValue(version) {
  // 6 version bits + BCH(18,6) with generator 0x1F25, no XOR mask.
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return ((version << 12) | rem) & 0x3ffff;
}

function buildFunctionPatterns(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(0));
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, v) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    m[r][c] = v;
    fixed[r][c] = true;
  };

  // Finder patterns plus their one-module light separators.
  [[0, 0], [0, size - 7], [size - 7, 0]].forEach(([top, left]) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const inBox = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        const ring = inBox && (r === 0 || r === 6 || c === 0 || c === 6);
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        set(top + r, left + c, ring || core ? 1 : 0);
      }
    }
  });

  // Timing patterns: row 6 and column 6 alternate, dark on even coordinates.
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    set(6, i, v);
    set(i, 6, v);
  }

  // Alignment patterns at every centre pair except the three that would
  // land on a finder.
  const centres = ALIGN[version - 1];
  const last = centres.length - 1;
  centres.forEach((cr, i) => centres.forEach((cc, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const ring = Math.max(Math.abs(r), Math.abs(c));
        set(cr + r, cc + c, ring === 1 ? 0 : 1);
      }
    }
  }));

  // The dark module — one always-dark cell just above the lower format copy.
  set(size - 8, 8, 1);

  // Reserve (but do not yet fill) the two format-information areas.
  for (let i = 0; i <= 8; i++) {
    if (!fixed[8][i]) set(8, i, 0);
    if (!fixed[i][8]) set(i, 8, 0);
  }
  for (let i = 0; i < 8; i++) {
    if (!fixed[8][size - 1 - i]) set(8, size - 1 - i, 0);
    if (!fixed[size - 1 - i][8]) set(size - 1 - i, 8, 0);
  }

  // Version information (two 6x3 blocks) from version 7 on.
  if (version >= 7) {
    const value = versionValue(version);
    for (let i = 0; i < 18; i++) {
      const bit = (value >>> i) & 1;
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      set(a, b, bit);
      set(b, a, bit);
    }
  }

  return { m, fixed, size };
}

function placeData(m, fixed, size, words) {
  const bits = [];
  words.forEach((w) => { for (let i = 7; i >= 0; i--) bits.push((w >>> i) & 1); });

  let i = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // the vertical timing column is not data
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const c = right - k;
        if (fixed[r][c]) continue;
        m[r][c] = i < bits.length ? bits[i] : 0; // remainder bits are light
        i++;
      }
    }
    upward = !upward;
  }
}

function placeFormat(m, size, mask) {
  const value = formatValue(mask);
  // Position 0 — module (8,0) — carries the MOST significant of the 15 bits.
  const bit = (i) => (value >>> (14 - i)) & 1;

  // Copy around the top-left finder.
  for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
  m[8][7] = bit(6);
  m[8][8] = bit(7);
  m[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);

  // Split copy: seven modules up the bottom-left column (the dark module
  // sits above them), eight along the top-right row.
  for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = bit(i);
  for (let i = 7; i <= 14; i++) m[8][size - 15 + i] = bit(i);
}

// ---------------------------------------------------------------- masking

function applyMask(m, fixed, size, mask) {
  const fn = MASKS[mask];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (!fixed[r][c] && fn(r, c)) m[r][c] ^= 1;
    }
  }
}

/**
 * The four penalty rules summed; the mask with the lowest total wins.
 * Pure over any square 0/1 matrix, and exported so the logic tests can pin
 * each rule against a hand-computed fixture.
 */
export function maskPenalty(m) {
  const size = m.length;
  let score = 0;

  // Rule 1 — runs of five or more equal modules in a row or column.
  const runs = (get) => {
    for (let a = 0; a < size; a++) {
      let run = 1;
      for (let b = 1; b < size; b++) {
        if (get(a, b) === get(a, b - 1)) {
          run++;
        } else {
          if (run >= 5) score += 3 + (run - 5);
          run = 1;
        }
      }
      if (run >= 5) score += 3 + (run - 5);
    }
  };
  runs((a, b) => m[a][b]);
  runs((a, b) => m[b][a]);

  // Rule 2 — every 2x2 block of one colour.
  for (let r = 0; r < size - 1; r++) {
    for (let c = 0; c < size - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
    }
  }

  // Rule 3 — hunts the finder's own 1:1:3:1:1 signature (dark-light-dark3-
  // light-dark) with four light modules beside it. Such a run inside the
  // data would look like a finder to a scanner and could mis-locate the
  // whole symbol, so it is worth 40 points wherever it appears.
  const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  const scan = (get) => {
    for (let a = 0; a < size; a++) {
      for (let b = 0; b + 11 <= size; b++) {
        let hit1 = true;
        let hit2 = true;
        for (let k = 0; k < 11; k++) {
          const v = get(a, b + k);
          if (v !== P1[k]) hit1 = false;
          if (v !== P2[k]) hit2 = false;
        }
        if (hit1) score += 40;
        if (hit2) score += 40;
      }
    }
  };
  scan((a, b) => m[a][b]);
  scan((a, b) => m[b][a]);

  // Rule 4 — deviation of the dark-module share from 50%, in 5% steps. The
  // spec takes the SMALLER of the deviations of the neighbouring multiples of
  // five, which is the floor below; several libraries round the other way and
  // so pick a different mask on near-balanced symbols. Any mask is valid —
  // the format info names it — so this only affects which one wins.
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

// ------------------------------------------------------------------- API

/**
 * The finished module matrix as rows of 0 (light) and 1 (dark), without the
 * quiet zone. Exported for the logic tests; the app uses qrSvg.
 * Throws Error('qr-overflow') when the text does not fit version 15-M.
 */
export function qrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length);
  const words = interleave(encodeData(bytes, version), version);

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const { m, fixed, size } = buildFunctionPatterns(version);
    placeData(m, fixed, size, words);
    applyMask(m, fixed, size, mask);
    placeFormat(m, size, mask);
    const score = maskPenalty(m);
    if (!best || score < best.score) best = { m, score, mask };
  }
  return best.m;
}

/**
 * A self-contained SVG string for `text`. Black on white with a four-module
 * quiet zone — the colours are literal on purpose: a camera needs that
 * contrast, so this must not follow gymii's dark theme variables. Sized only
 * by viewBox, so CSS scales it freely.
 */
export function qrSvg(text) {
  const m = qrMatrix(text);
  const size = m.length;
  const dim = size + QUIET * 2;

  // One path, one horizontal run per stretch of dark modules.
  let d = '';
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (!m[r][c]) { c++; continue; }
      let run = 1;
      while (c + run < size && m[r][c + run]) run++;
      d += `M${c + QUIET} ${r + QUIET}h${run}v1h-${run}z`;
      c += run;
    }
  }

  return `<svg viewBox="0 0 ${dim} ${dim}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="QR code" shape-rendering="crispEdges">`
    + `<rect width="${dim}" height="${dim}" fill="#ffffff"/>`
    + `<path d="${d}" fill="#000000"/>`
    + '</svg>';
}
