// tests/levels_test.mjs
// Regression test for the M1.8 "gentler levels 1-2" playability fix: level 1
// must use only a game's simplest (first-taught) cue type, with every
// judged response landing on a WHOLE beat of its own section - no half-beat
// motifs, no swung/triplet off-grid placement, no second cue type at all.
// Level 2 is allowed to add its "one variation" (typically the second cue
// type reappearing, an off-beat pattern reappearing, or both fused into one
// mechanic - e.g. Triplet Juggle's whoosh), so it's checked more loosely:
// at most two distinct cue types among judged (non-fake) notes. Levels 3+
// are untouched by this milestone and aren't covered here (see
// tests/calibration_test.mjs-style regression scope: this only guards the
// exact rule this session's fix promises). Run directly with
// `node tests/levels_test.mjs`, or via `node tests/run.mjs`.

import { subRng } from '../js/rng.js';
import { buildChart } from '../js/songform.js';
import { GAMES } from '../js/games/index.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

const SEEDS = 20;
const BEAT_EPS = 1e-6;

for (const game of GAMES) {
  // --- Level 1: whole-beat, single cue type, bpm <= 90 -------------------
  for (let s = 0; s < SEEDS; s++) {
    const seed = `levelstest:${game.id}:1:${s}`;
    const rng = subRng(seed, 'chart');
    const chart = buildChart(rng, game, 1, {});

    assert(chart.bpm <= 90, `${game.id} L1 seed${s}: bpm ${chart.bpm} should be <=90`);

    const cueIds = new Set();
    for (const n of chart.notes) {
      if (n.fake) continue;
      cueIds.add(n.cueId);
      const section = chart.sections[n.sectionIndex];
      const relBeat = (n.time - section.startTime) / chart.beatDuration;
      assert(
        Math.abs(relBeat - Math.round(relBeat)) < BEAT_EPS,
        `${game.id} L1 seed${s}: note (cueId=${n.cueId}) at relative beat ${relBeat.toFixed(4)} is not on a whole beat`
      );
    }
    assert(cueIds.size <= 1, `${game.id} L1 seed${s}: expected only 1 cue type among judged notes, got ${cueIds.size} (${[...cueIds].join(', ')})`);
    assert(chart.notes.filter((n) => !n.fake).length > 0, `${game.id} L1 seed${s}: chart has no judged notes at all`);
  }

  // --- Level 2: at most two cue types --------------------------------
  for (let s = 0; s < SEEDS; s++) {
    const seed = `levelstest:${game.id}:2:${s}`;
    const rng = subRng(seed, 'chart');
    const chart = buildChart(rng, game, 2, {});

    const cueIds = new Set();
    for (const n of chart.notes) {
      if (n.fake) continue;
      cueIds.add(n.cueId);
    }
    assert(cueIds.size <= 2, `${game.id} L2 seed${s}: expected at most 2 cue types among judged notes, got ${cueIds.size} (${[...cueIds].join(', ')})`);
  }
}

const ok = failures === 0;
console.log(ok ? `PASS - level 1/2 gentleness checks passed (${GAMES.length} games x ${SEEDS} seeds each)` : `FAIL - ${failures} check(s) failed`);
if (!ok) process.exitCode = 1;
