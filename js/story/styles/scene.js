// js/story/styles/scene.js
// Shared SCENE COMPOSITION system. Every style calls composeScene() with a
// fresh, identically-seeded rng and gets back a fully laid-out shot: shot
// type, time of day, weather, a far/mid/near layer stack of drawable shapes
// (already positioned in absolute canvas pixels with a resolved colour),
// sun/moon/stars, a prop and a hero placement (position/size/facing/pose).
// Styles then walk composition.layers and draw each shape with their OWN
// technique (wash / flat+shadow / pixel fill / hatch / crayon strokes / neon
// glow / bold flat) - composeScene never touches canvas itself.
//
// Determinism: composeScene's shot/weather/time-of-day/layer/hero-placement
// decisions do NOT depend on `opts.fumbled` - only the hero's final pose
// (tilt/slump) does. So a style's renderScene() and renderFumbled(), called
// with two rng instances derived from the SAME seed, always agree on the
// composition and only the hero's pose (plus each style's own fumble
// overlay) differs - "the same picture, gone wrong", not a different one.

import { PALETTES } from '../storygen.js';
import { hexToRgb, darkenRgb, lightenRgb, desaturateRgb, mixRgb } from './geom.js';

/**
 * Resolve scene.paletteIdx into named rgb colour slots. `fumbleAmount` (0-1)
 * desaturates sky/ground/accent and darkens+desaturates the hero, matching
 * the original watercolour fumble treatment; styles that want a different
 * fumble colour move (e.g. pixel art's palette shift, neon's dimming) can
 * pass fumbleAmount:0 here and do their own thing instead.
 */
export function resolvePalette(scene, fumbleAmount = 0) {
  const raw = PALETTES[scene.paletteIdx % PALETTES.length].map(hexToRgb);
  const [skyHex, groundHex, accentHex, heroHex] = raw;
  const sky = fumbleAmount ? desaturateRgb(skyHex, fumbleAmount) : skyHex;
  const ground = fumbleAmount ? desaturateRgb(groundHex, fumbleAmount) : groundHex;
  const accent = fumbleAmount ? desaturateRgb(accentHex, fumbleAmount * 1.05) : accentHex;
  let hero = fumbleAmount ? desaturateRgb(heroHex, fumbleAmount * 0.93) : heroHex;
  if (scene.mood === 'somber' || fumbleAmount) hero = darkenRgb(hero, 0.2);

  return {
    sky, ground, accent, hero,
    heroDark: darkenRgb(hero, 0.15),
    accentDark: darkenRgb(accent, 0.35),
    accentLight: lightenRgb(accent, 0.25),
    ink: { r: 45, g: 38, b: 35 },
  };
}

function weightedPick(rng, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((a, [, w]) => a + w, 0);
  let roll = rng.next() * total;
  for (const [k, w] of entries) {
    roll -= w;
    if (roll <= 0) return k;
  }
  return entries[entries.length - 1][0];
}

// --- shot type: frames the whole composition ------------------------------

const SHOT_WEIGHTS = {
  setout: { wide: 0.45, mid: 0.3, highangle: 0.25 },
  journey: { mid: 0.3, wide: 0.25, highangle: 0.2, detail: 0.15, closeup: 0.1 },
  obstacle: { silhouette: 0.3, closeup: 0.25, highangle: 0.2, mid: 0.15, detail: 0.1 },
  climax: { closeup: 0.35, silhouette: 0.35, wide: 0.15, mid: 0.15 },
  good: { wide: 0.55, mid: 0.3, closeup: 0.15 },
  bad: { silhouette: 0.45, closeup: 0.3, mid: 0.25 },
};
function pickShotType(scene, rng) {
  return weightedPick(rng, SHOT_WEIGHTS[scene.kind] || SHOT_WEIGHTS.journey);
}

const HERO_SIZE_RANGE = {
  wide: [0.12, 0.2],
  mid: [0.2, 0.3],
  closeup: [0.36, 0.5],
  silhouette: [0.28, 0.4],
  highangle: [0.16, 0.24],
  detail: [0.3, 0.46],
};

// --- environment: what kind of place this beat happens in -----------------

const ENV_TYPE = {
  meadow: 'hills', 'home shore': 'sea', 'quiet harbor': 'town',
  forest: 'forest', 'wide river': 'sea', 'rolling hills': 'hills',
  'open sea': 'sea', 'winding path': 'path', 'misty valley': 'hills',
  storm: 'sea', 'dark wood': 'forest', 'steep cliff': 'mountains',
  'tangled thicket': 'forest',
};
function envTypeFor(scene, rng) {
  return ENV_TYPE[scene.environment] || rng.pick(['hills', 'forest', 'sea']);
}

function deriveWeather(scene, rng) {
  if (scene.environment === 'storm') return 'rain';
  if (scene.environment === 'misty valley') return 'fog';
  if (scene.kind === 'obstacle' && rng.chance(0.35)) return rng.pick(['rain', 'fog', 'snow']);
  if (scene.kind === 'climax' && rng.chance(0.22)) return rng.pick(['rain', 'fog']);
  if (rng.chance(0.1)) return rng.pick(['rain', 'snow', 'fog']);
  return 'clear';
}

function deriveTimeOfDay(scene, rng) {
  const base = scene.timeOfDay;
  if (scene.kind === 'obstacle' || scene.kind === 'bad') {
    if (rng.chance(0.4)) return 'night';
    return base !== 'day' || rng.chance(0.3) ? 'dusk' : 'day';
  }
  if (scene.kind === 'climax') {
    if (rng.chance(0.3)) return 'night';
    return base === 'day' ? 'golden' : 'dusk';
  }
  if (base === 'dawn' || base === 'dusk') return rng.chance(0.5) ? 'golden' : 'dusk';
  if (scene.kind === 'good') return rng.chance(0.5) ? 'golden' : 'day';
  return 'day';
}

/** Sky gradient stops for a resolved time-of-day, built from the story's
 * own sky/accent colours (never a fixed hard-coded palette) so every style
 * still reads as "this story's" picture. */
function skyStops(colors, tod) {
  switch (tod) {
    case 'night':
      return { top: mixRgb(colors.sky, { r: 8, g: 8, b: 28 }, 0.8), bottom: mixRgb(colors.sky, { r: 35, g: 30, b: 60 }, 0.55) };
    case 'golden':
      return { top: mixRgb(colors.sky, colors.accent, 0.35), bottom: lightenRgb(colors.accent, 0.15) };
    case 'dusk':
      return { top: mixRgb(colors.sky, { r: 45, g: 20, b: 55 }, 0.5), bottom: mixRgb(colors.accent, { r: 60, g: 20, b: 40 }, 0.4) };
    default:
      return { top: lightenRgb(colors.sky, 0.08), bottom: lightenRgb(colors.sky, 0.38) };
  }
}

// --- generic ridge/band geometry (shared by hills/forest/mountains/town) --

function ridge(rng, x0, x1, baseY, amp, segments) {
  const pts = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const x = x0 + (x1 - x0) * t;
    const wobble = Math.sin(t * Math.PI * (1.4 + rng.next() * 0.8) + rng.next()) * amp * 0.3;
    const y = baseY - amp * (0.3 + rng.next() * 0.7) - wobble;
    pts.push([x, y]);
  }
  return pts;
}
function bandFromRidge(ridgePts, bottomY) {
  const first = ridgePts[0];
  const last = ridgePts[ridgePts.length - 1];
  return [[first[0], bottomY], ...ridgePts, [last[0], bottomY]];
}
function ellipsePts(cx, cy, rx, ry, n = 10) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}
function treeClump(cx, baseY, s, rng) {
  const h = s * (0.8 + rng.next() * 0.5);
  const w = s * (0.4 + rng.next() * 0.25);
  return [[cx, baseY - h], [cx + w, baseY - h * 0.35], [cx + w * 0.6, baseY], [cx - w * 0.6, baseY], [cx - w, baseY - h * 0.35]];
}
function buildingShape(cx, baseY, w, h, roofed, rng) {
  const pts = [[cx - w / 2, baseY], [cx - w / 2, baseY - h], [cx + w / 2, baseY - h], [cx + w / 2, baseY]];
  if (roofed) pts.splice(2, 0, [cx, baseY - h - w * 0.5]);
  return pts;
}
function grassTuft(cx, baseY, s) {
  return {
    shape: 'path',
    ops: [[cx - s * 0.3, baseY], [cx - s * 0.1, baseY - s], [cx, baseY - s * 0.4], [cx + s * 0.15, baseY - s * 1.1], [cx + s * 0.35, baseY]],
    curve: false,
  };
}
function rockShape(cx, baseY, s, rng) {
  const w = s * (0.6 + rng.next() * 0.5);
  const h = s * (0.4 + rng.next() * 0.3);
  return [[cx - w / 2, baseY], [cx - w * 0.4, baseY - h], [cx + w * 0.2, baseY - h * 0.9], [cx + w / 2, baseY]];
}

// --- environment layer builders: one per envType, each returns shapes for
// far/mid/near depths (absolute px, {shape, points|cx/cy/r, ops, color}) ---

function buildSea(rng, width, height, horizonY, colors, tod, detail) {
  const far = mixRgb(colors.sky, { r: 255, g: 255, b: 255 }, 0.35);
  const water = tod === 'night' ? mixRgb(colors.sky, colors.ground, 0.6) : mixRgb(colors.sky, colors.ground, 0.45);
  const deep = darkenRgb(water, 0.18);
  const layers = { far: [], mid: [], near: [] };
  if (detail.far) {
    layers.far.push({ shape: 'polygon', points: ridge(rng, -20, width + 20, horizonY, height * 0.01, 3).map((p) => [p[0], horizonY - 1]), color: far });
  }
  layers.mid.push({ shape: 'polygon', points: [[-4, horizonY], [width + 4, horizonY], [width + 4, height + 4], [-4, height + 4]], color: water });
  const waveCount = detail.near ? 5 : 3;
  for (let i = 0; i < waveCount; i++) {
    const wy = horizonY + (height - horizonY) * (0.15 + (i / waveCount) * 0.75) + rng.next() * 10;
    layers.mid.push({ shape: 'path', ops: ridge(rng, -10, width + 10, wy, height * 0.012, 6), color: lightenRgb(water, 0.18), stroke: true });
  }
  if (detail.near) {
    layers.near.push({ shape: 'polygon', points: [[-4, height + 4], [width + 4, height + 4], [width + 4, height * 0.92], [-4, height * 0.97]], color: deep });
  }
  return layers;
}

function buildForest(rng, width, height, horizonY, colors, dense, detail) {
  const far = lightenRgb(desaturateRgb(colors.ground, 0.4), 0.22);
  const mid = colors.ground;
  const near = darkenRgb(colors.ground, dense ? 0.32 : 0.22);
  const layers = { far: [], mid: [], near: [] };
  // Forest floor - a full ground band UNDER the tree clumps, else the
  // ground would show through as bare canvas colour between trunks.
  layers.mid.push({ shape: 'polygon', points: [[-4, horizonY], [width + 4, horizonY], [width + 4, height + 4], [-4, height + 4]], color: lightenRgb(mid, 0.06) });
  if (detail.far) {
    const r1 = ridge(rng, -10, width + 10, horizonY - height * 0.02, height * 0.05, 8);
    layers.far.push({ shape: 'polygon', points: bandFromRidge(r1, horizonY), color: far });
  }
  const treeCount = detail.near ? 9 : 6;
  for (let i = 0; i < treeCount; i++) {
    const cx = width * (i / (treeCount - 1)) + (rng.next() - 0.5) * (width / treeCount) * 0.7;
    layers.mid.push({ shape: 'polygon', points: treeClump(cx, horizonY + rng.next() * 6, Math.min(width, height) * (dense ? 0.16 : 0.13), rng), color: mid });
  }
  if (detail.near) {
    const bigCount = dense ? 4 : 2;
    for (let i = 0; i < bigCount; i++) {
      const cx = rng.chance(0.5) ? width * (0.05 + rng.next() * 0.15) : width * (0.8 + rng.next() * 0.15);
      layers.near.push({ shape: 'polygon', points: treeClump(cx, height + Math.min(width, height) * 0.05, Math.min(width, height) * 0.32, rng), color: near });
    }
  }
  return layers;
}

function buildHills(rng, width, height, horizonY, colors, detail) {
  const far = lightenRgb(desaturateRgb(colors.ground, 0.35), 0.2);
  const mid = colors.ground;
  const layers = { far: [], mid: [], near: [] };
  if (detail.far) {
    const r1 = ridge(rng, -10, width + 10, horizonY - height * 0.03, height * 0.08, 6);
    layers.far.push({ shape: 'polygon', points: bandFromRidge(r1, height + 4), color: far });
  }
  const r2 = ridge(rng, -10, width + 10, horizonY + height * 0.02, height * 0.05, 7);
  layers.mid.push({ shape: 'polygon', points: bandFromRidge(r2, height + 4), color: mid });
  if (detail.near) {
    const tuftCount = 6;
    for (let i = 0; i < tuftCount; i++) {
      const cx = width * (0.05 + rng.next() * 0.9);
      const by = height - rng.next() * height * 0.06;
      layers.near.push({ ...grassTuft(cx, by, Math.min(width, height) * 0.045), color: darkenRgb(mid, 0.3) });
    }
  }
  return layers;
}

function buildMountains(rng, width, height, horizonY, colors, detail) {
  const far = lightenRgb(desaturateRgb(colors.ground, 0.5), 0.3);
  const mid = desaturateRgb(mixRgb(colors.ground, { r: 130, g: 130, b: 140 }, 0.35), 0.1);
  const layers = { far: [], mid: [], near: [] };
  if (detail.far) {
    const r1 = ridge(rng, -10, width + 10, horizonY - height * 0.02, height * 0.1, 6);
    layers.far.push({ shape: 'polygon', points: bandFromRidge(r1, height + 4), color: far });
  }
  const r2 = ridge(rng, -10, width + 10, horizonY, height * 0.22, 5);
  layers.mid.push({ shape: 'polygon', points: bandFromRidge(r2, height + 4), color: mid });
  if (detail.near) {
    for (let i = 0; i < 3; i++) {
      const cx = width * (0.1 + rng.next() * 0.8);
      layers.near.push({ shape: 'polygon', points: rockShape(cx, height + Math.min(width, height) * 0.02, Math.min(width, height) * 0.14, rng), color: darkenRgb(mid, 0.3) });
    }
  }
  return layers;
}

function buildTown(rng, width, height, horizonY, colors, detail) {
  const far = mixRgb(colors.sky, { r: 255, g: 255, b: 255 }, 0.3);
  const bases = [colors.ground, colors.accentDark || colors.accent, darkenRgb(colors.ground, 0.15)];
  const layers = { far: [], mid: [], near: [] };
  // Street/ground band under the buildings.
  layers.mid.push({ shape: 'polygon', points: [[-4, horizonY], [width + 4, horizonY], [width + 4, height + 4], [-4, height + 4]], color: darkenRgb(colors.ground, 0.05) });
  if (detail.far) layers.far.push({ shape: 'polygon', points: [[-4, horizonY - 2], [width + 4, horizonY - 2], [width + 4, horizonY], [-4, horizonY]], color: far });
  const count = detail.near ? 8 : 5;
  for (let i = 0; i < count; i++) {
    const w = width / count;
    const cx = w * i + w / 2 + (rng.next() - 0.5) * w * 0.3;
    const h = Math.min(width, height) * (0.1 + rng.next() * 0.16);
    layers.mid.push({ shape: 'polygon', points: buildingShape(cx, horizonY + 2, w * 0.7, h, rng.chance(0.4), rng), color: rng.pick(bases) });
  }
  if (detail.near) {
    layers.near.push({ shape: 'polygon', points: [[-4, height + 4], [width + 4, height + 4], [width + 4, horizonY + height * 0.02], [-4, horizonY + height * 0.05]], color: darkenRgb(mixRgb(colors.sky, colors.ground, 0.5), 0.1) });
  }
  return layers;
}

function buildPath(rng, width, height, horizonY, colors, detail) {
  const hills = buildHills(rng, width, height, horizonY, colors, detail);
  const dirt = lightenRgb(mixRgb(colors.ground, colors.accentLight || colors.accent, 0.4), 0.1);
  const vpX = width * (0.4 + rng.next() * 0.2);
  const pathPoly = [
    [width * 0.5 - width * 0.16, height + 4], [width * 0.5 + width * 0.16, height + 4],
    [vpX + width * 0.02, horizonY + 4], [vpX - width * 0.02, horizonY + 4],
  ];
  hills.mid.push({ shape: 'polygon', points: pathPoly, color: dirt });
  if (detail.near) {
    const stepCount = 3;
    for (let i = 0; i < stepCount; i++) {
      const t = 0.25 + i * 0.22 + rng.next() * 0.08;
      const y = height - (height - horizonY) * (1 - t) * 0.55;
      const x = width * 0.5 + (rng.next() - 0.5) * width * 0.1;
      hills.near.push({ shape: 'ellipse', cx: x, cy: y, rx: width * 0.02, ry: width * 0.008, color: darkenRgb(dirt, 0.25) });
    }
  }
  return hills;
}

function buildEnvironment(envType, rng, width, height, horizonY, colors, tod, detail) {
  switch (envType) {
    case 'sea': return buildSea(rng, width, height, horizonY, colors, tod, detail);
    case 'forest': return buildForest(rng, width, height, horizonY, colors, false, detail);
    case 'mountains': return buildMountains(rng, width, height, horizonY, colors, detail);
    case 'town': return buildTown(rng, width, height, horizonY, colors, detail);
    case 'path': return buildPath(rng, width, height, horizonY, colors, detail);
    case 'hills':
    default: return buildHills(rng, width, height, horizonY, colors, detail);
  }
}

// --- weather particles (positions only; each style draws them its way) ----

function buildWeather(weather, rng, width, height, lowEnd) {
  if (weather === 'rain') {
    const n = lowEnd ? 18 : 36;
    const lines = [];
    for (let i = 0; i < n; i++) {
      const x = rng.next() * width;
      const y = rng.next() * height;
      const len = height * (0.03 + rng.next() * 0.02);
      lines.push({ x1: x, y1: y, x2: x - len * 0.25, y2: y + len });
    }
    return { kind: 'rain', lines };
  }
  if (weather === 'snow') {
    const n = lowEnd ? 20 : 40;
    const dots = [];
    for (let i = 0; i < n; i++) {
      dots.push({ cx: rng.next() * width, cy: rng.next() * height, r: 1 + rng.next() * 2.2 });
    }
    return { kind: 'snow', dots };
  }
  if (weather === 'fog') {
    const n = 3;
    const bands = [];
    for (let i = 0; i < n; i++) {
      bands.push({ y: height * (0.45 + i * 0.15 + rng.next() * 0.08), h: height * (0.08 + rng.next() * 0.06) });
    }
    return { kind: 'fog', bands };
  }
  return { kind: 'clear' };
}

function buildStars(rng, width, horizonY, lowEnd) {
  const n = lowEnd ? 14 : 26;
  const stars = [];
  for (let i = 0; i < n; i++) {
    stars.push({ cx: rng.next() * width, cy: rng.next() * horizonY * 0.9, r: 0.6 + rng.next() * 1.4 });
  }
  return stars;
}

/**
 * Compose one full shot. Returns a plain-data description; styles draw it.
 * @param {object} scene - from storygen.js
 * @param {object} rng - a FRESH rng (see file header determinism note)
 * @param {number} width
 * @param {number} height
 * @param {object} colors - already resolved via resolvePalette() by the caller
 * @param {{fumbled?:boolean, lowEnd?:boolean}} opts
 */
export function composeScene(scene, rng, width, height, colors, opts = {}) {
  const shotType = pickShotType(scene, rng);
  const envType = envTypeFor(scene, rng);
  const weather = deriveWeather(scene, rng);
  const tod = deriveTimeOfDay(scene, rng);
  const sky = skyStops(colors, tod);

  // Horizon: pushed near the top for a high-angle look, low/hidden for a
  // close-up or detail shot, mid-frame otherwise.
  let horizonY;
  if (shotType === 'highangle') horizonY = height * (0.06 + rng.next() * 0.06);
  else if (shotType === 'closeup') horizonY = height * (0.7 + rng.next() * 0.15);
  else if (shotType === 'detail') horizonY = height * (0.55 + rng.next() * 0.2);
  else horizonY = height * (0.55 + rng.next() * 0.14);

  const detail = {
    far: shotType !== 'closeup' && shotType !== 'detail' && shotType !== 'silhouette',
    near: shotType === 'wide' || shotType === 'mid' || shotType === 'highangle',
  };
  const layersByDepth = buildEnvironment(envType, rng, width, height, horizonY, colors, tod, detail);
  const layers = [
    { depth: 'far', shapes: layersByDepth.far },
    { depth: 'mid', shapes: layersByDepth.mid },
    { depth: 'near', shapes: layersByDepth.near },
  ];

  // Celestial body: sun by day/golden, moon by dusk/night.
  const isMoon = tod === 'night' || (tod === 'dusk' && rng.chance(0.5));
  const thirds = ['left', 'center', 'right'];
  const sunSide = rng.pick(thirds);
  const sunCx = width * (sunSide === 'left' ? 0.2 : sunSide === 'right' ? 0.82 : 0.5);
  const sunCy = height * (0.12 + rng.next() * 0.12);
  const sunR = Math.min(width, height) * (isMoon ? 0.055 : 0.085);
  const celestial = { kind: isMoon ? 'moon' : 'sun', cx: sunCx, cy: sunCy, r: sunR };
  const stars = tod === 'night' ? buildStars(rng, width, horizonY, !!opts.lowEnd) : [];

  // Hero placement: shot-type size range, a third for x, facing direction,
  // gentle pose jitter, plus (fumbled only) an extra tilt + slump.
  const [minS, maxS] = HERO_SIZE_RANGE[shotType];
  const heroSize = Math.min(width, height) * (minS + rng.next() * (maxS - minS));
  const heroThird = weightedPick(rng, { left: 0.35, center: 0.3, right: 0.35 });
  let heroCx = width * (heroThird === 'left' ? 0.28 : heroThird === 'right' ? 0.72 : 0.5);
  if (shotType === 'detail') heroCx = width * (rng.chance(0.5) ? 0.12 : 0.88); // hero bleeds off-frame
  let heroCy = shotType === 'highangle'
    ? horizonY + (height - horizonY) * (0.55 + rng.next() * 0.25)
    : horizonY - heroSize * (0.02 + rng.next() * 0.1);
  const facing = rng.chance(0.5) ? 1 : -1;
  let poseRot = (rng.next() * 10 - 5) * (Math.PI / 180);
  if (opts.fumbled) {
    poseRot += ((rng.next() * 16 - 8) * Math.PI) / 180;
    heroCy += heroSize * 0.14;
  }
  const hero = { cx: heroCx, cy: heroCy, size: heroSize, facing, poseRot, silhouette: shotType === 'silhouette' };

  // Prop: usually modest and near the hero; the "detail" shot makes it the
  // whole point of the picture.
  let prop = null;
  if (scene.prop) {
    const propSize = Math.min(width, height) * (shotType === 'detail' ? 0.3 + rng.next() * 0.14 : 0.12 + rng.next() * 0.06);
    const propCx = shotType === 'detail'
      ? width * (heroCx > width / 2 ? 0.35 : 0.65) + (rng.next() - 0.5) * width * 0.1
      : width * (0.15 + rng.next() * 0.7);
    const propCy = shotType === 'highangle'
      ? heroCy + heroSize * (0.6 + rng.next() * 0.6)
      : horizonY + (height - horizonY) * (0.1 + rng.next() * 0.35);
    prop = { type: scene.prop, cx: propCx, cy: propCy, size: propSize };
  }

  const weatherParticles = buildWeather(weather, rng, width, height, !!opts.lowEnd);

  return { shotType, envType, weather, tod, sky, horizonY, layers, celestial, stars, hero, prop, weatherParticles };
}
