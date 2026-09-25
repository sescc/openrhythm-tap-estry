// js/practice.js
// Pure practice-round outcome logic - no DOM/audio - directly unit-testable
// via a plain Node import (same pattern as js/calibration.js). Lives apart
// from js/main.js's own practiceAttemptRound() (which owns all the DOM/
// audio/judge wiring) so the pass/fail/interrupted decision itself can be
// tested without a browser.

export const PRACTICE_PASS_RATIO = 0.7; // matches the real game's own clear threshold

/**
 * Resolve a completed practice round's outcome from its raw tally.
 * - 'interrupted': the round was backgrounded (tab hidden/blurred) at some
 *   point during it - never a pass or a fail, the caller re-runs the SAME
 *   round (not counted against the round limit).
 * - 'fail': zero judged notes (e.g. rAF never ticked because the tab was
 *   backgrounded, so judge.update()'s own auto-miss sweep never ran - this
 *   used to silently read as a pass, `tally.total > 0 ? ... : true`, which
 *   is the exact bug this function exists to fix), or a good ratio below
 *   PRACTICE_PASS_RATIO.
 * - 'pass': good/total >= PRACTICE_PASS_RATIO, with total > 0.
 * @param {{good:number, total:number, interrupted:boolean}} stats
 * @returns {'pass'|'fail'|'interrupted'}
 */
export function practiceRoundOutcome({ good, total, interrupted }) {
  if (interrupted) return 'interrupted';
  if (total === 0) return 'fail';
  return good / total >= PRACTICE_PASS_RATIO ? 'pass' : 'fail';
}
