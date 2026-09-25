// js/games/echo.js
// Echo Birds - the M1 call/response mechanic, ported into the generic
// minigame module interface (see js/games/index.js for the shape every
// module implements). A bird sings a short motif (the "chirp" cue); you
// echo it back one "half" later. A double-chirp (level 5+) means echo it
// twice as fast.

const MOTIFS = {
  simple: [[0, 1, 2]],
  '8th': [[0], [0, 1], [0, 1, 2], [0, 2, 3], [0, 0.5, 1, 2], [0, 1, 1.5, 3], [0, 2, 2.5]],
  '16th': [[0, 0.5, 0.75, 1.5], [0, 0.25, 0.5, 1, 2], [0, 0.75, 1, 1.75, 2.5]],
  triplet: [
    [0, 1 / 3, 2 / 3, 1.5],
    [0, 2 / 3, 4 / 3, 2],
  ],
  // Only motifs whose onsets are >=1 beat apart go here - "double chirp"
  // HALVES onset spacing (see compose() below), so a motif with a 0.5-beat
  // gap would halve to 0.25 beat, which the learnability lint's 120ms
  // collision minimum can no longer guarantee at high tempo/level (e.g.
  // 0.25 beat @150bpm = 100ms). Doubling only ever draws from this pool,
  // regardless of level, so the halved gap is always >=0.5 beat (>=200ms
  // even at the 150bpm cap).
  doubleSafe: [[0], [0, 1], [0, 1, 2], [0, 2, 3], [0, 1, 3]],
};

function minGap(motif) {
  let g = Infinity;
  for (let i = 1; i < motif.length; i++) g = Math.min(g, motif[i] - motif[i - 1]);
  return g;
}

// Tempo rises with level (see js/songform.js levelParamsFor), so a motif
// that's safely >=120ms apart at a low-level tempo can drop below that at a
// high-level one - especially once halved for "double chirp". Every pool
// lookup filters by the CURRENT chart's beatDuration so the learnability
// lint's collision minimum holds at every level, not just the ones this was
// eyeballed against.
function motifPool(levelParams) {
  const beatDuration = 60 / levelParams.bpm;
  const minBeatGap = 0.125 / beatDuration; // 125ms safety margin over the 120ms lint minimum
  let pool = MOTIFS['8th'].slice();
  if (levelParams.subdivisions.includes('16th')) pool = pool.concat(MOTIFS['16th']);
  if (levelParams.subdivisions.includes('triplet')) pool = pool.concat(MOTIFS.triplet);
  // M1.8 gentler level 1: every judged response lands on a whole beat, so
  // the half-beat 8th-note motifs (e.g. [0,0.5,1,2]) are held back until
  // level 2 - its one variation (the off-beat pattern reappears exactly as
  // it always did from level 2 up; nothing here changes level 2+).
  if (levelParams.level === 1) pool = pool.filter((m) => m.every((b) => Number.isInteger(b)));
  const filtered = pool.filter((m) => minGap(m) >= minBeatGap);
  return filtered.length > 0 ? filtered : MOTIFS['8th'];
}

function motifSpan(motif) {
  return Math.max(...motif) + 1;
}

export const id = 'echo';
export const name = 'Echo Birds';
export const mascot = { emoji: '🐦', label: 'the bird' };
export const stylePrefs = { watercolor: 2, crayon: 2 };
export const groove = 'straight';
export const cueTypes = [
  { id: 'chirp', meaning: 'copy the tune you just heard', glyph: '♪' },
  { id: 'doubleChirp', meaning: 'copy it - twice as fast', glyph: '♪♪' },
];
export const practice = [
  { cueId: 'chirp', caption: '🐦 A chirp sings a little tune. Copy it back.' },
  { cueId: 'doubleChirp', caption: '🐦🐦 A double chirp means copy it TWICE as fast.' },
];

export function soundPack(rng) {
  const base = 640 + rng.int(-60, 80);
  return {
    cues: {
      chirp: { voice: 'tone', wave: 'triangle', freq: base, freqEnd: base * 1.3, dur: 0.16, attack: 0.008, gain: 0.4, pitchStepMul: 1.08 },
      doubleChirp: { voice: 'tone', wave: 'triangle', freq: base * 1.25, freqEnd: base * 1.6, dur: 0.11, attack: 0.006, gain: 0.4, pitchStepMul: 1.1 },
    },
    response: {
      tapGood: { voice: 'tone', wave: 'sine', freq: base * 1.5, dur: 0.13, attack: 0.004, gain: 0.5 },
      tapMiss: { voice: 'noise', dur: 0.07, gain: 0.3, filterType: 'bandpass', filterFreq: 500 },
      holdSustain: { voice: 'tone', wave: 'sine', freq: base, dur: 0.3, attack: 0.05, gain: 0.25 },
      holdRelease: { voice: 'tone', wave: 'sine', freq: base * 1.6, dur: 0.12, attack: 0.004, gain: 0.45 },
    },
  };
}

/**
 * @param {object} rng - chart RNG stream
 * @param {object} levelParams - see js/songform.js levelParamsFor()
 * @param {number} beats - length of this section, in quarter-note beats
 * @param {string} kind - 'teachA'|'varyA'|'teachB'|'varyB'|'combine'|'breather'|'finale'
 */
export function compose(rng, levelParams, beats, kind) {
  const events = [];
  const cues = [];
  const doubleAllowed = levelParams.level >= 5;
  const teaching = kind === 'teachA' || kind === 'teachB';
  const pool = teaching ? MOTIFS.simple : motifPool(levelParams);

  let cursor = 0;
  let guard = 0;
  while (cursor < beats - 1.5 && guard < 8) {
    guard++;
    const wantDouble =
      doubleAllowed && (kind === 'teachB' || kind === 'varyB' || kind === 'combine' || kind === 'finale') && rng.chance(kind === 'teachB' ? 1 : 0.5);
    const motif = wantDouble ? rng.pick(MOTIFS.doubleSafe) : rng.pick(pool);
    const span = motifSpan(motif);
    const pairLen = Math.max(2, Math.ceil(span));
    if (cursor + pairLen * 2 > beats) break;

    const cueId = wantDouble ? 'doubleChirp' : 'chirp';
    motif.forEach((b, i) => cues.push({ beat: cursor + b, cueId, variant: i }));
    const respMotif = wantDouble ? motif.map((b) => b / 2) : motif;
    const respStart = cursor + pairLen;
    respMotif.forEach((b, i) => events.push({ beat: respStart + b, kind: 'tap', cueId, variant: i }));

    cursor += pairLen * 2;
  }

  if (events.length === 0) {
    // Breather / anything too short for a full pair: one slow single note.
    cues.push({ beat: 0, cueId: 'chirp', variant: 0 });
    events.push({ beat: Math.min(beats - 0.5, beats / 2), kind: 'tap', cueId: 'chirp', variant: 0 });
  }

  return { events, cues };
}
