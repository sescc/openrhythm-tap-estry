// js/story/styles/geometric.js
// Geometric / Bauhaus style: bold flat primaries-leaning shapes (circles,
// rects, triangles) on a light grid, crisp black outlines, no texture.
//
// Fumble: colours dulled (desaturated), every part nudged askew (small
// random rotation around its own centre) and one part knocked right off -
// rotated hard and dropped below its normal spot.

import { heroParts, scPts } from './parts.js';
import { resolvePalette, composeScene } from './scene.js';
import { rgbToCss, darkenRgb, lightenRgb, ellipsePoints, circlePoints } from './geom.js';

const SILHOUETTE_RGB = { r: 26, g: 24, b: 30 };

function tracePts(ctx, points) {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  ctx.closePath();
}
function centerOf(points) {
  let sx = 0, sy = 0;
  for (const [x, y] of points) { sx += x; sy += y; }
  return [sx / points.length, sy / points.length];
}
function bboxOf(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

// --- hero-part -> bold Bauhaus primitive abstraction ----------------------
// Bauhaus doesn't draw a fox or a bird literally - it reduces a figure to
// circles, triangles, rects and arcs. Every hero part list (parts.js) is
// shared across styles, so here each part's ROLE (body/head/ear/tail/...)
// picks a primitive KIND, and the part's own ellipse/polygon geometry only
// supplies where/how big to draw it - the literal silhouette shape is
// discarded in favour of the primitive.
const ROLE_PRIMITIVE = {
  body: 'circle', head: 'circle', shell: 'circle', glow: 'circle', hull: 'rect',
  ear: 'triangle', beak: 'triangle', snout: 'triangle', sail: 'triangle', flag: 'triangle',
  wing: 'halfcircle', tail: 'halfcircle', bow: 'rect',
};
function primitiveKind(part) {
  if (ROLE_PRIMITIVE[part.role]) return ROLE_PRIMITIVE[part.role];
  if (part.shape === 'ellipse') return 'circle';
  if (part.shape === 'polygon') return part.points.length <= 3 ? 'triangle' : 'rect';
  return null;
}
/** The part's own geometry, reduced to a centre + a radius-ish half-size -
 * this is deliberately lossy (an ellipse's rx/ry, or a polygon's bbox
 * half-extents), because the primitive shape we draw from it doesn't try
 * to preserve the original silhouette. */
function partGeometry(part, s) {
  if (part.shape === 'ellipse') {
    return { cx: part.cx * s, cy: part.cy * s, rx: Math.abs(part.rx * s), ry: Math.abs(part.ry * s) };
  }
  if (part.shape === 'polygon') {
    const pts = scPts(part.points, s);
    const bb = bboxOf(pts);
    return { cx: (bb.minX + bb.maxX) / 2, cy: (bb.minY + bb.maxY) / 2, rx: (bb.maxX - bb.minX) / 2, ry: (bb.maxY - bb.minY) / 2 };
  }
  return null;
}
/** Build the primitive's own point list, oriented outward from the hero's
 * local origin (0,0) so ears/wings/tails/beaks point away from the body
 * the way a Bauhaus figure study would fan its shapes out from a core. */
function primitivePoints(kind, geo) {
  const { cx, cy, rx, ry } = geo;
  const r = Math.max(rx, ry, 1);
  const ang = cx === 0 && cy === 0 ? -Math.PI / 2 : Math.atan2(cy, cx);
  switch (kind) {
    case 'circle':
      return circlePoints(cx, cy, r, 22);
    case 'halfcircle': {
      const pts = [];
      const n = 14;
      for (let i = 0; i <= n; i++) {
        const a = ang - Math.PI / 2 + (i / n) * Math.PI;
        pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      }
      pts.push([cx - Math.cos(ang) * r * 0.1, cy - Math.sin(ang) * r * 0.1]);
      return pts;
    }
    case 'triangle': {
      const tip = [cx + Math.cos(ang) * r * 1.25, cy + Math.sin(ang) * r * 1.25];
      const perp = ang + Math.PI / 2;
      const backX = cx - Math.cos(ang) * r * 0.35;
      const backY = cy - Math.sin(ang) * r * 0.35;
      return [tip, [backX + Math.cos(perp) * r * 0.75, backY + Math.sin(perp) * r * 0.75], [backX - Math.cos(perp) * r * 0.75, backY - Math.sin(perp) * r * 0.75]];
    }
    case 'rect':
    default:
      return [[cx - rx, cy - ry], [cx + rx, cy - ry], [cx + rx, cy + ry], [cx - rx, cy + ry]];
  }
}
function fillOutline(ctx, points, colorRgb, lineWidth) {
  tracePts(ctx, points);
  ctx.fillStyle = rgbToCss(colorRgb, 1);
  ctx.fill();
  ctx.strokeStyle = 'rgba(24,22,22,0.85)';
  ctx.lineWidth = lineWidth;
  ctx.stroke();
}

const PROP_SHAPE = { tree: 'triangle', wave: 'rect', star: 'diamond', cloud: 'circle', rock: 'square', flower: 'circle' };
function propGeoPoints(type, cx, cy, s) {
  const kind = PROP_SHAPE[type] || 'square';
  if (kind === 'triangle') return [[cx, cy - s], [cx + s * 0.9, cy + s * 0.6], [cx - s * 0.9, cy + s * 0.6]];
  if (kind === 'diamond') return [[cx, cy - s], [cx + s * 0.7, cy], [cx, cy + s], [cx - s * 0.7, cy]];
  if (kind === 'rect') return [[cx - s, cy - s * 0.35], [cx + s, cy - s * 0.35], [cx + s, cy + s * 0.35], [cx - s, cy + s * 0.35]];
  if (kind === 'square') return [[cx - s * 0.75, cy - s * 0.75], [cx + s * 0.75, cy - s * 0.75], [cx + s * 0.75, cy + s * 0.75], [cx - s * 0.75, cy + s * 0.75]];
  return circlePoints(cx, cy, s * 0.75, 20); // circle
}

/** Draw one composed environment-layer shape as a bold flat Bauhaus block. */
function drawLayerShape(ctx, shape, lineWidth) {
  if (shape.shape === 'polygon') {
    fillOutline(ctx, shape.points, shape.color, lineWidth * 0.6);
  } else if (shape.shape === 'ellipse') {
    fillOutline(ctx, ellipsePoints(shape.cx, shape.cy, shape.rx, shape.ry, 16), shape.color, lineWidth * 0.6);
  } else if (shape.shape === 'path') {
    ctx.save();
    ctx.strokeStyle = rgbToCss(darkenRgb(shape.color, 0.2), 0.8);
    ctx.lineWidth = Math.max(1, lineWidth * 0.5);
    ctx.beginPath();
    shape.ops.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
    ctx.stroke();
    ctx.restore();
  }
}

function drawWeather(ctx, weather, width, height) {
  if (weather.kind === 'rain') {
    ctx.save();
    ctx.strokeStyle = 'rgba(40,60,110,0.5)';
    ctx.lineWidth = 1.5;
    for (const l of weather.lines) { ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.stroke(); }
    ctx.restore();
  } else if (weather.kind === 'snow') {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    for (const d of weather.dots) { ctx.beginPath(); ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  } else if (weather.kind === 'fog') {
    ctx.save();
    for (const b of weather.bands) { ctx.fillStyle = 'rgba(243,239,228,0.6)'; ctx.fillRect(0, b.y, width, b.h); }
    ctx.restore();
  }
}

function drawPart(ctx, rng, part, s, colors, lineWidth, fumbled, isFallen, silhouette, deliberateOffset) {
  const color = silhouette ? SILHOUETTE_RGB : (colors[part.colorSlot] || colors.hero);
  if (silhouette && part.shape === 'dot') return;

  const geo = partGeometry(part, s);
  const kind = geo ? primitiveKind(part) : null;
  let pts = geo && kind ? primitivePoints(kind, geo) : null;
  if (!pts && part.shape === 'polygon') pts = scPts(part.points, s); // fallback, shouldn't normally hit

  if (pts) {
    // A couple of parts are DELIBERATELY offset/overlapping - the Bauhaus
    // figure study look of primitives that don't quite line up, rather
    // than a tidy silhouette. Applied unconditionally (not gated on
    // `fumbled`) so the good/fumbled rng sequence stays in lockstep.
    const offX = deliberateOffset ? (rng.next() - 0.5) * s * 0.22 : 0;
    const offY = deliberateOffset ? (rng.next() - 0.5) * s * 0.22 : 0;
    pts = pts.map(([x, y]) => [x + offX, y + offY]);

    const [cx, cy] = centerOf(pts);
    let rot = 0;
    let dy = 0;
    if (fumbled) {
      rot = ((rng.next() * 16 - 8) * Math.PI) / 180;
      if (isFallen) { rot += ((rng.next() * 70 + 30) * Math.PI) / 180; dy = s * (0.8 + rng.next() * 0.4); }
    }
    if (isFallen) {
      // A dashed outline left at the shape's original spot, so a knocked-
      // over piece reads as "fell FROM here" rather than a second shape.
      ctx.save();
      ctx.strokeStyle = 'rgba(24,22,22,0.5)';
      ctx.lineWidth = Math.max(1, lineWidth * 0.7);
      ctx.setLineDash([4, 4]);
      tracePts(ctx, pts);
      ctx.stroke();
      ctx.restore();
    }
    ctx.save();
    ctx.translate(cx, cy + dy);
    ctx.rotate(rot);
    ctx.translate(-cx, -cy);
    fillOutline(ctx, pts, color, lineWidth);
    if (isFallen) {
      // A little grounding shadow so the fallen shape reads as resting
      // lower down, not just floating mid-rotation.
      ctx.beginPath();
      ctx.ellipse(cx, cy + s * 0.14, s * 0.22, s * 0.06, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(20,18,16,0.22)';
      ctx.fill();
    }
    ctx.restore();
    return;
  }

  if (part.shape === 'dot') {
    ctx.beginPath();
    ctx.arc(part.cx * s, part.cy * s, part.r * s * 1.3, 0, Math.PI * 2);
    ctx.fillStyle = rgbToCss(colors.ink, 0.9);
    ctx.fill();
    return;
  }

  // path/arc/spiral -> a plain crisp black line (Bauhaus linework is thin
  // and geometric, not textured).
  const spts = part.shape === 'arc'
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
  ctx.strokeStyle = 'rgba(24,22,22,0.8)';
  ctx.lineWidth = Math.max(1.5, s * 0.012);
  ctx.beginPath();
  spts.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  ctx.stroke();
}

function render(scene, rng, opts, fumbled) {
  const width = opts.width || 640;
  const height = opts.height || 480;
  const dpr = Math.min(2, opts.dpr || 1);
  const colors = resolvePalette(scene, fumbled ? 0.55 : 0);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  ctx.fillStyle = '#f3efe4';
  ctx.fillRect(0, 0, width, height);

  const comp = composeScene(scene, rng, width, height, colors, { fumbled, lowEnd: opts.lowEnd });
  const { horizonY, sky, celestial, hero, prop, weatherParticles } = comp;
  const lineWidth = Math.max(1.5, Math.min(width, height) * 0.006);

  // Bold sky/ground blocks (no gradients - flat Bauhaus colour fields).
  fillOutline(ctx, [[0, 0], [width, 0], [width, horizonY], [0, horizonY]], sky.top, 0);
  fillOutline(ctx, [[0, horizonY], [width, horizonY], [width, height], [0, height]], colors.ground, 0);
  ctx.beginPath();
  ctx.moveTo(0, horizonY);
  ctx.lineTo(width, horizonY);
  ctx.strokeStyle = 'rgba(24,22,22,0.7)';
  ctx.lineWidth = lineWidth;
  ctx.stroke();

  // Background grid - drawn ON TOP of the colour blocks (Bauhaus poster
  // grid), using an 'overlay' blend so it reads on both the light sky and
  // the darker ground blocks instead of disappearing into either.
  ctx.save();
  ctx.globalCompositeOperation = 'overlay';
  ctx.strokeStyle = 'rgba(255,255,255,0.65)';
  ctx.lineWidth = 1.4;
  const step = Math.max(18, Math.round(Math.min(width, height) / 16));
  for (let x = 0; x <= width; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 0; y <= height; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  ctx.restore();
  // A second pass with 'multiply' darkens the grid on the LIGHT sky block
  // too - 'overlay' alone reads strongly on the ground but stays faint on
  // a pale sky, and the grid should be present everywhere, not just below
  // the horizon.
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  ctx.strokeStyle = 'rgba(24,22,22,0.16)';
  ctx.lineWidth = 1;
  for (let x = 0; x <= width; x += step) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, horizonY); ctx.stroke(); }
  for (let y = 0; y <= horizonY; y += step) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  ctx.restore();

  // Sun/moon: bold concentric-circle bullseye.
  const bodyColor = celestial.kind === 'moon' ? lightenRgb(colors.accent, 0.3) : colors.accent;
  fillOutline(ctx, circlePoints(celestial.cx, celestial.cy, celestial.r, 24), bodyColor, lineWidth);
  ctx.beginPath();
  ctx.arc(celestial.cx, celestial.cy, celestial.r * 0.5, 0, Math.PI * 2);
  ctx.fillStyle = rgbToCss(darkenRgb(bodyColor, 0.35), 1);
  ctx.fill();

  // Parallax environment layers - bold flat Bauhaus blocks/shapes.
  for (const group of comp.layers) {
    for (const shape of group.shapes) drawLayerShape(ctx, shape, lineWidth);
  }

  drawWeather(ctx, weatherParticles, width, height);

  if (prop) {
    fillOutline(ctx, propGeoPoints(prop.type, prop.cx, prop.cy, prop.size * 0.7), colors.accentDark, lineWidth);
  }

  const parts = heroParts(scene.heroType);
  // Only ellipse/polygon parts can visibly "fall" (dots/paths have no fill
  // shape to knock over) - restrict the pick to those so the fumble is
  // never silently a no-op on a part type that can't show it.
  const fallableIdx = parts.reduce((acc, p, i) => ((p.shape === 'ellipse' || p.shape === 'polygon') ? (acc.push(i), acc) : acc), []);
  const fallenIdx = fumbled && fallableIdx.length ? rng.pick(fallableIdx) : -1;

  // A couple of primitives are deliberately offset/overlapping - the
  // Bauhaus figure-study look, not a fumble effect, so this is picked the
  // same way (and consumes rng identically) for both good and fumbled.
  const offsetIdx = new Set();
  const offsetCount = Math.min(2, fallableIdx.length);
  while (offsetIdx.size < offsetCount) offsetIdx.add(rng.pick(fallableIdx));

  ctx.save();
  ctx.translate(hero.cx, hero.cy);
  ctx.rotate(hero.poseRot);
  ctx.scale(hero.facing, 1);
  parts.forEach((part, i) => drawPart(ctx, rng, part, hero.size, colors, lineWidth, fumbled, i === fallenIdx, hero.silhouette, offsetIdx.has(i)));
  ctx.restore();

  return canvas;
}

export function renderScene(scene, rng, opts = {}) {
  return render(scene, rng, opts, false);
}
export function renderFumbled(scene, rng, opts = {}) {
  return render(scene, rng, opts, true);
}

export default { id: 'geometric', name: 'Geometric / Bauhaus', cost: 1, renderScene, renderFumbled };
