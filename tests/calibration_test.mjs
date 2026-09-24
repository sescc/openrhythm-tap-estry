// tests/calibration_test.mjs
// Regression test for the M1.6 zero-hits bug: js/main.js used to pair the
// n-th calibration tap with the n-th metronome click by COUNTING position
// (`clickTimes[tapCount]`). One missed/extra/early tap shifted every later
// pairing by a whole beat, and the resulting garbage offset - stored
// unclamped and unchecked - made every real tap in every game land outside
// the judging window forever. js/calibration.js fixes this by pairing each
// tap with whichever click it's actually closest to IN TIME.
//
// Also covers the M1.7 Bluetooth fix: a genuine ~150-400ms device latency
// is a CORRECT reading, not noise, so the old symmetric +-200ms CLAMP_MS
// wrongly rejected it. js/calibration.js replaces that with an asymmetric
// pairing window and an asymmetric accepted-offset range (see 6a-6f below).
//
// Run directly with `node tests/calibration_test.mjs`, or via
// `node tests/run.mjs`.

import { pairTapsToClicks, isCountInTap, computeCalibration, computeVerifyResiduals, VERIFY_TAPS, CAL_BPM, MIN_OFFSET_MS, MAX_OFFSET_MS } from '../js/calibration.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

// This file's 6a-6f scenarios are hand-picked against the CURRENT
// MIN_OFFSET_MS/MAX_OFFSET_MS/CAL_BPM values - if those constants change,
// this file (not just calibration.js) needs a look, not just calibration.js.
assert(CAL_BPM === 80, `CAL_BPM changed to ${CAL_BPM} - re-check this file's hand-picked ms values`);
assert(MIN_OFFSET_MS === -200 && MAX_OFFSET_MS === 450, `offset range changed to [${MIN_OFFSET_MS},${MAX_OFFSET_MS}] - re-check this file's hand-picked ms values`);

const CAL_TAPS = 12;
// Imported from calibration.js (not duplicated) so this test exercises the
// SAME beat duration production calibration actually runs at - the
// asymmetric window's absolute ms bounds scale with beatDur, so a test
// written against a different BPM would exercise different ms thresholds
// than the real flow.
const BPM = CAL_BPM;
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

// A deterministic, SYMMETRIC jitter pattern (12 values, one per tap) whose
// median is exactly 0 by construction (6 negative/6 positive, mirrored) -
// used below instead of a random seed so 6a/6b prove the pairing+median
// LOGIC handles realistic per-tap variation, not that one particular seed
// happened to land close enough. A prior version of this test searched for
// a seed that passed a +-15ms tolerance (seeds 2501/4002 missed it at
// 267.4ms/371.8ms - a 12-sample median of +-40ms UNIFORM RANDOM jitter
// isn't reliably that tight) - this replaces that with an exact-by-design
// case plus one honestly-random noise check with a looser tolerance below.
const SYMMETRIC_JITTER_MS = [-40, -35, -25, -15, -10, -5, 5, 10, 15, 25, 35, 40];

// --- 6a. Bluetooth-safe: a consistent +250ms offset (with realistic,
// deterministic +-40ms jitter) must now SUCCEED - this is exactly the M1.7
// bug report (a genuine device latency wrongly rejected by the old
// symmetric +-200ms CLAMP_MS). ---------------------------------------------
{
  const truth = 250;
  const cl = clicks();
  const taps = cl.map((c, i) => c + (truth + SYMMETRIC_JITTER_MS[i]) / 1000);
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(result.ok, `bluetooth +250ms: expected success, got "${result.reason}"`);
  if (result.ok) assert(Math.abs(result.offsetMs - truth) <= 3, `bluetooth +250ms: median ${result.offsetMs.toFixed(1)}ms not within 3ms of truth ${truth}ms (symmetric jitter medians to exactly 0 by construction)`);
}

// --- 6b. Bluetooth-safe: a consistent +400ms offset (same deterministic
// +-40ms jitter pattern) must also succeed. --------------------------------
{
  const truth = 400;
  const cl = clicks();
  const taps = cl.map((c, i) => c + (truth + SYMMETRIC_JITTER_MS[i]) / 1000);
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(result.ok, `bluetooth +400ms: expected success, got "${result.reason}"`);
  if (result.ok) assert(Math.abs(result.offsetMs - truth) <= 3, `bluetooth +400ms: median ${result.offsetMs.toFixed(1)}ms not within 3ms of truth ${truth}ms (symmetric jitter medians to exactly 0 by construction)`);
}

// --- 6b2. Noise check: a genuinely random (seeded) +-40ms jitter around
// +300ms, with a deliberately LOOSER +-25ms tolerance (matching this file's
// other random-jitter case, #5) - a real device's jitter isn't symmetric
// by construction the way 6a/6b's is, so this keeps one honest random
// sample in the mix without over-constraining it to an exact median. -----
{
  const truth = 300;
  const rng = mulberry(777);
  const cl = clicks();
  const taps = cl.map((c) => c + truth / 1000 + (rng() * 2 - 1) * 0.04);
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(result.ok, `bluetooth +300ms (random jitter): expected success, got "${result.reason}"`);
  if (result.ok) assert(Math.abs(result.offsetMs - truth) <= 25, `bluetooth +300ms (random jitter): median ${result.offsetMs.toFixed(1)}ms not within 25ms of truth ${truth}ms`);
}

// --- 6c. +500ms is INSIDE the pairing window (LATE_FRAC=0.7 * beatDur =
// 525ms at CAL_BPM=80) but bigger than MAX_OFFSET_MS(450) - must fail via
// the range check, not silently clamp. ---------------------------------
{
  const cl = clicks();
  const taps = cl.map((c) => c + 0.5);
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  assert(offsetsMs.every((v) => Math.abs(v - 500) < 1), '+500ms: sanity - every tap should pair to its OWN click at ~500ms (within the window, not reassigned)');
  const result = computeCalibration(offsetsMs);
  assert(!result.ok, `+500ms: expected re-run (ok:false), got offset=${result.offsetMs}`);
}

// --- 6d. -250ms is OUTSIDE the pairing window for its own click
// (EARLY_FRAC=0.3 * beatDur = 225ms), so nearest-window pairing reassigns
// each tap to the PREVIOUS click instead (at +500ms relative to that one) -
// which then fails the same MAX_OFFSET_MS range check. Still a correct
// "no" (not a crash, not a silently-stored garbage value), just via
// mis-pairing rather than the offset itself being out of range. ---------
{
  const cl = clicks();
  const taps = cl.map((c) => c - 0.25);
  const { offsetsMs } = pairTapsToClicks(taps, cl, beatDur);
  const result = computeCalibration(offsetsMs);
  assert(!result.ok, `-250ms: expected re-run (ok:false), got offset=${result.offsetMs}`);
}

// --- 6e. Taps arriving during the count-in (before the first recorded
// click) must be recognised as such BY TIME, not counted as one of the
// recorded taps - this is what keeps an eager early tap from ever
// reintroducing the old count-based pairing bug (see js/main.js
// waitForTaps, which filters on this before a tap is even pushed). -----
{
  const firstClick = 20;
  assert(isCountInTap(firstClick - 0.3 * beatDur - 0.001, firstClick, beatDur), 'a tap just before the early-window boundary should be a count-in tap');
  assert(!isCountInTap(firstClick - 0.3 * beatDur + 0.001, firstClick, beatDur), 'a tap just inside the early-window boundary should NOT be a count-in tap');
  assert(!isCountInTap(firstClick, firstClick, beatDur), 'a tap exactly on the first recorded click should NOT be a count-in tap');
  assert(isCountInTap(firstClick - beatDur, firstClick, beatDur), 'a tap a full beat before the first recorded click (i.e. during the count-in itself) should be a count-in tap');
}

// --- 6f. Asymmetric pairing window, in isolation (single tap, exact
// arithmetic - no jitter/outlier machinery involved). The window is
// -EARLY_FRAC*beat <= t-c < LATE_FRAC*beat, so which click a tap pairs
// with depends on where in that window it falls, not on which click it's
// "nominally" nearest to by naive halfway-point reasoning. --------------
{
  const cl = clicks();
  const k = 5;

  // A tap 0.65 beat AFTER click k is still inside click k's own window
  // (< LATE_FRAC=0.7 beat late) - it pairs with click k itself (the
  // earlier of the two neighbouring clicks), at +0.65 beat.
  {
    const t = cl[k] + 0.65 * beatDur;
    const { offsetsMs, rejectedCount } = pairTapsToClicks([t], cl, beatDur);
    assert(rejectedCount === 0 && offsetsMs.length === 1, 't=click[k]+0.65beat should pair with some click');
    if (offsetsMs.length === 1) assert(Math.abs(offsetsMs[0] - 0.65 * beatDur * 1000) < 1, `t=click[k]+0.65beat: expected offset ~${(0.65 * beatDur * 1000).toFixed(0)}ms (paired to click[k]), got ${offsetsMs[0].toFixed(1)}ms`);
  }

  // A tap 0.35 beat BEFORE click k is OUTSIDE click k's own window
  // (>= EARLY_FRAC=0.3 beat early) - nearest-window pairing instead finds
  // click k-1, which this same tap is 0.65 beat AFTER (inside ITS window).
  // So this tap pairs with the click BEFORE the one it's nominally near,
  // not with click k itself.
  {
    const t = cl[k] - 0.35 * beatDur;
    const { offsetsMs, rejectedCount } = pairTapsToClicks([t], cl, beatDur);
    assert(rejectedCount === 0 && offsetsMs.length === 1, 't=click[k]-0.35beat should pair with some click');
    if (offsetsMs.length === 1) assert(Math.abs(offsetsMs[0] - 0.65 * beatDur * 1000) < 1, `t=click[k]-0.35beat: expected offset ~${(0.65 * beatDur * 1000).toFixed(0)}ms (paired to click[k-1], the EARLIER click), got ${offsetsMs[0].toFixed(1)}ms`);
  }

  // A tap only 0.25 beat before click k IS inside click k's own window
  // (< EARLY_FRAC=0.3 beat early) - this is the genuine "pairs with the
  // next click" case: no reassignment needed, it pairs directly with the
  // click it's nominally approaching.
  {
    const t = cl[k] - 0.25 * beatDur;
    const { offsetsMs, rejectedCount } = pairTapsToClicks([t], cl, beatDur);
    assert(rejectedCount === 0 && offsetsMs.length === 1, 't=click[k]-0.25beat should pair with some click');
    if (offsetsMs.length === 1) assert(Math.abs(offsetsMs[0] - -0.25 * beatDur * 1000) < 1, `t=click[k]-0.25beat: expected offset ~${(-0.25 * beatDur * 1000).toFixed(0)}ms (paired to click[k], the NEXT click), got ${offsetsMs[0].toFixed(1)}ms`);
  }
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
