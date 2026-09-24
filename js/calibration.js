// js/calibration.js
// Pure calibration math - no DOM/audio - directly unit-testable via a plain
// Node import (see the M1.6 regression test this file exists because of).
//
// THE M1.5 BUG this replaces: js/main.js's old runCalibrationTaps() paired
// the n-th tap with the n-th metronome click by COUNTING taps
// (`clickTimes[tapCount]`). One missed, early, or extra tap shifted every
// later pairing by a whole beat (600ms at CAL_BPM=100). That median was
// stored unclamped and unchecked, then subtracted from every real tap in
// js/input.js, pushing every tap outside the +-150ms judging window -
// "ignored", forever, in every game. `?autoplay=` taps at exact chart times
// with the same (wrong) offset applied to both sides, so the error
// cancelled out and no automated test ever saw it - only real human input,
// which never lands on an exact multiple of the calibration beat, did.
//
// The fix: pair each tap with whichever click it's actually CLOSEST TO IN
// TIME, not by position in the sequence.

export const MIN_VALID_TAPS = 6;
export const CLAMP_MS = 200;
export const OUTLIER_MAD_MULT = 3; // reject taps beyond this many MADs from the median
export const VERIFY_TAPS = 4;

function median(arr) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pair each raw tap time with its NEAREST click time (nearest-neighbour by
 * time, never by index/order). A tap more than half a beat from every click
 * isn't attributable to any specific click (a genuine miss, a double-tap,
 * noise) and is rejected outright rather than paired with something distant.
 * @param {number[]} tapTimes - AudioContext-time of each tap
 * @param {number[]} clickTimes - AudioContext-time of each metronome click
 * @param {number} beatDurSec
 * @returns {{offsetsMs:number[], rejectedCount:number}}
 */
export function pairTapsToClicks(tapTimes, clickTimes, beatDurSec) {
  const halfBeat = beatDurSec / 2;
  const offsetsMs = [];
  let rejectedCount = 0;
  for (const t of tapTimes) {
    let bestDt = Infinity;
    let bestClick = null;
    for (const c of clickTimes) {
      const dt = Math.abs(t - c);
      if (dt < bestDt) {
        bestDt = dt;
        bestClick = c;
      }
    }
    if (bestClick === null || bestDt > halfBeat) {
      rejectedCount++;
      continue;
    }
    offsetsMs.push((t - bestClick) * 1000);
  }
  return { offsetsMs, rejectedCount };
}

/**
 * MAD-based outlier rejection, then a sanity clamp. Returns `ok:false` (with
 * a human-readable `reason`) whenever the input doesn't support a
 * trustworthy result - the caller re-runs calibration in that case rather
 * than storing a guess. Never returns a value outside +-CLAMP_MS; a median
 * that would need clamping is treated as "that didn't look right" instead
 * of silently clamped and stored, since a real device offset that extreme
 * is far more likely to mean the pairing went wrong than a genuine reading.
 * @param {number[]} offsetsMs - from pairTapsToClicks
 */
export function computeCalibration(offsetsMs) {
  if (offsetsMs.length < MIN_VALID_TAPS) {
    return { ok: false, reason: `Only ${offsetsMs.length} usable tap${offsetsMs.length === 1 ? '' : 's'} - need at least ${MIN_VALID_TAPS}. Let's try again.` };
  }
  const med1 = median(offsetsMs);
  const mad1 = median(offsetsMs.map((v) => Math.abs(v - med1))) || 1; // avoid a zero MAD nuking every point
  const kept = offsetsMs.filter((v) => Math.abs(v - med1) <= OUTLIER_MAD_MULT * mad1);
  if (kept.length < MIN_VALID_TAPS) {
    return { ok: false, reason: `Too many inconsistent taps (${offsetsMs.length - kept.length} outlier${offsetsMs.length - kept.length === 1 ? '' : 's'}) - let's try again.` };
  }
  const finalMedian = median(kept);
  const spreadMs = median(kept.map((v) => Math.abs(v - finalMedian))); // MAD of the kept set
  if (Math.abs(finalMedian) > CLAMP_MS) {
    return {
      ok: false,
      reason: `That didn't look right (measured ${finalMedian.toFixed(0)}ms, bigger than expected) - let's try again.`,
    };
  }
  return {
    ok: true,
    offsetMs: Math.max(-CLAMP_MS, Math.min(CLAMP_MS, finalMedian)),
    spreadMs,
    keptCount: kept.length,
    outlierCount: offsetsMs.length - kept.length,
    rejectedCount: 0, // filled in by the caller from pairTapsToClicks's own rejectedCount
  };
}

/**
 * Residuals for the post-calibration verify step: how far off each verify
 * tap lands AFTER applying the just-measured offset. A good calibration
 * should show residuals clustered near 0.
 */
export function computeVerifyResiduals(tapTimes, clickTimes, beatDurSec, offsetMs) {
  const { offsetsMs, rejectedCount } = pairTapsToClicks(tapTimes, clickTimes, beatDurSec);
  return { residualsMs: offsetsMs.map((raw) => raw - offsetMs), rejectedCount };
}
