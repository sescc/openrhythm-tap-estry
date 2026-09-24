// js/audio/synth.js
// Procedural song generator: turns a chart (js/songform.js buildChart) into
// a single rendered AudioBuffer via OfflineAudioContext. Drums/bass/chords
// are built per SECTION (variable length now, not a fixed 8-beat phrase);
// every cue sound (the "call" - part of the music) is baked in using the
// composing game's own soundPack, so each minigame gets its own timbre.
//
// M1.5 change from M1: the baked per-note melody pluck is GONE (it used to
// play on every judged note, which spelled out the answer - see the plan's
// "the player makes the response sound" principle). Judged notes are
// audibly SILENT in the backing track; the live response comes from
// js/audio/sfx.js on the judged hit itself.
//
// `rng` must be a DEDICATED stream (subRng(seed,'synth')) - see js/main.js.
// It is consumed, in order: noise buffer -> scale/root/progression -> one
// soundPack(rng) draw per involved game id (sorted - see
// js/games/index.js collectInvolvedGameIds), so a seed's baked audio is
// fully deterministic.

import { createNoiseBuffer, scheduleClick } from './cues.js';
import { playSpec, chordBlip } from './voices.js';
import { collectInvolvedGameIds, getGame } from '../games/index.js';

const SCALES = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};
const SCALE_NAMES = Object.keys(SCALES);

const PROGRESSIONS = [
  [0, 3, 4, 0],
  [0, 5, 3, 4],
  [0, 4, 5, 3],
  [5, 3, 0, 4],
];

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}
function scaleDegreeToMidi(scale, rootMidi, degree) {
  const len = scale.length;
  const octaveShift = Math.floor(degree / len);
  const idx = ((degree % len) + len) % len;
  return rootMidi + octaveShift * 12 + scale[idx];
}

// --- percussion / instrument voices -----------------------------------

function playKick(ctx, dest, time) {
  const osc = ctx.createOscillator();
  const amp = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(42, time + 0.12);
  amp.gain.setValueAtTime(0.9, time);
  amp.gain.exponentialRampToValueAtTime(0.001, time + 0.22);
  osc.connect(amp).connect(dest);
  osc.start(time);
  osc.stop(time + 0.25);
}

function playSnare(ctx, dest, time, noiseBuffer, noiseOffset) {
  const dur = 0.14;
  const maxOffset = Math.max(0, noiseBuffer.duration - dur - 0.02);
  const offset = maxOffset > 0 ? noiseOffset % maxOffset : 0;

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'highpass';
  noiseFilter.frequency.value = 1200;
  const noiseAmp = ctx.createGain();
  noiseAmp.gain.setValueAtTime(0.55, time);
  noiseAmp.gain.exponentialRampToValueAtTime(0.001, time + dur);
  noise.connect(noiseFilter).connect(noiseAmp).connect(dest);
  noise.start(time, offset, dur + 0.02);

  const body = ctx.createOscillator();
  const bodyAmp = ctx.createGain();
  body.type = 'triangle';
  body.frequency.setValueAtTime(190, time);
  bodyAmp.gain.setValueAtTime(0.35, time);
  bodyAmp.gain.exponentialRampToValueAtTime(0.001, time + 0.09);
  body.connect(bodyAmp).connect(dest);
  body.start(time);
  body.stop(time + 0.1);
}

function playHat(ctx, dest, time, noiseBuffer, open, noiseOffset) {
  const dur = open ? 0.22 : 0.045;
  const maxOffset = Math.max(0, noiseBuffer.duration - dur - 0.02);
  const offset = maxOffset > 0 ? noiseOffset % maxOffset : 0;

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 7000;
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(open ? 0.2 : 0.16, time);
  amp.gain.exponentialRampToValueAtTime(0.001, time + dur);
  noise.connect(filter).connect(amp).connect(dest);
  noise.start(time, offset, dur + 0.02);
}

function playBass(ctx, dest, time, freq, dur) {
  const osc = ctx.createOscillator();
  const filter = ctx.createBiquadFilter();
  const amp = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, time);
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(600, time);
  amp.gain.setValueAtTime(0.0001, time);
  amp.gain.exponentialRampToValueAtTime(0.28, time + 0.02);
  amp.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  osc.connect(filter).connect(amp).connect(dest);
  osc.start(time);
  osc.stop(time + dur + 0.05);
}

function playChord(ctx, dest, time, freqs, dur) {
  const amp = ctx.createGain();
  amp.gain.setValueAtTime(0.0001, time);
  amp.gain.exponentialRampToValueAtTime(0.14, time + 0.05);
  amp.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  amp.connect(dest);
  for (const f of freqs) {
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(f, time);
    osc.connect(amp);
    osc.start(time);
    osc.stop(time + dur + 0.1);
  }
}

// --- groove styles -------------------------------------------------------
// Each writes kick/snare/hat events for one section (section.beats long,
// starting at section.startTime) onto `dest` (the backing bus - see
// renderSong). This is where each minigame's "own groove" (straight/swing/
// shuffle/half-time/6-8) actually differs audibly.

function grooveStraight(ctx, dest, start, beats, beatDur, noiseBuffer) {
  for (let b = 0; b < beats; b += 0.5) {
    const t = start + b * beatDur;
    if (b % 4 === 0) playKick(ctx, dest, t);
    if (b % 4 === 2) playSnare(ctx, dest, t, noiseBuffer, t * 0.37);
    playHat(ctx, dest, t, noiseBuffer, b % 4 === 3.5, t * 0.19);
  }
}

function grooveSwing(ctx, dest, start, beats, beatDur, noiseBuffer, shuffleSoft) {
  for (let b = 0; b < beats; b++) {
    const t = start + b * beatDur;
    if (b % 4 === 0) playKick(ctx, dest, t);
    if (b % 4 === 2) playSnare(ctx, dest, t, noiseBuffer, t * 0.37);
    playHat(ctx, dest, t, noiseBuffer, false, t * 0.19);
    playHat(ctx, dest, start + (b + 2 / 3) * beatDur, noiseBuffer, !shuffleSoft && b % 4 === 3, (t + 1) * 0.19);
  }
}

function grooveHalftime(ctx, dest, start, beats, beatDur, noiseBuffer) {
  for (let b = 0; b < beats; b += 4) {
    const t0 = start + b * beatDur;
    playKick(ctx, dest, t0);
    playSnare(ctx, dest, start + (b + 2) * beatDur, noiseBuffer, (t0 + 2) * 0.37);
    for (let s = 0; s < 4; s++) playHat(ctx, dest, start + (b + s) * beatDur, noiseBuffer, s === 3, (t0 + s) * 0.19);
  }
}

function grooveSixEight(ctx, dest, start, beats, beatDur, noiseBuffer) {
  const offsets = [0, 1 / 3, 2 / 3, 1, 4 / 3, 5 / 3];
  for (let b = 0; b + 2 <= beats + 0.001; b += 2) {
    const t0 = start + b * beatDur;
    playKick(ctx, dest, t0);
    offsets.forEach((o, i) => {
      const t = start + (b + o) * beatDur;
      if (i === 0) return;
      if (i === 3) playSnare(ctx, dest, t, noiseBuffer, t * 0.37);
      else playHat(ctx, dest, t, noiseBuffer, false, t * 0.19);
    });
  }
}

const GROOVES = {
  straight: (ctx, dest, start, beats, beatDur, nb) => grooveStraight(ctx, dest, start, beats, beatDur, nb),
  swing: (ctx, dest, start, beats, beatDur, nb) => grooveSwing(ctx, dest, start, beats, beatDur, nb, false),
  shuffle: (ctx, dest, start, beats, beatDur, nb) => grooveSwing(ctx, dest, start, beats, beatDur, nb, true),
  halftime: (ctx, dest, start, beats, beatDur, nb) => grooveHalftime(ctx, dest, start, beats, beatDur, nb),
  sixEight: (ctx, dest, start, beats, beatDur, nb) => grooveSixEight(ctx, dest, start, beats, beatDur, nb),
};

/**
 * Render the whole song to one AudioBuffer.
 * @param {object} rng - DEDICATED 'synth' rng stream (see file header)
 * @param {object} chart - from js/songform.js buildChart(), relative times
 * @param {(id:string)=>object} gamesById - game module lookup (js/games/index.js getGame)
 * @param {{sampleRate?: number}} options
 */
export async function renderSong(rng, chart, gamesById, options = {}) {
  const sampleRate = options.sampleRate || 44100;
  const totalSamples = Math.ceil((chart.totalDuration + 1) * sampleRate); // +1s tail pad
  const OfflineCtor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const octx = new OfflineCtor(2, totalSamples, sampleRate);

  const master = octx.createGain();
  master.gain.value = 0.9;
  const compressor = octx.createDynamicsCompressor();
  master.connect(compressor).connect(octx.destination);

  // Backing bus (drums/bass/chords) gets ducked around cues; cues themselves
  // play straight into the compressor so they always cut through cleanly.
  const backingBus = octx.createGain();
  backingBus.gain.setValueAtTime(1, 0);
  backingBus.connect(master);
  const cueBus = master;

  const noiseBuffer = createNoiseBuffer(octx, rng, 1.0);

  const scaleName = rng.pick(SCALE_NAMES);
  const scale = SCALES[scaleName];
  const rootMidi = 48 + rng.int(0, 11);
  const progression = rng.pick(PROGRESSIONS);
  const beatDur = chart.beatDuration;

  // Count-in: a clear click on every intro beat.
  for (const t of chart.countInCues) {
    scheduleClick(octx, backingBus, t, { freq: 1600, gain: 0.55 });
  }

  // Backing groove + bass/chords, per section (variable length now).
  for (const section of chart.sections) {
    const grooveFn = GROOVES[section.groove] || GROOVES.straight;
    grooveFn(octx, backingBus, section.startTime, section.beats, beatDur, noiseBuffer);

    const degree = progression[section.index % progression.length];
    const chordMidis = [0, 2, 4].map((step) => scaleDegreeToMidi(scale, rootMidi, degree + step));
    const chordFreqs = chordMidis.map(midiToFreq);
    const bassFreq = midiToFreq(scaleDegreeToMidi(scale, rootMidi - 12, degree));
    const halfBeats = section.beats / 2;

    playBass(octx, backingBus, section.startTime, bassFreq, beatDur * Math.min(4, halfBeats) - 0.03);
    if (section.beats > halfBeats) {
      playBass(octx, backingBus, section.startTime + halfBeats * beatDur, bassFreq, beatDur * Math.min(4, halfBeats) - 0.03);
    }
    playChord(octx, backingBus, section.startTime, chordFreqs, beatDur * section.beats - 0.05);
  }

  // Each game involved (the chart's own game, plus remix sub-games) draws
  // ITS soundPack from the SAME shared rng stream, in a fixed sorted order.
  const involvedIds = collectInvolvedGameIds(chart);
  const packs = new Map();
  for (const gid of involvedIds) {
    const game = gamesById(gid) || getGame(gid);
    if (game) packs.set(gid, game.soundPack(rng));
  }

  // Cue sounds - baked into the song, unducked, one per game's own timbre.
  for (const cue of chart.cues) {
    if (cue.cueId === 'oddMeter') {
      chordBlip(octx, cueBus, cue.time, [880, 1108, 1318], { dur: 0.3, gain: 0.32, wave: 'sine' });
      continue;
    }
    const pack = packs.get(cue.srcGame);
    const spec = pack && pack.cues[cue.cueId];
    if (!spec) continue;
    const effSpec = cue.spanBeats != null ? { ...spec, dur: cue.spanBeats * beatDur } : spec;
    playSpec(octx, cueBus, cue.time, effSpec, noiseBuffer, cue.variant || 0);
  }

  // Duck the backing bus briefly around every cue so it cuts through - cues
  // are processed in time order already (chart.cues is sorted).
  let lastDuckEnd = 0;
  for (const cue of chart.cues) {
    const t = cue.time;
    const dipStart = Math.max(t - 0.12, lastDuckEnd);
    if (dipStart >= t + 0.16) continue;
    backingBus.gain.setValueAtTime(1, dipStart);
    backingBus.gain.linearRampToValueAtTime(0.55, Math.max(dipStart, t - 0.02));
    backingBus.gain.linearRampToValueAtTime(1, t + 0.16);
    lastDuckEnd = t + 0.16;
  }

  // Outro: a final chord sting with the groove fading under it.
  const outroDegree = progression[0];
  const outroChord = [0, 2, 4, 7].map((step) => midiToFreq(scaleDegreeToMidi(scale, rootMidi, outroDegree + step)));
  playChord(octx, backingBus, chart.outroStartTime, outroChord, chart.outroBeats * beatDur - 0.05);
  master.gain.setValueAtTime(0.9, chart.outroStartTime);
  master.gain.linearRampToValueAtTime(0.0001, chart.outroStartTime + chart.outroBeats * beatDur);

  const buffer = await octx.startRendering();
  return { buffer, sampleRate, scaleName, rootMidi };
}
