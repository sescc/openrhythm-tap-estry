// js/story/styles/crayon.js
// Crayon / kids'-drawing style: shapes are "coloured in" with many short
// waxy scribble strokes (clipped to the shape, leaving little gaps of
// visible paper like real crayon coverage), then outlined with a thick,
// wobbly hand-drawn line. Bright primary-leaning colours on visible paper.
//
// Fumble: a dense scribble scrawled over the hero (as if crossed out) plus
// a broken crayon streak - two segments of a thick colour streak with a
// gap, and two little crayon-stub rectangles tumbling at the break.

import { heroParts, scPts } from './parts.js';
import { resolvePalette, composeScene } from './scene.js';
import { rgbToCss, darkenRgb, lightenRgb, roughPolygon, ellipsePoints, propPoints, paperGrainPattern } from './geom.js';

const SILHOUETTE_RGB = { r: 26, g: 22, b: 26 };

function tracePts(ctx, points) {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  ctx.closePath();
}
function bbox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/** Many short overlapping strokes at VARIED random angles and pressure
 * (opacity), clipped to the shape - but the stroke COUNT is derived from
 * the shape's own area (a Poisson coverage model: n = -ln(1-coverage) *
 * boxArea / strokeArea) so a big sky/ground area gets proportionally more
 * strokes than a small hero part instead of a fixed count that reads as
 * sparse "confetti" on anything bigger than a thumbnail. `coverage` (0-1)
 * is the target fraction of the area that ends up stroked at least once -
 * kid's crayon fill is dense (0.7-0.9), not a scatter of dashes, while
 * still leaving the paper's own texture showing through inside the fill
 * via per-stroke pressure (alpha) variation, not via empty gaps. */
function crayonFill(ctx, rng, points, colorRgb, coverage = 0.8, maxStrokes = 260) {
  const box = bbox(points);
  ctx.save();
  tracePts(ctx, points);
  ctx.clip();
  const minDim = Math.min(box.w, box.h);
  const strokeLen = Math.max(10, minDim * 0.42);
  const strokeW = Math.max(1.6, minDim * 0.055);
  const strokeArea = strokeLen * strokeW * 0.8; // avg over length/angle jitter
  const boxArea = Math.max(1, box.w * box.h);
  const n = Math.min(maxStrokes, Math.max(10, Math.round((-Math.log(1 - Math.min(0.95, coverage)) * boxArea) / strokeArea)));
  const lighter = lightenRgb(colorRgb, 0.18);
  for (let i = 0; i < n; i++) {
    const cx = box.x + rng.next() * box.w;
    const cy = box.y + rng.next() * box.h;
    const angle = rng.next() * Math.PI * 2;
    const len = strokeLen * (0.6 + rng.next() * 0.7);
    const pressure = 0.3 + rng.next() * 0.5; // uneven pressure - still opaque enough to read as filled
    const w = Math.max(1.4, strokeW * (0.7 + rng.next() * 0.6));
    const dx = (Math.cos(angle) * len) / 2;
    const dy = (Math.sin(angle) * len) / 2;
    ctx.strokeStyle = rgbToCss(rng.chance(0.65) ? colorRgb : lighter, pressure);
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - dx, cy - dy);
    ctx.lineTo(cx + dx, cy + dy);
    ctx.stroke();
  }
  ctx.restore();
}

/** A wobbly outline drawn TWICE with independent jitter (a kid's crayon
 * always goes back over the line, slightly off the first pass). */
function crayonOutline(ctx, rng, points, colorRgb, widthFrac) {
  const box = bbox(points);
  const dark = darkenRgb(colorRgb, 0.35);
  for (let pass = 0; pass < 2; pass++) {
    const jittered = roughPolygon(rng, points, 2, 0.06 + pass * 0.045);
    tracePts(ctx, jittered);
    ctx.strokeStyle = rgbToCss(dark, pass === 0 ? 0.85 : 0.45);
    ctx.lineWidth = Math.max(1.6, box.w * widthFrac * (pass === 0 ? 1 : 0.65));
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

function drawPart(ctx, rng, part, s, colors) {
  const color = colors[part.colorSlot] || colors.hero;
  if (part.shape === 'ellipse') {
    const pts = ellipsePoints(part.cx * s, part.cy * s, part.rx * s, part.ry * s, 10, part.rot || 0);
    crayonFill(ctx, rng, pts, color, 0.88, 140);
    crayonOutline(ctx, rng, pts, color, 0.032);
  } else if (part.shape === 'polygon') {
    const pts = scPts(part.points, s);
    crayonFill(ctx, rng, pts, color, 0.85, 120);
    crayonOutline(ctx, rng, pts, color, 0.04);
  } else if (part.shape === 'dot') {
    ctx.beginPath();
    ctx.arc(part.cx * s, part.cy * s, part.r * s, 0, Math.PI * 2);
    ctx.fillStyle = rgbToCss(colors.ink, 0.85);
    ctx.fill();
  } else {
    const pts = part.shape === 'arc'
      ? Array.from({ length: 10 }, (_, i) => {
          const a = part.a0 + ((part.a1 - part.a0) * i) / 9;
          return [part.cx * s + Math.cos(a) * part.r * s, part.cy * s + Math.sin(a) * part.r * s];
        })
      : scPts(part.ops || [], s);
    ctx.strokeStyle = rgbToCss(color, 0.8);
    ctx.lineWidth = Math.max(2, s * (part.widthFactor ?? 0.02) * 1.6);
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
  }
}

function drawSilhouettePart(ctx, rng, part, s) {
  if (part.shape === 'dot') return;
  if (part.shape === 'ellipse') {
    const pts = ellipsePoints(part.cx * s, part.cy * s, part.rx * s, part.ry * s, 10, part.rot || 0);
    crayonFill(ctx, rng, pts, SILHOUETTE_RGB, 0.88, 140);
    crayonOutline(ctx, rng, pts, SILHOUETTE_RGB, 0.032);
  } else if (part.shape === 'polygon') {
    const pts = scPts(part.points, s);
    crayonFill(ctx, rng, pts, SILHOUETTE_RGB, 0.85, 120);
    crayonOutline(ctx, rng, pts, SILHOUETTE_RGB, 0.04);
  } else {
    const pts = part.shape === 'arc'
      ? Array.from({ length: 10 }, (_, i) => {
          const a = part.a0 + ((part.a1 - part.a0) * i) / 9;
          return [part.cx * s + Math.cos(a) * part.r * s, part.cy * s + Math.sin(a) * part.r * s];
        })
      : scPts(part.ops || [], s);
    ctx.strokeStyle = rgbToCss(SILHOUETTE_RGB, 0.85);
    ctx.lineWidth = Math.max(2, s * (part.widthFactor ?? 0.02) * 1.6);
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
  }
}

/** Draw one composed environment-layer shape in the crayon technique - a
 * dense fill (every layer reads as a solid coloured region, not scattered
 * dashes) plus a thick wobbly outline so hills/tree-clumps/buildings/etc
 * all get the same hand-drawn edge the hero gets. */
function drawLayerShape(ctx, rng, shape, lowEnd) {
  const maxStrokes = lowEnd ? 150 : 260;
  if (shape.shape === 'polygon') {
    crayonFill(ctx, rng, shape.points, shape.color, 0.82, maxStrokes);
    crayonOutline(ctx, rng, shape.points, shape.color, 0.012);
  } else if (shape.shape === 'ellipse') {
    const pts = ellipsePoints(shape.cx, shape.cy, shape.rx, shape.ry, 12);
    crayonFill(ctx, rng, pts, shape.color, 0.82, maxStrokes);
    crayonOutline(ctx, rng, pts, shape.color, 0.02);
  } else if (shape.shape === 'path') {
    ctx.save();
    ctx.strokeStyle = rgbToCss(darkenRgb(shape.color, 0.25), 0.75);
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    shape.ops.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
    ctx.restore();
  }
}

function drawWeather(ctx, weather, width, height) {
  if (weather.kind === 'rain') {
    ctx.save();
    ctx.strokeStyle = 'rgba(100,120,170,0.55)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (const l of weather.lines) { ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.stroke(); }
    ctx.restore();
  } else if (weather.kind === 'snow') {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const d of weather.dots) { ctx.beginPath(); ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  } else if (weather.kind === 'fog') {
    ctx.save();
    for (const b of weather.bands) { ctx.fillStyle = 'rgba(255,253,245,0.5)'; ctx.fillRect(0, b.y, width, b.h); }
    ctx.restore();
  }
}

function paintScribbleOver(ctx, rng, heroCx, heroCy, heroSize) {
  ctx.save();
  ctx.strokeStyle = 'rgba(40,35,35,0.75)';
  ctx.lineWidth = Math.max(3, heroSize * 0.045);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  let x = heroCx - heroSize * 0.55;
  let y = heroCy - heroSize * 0.35;
  ctx.moveTo(x, y);
  for (let i = 0; i < 10; i++) {
    x = heroCx + (rng.next() * 2 - 1) * heroSize * 0.6;
    y = heroCy + (rng.next() * 2 - 1) * heroSize * 0.5;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function paintBrokenStreak(ctx, rng, width, height, colorRgb) {
  const angle = ((rng.next() * 30 - 15) * Math.PI) / 180;
  const cx = width * (0.3 + rng.next() * 0.4);
  const cy = height * (0.35 + rng.next() * 0.3);
  const len = width * 0.5;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const gap = width * 0.05;
  const w = Math.max(4, width * 0.02);
  ctx.save();
  ctx.strokeStyle = rgbToCss(colorRgb, 0.8);
  ctx.lineWidth = w;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - dx * len * 0.5, cy - dy * len * 0.5);
  ctx.lineTo(cx - dx * gap * 0.5, cy - dy * gap * 0.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx + dx * gap * 0.5, cy + dy * gap * 0.5);
  ctx.lineTo(cx + dx * len * 0.5, cy + dy * len * 0.5);
  ctx.stroke();
  // Two little broken crayon-stub rectangles tumbling at the break.
  const nx = -dy, ny = dx;
  ctx.translate(cx, cy);
  ctx.rotate(angle + 0.5);
  ctx.fillStyle = rgbToCss(colorRgb, 0.95);
  ctx.fillRect(-w * 1.2, -w * 0.5, w * 1.4, w);
  ctx.rotate(-1.1);
  ctx.fillRect(w * 0.3, w * 0.3, w * 1.2, w * 0.9);
  ctx.restore();
}

function render(scene, rng, opts, fumbled) {
  const width = opts.width || 640;
  const height = opts.height || 480;
  const dpr = Math.min(2, opts.dpr || 1);
  const lowEnd = !!opts.lowEnd;
  const maxStrokes = lowEnd ? 170 : 300;
  const colors = resolvePalette(scene, 0);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#fffdf5';
  ctx.fillRect(0, 0, width, height);

  const comp = composeScene(scene, rng, width, height, colors, { fumbled, lowEnd: opts.lowEnd });
  const { horizonY, sky, celestial, hero, prop, weatherParticles } = comp;

  // Sky: a dense scribbled fill that stops a little short of the top/side
  // edges (kids rarely colour flush to the paper's border) rather than a
  // hard edge-to-edge rectangle.
  const skyMargin = Math.min(width, height) * 0.025;
  crayonFill(
    ctx, rng,
    [[skyMargin, skyMargin], [width - skyMargin, skyMargin], [width - skyMargin, horizonY], [skyMargin, horizonY]],
    sky.top, 0.8, maxStrokes
  );

  const bodyColor = celestial.kind === 'moon' ? lightenRgb(colors.accent, 0.3) : colors.accent;
  const sunPts = ellipsePoints(celestial.cx, celestial.cy, celestial.r, celestial.r, 14);
  crayonFill(ctx, rng, sunPts, bodyColor, 0.85, 90);
  crayonOutline(ctx, rng, sunPts, bodyColor, (0.15 * celestial.r) / width);

  // Parallax environment layers (far -> mid -> near) - these carry the
  // ground/hills/sea/etc. fill, each a dense filled region with its own
  // wobbly outline (drawLayerShape), so nothing between the sky and the
  // hero is left as bare white paper.
  for (const group of comp.layers) {
    for (const shape of group.shapes) drawLayerShape(ctx, rng, shape, lowEnd);
  }

  drawWeather(ctx, weatherParticles, width, height);

  if (prop) {
    const pts = propPoints(prop.type, prop.cx, prop.cy, prop.size);
    if (pts) {
      crayonFill(ctx, rng, pts, colors.accentDark, 0.85, 100);
      crayonOutline(ctx, rng, pts, colors.accentDark, 0.03);
    }
  }

  ctx.save();
  ctx.translate(hero.cx, hero.cy);
  ctx.rotate(hero.poseRot);
  ctx.scale(hero.facing, 1);
  for (const part of heroParts(scene.heroType)) {
    if (hero.silhouette) drawSilhouettePart(ctx, rng, part, hero.size);
    else drawPart(ctx, rng, part, hero.size, colors);
  }
  ctx.restore();

  if (fumbled) {
    paintScribbleOver(ctx, rng, hero.cx, hero.cy, hero.size);
    paintBrokenStreak(ctx, rng, width, height, colors.hero);
  }

  const pattern = paperGrainPattern(ctx);
  if (pattern) {
    ctx.save();
    ctx.globalAlpha = 0.18;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  return canvas;
}

export function renderScene(scene, rng, opts = {}) {
  return render(scene, rng, opts, false);
}
export function renderFumbled(scene, rng, opts = {}) {
  return render(scene, rng, opts, true);
}

export default { id: 'crayon', name: 'Crayon', cost: 2, renderScene, renderFumbled };
