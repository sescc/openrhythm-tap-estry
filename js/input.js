// js/input.js
// Turns pointerdown/pointerup/keydown/keyup into judged taps and hold
// press/release against a chart's event list. Owns the judging state
// machine; js/main.js just wires createJudge() to a DOM element and to its
// per-frame update() call.
//
// M1.5 additions over M1: holds (press judged separately from release) and
// fakes (a tap near a fake = Miss; correctly NOT tapping a fake = a
// successful "avoided" outcome, judged silently once its window passes).

import { eventToContextTime, now as clockNow } from './clock.js';

const PERFECT_WINDOW = 0.045; // seconds
const GOOD_WINDOW = 0.09;
const MISS_WINDOW = 0.15; // unhit notes auto-miss this long after their time
const FAKE_WINDOW = 0.12; // a tap within this of a fake = Miss (the "bonk")

const RANK = { perfect: 2, good: 1 };
function classify(absDt) {
  if (absDt <= PERFECT_WINDOW) return 'perfect';
  if (absDt <= GOOD_WINDOW) return 'good';
  return null;
}
function worseOf(a, b) {
  return RANK[a] <= RANK[b] ? a : b;
}

/**
 * @param {Array} notes - sorted ascending by `.time`, ABSOLUTE (AudioContext)
 *   time - see chart.js toAbsoluteChart(). Mutated in place. Each entry:
 *   { kind:'tap'|'hold', time, releaseTime?, fake?, judged, judgement }
 * @param {{calibrationOffsetSec?:number, onJudged?:Function}} opts
 *   onJudged receives:
 *     { type:'judged', note, judgement, offsetMs, source, phase, final }
 *       phase: 'tap' | 'holdPress' | 'holdRelease'
 *       final: true once the note's outcome (and its story reveal) is
 *         settled - false only for the intermediate holdPress event, which
 *         exists purely so the stage can pulse a "pressed" cue before the
 *         hold resolves on release.
 *       judgement: 'perfect' | 'good' | 'miss' | 'avoided'
 *         ('avoided' = a fake that was correctly left untapped - a success)
 *   or { type:'ignored', tapTime, source, nearestNote, nearestIndex, deltaMs }
 *       (stray tap/release, no penalty - nearestNote/deltaMs (signed, ms;
 *       positive = tap was LATE) are for self-diagnosis, see js/main.js -
 *       deltaMs is null only if the chart has no notes at all)
 */
export function createJudge(notes, opts = {}) {
  const calibrationOffsetSec = opts.calibrationOffsetSec || 0;
  const onJudged = opts.onJudged;

  let sweepFrom = 0; // notes before this index are fully judged; speeds up update()

  function advanceSweep() {
    while (sweepFrom < notes.length && notes[sweepFrom].judged) sweepFrom++;
  }

  function resolveFinal(note, judgement, offsetMs, source, phase) {
    note.judged = true;
    note.judgement = judgement;
    advanceSweep();
    onJudged?.({ type: 'judged', note, judgement, offsetMs, source, phase, final: true });
  }

  /** Nearest candidate note still awaiting a PRESS judgement (fakes and
   * plain taps included; a hold whose press already resolved is excluded -
   * it's waiting on judgeRelease, not another judgeTap). */
  function findPressCandidate(tapTime) {
    let best = -1;
    let bestDt = Infinity;
    for (let i = sweepFrom; i < notes.length; i++) {
      const n = notes[i];
      if (n.time - tapTime > MISS_WINDOW) break; // sorted by .time -> nothing closer ahead
      if (n.judged) continue;
      if (n.kind === 'hold' && n._pressResolved) continue;
      const dt = Math.abs(n.time - tapTime);
      if (dt < bestDt) {
        bestDt = dt;
        best = i;
      }
    }
    return best;
  }

  /** Nearest note in the WHOLE chart (any judged state, no MISS_WINDOW
   * cutoff) - purely diagnostic, for reporting "how far off was that tap"
   * even when it's nowhere near a live candidate (the M1.5 calibration bug
   * produced consistent ~600ms-off taps that findPressCandidate would never
   * even see, since they're well outside MISS_WINDOW - self-diagnosis needs
   * an unconditional answer, not "no candidate"). O(n) - only ever called
   * on a genuinely stray tap, not on the hot per-frame path. */
  function findNearestNoteAny(tapTime) {
    let best = -1;
    let bestDt = Infinity;
    for (let i = 0; i < notes.length; i++) {
      const dt = Math.abs(notes[i].time - tapTime);
      if (dt < bestDt) {
        bestDt = dt;
        best = i;
      }
    }
    return best;
  }

  /** Builds the diagnostic fields ({nearestNote, nearestIndex, deltaMs}) for
   * an ignored-tap event. Always does the full unconditional scan rather
   * than trusting findPressCandidate's own "best" as a hint: that search
   * stops as soon as it sees a note more than MISS_WINDOW ahead, WITHOUT
   * comparing that breaking note's own distance first - so right at the
   * boundary it can return a much-worse note than the true nearest one
   * (found and fixed via the calibration_test/judging_e2e_test M1.6
   * regression tests). Diagnostics need the true answer, not a fast one. */
  function ignoredDiagnostics(tapTime) {
    const idx = findNearestNoteAny(tapTime);
    if (idx < 0) return { nearestNote: null, nearestIndex: -1, deltaMs: null };
    return { nearestNote: notes[idx], nearestIndex: idx, deltaMs: (tapTime - notes[idx].time) * 1000 };
  }

  /** Nearest active hold (press already resolved, release still open),
   * matched by proximity to its OWN releaseTime - holds are not necessarily
   * contiguous with the sweep front since other notes can sit between a
   * hold's press and release times. */
  function findActiveHold(releaseTime) {
    let best = -1;
    let bestDt = Infinity;
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      if (n.kind !== 'hold' || !n._pressResolved || n.judged) continue;
      const dt = Math.abs(n.releaseTime - releaseTime);
      if (dt < bestDt) {
        bestDt = dt;
        best = i;
      }
    }
    return best;
  }

  /**
   * @param {number} rawContextTime - AudioContext-time of the press, BEFORE
   *   calibration is applied.
   */
  function judgeTap(rawContextTime, source = 'pointer') {
    const tapTime = rawContextTime - calibrationOffsetSec;
    const idx = findPressCandidate(tapTime);
    if (idx === -1) {
      onJudged?.({ type: 'ignored', tapTime, source, ...ignoredDiagnostics(tapTime) });
      return;
    }
    const note = notes[idx];
    const dt = tapTime - note.time;
    const absDt = Math.abs(dt);

    if (note.fake) {
      if (absDt <= FAKE_WINDOW) {
        resolveFinal(note, 'miss', dt * 1000, source, 'tap');
      } else {
        onJudged?.({ type: 'ignored', tapTime, source, ...ignoredDiagnostics(tapTime) });
      }
      return;
    }

    const judgement = classify(absDt);
    if (!judgement) {
      // Stray tap: nearest note exists but is outside the Good window.
      // Lenient per spec - ignore rather than penalize.
      onJudged?.({ type: 'ignored', tapTime, source, ...ignoredDiagnostics(tapTime) });
      return;
    }

    if (note.kind === 'hold') {
      note._pressResolved = true;
      note._pressJudgement = judgement;
      onJudged?.({ type: 'judged', note, judgement, offsetMs: dt * 1000, source, phase: 'holdPress', final: false });
      return;
    }

    resolveFinal(note, judgement, dt * 1000, source, 'tap');
  }

  /**
   * @param {number} rawContextTime - AudioContext-time of the release
   *   (pointerup/keyup/pointercancel/blur), BEFORE calibration.
   */
  function judgeRelease(rawContextTime, source = 'pointer') {
    const relTime = rawContextTime - calibrationOffsetSec;
    const idx = findActiveHold(relTime);
    if (idx === -1) return; // no hold currently pressed - nothing to release
    const note = notes[idx];
    const dt = relTime - note.releaseTime;
    const absDt = Math.abs(dt);
    const releaseJudgement = classify(absDt);
    // An early/late release fumbles the region outright; otherwise the
    // final grade can only be as good as the WEAKER of press and release.
    const final = releaseJudgement ? worseOf(note._pressJudgement, releaseJudgement) : 'miss';
    resolveFinal(note, final, dt * 1000, source, 'holdRelease');
  }

  /** Call once per animation frame with the current AudioContext time. */
  function update(contextNow) {
    // M1.7 fix: this used to compare the raw scheduling clock (contextNow)
    // directly against note.time, while judgeTap/judgeRelease compare
    // against `rawContextTime - calibrationOffsetSec`. On a device with a
    // large positive (late) offset - e.g. Bluetooth, ~250ms - a note was
    // auto-missed here at contextNow > note.time + MISS_WINDOW (150ms)
    // BEFORE the player's correspondingly-late real tap ever arrived at
    // judgeTap, so every tap on such a device was "ignored" against an
    // already-judged note no matter how well calibrated. `heard` puts this
    // sweep in the SAME reference frame judgeTap/judgeRelease use.
    const heard = contextNow - calibrationOffsetSec;
    // Not early-exited on first not-yet-due note: a hold's controlling
    // deadline is its releaseTime, not its (sort-key) press time, so later
    // array entries can become due before an earlier hold's release does.
    for (let i = sweepFrom; i < notes.length; i++) {
      const n = notes[i];
      if (n.judged) continue;
      if (n.kind === 'hold' && n._pressResolved) {
        if (heard - n.releaseTime > MISS_WINDOW) {
          resolveFinal(n, 'miss', null, 'auto', 'holdRelease');
        }
        continue;
      }
      if (n.fake) {
        if (heard - n.time > FAKE_WINDOW) {
          resolveFinal(n, 'avoided', null, 'auto', 'tap');
        }
        continue;
      }
      if (heard - n.time > MISS_WINDOW) {
        resolveFinal(n, 'miss', null, 'auto', 'tap');
      }
    }
    advanceSweep();
  }

  return { judgeTap, judgeRelease, update, notes };
}

/**
 * Attach pointerdown/pointerup/pointercancel + keydown/keyup listeners.
 * Converts events to raw (pre-calibration) AudioContext time and hands them
 * to onPress / onRelease. pointercancel and window blur are both treated as
 * an immediate release (per spec - a lost hold shouldn't hang forever).
 * Returns a detach function.
 */
export function attachInput(stageEl, onPress, onRelease) {
  stageEl.style.touchAction = 'none';

  const handleDown = (e) => {
    e.preventDefault();
    onPress(eventToContextTime(e.timeStamp), 'pointer');
  };
  const handleUp = (e) => {
    e.preventDefault();
    onRelease?.(eventToContextTime(e.timeStamp), 'pointer');
  };
  const handleCancel = (e) => {
    onRelease?.(eventToContextTime(e.timeStamp), 'pointer');
  };
  const handleKeyDown = (e) => {
    if (e.repeat) return;
    onPress(eventToContextTime(e.timeStamp), 'key');
  };
  const handleKeyUp = (e) => {
    onRelease?.(eventToContextTime(e.timeStamp), 'key');
  };
  // No DOM event timestamp for a blur - fall back to the clock's own "now".
  const handleBlur = () => {
    onRelease?.(clockNow(), 'blur');
  };

  stageEl.addEventListener('pointerdown', handleDown, { passive: false });
  stageEl.addEventListener('pointerup', handleUp, { passive: false });
  stageEl.addEventListener('pointercancel', handleCancel, { passive: false });
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleBlur);

  return () => {
    stageEl.removeEventListener('pointerdown', handleDown);
    stageEl.removeEventListener('pointerup', handleUp);
    stageEl.removeEventListener('pointercancel', handleCancel);
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    window.removeEventListener('blur', handleBlur);
  };
}

export { PERFECT_WINDOW, GOOD_WINDOW, MISS_WINDOW, FAKE_WINDOW };
