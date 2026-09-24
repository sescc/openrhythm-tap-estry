// js/songform.js
// Builds the section plan (teach -> vary -> teach B -> combine -> breather
// -> finale) for a chosen minigame + level, asks the game module to
// compose() each section, and assembles the result via chart.js. Also owns
// the learnability lint (runs in ?debug and from tools/lint.html).
//
// RNG discipline: `rng` here is a DEDICATED stream (subRng(seed,'chart')),
// independent of the synth/sfx streams - see js/main.js. Every random
// decision that affects the CHART (section order, which cue/gap/motif a
// game.compose() picks) must come from this same stream, in this same call
// order, for a seed to reproduce identically.

import { assembleChart } from './chart.js';

const SECTION_BEATS = { teachA: 8, varyA: 8, teachB: 8, varyB: 8, combine: 8, breather: 4, finale: 16 };
const INTRO_BEATS = 8;
const OUTRO_BEATS = 8;
const TARGET_SECONDS = 70; // song target 60-80s; see buildChart()
const MIN_PHRASES = 6;
const MAX_PHRASES = 16;

/**
 * Difficulty ramp: level 1..∞ -> allowed subdivisions / fake rate / density
 * / tempo. Capped at level 10 for the ramp itself (levels beyond 10 keep
 * level-10 knobs but keep raising tempo up to the 150bpm cap).
 */
export function levelParamsFor(level) {
  const L = Math.max(1, Math.floor(level) || 1);
  const rampL = Math.min(L, 10);
  const t = (rampL - 1) / 9; // 0 at level1, 1 at level10+
  const bpm = Math.min(150, Math.round(90 + (L - 1) * 4));
  const subdivisions = ['8th'];
  if (rampL >= 3) subdivisions.push('16th');
  if (rampL >= 6) subdivisions.push('triplet');
  if (rampL >= 6) subdivisions.push('swing');
  return {
    level: L,
    bpm,
    subdivisions,
    fakeRate: rampL < 4 ? 0 : rampL < 8 ? 0.15 : 0.28,
    density: 0.45 + 0.5 * t,
    combineAllowed: rampL >= 4,
    sevenEighthAllowed: rampL >= 8, // remix-only "unconventional but announced" knob
  };
}

function sectionKindSequence(rng, numPhrases, hasSecondCue) {
  const seq = ['teachA', 'varyA'];
  if (hasSecondCue) seq.push('teachB');
  for (let i = seq.length; i < numPhrases; i++) {
    if (i === numPhrases - 1) {
      seq.push('finale');
      continue;
    }
    if (i % 5 === 4) {
      seq.push('breather');
      continue;
    }
    if (hasSecondCue && i / numPhrases > 0.35 && rng.chance(0.4)) {
      seq.push('combine');
      continue;
    }
    seq.push(hasSecondCue && rng.chance(0.5) ? 'varyB' : 'varyA');
  }
  return seq;
}

/**
 * Build a full relative-time chart for `game` (a js/games/*.js module) at
 * `level`. `rng` must be a fresh dedicated stream (see file header).
 * `extra.clearedIds` (remix only) is the list of cleared game ids remix may
 * draw its sub-games from - see js/games/remix.js.
 */
export function buildChart(rng, game, level, extra = {}) {
  const levelParams = levelParamsFor(level);
  const beatDuration = 60 / levelParams.bpm;

  const isRemix = game.id === 'remix';
  const subGames = isRemix ? game.pickSubGames(rng, extra.clearedIds || []) : null;
  const hasSecondCue = isRemix ? true : (game.cueTypes || []).length > 1;

  const fixedBeats = INTRO_BEATS + OUTRO_BEATS;
  const avgPhraseBeats = 8;
  const targetBeats = TARGET_SECONDS / beatDuration - fixedBeats;
  let numPhrases = Math.round(targetBeats / avgPhraseBeats);
  numPhrases = Math.max(MIN_PHRASES, Math.min(MAX_PHRASES, numPhrases));

  const kinds = sectionKindSequence(rng, numPhrases, hasSecondCue);

  const countInCues = [];
  for (let b = 0; b < INTRO_BEATS; b++) countInCues.push(b * beatDuration);

  let cursorBeat = INTRO_BEATS;
  const sections = [];
  const events = [];
  const cues = [];

  kinds.forEach((kind, i) => {
    let beats = SECTION_BEATS[kind] || 8;
    // Remix-only "unconventional but announced" knob: an occasional 7/8 bar
    // at level 8+, flagged with its own distinct (unscored) cue right at
    // the section's start so it's heard before it's played, not sprung on
    // the player mid-phrase.
    const wantOddMeter =
      isRemix && levelParams.sevenEighthAllowed && kind !== 'teachA' && kind !== 'teachB' && kind !== 'breather' && rng.chance(0.2);
    if (wantOddMeter) beats = 7;

    const startBeat = cursorBeat;
    const startTime = startBeat * beatDuration;

    const composed = isRemix
      ? game.composeSection(subGames, rng, levelParams, beats, kind, i) || { events: [], cues: [] }
      : game.compose(rng, levelParams, beats, kind, { beatDuration }) || { events: [], cues: [] };

    const groove = composed.groove || (typeof game.groove === 'function' ? game.groove(levelParams, kind) : game.groove || 'straight');
    const section = {
      index: i,
      kind,
      beats,
      startBeat,
      startTime,
      endTime: startTime + beats * beatDuration,
      isPhrase: true,
      groove,
      oddMeter: wantOddMeter,
      eventCount: 0,
    };

    if (wantOddMeter) {
      cues.push({ time: startTime, cueId: 'oddMeter', fake: false, variant: 0, srcGame: game.id, sectionIndex: i });
    }

    for (const c of composed.cues || []) {
      cues.push({
        time: startTime + c.beat * beatDuration,
        cueId: c.cueId,
        fake: !!c.fake,
        variant: c.variant,
        srcGame: c.srcGame || game.id,
        sectionIndex: i,
      });
    }

    let regionIndex = 0;
    for (const e of composed.events || []) {
      const time = startTime + e.beat * beatDuration;
      const note = {
        kind: e.kind || 'tap',
        time,
        cueId: e.cueId,
        fake: !!e.fake,
        srcGame: e.srcGame || game.id,
        sectionIndex: i,
        phraseIndex: i,
        regionIndex: regionIndex++,
        judged: false,
        judgement: null,
      };
      if (note.kind === 'hold') note.releaseTime = startTime + e.releaseBeat * beatDuration;
      events.push(note);
    }
    section.eventCount = regionIndex;
    sections.push(section);
    cursorBeat += beats;
  });

  const outroStartTime = cursorBeat * beatDuration;
  cursorBeat += OUTRO_BEATS;
  const totalDuration = cursorBeat * beatDuration;

  const chart = assembleChart({
    bpm: levelParams.bpm,
    meter: game.meter || [4, 4],
    introBeats: INTRO_BEATS,
    sections,
    events,
    cues,
    countInCues,
    outroBeats: OUTRO_BEATS,
    outroStartTime,
    totalDuration,
    gameId: game.id,
    level,
  });
  chart.levelParams = levelParams;
  if (isRemix) chart.remixSubGameIds = subGames.map((g) => g.id);
  return chart;
}

// --- backgrounding / pause-resume ---------------------------------------
/**
 * A player can background the game mid-song (switch apps, lock the screen,
 * alt-tab). The audio clock keeps running under that; without this, the
 * game would silently "catch up" on return - panels jumping, and every note
 * that passed while backgrounded auto-missing through no fault of the
 * player. js/main.js calls this once the player taps "resume", after
 * scheduling the count-in.
 *
 * Given an ABSOLUTE-time chart (js/chart.js toAbsoluteChart), the
 * AudioContext time the player was interrupted at, and the AudioContext
 * time the resumed song audio will actually start sounding again, this:
 *   1. picks a resume point that is ALWAYS a phrase boundary (the phrase
 *      that hadn't started yet when paused, if any; otherwise the next one)
 *      - never mid-phrase into a note the player couldn't have anticipated,
 *      since every cue that would have predicted it already played;
 *   2. marks every not-yet-judged note before that point judged:true,
 *      judgement:'skipped' in place (js/main.js excludes these from the
 *      accuracy denominator and reveals their story region as the good
 *      variant, same as forceCompletePanel does at song end);
 *   3. shifts every note/cue/phrase time at or after the resume point by
 *      `newAudioStartCtxTime - resumeAtAbsTime`, so they land exactly when
 *      the resumed audio will actually sound them - `chart` is mutated in
 *      place (notes/cues/phrases arrays already hold their own fresh
 *      objects post toAbsoluteChart(), so mutating them here doesn't touch
 *      the original relative chart).
 *
 * Pure data in, mutated data out - no DOM/audio here, so this is directly
 * unit-testable via a plain Node import of songform.js + chart.js, without
 * a browser (see tools/lint.html-style verification / CLAUDE.md).
 */
export function planPauseResume(absChart, pauseCtxTime, newAudioStartCtxTime) {
  const phrases = absChart.phrases;
  let activeIdx = phrases.findIndex((p) => pauseCtxTime < p.endTime);
  if (activeIdx === -1) activeIdx = phrases.length; // paused after every phrase (in the outro)
  // If we hadn't even reached this phrase yet (its own cues never played),
  // resuming AT its start loses nothing. Otherwise we're mid-phrase (or
  // past it) - the phrase's cues already sounded, so its remaining events
  // aren't predictable anymore; skip the rest of it and resume at the next
  // (already-past-the-last-phrase clamps to phrases.length, not beyond it).
  let resumeIdx;
  if (activeIdx >= phrases.length) {
    resumeIdx = phrases.length;
  } else if (pauseCtxTime <= phrases[activeIdx].startTime) {
    resumeIdx = activeIdx;
  } else {
    resumeIdx = activeIdx + 1;
  }
  const resumeAtAbsTime = resumeIdx < phrases.length ? phrases[resumeIdx].startTime : absChart.outroStartTime;

  let skippedCount = 0;
  for (const note of absChart.notes) {
    if (!note.judged && note.time < resumeAtAbsTime) {
      note.judged = true;
      note.judgement = 'skipped';
      skippedCount++;
    }
  }

  const timeShift = newAudioStartCtxTime - resumeAtAbsTime;
  for (const note of absChart.notes) {
    if (note.time >= resumeAtAbsTime) {
      note.time += timeShift;
      if (note.releaseTime != null) note.releaseTime += timeShift;
    }
  }
  for (const cue of absChart.cues) {
    if (cue.time >= resumeAtAbsTime) cue.time += timeShift;
  }
  for (const phrase of phrases) {
    if (phrase.startTime >= resumeAtAbsTime) {
      phrase.startTime += timeShift;
      phrase.endTime += timeShift;
    }
  }
  if (absChart.outroStartTime >= resumeAtAbsTime) absChart.outroStartTime += timeShift;
  if (absChart.absoluteEndTime >= resumeAtAbsTime) absChart.absoluteEndTime += timeShift;

  return {
    skippedCount,
    resumeIdx, // RAW - may equal phrases.length ("nothing left but the outro")
    resumeAtAbsTime,
    timeShift,
  };
}

// --- learnability lint --------------------------------------------------
// Three checks, run over a RELATIVE-time chart (pre toAbsoluteChart):
//   1. Every judged event's `time` (a hold's PRESS, a tap's own time) must
//      be predictable from a cue of the SAME cueId at least one beat
//      earlier - resolved against chart.cues itself (not a field the
//      composer wrote), so a composer bug can't grade its own homework.
//      A hold's releaseTime is exempt: the release deadline is a fixed,
//      already-announced offset from the press (the whole point of "the
//      rate never changes"), audible for its whole duration as the baked
//      cue sound itself, not a second discrete cue.
//   2. No two events collide (< 120ms apart at the .time used for judging;
//      an active hold's [time, releaseTime] must not overlap another
//      event's .time).
//   3. Every fake's cueId must not be used by any non-fake cue in the same
//      game - i.e. it is structurally (and, by soundPack construction,
//      acoustically) distinct from every real cue.
export function lintChart(chart) {
  const violations = [];
  const beatDuration = chart.beatDuration;
  const cuesByGame = new Map(); // srcGame -> cue[]
  for (const c of chart.cues) {
    const g = c.srcGame || chart.gameId;
    if (!cuesByGame.has(g)) cuesByGame.set(g, []);
    cuesByGame.get(g).push(c);
  }

  function predictedAt(cueList, cueId, atOrBefore) {
    for (const c of cueList) {
      if (c.cueId === cueId && c.time <= atOrBefore) return true;
    }
    return false;
  }

  for (const note of chart.notes) {
    const g = note.srcGame || chart.gameId;
    const cueList = cuesByGame.get(g) || [];
    const deadline = note.time - beatDuration + 1e-6;
    if (!predictedAt(cueList, note.cueId, deadline)) {
      violations.push(
        `unpredictable ${note.kind}@${note.time.toFixed(3)}s (cueId=${note.cueId}, game=${g}, section=${note.sectionIndex}) - no matching cue >=1 beat earlier`
      );
    }
  }

  // Fake cueIds must never coincide with a real (non-fake) cueId, per game.
  for (const [g, list] of cuesByGame) {
    const realIds = new Set(list.filter((c) => !c.fake).map((c) => c.cueId));
    for (const c of list) {
      if (c.fake && realIds.has(c.cueId)) {
        violations.push(`fake cue "${c.cueId}" (game=${g}) shares an id with a real cue - not acoustically distinct`);
      }
    }
  }

  // Collision check: build a flat timeline of [start,end) intervals (holds
  // get their real span; taps/cues get a 0-length point treated as needing
  // 120ms clearance from anything else).
  const MIN_GAP = 0.12;
  const points = [];
  for (const n of chart.notes) {
    points.push({ start: n.time, end: n.kind === 'hold' ? n.releaseTime : n.time, label: `${n.kind}@${n.time.toFixed(3)}` });
  }
  points.sort((a, b) => a.start - b.start);
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (cur.start - prev.end < MIN_GAP - 1e-6) {
      violations.push(`collision: ${prev.label} and ${cur.label} are < ${Math.round(MIN_GAP * 1000)}ms apart`);
    }
  }

  return violations;
}
