// tests/practice_test.mjs
// Regression test for the practice "false pass" bug: a round where rAF
// never ticked (the tab was backgrounded) used to resolve with
// `tally.total === 0` and read `passed = tally.total > 0 ? ... : true` as
// an automatic PASS - confirmed live, "2 passed" with zero taps judged.
// js/practice.js's practiceRoundOutcome() is the pure fix: a round with no
// judged notes is always 'fail', and a round flagged 'interrupted'
// (backgrounded mid-round) is neither a pass nor a fail at all - the caller
// (js/main.js practiceAttemptRound/runPracticeSteps) re-runs it instead.
// Run directly with `node tests/practice_test.mjs`, or via
// `node tests/run.mjs`.

import { practiceRoundOutcome, PRACTICE_PASS_RATIO } from '../js/practice.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

// --- 1. THE bug trigger: zero judged notes (rAF never ticked) must be a
// FAIL, never the old "tally.total > 0 ? ... : true" false pass. ----------
{
  const outcome = practiceRoundOutcome({ good: 0, total: 0, interrupted: false });
  assert(outcome === 'fail', `zero judged notes: expected 'fail', got '${outcome}'`);
}

// --- 2. Zero judged notes AND interrupted: 'interrupted' wins (never
// silently counted as a fail either - it just gets re-run). --------------
{
  const outcome = practiceRoundOutcome({ good: 0, total: 0, interrupted: true });
  assert(outcome === 'interrupted', `zero notes + interrupted: expected 'interrupted', got '${outcome}'`);
}

// --- 3. A genuinely interrupted round with real judged notes is STILL
// 'interrupted', not scored on whatever partial data it collected. -------
{
  const outcome = practiceRoundOutcome({ good: 5, total: 5, interrupted: true });
  assert(outcome === 'interrupted', `interrupted with a perfect partial tally: expected 'interrupted', got '${outcome}'`);
}

// --- 4. A normal pass: good ratio at or above PRACTICE_PASS_RATIO. -------
{
  const total = 10;
  const good = Math.ceil(total * PRACTICE_PASS_RATIO); // exactly at the bar
  const outcome = practiceRoundOutcome({ good, total, interrupted: false });
  assert(outcome === 'pass', `${good}/${total} (>= ${PRACTICE_PASS_RATIO}): expected 'pass', got '${outcome}'`);
}

// --- 5. A normal fail: good ratio below PRACTICE_PASS_RATIO. -------------
{
  const outcome = practiceRoundOutcome({ good: 1, total: 10, interrupted: false });
  assert(outcome === 'fail', `1/10 (< ${PRACTICE_PASS_RATIO}): expected 'fail', got '${outcome}'`);
}

// --- 6. A single judged note that's good is still a pass (ratio 1). ------
{
  const outcome = practiceRoundOutcome({ good: 1, total: 1, interrupted: false });
  assert(outcome === 'pass', `1/1: expected 'pass', got '${outcome}'`);
}

// --- 7. A single judged note that's a miss is a fail (ratio 0). ----------
{
  const outcome = practiceRoundOutcome({ good: 0, total: 1, interrupted: false });
  assert(outcome === 'fail', `0/1: expected 'fail', got '${outcome}'`);
}

const ok = failures === 0;
console.log(ok ? 'PASS - practice round outcome checks passed' : `FAIL - ${failures} check(s) failed`);
if (!ok) process.exitCode = 1;
