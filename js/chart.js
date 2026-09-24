// js/chart.js
// Generic chart model (M1.5). This file no longer picks patterns itself -
// js/songform.js builds the section plan and asks the selected minigame
// module (js/games/*.js) to compose() each section; this file only
// assembles the result into one consistent shape and (unchanged contract)
// shifts it to AudioContext-absolute time once, right before playback.
//
// All times here are RELATIVE to song start (t=0 is the first sample of the
// rendered AudioBuffer) until toAbsoluteChart() runs.
//
// Judged event ("note") shape:
//   { kind:'tap'|'hold', time, releaseTime?, cueId, fake?:true,
//     srcGame?:string,          // remix only - which sub-game this came from
//     sectionIndex, phraseIndex, regionIndex,
//     judged:false, judgement:null,
//     holdReleaseJudged?:false, holdReleaseJudgement?:null } // holds only
// Cue shape (NOT judged - audio+visual only, baked into the song):
//   { time, cueId, fake?:true, srcGame?:string, sectionIndex, variant? }

/**
 * Assemble a chart from songform.js's section plan + composed events/cues.
 * @param {object} spec
 *   bpm, meter, sections (array, each already carrying startBeat/startTime/
 *   endTime/eventCount/isPhrase - see songform.js), events, cues,
 *   countInCues (relative seconds), outroBeats, outroStartTime, totalDuration
 */
export function assembleChart(spec) {
  const {
    bpm,
    meter,
    sections,
    events,
    cues,
    countInCues,
    introBeats = 0,
    outroBeats,
    outroStartTime,
    totalDuration,
    gameId,
    level,
  } = spec;
  const beatDuration = 60 / bpm;

  const sortedEvents = events.slice().sort((a, b) => a.time - b.time);
  const sortedCues = cues.slice().sort((a, b) => a.time - b.time);

  const phraseSections = sections.filter((s) => s.isPhrase);
  const phrases = phraseSections.map((s, i) => ({
    index: i,
    sectionIndex: s.index,
    kind: s.kind,
    startBeat: s.startBeat,
    startTime: s.startTime,
    endTime: s.endTime,
    groove: s.groove,
    regionCount: Math.max(1, s.eventCount),
  }));

  return {
    gameId,
    level,
    bpm,
    beatDuration,
    meter: meter || [4, 4],
    introBeats,
    outroBeats,
    outroStartTime,
    numPhrases: phrases.length,
    sections,
    phrases,
    notes: sortedEvents,
    cues: sortedCues,
    countInCues,
    totalDuration, // seconds, relative to song start (t=0)
  };
}

/**
 * Shift every relative time in a chart into AudioContext-absolute time,
 * given the moment (ctx time, seconds) the song's AudioBufferSourceNode was
 * started. Called exactly once by js/main.js right before playback begins;
 * every other module (input judging, stage reveal, beat pulse, autoplay)
 * only ever sees absolute times afterwards.
 */
export function toAbsoluteChart(chart, startTime) {
  const shift = (t) => t + startTime;
  return {
    ...chart,
    startTime,
    notes: chart.notes.map((n) => ({
      ...n,
      time: shift(n.time),
      releaseTime: n.releaseTime != null ? shift(n.releaseTime) : undefined,
    })),
    cues: chart.cues.map((c) => ({ ...c, time: shift(c.time) })),
    countInCues: chart.countInCues.map(shift),
    sections: chart.sections.map((s) => ({ ...s, startTime: shift(s.startTime), endTime: shift(s.endTime) })),
    phrases: chart.phrases.map((p) => ({ ...p, startTime: shift(p.startTime), endTime: shift(p.endTime) })),
    outroStartTime: shift(chart.outroStartTime),
    absoluteEndTime: shift(chart.totalDuration),
  };
}
