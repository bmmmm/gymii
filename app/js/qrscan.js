// QR code DECODER — the reading half of js/qr.js, for the pairing scanner in
// Settings → Sync. Pure: pixels in, text out; no DOM, no camera (settings.js
// owns those), and its only import is qr.js, whose tables ARE the spec — one
// copy, shared, so a symbol qr.js draws is by construction one this reads.
//
// Why hand-written: the browser's own BarcodeDetector does not exist in
// Safari, and an iPhone is exactly the device that needs to scan (a Home
// Screen app cannot be reached through the camera app — the camera opens
// links in Safari, whose storage is not the app's). A library would be the
// shipped app's first dependency.
//
// Scope, on purpose: what gymii and gymii-cli write — byte mode, error
// correction level M, versions 1–15. Anything else answers null like an
// unreadable frame; the scanner then simply keeps looking. The pipeline is
// the classic one (ZXing's shape): adaptive binarisation → finder patterns
// by their 1:1:3:1:1 run signature → the bottom-right alignment pattern →
// a perspective grid → format/version info → unmask → de-interleave →
// Reed-Solomon correction → the byte segment.

import {
  BLOCKS_M, GF_EXP, GF_LOG, MASKS, MAX_VERSION, buildFunctionPatterns, formatValue, gfMul,
  versionValue,
} from './qr.js';

const MIN_DIM = 21;
const MAX_DIM = 17 + 4 * MAX_VERSION;

// ------------------------------------------------------------ binarisation

// Rec. 601 luma in integer maths — the camera frame's colour is noise here.
function luminance({ data, width, height }) {
  const n = width * height;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (data[j] * 77 + data[j + 1] * 150 + data[j + 2] * 29) >> 8;
  }
  return out;
}

// Local thresholds, not one global one: a phone pointed at a monitor sees a
// gradient (glare at one corner, a vignette at the others). The frame is cut
// into 8 px blocks; a block's black point is its mean, or — where the block
// is flat, i.e. inside one big module or the quiet zone — half its minimum,
// lifted to the neighbours' black point when that is higher, so the inside
// of a large dark area stays dark. Each pixel is then compared against the
// mean black point of the 5×5 blocks around its own (jsQR's scheme).
const BLOCK = 8;
const MIN_RANGE = 24;

function binarize(lum, w, h, invert) {
  const bw = Math.ceil(w / BLOCK);
  const bh = Math.ceil(h / BLOCK);
  const black = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      let min = 255;
      let max = 0;
      let count = 0;
      const y1 = Math.min(h, (by + 1) * BLOCK);
      const x1 = Math.min(w, (bx + 1) * BLOCK);
      for (let y = by * BLOCK; y < y1; y++) {
        for (let x = bx * BLOCK; x < x1; x++) {
          const v = invert ? 255 - lum[y * w + x] : lum[y * w + x];
          sum += v;
          if (v < min) min = v;
          if (v > max) max = v;
          count++;
        }
      }
      let t = sum / count;
      if (max - min <= MIN_RANGE) {
        t = min / 2;
        if (bx > 0 && by > 0) {
          const nb = (black[(by - 1) * bw + bx] + 2 * black[by * bw + bx - 1]
            + black[(by - 1) * bw + bx - 1]) / 4;
          if (min < nb) t = nb;
        }
      }
      black[by * bw + bx] = t;
    }
  }

  const bits = new Uint8Array(w * h);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = Math.min(bh - 1, Math.max(0, by + dy));
        for (let dx = -2; dx <= 2; dx++) {
          sum += black[yy * bw + Math.min(bw - 1, Math.max(0, bx + dx))];
        }
      }
      const t = sum / 25;
      const y1 = Math.min(h, (by + 1) * BLOCK);
      const x1 = Math.min(w, (bx + 1) * BLOCK);
      for (let y = by * BLOCK; y < y1; y++) {
        for (let x = bx * BLOCK; x < x1; x++) {
          const v = invert ? 255 - lum[y * w + x] : lum[y * w + x];
          bits[y * w + x] = v <= t ? 1 : 0;
        }
      }
    }
  }

  // A terminal draws the symbol in half blocks, two module rows per text
  // row, and some terminals leave a hairline between text rows: one light
  // pixel row straight through every dark module. Closing exactly that —
  // a single light pixel between two dark ones, vertically — reunites the
  // modules; a real light module is never one pixel tall at a scannable
  // size.
  for (let y = 1; y < h - 1; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!bits[i] && bits[i - w] && bits[i + w]) bits[i] = 1;
    }
  }
  return bits;
}

// ---------------------------------------------------------- finder patterns

const total5 = (c) => c[0] + c[1] + c[2] + c[3] + c[4];

// The finder's signature across its centre: dark 1, light 1, dark 3, light 1,
// dark 1 — each run within half a module of its share.
function finderRatio(c) {
  const total = total5(c);
  if (total < 7) return false;
  const m = total / 7;
  const v = m / 2;
  return Math.abs(m - c[0]) < v && Math.abs(m - c[1]) < v && Math.abs(3 * m - c[2]) < 3 * v
    && Math.abs(m - c[3]) < v && Math.abs(m - c[4]) < v;
}

// Light gaps narrower than this share of a module, inside a dark run, are
// closed before a cross-check counts: a terminal whose line spacing leaves a
// hairline between text rows runs it straight through every finder's core
// (the row boundary falls inside the core's three modules), and wider than
// the one pixel binarize() closes once the symbol fills the frame. A real
// light module is a whole module tall, so it never closes.
const HAIRLINE = 0.45;

// Re-measures the five runs through (x, y) along one axis — `step` is 1 for a
// row, w for a column; `lo`/`hi` are the line's ends — and answers the centre
// of the middle run, in units of `step` from `lo`, or NaN. `maxCount` bounds
// the outer runs (no part of a finder is wider than its 3-module core),
// `expected` is the total the first axis measured. Only the stretch a finder
// can reach is copied out, so closing its hairlines stays cheap.
function crossCheck(bits, at, step, lo, hi, maxCount, expected) {
  const reach = Math.ceil(expected * 1.5);
  const before = Math.min(reach, Math.floor((at - lo) / step));
  const len = before + Math.min(reach, Math.floor((hi - at) / step)) + 1;
  const line = new Uint8Array(len);
  for (let k = 0; k < len; k++) line[k] = bits[at + (k - before) * step];
  const gap = Math.max(1, Math.floor((expected / 7) * HAIRLINE));
  for (let k = 0; k < len;) {
    if (line[k]) { k++; continue; }
    let e = k;
    while (e < len && !line[e]) e++;
    if (k > 0 && e < len && e - k <= gap) line.fill(1, k, e);
    k = e;
  }

  const c = [0, 0, 0, 0, 0];
  let i = before;
  while (i >= 0 && line[i]) { c[2]++; i--; }
  if (i < 0) return NaN;
  while (i >= 0 && !line[i] && c[1] <= maxCount) { c[1]++; i--; }
  if (i < 0 || c[1] > maxCount) return NaN;
  while (i >= 0 && line[i] && c[0] <= maxCount) { c[0]++; i--; }
  if (c[0] > maxCount) return NaN;
  i = before + 1;
  while (i < len && line[i]) { c[2]++; i++; }
  if (i >= len) return NaN;
  while (i < len && !line[i] && c[3] < maxCount) { c[3]++; i++; }
  if (i >= len || c[3] >= maxCount) return NaN;
  while (i < len && line[i] && c[4] < maxCount) { c[4]++; i++; }
  if (c[4] >= maxCount) return NaN;
  const total = total5(c);
  if (5 * Math.abs(total - expected) >= 2 * expected) return NaN;
  if (!finderRatio(c)) return NaN;
  return (at - lo) / step - before + i - c[4] - c[3] - c[2] / 2;
}

function findFinders(bits, w, h) {
  const found = [];
  const consider = (c, y, end) => {
    const total = total5(c);
    const cx = end - c[4] - c[3] - c[2] / 2;
    const col = Math.floor(cx);
    // vertical: the column through cx, measured in rows
    const cy = crossCheck(bits, y * w + col, w, col, (h - 1) * w + col, c[2], total);
    if (Number.isNaN(cy)) return;
    const row = Math.floor(cy);
    // horizontal again, through the corrected row
    const cx2 = crossCheck(bits, row * w + col, 1, row * w, row * w + w - 1, c[2], total);
    if (Number.isNaN(cx2)) return;
    const size = total / 7;
    const near = found.find((f) => Math.abs(cy - f.y) <= size && Math.abs(cx2 - f.x) <= size
      && (Math.abs(size - f.size) <= 1 || Math.abs(size - f.size) <= f.size));
    if (near) {
      const n = near.count;
      near.x = (near.x * n + cx2) / (n + 1);
      near.y = (near.y * n + cy) / (n + 1);
      near.size = (near.size * n + size) / (n + 1);
      near.count = n + 1;
    } else {
      found.push({ x: cx2, y: cy, size, count: 1 });
    }
  };

  for (let y = 0; y < h; y++) {
    const c = [0, 0, 0, 0, 0];
    let state = 0;
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (bits[row + x]) {
        if (state & 1) state++; // a light run just ended
        c[state]++;
      } else if (state & 1) {
        c[state]++;
      } else if (state === 4) {
        if (finderRatio(c)) consider(c, y, x);
        // slide by two runs: the last dark run may open the next finder
        c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0;
        state = 3;
      } else {
        state++;
        c[state]++;
      }
    }
    if (state === 4 && finderRatio(c)) consider(c, y, w);
  }
  return found;
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Every plausible trio, best first: similar module sizes, two similar legs
// and a right angle between them (Pythagoras, loosely — perspective bends
// it). Orientation comes from the sign of the cross product: in image
// coordinates (y down) TL→TR × TL→BL is positive for an unmirrored symbol.
function finderTriples(found) {
  const strong = found.filter((f) => f.count >= 2);
  const pool = (strong.length >= 3 ? strong : found)
    .sort((a, b) => b.count - a.count)
    .slice(0, 12);
  const out = [];
  for (let i = 0; i < pool.length; i++) {
    for (let j = i + 1; j < pool.length; j++) {
      for (let k = j + 1; k < pool.length; k++) {
        const p = [pool[i], pool[j], pool[k]];
        const sizes = p.map((f) => f.size);
        const sMax = Math.max(...sizes);
        const sMin = Math.min(...sizes);
        if (sMax > sMin * 1.5) continue;
        // the vertex opposite the longest side is the top-left finder
        const sides = [[dist(p[1], p[2]), 0], [dist(p[0], p[2]), 1], [dist(p[0], p[1]), 2]]
          .sort((a, b) => a[0] - b[0]);
        const [l1, l2] = [sides[0][0], sides[1][0]];
        const hyp = sides[2][0];
        if (l2 > l1 * 1.6) continue;
        const right = Math.hypot(l1, l2);
        if (Math.abs(hyp - right) > 0.15 * right) continue;
        const m = (sizes[0] + sizes[1] + sizes[2]) / 3;
        const dim = (l1 + l2) / 2 / m + 7;
        if (dim < MIN_DIM - 4 || dim > MAX_DIM + 8) continue;
        const tl = p[sides[2][1]];
        let [a, b] = p.filter((f) => f !== tl);
        if ((a.x - tl.x) * (b.y - tl.y) - (a.y - tl.y) * (b.x - tl.x) < 0) [a, b] = [b, a];
        const score = (l2 - l1) / l2 + Math.abs(hyp - right) / hyp + (sMax - sMin) / sMax;
        out.push({ tl, tr: a, bl: b, m, score });
      }
    }
  }
  return out.sort((x, y) => x.score - y.score).slice(0, 4);
}

// -------------------------------------------------------- alignment pattern

// The bottom-right alignment pattern anchors the fourth corner of the grid —
// without it a symbol photographed at an angle drifts by modules towards the
// far corner. Found by template: around each guess, every candidate centre
// is scored against the 5×5 pattern (dark centre, light ring, dark ring) laid
// out along the module axes the finders give, at the guess's own scales;
// isolated dark data modules score far lower than the real thing. The best
// score anywhere wins (a tie goes to the spot nearest its guess), and is
// then refined: the equally-scoring spots within a module are averaged.
const ALIGN_REACH = 8; // modules around a guess
const ALIGN_MIN_SCORE = 22; // of 25

function findAlignment(bits, w, h, guesses, ux, uy, m) {
  const score = (x, y, k) => {
    let s = 0;
    for (let dr = -2; dr <= 2; dr++) {
      for (let dc = -2; dc <= 2; dc++) {
        const px = Math.floor(x + k * (dc * ux[0] + dr * uy[0]));
        const py = Math.floor(y + k * (dc * ux[1] + dr * uy[1]));
        const v = px >= 0 && py >= 0 && px < w && py < h ? bits[py * w + px] : 0;
        if (v === (Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1)) s++;
      }
    }
    return s;
  };
  const step = Math.max(1, m / 3);
  const r = ALIGN_REACH * m;
  let best = { s: -1, d: 0, x: 0, y: 0, k: 1 };
  for (const g of guesses) {
    for (const k of g.scales) {
      for (let y = g.y - r; y <= g.y + r; y += step) {
        for (let x = g.x - r; x <= g.x + r; x += step) {
          const s = score(x, y, k);
          const d = Math.hypot(x - g.x, y - g.y);
          if (s > best.s || (s === best.s && d < best.d)) best = { s, d, x, y, k };
        }
      }
    }
  }
  if (best.s < ALIGN_MIN_SCORE) return null;
  const fine = Math.max(0.5, m / 6);
  let top = -1;
  let pts = [];
  for (let y = best.y - m; y <= best.y + m; y += fine) {
    for (let x = best.x - m; x <= best.x + m; x += fine) {
      const s = score(x, y, best.k);
      if (s > top) { top = s; pts = [[x, y]]; } else if (s === top) pts.push([x, y]);
    }
  }
  return {
    x: pts.reduce((s, p) => s + p[0], 0) / pts.length,
    y: pts.reduce((s, p) => s + p[1], 0) / pts.length,
  };
}

// ------------------------------------------------------------ the grid

// The perspective transform from four point pairs: the 8×8 linear system of
// a homography, solved by Gauss-Jordan with partial pivoting.
function homography(src, dst) {
  const A = [];
  const b = [];
  for (let i = 0; i < 4; i++) {
    const [u, v] = src[i];
    const [x, y] = dst[i];
    A.push([u, v, 1, 0, 0, 0, -u * x, -v * x]); b.push(x);
    A.push([0, 0, 0, u, v, 1, -u * y, -v * y]); b.push(y);
  }
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-9) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = A[r][col] / A[col][col];
      if (!f) continue;
      for (let k = col; k < 8; k++) A[r][k] -= f * A[col][k];
      b[r] -= f * b[col];
    }
  }
  const hm = b.map((v, i) => v / A[i][i]);
  return (u, v) => {
    const d = hm[6] * u + hm[7] * v + 1;
    return [(hm[0] * u + hm[1] * v + hm[2]) / d, (hm[3] * u + hm[4] * v + hm[5]) / d];
  };
}

// Module (r, c) is read at its centre, (c + 0.5, r + 0.5) in module space.
function sampleGrid(bits, w, h, map, dim) {
  const grid = [];
  for (let r = 0; r < dim; r++) {
    const row = new Array(dim);
    for (let c = 0; c < dim; c++) {
      const [x, y] = map(c + 0.5, r + 0.5);
      const xi = Math.floor(x);
      const yi = Math.floor(y);
      row[c] = xi >= 0 && yi >= 0 && xi < w && yi < h ? bits[yi * w + xi] : 0;
    }
    grid.push(row);
  }
  return grid;
}

const transpose = (g) => g.map((row, r) => row.map((_, c) => g[c][r]));

const popcount = (x) => {
  let n = 0;
  for (let v = x; v; v &= v - 1) n++;
  return n;
};

// ------------------------------------------------------ format and version

// Both copies of the 15 format bits, in exactly the module order
// qr.js placeFormat() writes them (bit 0 = the most significant). The
// nearest valid level-M word wins if it is within 3 bit errors of either
// copy — BCH(15,5) keeps valid words at least 7 apart, so a level-L/Q/H
// symbol can never pass for one.
function readFormat(g, size) {
  const one = [];
  for (let i = 0; i <= 5; i++) one.push(g[8][i]);
  one.push(g[8][7], g[8][8], g[7][8]);
  for (let i = 9; i <= 14; i++) one.push(g[14 - i][8]);
  const two = [];
  for (let i = 0; i <= 6; i++) two.push(g[size - 1 - i][8]);
  for (let i = 7; i <= 14; i++) two.push(g[8][size - 15 + i]);
  const word = (bitsArr) => bitsArr.reduce((v, bit) => (v << 1) | bit, 0);
  const a = word(one);
  const b = word(two);
  let best = -1;
  let bestD = 4;
  for (let mask = 0; mask < 8; mask++) {
    const fv = formatValue(mask);
    const d = Math.min(popcount(a ^ fv), popcount(b ^ fv));
    if (d < bestD) { bestD = d; best = mask; }
  }
  return best;
}

// Version 7+ carries its number twice (6×3 blocks by the top-right and
// bottom-left finders, bit i at the spot qr.js buildFunctionPatterns sets it).
function readVersion(g, size) {
  let a = 0;
  let b = 0;
  for (let i = 0; i < 18; i++) {
    const r = Math.floor(i / 3);
    const c = size - 11 + (i % 3);
    a |= g[r][c] << i;
    b |= g[c][r] << i;
  }
  let best = 0;
  let bestD = 4;
  for (let v = 7; v <= MAX_VERSION; v++) {
    const vv = versionValue(v);
    const d = Math.min(popcount(a ^ vv), popcount(b ^ vv));
    if (d < bestD) { bestD = d; best = v; }
  }
  return best;
}

// ------------------------------------------------------------ Reed-Solomon

const gfDiv = (a, b) => (a ? GF_EXP[(GF_LOG[a] + 255 - GF_LOG[b]) % 255] : 0);
const gfPow = (a, n) => (n === 0 ? 1 : GF_EXP[(GF_LOG[a] * n) % 255]);

function syndromes(cw, ecLen) {
  const s = new Array(ecLen);
  for (let j = 0; j < ecLen; j++) {
    const a = GF_EXP[j]; // qr.js's generator has the roots a^0 .. a^(ecLen-1)
    let acc = 0;
    for (let k = 0; k < cw.length; k++) acc = gfMul(acc, a) ^ cw[k];
    s[j] = acc;
  }
  return s;
}

/**
 * Corrects one block — data then EC codewords, highest degree first, as
 * qr.js rsEcCodewords lays them out — in place of a copy, or answers null
 * when it holds more errors than ecLen/2. Berlekamp-Massey finds the error
 * locator, a Chien search its roots, Forney the magnitudes; the syndromes
 * are recomputed at the end, so a miscorrection can never slip through.
 * Exported for the logic tests.
 */
export function rsCorrect(cw, ecLen) {
  const s = syndromes(cw, ecLen);
  if (s.every((v) => v === 0)) return cw.slice();
  const n = cw.length;

  const C = [1]; // grows in place
  let B = [1];
  let L = 0;
  let m = 1;
  let bb = 1;
  for (let i = 0; i < ecLen; i++) {
    let d = s[i];
    for (let k = 1; k <= L; k++) d ^= gfMul(C[k] ?? 0, s[i - k]);
    if (d === 0) { m++; continue; }
    const coef = gfDiv(d, bb);
    const T = C.slice();
    while (C.length < B.length + m) C.push(0);
    for (let k = 0; k < B.length; k++) C[k + m] ^= gfMul(coef, B[k]);
    if (2 * L <= i) {
      L = i + 1 - L;
      B = T;
      bb = d;
      m = 1;
    } else {
      m++;
    }
  }
  if (2 * L > ecLen) return null;

  const evalLow = (poly, x) => {
    let acc = 0;
    for (let k = poly.length - 1; k >= 0; k--) acc = gfMul(acc, x) ^ poly[k];
    return acc;
  };
  const positions = [];
  for (let p = 0; p < n; p++) if (evalLow(C, GF_EXP[(255 - p) % 255]) === 0) positions.push(p);
  if (positions.length !== L) return null;

  // Omega = S(x) * Lambda(x) mod x^ecLen; with the first root a^0, Forney's
  // magnitude is X * Omega(1/X) / Lambda'(1/X)
  const omega = new Array(ecLen).fill(0);
  for (let i = 0; i < ecLen; i++) {
    for (let k = 0; k <= i && k < C.length; k++) omega[i] ^= gfMul(C[k], s[i - k]);
  }
  const out = cw.slice();
  for (const p of positions) {
    const xinv = GF_EXP[(255 - p) % 255];
    let den = 0;
    for (let k = 1; k < C.length; k += 2) den ^= gfMul(C[k], gfPow(xinv, k - 1));
    if (!den) return null;
    out[n - 1 - p] ^= gfMul(GF_EXP[p], gfDiv(evalLow(omega, xinv), den));
  }
  return syndromes(out, ecLen).every((v) => v === 0) ? out : null;
}

// ------------------------------------------------------------ the payload

function readCodewords(g, version, mask) {
  const { fixed, size } = buildFunctionPatterns(version);
  const [ecLen, b1, d1, b2, d2] = BLOCKS_M[version - 1];
  const total = b1 * d1 + b2 * d2 + ecLen * (b1 + b2);
  const words = new Uint8Array(total);
  const fn = MASKS[mask];
  let at = 0;
  let upward = true;
  // the same zig-zag qr.js placeData() walks
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const c = right - k;
        if (fixed[r][c]) continue;
        if (at < total * 8 && (g[r][c] ^ (fn(r, c) ? 1 : 0))) words[at >> 3] |= 0x80 >> (at & 7);
        at++;
      }
    }
    upward = !upward;
  }

  // undo qr.js interleave(): data column-wise across the blocks, then EC
  const blocks = [];
  for (let i = 0; i < b1 + b2; i++) blocks.push({ len: i < b1 ? d1 : d2, data: [], ec: [] });
  let k = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) {
    for (const blk of blocks) if (i < blk.len) blk.data.push(words[k++]);
  }
  for (let i = 0; i < ecLen; i++) for (const blk of blocks) blk.ec.push(words[k++]);

  const data = [];
  for (const blk of blocks) {
    const fixedBlock = rsCorrect([...blk.data, ...blk.ec], ecLen);
    if (!fixedBlock) return null;
    for (let i = 0; i < blk.len; i++) data.push(fixedBlock[i]);
  }
  return data;
}

// Byte segments only (mode 0100) — what qr.js encodeData writes; the
// terminator, or running out of bits, ends the stream.
function readPayload(words, version) {
  const nbits = words.length * 8;
  let pos = 0;
  const read = (len) => {
    if (pos + len > nbits) return -1;
    let v = 0;
    for (let i = 0; i < len; i++, pos++) v = (v << 1) | ((words[pos >> 3] >> (7 - (pos & 7))) & 1);
    return v;
  };
  const bytes = [];
  while (nbits - pos >= 4) {
    const mode = read(4);
    if (mode === 0) break;
    if (mode !== 0b0100) return null;
    const count = read(version < 10 ? 8 : 16);
    if (count < 0) return null;
    for (let i = 0; i < count; i++) {
      const byte = read(8);
      if (byte < 0) return null;
      bytes.push(byte);
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

function decodeGrid(g, version) {
  const mask = readFormat(g, g.length);
  if (mask < 0) return null;
  const words = readCodewords(g, version, mask);
  return words ? readPayload(words, version) : null;
}

// Where the bottom-right alignment centre should be — it sits 3 modules in
// from the corner the finder centres span. Two guesses: the parallelogram
// (exact for a head-on symbol), and a perspective one for a symbol held at
// an angle. The latter reads the tilt off the finders' own module sizes: a
// homography's local scale goes as 1/w² along a line, so the projective
// weight w at TR and BL is √(size at TL / size there); with w affine in
// module space, the point is A/w for the matching affine A (w = 1 at TL).
// Its template scale is the module size predicted there, 1/w² of TL's.
function alignmentGuesses(tl, tr, bl, span, m) {
  const f = (span - 3) / span;
  const affine = {
    x: tl.x + f * (tr.x + bl.x - 2 * tl.x), y: tl.y + f * (tr.y + bl.y - 2 * tl.y), scales: [1, 1.2],
  };
  const wTr = Math.sqrt(tl.size / tr.size);
  const wBl = Math.sqrt(tl.size / bl.size);
  const wf = 1 + f * (wTr - 1) + f * (wBl - 1);
  const tilted = {
    x: (tl.x + f * (wTr * tr.x - tl.x) + f * (wBl * bl.x - tl.x)) / wf,
    y: (tl.y + f * (wTr * tr.y - tl.y) + f * (wBl * bl.y - tl.y)) / wf,
    scales: [tl.size / (wf * wf) / m, 1],
  };
  return Math.hypot(tilted.x - affine.x, tilted.y - affine.y) > m ? [affine, tilted] : [affine];
}

// One trio of finders: estimate the size, then try it — the estimate ±4 too,
// and whatever a version-info block names, since a module-size misjudged by a
// few percent misses the dimension by a step on the larger versions.
function decodeTriple(bits, w, h, { tl, tr, bl, m }) {
  const est = Math.round((dist(tl, tr) + dist(tl, bl)) / (2 * m)) + 7;
  const base = 4 * Math.round((est - 1) / 4) + 1;
  const dims = [base, base + 4, base - 4];
  const tried = new Set();
  for (let i = 0; i < dims.length; i++) {
    const dim = dims[i];
    if (dim < MIN_DIM || dim > MAX_DIM || tried.has(dim)) continue;
    tried.add(dim);
    const version = (dim - 17) / 4;
    const span = dim - 7; // modules between the finder centres
    const ux = [(tr.x - tl.x) / span, (tr.y - tl.y) / span];
    const uy = [(bl.x - tl.x) / span, (bl.y - tl.y) / span];
    const corners = [];
    if (version >= 2) {
      const ap = findAlignment(bits, w, h, alignmentGuesses(tl, tr, bl, span, m), ux, uy, m);
      if (ap) corners.push([[dim - 6.5, dim - 6.5], [ap.x, ap.y]]);
    }
    corners.push([[dim - 3.5, dim - 3.5], [tr.x + bl.x - tl.x, tr.y + bl.y - tl.y]]);
    for (const [src, dst] of corners) {
      const map = homography(
        [[3.5, 3.5], [dim - 3.5, 3.5], [3.5, dim - 3.5], src],
        [[tl.x, tl.y], [tr.x, tr.y], [bl.x, bl.y], dst],
      );
      if (!map) continue;
      const grid = sampleGrid(bits, w, h, map, dim);
      // a mirrored symbol (a selfie camera, a reflection) reads transposed
      for (const g of [grid, transpose(grid)]) {
        if (version >= 7) {
          const named = readVersion(g, dim);
          if (named && named !== version) {
            if (!tried.has(17 + 4 * named)) dims.push(17 + 4 * named);
            continue;
          }
        }
        const text = decodeGrid(g, version);
        if (text !== null) return text;
      }
    }
  }
  return null;
}

/**
 * Reads the QR code in an RGBA frame ({ data, width, height } — an ImageData,
 * or anything shaped like one). Answers its text, or null when there is no
 * symbol this can read (none in view, blurred, a level other than M, a mode
 * other than byte). A light-on-dark symbol is tried too.
 */
export function decodeQr(img) {
  const { width: w, height: h } = img;
  if (!w || !h) return null;
  const lum = luminance(img);
  for (const invert of [false, true]) {
    const bits = binarize(lum, w, h, invert);
    for (const triple of finderTriples(findFinders(bits, w, h))) {
      const text = decodeTriple(bits, w, h, triple);
      if (text !== null) return text;
    }
  }
  return null;
}
