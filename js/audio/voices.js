// js/audio/voices.js
// Small, parameterized one-shot/sweep synth voices shared by:
//   - js/audio/synth.js  (baked into the song via an OfflineAudioContext -
//     drum/bass/chords AND every game's cue sounds, since cues are part of
//     the music)
//   - js/audio/sfx.js    (pre-rendered to short AudioBuffers, one tiny
//     OfflineAudioContext render per sound, during the loading screen)
// Every function is a pure function of (ctx, dest, time, spec) so it works
// against either context type. Nothing here is ever called at tap time -
// see sfx.js header for why response sounds are buffer-playback only.

/** A plain tone with an exponential attack/decay envelope, optional pitch
 * ramp and optional filtering. The general-purpose "blip" voice. */
export function tone(ctx, dest, time, opts = {}) {
  const {
    wave = 'sine',
    freq = 440,
    freqEnd = null,
    dur = 0.15,
    attack = 0.006,
    gain = 0.4,
    filterType = null,
    filterFreq = 1200,
  } = opts;
  const osc = ctx.createOscillator();
  osc.type = wave;
  osc.frequency.setValueAtTime(Math.max(1, freq), time);
  if (freqEnd != null) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), time + dur);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, time);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), time + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  let tail = osc;
  if (filterType) {
    const filt = ctx.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.value = filterFreq;
    osc.connect(filt);
    tail = filt;
  }
  tail.connect(amp).connect(dest);
  osc.start(time);
  osc.stop(time + dur + 0.05);
  return { osc, amp };
}

/** A short filtered burst from a shared noise buffer (percussive hits,
 * "bonk"/"clap"/"thud" style sounds). */
export function noiseHit(ctx, dest, time, noiseBuffer, opts = {}) {
  const { dur = 0.08, gain = 0.4, filterType = 'highpass', filterFreq = 2000, attack = 0.002 } = opts;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer;
  const filt = ctx.createBiquadFilter();
  filt.type = filterType;
  filt.frequency.value = filterFreq;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, time);
  amp.gain.exponentialRampToValueAtTime(Math.max(0.001, gain), time + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  const maxOffset = Math.max(0, noiseBuffer.duration - dur - 0.02);
  // Deterministic-enough pseudo-offset so repeated hits don't all read the
  // exact same slice of noise (cosmetic only - no rng dependency needed).
  const offset = maxOffset > 0 ? (time * 977) % maxOffset : 0;
  src.connect(filt).connect(amp).connect(dest);
  src.start(time, offset, dur + 0.02);
  return { src, amp };
}

/** A continuous rising/falling tone - Balloon Pump's whistle cue. Returns a
 * handle with stopAt() so a LIVE instance (sfx.js hold-sustain buffers are
 * looped short clips, not this - this is only ever baked) can be cut off. */
export function sweepTone(ctx, dest, time, opts = {}) {
  const { wave = 'sawtooth', freqStart = 300, freqEnd = 1200, dur = 2, gain = 0.3, filterFreq = 2400 } = opts;
  const osc = ctx.createOscillator();
  osc.type = wave;
  osc.frequency.setValueAtTime(freqStart, time);
  osc.frequency.linearRampToValueAtTime(freqEnd, time + dur);
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(filterFreq * 0.5, time);
  filt.frequency.linearRampToValueAtTime(filterFreq, time + dur);
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, time);
  amp.gain.exponentialRampToValueAtTime(gain, time + 0.05);
  amp.gain.setValueAtTime(gain, time + Math.max(0.05, dur - 0.08));
  amp.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  osc.connect(filt).connect(amp).connect(dest);
  osc.start(time);
  osc.stop(time + dur + 0.05);
  return { osc, amp };
}

/**
 * Data-driven dispatcher used by BOTH synth.js (baking a game's cue sounds
 * into the song) and sfx.js (pre-rendering a game's live response sounds).
 * `spec` is one entry of a game module's soundPack() - see js/games/*.js.
 * `variant` is a small integer step (e.g. a motif's note index, or 0/1 for
 * "ready"/"set") - specs may declare `pitchStepMul` to have pitch rise/fall
 * per step, so one spec can express a whole rising/falling cue family.
 */
export function playSpec(ctx, dest, time, spec, noiseBuffer, variant = 0) {
  const mul = spec.pitchStepMul != null ? Math.pow(spec.pitchStepMul, variant) : 1;
  const freq = spec.freq != null ? spec.freq * mul : undefined;
  const freqEnd = spec.freqEnd != null ? spec.freqEnd * mul : undefined;
  switch (spec.voice) {
    case 'noise':
      return noiseHit(ctx, dest, time, noiseBuffer, spec);
    case 'sweep':
      return sweepTone(ctx, dest, time, { ...spec, freqStart: freq ?? spec.freqStart, freqEnd: freqEnd ?? spec.freqEnd });
    case 'chord':
      return chordBlip(ctx, dest, time, (spec.freqs || [freq]).map((f) => f * mul), spec);
    case 'tone':
    default:
      return tone(ctx, dest, time, { ...spec, freq, freqEnd });
  }
}

/** Two/three-note chord blip (used by a couple of "go" cues). */
export function chordBlip(ctx, dest, time, freqs, opts = {}) {
  const { wave = 'triangle', dur = 0.18, gain = 0.28, attack = 0.006 } = opts;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, time);
  amp.gain.exponentialRampToValueAtTime(gain, time + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  amp.connect(dest);
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.setValueAtTime(f, time);
    osc.connect(amp);
    osc.start(time);
    osc.stop(time + dur + 0.05);
  }
  return { amp };
}
