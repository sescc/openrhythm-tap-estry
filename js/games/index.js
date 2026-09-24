// js/games/index.js
// Minigame module registry + progression helpers. Every module in this
// directory implements:
//   id, name, mascot:{emoji,label}, stylePrefs:{styleId:weight,...},
//   groove: string | (levelParams, kind) => string,
//   cueTypes: [{id, meaning}], practice: [{cueId, caption}],
//   soundPack(rng) -> { cues:{cueId:spec}, response:{tapGood,tapMiss,
//     holdSustain,holdRelease} } (see js/audio/voices.js playSpec()),
//   compose(rng, levelParams, beats, kind) -> { events:[...], cues:[...] }
// js/games/remix.js is special-cased (composeSection + pickSubGames) - see
// its own header and js/songform.js buildChart().

import * as echo from './echo.js';
import * as ready from './ready.js';
import * as bounce from './bounce.js';
import * as pump from './pump.js';
import * as swing from './swing.js';
import * as triplet from './triplet.js';
import * as remix from './remix.js';

export const GAMES = [echo, ready, bounce, pump, swing, triplet];
export const REMIX = remix;
export const ALL = [...GAMES, remix];

export function getGame(gameId) {
  return ALL.find((g) => g.id === gameId) || null;
}

/**
 * Every 4th game played is a Remix, once at least 2 games are cleared.
 * `gamesPlayed` is a 0-based count of games played so far this session
 * (see js/storage.js) - the 4th, 8th, 12th... game (index 3, 7, 11...) is a
 * remix attempt.
 */
export function isRemixTurn(gamesPlayed, clearedIds) {
  return (gamesPlayed + 1) % 4 === 0 && (clearedIds || []).length >= 2;
}

/**
 * Deterministic-ish "next game" pick for the ladder: cycles through GAMES in
 * order (seeded by gamesPlayed), falling back off remix if not eligible.
 */
export function pickNextGame(gamesPlayed, clearedIds) {
  if (isRemixTurn(gamesPlayed, clearedIds)) return remix;
  return GAMES[gamesPlayed % GAMES.length];
}

/** Every game id a chart's baked cues / live response sfx need a soundPack
 * for: the chart's own game, plus (remix only) every distinct `srcGame` its
 * notes/cues carry. Sorted so soundPack(rng) draws happen in a fixed order
 * regardless of Set iteration - see js/audio/synth.js and js/audio/sfx.js. */
export function collectInvolvedGameIds(chart) {
  const ids = new Set([chart.gameId]);
  for (const n of chart.notes) ids.add(n.srcGame || chart.gameId);
  for (const c of chart.cues) ids.add(c.srcGame || chart.gameId);
  return Array.from(ids).filter((id) => getGame(id) && id !== 'remix').sort();
}
