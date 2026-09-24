// js/rng.js
// Seeded pseudo-random number generation so an entire game (music, chart,
// story, art) can be exactly reproduced from a single seed (see ?seed=).
//
// Algorithm: mulberry32 (fast, tiny, decent statistical quality for a game).
// String seeds are first hashed to a 32-bit int with xmur3.

// xmur3: turns an arbitrary string into a 32-bit hash generator.
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

// mulberry32: given a 32-bit int seed, returns a function that yields
// successive floats in [0, 1).
function mulberry32(seedInt) {
  let a = seedInt >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Create a seeded RNG helper.
 * @param {string|number} seed
 */
export function makeRng(seed) {
  const seedInt = typeof seed === 'number' ? seed >>> 0 : xmur3(String(seed))();
  const next = mulberry32(seedInt);
  return {
    seedInt,
    // raw float in [0, 1)
    next,
    // float in [min, max)
    range(min, max) {
      return min + next() * (max - min);
    },
    // integer in [min, max] inclusive
    int(min, max) {
      return Math.floor(min + next() * (max - min + 1));
    },
    // random element of an array
    pick(arr) {
      return arr[Math.floor(next() * arr.length)];
    },
    // boolean with probability p of true
    chance(p) {
      return next() < p;
    },
    // Fisher-Yates shuffle, returns a new array
    shuffle(arr) {
      const out = arr.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}

/**
 * Derive an independent-looking sub-RNG from a master seed and a tag, e.g.
 * subRng(seed, 'music'), subRng(seed, 'story'), subRng(seed, 'art').
 * This lets each subsystem draw random numbers without their call counts
 * affecting one another, while everything stays deterministic per seed.
 */
export function subRng(seed, tag) {
  return makeRng(`${seed}:${tag}`);
}

// Turn the ?seed= URL param (or none) into a concrete seed value.
// A missing/empty seed gets a fresh random one (still an int we can display
// and put back in the URL for "Replay seed").
export function resolveSeed(paramValue) {
  if (paramValue !== null && paramValue !== undefined && paramValue !== '') {
    return paramValue;
  }
  return Math.floor(Math.random() * 0xffffffff);
}
