// js/games/triplet.js
// Triplet Juggle - 6/8 feel and hemiola (3 groups across 2). A "whoosh" cue
// announces a 3-toss run at triplet spacing (three catches spread evenly
// across the beat right after the whoosh); a "clap" cue means a single
// catch, right on the next beat. Both cues sit exactly 1 beat before what
// they predict, same pattern as every other game here.

export const id = 'triplet';
export const name = 'Triplet Juggle';
export const mascot = { emoji: '🐰', label: 'the juggling rabbit' };
export const stylePrefs = { crayon: 2, ink: 2 };
export const groove = 'sixEight';
export const cueTypes = [
  { id: 'whoosh', meaning: 'a 3-toss run follows, spaced in triplets', glyph: '〜' },
  { id: 'clap', meaning: 'a single catch, right on the beat', glyph: '❖' },
];
export const practice = [
  { cueId: 'whoosh', caption: '🐰 A whoosh means three quick catches, evenly spread across the next beat.' },
  { cueId: 'clap', caption: '🐰 A clap means just one catch, right on the beat.' },
];

export function soundPack(rng) {
  const base = 1400 + rng.int(-150, 200);
  return {
    cues: {
      whoosh: { voice: 'noise', dur: 0.22, gain: 0.3, filterType: 'bandpass', filterFreq: base * 0.5 },
      clap: { voice: 'noise', dur: 0.06, gain: 0.42, filterType: 'highpass', filterFreq: base },
    },
    response: {
      tapGood: { voice: 'tone', wave: 'triangle', freq: base * 0.6, dur: 0.1, attack: 0.004, gain: 0.45 },
      tapMiss: { voice: 'noise', dur: 0.07, gain: 0.28, filterType: 'lowpass', filterFreq: 600 },
      holdSustain: { voice: 'tone', wave: 'triangle', freq: base * 0.4, dur: 0.3, attack: 0.05, gain: 0.18 },
      holdRelease: { voice: 'tone', wave: 'triangle', freq: base * 0.8, dur: 0.1, attack: 0.004, gain: 0.42 },
    },
  };
}

export function compose(rng, levelParams, beats, kind) {
  const events = [];
  const cues = [];
  const forceWhoosh = kind === 'teachA';
  const forceClap = kind === 'teachB';

  const teaching = forceWhoosh || forceClap;
  let cursor = 0;
  let guard = 0;
  while (cursor < beats - 1.5 && guard < 8) {
    guard++;
    // Triplet runs pack 3 judged taps into 1 beat, so this is naturally the
    // densest game - non-teaching sections lean a bit more on the sparser
    // single-clap catch, and get an occasional breath between runs, so the
    // whole song doesn't run far denser than every other minigame.
    const useWhoosh = forceWhoosh ? true : forceClap ? false : rng.chance(0.45);
    // Rest chance scales gently with level: higher levels already pack more
    // (shorter, tempo-driven) sections into the same ~70s target, so the
    // per-run breather needs to grow too or the highest levels would run
    // far denser than everything else even after the base rate above.
    const restChance = teaching ? 0 : Math.min(0.6, 0.35 + levelParams.level * 0.02);
    const rest = rng.chance(restChance) ? 1 : 0;
    if (useWhoosh) {
      if (cursor + 3 + rest > beats) break;
      cues.push({ beat: cursor, cueId: 'whoosh', variant: 0 });
      [0, 1 / 3, 2 / 3].forEach((o, i) => events.push({ beat: cursor + 1 + o, kind: 'tap', cueId: 'whoosh', variant: i }));
      cursor += 3 + rest;
    } else {
      if (cursor + 2 + rest > beats) break;
      cues.push({ beat: cursor, cueId: 'clap', variant: 0 });
      events.push({ beat: cursor + 1, kind: 'tap', cueId: 'clap' });
      cursor += 2 + rest;
    }
  }

  if (events.length === 0) {
    cues.push({ beat: 0, cueId: 'clap', variant: 0 });
    events.push({ beat: 1, kind: 'tap', cueId: 'clap' });
  }

  return { events, cues };
}
