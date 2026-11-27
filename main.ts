// Squeeze screenshots into the smallest PNG — an entry for make.fun's png-squeeze-01 bounty.
//
// The program reads every screenshot of a set from /input/<id>/image.png, rewrites the very same
// pixels losslessly in as few bytes as it can, and writes /output/<id>/image.png. Nothing is read
// from anywhere but /input and nothing but the answer files is written; the work budget is counted
// in bytes processed, never in clock time, so two runs of the same set answer byte for byte alike.
//
// The pipeline, per screenshot:
//   1. read the pixels, then pick the smallest lossless colour type the pixels allow: grey (type 0),
//      a palette with tRNS (type 3), RGB (type 2) or RGBA (type 6);
//   2. for a palette, order the entries so that neighbours in the picture get neighbouring indices —
//      a greedy walk over the pixel-adjacency graph, then swaps that shrink the weighted spread;
//   3. choose the PNG row filter (0..4) by trying all five and measuring them with a fast deflate;
//   4. write the filtered rows with an own DEFLATE encoder: an optimal parse (shortest bit path over
//      the match graph, re-costed from the Huffman table of the previous pass) and dynamic Huffman
//      blocks whose boundaries are chosen by size.
//
// Node 22 runs this file as TypeScript with its types stripped, so plain JavaScript is written here.

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------- PNG reading

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; }
  return t;
})();

function crc32(bytes) {
  let c = -1;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(d) {
  let a = 1, b = 0;
  for (let i = 0; i < d.length;) {
    const end = Math.min(d.length, i + 5552);
    for (; i < end; i++) { a += d[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function readPng(bytes) {
  let off = 8, width = 0, height = 0, colourType = 6;
  const idat = [];
  let palette = null, trns = null;
  while (off + 8 <= bytes.length) {
    const len = (bytes[off] << 24 | bytes[off + 1] << 16 | bytes[off + 2] << 8 | bytes[off + 3]) >>> 0;
    const type = String.fromCharCode(bytes[off + 4], bytes[off + 5], bytes[off + 6], bytes[off + 7]);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = (data[0] << 24 | data[1] << 16 | data[2] << 8 | data[3]) >>> 0;
      height = (data[4] << 24 | data[5] << 16 | data[6] << 8 | data[7]) >>> 0;
      colourType = data[9];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const ch = CHANNELS[colourType];
  const stride = width * ch;
  const raw = zlibInflate(Buffer.concat(idat.map((b) => Buffer.from(b))), height * (stride + 1));
  const rgba = new Uint8Array(width * height * 4);
  const cur = new Uint8Array(stride), prev = new Uint8Array(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const ft = raw[p++];
    cur.set(raw.subarray(p, p + stride)); p += stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? cur[i - ch] : 0, b = prev[i], c = i >= ch ? prev[i - ch] : 0;
      let v = cur[i];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) {
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (ch === 4) { rgba[o] = cur[x * 4]; rgba[o + 1] = cur[x * 4 + 1]; rgba[o + 2] = cur[x * 4 + 2]; rgba[o + 3] = cur[x * 4 + 3]; }
      else if (ch === 3) {
        const k = cur[x] * 3;
        rgba[o] = palette[k]; rgba[o + 1] = palette[k + 1]; rgba[o + 2] = palette[k + 2];
        rgba[o + 3] = trns && cur[x] < trns.length ? trns[cur[x]] : 255;
      }
      else if (ch === 2) { rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[x * 2]; rgba[o + 3] = cur[x * 2 + 1]; }
      else { rgba[o] = rgba[o + 1] = rgba[o + 2] = cur[x]; rgba[o + 3] = 255; }
    }
    prev.set(cur);
  }
  return { width, height, rgba };
}

function zlibInflate(buf, expected) {
  const out = inflateSync(buf);
  if (out.length < expected) throw new Error('short inflate');
  return out.subarray(0, expected);
}

// ---------------------------------------------------------------- PNG writing

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  out[0] = data.length >>> 24; out[1] = data.length >>> 16; out[2] = data.length >>> 8; out[3] = data.length;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const c = crc32(out.subarray(4, 8 + data.length));
  out[8 + data.length] = c >>> 24; out[9 + data.length] = c >>> 16; out[10 + data.length] = c >>> 8; out[11 + data.length] = c;
  return out;
}

function writePng(width, height, colourType, extraChunks, stream) {
  const parts = [Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10)];
  const ihdr = new Uint8Array(13);
  ihdr[0] = width >>> 24; ihdr[1] = width >>> 16; ihdr[2] = width >>> 8; ihdr[3] = width;
  ihdr[4] = height >>> 24; ihdr[5] = height >>> 16; ihdr[6] = height >>> 8; ihdr[7] = height;
  ihdr[8] = 8; ihdr[9] = colourType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  parts.push(chunk('IHDR', ihdr));
  for (const c of extraChunks) parts.push(chunk(c.type, c.data));
  parts.push(chunk('IDAT', stream));
  parts.push(chunk('IEND', new Uint8Array(0)));
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ---------------------------------------------------------------- DEFLATE

const WINDOW = 32768, MINM = 3, MAXM = 258;
const HBITS = 17, HSIZE = 1 << HBITS, STRIDE = 8;
const BLOCK_CHOICES = [1 << 14, 1 << 15, 1 << 16, 1 << 17, 1 << 30];

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const lenSym = new Uint16Array(MAXM + 2), lenExt = new Uint8Array(MAXM + 2), lenVal = new Uint16Array(MAXM + 2);
for (let s = 0; s < 29; s++) {
  const base = LEN_BASE[s], cnt = s === 28 ? 1 : LEN_BASE[s + 1] - base;
  for (let k = 0; k < cnt; k++) { const L = base + k; lenSym[L] = 257 + s; lenExt[L] = LEN_EXTRA[s]; lenVal[L] = k; }
}
const distSym = new Uint8Array(32769);
{
  let s = 0;
  for (let d = 1; d <= 32768; d++) { while (s < 29 && DIST_BASE[s + 1] <= d) s++; distSym[d] = s; }
}

function buildLengths(freqs, maxBits) {
  const n = freqs.length;
  const len = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) syms.push(i);
  if (syms.length === 0) return len;
  if (syms.length === 1) { len[syms[0]] = 1; return len; }
  const heap = [];
  const less = (a, b) => a.f < b.f || (a.f === b.f && a.s < b.s);
  const push = (nd) => {
    heap.push(nd);
    let i = heap.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (less(heap[i], heap[p])) { const t = heap[i]; heap[i] = heap[p]; heap[p] = t; i = p; } else break; }
  };
  const pop = () => {
    const top = heap[0], last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l], heap[m])) m = l;
        if (r < heap.length && less(heap[r], heap[m])) m = r;
        if (m === i) break;
        const t = heap[i]; heap[i] = heap[m]; heap[m] = t; i = m;
      }
    }
    return top;
  };
  for (const s of syms) push({ f: freqs[s], s, l: null, r: null });
  while (heap.length > 1) { const a = pop(), b = pop(); push({ f: a.f + b.f, s: Math.min(a.s, b.s), l: a, r: b }); }
  const walk = (nd, depth) => { if (!nd.l) { len[nd.s] = Math.max(1, depth); return; } walk(nd.l, depth + 1); walk(nd.r, depth + 1); };
  walk(heap[0], 0);
  let maxLen = 0;
  for (const s of syms) if (len[s] > maxLen) maxLen = len[s];
  if (maxLen > maxBits) {
    const bl = new Uint16Array(maxBits + 2);
    let overflow = 0;
    for (const s of syms) { const L = len[s]; if (L > maxBits) { bl[maxBits]++; overflow++; } else bl[L]++; }
    while (overflow > 0) {
      let b = maxBits - 1;
      while (b > 0 && bl[b] === 0) b--;
      bl[b]--; bl[b + 1] += 2; bl[maxBits]--; overflow -= 2;
    }
    const order = syms.slice().sort((a, b) => freqs[a] - freqs[b] || a - b);
    let idx = 0;
    for (let b = maxBits; b >= 1; b--) for (let k = 0; k < bl[b]; k++) len[order[idx++]] = b;
    for (; idx < order.length; idx++) len[order[idx]] = maxBits;
  }
  return len;
}

function canonicalCodes(lens) {
  const blCount = new Uint16Array(16);
  for (let i = 0; i < lens.length; i++) if (lens[i]) blCount[lens[i]]++;
  const nextCode = new Uint16Array(17);
  let code = 0;
  for (let b = 1; b <= 15; b++) { code = (code + blCount[b - 1]) << 1; nextCode[b] = code; }
  const codes = new Uint16Array(lens.length);
  for (let i = 0; i < lens.length; i++) { const l = lens[i]; if (l) codes[i] = nextCode[l]++; }
  return codes;
}

const REV = new Uint16Array(1 << 15);
for (let v = 0; v < 1 << 15; v++) { let r = 0, x = v; for (let i = 0; i < 15; i++) { r = (r << 1) | (x & 1); x >>= 1; } REV[v] = r; }
const rev = (v, n) => REV[v] >>> (15 - n);

class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.bit = 0; this.acc = 0; }
  bits(value, n) {
    if (n === 0) return;
    this.acc |= value << this.bit;
    this.bit += n;
    while (this.bit >= 8) { this.buf[this.pos++] = this.acc & 255; this.acc >>>= 8; this.bit -= 8; }
  }
  done() { if (this.bit > 0) { this.buf[this.pos++] = this.acc & 255; this.acc = 0; this.bit = 0; } return this.buf.subarray(0, this.pos); }
}

function matchTable(d, n, steps) {
  const head = new Int32Array(HSIZE).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const cnt = new Uint8Array(n);
  const m = new Uint32Array(n * STRIDE);
  const dv = new DataView(d.buffer, d.byteOffset, d.length);
  const u32 = (p) => (p + 4 <= n ? dv.getUint32(p) : -1);
  for (let i = 0; i + MINM <= n; i++) {
    const h = (Math.imul((d[i] << 12) ^ (d[i + 1] << 8) ^ (d[i + 2] << 4) ^ d[i + 3], 2654435761) >>> 19) & (HSIZE - 1);
    let cur = head[h];
    prev[i] = cur;
    head[h] = i;
    const maxLen = Math.min(MAXM, n - i);
    let count = 0, best = MINM - 1, walked = 0;
    const w0 = u32(i);
    while (cur >= 0 && walked < steps) {
      const dist = i - cur;
      if (dist > WINDOW) break;
      walked++;
      if (u32(cur) === w0 && d[cur + best] === d[i + best]) {
        let L = 0;
        while (L + 4 <= maxLen && u32(cur + L) === u32(i + L)) L += 4;
        while (L < maxLen && d[cur + L] === d[i + L]) L++;
        if (L > best) {
          best = L;
          m[i * STRIDE + count++] = (L << 16) | dist;
          if (L >= maxLen || count === STRIDE) break;
        }
      }
      cur = prev[cur];
    }
    cnt[i] = count;
  }
  return { cnt, m };
}

function writeBlock(w, toks, ll, dl, final, from, to) {
  const lc = canonicalCodes(ll), dc = canonicalCodes(dl);
  let hlit = 286;
  while (hlit > 257 && ll[hlit - 1] === 0) hlit--;
  let hdist = 30;
  while (hdist > 1 && dl[hdist - 1] === 0) hdist--;
  w.bits(final, 1);
  w.bits(2, 2);
  w.bits(hlit - 257, 5);
  w.bits(hdist - 1, 5);
  const all = new Uint8Array(hlit + hdist);
  all.set(ll.subarray(0, hlit));
  all.set(dl.subarray(0, hdist), hlit);
  const rle = [];
  for (let i = 0; i < all.length;) {
    const v = all[i];
    let run = 1;
    while (i + run < all.length && all[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) { const c = Math.min(138, left); rle.push([18, c - 11, 7]); left -= c; }
      if (left >= 3) { rle.push([17, left - 3, 3]); left = 0; }
      while (left-- > 0) rle.push([0, 0, 0]);
    } else {
      rle.push([v, 0, 0]);
      let left = run - 1;
      while (left >= 3) { const c = Math.min(6, left); rle.push([16, c - 3, 2]); left -= c; }
      while (left-- > 0) rle.push([v, 0, 0]);
    }
    i += run;
  }
  const clFreq = new Uint32Array(19);
  for (const r of rle) clFreq[r[0]]++;
  const cl = buildLengths(clFreq, 7);
  let hclen = 19;
  while (hclen > 4 && cl[CL_ORDER[hclen - 1]] === 0) hclen--;
  w.bits(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) w.bits(cl[CL_ORDER[i]], 3);
  const clc = canonicalCodes(cl);
  for (const r of rle) { w.bits(rev(clc[r[0]], cl[r[0]]), cl[r[0]]); if (r[2]) w.bits(r[1], r[2]); }
  for (let t = from; t < to; t++) {
    const v = toks[t];
    if (v < 0) { const b = -v - 1; w.bits(rev(lc[b], ll[b]), ll[b]); }
    else {
      const L = v >>> 17, dist = v & 0xffff;
      const s = lenSym[L];
      w.bits(rev(lc[s], ll[s]), ll[s]);
      if (lenExt[L]) w.bits(lenVal[L], lenExt[L]);
      const ds = distSym[dist];
      w.bits(rev(dc[ds], dl[ds]), dl[ds]);
      if (DIST_EXTRA[ds]) w.bits(dist - DIST_BASE[ds], DIST_EXTRA[ds]);
    }
  }
  w.bits(rev(lc[256], ll[256]), ll[256]);
}

function encodeStream(data, toks, n, blockSize) {
  const ends = new Int32Array(toks.length);
  let p = 0;
  for (let t = 0; t < toks.length; t++) { const v = toks[t]; p += v < 0 ? 1 : v >>> 17; ends[t] = p; }
  const bounds = [];
  if (blockSize >= n) bounds.push([0, toks.length]);
  else {
    let start = 0;
    for (let t = 0; t < toks.length; t++) {
      const from = start === 0 ? 0 : ends[start - 1];
      if (ends[t] - from >= blockSize || t === toks.length - 1) { bounds.push([start, t + 1]); start = t + 1; }
    }
  }
  const w = new BitWriter(Math.max(2048, (n >> 2) + 2048));
  w.bits(0x78, 8);
  w.bits(0xda, 8);
  for (let b = 0; b < bounds.length; b++) {
    const [a, z] = bounds[b];
    const litLen = new Uint32Array(286), distLen = new Uint32Array(30);
    for (let t = a; t < z; t++) {
      const v = toks[t];
      if (v < 0) litLen[-v - 1]++;
      else { litLen[lenSym[v >>> 17]]++; distLen[distSym[v & 0xffff]]++; }
    }
    litLen[256] = 1;
    const ll = buildLengths(litLen, 15), dl = buildLengths(distLen, 15);
    writeBlock(w, toks, ll, dl, b === bounds.length - 1 ? 1 : 0, a, z);
  }
  const body = w.done();
  const ad = adler32(data);
  const out = new Uint8Array(body.length + 4);
  out.set(body);
  out[body.length] = ad >>> 24; out[body.length + 1] = ad >>> 16; out[body.length + 2] = ad >>> 8; out[body.length + 3] = ad;
  return out;
}

function zdeflate(data, steps, iters) {
  const n = data.length;
  const { cnt, m } = matchTable(data, n, steps);
  const cost = new Float64Array(n + 2);
  const choice = new Int32Array(n + 1);
  let litCost = new Float64Array(256).fill(8);
  let lenCost = new Float64Array(MAXM + 2), distCost = new Float64Array(30);
  for (let L = MINM; L <= MAXM; L++) lenCost[L] = 5 + lenExt[L];
  distCost.fill(5);
  let best = null;
  for (let it = 0; it < iters; it++) {
    cost.fill(1e30);
    cost[0] = 0;
    choice.fill(0);
    for (let i = 0; i < n; i++) {
      const c = cost[i];
      if (c >= 1e30) continue;
      const lc = c + litCost[data[i]];
      if (lc < cost[i + 1]) { cost[i + 1] = lc; choice[i + 1] = 0; }
      const k = cnt[i];
      if (k === 0) continue;
      let prevLen = MINM - 1;
      for (let j = 0; j < k; j++) {
        const v = m[i * STRIDE + j];
        const L = v >>> 16, dist = v & 0xffff;
        const base = c + distCost[distSym[dist]];
        for (let LL = prevLen + 1; LL <= L; LL++) {
          const cc = base + lenCost[LL];
          if (cc < cost[i + LL]) { cost[i + LL] = cc; choice[i + LL] = (LL << 17) | dist; }
        }
        prevLen = L;
      }
    }
    const toks = [];
    let p = n;
    while (p > 0) {
      const ch = choice[p];
      if (ch === 0) { toks.push(-data[p - 1] - 1); p -= 1; }
      else { toks.push(ch); p -= ch >>> 17; }
    }
    toks.reverse();
    const glit = new Uint32Array(286), gdist = new Uint32Array(30);
    for (let t = 0; t < toks.length; t++) {
      const v = toks[t];
      if (v < 0) glit[-v - 1]++;
      else { glit[lenSym[v >>> 17]]++; gdist[distSym[v & 0xffff]]++; }
    }
    glit[256] = 1;
    const ll = buildLengths(glit, 15), dl = buildLengths(gdist, 15);
    // only the last pass writes a stream: the earlier ones exist to sharpen the cost model
    if (it === iters - 1) {
      for (const bs of BLOCK_CHOICES) {
        const cand = encodeStream(data, toks, n, bs);
        if (!best || cand.length < best.length) best = cand;
      }
    }
    litCost = new Float64Array(256);
    for (let i = 0; i < 256; i++) litCost[i] = ll[i] || 15;
    lenCost = new Float64Array(MAXM + 2);
    for (let L = MINM; L <= MAXM; L++) lenCost[L] = (ll[lenSym[L]] || 15) + lenExt[L];
    distCost = new Float64Array(30);
    for (let s = 0; s < 30; s++) distCost[s] = (dl[s] || 15) + DIST_EXTRA[s];
  }
  return best;
}

// ---------------------------------------------------------------- colour types and filters

function filterRows(samples, w, h, bpp, f) {
  const stride = w * bpp;
  const out = new Uint8Array(h * (stride + 1));
  for (let y = 0; y < h; y++) {
    const base = y * stride, prevBase = (y - 1) * stride, o = y * (stride + 1);
    out[o] = f;
    if (f === 0 || (f === 2 && y === 0)) { out.set(samples.subarray(base, base + stride), o + 1); continue; }
    for (let i = 0; i < stride; i++) {
      const cur = samples[base + i];
      const a = i >= bpp ? samples[base + i - bpp] : 0;
      const b = y > 0 ? samples[prevBase + i] : 0;
      let v;
      if (f === 1) v = cur - a;
      else if (f === 2) v = cur - b;
      else if (f === 3) v = cur - ((a + b) >> 1);
      else {
        const c = i >= bpp && y > 0 ? samples[prevBase + i - bpp] : 0;
        const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v = cur - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      out[o + 1 + i] = v & 255;
    }
  }
  return out;
}

function orderPalette(idx, w, h, k) {
  const adj = new Float64Array(k * k);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, a = idx[i];
      if (x + 1 < w) { const b = idx[i + 1]; adj[a * k + b]++; adj[b * k + a]++; }
      if (y + 1 < h) { const b = idx[i + w]; adj[a * k + b]++; adj[b * k + a]++; }
    }
  }
  const used = new Uint8Array(k), order = [];
  for (let start = 0; start < k; start++) {
    if (used[start]) continue;
    let cur = start;
    used[cur] = 1;
    order.push(cur);
    for (;;) {
      let bestJ = -1, bestW = -1;
      for (let j = 0; j < k; j++) if (!used[j] && adj[cur * k + j] > bestW) { bestW = adj[cur * k + j]; bestJ = j; }
      if (bestJ < 0) break;
      used[bestJ] = 1;
      order.push(bestJ);
      cur = bestJ;
    }
  }
  if (k <= 96) {
    const score = (ord) => {
      let s = 0;
      for (let a = 0; a < k; a++) for (let b = a + 1; b < k; b++) { const wt = adj[ord[a] * k + ord[b]]; if (wt) s += wt * (b - a); }
      return s;
    };
    let cur = score(order);
    for (let a = 1; a < k - 1; a++) {
      for (let b = a + 1; b < k; b++) {
        const t = order[a]; order[a] = order[b]; order[b] = t;
        const s2 = score(order);
        if (s2 < cur - 1e-9) cur = s2;
        else { const t2 = order[a]; order[a] = order[b]; order[b] = t2; }
      }
    }
  }
  const map = new Uint8Array(k);
  order.forEach((oldIdx, pos) => { map[oldIdx] = pos; });
  return { order, map };
}

function buildCandidates(rgba, w, h) {
  const n = w * h;
  const seen = new Map();
  let grey = true, opaque = true;
  for (let i = 0, o = 0; i < n; i++, o += 4) {
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2], a = rgba[o + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) opaque = false;
    const key = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  const cands = [];
  if (grey && opaque) {
    const s = new Uint8Array(n);
    for (let i = 0, o = 0; i < n; i++, o += 4) s[i] = rgba[o];
    cands.push({ ct: 0, bpp: 1, samples: s, extra: 0, chunks: [] });
  }
  if (seen.size <= 256) {
    const keys = [...seen.keys()];
    const index = new Map();
    keys.forEach((k, i) => index.set(k, i));
    const idx = new Uint8Array(n);
    for (let i = 0, o = 0; i < n; i++, o += 4) idx[i] = index.get(((rgba[o] << 24) | (rgba[o + 1] << 16) | (rgba[o + 2] << 8) | rgba[o + 3]) >>> 0);
    const { order, map } = orderPalette(idx, w, h, keys.length);
    const samples = new Uint8Array(n);
    for (let i = 0; i < n; i++) samples[i] = map[idx[i]];
    const plte = new Uint8Array(keys.length * 3), trns = new Uint8Array(keys.length);
    order.forEach((oldIdx, pos) => {
      const k = keys[oldIdx];
      plte[pos * 3] = (k >>> 24) & 255;
      plte[pos * 3 + 1] = (k >>> 16) & 255;
      plte[pos * 3 + 2] = (k >>> 8) & 255;
      trns[pos] = k & 255;
    });
    let tlen = trns.length;
    while (tlen > 0 && trns[tlen - 1] === 255) tlen--;
    const chunks = [{ type: 'PLTE', data: plte }];
    if (tlen) chunks.push({ type: 'tRNS', data: trns.subarray(0, tlen) });
    cands.push({ ct: 3, bpp: 1, samples, extra: 12 + plte.length + (tlen ? 12 + tlen : 0), chunks });
  }
  if (opaque) {
    const s = new Uint8Array(n * 3);
    for (let i = 0, o = 0, j = 0; i < n; i++, o += 4, j += 3) { s[j] = rgba[o]; s[j + 1] = rgba[o + 1]; s[j + 2] = rgba[o + 2]; }
    cands.push({ ct: 2, bpp: 3, samples: s, extra: 0, chunks: [] });
  }
  const s4 = new Uint8Array(n * 4);
  s4.set(rgba);
  cands.push({ ct: 6, bpp: 4, samples: s4, extra: 0, chunks: [] });
  return cands;
}

// ---------------------------------------------------------------- per-screenshot answer

function answerFor(pngBytes) {
  const { width: w, height: h, rgba } = readPng(pngBytes);
  const n = w * h;
  const cands = buildCandidates(rgba, w, h);

  // rank the (colour type, filter) pairs with a fast deflate, then spend the slow encoder on the best
  let pick = null;
  for (const c of cands) {
    for (let f = 0; f < 5; f++) {
      const filtered = filterRows(c.samples, w, h, c.bpp, f);
      const size = deflateSync(filtered, { level: 6, memLevel: 9 }).length + c.extra;
      if (!pick || size < pick.size) pick = { c, f, filtered, size };
    }
  }

  // work budget, counted in bytes rather than seconds: a smaller buffer gets the deeper search.
  // The whole set must fit one 60-second wall, so the budget is deliberately conservative.
  const size = pick.filtered.length;
  const steps = size <= 1050000 ? 576 : size <= 3300000 ? 448 : 384;
  const iters = 3;

  const stream = zdeflate(pick.filtered, steps, iters);
  const out = writePng(w, h, pick.c.ct, pick.c.chunks, stream);
  if (out.length < pngBytes.length) return out;

  // never answer worse than the input itself
  return pngBytes;
}

// ---------------------------------------------------------------- run the set

const ids = readdirSync(INPUT_DIR).filter((d) => existsSync(join(INPUT_DIR, d, 'image.png'))).sort();
for (const id of ids) {
  const input = readFileSync(join(INPUT_DIR, id, 'image.png'));
  let answer;
  try {
    answer = answerFor(new Uint8Array(input.buffer, input.byteOffset, input.length));
  } catch (err) {
    answer = new Uint8Array(input);
  }
  const dir = join(OUTPUT_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'image.png'), answer);
}
