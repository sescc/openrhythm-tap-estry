// js/story/styles/index.js
// Style registry: every art style module exports
//   { id, name, cost (1-3), renderScene(scene, rng, opts) -> canvas,
//     renderFumbled(scene, rng, opts) -> canvas }
// opts = { width, height, dpr, lowEnd }.
//
// Adding a new style is just: write styles/<name>.js against the shared
// hero part lists (parts.js) and scene layout (scene.js), then add it here.

import watercolor from './watercolor.js';
import papercut from './papercut.js';
import pixel from './pixel.js';
import ink from './ink.js';
import crayon from './crayon.js';
import neon from './neon.js';
import geometric from './geometric.js';

export const STYLES = [watercolor, papercut, pixel, ink, crayon, neon, geometric];

export const STYLES_BY_ID = Object.fromEntries(STYLES.map((s) => [s.id, s]));

export function getStyle(id) {
  return STYLES_BY_ID[id] || null;
}

// Global base weight per style, applied before any per-minigame stylePrefs
// (see pickStyle below). Every style defaults to 1; pixel is the user's
// favourite ("paper boat level") and gets ~3x any other style. With 7
// styles at base weight 1 except pixel at 3, uniform draws land pixel at
// 3/9 = 33.3% - inside the 30-35% target - and a minigame's own stylePrefs
// still multiply on TOP of this (never overrides it to exactly 1).
const BASE_WEIGHTS = { pixel: 3 };
function baseWeight(id) {
  return BASE_WEIGHTS[id] ?? 1;
}

/**
 * Weighted-pick a style with a seeded rng.
 * @param {object} rng - from js/rng.js (needs .next())
 * @param {{stylePrefs?: Record<string,number>, forceStyle?: string, lowEnd?: boolean}} opts
 *   stylePrefs: style-id -> weight, COMBINED (multiplied) with each style's
 *   global base weight (see BASE_WEIGHTS) - missing ids default to
 *   stylePrefs weight 1, so the base weight alone still applies. If
 *   stylePrefs is omitted entirely, the pick is just the base weights.
 *   forceStyle: if set and valid, always wins (even in low-end, per spec -
 *   an explicit ?style= override should not be silently dropped).
 *   lowEnd: when true, cost-3 styles are excluded from the weighted pool
 *   UNLESS forceStyle names one of them directly.
 */
export function pickStyle(rng, opts = {}) {
  const { stylePrefs, forceStyle, lowEnd } = opts;

  if (forceStyle && STYLES_BY_ID[forceStyle]) {
    return STYLES_BY_ID[forceStyle];
  }

  let pool = STYLES;
  if (lowEnd) {
    const cheap = STYLES.filter((s) => s.cost < 3);
    if (cheap.length > 0) pool = cheap;
  }

  const weights = pool.map((s) => baseWeight(s.id) * Math.max(0, stylePrefs?.[s.id] ?? 1));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return rng.pick(pool);

  let roll = rng.next() * total;
  for (let i = 0; i < pool.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return pool[i];
  }
  return pool[pool.length - 1];
}
