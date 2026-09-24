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
//
// THE M1.7 BUG this fixes on top of that: a genuine Bluetooth output delay
// (~150-350ms) is a CORRECT reading, not noise - `getOutputTimestamp()`
// often doesn't fully account for it. The symmetric +-200ms CLAMP_MS
// (M1.6) rejected any such reading outright ("measured 248ms, bigger than
// expected"), and at CAL_BPM=100 the OLD symmetric +-halfBeat(300ms)
// pairing window could mis-pair a slightly larger delay to the wrong click
// entirely. Output latency only ever makes a tap LATE relative to the
// click it was meant for, never early by more than a small human-timing
// margin - so the pairing window below is asymmetric (tight early, wide
// late) and the accepted offset range is asymmetric too (MIN_OFFSET_MS,
// MAX_OFFSET_MS), rather than a single symmetric clamp.

export const MIN_VALID_TAPS = 6;
export const MIN_OFFSET_MS = -200;
export const MAX_OFFSET_MS = 450;
export const OUTLIER_MAD_MULT = 3; // reject taps beyond this many MADs from the median
export const VERIFY_TAPS = 4;
export const CAL_BPM = 80; // slower than the old 100 - more headroom per beat for a laggy device
export const COUNT_IN_BEATS = 4;
export const VERIFY_COUNT_IN_BEATS = 2;
// A tap belongs to click c only if -EARLY_FRAC*beat <= t-c < LATE_FRAC*beat
// (see pairTapsToClicks). Also used to decide whether a tap arrived during
// the count-in (before the first RECORDED click) and should be ignored by
// TIME rather than by counting - see isCountInTap().
export const EARLY_FRAC = 0.3;
export const LATE_FRAC = 0.7;

function median(arr) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Pair each raw tap time with its NEAREST-IN-WINDOW click time (never by
 * index/order). The window is ASYMMETRIC: a tap belongs to click c only if
 * -EARLY_FRAC*beatDurSec <= t-c < LATE_FRAC*beatDurSec, because output
 * latency only ever makes a tap arrive LATE relative to its intended click,
 * never meaningfully early. Among every click a tap qualifies for, the one
 * with the smallest |t-c| wins - which can be the click just BEFORE the
 * tap (if the tap is late enough relative to it) rather than the click the
 * tap is nominally "near". A tap that qualifies for no click at all isn't
 * attributable to any specific one (a genuine miss, a double-tap, noise)
 * and is rejected outright rather than paired with something distant.
 * @param {number[]} tapTimes - AudioContext-time of each tap
 * @param {number[]} clickTimes - AudioContext-time of each metronome click
 * @param {number} beatDurSec
 * @returns {{offsetsMs:number[], rejectedCount:number}}
 */
export function pairTapsToClicks(tapTimes, clickTimes, beatDurSec) {
  const lowBound = -EARLY_FRAC * beatDurSec;
  const highBound = LATE_FRAC * beatDurSec;
  const offsetsMs = [];
  let rejectedCount = 0;
  for (const t of tapTimes) {
    let bestAbsDt = Infinity;
    let bestOffsetSec = null;
    for (const c of clickTimes) {
      const dt = t - c;
      if (dt < lowBound || dt >= highBound) continue; // outside the window for THIS click
      const absDt = Math.abs(dt);
      if (absDt < bestAbsDt) {
        bestAbsDt = absDt;
        bestOffsetSec = dt;
      }
    }
    if (bestOffsetSec === null) {
      rejectedCount++;
      continue;
    }
    offsetsMs.push(bestOffsetSec * 1000);
  }
  return { offsetsMs, rejectedCount };
}

/**
 * True if `tapTime` arrived during the count-in (strictly before the
 * window that would let it pair with the first RECORDED click) and should
 * therefore not count as one of the recorded taps at all. Filtering by
 * TIME - not by waiting for a specific tap count - is what keeps an eager
 * early tap from ever reintroducing the old count-based pairing bug: it
 * simply never enters the recorded-taps array in the first place.
 * @param {number} tapTime
 * @param {number} firstClickTime - AudioContext-time of the first RECORDED click
 * @param {number} beatDurSec
 */
export function isCountInTap(tapTime, firstClickTime, beatDurSec) {
  return tapTime < firstClickTime - EARLY_FRAC * beatDurSec;
}

/**
 * MAD-based outlier rejection, then a sanity range check. Returns `ok:false`
 * (with a human-readable `reason`) whenever the input doesn't support a
 * trustworthy result - the caller re-runs calibration in that case rather
 * than storing a guess. Never returns a value outside
 * [MIN_OFFSET_MS, MAX_OFFSET_MS]; a median outside that range is treated as
 * "that didn't look right" instead of silently clamped and stored, since a
 * reading that extreme is more likely to mean the pairing went wrong than a
 * genuine (if laggy) device. The range is asymmetric - a big LATE offset is
 * plausible (Bluetooth), a big EARLY one much less so.
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
  if (finalMedian < MIN_OFFSET_MS || finalMedian > MAX_OFFSET_MS) {
    return {
      ok: false,
      reason: `That didn't look right (measured ${finalMedian.toFixed(0)}ms, outside the expected range) - let's try again.`,
    };
  }
  return {
    ok: true,
    offsetMs: finalMedian,
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
