// js/story/styles/neon.js
// Neon / synthwave style: a dark gradient sky, a perspective grid horizon,
// and glowing outline "tubes" (layered strokes with shadowBlur, several
// widths/alphas stacked so the bloom reads as a glow once baked into the
// pre-rendered bitmap - there is no live animation here, just canvas glow).
//
// Fumble: the tubes dim/flicker (lower alpha, some grid + hero segments
// skipped entirely), one hero part's outline has a visibly broken gap, and
// a burst of small bright sparks flies off the break.

import { heroParts, scPts } from './parts.js';
import { resolvePalette, composeScene } from './scene.js';
import { rgbToCss, lightenRgb, mixRgb, ellipsePoints, propPoints } from './geom.js';

// Neon/synthwave is a fixed, deliberately vivid IDENTITY - a genuinely dark
// indigo-to-magenta sky and a bright cyan/magenta grid, not a wash of the
// story's own (often pastel) palette, which is what read as "muted olive"
// before. `paletteIdx` still picks WHICH of these presets a given story
// gets, so it stays seeded and varies story-to-story, but every preset is
// independently saturated enough to read as synthwave.
const SYNTH_PRESETS = [
  { top: { r: 18, g: 8, b: 46 }, horizon: { r: 255, g: 60, b: 150 }, sun: { r: 255, g: 150, b: 40 }, grid: { r: 0, g: 235, b: 255 } },
  { top: { r: 10, g: 10, b: 54 }, horizon: { r: 255, g: 40, b: 170 }, sun: { r: 255, g: 210, b: 60 }, grid: { r: 60, g: 255, b: 210 } },
  { top: { r: 8, g: 16, b: 40 }, horizon: { r: 0, g: 210, b: 220 }, sun: { r: 120, g: 230, b: 255 }, grid: { r: 255, g: 50, b: 210 } },
  { top: { r: 28, g: 6, b: 42 }, horizon: { r: 255, g: 170, b: 40 }, sun: { r: 255, g: 90, b: 170 }, grid: { r: 0, g: 240, b: 255 } },
];
function synthPreset(scene) {
  return SYNTH_PRESETS[Math.abs(scene.paletteIdx || 0) % SYNTH_PRESETS.length];
}

function glowLayers(lowEnd) {
  return lowEnd
    ? [{ w: 5, a: 0.25, blur: 7 }, { w: 1.6, a: 0.95, blur: 2 }]
    : [{ w: 9, a: 0.16, blur: 16 }, { w: 4.5, a: 0.35, blur: 9 }, { w: 1.6, a: 0.95, blur: 3 }];
}

function tracePts(ctx, points, close = true) {
  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1])));
  if (close) ctx.closePath();
}

function glowStroke(ctx, points, colorRgb, layers, close = true, skipProb = 0) {
  for (const L of layers) {
    ctx.save();
    ctx.shadowColor = rgbToCss(colorRgb, 0.9);
    ctx.shadowBlur = L.blur;
    ctx.strokeStyle = rgbToCss(colorRgb, L.a);
    ctx.lineWidth = L.w;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (skipProb > 0) {
      // Draw as short dashes with gaps, simulating a flickering/broken tube.
      ctx.setLineDash([points.length ? 14 : 0, skipProb * 20 + 4]);
    }
    tracePts(ctx, points, close);
    ctx.stroke();
    ctx.restore();
  }
}

function drawPart(ctx, rng, part, s, colors, layers, fumbled, breakPart, silhouette) {
  const color = colors[part.colorSlot] || colors.hero;
  const isBroken = fumbled && part === breakPart;
  const dim = fumbled ? 0.55 + rng.next() * 0.25 : 1;
  const tint = layers.map((L) => ({ ...L, a: L.a * dim }));

  if (part.shape === 'ellipse' || part.shape === 'polygon') {
    const pts = part.shape === 'ellipse'
      ? ellipsePoints(part.cx * s, part.cy * s, part.rx * s, part.ry * s, 16, part.rot || 0)
      : scPts(part.points, s);
    ctx.save();
    tracePts(ctx, pts);
    // A "silhouette" shot backlights the hero into a solid glowing mass
    // instead of a dark tube-outlined body.
    ctx.fillStyle = silhouette ? rgbToCss(lightenRgb(color, 0.2), 0.9 * dim) : 'rgba(8,6,20,0.55)';
    ctx.fill();
    ctx.restore();
    if (silhouette) {
      ctx.save();
      ctx.shadowColor = rgbToCss(color, 0.9);
      ctx.shadowBlur = 14;
      ctx.fillStyle = rgbToCss(lightenRgb(color, 0.3), 0.6 * dim);
      tracePts(ctx, pts);
      ctx.fill();
      ctx.restore();
    } else {
      glowStroke(ctx, pts, color, tint, true, isBroken ? 0.5 : 0);
    }
  } else if (part.shape === 'dot') {
    if (silhouette) return;
    ctx.save();
    ctx.shadowColor = rgbToCss(colors.accentLight, 0.9);
    ctx.shadowBlur = 8;
    ctx.fillStyle = rgbToCss(lightenRgb(colors.accentLight, 0.3), dim);
    ctx.beginPath();
    ctx.arc(part.cx * s, part.cy * s, part.r * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  } else {
    const pts = part.shape === 'arc'
      ? Array.from({ length: 12 }, (_, i) => {
          const a = part.a0 + ((part.a1 - part.a0) * i) / 11;
          return [part.cx * s + Math.cos(a) * part.r * s, part.cy * s + Math.sin(a) * part.r * s];
        })
      : (part.shape === 'spiral'
        ? Array.from({ length: (part.steps || 28) + 1 }, (_, t) => {
            const a = (t / (part.steps || 28)) * Math.PI * (part.turns || 2.6);
            const r = part.r * s * (1 - t / ((part.steps || 28) + 4));
            return [part.cx * s + Math.cos(a) * r, part.cy * s + Math.sin(a) * r];
          })
        : scPts(part.ops || [], s));
    glowStroke(ctx, pts, color, tint.map((L) => ({ ...L, w: L.w * 0.7 })), false, isBroken ? 0.5 : 0);
  }
}

/** Draw one composed environment-layer shape as a glowing horizon
 * ridgeline in the preset's own grid hue (not the shape's story-palette
 * colour, and no dark fill) - a bright neon tube tracing the top of each
 * hill/mountain/tree-band/skyline, the way synthwave art silhouettes its
 * horizon against the grid instead of rendering full-detail scenery. Only
 * the visible top edge of each band reads, because the rest of the
 * polygon (its flat bottom + side edges) is drawn off-canvas by scene.js. */
function drawLayerShape(ctx, shape, gridColor, depth, dimFactor) {
  const depthDim = depth === 'far' ? 0.55 : 0.85;
  const tint = [
    { w: 6, a: 0.14 * depthDim * dimFactor, blur: 12 },
    { w: 2.5, a: 0.85 * depthDim * dimFactor, blur: 5 },
  ];
  if (shape.shape === 'polygon') glowStroke(ctx, shape.points, gridColor, tint);
  else if (shape.shape === 'ellipse') glowStroke(ctx, ellipsePoints(shape.cx, shape.cy, shape.rx, shape.ry, 12), gridColor, tint);
  else if (shape.shape === 'path') glowStroke(ctx, shape.ops, gridColor, tint.map((L) => ({ ...L, w: L.w * 0.7 })), false);
}

/** A small fixed starfield - synthwave skies always have stars, regardless
 * of the story's own time-of-day, so this doesn't depend on composeScene's
 * (tod==='night') stars list. */
function buildStarfield(rng, width, horizonY, lowEnd) {
  const n = lowEnd ? 20 : 40;
  const stars = [];
  for (let i = 0; i < n; i++) stars.push({ cx: rng.next() * width, cy: rng.next() * horizonY * 0.92, r: 0.5 + rng.next() * 1.5 });
  return stars;
}

function drawWeather(ctx, weather, width, height, colors) {
  if (weather.kind === 'rain') {
    ctx.save();
    ctx.shadowColor = rgbToCss(colors.accentLight, 0.7);
    ctx.shadowBlur = 4;
    ctx.strokeStyle = rgbToCss(colors.accentLight, 0.5);
    ctx.lineWidth = 1;
    for (const l of weather.lines) { ctx.beginPath(); ctx.moveTo(l.x1, l.y1); ctx.lineTo(l.x2, l.y2); ctx.stroke(); }
    ctx.restore();
  } else if (weather.kind === 'snow') {
    ctx.save();
    ctx.shadowColor = 'rgba(255,255,255,0.8)';
    ctx.shadowBlur = 4;
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    for (const d of weather.dots) { ctx.beginPath(); ctx.arc(d.cx, d.cy, d.r, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  } else if (weather.kind === 'fog') {
    ctx.save();
    for (const b of weather.bands) { ctx.fillStyle = 'rgba(20,15,40,0.35)'; ctx.fillRect(0, b.y, width, b.h); }
    ctx.restore();
  }
}

function paintSparks(ctx, rng, cx, cy, colorRgb, scale) {
  ctx.save();
  ctx.shadowColor = rgbToCss(colorRgb, 1);
  ctx.shadowBlur = Math.max(3, scale * 0.35);
  ctx.strokeStyle = rgbToCss(lightenRgb(colorRgb, 0.4), 0.9);
  ctx.lineWidth = Math.max(1, scale * 0.05);
  const n = 5 + Math.floor(rng.next() * 3);
  for (let i = 0; i < n; i++) {
    const a = rng.next() * Math.PI * 2;
    const len = scale * (0.12 + rng.next() * 0.2);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
    ctx.stroke();
  }
  ctx.restore();
}

function render(scene, rng, opts, fumbled) {
  const width = opts.width || 640;
  const height = opts.height || 480;
  const dpr = Math.min(2, opts.dpr || 1);
  const lowEnd = !!opts.lowEnd;
  const layers = glowLayers(lowEnd);
  const colors = resolvePalette(scene, 0);

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const comp = composeScene(scene, rng, width, height, colors, { fumbled, lowEnd });
  const { horizonY, hero, prop, weatherParticles } = comp;
  const preset = synthPreset(scene);
  // Night/dusk beats dim the horizon glow a little for variety; day/golden
  // beats keep it at full blaze. Always dark at the top regardless - that's
  // the style's fixed identity, not something the story's time-of-day
  // should wash out.
  const todDim = comp.tod === 'night' ? 0.75 : comp.tod === 'dusk' ? 0.88 : 1;

  // Sky: a genuinely dark indigo top blending into a vivid magenta/pink/
  // orange horizon glow (the preset), not a mix with the story's own
  // (often pastel) sky colour.
  const bgGrad = ctx.createLinearGradient(0, 0, 0, horizonY);
  bgGrad.addColorStop(0, rgbToCss(preset.top));
  bgGrad.addColorStop(0.6, rgbToCss(mixRgb(preset.top, preset.horizon, 0.5 * todDim)));
  bgGrad.addColorStop(1, rgbToCss(mixRgb(preset.top, preset.horizon, 0.9 * todDim)));
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, width, height);

  // Starfield - always present, the fixed synthwave sky, not gated on the
  // story's own time-of-day.
  const stars = buildStarfield(rng, width, horizonY, lowEnd);
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  for (const st of stars) { ctx.beginPath(); ctx.arc(st.cx, st.cy, st.r, 0, Math.PI * 2); ctx.fill(); }
  ctx.restore();

  // Retro sun: big, sitting ON the horizon (composeScene's own sun
  // position is overridden here - neon's sun is always a horizon-line
  // sunset disc, not an upper-sky one), horizontal scanline stripes cut
  // through a glowing disc, classic synthwave.
  const sunR = comp.celestial.r * 1.7;
  const sunCx = comp.celestial.cx;
  const sunCy = horizonY - sunR * 0.12;
  ctx.save();
  ctx.shadowColor = rgbToCss(preset.sun, 0.95);
  ctx.shadowBlur = lowEnd ? 16 : 30;
  ctx.fillStyle = rgbToCss(preset.sun, fumbled ? 0.5 : 0.9);
  ctx.beginPath();
  ctx.arc(sunCx, sunCy, sunR, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(sunCx, sunCy, sunR, 0, Math.PI * 2);
  ctx.clip();
  ctx.fillStyle = rgbToCss(preset.top, 0.85);
  const stripeH = Math.max(2, sunR * 0.1);
  for (let y = sunCy - sunR; y < sunCy + sunR; y += stripeH * 2) {
    ctx.fillRect(sunCx - sunR, y, sunR * 2, stripeH);
  }
  ctx.restore();

  // Ground plane: a solid dark gradient from the horizon (bright, picking
  // up the horizon glow) down to near-black - this is what was MISSING
  // before (the sky gradient just continued below the horizon with
  // nothing distinct there), and it's what makes the sun read as sinking
  // INTO the grid instead of floating over a flat wash.
  const groundGrad = ctx.createLinearGradient(0, horizonY, 0, height);
  groundGrad.addColorStop(0, rgbToCss(mixRgb(preset.horizon, { r: 0, g: 0, b: 0 }, 0.25), 0.95));
  groundGrad.addColorStop(1, 'rgba(4,2,10,0.98)');
  ctx.fillStyle = groundGrad;
  ctx.fillRect(0, horizonY, width, height - horizonY);

  // Perspective grid horizon: lines converge to a vanishing point that
  // tracks the composed horizon (pushed high for a high-angle shot, low
  // for a close-up), in the preset's vivid grid hue.
  const vpX = width * 0.5;
  const vpY = horizonY;
  ctx.save();
  const gridDim = fumbled ? 0.55 : 1;
  ctx.strokeStyle = rgbToCss(preset.grid, 0.7 * gridDim);
  ctx.shadowColor = rgbToCss(preset.grid, 0.8);
  ctx.shadowBlur = lowEnd ? 4 : 8;
  ctx.lineWidth = 1.4;
  const cols = lowEnd ? 8 : 14;
  for (let i = -cols; i <= cols; i++) {
    if (fumbled && rng.chance(0.18)) continue; // flicker: skip a grid line
    const x = width * 0.5 + (i / cols) * width * 1.3;
    ctx.beginPath();
    ctx.moveTo(vpX, vpY);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  const rows = lowEnd ? 5 : 8;
  for (let j = 1; j <= rows; j++) {
    const t = j / rows;
    const y = vpY + (height - vpY) * (t * t);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
  ctx.restore();

  // Environment layers read as bright glowing horizon ridgelines (in the
  // grid's own hue) tracing hills/mountains/tree-bands/skyline right at
  // the horizon - not full-detail scenery, but not invisible either.
  const dimFactor = fumbled ? 0.55 : 1;
  for (const group of comp.layers) {
    if (group.depth === 'near') continue; // keep the grid floor uncluttered
    for (const shape of group.shapes) drawLayerShape(ctx, shape, preset.grid, group.depth, dimFactor);
  }

  drawWeather(ctx, weatherParticles, width, height, colors);

  if (prop) {
    const pts = propPoints(prop.type, prop.cx, prop.cy, prop.size);
    if (pts) glowStroke(ctx, pts, preset.grid, layers.map((L) => ({ ...L, w: L.w * 0.6 })));
  }

  const parts = heroParts(scene.heroType);
  // Only shapes that actually get glow-stroked can visibly "break" (a dot
  // eye has no outline to gap) - restrict the pick to those.
  const breakable = parts.filter((p) => p.shape !== 'dot');
  const breakPart = fumbled && breakable.length ? rng.pick(breakable) : null;

  ctx.save();
  ctx.translate(hero.cx, hero.cy);
  ctx.rotate(hero.poseRot);
  ctx.scale(hero.facing, 1);
  for (const part of parts) drawPart(ctx, rng, part, hero.size, colors, layers, fumbled, breakPart, hero.silhouette);
  ctx.restore();

  if (fumbled && breakPart && !hero.silhouette) {
    // Sparks fly off the broken tube's location (approximate: hero centre
    // offset toward the broken part's own centre), sized relative to the
    // hero so they read as a small shower, not a starburst covering it.
    const sx = hero.cx + (breakPart.cx || 0) * hero.size * hero.facing;
    const sy = hero.cy + (breakPart.cy || 0) * hero.size;
    paintSparks(ctx, rng, sx, sy, colors.accentLight, hero.size);
  }

  return canvas;
}

export function renderScene(scene, rng, opts = {}) {
  return render(scene, rng, opts, false);
}
export function renderFumbled(scene, rng, opts = {}) {
  return render(scene, rng, opts, true);
}

export default { id: 'neon', name: 'Neon synthwave', cost: 3, renderScene, renderFumbled };
