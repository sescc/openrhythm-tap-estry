// js/story/styles/pixel.js
// Pixel art style: the ENTIRE scene is composed and drawn at a genuinely
// low internal resolution (320x~230 normal, 192x~138 low-end - up from
// 112x81/80x58), quantized to a 26-colour palette organised as RAMPS (3-6
// shades per base hue) with an ordered (Bayer 4x4) dither pass, then
// upscaled to the final size with image smoothing OFF so every internal
// pixel is a crisp square block. The higher resolution + ramps is what
// lets this read as "pixelated yet painterly": shaded hero volumes (a lit
// side toward the sun/moon and a shadow side away from it, via a canvas
// gradient the dither pass turns into stepped shade bands), a rim-light
// highlight on the sun-facing edge, a soft ambient-occlusion shadow under
// the hero's feet, actual cloud/star shapes, water reflections, and
// textured/foliage ground - on top of the existing 1px outline convention.
//
// COST: quantize() used to be an O(paletteSize) nearest-colour search per
// pixel. It's now a 15-bit RGB lookup table (32768-entry Uint8Array, 5 bits
// per channel) built ONCE per distinct palette and cached across panels of
// the same story (the palette only changes with scene.paletteIdx/mood), so
// per-pixel cost is a single array read regardless of resolution or
// palette size. See CLAUDE.md for the before/after timing.
//
// Fumble: glitch row-shift (bands of the upscaled image slip sideways), a
// palette-shift colour-wash band, and scattered "dead pixel" blocks.

import { heroParts, scPts } from './parts.js';
import { resolvePalette, composeScene } from './scene.js';
import { rgbToCss, darkenRgb, lightenRgb, ellipsePoints, propPoints } from './geom.js';

const BAYER4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// --- ramp palette ----------------------------------------------------------

/** `offsets`: negative = darken by |o|, positive = lighten by o, 0 = base
 * colour unchanged. Ordered dark -> light. */
function rampOf(base, offsets) {
  return offsets.map((o) => (o < 0 ? darkenRgb(base, -o) : o > 0 ? lightenRgb(base, o) : { ...base }));
}

/** 4 + 6 + 5 + 5 + 3 + 3 = 26 colours, well inside the 24-32 budget. */
function buildRamps(colors) {
  return {
    sky: rampOf(colors.sky, [-0.5, -0.15, 0.2, 0.55]),
    ground: rampOf(colors.ground, [-0.55, -0.32, -0.12, 0, 0.18, 0.4]),
    accent: rampOf(colors.accent, [-0.3, 0, 0.25, 0.5, 0.78]),
    hero: rampOf(colors.hero, [-0.48, -0.2, 0, 0.22, 0.45]),
    ink: rampOf(colors.ink, [-0.1, 0, 0.4]),
    paper: [{ r: 255, g: 255, b: 255 }, { r: 247, g: 242, b: 230 }, { r: 228, g: 224, b: 210 }],
  };
}
function flattenRamps(ramps) {
  return [...ramps.sky, ...ramps.ground, ...ramps.accent, ...ramps.hero, ...ramps.ink, ...ramps.paper];
}

// --- LUT-based quantize (the cost fix) --------------------------------------

/** 5 bits/channel = 32768 buckets. Built once per distinct palette and
 * cached (module-level, single slot) across the many panels of one story,
 * which almost always share the same palette (same `paletteIdx`/`mood`). */
let lutCache = { key: null, lut: null };
function getQuantizeLUT(key, flatPalette) {
  if (lutCache.key === key) return lutCache.lut;
  const lut = buildQuantizeLUT(flatPalette);
  lutCache = { key, lut };
  return lut;
}
function buildQuantizeLUT(palette) {
  const n = palette.length;
  const pr = new Float64Array(n);
  const pg = new Float64Array(n);
  const pb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    pr[i] = palette[i].r; pg[i] = palette[i].g; pb[i] = palette[i].b;
  }
  const lut = new Uint8Array(32768 * 3);
  let o = 0;
  for (let r5 = 0; r5 < 32; r5++) {
    const r = r5 * 8 + 4;
    for (let g5 = 0; g5 < 32; g5++) {
      const g = g5 * 8 + 4;
      for (let b5 = 0; b5 < 32; b5++) {
        const b = b5 * 8 + 4;
        let best = 0;
        let bestDist = Infinity;
        for (let i = 0; i < n; i++) {
          const dr = pr[i] - r;
          const dg = pg[i] - g;
          const db = pb[i] - b;
          const d = dr * dr + dg * dg + db * db;
          if (d < bestDist) { bestDist = d; best = i; }
        }
        lut[o] = pr[best]; lut[o + 1] = pg[best]; lut[o + 2] = pb[best];
        o += 3;
      }
    }
  }
  return lut;
}

/** Ordered-dither the whole internal canvas (nudge every pixel toward a
 * neighbour shade by a Bayer threshold) THEN snap to the nearest palette
 * colour via one LUT read - this is what makes gradients (sky, and now the
 * hero's own shaded fill) come out with genuine dither speckle/stepped
 * bands instead of a smooth blend the quantize step would otherwise crush
 * to a single flat shade. */
function ditherAndQuantize(ctx, w, h, lut) {
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;
  for (let y = 0; y < h; y++) {
    const row = BAYER4[y & 3];
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const thresh = (row[x & 3] - 7.5) * 2.6; // roughly -19..+19
      let r = data[idx] + thresh;
      let g = data[idx + 1] + thresh;
      let b = data[idx + 2] + thresh;
      r = r < 0 ? 0 : r > 255 ? 255 : r;
      g = g < 0 ? 0 : g > 255 ? 255 : g;
      b = b < 0 ? 0 : b > 255 ? 255 : b;
      const lutIdx = (((r >> 3) * 32 + (g >> 3)) * 32 + (b >> 3)) * 3;
      data[idx] = lut[lutIdx]; data[idx + 1] = lut[lutIdx + 1]; data[idx + 2] = lut[lutIdx + 2]; data[idx + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
}

// --- drawing helpers ---------------------------------------------------------

function tracePts(ctx, points) {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  ctx.closePath();
}
function fillPoly(ctx, points, colorRgb) {
  tracePts(ctx, points);
  ctx.fillStyle = rgbToCss(colorRgb, 1);
  ctx.fill();
  return points;
}
function fillPolyStyle(ctx, points, style) {
  tracePts(ctx, points);
  ctx.fillStyle = style;
  ctx.fill();
}
function outlinePart(ctx, points, inkRgb) {
  tracePts(ctx, points);
  ctx.strokeStyle = rgbToCss(inkRgb, 0.9);
  ctx.lineWidth = 1;
  ctx.stroke();
}
function bboxOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/** A flat fill for small/secondary parts, or a shadow->highlight linear
 * gradient spanning the FULL ramp (its darkest to its lightest shade) for
 * the hero's big "volumetric" parts (body/head/hull/shell), oriented
 * toward `lightDir` - the dither+LUT pass then turns that smooth gradient
 * into genuine stepped shade bands, giving a lit side and a shadow side
 * without any per-pixel lighting math. A 3-stop gradient using only the
 * ramp steps adjacent to `mid` (the flat parts' own shade) was tried first
 * and was too subtle to read at hero size - the "mid" plateau dominated
 * most of the shape's area, so this spans the ramp's full dark/light
 * extremes with just 2 stops instead. */
function shadedFillStyle(ctx, points, ramp, mid, volumetric, lightDir) {
  if (!volumetric) return rgbToCss(ramp[mid]);
  const bb = bboxOf(points);
  const litX = lightDir.x >= 0 ? bb.maxX : bb.minX;
  const litY = lightDir.y >= 0 ? bb.maxY : bb.minY;
  const shadowX = lightDir.x >= 0 ? bb.minX : bb.maxX;
  const shadowY = lightDir.y >= 0 ? bb.minY : bb.maxY;
  const grad = ctx.createLinearGradient(shadowX, shadowY, litX, litY);
  grad.addColorStop(0, rgbToCss(ramp[0]));
  grad.addColorStop(1, rgbToCss(ramp[ramp.length - 1]));
  return grad;
}

/** A short bright highlight on the edge point closest to the light source -
 * a rim-lit pixel-art convention - instead of the old fixed "always upper
 * left" assumption. */
function rimHighlight(ctx, points, rimRgb, lightDir) {
  let bestI = 0;
  let bestScore = -Infinity;
  points.forEach((p, i) => {
    const score = p[0] * lightDir.x + p[1] * lightDir.y;
    if (score > bestScore) { bestScore = score; bestI = i; }
  });
  const a = points[(bestI - 1 + points.length) % points.length];
  const b = points[bestI];
  const c = points[(bestI + 1) % points.length];
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.lineTo(c[0], c[1]);
  ctx.strokeStyle = rgbToCss(rimRgb, 0.95);
  ctx.lineWidth = 1;
  ctx.stroke();
}

const VOLUMETRIC_ROLES = new Set(['body', 'head', 'hull', 'shell']);
function slotRamp(slot, ramps) {
  switch (slot) {
    case 'hero': return { arr: ramps.hero, mid: 2 };
    case 'heroDark': return { arr: ramps.hero, mid: 1 };
    case 'accent': return { arr: ramps.accent, mid: 1 };
    case 'accentDark': return { arr: ramps.accent, mid: 0 };
    case 'accentLight': return { arr: ramps.accent, mid: 3 };
    case 'ink': return { arr: ramps.ink, mid: 0 };
    default: return { arr: ramps.hero, mid: 2 };
  }
}

function drawPart(ctx, part, s, ramps, silhouette, lightDir) {
  if (silhouette) {
    if (part.shape === 'ellipse') fillPoly(ctx, ellipsePoints(part.cx * s, part.cy * s, part.rx * s, part.ry * s, 10, part.rot || 0), ramps.ink[0]);
    else if (part.shape === 'polygon') fillPoly(ctx, scPts(part.points, s), ramps.ink[0]);
    return;
  }
  const { arr, mid } = slotRamp(part.colorSlot, ramps);
  const volumetric = VOLUMETRIC_ROLES.has(part.role);
  if (part.shape === 'ellipse' || part.shape === 'polygon') {
    const pts = part.shape === 'ellipse'
      ? ellipsePoints(part.cx * s, part.cy * s, part.rx * s, part.ry * s, 10, part.rot || 0)
      : scPts(part.points, s);
    fillPolyStyle(ctx, pts, shadedFillStyle(ctx, pts, arr, mid, volumetric, lightDir));
    outlinePart(ctx, pts, ramps.ink[0]);
    if (volumetric) rimHighlight(ctx, pts, ramps.hero[4], lightDir);
  } else if (part.shape === 'dot') {
    const x = part.cx * s;
    const y = part.cy * s;
    const r = part.r * s;
    ctx.fillStyle = rgbToCss(ramps.ink[0]);
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
    // A tiny glint - a single highlight pixel - a common pixel-art eye trick.
    ctx.fillStyle = rgbToCss(ramps.paper[0]);
    ctx.fillRect(x - r * 0.3, y - r * 0.9, Math.max(1, r * 0.5), Math.max(1, r * 0.5));
  } else {
    const pts = part.shape === 'arc'
      ? Array.from({ length: 8 }, (_, i) => {
          const a = part.a0 + ((part.a1 - part.a0) * i) / 7;
          return [part.cx * s + Math.cos(a) * part.r * s, part.cy * s + Math.sin(a) * part.r * s];
        })
      : scPts(part.ops || [], s);
    ctx.strokeStyle = rgbToCss(arr[mid]);
    ctx.lineWidth = Math.max(1, s * (part.widthFactor ?? 0.02));
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
  }
}

function drawLayerShape(ctx, shape, ramps) {
  if (shape.shape === 'polygon') fillPoly(ctx, shape.points, shape.color);
  else if (shape.shape === 'ellipse') fillPoly(ctx, ellipsePoints(shape.cx, shape.cy, shape.rx, shape.ry, 10), shape.color);
  else if (shape.shape === 'path') {
    ctx.strokeStyle = rgbToCss(shape.color, 1);
    ctx.lineWidth = 1;
    ctx.beginPath();
    shape.ops.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
  }
  void ramps; // (layer shapes already carry a resolved colour; ramps unused here)
}

/** A two-tone checker ground tile PLUS scattered foliage/dirt speckle - a
 * textured tile floor instead of a flat colour, now affordable at the
 * higher resolution. */
function texturedGround(ctx, rng, w, h, horizonY, ramps, envType) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, horizonY, w, h - horizonY);
  ctx.clip();
  const tile = 4;
  const shadeA = ramps.ground[3];
  const shadeB = ramps.ground[2];
  for (let y = Math.floor(horizonY / tile) * tile; y < h; y += tile) {
    for (let x = 0; x < w; x += tile) {
      const checker = (Math.round(x / tile) + Math.round(y / tile)) % 2 === 0;
      ctx.fillStyle = rgbToCss(checker ? shadeA : shadeB, 0.55);
      ctx.fillRect(x, y, tile, tile);
    }
  }
  if (envType === 'forest' || envType === 'hills' || envType === 'path') {
    const count = Math.round((w * (h - horizonY)) / 900);
    ctx.fillStyle = rgbToCss(ramps.ground[1]);
    for (let i = 0; i < count; i++) {
      const x = Math.floor(rng.next() * w);
      const y = Math.floor(horizonY + rng.next() * (h - horizonY) * 0.9);
      ctx.fillRect(x, y, 2, 2);
    }
  }
  ctx.restore();
}

/** Short vertical light-streak reflections on water. */
function waterReflection(ctx, rng, w, h, horizonY, ramps) {
  ctx.strokeStyle = rgbToCss(ramps.sky[3], 0.5);
  ctx.lineWidth = 1;
  const n = 7;
  for (let i = 0; i < n; i++) {
    const x = Math.floor(rng.next() * w);
    const y0 = horizonY + rng.next() * 3;
    const len = 5 + rng.next() * 12;
    ctx.beginPath();
    ctx.moveTo(x, y0);
    ctx.lineTo(x, Math.min(h, y0 + len));
    ctx.stroke();
  }
}

/** Actual cloud shapes (a small cluster of overlapping circles) instead of
 * nothing, and star SHAPES (a 5-pixel sparkle) instead of 1px dots. */
function drawClouds(ctx, rng, w, horizonY, ramps, count) {
  ctx.fillStyle = rgbToCss(ramps.paper[1], 0.92);
  for (let i = 0; i < count; i++) {
    const cx = rng.next() * w;
    const cy = rng.next() * horizonY * 0.55;
    const s = 4 + rng.next() * 5;
    for (const [ox, oy, r] of [[0, 0, s], [s * 0.85, s * 0.15, s * 0.68], [-s * 0.8, s * 0.12, s * 0.6]]) {
      ctx.beginPath();
      ctx.arc(cx + ox, cy + oy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
function drawStars(ctx, stars, ramps) {
  for (const st of stars) {
    const x = Math.round(st.cx);
    const y = Math.round(st.cy);
    ctx.fillStyle = rgbToCss(ramps.paper[2], 0.75);
    ctx.fillRect(x - 1, y, 1, 1);
    ctx.fillRect(x + 1, y, 1, 1);
    ctx.fillRect(x, y - 1, 1, 1);
    ctx.fillRect(x, y + 1, 1, 1);
    ctx.fillStyle = rgbToCss(ramps.paper[0]);
    ctx.fillRect(x, y, 1, 1);
  }
}

/** A two-tone sun/moon disc (dimmer halo ring, brighter core) instead of a
 * flat circle. */
function drawCelestial(ctx, celestial, ramps) {
  const isMoon = celestial.kind === 'moon';
  const halo = isMoon ? ramps.paper[2] : ramps.accent[2];
  const core = isMoon ? ramps.paper[1] : ramps.accent[4];
  ctx.fillStyle = rgbToCss(halo);
  ctx.beginPath();
  ctx.arc(celestial.cx, celestial.cy, celestial.r * 1.12, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = rgbToCss(core);
  ctx.beginPath();
  ctx.arc(celestial.cx, celestial.cy, celestial.r * 0.82, 0, Math.PI * 2);
  ctx.fill();
}

/** A soft ambient-occlusion shadow under the hero's feet, drawn BEFORE the
 * hero so it reads as ground contact shading, not a floating cutout. */
function drawGroundAO(ctx, hero, ramps) {
  ctx.save();
  ctx.globalAlpha = 0.4;
  ctx.fillStyle = rgbToCss(ramps.ground[0]);
  ctx.beginPath();
  ctx.ellipse(hero.cx, hero.cy + hero.size * 0.3, hero.size * 0.42, hero.size * 0.11, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawWeather(ctx, weather, w, h) {
  if (weather.kind === 'rain') {
    ctx.strokeStyle = 'rgba(200,210,230,0.8)';
    ctx.lineWidth = 1;
    for (const l of weather.lines) { ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.stroke(); }
  } else if (weather.kind === 'snow') {
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const d of weather.dots) ctx.fillRect(d.cx, d.cy, 1, 1);
  } else if (weather.kind === 'fog') {
    ctx.fillStyle = 'rgba(230,230,230,0.35)';
    for (const b of weather.bands) ctx.fillRect(0, b.y, w, b.h);
  }
}

function glitchRows(ctx, rng, w, h, blockH) {
  const bands = 3 + Math.floor(rng.next() * 3);
  for (let i = 0; i < bands; i++) {
    const rowBlock = Math.floor(rng.next() * Math.max(1, h / blockH));
    const y = Math.min(h - blockH, rowBlock * blockH);
    const bandH = Math.min(h - y, blockH * (1 + Math.floor(rng.next() * 2)));
    const shift = (Math.floor(rng.next() * 7) - 3) * blockH;
    if (!shift || bandH <= 0) continue;
    ctx.drawImage(ctx.canvas, 0, y, w, bandH, shift, y, w, bandH);
    ctx.fillStyle = 'rgba(15,10,10,0.18)';
    if (shift > 0) ctx.fillRect(0, y, shift, bandH);
    else ctx.fillRect(w + shift, y, -shift, bandH);
  }
}

function deadPixels(ctx, rng, w, h, blockW, blockH) {
  const n = 10 + Math.floor(rng.next() * 14);
  for (let i = 0; i < n; i++) {
    const bx = Math.floor(rng.next() * (w / blockW)) * blockW;
    const by = Math.floor(rng.next() * (h / blockH)) * blockH;
    ctx.fillStyle = rng.chance(0.5) ? '#050505' : '#ff29d6';
    ctx.fillRect(bx, by, blockW, blockH);
  }
}

function paletteShiftBand(ctx, rng, w, h) {
  ctx.save();
  ctx.globalCompositeOperation = 'color';
  ctx.fillStyle = rng.chance(0.5) ? 'rgba(255,0,160,0.4)' : 'rgba(0,255,180,0.35)';
  const y = h * (0.15 + rng.next() * 0.35);
  const bh = h * (0.15 + rng.next() * 0.2);
  ctx.fillRect(0, y, w, bh);
  ctx.restore();
}

function render(scene, rng, opts, fumbled) {
  const width = opts.width || 640;
  const height = opts.height || 480;
  const dpr = Math.min(2, opts.dpr || 1);
  const finalW = Math.max(1, Math.round(width * dpr));
  const finalH = Math.max(1, Math.round(height * dpr));

  // Genuinely low internal resolution, but with real room for scene detail:
  // 320x~230 normal (~8x the pixel count of the old 112x81), 192x~138
  // low-end (~3x the old 80x58) - still unmistakably pixel art at panel
  // size, per the user's "paper boat level" favourite.
  const internalW = opts.lowEnd ? 192 : 320;
  const internalH = Math.max(1, Math.round(internalW * (height / width)));

  const small = document.createElement('canvas');
  small.width = internalW;
  small.height = internalH;
  // willReadFrequently: this canvas gets a getImageData()/putImageData()
  // round-trip on every render (the dither+quantize pass) - without this
  // hint the browser keeps it GPU-backed and getImageData forces a GPU->CPU
  // sync that dominates render time at the larger resolution (measured:
  // ~10-13ms just for getImageData at 320x230 without the hint, vs the
  // LUT-based quantize LOOP itself costing ~1.1ms). With the hint the
  // canvas stays CPU-backed, which getImageData needs no sync for.
  const sctx = small.getContext('2d', { willReadFrequently: true });

  const colors = resolvePalette(scene, 0);
  const ramps = buildRamps(colors);
  const flatPalette = flattenRamps(ramps);
  const lutKey = `${scene.paletteIdx}:${scene.mood || ''}`;
  const lut = getQuantizeLUT(lutKey, flatPalette);

  const comp = composeScene(scene, rng, internalW, internalH, colors, { fumbled, lowEnd: opts.lowEnd });
  const { horizonY, sky, celestial, stars, hero, prop, weatherParticles } = comp;

  sctx.fillStyle = rgbToCss(ramps.paper[1]);
  sctx.fillRect(0, 0, internalW, internalH);

  const skyGrad = sctx.createLinearGradient(0, 0, 0, Math.max(1, horizonY));
  skyGrad.addColorStop(0, rgbToCss(sky.top));
  skyGrad.addColorStop(1, rgbToCss(sky.bottom));
  sctx.fillStyle = skyGrad;
  sctx.fillRect(0, 0, internalW, Math.max(1, horizonY));

  if (stars.length) drawStars(sctx, stars, ramps);
  if (!stars.length && comp.weather === 'clear') drawClouds(sctx, rng, internalW, horizonY, ramps, 2 + Math.floor(rng.next() * 2));

  drawCelestial(sctx, celestial, ramps);

  for (const group of comp.layers) {
    for (const shape of group.shapes) drawLayerShape(sctx, shape, ramps);
  }
  texturedGround(sctx, rng, internalW, internalH, horizonY, ramps, comp.envType);
  if (comp.envType === 'sea') waterReflection(sctx, rng, internalW, internalH, horizonY, ramps);

  drawWeather(sctx, weatherParticles, internalW, internalH);

  if (prop) {
    const pts = propPoints(prop.type, prop.cx, prop.cy, prop.size);
    if (pts) fillPoly(sctx, pts, colors.accentDark);
  }

  drawGroundAO(sctx, hero, ramps);

  // Light direction (toward the sun/moon), rotated into the hero's own
  // local drawing space (undoing pose rotation + facing flip) so the
  // lit/shadow gradient and rim highlight stay correct however the hero is
  // posed - a purely decorative approximation, not physically exact.
  const dxL = celestial.cx - hero.cx;
  const dyL = celestial.cy - hero.cy;
  const lenL = Math.hypot(dxL, dyL) || 1;
  const cosR = Math.cos(-hero.poseRot);
  const sinR = Math.sin(-hero.poseRot);
  const lx0 = dxL / lenL;
  const ly0 = dyL / lenL;
  const lightDir = { x: (lx0 * cosR - ly0 * sinR) * hero.facing, y: lx0 * sinR + ly0 * cosR };

  sctx.save();
  sctx.translate(hero.cx, hero.cy);
  sctx.rotate(hero.poseRot);
  sctx.scale(hero.facing, 1);
  for (const part of heroParts(scene.heroType)) drawPart(sctx, part, hero.size, ramps, hero.silhouette, lightDir);
  sctx.restore();

  // Dither + quantize the whole internal frame to the ramp palette via the
  // LUT - this is what turns every gradient (sky, hero shading) into
  // genuine stepped/dithered pixel-art bands.
  ditherAndQuantize(sctx, internalW, internalH, lut);

  const canvas = document.createElement('canvas');
  canvas.width = finalW;
  canvas.height = finalH;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, finalW, finalH);

  if (fumbled) {
    const blockW = finalW / internalW;
    const blockH = finalH / internalH;
    glitchRows(ctx, rng, finalW, finalH, blockH);
    paletteShiftBand(ctx, rng, finalW, finalH);
    deadPixels(ctx, rng, finalW, finalH, blockW, blockH);
  }

  return canvas;
}

export function renderScene(scene, rng, opts = {}) {
  return render(scene, rng, opts, false);
}
export function renderFumbled(scene, rng, opts = {}) {
  return render(scene, rng, opts, true);
}

export default { id: 'pixel', name: 'Pixel art', cost: 2, renderScene, renderFumbled };
