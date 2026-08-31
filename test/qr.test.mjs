// QR encoder tests: a pinned reference symbol, a full decode round-trip and
// the structural invariants a scanner relies on.
// Run with: node test/qr.test.mjs
import { strict as assert } from 'node:assert';
import { qrSvg, qrMatrix, rsEcCodewords, gfMul, maskPenalty } from '../js/qr.js';

// ---------------------------------------------------------------- GF(256)

// Multiplication identities in the field the QR spec prescribes (0x11D).
assert.equal(gfMul(0, 123), 0, '0 annihilates');
assert.equal(gfMul(1, 123), 123, '1 is the identity');
assert.equal(gfMul(123, 1), 123, 'identity from the other side');
assert.equal(gfMul(2, 0x80), 0x1d, 'a carry out of bit 7 reduces by 0x11D');
for (const [a, b] of [[3, 7], [200, 13], [255, 255]]) {
  assert.equal(gfMul(a, b), gfMul(b, a), `gfMul is commutative for ${a},${b}`);
}
assert.equal(gfMul(gfMul(3, 5), 7), gfMul(3, gfMul(5, 7)), 'gfMul is associative');

// The published worked example: "HELLO WORLD" as a version 1-M symbol
// (alphanumeric mode) has these 16 data codewords, and the spec's
// Reed-Solomon step turns them into exactly these 10 EC codewords.
const HELLO_DATA = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
assert.deepEqual(
  rsEcCodewords(HELLO_DATA, 10),
  [196, 35, 39, 119, 235, 215, 231, 226, 93, 23],
  'Reed-Solomon matches the published "HELLO WORLD" 1-M vector',
);

// -------------------------------------------------------- pinned symbol

// The complete module matrix for byte-mode "HELLO WORLD" at EC level M.
// Cross-checked module for module against node-qrcode (an independent
// implementation) driven with an explicit byte segment at level M; the
// data codewords and their placement additionally match libqrencode.
// A single wrong bit anywhere in the pipeline moves at least one module
// here, which is what makes this the test that catches everything.
const HELLO_WORLD_M = [
  '111111101100101111111',
  '100000100001001000001',
  '101110100101001011101',
  '101110101001001011101',
  '101110101110101011101',
  '100000101001001000001',
  '111111101010101111111',
  '000000001001100000000',
  '100010111111011111001',
  '000100001011100001111',
  '001111110011011010010',
  '111110001100010000000',
  '111110101010101100110',
  '000000001010111101011',
  '111111101110101011010',
  '100000100101110110011',
  '101110101101011000110',
  '101110100100100011011',
  '101110100111000111000',
  '100000100001010000000',
  '111111101111111110101',
].map((row) => row.split('').map(Number));

assert.deepEqual(qrMatrix('HELLO WORLD'), HELLO_WORLD_M, 'pinned reference symbol');

// ------------------------------------------- independent spec machinery
// Rebuilt here from the spec rather than imported, so the test measures
// the encoder instead of agreeing with it.

const ALIGN = [
  [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54],
  [6, 32, 58], [6, 34, 62], [6, 26, 46, 66], [6, 26, 48, 70],
];

// [ecPerBlock, group1Blocks, group1Data, group2Blocks, group2Data] at level M
const BLOCKS_M = [
  [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0],
  [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0], [22, 2, 38, 2, 39],
  [22, 3, 36, 2, 37], [26, 4, 43, 1, 44], [30, 1, 50, 4, 51], [22, 6, 36, 2, 37],
  [22, 8, 37, 1, 38], [24, 4, 40, 5, 41], [24, 5, 41, 5, 42],
];

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

// alpha^n for the syndrome check below
const ALPHA = [1];
for (let i = 1; i < 512; i++) ALPHA[i] = gfMul(ALPHA[i - 1], 2);

// Every module that is NOT payload: finders, separators, timing, alignment,
// the dark module, both format areas and (from version 7) the version blocks.
function functionMap(version) {
  const size = version * 4 + 17;
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const mark = (r, c) => { if (r >= 0 && c >= 0 && r < size && c < size) fixed[r][c] = true; };

  [[0, 0], [0, size - 7], [size - 7, 0]].forEach(([t, l]) => {
    for (let r = -1; r <= 7; r++) for (let c = -1; c <= 7; c++) mark(t + r, l + c);
  });
  for (let i = 0; i < size; i++) { mark(6, i); mark(i, 6); }

  const centres = ALIGN[version - 1];
  const last = centres.length - 1;
  centres.forEach((cr, i) => centres.forEach((cc, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) mark(cr + r, cc + c);
  }));

  for (let i = 0; i <= 8; i++) { mark(8, i); mark(i, 8); }
  for (let i = 0; i < 8; i++) { mark(8, size - 1 - i); mark(size - 1 - i, 8); }
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = size - 11 + (i % 3);
      mark(a, b); mark(b, a);
    }
  }
  return fixed;
}

// Read both copies of the format information back out of a finished symbol.
function readFormat(m) {
  const size = m.length;
  const copy1 = [];
  for (let i = 0; i <= 5; i++) copy1.push(m[8][i]);
  copy1.push(m[8][7], m[8][8], m[7][8]);
  for (let i = 9; i <= 14; i++) copy1.push(m[14 - i][8]);

  const copy2 = [];
  for (let i = 0; i <= 6; i++) copy2.push(m[size - 1 - i][8]);
  for (let i = 7; i <= 14; i++) copy2.push(m[8][size - 15 + i]);

  const raw = parseInt(copy1.join(''), 2);
  const value = raw ^ 0x5412; // undo the spec's XOR mask
  // A valid format word is divisible by the BCH generator 0x537.
  let rem = value;
  for (let i = 4; i >= 0; i--) if ((rem >>> (i + 10)) & 1) rem ^= 0x537 << i;

  return {
    copiesAgree: copy1.join('') === copy2.join(''),
    bchOk: (rem & 0x3ff) === 0,
    ecBits: (value >> 13) & 3,
    mask: (value >> 10) & 7,
  };
}

// Full decode: unmask, walk the zigzag, de-interleave, check every block is a
// valid Reed-Solomon codeword, then read the byte-mode payload back out.
function decodeMatrix(m) {
  const size = m.length;
  const version = (size - 17) / 4;
  const fmt = readFormat(m);
  const fixed = functionMap(version);
  const maskFn = MASKS[fmt.mask];

  const bits = [];
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step++) {
      const r = upward ? size - 1 - step : step;
      for (let k = 0; k < 2; k++) {
        const c = right - k;
        if (fixed[r][c]) continue;
        bits.push(m[r][c] ^ (maskFn(r, c) ? 1 : 0));
      }
    }
    upward = !upward;
  }

  const [ecLen, b1, d1, b2, d2] = BLOCKS_M[version - 1];
  const total = b1 * (d1 + ecLen) + b2 * (d2 + ecLen);
  const words = [];
  for (let i = 0; words.length < total; i += 8) {
    let w = 0;
    for (let j = 0; j < 8; j++) w = (w << 1) | bits[i + j];
    words.push(w);
  }

  // Undo the column-wise interleave.
  const lens = [];
  for (let i = 0; i < b1 + b2; i++) lens.push(i < b1 ? d1 : d2);
  const blocks = lens.map(() => []);
  let at = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) {
    blocks.forEach((b, k) => { if (i < lens[k]) b.push(words[at++]); });
  }
  const ecs = lens.map(() => []);
  for (let i = 0; i < ecLen; i++) ecs.forEach((e) => e.push(words[at++]));

  // Syndromes of a valid codeword vanish at alpha^0 .. alpha^(ecLen-1).
  const syndromesOk = blocks.every((b, k) => {
    const cw = b.concat(ecs[k]);
    for (let s = 0; s < ecLen; s++) {
      let acc = 0;
      cw.forEach((v, idx) => { acc ^= gfMul(v, ALPHA[(s * (cw.length - 1 - idx)) % 255]); });
      if (acc !== 0) return false;
    }
    return true;
  });

  // Byte-mode header, then the payload itself.
  const data = blocks.flat();
  const countBits = version < 10 ? 8 : 16;
  const dataBits = [];
  data.forEach((w) => { for (let i = 7; i >= 0; i--) dataBits.push((w >>> i) & 1); });
  const take = (n, from) => parseInt(dataBits.slice(from, from + n).join(''), 2);
  const mode = take(4, 0);
  const len = take(countBits, 4);
  const bytes = [];
  for (let i = 0; i < len; i++) bytes.push(take(8, 4 + countBits + i * 8));

  return {
    version, fmt, syndromesOk, mode, len,
    text: new TextDecoder().decode(Uint8Array.from(bytes)),
  };
}

// ------------------------------------------------- structural invariants

const SAMPLES = [
  'g',
  'gymii',
  'HELLO WORLD',
  'https://gymii.example/#sync',
  'Ünïcödé — Grüße 💪',
  'a'.repeat(100),
  'gymii-sync:v1:' + 'QWERTYuiop0123456789-_'.repeat(11), // ~250 chars
  'z'.repeat(412), // exactly the version 15-M ceiling
];

// Byte-mode payload capacity per version at EC level M (ISO/IEC 18004).
// Automatic version selection must land on the smallest version that fits:
// exactly `cap` bytes stays, one more byte rolls over.
const CAPACITY_M = [14, 26, 42, 62, 84, 106, 122, 152, 180, 213, 251, 287, 331, 362, 412];
CAPACITY_M.forEach((cap, i) => {
  const v = i + 1;
  assert.equal(qrMatrix('z'.repeat(cap)).length, 21 + 4 * (v - 1),
    `${cap} bytes is the ceiling of version ${v}-M`);
  if (v < 15) {
    assert.equal(qrMatrix('z'.repeat(cap + 1)).length, 21 + 4 * v,
      `${cap + 1} bytes rolls over to version ${v + 1}`);
  }
});

SAMPLES.forEach((text) => {
  const m = qrMatrix(text);
  const size = m.length;
  const version = (size - 17) / 4;
  const label = `"${text.slice(0, 20)}" (v${version})`;

  assert.ok(Number.isInteger(version) && version >= 1 && version <= 15,
    `${label}: size is 21 + 4*(v-1) for a version in 1..15`);
  assert.equal(size, 21 + 4 * (version - 1), `${label}: size matches its version`);
  const byteLen = new TextEncoder().encode(text).length;
  assert.ok(byteLen <= CAPACITY_M[version - 1]
    && (version === 1 || byteLen > CAPACITY_M[version - 2]),
    `${label}: ${byteLen} bytes picks the smallest fitting version`);

  // No undefined cells — every module is exactly 0 or 1.
  assert.equal(m.length, size, `${label}: matrix is square`);
  m.forEach((row, r) => {
    assert.equal(row.length, size, `${label}: row ${r} is full width`);
    row.forEach((v, c) => assert.ok(v === 0 || v === 1, `${label}: module ${r},${c} is 0 or 1`));
  });

  // Three finder patterns, each with its light separator.
  [[0, 0], [0, size - 7], [size - 7, 0]].forEach(([t, l]) => {
    for (let r = 0; r < 7; r++) {
      for (let c = 0; c < 7; c++) {
        const ring = r === 0 || r === 6 || c === 0 || c === 6;
        const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        assert.equal(m[t + r][l + c], ring || core ? 1 : 0,
          `${label}: finder at ${t},${l} module ${r},${c}`);
      }
    }
    for (let r = -1; r <= 7; r++) {
      for (const c of [-1, 7]) {
        if (t + r >= 0 && t + r < size && l + c >= 0 && l + c < size) {
          assert.equal(m[t + r][l + c], 0, `${label}: separator beside finder ${t},${l}`);
        }
        if (t + c >= 0 && t + c < size && l + r >= 0 && l + r < size) {
          assert.equal(m[t + c][l + r], 0, `${label}: separator above/below finder ${t},${l}`);
        }
      }
    }
  });

  // Timing patterns alternate, dark on even coordinates.
  for (let i = 8; i < size - 8; i++) {
    assert.equal(m[6][i], i % 2 === 0 ? 1 : 0, `${label}: horizontal timing at ${i}`);
    assert.equal(m[i][6], i % 2 === 0 ? 1 : 0, `${label}: vertical timing at ${i}`);
  }

  // Alignment patterns wherever the spec puts them.
  const centres = ALIGN[version - 1];
  const last = centres.length - 1;
  centres.forEach((cr, i) => centres.forEach((cc, j) => {
    if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const ring = Math.max(Math.abs(r), Math.abs(c));
        assert.equal(m[cr + r][cc + c], ring === 1 ? 0 : 1,
          `${label}: alignment pattern at ${cr},${cc} module ${r},${c}`);
      }
    }
  }));

  // The dark module.
  assert.equal(m[4 * version + 9][8], 1, `${label}: dark module at (4v+9, 8)`);
  assert.equal(4 * version + 9, size - 8, `${label}: (4v+9) is size-8`);

  // Version information: two identical 6x3 blocks from version 7 on, each an
  // 18-bit BCH word (generator 0x1F25, no XOR mask) naming this version.
  if (version >= 7) {
    const read = (pick) => {
      let v = 0;
      for (let i = 0; i < 18; i++) v |= pick(i) << i;
      return v;
    };
    const topRight = read((i) => m[Math.floor(i / 3)][size - 11 + (i % 3)]);
    const bottomLeft = read((i) => m[size - 11 + (i % 3)][Math.floor(i / 3)]);
    assert.equal(topRight, bottomLeft, `${label}: both version blocks carry the same word`);
    assert.equal(topRight >> 12, version, `${label}: version block names version ${version}`);
    let rem = topRight;
    for (let i = 5; i >= 0; i--) if ((rem >>> (i + 12)) & 1) rem ^= 0x1f25 << i;
    assert.equal(rem & 0xfff, 0, `${label}: version block passes its BCH check`);
  }

  // Format info: both copies agree, the BCH check passes, EC level is M and
  // the mask it names is the mask the symbol was actually built with (a
  // wrong mask would corrupt the codewords and fail the syndromes below).
  const decoded = decodeMatrix(m);
  assert.ok(decoded.fmt.copiesAgree, `${label}: both format copies carry the same word`);
  assert.ok(decoded.fmt.bchOk, `${label}: format word passes its BCH check`);
  assert.equal(decoded.fmt.ecBits, 0b00, `${label}: format info says EC level M`);
  assert.ok(decoded.fmt.mask >= 0 && decoded.fmt.mask <= 7, `${label}: mask id is 0..7`);

  // Full round-trip through the spec's own machinery.
  assert.ok(decoded.syndromesOk, `${label}: every block is a valid Reed-Solomon codeword`);
  assert.equal(decoded.mode, 0b0100, `${label}: mode header says byte mode`);
  assert.equal(decoded.len, byteLen, `${label}: length header matches the payload`);
  assert.equal(decoded.text, text, `${label}: decodes back to the original text`);
});

// ------------------------------------------------------- mask coverage

// One payload per mask id: every one of the eight masks must be reachable,
// correctly applied and correctly announced in the format info. Without this
// a mask formula that is never picked could stay broken unnoticed.
const PER_MASK = {
  0: 'aa', 1: 'g', 2: '7', 3: 'ZZZZZZ',
  4: 'x', 5: 'a', 6: '77777', 7: 'aaaaaaaaa',
};
Object.entries(PER_MASK).forEach(([id, text]) => {
  const decoded = decodeMatrix(qrMatrix(text));
  assert.equal(decoded.fmt.mask, Number(id), `"${text}" selects mask ${id}`);
  assert.ok(decoded.syndromesOk, `mask ${id}: blocks stay valid after unmasking`);
  assert.equal(decoded.text, text, `mask ${id}: round-trips`);
});

// ------------------------------------------------------ penalty scoring

// Rules 1, 2 and 4 on a blank 21x21 symbol, all hand-computed:
//   rule 1: 42 lines, each one run of 21 -> 42 * (3 + 21 - 5) = 798
//   rule 2: 20*20 uniform 2x2 blocks    -> 400 * 3            = 1200
//   rule 3: needs dark modules                                = 0
//   rule 4: 0% dark, |0 - 50| / 5 = 10  -> 10 * 10            = 100
const blank21 = Array.from({ length: 21 }, () => new Array(21).fill(0));
assert.equal(maskPenalty(blank21), 2098, 'penalty of an all-light 21x21 field');
const solid21 = Array.from({ length: 21 }, () => new Array(21).fill(1));
assert.equal(maskPenalty(solid21), 2098, 'an all-dark field scores the same by symmetry');

// Rule 3 hunts the finder signature 1:1:3:1:1 with four light modules beside
// it. On an 11x11 blank field a single such run costs 40 on top of
// 184 (rule 1) + 279 (rule 2) + 90 (rule 4, 5/121 dark) = 553.
const withFinderRun = (row) => {
  const m = Array.from({ length: 11 }, () => new Array(11).fill(0));
  m[0] = row.slice();
  return m;
};
assert.equal(maskPenalty(withFinderRun([1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0])), 593,
  'rule 3 charges 40 for a finder-like run followed by four light modules');
assert.equal(maskPenalty(withFinderRun([0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1])), 593,
  'and the same for the mirrored run');
// Shift the same run one module right so only three light modules follow it:
// it no longer reads as a finder and the 40 points fall away. 593 - 40 - 3 =
// 550, the extra 3 being the one uniform 2x2 light block the shift destroys.
assert.equal(maskPenalty(withFinderRun([0, 1, 0, 1, 1, 1, 0, 1, 0, 0, 0])), 550,
  'no charge when the light area beside the run is too narrow');

// ------------------------------------------------------------- overflow

assert.equal(qrMatrix('z'.repeat(412)).length, 77, '412 bytes still fit version 15-M');
assert.throws(() => qrMatrix('z'.repeat(413)), /^Error: qr-overflow$/,
  '413 bytes overflow version 15-M');
assert.throws(() => qrSvg('z'.repeat(5000)), /^Error: qr-overflow$/,
  'qrSvg surfaces the same overflow');
// Multi-byte characters count as bytes, not characters.
assert.throws(() => qrMatrix('💪'.repeat(104)), /^Error: qr-overflow$/,
  '416 UTF-8 bytes overflow even though it is 104 characters');

// ----------------------------------------------------------------- SVG

SAMPLES.forEach((text) => {
  const svg = qrSvg(text);
  const size = qrMatrix(text).length;
  const dim = size + 8; // a four-module quiet zone on every side

  assert.ok(svg.startsWith('<svg'), 'SVG starts with <svg');
  assert.ok(svg.endsWith('</svg>'), 'SVG is closed');
  assert.ok(svg.includes(`viewBox="0 0 ${dim} ${dim}"`), `viewBox is ${dim} for a ${size} symbol`);
  const openTag = svg.slice(0, svg.indexOf('>') + 1);
  assert.ok(!/\swidth=/.test(openTag) && !/\sheight=/.test(openTag),
    'no fixed pixel size on the <svg> tag itself, so CSS can scale it');
  assert.ok(svg.includes(`<rect width="${dim}" height="${dim}" fill="#ffffff"/>`),
    'white background rect covers the whole viewBox including the quiet zone');
  assert.match(svg, /<path d="M[^"]+" fill="#000000"\/>/, 'black modules as one path');
  // Literal colors: a camera needs the contrast, so the theme must not reach in.
  assert.ok(!svg.includes('var(--'), 'no CSS variables in the SVG');
});

// The path draws exactly the dark modules and nothing else: read the runs
// back out and rebuild the matrix from them. This also proves the quiet zone
// stays empty, since a run outside the symbol would fall off the grid.
SAMPLES.forEach((text) => {
  const svg = qrSvg(text);
  const m = qrMatrix(text);
  const size = m.length;
  const rebuilt = Array.from({ length: size }, () => new Array(size).fill(0));
  const runs = [...svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)].map((mt) => mt.slice(1, 4).map(Number));
  assert.ok(runs.length, `"${text.slice(0, 12)}": the path has module runs`);
  runs.forEach(([x, y, run]) => {
    assert.ok(x >= 4 && y >= 4 && x + run <= 4 + size && y < 4 + size,
      `run at ${x},${y} stays inside the symbol, clear of the quiet zone`);
    for (let i = 0; i < run; i++) rebuilt[y - 4][x - 4 + i] = 1;
  });
  assert.deepEqual(rebuilt, m, `"${text.slice(0, 12)}": SVG path reproduces the module matrix`);
});

console.log('qr: all assertions passed');
