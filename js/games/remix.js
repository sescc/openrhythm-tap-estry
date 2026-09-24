// js/games/remix.js
// Every 4th game (once >=2 games are cleared - see js/games/index.js) is a
// Remix: it doesn't have its own cue vocabulary. Instead it picks 2-3
// ALREADY-CLEARED games and, section by section, delegates composing to one
// of them - tagging every event/cue with `srcGame` so js/audio/synth.js and
// js/audio/sfx.js can look up THAT game's own soundPack, and js/main.js can
// show THAT game's own mascot. Each cue keeps its own sound and mascot;
// recognising them (now mixed together) is the whole point.
//
// Unlike the other games, remix needs the pool of cleared games decided
// once per chart (not per section) - js/songform.js special-cases
// game.id === 'remix' to call pickSubGames() once, then composeSection()
// (not compose()) for every section. See songform.js buildChart().

import * as echo from './echo.js';
import * as ready from './ready.js';
import * as bounce from './bounce.js';
import * as pump from './pump.js';
import * as swing from './swing.js';
import * as triplet from './triplet.js';

const ALL_GAMES = [echo, ready, bounce, pump, swing, triplet];

export const id = 'remix';
export const name = 'Remix';
export const mascot = { emoji: '🎪', label: 'the whole troupe' };
// Remix switches art style per section (its own "flavour" per the plan) -
// js/main.js handles that when it has >=2 sub-games to alternate between;
// no single stylePrefs weighting makes sense here.
export const stylePrefs = {};
export const groove = 'straight'; // overridden per-section by the delegate's own groove
export const cueTypes = []; // every cue was already taught by its own game
export const practice = []; // -> practice screen is skipped for remix (see main.js)

export function pickSubGames(rng, clearedIds) {
  let pool = ALL_GAMES.filter((g) => (clearedIds || []).includes(g.id));
  // js/games/index.js's isRemixTurn() gates normal ladder progression on
  // having >=2 cleared games, but a direct ?game=remix (or any other caller
  // that skips that gate - a fresh profile, a debug link) must still
  // produce a real, playable song rather than an empty/silent one: fall
  // back to picking at random from every game.
  if (pool.length < 2) pool = ALL_GAMES;
  const shuffled = rng.shuffle(pool);
  const count = pool.length >= 3 && rng.chance(0.5) ? 3 : 2;
  return shuffled.slice(0, count);
}

function tagGame(arr, gameId, beatOffset = 0) {
  return arr.map((x) => ({
    ...x,
    beat: x.beat + beatOffset,
    releaseBeat: x.releaseBeat != null ? x.releaseBeat + beatOffset : undefined,
    srcGame: gameId,
  }));
}

function grooveOf(game, levelParams, kind) {
  return typeof game.groove === 'function' ? game.groove(levelParams, kind) : game.groove || 'straight';
}

/**
 * Called by songform.js once per section, IN PLACE of game.compose().
 */
export function composeSection(subGames, rng, levelParams, beats, kind, sectionIdx) {
  if (subGames.length === 0) return { events: [], cues: [], groove: 'straight' };
  const mappedKind = kind === 'teachA' || kind === 'teachB' ? 'varyA' : kind;

  if (kind === 'combine' && subGames.length >= 2) {
    const half = Math.max(2, Math.floor(beats / 2));
    const gA = subGames[sectionIdx % subGames.length];
    const gB = subGames[(sectionIdx + 1) % subGames.length];
    const a = gA.compose(rng, levelParams, half, 'varyA') || { events: [], cues: [] };
    const b = gB.compose(rng, levelParams, beats - half, 'varyA') || { events: [], cues: [] };
    return {
      events: tagGame(a.events || [], gA.id).concat(tagGame(b.events || [], gB.id, half)),
      cues: tagGame(a.cues || [], gA.id).concat(tagGame(b.cues || [], gB.id, half)),
      groove: grooveOf(gA, levelParams, 'varyA'),
    };
  }

  const game = rng.pick(subGames);
  const composed = game.compose(rng, levelParams, beats, mappedKind) || { events: [], cues: [] };
  return {
    events: tagGame(composed.events || [], game.id),
    cues: tagGame(composed.cues || [], game.id),
    groove: grooveOf(game, levelParams, mappedKind),
  };
}
