// js/audio/cues.js
// Cue sound bank: short, timbrally distinct synth blips used for the "call"
// half of call-and-response phrases, the count-in, and (in later
// milestones) mixed over any uploaded/online track to mark beats/off-beats.
// Kept separate from the drum/bass/melody voices in js/audio/synth.js.

/**
 * Build a short white-noise AudioBuffer using the game's seeded RNG, so the
 * whole render (including noise-based drum hits) is fully deterministic.
 */
export function createNoiseBuffer(ctx, rng, durationSec = 1) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = rng.next() * 2 - 1;
  }
  return buffer;
}

/**
 * A short metronome/count-in click. Bright, percussive, unmistakable.
 */
export function scheduleClick(ctx, dest, time, { freq = 1500, gain = 0.5 } = {}) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(freq, time);
  amp.gain.setValueAtTime(0.0001, time);
  amp.gain.exponentialRampToValueAtTime(gain, time + 0.002);
  amp.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  osc.connect(amp).connect(dest);
  osc.start(time);
  osc.stop(time + 0.06);
}

/**
 * The "call" cue blip: a quick upward-pitched triangle chirp, deliberately
 * different in timbre from the melody/bass so players learn to recognize
 * "this sound means listen, then repeat the rhythm."
 */
export function scheduleCueBlip(ctx, dest, time, { baseFreq = 880, gain = 0.35 } = {}) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(baseFreq, time);
  osc.frequency.exponentialRampToValueAtTime(baseFreq * 1.5, time + 0.08);
  amp.gain.setValueAtTime(0.0001, time);
  amp.gain.exponentialRampToValueAtTime(gain, time + 0.008);
  amp.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);
  osc.connect(amp).connect(dest);
  osc.start(time);
  osc.stop(time + 0.16);
}
