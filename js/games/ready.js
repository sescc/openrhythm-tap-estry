// js/games/ready.js
// Ready-Set-Go - two rising-pitch cues (same cueId, variant 0 then 1) a gap
// `d` apart; tap `d` after the second. A "slow horn" variant (a distinct,
// lower-timbre cueId) doubles the gap. Because the SECOND cue is exactly
// `d` before the tap and the FIRST is `2d` before it, using one cueId for
// both means the learnability lint always finds a qualifying cue (the
// first one) at least 1 beat before the response, even for d as small as
// half a beat - see js/songform.js lintChart().

function allowedGaps(level) {
  if (level >= 7) return [1, 0.5, 1.5, 0.75];
  if (level >= 5) return [1, 0.5, 1.5];
  if (level >= 3) return [1, 0.5];
  return [1];
}

export const id = 'ready';
export const name = 'Ready-Set-Go';
export const mascot = { emoji: '🐸', label: 'the frog' };
export const stylePrefs = { geometric: 3, pixel: 2 };
export const groove = 'straight';
export const cueTypes = [
  { id: 'readygo', meaning: 'tap the same gap again, after "set"', glyph: '▲' },
  { id: 'readygoSlow', meaning: 'a low horn - the same rule, but the gap is doubled', glyph: '▽' },
];
export const practice = [
  { cueId: 'readygo', caption: '🐸 Ready... set... - tap that same gap again.' },
  { cueId: 'readygoSlow', caption: '📯 A low horn means the gap doubles. Same rule, slower.' },
];

export function soundPack(rng) {
  const base = 520 + rng.int(-40, 60);
  return {
    cues: {
      readygo: { voice: 'tone', wave: 'square', freq: base, dur: 0.1, attack: 0.004, gain: 0.35, pitchStepMul: 1.5 },
      readygoSlow: { voice: 'tone', wave: 'sine', freq: base * 0.6, dur: 0.22, attack: 0.01, gain: 0.4, pitchStepMul: 1.3 },
    },
    response: {
      tapGood: { voice: 'tone', wave: 'square', freq: base * 1.9, dur: 0.1, attack: 0.003, gain: 0.5 },
      tapMiss: { voice: 'noise', dur: 0.06, gain: 0.3, filterType: 'bandpass', filterFreq: 700 },
      holdSustain: { voice: 'tone', wave: 'square', freq: base, dur: 0.3, attack: 0.05, gain: 0.2 },
      holdRelease: { voice: 'tone', wave: 'square', freq: base * 2, dur: 0.1, attack: 0.003, gain: 0.45 },
    },
  };
}

export function compose(rng, levelParams, beats, kind) {
  const events = [];
  const cues = [];
  const teaching = kind === 'teachA' || kind === 'teachB';
  const gaps = teaching ? [1] : allowedGaps(levelParams.level);
  const slowAllowed = levelParams.level >= 4 && !teaching;

  // Non-teaching sections weight the smaller gaps a bit more heavily (every
  // value in `gaps` is still reachable, so the level's full gap variety is
  // still taught/tested) - shorter launches mean more of them fit per
  // section instead of 1-2 launches followed by a long silent tail.
  const gapPool = teaching ? gaps : gaps.concat(gaps.filter((g) => g <= 0.75));

  let cursor = 0;
  let guard = 0;
  while (cursor < beats - 1.5 && guard < 14) {
    guard++;
    const useSlow =
      slowAllowed && (kind === 'teachB' || kind === 'varyB' || kind === 'combine' || kind === 'finale') && rng.chance(kind === 'teachB' ? 1 : 0.35);
    const baseD = rng.pick(gapPool);
    const cueId = useSlow ? 'readygoSlow' : 'readygo';
    const d = useSlow ? baseD * 2 : baseD;
    const launchLen = d * 2;
    // Only the response itself needs to fit, with a small margin - not a
    // full extra beat of headroom past it (that silently capped density).
    if (cursor + launchLen > beats - 0.25) break;

    cues.push({ beat: cursor, cueId, variant: 0 });
    cues.push({ beat: cursor + d, cueId, variant: 1 });
    events.push({ beat: cursor + 2 * d, kind: 'tap', cueId });

    // "Chained launches" (plan level knob): teaching sections always get a
    // full beat of rest to land the pattern clearly; everywhere else the
    // next launch's "ready" often starts soon after the previous response
    // (never AT it - that would bury the response's own tap sfx under the
    // next cue), so a section doesn't sit half-empty once the gap is small.
    const rest = teaching ? 1 : rng.pick([0, 0.5, 0.5, 1]);
    cursor += launchLen + rest;
  }

  if (events.length === 0) {
    cues.push({ beat: 0, cueId: 'readygo', variant: 0 });
    cues.push({ beat: 1, cueId: 'readygo', variant: 1 });
    events.push({ beat: 2, kind: 'tap', cueId: 'readygo' });
  }

  return { events, cues };
}
