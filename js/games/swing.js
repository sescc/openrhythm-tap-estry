// js/games/swing.js
// Swing Samurai - swung off-beat slashes: the "and" of the beat sits at 2/3
// of the way through it (SWING below), not halfway. A run of woodblock
// hits establishes the swung grid (the first hit or two are an unscored
// demo); every later hit in the run is a judged tap at the same grid.
//
// Fakes ("bonk", do NOT tap) get a distinct advance "tell": the tell sound
// fires exactly 1 beat BEFORE the grid slot it warns about (same pattern as
// js/games/pump.js's priming ticks), and the grid slot itself then stays
// silent - nothing plays there, nothing should be tapped there. This keeps
// fakes genuinely learnable (a real advance warning, not a same-instant
// reflex test) and keeps the learnability lint's "cue >=1 beat earlier"
// rule uniform across every game.

const SWING = 2 / 3;

export const id = 'swing';
export const name = 'Swing Samurai';
export const mascot = { emoji: '🦊', label: 'the samurai fox' };
export const stylePrefs = { neon: 3, ink: 1 };
export const groove = 'swing';
export const cueTypes = [
  { id: 'woodblock', meaning: 'slash on the swung "and"', glyph: '▮' },
  { id: 'bonk', meaning: 'a fake is coming one beat from now - do NOT tap that slot', glyph: '✕' },
];
export const practice = [
  { cueId: 'woodblock', caption: '🦊 Slash right on the wood-block click - it sits just after the beat.' },
  { cueId: 'bonk', caption: '🦊 A bonk means the NEXT click is a trick. Freeze - do not slash.' },
];

export function soundPack(rng) {
  const base = 900 + rng.int(-80, 100);
  return {
    cues: {
      woodblock: { voice: 'noise', dur: 0.05, gain: 0.4, filterType: 'bandpass', filterFreq: base },
      bonk: { voice: 'tone', wave: 'square', freq: base * 0.25, dur: 0.1, attack: 0.003, gain: 0.32, filterType: 'lowpass', filterFreq: 400 },
    },
    response: {
      tapGood: { voice: 'noise', dur: 0.06, gain: 0.46, filterType: 'bandpass', filterFreq: base * 1.3 },
      tapMiss: { voice: 'tone', wave: 'square', freq: base * 0.2, dur: 0.12, attack: 0.003, gain: 0.32 },
      holdSustain: { voice: 'tone', wave: 'square', freq: base * 0.5, dur: 0.3, attack: 0.05, gain: 0.18 },
      holdRelease: { voice: 'noise', dur: 0.08, gain: 0.42, filterType: 'bandpass', filterFreq: base },
    },
  };
}

export function compose(rng, levelParams, beats, kind) {
  const events = [];
  const cues = [];
  const teaching = kind === 'teachA';
  const fakeAllowed = kind !== 'teachA' && levelParams.fakeRate > 0;
  let forceFakeOnce = kind === 'teachB' && fakeAllowed;

  let cursor = 0;
  let guard = 0;
  while (cursor < beats - 1.5 && guard < 8) {
    guard++;
    const runLen = teaching ? 3 : rng.int(3, kind === 'finale' ? 6 : 5);
    const demoCount = teaching ? 2 : 1;
    if (cursor + runLen + 1 > beats) break;

    for (let i = 0; i < runLen; i++) {
      const slotBeat = cursor + i + SWING;
      if (i < demoCount) {
        cues.push({ beat: slotBeat, cueId: 'woodblock', variant: Math.min(i, 3) });
        continue;
      }
      const doFake = i >= demoCount + 1 && (forceFakeOnce || (fakeAllowed && rng.chance(levelParams.fakeRate)));
      if (doFake) {
        forceFakeOnce = false;
        cues.push({ beat: slotBeat - 1, cueId: 'bonk', variant: 0, fake: true });
        events.push({ beat: slotBeat, kind: 'tap', cueId: 'bonk', fake: true });
      } else {
        cues.push({ beat: slotBeat, cueId: 'woodblock', variant: Math.min(i, 3) });
        events.push({ beat: slotBeat, kind: 'tap', cueId: 'woodblock' });
      }
    }
    cursor += runLen + 1;
  }

  if (events.length === 0) {
    cues.push({ beat: SWING, cueId: 'woodblock', variant: 0 });
    cues.push({ beat: 1 + SWING, cueId: 'woodblock', variant: 1 });
    events.push({ beat: 1 + SWING, kind: 'tap', cueId: 'woodblock' });
  }

  return { events, cues };
}
