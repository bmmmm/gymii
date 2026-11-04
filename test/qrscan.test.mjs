// js/qrscan.js — the pairing scanner's decoder. Every symbol here comes out
// of js/qr.js, the encoder the app and gymii-cli share, and goes through a
// synthetic "camera": rotation, keystone perspective, sensor noise, a glare
// gradient, a mirror, inverted colours, and the half-block rendering of a
// terminal with hairlines between its text rows — the shapes a phone sees.
// Run: node test/qrscan.test.mjs

import assert from 'node:assert/strict';
import { formatValue, qrMatrix, rsEcCodewords } from '../app/js/qr.js';
import { decodeQr, rsCorrect } from '../app/js/qrscan.js';

// a tiny seeded PRNG, so every "random" case is the same on every run
const prng = (seed) => {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Renders a module matrix into an RGBA frame the way a camera would see it.
 * Each output pixel is mapped BACK into module space (rotation, keystone),
 * 2×2-supersampled so edges come out grey, then lit, noised and inverted.
 */
function render(matrix, opts = {}) {
  const {
    size = 360, fill = 0.8, angle = 0, keystone = [0, 0], noise = 0, gradient = 0,
    invert = false, mirror = false, terminal = null, surround = null, seed = 1,
  } = opts;
  const n = matrix.length;
  const dim = n + 8; // four quiet modules each side
  const s = (size * fill) / dim;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const rnd = prng(seed);
  const data = new Uint8ClampedArray(size * size * 4);
  const shade = (u0, v0) => {
    const u = mirror ? dim - u0 : u0;
    let v = v0;
    if (terminal) {
      // half blocks: one text row carries two module rows and is `aspect`
      // times two modules tall; its glyph leaves a hairline of `gap` (module
      // widths) of the cell background — the symbol's light — at its top
      const a = terminal.aspect ?? 1;
      const y = v0 - dim / 2 + (dim * a) / 2; // from the top of the quiet zone
      const t = Math.floor(y / (2 * a));
      const p = y - t * 2 * a;
      if (t >= 0 && t < dim / 2 && u >= 0 && u < dim && p < terminal.gap) return 235;
      v = 2 * t + (2 * (p - terminal.gap)) / (2 * a - terminal.gap);
    }
    if (u < 0 || v < 0 || u >= dim || v >= dim) return surround ?? 235;
    const r = Math.floor(v) - 4;
    const c = Math.floor(u) - 4;
    return r >= 0 && c >= 0 && r < n && c < n && matrix[r][c] ? 25 : 235;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0;
      for (const sy of [0.25, 0.75]) {
        for (const sx of [0.25, 0.75]) {
          const X = x + sx - size / 2;
          const Y = y + sy - size / 2;
          const d = 1 + keystone[0] * X + keystone[1] * Y;
          const xr = (X * cos + Y * sin) / d;
          const yr = (-X * sin + Y * cos) / d;
          sum += shade(xr / s + dim / 2, yr / s + dim / 2);
        }
      }
      let lum = sum / 4;
      lum *= 1 - gradient * (x / size);
      lum += (rnd() - 0.5) * 2 * noise;
      if (invert) lum = 255 - lum;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = lum;
      data[i + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

// --- Reed-Solomon, on its own ---
{
  const rnd = prng(7);
  const data = Array.from({ length: 36 }, () => Math.floor(rnd() * 256));
  const ecLen = 22; // version 12-M's blocks
  const clean = [...data, ...rsEcCodewords(data, ecLen)];
  assert.deepEqual(rsCorrect(clean, ecLen), clean, 'a clean block comes back as it went in');
  for (let errors = 1; errors <= ecLen / 2; errors++) {
    const hurt = clean.slice();
    const spots = new Set();
    while (spots.size < errors) spots.add(Math.floor(rnd() * hurt.length));
    for (const p of spots) hurt[p] ^= 1 + Math.floor(rnd() * 255);
    assert.deepEqual(rsCorrect(hurt, ecLen), clean, `${errors} wrong codewords are corrected`);
  }
  const wrecked = clean.slice();
  for (let p = 0; p < 14; p++) wrecked[p * 4] ^= 0x5a;
  assert.equal(rsCorrect(wrecked, ecLen), null, 'beyond ecLen/2 it gives up instead of guessing');
}

// --- every version, clean ---
{
  const seen = new Map();
  for (let len = 1; len <= 412 && seen.size < 15; len++) {
    const text = 'x'.repeat(len - 1) + String(len % 10);
    let size;
    try { size = qrMatrix(text).length; } catch { break; }
    if (!seen.has(size)) seen.set(size, text);
  }
  assert.equal(seen.size, 15, 'versions 1–15 are all exercised');
  for (const [size, text] of seen) {
    const frame = render(qrMatrix(text), { size: Math.max(160, (size + 8) * 4) });
    assert.equal(decodeQr(frame), text, `version ${(size - 17) / 4} reads back`);
  }
}

// --- what the scanner actually meets: a pairing code and an invite link ---
const b64url = (s) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const CODE = `gymii-sync:v1:${b64url(JSON.stringify({
  server: 'https://sync.example.org',
  token: `tok_${'fixture'.repeat(5)}`, // made up; a real token's length
  pass: 'amber-violet-orbit-saddle-cobalt-nectar-wisp',
  gymId: 'g_8f3a2c71d9',
  invite: true,
}))}`;
const LINK = `https://bmmmm.github.io/gymii/#pair=${encodeURIComponent(CODE)}`;
const unicode = 'Studio Süd — Kraftraum ✓';

const cases = [
  ['a bare code, head-on', CODE, {}],
  ['the invite link, head-on', LINK, {}],
  ['UTF-8 text survives the byte segment', unicode, {}],
  ['turned a quarter', LINK, { angle: Math.PI / 2 }],
  ['upside down', LINK, { angle: Math.PI }],
  ['held crooked (17°)', LINK, { angle: 0.3 }],
  ['at an angle: keystone perspective', LINK, { keystone: [0.0009, 0.0006], fill: 0.7 }],
  ['small in the frame (≈3.6 px per module)', LINK, { size: 320, fill: 0.92 }],
  ['sensor noise', LINK, { noise: 45 }],
  ['a glare gradient across the screen', LINK, { gradient: 0.6 }],
  ['light on dark (inverted)', LINK, { invert: true }],
  ['mirrored', LINK, { mirror: true }],
  ['a terminal: dark surround, half blocks, hairlines, tall cells',
    LINK, { size: 420, terminal: { gap: 0.18, aspect: 1.12 }, surround: 30 }],
  ['a terminal with wide line spacing, close up: hairlines several pixels high',
    LINK, { size: 640, terminal: { gap: 0.3, aspect: 1.2 }, surround: 30 }],
  ['all at once', LINK, {
    size: 440, angle: -0.2, keystone: [0.0005, -0.0004], noise: 30, gradient: 0.4, fill: 0.75,
  }],
];
for (const [what, text, opts] of cases) {
  assert.equal(decodeQr(render(qrMatrix(text), opts)), text, what);
}

// --- damage: Reed-Solomon carries it, up to a point ---
{
  const m = qrMatrix(LINK);
  const n = m.length;
  const hurt = (count, seed) => {
    const rnd = prng(seed);
    const copy = m.map((row) => row.slice());
    for (let k = 0; k < count; k++) {
      // a scratch in the data area, clear of the three finders
      const r = 10 + Math.floor(rnd() * (n - 20));
      const c = 10 + Math.floor(rnd() * (n - 20));
      copy[r][c] ^= 1;
    }
    return copy;
  };
  assert.equal(decodeQr(render(hurt(40, 3), { size: 400 })), LINK, '40 flipped modules are corrected');
  assert.equal(decodeQr(render(hurt(1500, 4), { size: 400 })), null,
    'a ruined symbol answers null — never a wrong text');
}

// --- out of scope answers null, never a guess ---
{
  // the same symbol relabelled as level L: format info is BCH-protected, so
  // no level-L word passes for an M one
  const m = qrMatrix(CODE).map((row) => row.slice());
  const size = m.length;
  const data = (0b01 << 3) | 0;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const levelL = (((data << 10) | rem) ^ 0x5412) & 0x7fff;
  assert.notEqual(levelL, formatValue(0));
  const bit = (i) => (levelL >>> (14 - i)) & 1;
  for (let i = 0; i <= 5; i++) m[8][i] = bit(i);
  m[8][7] = bit(6); m[8][8] = bit(7); m[7][8] = bit(8);
  for (let i = 9; i <= 14; i++) m[14 - i][8] = bit(i);
  for (let i = 0; i <= 6; i++) m[size - 1 - i][8] = bit(i);
  for (let i = 7; i <= 14; i++) m[8][size - 15 + i] = bit(i);
  assert.equal(decodeQr(render(m)), null, 'a level-L symbol is not read as M');

  const rnd = prng(11);
  const static_ = { data: new Uint8ClampedArray(200 * 200 * 4).map((_, i) => (i % 4 === 3 ? 255 : rnd() * 255)), width: 200, height: 200 };
  assert.equal(decodeQr(static_), null, 'sensor static is not a QR code');
  const blank = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
  assert.equal(decodeQr(blank), null, 'a blank frame is not either');
  assert.equal(decodeQr({ data: new Uint8ClampedArray(0), width: 0, height: 0 }), null,
    'nor is a frame the video has not delivered yet');
}

console.log('qrscan tests passed');
