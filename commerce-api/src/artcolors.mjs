// Stage 14 (owner decision Oct 31, 2026): skip a garment color only when the whole design would blend into it.
// Nino adds outlines so designs stand out on most colors, so a color is skipped only when BOTH the design's body and
// its outer edge (where those outlines sit) are mostly too close to the garment. Measured on Printful's small
// thumbnail of the artwork file (about 220px), in CIELAB color distance.

export const DISTANCE = 35;    // CIELAB distance below which a pixel reads as "same color" as the garment
export const BODY_MIN = 0.75;  // share of the design's pixels that must stand out ...
export const EDGE_MIN = 0.8;   // ... or share of its edge (outline) pixels that must stand out

const readU32 = (b, i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// 8-bit, non-interlaced PNG (RGBA, RGB, gray, gray+alpha, palette with tRNS) -> {width, height, rgba}. null otherwise.
export async function decodePng(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (b.length < 33 || readU32(b, 0) !== 0x89504e47) return null;
  let i = 8, width = 0, height = 0, depth = 0, type = 0, interlace = 0, palette = null, trns = null; const idat = [];
  while (i + 8 <= b.length) {
    const len = readU32(b, i), tag = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]), data = b.subarray(i + 8, i + 8 + len);
    if (tag === 'IHDR') { width = readU32(data, 0); height = readU32(data, 4); depth = data[8]; type = data[9]; interlace = data[12]; }
    else if (tag === 'PLTE') palette = data;
    else if (tag === 'tRNS') trns = data;
    else if (tag === 'IDAT') idat.push(data);
    else if (tag === 'IEND') break;
    i += 12 + len;
  }
  const channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[type];
  if (!channels || depth !== 8 || interlace || !width || !height || width * height > 1e6 || (type === 3 && !palette)) return null;
  const total = idat.reduce((n, d) => n + d.length, 0), joined = new Uint8Array(total); let o = 0;
  for (const d of idat) { joined.set(d, o); o += d.length; }
  const raw = await inflate(joined);
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const pix = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? pix[row + x - channels] : 0, up = y ? pix[prev + x] : 0, c = y && x >= channels ? pix[prev + x - channels] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      pix[row + x] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * channels, d = p * 4;
    if (type === 6) { rgba[d] = pix[s]; rgba[d + 1] = pix[s + 1]; rgba[d + 2] = pix[s + 2]; rgba[d + 3] = pix[s + 3]; }
    else if (type === 2) { rgba[d] = pix[s]; rgba[d + 1] = pix[s + 1]; rgba[d + 2] = pix[s + 2]; rgba[d + 3] = 255; }
    else if (type === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = pix[s]; rgba[d + 3] = 255; }
    else if (type === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = pix[s]; rgba[d + 3] = pix[s + 1]; }
    else { const k = pix[s]; rgba[d] = palette[k * 3]; rgba[d + 1] = palette[k * 3 + 1]; rgba[d + 2] = palette[k * 3 + 2]; rgba[d + 3] = trns && k < trns.length ? trns[k] : 255; }
  }
  return {width, height, rgba};
}

export function lab([r, g, b]) {
  const ch = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const R = ch(r), G = ch(g), B = ch(b);
  const x = (0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047, y = 0.2126 * R + 0.7152 * G + 0.0722 * B, z = (0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883;
  const f = t => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))].map(v => Math.round(v));
}
export const hexRgb = hex => /^#?[0-9a-f]{6}$/i.test(String(hex || '')) ? [0, 2, 4].map(i => parseInt(String(hex).replace('#', '').slice(i, i + 2), 16)) : null;

// The design's colors as two small samples of CIELAB values: every opaque pixel (body) and the opaque pixels next to
// transparency (edge). Artwork without transparency gives null: there is nothing to tell design from background.
export function summarize({width, height, rgba}, max = {body: 900, edge: 450}) {
  const body = [], edge = []; let opaque = 0;
  const alpha = (x, y) => (x < 0 || y < 0 || x >= width || y >= height) ? 0 : rgba[(y * width + x) * 4 + 3];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (alpha(x, y) < 128) continue;
    opaque++;
    const k = (y * width + x) * 4, value = [rgba[k], rgba[k + 1], rgba[k + 2]];
    body.push(value);
    if (alpha(x + 1, y) < 128 || alpha(x - 1, y) < 128 || alpha(x, y + 1) < 128 || alpha(x, y - 1) < 128) edge.push(value);
  }
  if (!opaque || opaque === width * height) return null;
  const thin = (list, n) => { const step = Math.max(1, list.length / n); const out = []; for (let i = 0; i < list.length && out.length < n; i += step) out.push(lab(list[Math.floor(i)])); return out; };
  return {body: thin(body, max.body), edge: thin(edge, max.edge)};
}

// Share of the design (body, edge) that stands out on a garment color.
export function visibility(summary, hex) {
  const rgb = hexRgb(hex);
  if (!summary || !rgb) return null;
  const g = lab(rgb);
  const share = list => list.length ? list.filter(p => Math.hypot(p[0] - g[0], p[1] - g[1], p[2] - g[2]) >= DISTANCE).length / list.length : 1;
  return {body: share(summary.body), edge: share(summary.edge)};
}
export function blendsIn(summary, hex) {
  const v = visibility(summary, hex);
  return Boolean(v) && v.body < BODY_MIN && v.edge < EDGE_MIN;
}
