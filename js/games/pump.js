// js/games/pump.js
// Balloon Pump (hold). A short "get ready" tick always sits exactly 1 beat
// before what it precedes - 'pumpTick' before a hold's press, 'tapTick'
// before a lone tap - so both are predictable the same simple way the
// learnability lint checks. The hold's RELEASE is intentionally exempt from
// that same check (see js/songform.js lintChart() header): the whistle
// cue's rise rate never changes, so its pitch at any instant already tells
// you how much longer to hold - hold length (1-4 beats) can vary by level
// without breaking predictability, because the rate, not the length, is
// what's fixed and audible throughout.

export const id = 'pump';
export const name = 'Balloon Pump';
export const mascot = { emoji: '🦉', label: 'the owl' };
export const stylePrefs = { crayon: 3, watercolor: 1 };
export const groove = 'halftime';
export const cueTypes = [
  { id: 'pumpTick', meaning: 'get ready - a hold is coming', glyph: '↕' },
  { id: 'tapTick', meaning: 'get ready - a single tap is coming', glyph: '↓' },
];
export const practice = [
  { cueId: 'pumpTick', caption: '🦉 A low tick means: press and HOLD. Release when the whistle tops out.' },
  { cueId: 'tapTick', caption: '🦉 A high tick means: just a single tap this time.' },
];

export function soundPack(rng) {
  const base = 320 + rng.int(-30, 50);
  return {
    cues: {
      pumpTick: { voice: 'tone', wave: 'square', freq: base * 0.7, dur: 0.05, attack: 0.003, gain: 0.28 },
      tapTick: { voice: 'tone', wave: 'square', freq: base * 1.6, dur: 0.05, attack: 0.003, gain: 0.26 },
      pump: { voice: 'sweep', wave: 'sawtooth', freqStart: base, freqEnd: base * 3.2, dur: 2, gain: 0.28 },
    },
    response: {
      tapGood: { voice: 'tone', wave: 'triangle', freq: base * 2.4, dur: 0.11, attack: 0.004, gain: 0.48 },
      tapMiss: { voice: 'noise', dur: 0.09, gain: 0.3, filterType: 'lowpass', filterFreq: 700 },
      holdSustain: { voice: 'tone', wave: 'sawtooth', freq: base * 1.4, dur: 0.3, attack: 0.06, gain: 0.16 },
      holdRelease: { voice: 'tone', wave: 'triangle', freq: base * 3.5, dur: 0.16, attack: 0.004, gain: 0.5 },
    },
  };
}

function holdLenOptions(level) {
  if (level >= 7) return [1, 2, 3, 4];
  if (level >= 4) return [1, 2];
  return [2];
}

export function compose(rng, levelParams, beats, kind) {
  const events = [];
  const cues = [];
  const forceHold = kind === 'teachA';
  const forceTap = kind === 'teachB';

  let cursor = 0;
  let guard = 0;
  while (cursor < beats - 1.5 && guard < 12) {
    guard++;
    // Non-teaching sections lean a bit less on holds (each one eats 4+
    // beats for a single judged event) and a bit more on the mixed-in taps
    // (2 beats each) - still "mostly holds, some taps", just enough to
    // keep density from trailing every other game.
    const doHold = forceHold ? true : forceTap ? false : rng.chance(0.55);

    if (doHold) {
      const holdBeats = forceHold ? 2 : rng.pick(holdLenOptions(levelParams.level));
      const tickBeat = cursor;
      const pressBeat = cursor + 1;
      const releaseBeat = pressBeat + holdBeats;
      // Only the release itself needs to fit, with a small margin - not a
      // full extra beat of headroom past it (that silently capped density).
      if (releaseBeat > beats - 0.5) break;
      cues.push({ beat: tickBeat, cueId: 'pumpTick', variant: 0 });
      cues.push({ beat: pressBeat, cueId: 'pump', variant: 0, spanBeats: holdBeats });
      events.push({ beat: pressBeat, kind: 'hold', releaseBeat, cueId: 'pumpTick' });
      // Teaching sections rest a full beat after the hold so the release
      // reads clearly; elsewhere the next tick often follows sooner, so a
      // section fits more holds/taps instead of a long silent tail.
      cursor = releaseBeat + (forceHold || forceTap ? 1 : rng.pick([0, 0.5, 0.5, 1]));
    } else {
      const tickBeat = cursor;
      const tapBeat = cursor + 1;
      if (tapBeat > beats - 0.5) break;
      cues.push({ beat: tickBeat, cueId: 'tapTick', variant: 0 });
      events.push({ beat: tapBeat, kind: 'tap', cueId: 'tapTick' });
      cursor = tapBeat + 1;
    }
  }

  if (events.length === 0) {
    cues.push({ beat: 0, cueId: 'pumpTick', variant: 0 });
    cues.push({ beat: 1, cueId: 'pump', variant: 0, spanBeats: 2 });
    events.push({ beat: 1, kind: 'hold', releaseBeat: 3, cueId: 'pumpTick' });
  }

  return { events, cues };
}
