// js/audio/sfx.js
// Live response sound effects. Per the M1.5 invariant: response SFX must be
// triggered LIVE on judged hits, from AudioBuffers pre-rendered during
// loading - never synthesized at tap time (that risks missing the audio
// render quantum under load, and it's extra allocation on the hot path).
// This file does two things:
//   1. renderResponsePack(sfxRng, game, sampleRate) - during the loading
//      screen, renders one game's `response.*` sounds (see its soundPack())
//      to short AudioBuffers via tiny OfflineAudioContexts.
//   2. playBuffer(ctx, buffer, dest, opts) - at judge time, plays an
//      already-rendered buffer live via the ONLINE AudioContext. This is
//      the only per-tap allocation on the hot path (an AudioBufferSourceNode
//      is one-shot and can't be pooled - see js/input.js/js/main.js), and it
//      does no synthesis of its own.
// An AudioBuffer isn't tied to the context that created it (only NODES
// are), so one shared noise buffer can be reused across every tiny
// per-sound OfflineAudioContext below without re-generating it.
//
// Remix charts need every INVOLVED sub-game's pack, not just one - see
// renderAllPacks().

import { playSpec } from './voices.js';
import { createNoiseBuffer } from './cues.js';

function offlineCtor() {
  return window.OfflineAudioContext || window.webkitOfflineAudioContext;
}

async function renderOneShot(sampleRate, dur, drawFn) {
  const OfflineCtor = offlineCtor();
  const octx = new OfflineCtor(2, Math.max(1, Math.ceil(dur * sampleRate)), sampleRate);
  drawFn(octx);
  return octx.startRendering();
}

/**
 * Render one game's response pack (tapGood / tapMiss / holdSustain(loop) /
 * holdRelease) to AudioBuffers. `sfxRng` should be a dedicated stream
 * (subRng(seed,'sfx')) so it never perturbs the chart/synth streams.
 */
export async function renderResponsePack(sfxRng, game, sampleRate) {
  const pack = game.soundPack(sfxRng);
  const response = pack.response || {};

  // One shared noise source for every noise-voiced response in this pack.
  const NoiseCtor = offlineCtor();
  const noiseFactory = new NoiseCtor(1, 1, sampleRate);
  const noiseBuffer = createNoiseBuffer(noiseFactory, sfxRng, 0.4);

  async function renderNamed(spec, dur) {
    if (!spec) return null;
    return renderOneShot(sampleRate, dur, (octx) => {
      playSpec(octx, octx.destination, 0.005, spec, noiseBuffer, 0);
    });
  }

  const [tapGood, tapMiss, holdRelease] = await Promise.all([
    renderNamed(response.tapGood, 0.3),
    renderNamed(response.tapMiss, 0.25),
    renderNamed(response.holdRelease, 0.3),
  ]);
  // Hold sustain is a short LOOPABLE clip - played with loop=true from press
  // and cut off exactly at release (see js/main.js).
  const holdSustain = response.holdSustain ? await renderNamed(response.holdSustain, 0.26) : null;

  return { gameId: game.id, tapGood, tapMiss, holdSustain, holdRelease };
}

/**
 * Render response packs for every game a chart can reference: the chart's
 * own game, plus (for remix) every distinct `srcGame` its notes carry.
 * Returns a Map keyed by gameId. `gamesById(id)` looks up a game module.
 */
export async function renderAllPacks(sfxRng, chart, gamesById, sampleRate) {
  const ids = new Set([chart.gameId]);
  for (const n of chart.notes) ids.add(n.srcGame || chart.gameId);
  const packs = new Map();
  // Sorted so a seed's sfx render order (and thus sfxRng draws) stays fixed
  // regardless of Set/Map iteration quirks.
  for (const gid of Array.from(ids).sort()) {
    const game = gamesById(gid);
    if (!game || !game.soundPack) continue;
    packs.set(gid, await renderResponsePack(sfxRng, game, sampleRate));
  }
  return packs;
}

/**
 * Play an already-rendered buffer live, right now (ctx.currentTime) - the
 * usual place sfx are triggered from (a judged hit). Returns the source
 * node (holds use this to stop() it on release).
 */
export function playBuffer(ctx, buffer, dest, opts = {}) {
  return scheduleBuffer(ctx, buffer, dest, ctx.currentTime, opts);
}

/**
 * Like playBuffer, but at an explicit future AudioContext time - used for
 * guide ticks (section C), which are scheduled for every upcoming note the
 * moment a song starts (or resumes), not triggered reactively on a tap.
 * Precision comes from the Web Audio scheduler itself (sample-accurate
 * regardless of how far ahead `when` is), not from setTimeout/rAF.
 */
export function scheduleBuffer(ctx, buffer, dest, when, { loop = false, gain = 1 } = {}) {
  if (!buffer) return null;
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.loop = loop;
  if (gain !== 1) {
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g);
    g.connect(dest);
  } else {
    src.connect(dest);
  }
  src.start(when);
  return src;
}

/**
 * Render the two generic (not per-game) guide sounds: a soft tick for every
 * expected tap, and a slightly different one for a hold's release. Generic
 * on purpose - guides are a learning aid layered OVER a game's own cue
 * vocabulary, not one more thing with its own meaning to learn, so every
 * game's guide sounds identical.
 */
export async function renderGuidePack(sampleRate) {
  const dur = 0.09;
  const tick = await renderOneShot(sampleRate, dur, (octx) => {
    playSpec(octx, octx.destination, 0.004, { voice: 'tone', wave: 'sine', freq: 1800, dur: 0.06, attack: 0.003, gain: 0.22 }, null, 0);
  });
  const release = await renderOneShot(sampleRate, dur, (octx) => {
    playSpec(octx, octx.destination, 0.004, { voice: 'tone', wave: 'sine', freq: 1200, dur: 0.07, attack: 0.003, gain: 0.2 }, null, 0);
  });
  return { tick, release };
}
