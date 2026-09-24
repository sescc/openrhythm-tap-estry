// tests/judging_e2e_test.mjs
// Plan M1.6 section F, second bullet: "the test that would have caught the
// bug". Drives js/input.js's createJudge() directly at KNOWN offsets: taps
// within the Perfect/Good windows must be judged as such, and taps far
// outside must be ignored AND report a correct signed deltaMs - the exact
// self-diagnosis readout the original zero-hits bug report had no way to
// see (every ignored tap used to report nothing but a bare timestamp).
// Run directly with `node tests/judging_e2e_test.mjs`, or via `node tests/run.mjs`.

import { subRng } from '../js/rng.js';
import { buildChart } from '../js/songform.js';
import { toAbsoluteChart } from '../js/chart.js';
import { GAMES } from '../js/games/index.js';
import { createJudge } from '../js/input.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

const game = GAMES.find((g) => g.id === 'echo');
const rng = subRng('e2e-judging-test', 'chart');
const chart = buildChart(rng, game, 1, {});
const abs = toAbsoluteChart(chart, 1000);

// Only test plain taps (not holds/fakes) for this pass/fail-window check.
const plainTaps = abs.notes.filter((n) => n.kind === 'tap' && !n.fake);
assert(plainTaps.length > 5, 'sanity: chart should have several plain tap notes');

// --- Part 1: taps at +-30ms must be judged Perfect/Good (0ms calibration) ---
{
  const judgedEvents = [];
  const judge = createJudge(
    plainTaps.map((n) => ({ ...n, judged: false, judgement: null })),
    { calibrationOffsetSec: 0, onJudged: (e) => judgedEvents.push(e) }
  );
  plainTaps.forEach((n, i) => {
    const sign = i % 2 === 0 ? 1 : -1;
    judge.judgeTap(n.time + sign * 0.03, 'test'); // +-30ms
  });
  for (const e of judgedEvents) {
    assert(
      e.type === 'judged' && (e.judgement === 'perfect' || e.judgement === 'good'),
      `+-30ms tap should be perfect/good, got ${JSON.stringify(e.type === 'judged' ? e.judgement : e.type)}`
    );
  }
  assert(judgedEvents.length === plainTaps.length, `expected ${plainTaps.length} judged events, got ${judgedEvents.length}`);
}

// --- Part 2 & 3: taps at +-600ms (this IS the M1.5/M1.6 bug's failure mode)
// must be ignored AND report ~600ms in the new deltaMs readout. Uses a
// PURPOSE-BUILT sparse/widely-spaced synthetic note list (real charts pack
// notes close enough that a +-600ms-shifted tap can alias onto a DIFFERENT
// real note and get legitimately judged against THAT one instead - a
// realistic side effect of dense charts, not a bug, but a confound for this
// specific "known offset -> known outcome" check). ------------------------
{
  const sparseNotes = [];
  for (let i = 0; i < 10; i++) sparseNotes.push({ kind: 'tap', time: 1000 + i * 3, judged: false, judgement: null });

  for (const sign of [1, -1]) {
    const judgedEvents = [];
    const judge = createJudge(
      sparseNotes.map((n) => ({ ...n })),
      { calibrationOffsetSec: 0, onJudged: (e) => judgedEvents.push(e) }
    );
    sparseNotes.forEach((n) => judge.judgeTap(n.time + sign * 0.6, 'test'));
    assert(judgedEvents.length === sparseNotes.length, `expected ${sparseNotes.length} ignored events, got ${judgedEvents.length}`);
    for (const e of judgedEvents) {
      assert(e.type === 'ignored', `${sign * 600}ms-off tap should be ignored, got type=${e.type}`);
      assert(e.deltaMs != null, 'ignored event must carry a non-null deltaMs');
      assert(Math.abs(e.deltaMs - sign * 600) < 5, `deltaMs should read ~${sign * 600}ms, got ${e.deltaMs}`);
      assert(e.nearestNote != null, 'ignored event must carry a nearestNote reference');
    }
  }
}

const ok = failures === 0;
console.log(ok ? 'PASS - judging end-to-end checks passed' : `FAIL - ${failures} check(s) failed`);
if (!ok) process.exitCode = 1;
