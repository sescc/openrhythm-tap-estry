// js/games/bounce.js
// Bouncy Ball - a ball bounces ("boing") at a fixed spacing; tap on the
// next landing after the bouncing sound stops. A squeaky boing halves the
// spacing (speed-up). At higher levels the very last bounce before the tap
// can be silent (hidden) - still predictable because at least two bounces
// at the CURRENT spacing always sound first (see the squeakyAt clamp in
// compose(), which exists specifically to keep the learnability lint
// satisfied when a bounce goes silent).

export const id = 'bounce';
export const name = 'Bouncy Ball';
export const mascot = { emoji: '🦦', label: 'the otter' };
export const stylePrefs = { pixel: 3, crayon: 1 };
export const groove = 'straight';
export const cueTypes = [
  { id: 'boing', meaning: 'the ball is bouncing - tap the next landing after it stops', glyph: '●' },
  { id: 'boingSqueaky', meaning: 'the bounce sped up - same rule, faster spacing', glyph: '◎' },
];
export const practice = [
  { cueId: 'boing', caption: '🦦 Count the bounces. Tap the beat right after the LAST one.' },
  { cueId: 'boingSqueaky', caption: '🦦 A squeaky boing means the ball sped up - spacing halves.' },
];

export function soundPack(rng) {
  const base = 260 + rng.int(-30, 40);
  return {
    cues: {
      boing: { voice: 'tone', wave: 'sine', freq: base, freqEnd: base * 0.6, dur: 0.14, attack: 0.004, gain: 0.42 },
      boingSqueaky: { voice: 'tone', wave: 'sine', freq: base * 1.8, freqEnd: base * 1.1, dur: 0.09, attack: 0.003, gain: 0.4 },
    },
    response: {
      tapGood: { voice: 'tone', wave: 'triangle', freq: base * 2.2, dur: 0.12, attack: 0.004, gain: 0.5 },
      tapMiss: { voice: 'noise', dur: 0.08, gain: 0.32, filterType: 'lowpass', filterFreq: 900 },
      holdSustain: { voice: 'tone', wave: 'triangle', freq: base, dur: 0.3, attack: 0.05, gain: 0.22 },
      holdRelease: { voice: 'tone', wave: 'triangle', freq: base * 2, dur: 0.1, attack: 0.004, gain: 0.45 },
    },
  };
}

export function compose(rng, levelParams, beats, kind) {
  const events = [];
  const cues = [];
  const teaching = kind === 'teachA' || kind === 'teachB';
  const squeakyAllowed = levelParams.level >= 5 && !teaching;
  const hideAllowed = levelParams.level >= 7 && !teaching;

  let cursor = 0;
  let guard = 0;
  while (cursor < beats - 1.5 && guard < 16) {
    guard++;
    // A run only ever produces ONE judged event (the response tap - the
    // bounces themselves are unscored cues), so note density is entirely a
    // function of how many runs fit per section: non-teaching runs default
    // shorter (2-3 bounces, not 2-4) so more of them fit.
    const runLen = teaching ? 3 : rng.int(2, kind === 'finale' ? 5 : 3);
    // Clamped so at least 2 bounces share whichever cueId is nearest the
    // response - keeps a >=1-beat-earlier same-id cue available even if
    // the final bounce goes silent (see file header).
    const squeakyAt = squeakyAllowed && runLen >= 3 && rng.chance(0.4) ? rng.int(1, runLen - 2) : -1;
    const hideLast = hideAllowed && runLen >= 3 && rng.chance(0.3);

    let t = cursor;
    let gap = 1;
    const bounceBeats = [];
    const cueIdAt = (i) => (squeakyAt >= 0 && i >= squeakyAt ? 'boingSqueaky' : 'boing');
    for (let i = 0; i < runLen; i++) {
      gap = squeakyAt >= 0 && i >= squeakyAt ? 0.5 : 1;
      bounceBeats.push(t);
      t += gap;
    }
    const responseBeat = t;
    // Only the response tap itself needs to fit (with a small margin) -
    // the OLD check here also demanded a full extra beat of headroom past
    // it before considering a run at all, which silently capped every
    // section at ~1-2 runs regardless of how much room was actually left.
    if (responseBeat > beats - 0.5) break;

    bounceBeats.forEach((b, i) => {
      if (hideLast && i === bounceBeats.length - 1) return; // silent - still predictable, see above
      cues.push({ beat: b, cueId: cueIdAt(i), variant: i });
    });
    events.push({ beat: responseBeat, kind: 'tap', cueId: cueIdAt(bounceBeats.length - 1) });

    // Teaching sections keep a full beat of rest so the "count the bounces,
    // tap after they stop" rule lands clearly; elsewhere the next run
    // usually starts sooner (never right ON the previous response, so its
    // tap sfx and the next run's first bounce don't collide in the mix),
    // so a section fits more than one run instead of sitting quiet.
    cursor = responseBeat + (teaching ? 1 : rng.pick([0, 0, 0.5, 1]));
  }

  if (events.length === 0) {
    cues.push({ beat: 0, cueId: 'boing', variant: 0 });
    cues.push({ beat: 1, cueId: 'boing', variant: 1 });
    events.push({ beat: 2, kind: 'tap', cueId: 'boing' });
  }

  return { events, cues };
}
