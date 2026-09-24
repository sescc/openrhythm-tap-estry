// js/story/styles/watercolor.js
// Watercolour style: layered deformed polygons (Tyler-Hobbs-style recursive
// midpoint displacement), multiply blending and a paper-grain overlay.
// Draws the shared scene composition (js/story/styles/scene.js - shot type,
// weather, time of day, parallax layers, hero placement) and the shared
// abstract hero part lists (parts.js), each in a soft painterly wash.
//
// The loader calls renderScene() and renderFumbled() with two FRESH rng
// instances created from the SAME seed (see js/story/loader.js) so their
// composition is identical and only the fumble-specific perturbations
// (drained colour, ink splatter, tilt/slump) differ.

import { heroParts, scPts } from './parts.js';
import { resolvePalette, composeScene } from './scene.js';
import {
  rgbToCss, darkenRgb, lightenRgb, roughPolygon, tracePolygon, circlePoints, ellipsePoints, starPoints, propPoints,
  paperGrainPattern,
} from './geom.js';

const SILHOUETTE_RGB = { r: 22, g: 18, b: 30 };

/**
 * Layered wash fill (multiply blend): one solid-ish base coat so the colour
 * actually reads as colour, plus a couple of lighter variation layers for
 * watercolour texture, plus one soft darker outline stroke.
 */
function paintWash(ctx, rng, basePoints, colorRgb, layers, opts = {}) {
  const baseAlpha = opts.alpha ?? 0.4;
  const variationAlpha = opts.variationAlpha ?? baseAlpha * 0.3;

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';

  const base = roughPolygon(rng, basePoints, 3, 0.13);
  tracePolygon(ctx, base);
  ctx.fillStyle = rgbToCss(colorRgb, baseAlpha);
  ctx.fill();

  for (let i = 1; i < layers; i++) {
    const jittered = roughPolygon(rng, basePoints, 3, 0.18 + rng.next() * 0.1);
    tracePolygon(ctx, jittered);
    ctx.fillStyle = rgbToCss(colorRgb, variationAlpha);
    ctx.fill();
  }

  if (opts.edge !== false) {
    const edge = roughPolygon(rng, basePoints, 3, 0.07);
    tracePolygon(ctx, edge);
    ctx.strokeStyle = rgbToCss(darkenRgb(colorRgb, 0.3), opts.edgeAlpha ?? 0.2);
    ctx.lineWidth = opts.edgeWidth ?? 1.4;
    ctx.stroke();
  }
  ctx.restore();
}

function paintEyeDot(ctx, cx, cy, r, inkRgb) {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = rgbToCss(inkRgb, 0.55);
  ctx.fill();
  ctx.restore();
}

function strokePath(ctx, part, s, colorRgb) {
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.strokeStyle = rgbToCss(colorRgb, part.strokeAlpha ?? 0.35);
  ctx.lineWidth = Math.max(1, s * (part.widthFactor ?? 0.015));
  ctx.beginPath();
  if (part.shape === 'arc') {
    ctx.arc(part.cx * s, part.cy * s, part.r * s, part.a0, part.a1);
  } else if (part.shape === 'spiral') {
    const steps = part.steps || 28;
    const r0 = part.r * s;
    ctx.moveTo(part.cx * s + r0, part.cy * s);
    for (let t = 1; t <= steps; t++) {
      const a = (t / steps) * Math.PI * (part.turns || 2.6);
      const r = r0 * (1 - t / (steps + 4));
      ctx.lineTo(part.cx * s + Math.cos(a) * r, part.cy * s + Math.sin(a) * r);
    }
  } else if (part.curve === 'quad') {
    const ops = part.ops;
    ctx.moveTo(ops[0][0] * s, ops[0][1] * s);
    for (let i = 1; i + 1 < ops.length; i += 2) {
      ctx.quadraticCurveTo(ops[i][0] * s, ops[i][1] * s, ops[i + 1][0] * s, ops[i + 1][1] * s);
    }
  } else {
    part.ops.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0] * s, p[1] * s) : ctx.lineTo(p[0] * s, p[1] * s)));
  }
  ctx.stroke();
  ctx.restore();
}

function drawPart(ctx, rng, part, s, colors, layers) {
  const color = colors[part.colorSlot] || colors.hero;
  if (part.shape === 'ellipse') {
    const pts = ellipsePoints(part.cx * s, part.cy * s, part.rx * s, part.ry * s, part.n || 10, part.rot || 0);
    paintWash(ctx, rng, pts, color, layers, { alpha: 0.57, edgeWidth: 1.2, edgeAlpha: 0.22 });
  } else if (part.shape === 'polygon') {
    paintWash(ctx, rng, scPts(part.points, s), color, Math.max(2, layers - 1), { alpha: 0.55, edgeWidth: 1, edgeAlpha: 0.2 });
  } else if (part.shape === 'dot') {
    paintEyeDot(ctx, part.cx * s, part.cy * s, part.r * s, colors.ink);
  } else {
    strokePath(ctx, part, s, color);
  }
}

function drawSilhouettePart(ctx, rng, part, s) {
  if (part.shape === 'dot') return; // no detail reads inside a flat silhouette
  if (part.shape === 'ellipse') {
    const pts = ellipsePoints(part.cx * s, part.cy * s, part.rx * s, part.ry * s, part.n || 10, part.rot || 0);
    paintWash(ctx, rng, pts, SILHOUETTE_RGB, 1, { alpha: 0.88, edge: false });
  } else if (part.shape === 'polygon') {
    paintWash(ctx, rng, scPts(part.points, s), SILHOUETTE_RGB, 1, { alpha: 0.88, edge: false });
  } else {
    strokePath(ctx, part, s, SILHOUETTE_RGB);
  }
}

function drawHero(ctx, rng, heroType, s, colors, layers, silhouette) {
  for (const part of heroParts(heroType)) {
    if (silhouette) drawSilhouettePart(ctx, rng, part, s);
    else drawPart(ctx, rng, part, s, colors, layers);
  }
}

/** Draw one composed environment-layer shape (absolute px, resolved colour)
 * in the watercolour wash technique. */
function drawLayerShape(ctx, rng, shape, layers) {
  if (shape.shape === 'polygon') {
    paintWash(ctx, rng, shape.points, shape.color, Math.max(2, layers - 1), { alpha: 0.5, edgeWidth: 1, edgeAlpha: 0.15 });
  } else if (shape.shape === 'ellipse') {
    const pts = ellipsePoints(shape.cx, shape.cy, shape.rx, shape.ry, 12);
    paintWash(ctx, rng, pts, shape.color, Math.max(2, layers - 1), { alpha: 0.5, edgeWidth: 1, edgeAlpha: 0.15 });
  } else if (shape.shape === 'path') {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = rgbToCss(shape.color, 0.3);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    shape.ops.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
    ctx.restore();
  }
}

function drawWeather(ctx, weather, width, height) {
  if (weather.kind === 'rain') {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = 'rgba(120,140,175,0.4)';
    ctx.lineWidth = 1.2;
    for (const l of weather.lines) {
      ctx.beginPath();
      ctx.moveTo(l.x1, l.y1);
      ctx.lineTo(l.x2, l.y2);
      ctx.stroke();
    }
    ctx.restore();
  } else if (weather.kind === 'snow') {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    for (const d of weather.dots) {
      ctx.beginPath();
      ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  } else if (weather.kind === 'fog') {
    ctx.save();
    for (const b of weather.bands) {
      ctx.fillStyle = 'rgba(255,255,255,0.3)';
      ctx.fillRect(0, b.y, width, b.h);
    }
    ctx.restore();
  }
}

// Fumble-only ink splatter, drawn on top of everything else.
function paintInkBlot(ctx, rng, width, height) {
  const bx = width * (0.25 + rng.next() * 0.5);
  const by = height * (0.15 + rng.next() * 0.25);
  const br = Math.min(width, height) * (0.07 + rng.next() * 0.05);
  const ink = 'rgba(46,42,64,';

  ctx.save();
  ctx.globalCompositeOperation = 'multiply';

  const lobes = 6 + Math.floor(rng.next() * 3);
  const blotBase = starPoints(bx, by, br, br * (0.55 + rng.next() * 0.25), lobes);
  for (let i = 0; i < 3; i++) {
    const pts = roughPolygon(rng, blotBase, 3, 0.32 + rng.next() * 0.18);
    tracePolygon(ctx, pts);
    ctx.fillStyle = `${ink}${(0.32 - i * 0.08).toFixed(2)})`;
    ctx.fill();
  }

  const dropletCount = 5 + Math.floor(rng.next() * 6);
  for (let i = 0; i < dropletCount; i++) {
    const angle = rng.next() * Math.PI * 2;
    const dist = br * (0.9 + rng.next() * 1.7);
    const dx = bx + Math.cos(angle) * dist;
    const dy = by + Math.sin(angle) * dist * 0.75;
    const dr = br * (0.05 + rng.next() * 0.13);
    const dropPts = roughPolygon(rng, circlePoints(dx, dy, dr, 6), 2, 0.3);
    tracePolygon(ctx, dropPts);
    ctx.fillStyle = `${ink}${(0.16 + rng.next() * 0.14).toFixed(2)})`;
    ctx.fill();
  }

  const dripAngle = Math.PI / 2 + (rng.next() * 0.7 - 0.35);
  const dripLen = br * (1.0 + rng.next() * 0.7);
  const dripW = br * 0.16;
  const nx = -Math.sin(dripAngle);
  const ny = Math.cos(dripAngle);
  const midX = bx + Math.cos(dripAngle) * dripLen * 0.55;
  const midY = by + Math.sin(dripAngle) * dripLen * 0.55;
  const endX = bx + Math.cos(dripAngle) * dripLen;
  const endY = by + Math.sin(dripAngle) * dripLen;
  ctx.beginPath();
  ctx.moveTo(bx - nx * dripW * 0.5, by - ny * dripW * 0.5);
  ctx.quadraticCurveTo(midX + nx * dripW * 0.3, midY + ny * dripW * 0.3, endX, endY);
  ctx.quadraticCurveTo(midX - nx * dripW * 0.3, midY - ny * dripW * 0.3, bx + nx * dripW * 0.5, by + ny * dripW * 0.5);
  ctx.closePath();
  ctx.fillStyle = `${ink}0.24)`;
  ctx.fill();

  ctx.restore();
}

function render(scene, rng, opts, fumbled) {
  const width = opts.width || 640;
  const height = opts.height || 480;
  const dpr = Math.min(2, opts.dpr || 1);
  const layers = opts.layers || (opts.lowEnd ? 2 : 4);
  const colors = resolvePalette(scene, fumbled ? 0.75 : 0);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#fbf8ef';
  ctx.fillRect(0, 0, width, height);

  const comp = composeScene(scene, rng, width, height, colors, { fumbled, lowEnd: opts.lowEnd });
  const { horizonY, sky, celestial, stars, hero, prop, weatherParticles } = comp;
  const bleed = Math.max(width, height) * 0.06;

  // Sky wash.
  const skyGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
  skyGrad.addColorStop(0, rgbToCss(sky.top, fumbled ? 0.4 : 0.55));
  skyGrad.addColorStop(1, rgbToCss(sky.bottom, fumbled ? 0.25 : 0.32));
  ctx.fillStyle = skyGrad;
  ctx.fillRect(0, 0, width, height);
  paintWash(
    ctx, rng,
    [[-bleed, -bleed], [width + bleed, -bleed], [width + bleed, horizonY], [-bleed, horizonY]],
    sky.top, layers, { alpha: 0.24, edge: false }
  );

  if (stars.length) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = 'rgba(255,250,220,0.8)';
    for (const st of stars) {
      ctx.beginPath();
      ctx.arc(st.cx, st.cy, st.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  // Sun / moon.
  const bodyColor = celestial.kind === 'moon' ? lightenRgb(colors.accent, 0.35) : colors.accent;
  const sunGrad = ctx.createRadialGradient(celestial.cx, celestial.cy, 0, celestial.cx, celestial.cy, celestial.r * 2.2);
  sunGrad.addColorStop(0, rgbToCss(bodyColor, celestial.kind === 'moon' ? 0.4 : 0.55));
  sunGrad.addColorStop(1, rgbToCss(bodyColor, 0));
  ctx.fillStyle = sunGrad;
  ctx.beginPath();
  ctx.arc(celestial.cx, celestial.cy, celestial.r * 2.2, 0, Math.PI * 2);
  ctx.fill();
  paintWash(ctx, rng, circlePoints(celestial.cx, celestial.cy, celestial.r, 12), bodyColor, Math.max(2, layers - 1), {
    alpha: 0.55, edgeWidth: 1, edgeAlpha: 0.2,
  });

  // Parallax environment layers (far -> mid -> near).
  for (const group of comp.layers) {
    for (const shape of group.shapes) drawLayerShape(ctx, rng, shape, layers);
  }

  drawWeather(ctx, weatherParticles, width, height);

  // Background prop.
  if (prop) {
    const pts = propPoints(prop.type, prop.cx, prop.cy, prop.size);
    if (pts) paintWash(ctx, rng, pts, colors.accent, Math.max(2, layers - 1), { alpha: 0.5, edgeWidth: 1, edgeAlpha: 0.2 });
  }

  // Hero.
  ctx.save();
  ctx.translate(hero.cx, hero.cy);
  ctx.rotate(hero.poseRot);
  ctx.scale(hero.facing, 1);
  drawHero(ctx, rng, scene.heroType, hero.size, colors, layers, hero.silhouette);
  ctx.restore();

  if (fumbled) paintInkBlot(ctx, rng, width, height);

  const pattern = paperGrainPattern(ctx);
  if (pattern) {
    ctx.save();
    ctx.globalAlpha = 0.3;
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

export default { id: 'watercolor', name: 'Watercolour', cost: 3, renderScene, renderFumbled };
