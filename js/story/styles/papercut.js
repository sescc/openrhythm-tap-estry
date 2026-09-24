// js/story/styles/papercut.js
// Paper cut-out style: flat, opaque, layered paper shapes with drop shadows
// and torn/deckled edges (a zigzag "tooth" displacement, not the soft
// watercolour wobble) on a visible paper-texture ground.
//
// Fumble: crumple creases across the whole picture, one flap visibly torn
// off the hero and drifted away, and the hero itself sagging/tilting more
// than usual (reuses the shared fumble slump from computeLayout, plus an
// extra droop rotation per limb-ish part so it reads as "coming apart").

import { heroParts, scPts } from './parts.js';
import { resolvePalette, composeScene } from './scene.js';
import { rgbToCss, darkenRgb, lightenRgb, circlePoints, ellipsePoints, propPoints, paperGrainPattern, tracePolygon } from './geom.js';

const SILHOUETTE_RGB = { r: 24, g: 20, b: 30 };

function deckleEdge(rng, p1, p2, jag, out) {
  const dx = p2[0] - p1[0];
  const dy = p2[1] - p1[1];
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const teeth = Math.max(2, Math.round(len / 13));
  for (let i = 1; i <= teeth; i++) {
    const t = i / teeth;
    const x = p1[0] + dx * t;
    const y = p1[1] + dy * t;
    // `jag` is the max pixel displacement of a tooth (NOT scaled by the
    // segment's tooth spacing - that previously made every torn edge scale
    // with segment length, turning hero silhouettes into spiky stars).
    const off = (rng.next() - 0.5) * 2 * jag;
    out.push([x + nx * off, y + ny * off]);
  }
}
function tornPolygon(rng, basePoints, jag = 2.4) {
  const out = [basePoints[0]];
  for (let i = 0; i < basePoints.length; i++) {
    deckleEdge(rng, basePoints[i], basePoints[(i + 1) % basePoints.length], jag, out);
  }
  return out;
}

function paperShape(ctx, rng, points, colorRgb, opts = {}) {
  const torn = tornPolygon(rng, points, opts.jag ?? 2.2);
  ctx.save();
  ctx.shadowColor = 'rgba(30,20,10,0.35)';
  ctx.shadowBlur = opts.shadowBlur ?? 7;
  ctx.shadowOffsetX = opts.shadowOffsetX ?? 3;
  ctx.shadowOffsetY = opts.shadowOffsetY ?? 5;
  tracePolygon(ctx, torn);
  ctx.fillStyle = rgbToCss(colorRgb, 1);
  ctx.fill();
  ctx.restore();
  tracePolygon(ctx, torn);
  ctx.strokeStyle = rgbToCss(darkenRgb(colorRgb, 0.35), 0.45);
  ctx.lineWidth = 1;
  ctx.stroke();
}

function drawPart(ctx, rng, part, s, colors) {
  const color = colors[part.colorSlot] || colors.hero;
  if (part.shape === 'ellipse') {
    paperShape(ctx, rng, ellipsePoints(part.cx * s, part.cy * s, part.rx * s, part.ry * s, 10, part.rot || 0), color, { jag: s * 0.02, shadowBlur: 4, shadowOffsetX: 2, shadowOffsetY: 3 });
  } else if (part.shape === 'polygon') {
    paperShape(ctx, rng, scPts(part.points, s), color, { jag: s * 0.02, shadowBlur: 4, shadowOffsetX: 2, shadowOffsetY: 3 });
  } else if (part.shape === 'dot') {
    ctx.save();
    ctx.beginPath();
    ctx.arc(part.cx * s, part.cy * s, part.r * s, 0, Math.PI * 2);
    ctx.fillStyle = rgbToCss(colors.ink, 0.85);
    ctx.fill();
    ctx.restore();
  } else {
    // path/arc/spiral -> a thin flat "cut paper strip" instead of a stroke.
    const pts = part.shape === 'arc'
      ? Array.from({ length: 10 }, (_, i) => {
          const a = part.a0 + ((part.a1 - part.a0) * i) / 9;
          return [part.cx * s + Math.cos(a) * part.r * s, part.cy * s + Math.sin(a) * part.r * s];
        })
      : scPts(part.ops || [], s);
    ctx.save();
    ctx.strokeStyle = rgbToCss(darkenRgb(color, 0.3), 0.7);
    ctx.lineWidth = Math.max(1.5, s * (part.widthFactor ?? 0.015) * 1.4);
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
    ctx.restore();
  }
}

function drawSilhouettePart(ctx, rng, part, s) {
  if (part.shape === 'dot') return;
  if (part.shape === 'ellipse') {
    paperShape(ctx, rng, ellipsePoints(part.cx * s, part.cy * s, part.rx * s, part.ry * s, 10, part.rot || 0), SILHOUETTE_RGB, { jag: s * 0.02, shadowBlur: 3, shadowOffsetX: 1, shadowOffsetY: 2 });
  } else if (part.shape === 'polygon') {
    paperShape(ctx, rng, scPts(part.points, s), SILHOUETTE_RGB, { jag: s * 0.02, shadowBlur: 3, shadowOffsetX: 1, shadowOffsetY: 2 });
  } else {
    const pts = part.shape === 'arc'
      ? Array.from({ length: 10 }, (_, i) => {
          const a = part.a0 + ((part.a1 - part.a0) * i) / 9;
          return [part.cx * s + Math.cos(a) * part.r * s, part.cy * s + Math.sin(a) * part.r * s];
        })
      : scPts(part.ops || [], s);
    ctx.save();
    ctx.strokeStyle = rgbToCss(SILHOUETTE_RGB, 0.9);
    ctx.lineWidth = Math.max(1.5, s * (part.widthFactor ?? 0.015) * 1.4);
    ctx.lineCap = 'round';
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
    ctx.restore();
  }
}

/** Draw one composed environment-layer shape (absolute px, resolved colour)
 * as a flat cut-paper piece with a torn edge. */
function drawLayerShape(ctx, rng, shape) {
  if (shape.shape === 'polygon') {
    paperShape(ctx, rng, shape.points, shape.color, { jag: 2.5, shadowBlur: 4, shadowOffsetX: 1, shadowOffsetY: 3 });
  } else if (shape.shape === 'ellipse') {
    paperShape(ctx, rng, ellipsePoints(shape.cx, shape.cy, shape.rx, shape.ry, 12), shape.color, { jag: 2, shadowBlur: 3, shadowOffsetX: 1, shadowOffsetY: 2 });
  } else if (shape.shape === 'path') {
    ctx.save();
    ctx.strokeStyle = rgbToCss(shape.color, 0.6);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    shape.ops.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
    ctx.restore();
  }
}

function drawWeather(ctx, weather, width, height) {
  if (weather.kind === 'rain') {
    ctx.save();
    ctx.strokeStyle = 'rgba(90,100,130,0.5)';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    for (const l of weather.lines) {
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
    ctx.restore();
  } else if (weather.kind === 'snow') {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const d of weather.dots) {
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else if (weather.kind === 'fog') {
    ctx.save();
    for (const b of weather.bands) {
      ctx.fillStyle = 'rgba(244,237,224,0.55)';
      ctx.fillRect(0, b.y, width, b.h);
    }
    ctx.restore();
  }
}

function paintCrumple(ctx, rng, width, height) {
  const n = 4 + Math.floor(rng.next() * 3);
  ctx.save();
  for (let i = 0; i < n; i++) {
    const angle = ((rng.next() * 50 - 25) * Math.PI) / 180;
    const cx = width * (0.2 + rng.next() * 0.6);
    const cy = height * (0.15 + rng.next() * 0.7);
    const len = width * (0.6 + rng.next() * 0.5);
    const x1 = cx - Math.cos(angle) * len * 0.5;
    const y1 = cy - Math.sin(angle) * len * 0.5;
    const x2 = cx + Math.cos(angle) * len * 0.5;
    const y2 = cy + Math.sin(angle) * len * 0.5;
    ctx.strokeStyle = 'rgba(255,255,255,0.4)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(x1 - 1.5, y1 - 1.5);
    ctx.lineTo(x2 - 1.5, y2 - 1.5);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(20,15,10,0.32)';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(x1 + 1.5, y1 + 1.5);
    ctx.lineTo(x2 + 1.5, y2 + 1.5);
    ctx.stroke();
  }
  ctx.restore();
}

function paintTornFlap(ctx, rng, heroCx, heroCy, heroSize, colorRgb) {
  const angle = rng.next() * Math.PI * 2;
  const dist = heroSize * (1.0 + rng.next() * 0.7);
  const fx = heroCx + Math.cos(angle) * dist;
  const fy = heroCy + Math.sin(angle) * dist * 0.55 + heroSize * 0.35;
  const fs = heroSize * 0.24;
  const rot = rng.next() * Math.PI * 2;
  const base = [[-fs, -fs * 0.6], [fs * 0.8, -fs * 0.3], [fs * 0.3, fs]].map(([x, y]) => [
    fx + x * Math.cos(rot) - y * Math.sin(rot),
    fy + x * Math.sin(rot) + y * Math.cos(rot),
  ]);
  paperShape(ctx, rng, base, colorRgb, { jag: fs * 0.18, shadowBlur: 5, shadowOffsetX: 2, shadowOffsetY: 3 });
  // A pale "gap" mark left on the hero where the flap tore away from.
  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.strokeStyle = 'rgba(251,248,239,0.9)';
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.ellipse(heroCx, heroCy, heroSize * 0.3, heroSize * 0.18, 0.3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function render(scene, rng, opts, fumbled) {
  const width = opts.width || 640;
  const height = opts.height || 480;
  const dpr = Math.min(2, opts.dpr || 1);
  const colors = resolvePalette(scene, 0);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#f4ede0';
  ctx.fillRect(0, 0, width, height);

  const comp = composeScene(scene, rng, width, height, colors, { fumbled, lowEnd: opts.lowEnd });
  const { horizonY, sky, celestial, hero, prop, weatherParticles } = comp;

  const skyC = fumbled ? darkenRgb(sky.top, 0.12) : sky.top;

  // Sky panel (torn along the horizon only - a deckle strip, not a full jag).
  paperShape(ctx, rng, [[-4, -4], [width + 4, -4], [width + 4, horizonY], [-4, horizonY]], skyC, { jag: 3, shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0 });

  // Sun/moon: a flat circle cut-out with a soft halo behind it.
  const bodyColor = celestial.kind === 'moon' ? lightenRgb(colors.accent, 0.3) : colors.accent;
  const haloGrad = ctx.createRadialGradient(celestial.cx, celestial.cy, 0, celestial.cx, celestial.cy, celestial.r * 2);
  haloGrad.addColorStop(0, rgbToCss(bodyColor, 0.5));
  haloGrad.addColorStop(1, rgbToCss(bodyColor, 0));
  ctx.fillStyle = haloGrad;
  ctx.beginPath();
  ctx.arc(celestial.cx, celestial.cy, celestial.r * 2, 0, Math.PI * 2);
  ctx.fill();
  paperShape(ctx, rng, circlePoints(celestial.cx, celestial.cy, celestial.r, 14), lightenRgb(bodyColor, fumbled ? 0 : 0.05), { jag: celestial.r * 0.08, shadowBlur: 5 });

  // Parallax environment layers (far -> mid -> near), each a torn paper sheet.
  for (const group of comp.layers) {
    for (const shape of group.shapes) drawLayerShape(ctx, rng, shape);
  }

  drawWeather(ctx, weatherParticles, width, height);

  if (prop) {
    const pts = propPoints(prop.type, prop.cx, prop.cy, prop.size);
    if (pts) paperShape(ctx, rng, pts, colors.accent, { jag: prop.size * 0.06, shadowBlur: 5 });
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
    paintTornFlap(ctx, rng, hero.cx, hero.cy, hero.size, colors.hero);
    paintCrumple(ctx, rng, width, height);
  }

  const pattern = paperGrainPattern(ctx);
  if (pattern) {
    ctx.save();
    ctx.globalAlpha = 0.22;
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

export default { id: 'papercut', name: 'Paper cut-out', cost: 2, renderScene, renderFumbled };
