// js/story/styles/ink.js
// Ink / line sketch style: pen outlines with a light hand-wobble, dense
// cross-hatching + stippling for shading, and exactly ONE accent colour
// (from the story palette) used boldly - on the sun/moon and the hero's
// main body - against off-white paper. Everything else stays black-ink
// linework.
//
// Fumble: broad grey smudge drags across the picture, plus an angry
// scribble scrawled directly over the hero.

import { heroParts, scPts } from './parts.js';
import { resolvePalette, composeScene } from './scene.js';
import { rgbToCss, lightenRgb, roughPolygon, ellipsePoints, propPoints, paperGrainPattern } from './geom.js';

const INK = 'rgba(30,26,24,';

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
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Parallel hatch lines clipped to `points`, at `angle` radians, `spacing`
 * apart, in `colorCss`. */
function hatchFill(ctx, points, angle, spacing, colorCss, lineWidth = 0.9) {
  const box = bbox(points);
  if (box.w <= 0 || box.h <= 0) return;
  ctx.save();
  tracePts(ctx, points);
  ctx.clip();
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const diag = Math.hypot(box.w, box.h) * 0.75 + spacing;
  const dx = Math.cos(angle);
  const dy = Math.sin(angle);
  const nx = -dy;
  const ny = dx;
  ctx.strokeStyle = colorCss;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (let d = -diag; d <= diag; d += spacing) {
    const ox = cx + nx * d;
    const oy = cy + ny * d;
    ctx.moveTo(ox - dx * diag, oy - dy * diag);
    ctx.lineTo(ox + dx * diag, oy + dy * diag);
  }
  ctx.stroke();
  ctx.restore();
}

/** Random stipple dots clipped to `points` - the pointillist shading a pen
 * sketch uses alongside (or instead of) hatch lines. */
function stipple(ctx, rng, points, count, colorCss, dotR = 0.7) {
  const box = bbox(points);
  if (box.w <= 0 || box.h <= 0) return;
  ctx.save();
  tracePts(ctx, points);
  ctx.clip();
  ctx.fillStyle = colorCss;
  for (let i = 0; i < count; i++) {
    const x = box.x + rng.next() * box.w;
    const y = box.y + rng.next() * box.h;
    ctx.beginPath();
    ctx.arc(x, y, dotR * (0.6 + rng.next() * 0.8), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function outlinePart(ctx, rng, points, opts) {
  const jittered = roughPolygon(rng, points, 2, 0.035);
  if (opts.fillCss) {
    tracePts(ctx, jittered);
    ctx.fillStyle = opts.fillCss;
    ctx.fill();
  }
  const hatchDensity = opts.hatchSpacing;
  if (hatchDensity) {
    const angleJitter = (rng.next() - 0.5) * 0.5;
    hatchFill(ctx, jittered, (opts.hatchAngle ?? 0.6) + angleJitter, hatchDensity, `${INK}${opts.hatchAlpha ?? 0.38})`);
    if (opts.crossHatch) hatchFill(ctx, jittered, (opts.hatchAngle ?? 0.6) + Math.PI / 2 + angleJitter, hatchDensity * (1.3 + rng.next() * 0.5), `${INK}${(opts.hatchAlpha ?? 0.38) * 0.75})`);
  }
  if (opts.stippleCount) stipple(ctx, rng, jittered, opts.stippleCount, `${INK}0.45)`);
  tracePts(ctx, jittered);
  ctx.strokeStyle = `${INK}0.9)`;
  ctx.lineWidth = opts.strokeWidth ?? 1.4;
  ctx.stroke();
}

function drawPart(ctx, rng, part, s, colors, layers, silhouette) {
  if (silhouette) {
    if (part.shape === 'dot') return;
    const pts = part.shape === 'ellipse'
      ? ellipsePoints(part.cx * s, part.cy * s, part.rx * s, part.ry * s, 12, part.rot || 0)
      : (part.shape === 'polygon' ? scPts(part.points, s) : null);
    if (pts) { tracePts(ctx, pts); ctx.fillStyle = `${INK}0.92)`; ctx.fill(); }
    return;
  }
  // The hero's main body/head get the bold accent wash AND a heavier
  // contour line; secondary parts (ears/tail/wing/etc.) stay pen-and-hatch.
  const isMain = part.role === 'body' || part.role === 'head';
  const accentCss = rgbToCss(colors.accent, isMain ? 0.55 : 0.15);
  const spacing = Math.max(2.2, s * (layers > 2 ? 0.032 : 0.05)) * (0.75 + rng.next() * 0.5);

  if (part.shape === 'ellipse') {
    outlinePart(ctx, rng, ellipsePoints(part.cx * s, part.cy * s, part.rx * s, part.ry * s, 12, part.rot || 0), {
      fillCss: accentCss, hatchSpacing: spacing, hatchAngle: 0.5 + (part.cx || 0), crossHatch: rng.chance(isMain ? 0.9 : 0.4),
      stippleCount: Math.round(s * s * 0.006), strokeWidth: isMain ? 2.1 : 1.3,
    });
  } else if (part.shape === 'polygon') {
    outlinePart(ctx, rng, scPts(part.points, s), {
      fillCss: isMain ? accentCss : (rng.chance(0.3) ? rgbToCss(colors.accent, 0.12) : null),
      hatchSpacing: spacing * 0.85, hatchAngle: -0.4, crossHatch: rng.chance(0.3),
      stippleCount: Math.round(s * s * 0.003), strokeWidth: isMain ? 1.8 : 1.2,
    });
  } else if (part.shape === 'dot') {
    ctx.beginPath();
    ctx.arc(part.cx * s, part.cy * s, part.r * s, 0, Math.PI * 2);
    ctx.fillStyle = `${INK}0.9)`;
    ctx.fill();
  } else {
    const pts = part.shape === 'arc'
      ? Array.from({ length: 10 }, (_, i) => {
          const a = part.a0 + ((part.a1 - part.a0) * i) / 9;
          return [part.cx * s + Math.cos(a) * part.r * s, part.cy * s + Math.sin(a) * part.r * s];
        })
      : (part.shape === 'spiral'
        ? Array.from({ length: (part.steps || 28) + 1 }, (_, t) => {
            const a = (t / (part.steps || 28)) * Math.PI * (part.turns || 2.6);
            const r = part.r * s * (1 - t / ((part.steps || 28) + 4));
            return [part.cx * s + Math.cos(a) * r, part.cy * s + Math.sin(a) * r];
          })
        : scPts(part.ops || [], s));
    ctx.strokeStyle = `${INK}0.8)`;
    ctx.lineWidth = Math.max(1, s * (part.widthFactor ?? 0.015) * 1.1);
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
  }
}

function drawLayerShape(ctx, rng, shape, dense) {
  if (shape.shape === 'polygon' || shape.shape === 'ellipse') {
    const pts = shape.shape === 'ellipse' ? ellipsePoints(shape.cx, shape.cy, shape.rx, shape.ry, 12) : shape.points;
    outlinePart(ctx, rng, pts, {
      hatchSpacing: Math.max(2.5, (bbox(pts).w || 20) * 0.05), hatchAngle: rng.next() * Math.PI,
      crossHatch: rng.chance(dense ? 0.6 : 0.25), stippleCount: rng.chance(0.4) ? Math.round((bbox(pts).w || 10) * 0.5) : 0,
      strokeWidth: 1,
    });
  } else if (shape.shape === 'path') {
    ctx.strokeStyle = `${INK}0.45)`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    shape.ops.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
  }
}

function drawWeather(ctx, weather, width, height) {
  if (weather.kind === 'rain') {
    ctx.strokeStyle = `${INK}0.4)`;
    ctx.lineWidth = 1;
    for (const l of weather.lines) { ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.stroke(); }
  } else if (weather.kind === 'snow') {
    ctx.fillStyle = `${INK}0.3)`;
    for (const d of weather.dots) { ctx.beginPath(); ctx.arc(d.cx, d.cy, d.r * 0.6, 0, Math.PI * 2); ctx.fill(); }
  } else if (weather.kind === 'fog') {
    ctx.fillStyle = 'rgba(250,246,236,0.55)';
    for (const b of weather.bands) ctx.fillRect(0, b.y, width, b.h);
  }
}

function paintSmudge(ctx, rng, width, height) {
  const cy = height * (0.3 + rng.next() * 0.4);
  const len = width * (0.6 + rng.next() * 0.3);
  const x0 = width * (0.5 - len / width / 2);
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  for (let i = 0; i < 6; i++) {
    ctx.fillStyle = `rgba(90,85,80,${(0.05 + rng.next() * 0.05).toFixed(2)})`;
    const yy = cy + (rng.next() - 0.5) * height * 0.12;
    const hh = height * (0.03 + rng.next() * 0.04);
    ctx.beginPath();
    ctx.ellipse(x0 + len / 2, yy, len / 2, hh, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function paintScribble(ctx, rng, heroCx, heroCy, heroSize) {
  ctx.save();
  ctx.strokeStyle = 'rgba(120,20,20,0.75)';
  ctx.lineWidth = Math.max(2, heroSize * 0.03);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const n = 14;
  let x = heroCx - heroSize * 0.5;
  let y = heroCy - heroSize * 0.3;
  ctx.moveTo(x, y);
  for (let i = 0; i < n; i++) {
    x = heroCx + (rng.next() * 2 - 1) * heroSize * 0.55;
    y = heroCy + (rng.next() * 2 - 1) * heroSize * 0.45;
    ctx.lineTo(x, y);
  }
  ctx.stroke();
  ctx.restore();
}

function render(scene, rng, opts, fumbled) {
  const width = opts.width || 640;
  const height = opts.height || 480;
  const dpr = Math.min(2, opts.dpr || 1);
  const layers = opts.layers || (opts.lowEnd ? 2 : 4);
  const colors = resolvePalette(scene, 0);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#faf6ec';
  ctx.fillRect(0, 0, width, height);

  const comp = composeScene(scene, rng, width, height, colors, { fumbled, lowEnd: opts.lowEnd });
  const { horizonY, celestial, stars, hero, prop, weatherParticles } = comp;

  // Sky: light hatch, denser near the horizon.
  const skySpacing = Math.max(4, width * (layers > 2 ? 0.018 : 0.03));
  for (let y = skySpacing; y < horizonY; y += skySpacing) {
    const t = y / Math.max(1, horizonY);
    ctx.strokeStyle = `${INK}${(0.06 + t * 0.18).toFixed(2)})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y - width * 0.02);
    ctx.stroke();
  }
  if (rng.chance(0.5)) stipple(ctx, rng, [[0, 0], [width, 0], [width, horizonY], [0, horizonY]], Math.round(width * horizonY * 0.0006), `${INK}0.15)`);
  ctx.strokeStyle = `${INK}0.75)`;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  ctx.lineTo(width, horizonY);
  ctx.stroke();

  if (stars.length) {
    ctx.fillStyle = `${INK}0.8)`;
    for (const st of stars) { ctx.beginPath(); ctx.arc(st.cx, st.cy, st.r * 0.8, 0, Math.PI * 2); ctx.fill(); }
  }

  // Sun/moon: the one bold accent colour, radiating hatch lines.
  const bodyColor = celestial.kind === 'moon' ? lightenRgb(colors.accent, 0.25) : colors.accent;
  ctx.beginPath();
  ctx.arc(celestial.cx, celestial.cy, celestial.r, 0, Math.PI * 2);
  ctx.fillStyle = rgbToCss(bodyColor, 0.6);
  ctx.fill();
  ctx.strokeStyle = rgbToCss(bodyColor, 0.9);
  ctx.lineWidth = 1.8;
  ctx.stroke();
  ctx.save();
  ctx.strokeStyle = rgbToCss(bodyColor, 0.55);
  ctx.lineWidth = 1.1;
  const rays = 12;
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(celestial.cx + Math.cos(a) * celestial.r * 1.25, celestial.cy + Math.sin(a) * celestial.r * 1.25);
    ctx.lineTo(celestial.cx + Math.cos(a) * celestial.r * 1.75, celestial.cy + Math.sin(a) * celestial.r * 1.75);
    ctx.stroke();
  }
  ctx.restore();

  // Parallax environment layers.
  const dense = layers > 2;
  for (const group of comp.layers) {
    for (const shape of group.shapes) drawLayerShape(ctx, rng, shape, dense);
  }

  drawWeather(ctx, weatherParticles, width, height);

  if (prop) {
    const pts = propPoints(prop.type, prop.cx, prop.cy, prop.size);
    if (pts) outlinePart(ctx, rng, pts, { hatchSpacing: skySpacing * 0.55, hatchAngle: 0.9, crossHatch: true, strokeWidth: 1.3 });
  }

  ctx.save();
  ctx.translate(hero.cx, hero.cy);
  ctx.rotate(hero.poseRot);
  ctx.scale(hero.facing, 1);
  for (const part of heroParts(scene.heroType)) drawPart(ctx, rng, part, hero.size, colors, layers, hero.silhouette);
  ctx.restore();

  if (fumbled) {
    paintSmudge(ctx, rng, width, height);
    paintScribble(ctx, rng, hero.cx, hero.cy, hero.size);
  }

  const pattern = paperGrainPattern(ctx);
  if (pattern) {
    ctx.save();
    ctx.globalAlpha = 0.35;
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

export default { id: 'ink', name: 'Ink sketch', cost: 2, renderScene, renderFumbled };
