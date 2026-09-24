// tests/pause_test.mjs
// Regression test for js/songform.js planPauseResume() (M1.5 round 3
// backgrounding feature): a player can background the app mid-song, so the
// resume point must always land on a phrase boundary (never mid-phrase into
// a note the player couldn't have anticipated), every note that passed
// while away must be marked 'skipped' (not judged, not overwritten if it
// was already judged for real), and every note/cue/phrase at or after the
// resume point must be time-shifted to match the new playback schedule.
// Run directly with `node tests/pause_test.mjs`, or via `node tests/run.mjs`.

import { subRng } from '../js/rng.js';
import { buildChart, planPauseResume } from '../js/songform.js';
import { toAbsoluteChart } from '../js/chart.js';
import { GAMES } from '../js/games/index.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

function cloneAbs(chart, startTime) {
  return toAbsoluteChart(chart, startTime);
}

function checkSortedAndSpaced(notes, label) {
  for (let i = 1; i < notes.length; i++) {
    if (notes[i].time < notes[i - 1].time - 1e-9) {
      failures++;
      console.log(`  FAIL: ${label} notes not sorted at index ${i}`);
    }
  }
}

for (const game of GAMES) {
  for (const level of [1, 5, 10]) {
    const rng = subRng(`pausetest:${game.id}:${level}`, 'chart');
    const chart = buildChart(rng, game, level, {});
    const startTime = 1000; // arbitrary absolute origin
    const phrasesRel = chart.phrases;

    // --- Case A: pause well before phrase 2 starts (nothing skipped from it) ---
    {
      const abs = cloneAbs(chart, startTime);
      const pRel = phrasesRel[2];
      const pauseCtxTime = startTime + pRel.startTime - 2; // 2s before phrase 2 begins
      const newAudioStart = 5000; // far-future arbitrary resume moment
      const preNotes = abs.notes.map((n) => ({ time: n.time, judged: n.judged }));
      const plan = planPauseResume(abs, pauseCtxTime, newAudioStart);

      assert(plan.resumeIdx === 2, `Case A (${game.id} L${level}): expected resumeIdx=2, got ${plan.resumeIdx}`);
      assert(
        Math.abs(plan.resumeAtAbsTime - (startTime + pRel.startTime)) < 1e-6,
        `Case A (${game.id} L${level}): resumeAtAbsTime should equal phrase 2's original start`
      );
      // Every note originally before phrase 2's start must be judged:skipped;
      // every note at/after it must NOT be skipped and must be shifted.
      for (let i = 0; i < abs.notes.length; i++) {
        const pre = preNotes[i];
        const post = abs.notes[i];
        if (pre.time < startTime + pRel.startTime) {
          assert(post.judgement === 'skipped' && post.judged === true, `Case A (${game.id} L${level}): note@${pre.time} should be skipped`);
        } else {
          assert(post.judgement !== 'skipped', `Case A (${game.id} L${level}): note@${pre.time} should NOT be skipped`);
          const expected = pre.time + plan.timeShift;
          assert(Math.abs(post.time - expected) < 1e-6, `Case A (${game.id} L${level}): note time not shifted correctly`);
        }
      }
      checkSortedAndSpaced(abs.notes, `Case A (${game.id} L${level})`);
      // The resumed phrase's own start must land exactly on the 4-beat count-in target.
      assert(Math.abs(abs.phrases[2].startTime - newAudioStart) < 1e-6, `Case A (${game.id} L${level}): phrase2 start != newAudioStart`);
    }

    // --- Case B: pause mid-phrase (after phrase 1's own start) -> must skip to phrase 2, not resume phrase 1 ---
    {
      const abs = cloneAbs(chart, startTime);
      const pRel = phrasesRel[1];
      const midPause = startTime + pRel.startTime + (pRel.endTime - pRel.startTime) * 0.4; // 40% into phrase 1
      const plan = planPauseResume(abs, midPause, 6000);
      assert(plan.resumeIdx === 2, `Case B (${game.id} L${level}): mid-phrase pause should resume at NEXT phrase (2), got ${plan.resumeIdx}`);
      // No note should be judged into the middle of phrase 2 or later.
      for (const n of abs.notes) {
        if (n.judgement === 'skipped') {
          assert(n.phraseIndex <= 1, `Case B (${game.id} L${level}): a phrase-2+ note was wrongly skipped (phraseIndex=${n.phraseIndex})`);
        }
      }
      checkSortedAndSpaced(abs.notes, `Case B (${game.id} L${level})`);
    }

    // --- Case C: pause very late (after the last phrase entirely, in the outro) ---
    {
      const abs = cloneAbs(chart, startTime);
      const lastPhrase = phrasesRel[phrasesRel.length - 1];
      const latePause = startTime + lastPhrase.endTime + 0.5;
      const plan = planPauseResume(abs, latePause, 7000);
      assert(plan.resumeIdx === phrasesRel.length, `Case C (${game.id} L${level}): expected resumeIdx==phrases.length, got ${plan.resumeIdx}`);
      assert(
        Math.abs(plan.resumeAtAbsTime - (startTime + chart.outroStartTime)) < 1e-6,
        `Case C (${game.id} L${level}): should resume at outroStartTime`
      );
      // Every note in the whole song should now be skipped (all before the outro).
      const allSkipped = abs.notes.every((n) => n.judgement === 'skipped');
      assert(allSkipped, `Case C (${game.id} L${level}): every note should be skipped when pausing in the outro`);
    }

    // --- Case D: notes already judged before the pause must NOT be overwritten ---
    {
      const abs = cloneAbs(chart, startTime);
      const pRel = phrasesRel[3];
      // Pretend the player actually hit the first 2 notes of phrase 0 for real.
      const firstTwo = abs.notes.filter((n) => n.phraseIndex === 0).slice(0, 2);
      for (const n of firstTwo) {
        n.judged = true;
        n.judgement = 'perfect';
      }
      const pauseCtxTime = startTime + pRel.startTime - 1;
      planPauseResume(abs, pauseCtxTime, 8000);
      for (const n of firstTwo) {
        assert(n.judgement === 'perfect', `Case D (${game.id} L${level}): a real 'perfect' judgement got overwritten to '${n.judgement}'`);
      }
    }
  }
}

const ok = failures === 0;
console.log(ok ? `PASS - all planPauseResume checks passed (${GAMES.length} games x 3 levels x 4 cases)` : `FAIL - ${failures} check(s) failed`);
if (!ok) process.exitCode = 1;
