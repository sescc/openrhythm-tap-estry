// tests/calibration_test.mjs
// Regression test for the M1.6 zero-hits bug: js/main.js used to pair the
// n-th calibration tap with the n-th metronome click by COUNTING position
// (`clickTimes[tapCount]`). One missed/extra/early tap shifted every later
// pairing by a whole beat, and the resulting garbage offset - stored
// unclamped and unchecked - made every real tap in every game land outside
// the judging window forever. js/calibration.js fixes this by pairing each
// tap with whichever click it's actually closest to IN TIME. Run directly
// with `node tests/calibration_test.mjs`, or via `node tests/run.mjs`.

import { pairTapsToClicks, computeCalibration, computeVerifyResiduals, VERIFY_TAPS } from '../js/calibration.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

const CAL_TAPS = 12;
const BPM = 100;
const beatDur = 60 / BPM;
const START = 10; // arbitrary ctx-time origin

function clicks(n = CAL_TAPS) {
  const arr = [];
  for (let i = 0; i < n; i++) arr.push(START + i * beatDur);
  return arr;
}

// Deterministic little PRNG so jitter is reproducible without pulling in rng.js.
function mulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- 1. Clean run, true offset 40ms late -----------------------------
{
  const truth = 40;
  const cl = clicks();
  const taps = cl.map((c) => c + truth / 1000);
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(result.ok, `clean run: expected success, got "${result.reason}"`);
  if (result.ok) assert(Math.abs(result.offsetMs - truth) <= 25, `clean run: median ${result.offsetMs.toFixed(1)}ms not within 25ms of truth ${truth}ms`);
}

// --- 2. A MISSED first tap (the exact M1.5/M1.6 bug trigger): the old code
// would pair tap[0] (originally meant for click[1]) with clickTimes[0],
// shifting EVERY later pairing by a full beat (600ms). Nearest-click
// pairing must recover the true offset regardless. ---------------------
{
  const truth = 30;
  const cl = clicks();
  const taps = cl.slice(1).map((c) => c + truth / 1000); // tap for click 0 never happened
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(result.ok, `missed first tap: expected success, got "${result.reason}"`);
  if (result.ok) {
    assert(
      Math.abs(result.offsetMs - truth) <= 25,
      `missed first tap: median ${result.offsetMs}ms not near truth ${truth}ms (bug would show ~${truth + 600}ms or similar beat-shifted value)`
    );
  }
}

// --- 3. An EXTRA tap inserted partway through -------------------------
{
  const truth = -25;
  const cl = clicks();
  const taps = [];
  for (let i = 0; i < cl.length; i++) {
    taps.push(cl[i] + truth / 1000);
    if (i === 5) taps.push(cl[i] + beatDur / 2 + truth / 1000); // a stray extra tap between click 5 and 6
  }
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(result.ok, `extra tap: expected success, got "${result.reason}"`);
  if (result.ok) assert(Math.abs(result.offsetMs - truth) <= 25, `extra tap: median ${result.offsetMs}ms not near truth ${truth}ms`);
}

// --- 4. A DOUBLE tap (two taps very close together on the same click) --
{
  const truth = 60;
  const cl = clicks();
  const taps = [];
  for (const c of cl) {
    taps.push(c + truth / 1000);
    if (c === cl[3]) taps.push(c + truth / 1000 + 0.01); // accidental double-tap, 10ms later
  }
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(result.ok, `double tap: expected success, got "${result.reason}"`);
  if (result.ok) assert(Math.abs(result.offsetMs - truth) <= 25, `double tap: median ${result.offsetMs}ms not near truth ${truth}ms`);
}

// --- 5. +-80ms jitter around a true offset -----------------------------
{
  const truth = -50;
  const rng = mulberry(12345);
  const cl = clicks();
  const taps = cl.map((c) => c + truth / 1000 + (rng() * 2 - 1) * 0.08);
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(result.ok, `jitter: expected success, got "${result.reason}"`);
  if (result.ok) assert(Math.abs(result.offsetMs - truth) <= 25, `jitter: median ${result.offsetMs.toFixed(1)}ms not near truth ${truth}ms`);
}

// --- 6. Out-of-range (bigger than the +-200ms clamp, but still within
// half a beat so nearest-click pairing doesn't just reassign it to the
// next click) must FAIL, not silently store a clamped guess. -----------
{
  const cl = clicks();
  const taps = cl.map((c) => c + 0.25); // 250ms off every click: > CLAMP_MS(200) but < halfBeat(300)
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(!result.ok, `out-of-range: expected re-run (ok:false), got offset=${result.offsetMs}`);
}

// --- 7. Too few valid taps (most rejected as > half a beat from any click) ---
{
  const cl = clicks();
  const taps = [cl[0] + 0.01, cl[1] + 0.01, cl[2] + 0.01]; // only 3 usable taps
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(!result.ok, `too few taps: expected re-run (ok:false), got offset=${result.offsetMs}`);
}

// --- 8. A single wild outlier among otherwise-good taps must not drag the
// result off (MAD rejection). --------------------------------------------
{
  const truth = 20;
  const cl = clicks();
  const taps = cl.map((c, i) => (i === 7 ? c + 0.55 : c + truth / 1000)); // one tap is way off
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(result.ok, `single outlier: expected success, got "${result.reason}"`);
  if (result.ok) {
    assert(Math.abs(result.offsetMs - truth) <= 25, `single outlier: median ${result.offsetMs.toFixed(1)}ms not near truth ${truth}ms (outlier not rejected?)`);
  }
}

// --- 9. Verify-step residuals should cluster near 0 for a correct offset ---
{
  const truth = 45;
  const cl = clicks(VERIFY_TAPS);
  const taps = cl.map((c) => c + truth / 1000);
  const { residualsMs } = computeVerifyResiduals(taps, cl, beatDur, truth);
  for (const r of residualsMs) assert(Math.abs(r) < 5, `verify residual ${r}ms should be ~0 when offset matches truth`);
}

const ok = failures === 0;
console.log(ok ? 'PASS - all calibration regression checks passed' : `FAIL - ${failures} check(s) failed`);
if (!ok) process.exitCode = 1;
