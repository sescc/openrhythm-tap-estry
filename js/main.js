// js/main.js
// Screen state machine: menu -> calibrate (if not calibrated) -> [practice]
// -> loading -> play -> end. Wires together every other module. This is the
// only file that touches multiple subsystems at once - clock/input/chart/
// synth/story modules stay independent of each other.

import { getContext, resumeContext } from './clock.js';
import { subRng, resolveSeed } from './rng.js';
import { toAbsoluteChart } from './chart.js';
import { buildChart, lintChart, planPauseResume } from './songform.js';
import { renderSong } from './audio/synth.js';
import { renderAllPacks, renderGuidePack, playBuffer, scheduleBuffer } from './audio/sfx.js';
import { scheduleClick } from './audio/cues.js';
import { loadStory, SOURCE_TYPES } from './story/loader.js';
import { createJudge, attachInput } from './input.js';
import { createStage } from './render/stage.js';
import { detectLowEnd, getBudget } from './assets.js';
import { attachAutoPause } from './pause.js';
import { pairTapsToClicks, computeCalibration, computeVerifyResiduals, VERIFY_TAPS } from './calibration.js';
import * as storage from './storage.js';
import { GAMES, REMIX, getGame, pickNextGame, isRemixTurn } from './games/index.js';

storage.migrateIfNeeded(); // M1.6: wipe a possibly-corrupt calibration + reset progress once

// --- URL params ---------------------------------------------------------
const urlParams = new URLSearchParams(location.search);
const DEBUG = urlParams.has('debug');
const AUTOPLAY = urlParams.get('autoplay'); // 'perfect' | 'miss' | 'events' | null
const FORCE_LOWEND = urlParams.has('lowend');
const FORCE_GAME = urlParams.get('game');
const FORCE_LEVEL = urlParams.has('level') ? parseInt(urlParams.get('level'), 10) : null;
const GUIDES_PARAM = urlParams.get('guides'); // 'on' | 'off' | null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Testing aid: with ?autoplay=perfect&missEvery=3, every 3rd note (1st,
// 4th, 7th... tapped; 3rd, 6th, 9th... deliberately skipped) is left
// unjudged so it auto-misses - lets you confirm only THAT note's own
// region goes fumbled while its neighbours stay good.
const MISS_EVERY = parseInt(urlParams.get('missEvery'), 10) || 0;

// --- screens -------------------------------------------------------------
const screens = {
  menu: document.getElementById('screen-menu'),
  calibrate: document.getElementById('screen-calibrate'),
  practice: document.getElementById('screen-practice'),
  loading: document.getElementById('screen-loading'),
  play: document.getElementById('screen-play'),
  end: document.getElementById('screen-end'),
};
function showScreen(name) {
  for (const key in screens) {
    screens[key].classList.toggle('screen--active', key === name);
  }
}

// --- debug overlay ---------------------------------------------------------
const debugOverlay = document.getElementById('debug-overlay');
const debugLog = document.getElementById('debug-log');
const debugStats = document.getElementById('debug-stats');
if (DEBUG) debugOverlay.hidden = false;

function pushDebugRow(text) {
  if (!DEBUG) return;
  const row = document.createElement('div');
  row.textContent = text;
  debugLog.prepend(row);
  while (debugLog.childElementCount > 40) debugLog.removeChild(debugLog.lastChild);
}
function medianOf(arr) {
  if (arr.length === 0) return null;
  const sorted = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function updateDebugStats(offsets, ignoredCount, allSignedOffsets) {
  if (!DEBUG || offsets.length === 0) return;
  const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  const median = medianOf(offsets);
  // Section B: the ALL-taps median (judged + ignored) is the self-diagnosis
  // number - it's what a systematic miscalibration shows up as even when
  // most/all taps are being ignored (where `median` above would be empty).
  const allMedian = allSignedOffsets ? medianOf(allSignedOffsets) : null;
  debugStats.textContent =
    `taps judged=${offsets.length} mean=${mean.toFixed(1)}ms median=${median.toFixed(1)}ms ignored=${ignoredCount}` +
    (allMedian != null ? ` allTapsMedian=${allMedian.toFixed(1)}ms` : '');
}

// --- progression: choosing this run's game + level --------------------
function chooseGameAndLevel() {
  const gamesPlayed = storage.getGamesPlayed();
  const clearedIds = storage.getClearedIds();
  let game = FORCE_GAME ? getGame(FORCE_GAME) : null;
  if (!game) game = pickNextGame(gamesPlayed, clearedIds);
  const level = FORCE_LEVEL != null && FORCE_LEVEL > 0 ? FORCE_LEVEL : storage.getLevel();
  return { game, level, clearedIds };
}

// --- guides (section C) ------------------------------------------------
// On while a game is uncleared, off automatically once cleared; a menu
// checkbox or ?guides= overrides either way.
function guidesEnabledFor(game) {
  if (GUIDES_PARAM === 'on') return true;
  if (GUIDES_PARAM === 'off') return false;
  const pref = storage.getGuidesPref();
  if (pref !== null) return pref;
  return !storage.getCleared()[game.id];
}

function computeStylePrefs(game, chart) {
  if (game.id === 'remix' && chart.remixSubGameIds) {
    const merged = {};
    for (const gid of chart.remixSubGameIds) {
      const g = getGame(gid);
      for (const [style, w] of Object.entries(g?.stylePrefs || {})) merged[style] = (merged[style] || 0) + w;
    }
    return merged;
  }
  return game.stylePrefs || {};
}

// --- menu ------------------------------------------------------------------
const btnPlay = document.getElementById('btn-play');
const btnCalibrate = document.getElementById('btn-calibrate');
const chkLowEnd = document.getElementById('chk-lowend');
const chkGuides = document.getElementById('chk-guides');
const menuProgress = document.getElementById('menu-progress');
const menuCalibration = document.getElementById('menu-calibration');

function refreshMenu() {
  const { game, level } = chooseGameAndLevel();
  const mascot = game.mascot || {};
  menuProgress.textContent = `Level ${level} - up next: ${mascot.emoji || ''} ${game.name}`;

  if (storage.isCalibrated()) {
    const off = storage.getCalibrationOffsetMs();
    const spread = storage.getCalibrationSpreadMs();
    menuCalibration.textContent = `Calibration: ${off >= 0 ? '+' : ''}${off.toFixed(0)}ms${spread != null ? ` (spread ±${spread.toFixed(0)}ms)` : ''}`;
    btnCalibrate.textContent = 'Recalibrate timing';
  } else {
    menuCalibration.textContent = 'Not calibrated yet - taps may be ignored until you do.';
    btnCalibrate.textContent = 'Calibrate timing';
  }
  chkGuides.checked = guidesEnabledFor(game);
}
refreshMenu();

chkLowEnd.checked = FORCE_LOWEND || storage.getLowEndPref() || detectLowEnd(false);
chkLowEnd.addEventListener('change', () => storage.setLowEndPref(chkLowEnd.checked));

chkGuides.addEventListener('change', () => storage.setGuidesPref(chkGuides.checked));

btnPlay.addEventListener('click', async () => {
  await resumeContext();
  if (!storage.isCalibrated() && !AUTOPLAY) {
    startCalibration(() => startRun());
  } else {
    startRun();
  }
});

// Always available (section A) - recalibrating never touches saved progress.
btnCalibrate.addEventListener('click', async () => {
  await resumeContext();
  startCalibration(() => {
    refreshMenu();
    showScreen('menu');
  });
});

// --- calibration (section A) ------------------------------------------
// See js/calibration.js for the pairing/outlier/clamp math (and why it
// replaces the old count-based pairing that caused the M1.5 zero-hits bug).
const CAL_TAPS = 12;
const CAL_BPM = 100;
const CAL_MAX_ATTEMPTS = 4;

function startCalibration(onDone) {
  showScreen('calibrate');
  const statusEl = document.getElementById('calibrate-status');
  const detailEl = document.getElementById('calibrate-detail');
  const tapArea = document.getElementById('calibrate-taparea');
  const beginBtn = document.getElementById('btn-calibrate-begin');

  statusEl.textContent = 'Tap the circle (or press any key) in time with the clicks.';
  detailEl.textContent = '';
  beginBtn.hidden = false;
  tapArea.hidden = true;

  beginBtn.onclick = async () => {
    await resumeContext();
    beginBtn.hidden = true;
    tapArea.hidden = false;
    runCalibrationFlow(statusEl, detailEl, tapArea, onDone);
  };
}

/** Resolves with an array of raw tap AudioContext times, once `count` taps
 * have arrived or `timeoutMs` has elapsed (whichever first). No release
 * handling needed - calibration only ever cares about presses. */
function waitForTaps(tapArea, count, timeoutMs, onProgress) {
  return new Promise((resolve) => {
    const taps = [];
    let done = false;
    let timer;
    const detach = attachInput(tapArea, (rawTime) => {
      if (done) return;
      taps.push(rawTime);
      onProgress?.(taps.length, count);
      if (taps.length >= count) finish();
    }, null);
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      detach();
      resolve(taps);
    }
    timer = setTimeout(finish, timeoutMs);
  });
}

async function runCalibrationFlow(statusEl, detailEl, tapArea, onDone) {
  const beatDur = 60 / CAL_BPM;
  for (let attempt = 1; attempt <= CAL_MAX_ATTEMPTS; attempt++) {
    const ctx = getContext();
    statusEl.textContent = attempt === 1 ? 'Tap the circle (or press any key) in time with the clicks.' : `Let's try again (attempt ${attempt}/${CAL_MAX_ATTEMPTS})...`;
    detailEl.textContent = '';
    await sleep(600);

    const startAt = ctx.currentTime + 0.6;
    const clickTimes = [];
    for (let i = 0; i < CAL_TAPS; i++) {
      const t = startAt + i * beatDur;
      clickTimes.push(t);
      scheduleClick(ctx, ctx.destination, t, { freq: 1500, gain: 0.5 });
    }
    const timeoutMs = (CAL_TAPS * beatDur + 2.5) * 1000;
    const tapTimes = await waitForTaps(tapArea, CAL_TAPS, timeoutMs, (n, total) => {
      statusEl.textContent = `Tap ${n} / ${total}`;
    });

    const { offsetsMs, rejectedCount } = pairTapsToClicks(tapTimes, clickTimes, beatDur);
    const result = computeCalibration(offsetsMs);
    if (!result.ok) {
      statusEl.textContent = "That didn't look right - let's try again.";
      detailEl.textContent = result.reason;
      await sleep(1600);
      continue;
    }

    storage.setCalibrationOffsetMs(result.offsetMs, result.spreadMs);
    statusEl.textContent = `Measured offset: ${result.offsetMs >= 0 ? '+' : ''}${result.offsetMs.toFixed(0)}ms`;
    detailEl.textContent = `Spread: ±${result.spreadMs.toFixed(0)}ms over ${result.keptCount} taps` + (rejectedCount ? ` (${rejectedCount} tap(s) not near any click)` : '');
    await sleep(1400);

    await runCalibrationVerify(statusEl, detailEl, tapArea, result.offsetMs, beatDur);
    statusEl.textContent = 'Calibrated!';
    await sleep(900);
    onDone();
    return;
  }

  // Repeated failures: don't loop forever - fall back to a neutral offset
  // rather than leaving the player stuck on this screen.
  storage.setCalibrationOffsetMs(0, null);
  statusEl.textContent = "Still having trouble - using no offset for now. You can Recalibrate anytime from the menu.";
  detailEl.textContent = '';
  await sleep(2000);
  onDone();
}

/** A short 4-tap verify pass AFTER storing the offset: prints each tap's
 * residual (how far off it lands once the just-measured offset is applied)
 * so a bad calibration is visible immediately rather than discovered
 * mid-song. Informational only - doesn't gate proceeding. */
async function runCalibrationVerify(statusEl, detailEl, tapArea, offsetMs, beatDur) {
  const ctx = getContext();
  statusEl.textContent = 'Quick check - keep tapping with the clicks...';
  detailEl.textContent = '';
  const startAt = ctx.currentTime + 0.5;
  const clickTimes = [];
  for (let i = 0; i < VERIFY_TAPS; i++) {
    const t = startAt + i * beatDur;
    clickTimes.push(t);
    scheduleClick(ctx, ctx.destination, t, { freq: 1700, gain: 0.45 });
  }
  const timeoutMs = (VERIFY_TAPS * beatDur + 2) * 1000;
  const tapTimes = await waitForTaps(tapArea, VERIFY_TAPS, timeoutMs);
  const { residualsMs, rejectedCount } = computeVerifyResiduals(tapTimes, clickTimes, beatDur, offsetMs);
  if (residualsMs.length === 0) {
    detailEl.textContent = 'No verify taps registered - that’s fine, you can always Recalibrate later.';
  } else {
    detailEl.textContent =
      `Residuals: ${residualsMs.map((r) => `${r >= 0 ? '+' : ''}${r.toFixed(0)}ms`).join(', ')}` +
      (rejectedCount ? ` (${rejectedCount} stray)` : '');
  }
  await sleep(2000);
}

// --- run orchestration: build chart -> loading -> practice -> play --------
let previousStoryResult = null;
function revokePreviousEndings() {
  if (!previousStoryResult) return;
  const urls = new Set([previousStoryResult.goodEndingPanel.goodUrl, previousStoryResult.badEndingPanel.goodUrl]);
  urls.forEach((u) => URL.revokeObjectURL(u));
  previousStoryResult = null;
}

function updateSeedInUrl(seed) {
  const url = new URL(location.href);
  url.searchParams.set('seed', seed);
  history.replaceState(null, '', url);
}

async function startRun(explicitSeed) {
  revokePreviousEndings();
  showScreen('loading');
  const { game, level, clearedIds } = chooseGameAndLevel();
  const seed = explicitSeed !== undefined ? explicitSeed : resolveSeed(urlParams.get('seed'));
  storage.setLastSeed(seed);
  updateSeedInUrl(seed);

  const lowEnd = chkLowEnd.checked || FORCE_LOWEND;
  const progressBar = document.getElementById('loading-bar');
  const progressLabel = document.getElementById('loading-label');
  const setProgress = (frac, label) => {
    progressBar.style.width = `${Math.round(Math.min(1, frac) * 100)}%`;
    if (label) progressLabel.textContent = label;
  };
  setProgress(0, 'Composing the song...');

  // Dedicated rng streams (chart/synth/sfx are independent - removing the
  // old baked melody, or any other change to one, must never reshuffle the
  // others' draws for the same seed).
  const chartRng = subRng(seed, 'chart');
  const chart = buildChart(chartRng, game, level, { clearedIds });

  if (DEBUG) {
    const violations = lintChart(chart);
    console.log(
      `[songform] game=${game.id} level=${level} bpm=${chart.bpm} sections=${chart.sections.length} ` +
        `notes=${chart.notes.length} cues=${chart.cues.length} lint=${violations.length === 0 ? 'OK' : violations.length + ' violation(s)'}`
    );
    if (violations.length) violations.forEach((v) => console.warn('[lint]', v));
    for (const s of chart.sections) {
      console.log(`  section#${s.index} ${s.kind} beats=${s.beats} groove=${s.groove} events=${s.eventCount}`);
    }
  }

  const budget = getBudget(lowEnd);
  const synthRng = subRng(seed, 'synth');
  const { buffer } = await renderSong(synthRng, chart, getGame, { sampleRate: budget.audioSampleRate });
  setProgress(0.15, 'Song ready. Warming up the sound effects...');
  await new Promise((r) => setTimeout(r, 0));

  const sfxRng = subRng(seed, 'sfx');
  const sfxPacks = await renderAllPacks(sfxRng, chart, getGame, budget.audioSampleRate);
  const guidePack = await renderGuidePack(budget.audioSampleRate); // section C - generic, no rng needed
  setProgress(0.25, 'Painting the story...');
  await new Promise((r) => setTimeout(r, 0));

  const regionCounts = chart.phrases.map((p) => p.regionCount);
  const stylePrefs = computeStylePrefs(game, chart);
  const storyResult = await loadStory(
    SOURCE_TYPES.PROCEDURAL,
    { seed, numPhrases: chart.numPhrases, regionCounts, lowEnd, stylePrefs },
    (frac, label) => setProgress(0.25 + frac * 0.75, `Painting ${label}...`)
  );

  setProgress(1, 'Ready!');
  await new Promise((r) => setTimeout(r, 150));
  previousStoryResult = storyResult;

  const runCtx = { seed, game, level, chart, songBuffer: buffer, sfxPacks, guidePack, storyResult, sampleRate: budget.audioSampleRate };
  maybeStartPractice(runCtx);
}

// --- practice (section D) --------------------------------------------------
// Reuses the ALREADY-rendered song buffer (a slice of it, via
// AudioBufferSourceNode start(when, offset, duration) - no extra render)
// and the real judge/input pipeline against that section's own notes, so
// "practice" behaves exactly like the real thing at a smaller scale, guides
// included. Per cue type: Listen (demo, unscored) -> up to 3 "Your turn"
// rounds (count-in, then an attempt), needing >=2 rounds to pass; a timeline
// strip with a moving playhead shows "when" visually, and every judged tap
// gets immediate direction+ms feedback.
const PRACTICE_ROUNDS_MAX = 3;
const PRACTICE_ROUNDS_TO_PASS = 2;
const PRACTICE_PASS_RATIO = 0.7; // matches the real game's own clear threshold

function maybeStartPractice(runCtx) {
  const { game } = runCtx;
  const steps = (game.practice || []).filter((p) => !storage.isCuePracticed(game.id, p.cueId));
  if (AUTOPLAY || game.id === 'remix' || steps.length === 0) {
    startPlay(runCtx);
    return;
  }
  showScreen('practice');
  runPracticeSteps(runCtx, steps, 0);
}

function sectionForCue(chart, game, cueId) {
  const idx = (game.cueTypes || []).findIndex((c) => c.id === cueId);
  const kind = idx === 0 ? 'teachA' : idx === 1 ? 'teachB' : 'varyA';
  return chart.sections.find((s) => s.kind === kind) || chart.sections.find((s) => s.isPhrase);
}

function practiceEls() {
  return {
    mascotEl: document.getElementById('practice-mascot'),
    titleEl: document.getElementById('practice-title'),
    meaningEl: document.getElementById('practice-meaning'),
    phaseEl: document.getElementById('practice-phase'),
    feedbackEl: document.getElementById('practice-feedback'),
    tallyEl: document.getElementById('practice-tally'),
    tapArea: document.getElementById('practice-taparea'),
    timelineEl: document.getElementById('practice-timeline'),
    playheadEl: document.getElementById('practice-playhead'),
    hearBtn: document.getElementById('btn-practice-hear'),
    continueBtn: document.getElementById('btn-practice-continue'),
    skipBtn: document.getElementById('btn-practice-skip'),
  };
}

async function runPracticeSteps(runCtx, steps, i) {
  if (i >= steps.length) {
    startPlay(runCtx);
    return;
  }
  const { game, chart } = runCtx;
  const step = steps[i];
  const cueInfo = (game.cueTypes || []).find((c) => c.id === step.cueId);
  const section = sectionForCue(chart, game, step.cueId);
  const els = practiceEls();

  els.mascotEl.textContent = game.mascot?.emoji || '🎵';
  els.titleEl.textContent = `Practice: ${game.name}`;
  // Plain-language statement of what the cue means (section D).
  els.meaningEl.textContent = cueInfo ? `${cueInfo.glyph ? cueInfo.glyph + ' ' : ''}${step.caption || cueInfo.meaning}` : step.caption || '';
  els.tallyEl.textContent = '';
  els.continueBtn.hidden = true;
  els.hearBtn.onclick = () => practiceListen(runCtx, section, els);

  let skipped = false;
  const finishSkip = () => {
    skipped = true;
    storage.markCuePracticed(game.id, step.cueId);
    startPlay(runCtx);
  };
  els.skipBtn.onclick = finishSkip;

  await practiceListen(runCtx, section, els);
  if (skipped) return;

  let passed = 0;
  let round = 0;
  while (round < PRACTICE_ROUNDS_MAX && passed < PRACTICE_ROUNDS_TO_PASS && !skipped) {
    round++;
    const outcome = await practiceAttemptRound(runCtx, section, els, round);
    if (skipped) return;
    if (outcome === 'pass') passed++;
    els.tallyEl.textContent = `Round ${round} of ${PRACTICE_ROUNDS_MAX} - ${passed} passed`;
  }
  if (skipped) return;

  if (passed < PRACTICE_ROUNDS_TO_PASS) {
    const proceed = await new Promise((resolve) => {
      els.phaseEl.textContent = "Still getting the hang of it - that's okay.";
      els.continueBtn.hidden = false;
      els.continueBtn.onclick = () => resolve(true);
      els.skipBtn.onclick = () => {
        finishSkip();
        resolve(false);
      };
    });
    els.continueBtn.hidden = true;
    if (!proceed) return;
  }

  storage.markCuePracticed(game.id, step.cueId);
  runPracticeSteps(runCtx, steps, i + 1);
}

/** Positions one pre-created marker per note along the timeline strip
 * (static once built - only the playhead animates per frame). */
function buildPracticeTimeline(timelineEl, notes, sectionStart, sectionDur) {
  timelineEl.querySelectorAll('.practice-timeline__note').forEach((el) => el.remove());
  for (const n of notes) {
    const pct = sectionDur > 0 ? Math.min(100, Math.max(0, ((n.time - sectionStart) / sectionDur) * 100)) : 0;
    const el = document.createElement('div');
    el.className = 'practice-timeline__note' + (n.kind === 'hold' ? ' practice-timeline__note--hold' : '');
    el.style.left = `${pct.toFixed(2)}%`;
    timelineEl.appendChild(el);
  }
}

function practiceSectionNotes(chart, section, playStart) {
  return chart.notes
    .filter((n) => n.sectionIndex === section.index)
    .map((n) => ({
      ...n,
      time: n.time - section.startTime + playStart,
      releaseTime: n.releaseTime != null ? n.releaseTime - section.startTime + playStart : undefined,
      judged: false,
      judgement: null,
    }));
}

/** Listen phase: the demo plays through (mascot performs via the normal
 * cue/mascot pulses if a stage were present - practice has no picture stage,
 * so this is audio + the timeline/playhead only), no input, nothing scored. */
function practiceListen(runCtx, section, els) {
  return new Promise((resolve) => {
    const ctx = getContext();
    const { chart, songBuffer, guidePack } = runCtx;
    if (!section) {
      resolve();
      return;
    }
    els.phaseEl.textContent = 'Listen...';
    els.feedbackEl.textContent = '';
    els.feedbackEl.className = 'practice-feedback';

    const lead = 0.3;
    const playStart = ctx.currentTime + lead;
    const sectionDur = section.endTime - section.startTime;
    const notes = practiceSectionNotes(chart, section, playStart);
    buildPracticeTimeline(els.timelineEl, notes, playStart, sectionDur);

    const src = ctx.createBufferSource();
    src.buffer = songBuffer;
    src.connect(ctx.destination);
    const safeDur = Math.min(sectionDur, songBuffer.duration - section.startTime);
    src.start(playStart, section.startTime, Math.max(0.1, safeDur));

    if (guidePack) {
      for (const n of notes) {
        scheduleBuffer(ctx, guidePack.tick, ctx.destination, n.time, { gain: 0.4 });
        if (n.kind === 'hold' && n.releaseTime != null) scheduleBuffer(ctx, guidePack.release, ctx.destination, n.releaseTime, { gain: 0.35 });
      }
    }

    const endAt = playStart + sectionDur + 0.3;
    let rafId;
    function frame() {
      const now = ctx.currentTime;
      const rel = sectionDur > 0 ? Math.max(0, Math.min(1, (now - playStart) / sectionDur)) : 0;
      els.playheadEl.style.left = `${(rel * 100).toFixed(2)}%`;
      if (now < endAt) rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    setTimeout(
      () => {
        cancelAnimationFrame(rafId);
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        resolve();
      },
      (endAt - ctx.currentTime) * 1000
    );
  });
}

/** "Your turn": a count-in, then a scored (practice-only) attempt against
 * the section's own notes, with per-tap direction+ms feedback and a
 * timeline playhead. Resolves 'pass' or 'fail' (>=70% good+ = pass, same
 * bar the real game clears at). */
function practiceAttemptRound(runCtx, section, els) {
  return new Promise((resolve) => {
    const ctx = getContext();
    const { chart, songBuffer, guidePack } = runCtx;
    if (!section) {
      resolve('pass');
      return;
    }
    els.feedbackEl.textContent = '';
    els.feedbackEl.className = 'practice-feedback';

    const countInBeats = 4;
    const beatDur = chart.beatDuration;
    const countInStart = ctx.currentTime + 0.2;
    els.phaseEl.textContent = 'Get ready...';
    for (let b = 0; b < countInBeats; b++) {
      scheduleClick(ctx, ctx.destination, countInStart + b * beatDur, { freq: 1600, gain: 0.5 });
    }
    const playStart = countInStart + countInBeats * beatDur;
    setTimeout(() => {
      els.phaseEl.textContent = 'Your turn!';
    }, Math.max(0, (playStart - ctx.currentTime) * 1000 - 250));

    const sectionDur = section.endTime - section.startTime;
    const notes = practiceSectionNotes(chart, section, playStart);
    buildPracticeTimeline(els.timelineEl, notes, playStart, sectionDur);

    const src = ctx.createBufferSource();
    src.buffer = songBuffer;
    src.connect(ctx.destination);
    const safeDur = Math.min(sectionDur, songBuffer.duration - section.startTime);
    src.start(playStart, section.startTime, Math.max(0.1, safeDur));

    if (guidePack) {
      for (const n of notes) {
        scheduleBuffer(ctx, guidePack.tick, ctx.destination, n.time, { gain: 0.55 });
        if (n.kind === 'hold' && n.releaseTime != null) scheduleBuffer(ctx, guidePack.release, ctx.destination, n.releaseTime, { gain: 0.5 });
      }
    }

    const tally = { good: 0, total: 0 };
    const calibrationOffsetSec = storage.getCalibrationOffsetMs() / 1000;
    const judge = createJudge(notes, {
      calibrationOffsetSec,
      onJudged: (evt) => {
        if (evt.type === 'ignored') {
          if (evt.deltaMs != null) {
            const dir = evt.deltaMs >= 0 ? 'late' : 'early';
            els.feedbackEl.textContent = `Missed - ${Math.abs(evt.deltaMs).toFixed(0)}ms too ${dir}`;
            els.feedbackEl.className = 'practice-feedback practice-feedback--miss';
          }
          return;
        }
        if (!evt.final) return;
        tally.total++;
        const good = evt.judgement === 'perfect' || evt.judgement === 'good' || evt.judgement === 'avoided';
        if (good) tally.good++;
        const ms = evt.offsetMs;
        let text;
        if (evt.judgement === 'avoided') text = 'Nice! (correctly avoided)';
        else if (ms == null) text = good ? 'Nice!' : 'Missed it';
        else {
          const dir = ms >= 0 ? 'late' : 'early';
          const msTxt = `${ms >= 0 ? '+' : ''}${ms.toFixed(0)}ms`;
          text = good ? `Nice! ${msTxt}` : `Too ${dir} ${msTxt}`;
        }
        els.feedbackEl.textContent = text;
        els.feedbackEl.className = 'practice-feedback' + (good ? '' : ' practice-feedback--miss');
      },
    });
    const detach = attachInput(els.tapArea, judge.judgeTap, judge.judgeRelease);

    const endAt = playStart + sectionDur + 0.5;
    let rafId;
    function frame() {
      const now = ctx.currentTime;
      judge.update(now);
      const rel = sectionDur > 0 ? Math.max(0, Math.min(1, (now - playStart) / sectionDur)) : 0;
      els.playheadEl.style.left = `${(rel * 100).toFixed(2)}%`;
      if (now < endAt) rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    setTimeout(
      () => {
        detach();
        cancelAnimationFrame(rafId);
        try {
          src.stop();
        } catch {
          /* already stopped */
        }
        const passed = tally.total > 0 ? tally.good / tally.total >= PRACTICE_PASS_RATIO : true;
        resolve(passed ? 'pass' : 'fail');
      },
      (endAt - ctx.currentTime) * 1000
    );
  });
}

// --- play ------------------------------------------------------------------
function startPlay(runCtx) {
  const { seed, game, level, chart, songBuffer, sfxPacks, guidePack, storyResult } = runCtx;
  showScreen('play');
  const ctx = getContext();
  const stageEl = document.getElementById('stage');
  const stage = createStage(stageEl);
  stage.setMascot(game.id === 'remix' ? REMIX : game, getGame);
  // TODO(mascot captions): the plan suggests captions can mention the
  // mascot ("The bird sang, and a little fox answered..."). storygen.js is
  // owned by the parallel art-style agent, so this isn't wired up here -
  // panel captions are shown exactly as storygen.js writes them; the
  // mascot corner (stage.setMascot above / per-cue switching in
  // stage.tick()) is the only mascot presence for now.

  // Cue glyph/name lookup for the corner icon (section C / corner-indicator
  // legend) - stage.js stays a leaf module (no js/games/* import), so it's
  // handed this resolver instead.
  function resolveCueType(srcGameId, cueId) {
    const g = getGame(srcGameId || game.id);
    return (g?.cueTypes || []).find((c) => c.id === cueId);
  }

  const startTime = ctx.currentTime + 0.5;
  const absChart = toAbsoluteChart(chart, startTime);

  let src = ctx.createBufferSource();
  src.buffer = songBuffer;
  src.connect(ctx.destination);
  src.start(startTime);

  // Guides (section C): on while this game is uncleared, off once cleared,
  // overridable via the menu checkbox or ?guides=. Ticks are scheduled ONCE
  // up front (Web Audio's own scheduler is sample-accurate regardless of
  // how far ahead .start() is called) and again, for whatever's left, after
  // a pause/resume time-shift (see resumeNow()) - never per-frame/per-tap.
  const guidesOn = guidesEnabledFor(game);
  stage.setGuidesEnabled(guidesOn);
  stage.setGuideTargets(absChart.notes);
  function scheduleGuideTicks() {
    if (!guidesOn || !guidePack) return;
    for (const n of absChart.notes) {
      if (n.judged || n.fake) continue;
      scheduleBuffer(ctx, guidePack.tick, ctx.destination, n.time, { gain: 0.5 });
      if (n.kind === 'hold' && n.releaseTime != null) {
        scheduleBuffer(ctx, guidePack.release, ctx.destination, n.releaseTime, { gain: 0.45 });
      }
    }
  }
  scheduleGuideTicks();

  const calibrationOffsetSec = storage.getCalibrationOffsetMs() / 1000;
  const counts = { perfect: 0, good: 0, avoided: 0, miss: 0, skipped: 0, ignored: 0 };
  let score = 0;
  const debugOffsets = [];
  // Section B: median signed offset over ALL taps, including ignored ones
  // (a real, ignored tap still carries a signed deltaMs - see input.js) -
  // this is what makes a systematic miscalibration visible/self-correcting
  // instead of just silently dropping every tap.
  const allSignedOffsets = [];
  debugLog.innerHTML = '';
  debugStats.textContent = '';

  // --- backgrounding (visibilitychange/blur/pagehide) --------------------
  // See js/pause.js + js/songform.js planPauseResume() for the mechanics;
  // this block just wires them to the DOM/audio nodes this closure owns.
  // Disabled entirely under any ?autoplay= mode: autoplay's own synthetic
  // pointer-event schedule (scheduleEventsAutoplay below) is built ONCE
  // from the chart's pre-shift note times, so a pause/resume time-shift
  // partway through would desync it from the (now-shifted) chart - autoplay
  // is a debug/testing tool, real backgrounding is a real-player concern,
  // and the two don't need to compose.
  const pauseOverlayEl = document.getElementById('pause-overlay');
  let paused = false;
  let pauseCtxTime = 0;
  let pauseGeneration = 0;
  let sessionEnded = false;

  function pauseNow(source) {
    if (AUTOPLAY || paused || sessionEnded) return;
    paused = true;
    pauseGeneration++;
    pauseCtxTime = ctx.currentTime;
    cancelAnimationFrame(rafId);
    detachInput();
    try {
      src.stop();
    } catch {
      /* already stopped */
    }
    for (const node of activeSustainNodes.values()) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    activeSustainNodes.clear();
    pauseOverlayEl.hidden = false;
    pushDebugRow(`paused @ ${pauseCtxTime.toFixed(3)}s (${source})`);
  }

  async function resumeNow() {
    if (!paused || sessionEnded) return;
    const myGeneration = pauseGeneration;
    paused = false;
    pauseOverlayEl.hidden = true;
    await resumeContext(); // satisfies autoplay policy if the context had suspended
    if (myGeneration !== pauseGeneration || sessionEnded) return; // paused again mid-await

    const beatDur = chart.beatDuration;
    const countInBeats = 4;
    const countInStart = ctx.currentTime + 0.15;
    for (let i = 0; i < countInBeats; i++) {
      scheduleClick(ctx, ctx.destination, countInStart + i * beatDur, { freq: 1600, gain: 0.55 });
    }
    const newAudioStart = countInStart + countInBeats * beatDur;

    const plan = planPauseResume(absChart, pauseCtxTime, newAudioStart);
    counts.skipped += plan.skippedCount;

    const lastShownIdx = Math.min(plan.resumeIdx, storyResult.panels.length);
    for (let i = currentPhraseIndex + 1; i < lastShownIdx; i++) {
      stage.discardPanel(storyResult.panels[i]);
    }
    if (currentPhraseIndex >= 0 && currentPhraseIndex < plan.resumeIdx) {
      stage.forceCompletePanel(storyResult.panels[currentPhraseIndex]);
    }
    currentPhraseIndex = Math.min(plan.resumeIdx, absChart.phrases.length) - 1;

    const bufferOffset = Math.max(0, plan.resumeAtAbsTime - startTime);
    src = ctx.createBufferSource();
    src.buffer = songBuffer;
    src.connect(ctx.destination);
    src.start(newAudioStart, bufferOffset);
    scheduleGuideTicks(); // re-schedule for whatever's left at their NEW (shifted) times

    detachInput = attachInput(stageEl, judge.judgeTap, judge.judgeRelease);
    pushDebugRow(
      `resumed - skipped ${plan.skippedCount} note(s), restarting at phrase ${plan.resumeIdx} after a ${countInBeats}-beat count-in`
    );
    rafId = requestAnimationFrame(frame);
  }

  pauseOverlayEl.onclick = () => resumeNow();
  const detachAutoPause = attachAutoPause((source) => pauseNow(source));

  // Hold sustain loop nodes currently playing, keyed by note - started on a
  // successful holdPress, stopped exactly on that note's terminal judgement.
  const activeSustainNodes = new Map();

  function packFor(note) {
    return sfxPacks.get(note.srcGame || chart.gameId);
  }

  function onJudged(evt) {
    if (evt.type === 'ignored') {
      counts.ignored++;
      // Section B: self-diagnosis - an ignored tap now carries the nearest
      // note and a signed delta, so a systematic miscalibration reads as
      // "ignored +412ms LATE (nearest note #12)" instead of a bare
      // timestamp with no way to tell a real miss from a timing bug.
      if (evt.deltaMs != null) {
        allSignedOffsets.push(evt.deltaMs);
        const dir = evt.deltaMs >= 0 ? 'LATE' : 'EARLY';
        const noteNum = evt.nearestIndex >= 0 ? evt.nearestIndex + 1 : '?';
        pushDebugRow(`ignored ${evt.deltaMs >= 0 ? '+' : ''}${evt.deltaMs.toFixed(0)}ms ${dir} (nearest note #${noteNum}) (${evt.source})`);
      } else {
        pushDebugRow(`ignored tap @ ${evt.tapTime.toFixed(3)}s (${evt.source})`);
      }
      return;
    }
    const { note, judgement, offsetMs, source, phase, final } = evt;
    stage.onJudged(evt, getGame);

    if (phase === 'holdPress') {
      if ((judgement === 'perfect' || judgement === 'good') && source !== 'auto') {
        const pack = packFor(note);
        const node = pack && pack.holdSustain ? playBuffer(ctx, pack.holdSustain, ctx.destination, { loop: true, gain: 0.8 }) : null;
        if (node) activeSustainNodes.set(note, node);
      }
      return;
    }
    if (!final) return;

    const sustainNode = activeSustainNodes.get(note);
    if (sustainNode) {
      try {
        sustainNode.stop();
      } catch {
        /* already stopped */
      }
      activeSustainNodes.delete(note);
    }

    counts[judgement] = (counts[judgement] || 0) + 1;
    if (judgement === 'perfect') score += 100;
    else if (judgement === 'good' || judgement === 'avoided') score += 50;

    // Design principle (plan, "the player makes the response sound"):
    // hitting feels good, missing is audibly silent - a miss plays NO live
    // sfx at all, so the backing/cue track never spells out what the
    // correct response would have sounded like.
    if (source !== 'auto' && note && judgement !== 'miss') {
      const pack = packFor(note);
      if (pack) {
        const buf = phase === 'holdRelease' ? pack.holdRelease : pack.tapGood;
        if (buf) playBuffer(ctx, buf, ctx.destination, { gain: 0.9 });
      }
    }

    if (offsetMs != null) {
      debugOffsets.push(offsetMs);
      allSignedOffsets.push(offsetMs);
      pushDebugRow(`${judgement} ${offsetMs.toFixed(1)}ms (${source})`);
      updateDebugStats(debugOffsets, counts.ignored, allSignedOffsets);
    }
  }

  const judge = createJudge(absChart.notes, { calibrationOffsetSec, onJudged });
  let detachInput = attachInput(stageEl, judge.judgeTap, judge.judgeRelease);

  stage.showPanel(storyResult.coverPanel); // visible immediately, during count-in
  stage.forceCompletePanel(storyResult.coverPanel); // single-region: show it whole, no tap needed

  let currentPhraseIndex = -1; // -1 while the cover panel is showing
  let eventsAutoplayStopped = false;

  // ?autoplay=events - dispatches REAL synthetic pointerdown/pointerup on
  // the stage at each note's press/release time, exercising the same path a
  // human does: DOM event -> clock.eventToContextTime -> input.js judging.
  // Holds get BOTH a down and an up action; fakes get none (skipped, so
  // they auto-resolve as "avoided").
  let eventsActions = null;
  let eventsIdx = 0;
  function buildEventsActions() {
    const actions = [];
    for (const note of absChart.notes) {
      if (note.fake) continue;
      actions.push({ time: note.time, type: 'pointerdown' });
      if (note.kind === 'hold') actions.push({ time: note.releaseTime, type: 'pointerup' });
    }
    actions.sort((a, b) => a.time - b.time);
    return actions;
  }
  function scheduleEventsAutoplay() {
    if (eventsAutoplayStopped) return;
    if (!eventsActions) eventsActions = buildEventsActions();
    if (eventsIdx >= eventsActions.length) return;
    const action = eventsActions[eventsIdx];
    eventsIdx++;
    const delayMs = Math.max(0, (action.time - ctx.currentTime) * 1000);
    setTimeout(() => {
      if (eventsAutoplayStopped) return;
      const evt = new PointerEvent(action.type, { bubbles: true, cancelable: true, pointerId: 1 });
      stageEl.dispatchEvent(evt);
      scheduleEventsAutoplay();
    }, delayMs);
  }
  if (AUTOPLAY === 'events') {
    scheduleEventsAutoplay();
  }

  function advancePhraseIfNeeded(nowCtx) {
    let target = currentPhraseIndex;
    while (target + 1 < absChart.phrases.length && nowCtx >= absChart.phrases[target + 1].startTime) {
      target++;
    }
    if (target === currentPhraseIndex) return;

    for (let i = currentPhraseIndex + 1; i < target; i++) {
      stage.discardPanel(storyResult.panels[i]);
    }
    if (currentPhraseIndex >= 0) {
      stage.forceCompletePanel(storyResult.panels[currentPhraseIndex]);
    }
    currentPhraseIndex = target;
    stage.showPanel(storyResult.panels[currentPhraseIndex]);
  }

  // ?autoplay=perfect - taps every real (non-fake) note exactly on time via
  // judge.judgeTap directly, and releases every hold exactly on time via
  // judge.judgeRelease. Fakes are deliberately left untouched so they
  // auto-resolve as "avoided" (a success) once their window passes.
  let autoplayPressIdx = 0;
  function autoplayTick(nowCtx) {
    if (AUTOPLAY !== 'perfect') return;
    while (autoplayPressIdx < absChart.notes.length && absChart.notes[autoplayPressIdx].time <= nowCtx) {
      const note = absChart.notes[autoplayPressIdx];
      const noteNumber = autoplayPressIdx + 1; // 1-based, for missEvery
      const deliberateMiss = MISS_EVERY > 0 && noteNumber % MISS_EVERY === 0;
      if (!note.fake && !note.judged && !note._pressResolved && !deliberateMiss) {
        judge.judgeTap(note.time + calibrationOffsetSec, 'autoplay');
      }
      autoplayPressIdx++;
    }
    for (const note of absChart.notes) {
      if (note.kind === 'hold' && note._pressResolved && !note.judged && note.releaseTime <= nowCtx) {
        judge.judgeRelease(note.releaseTime + calibrationOffsetSec, 'autoplay');
      }
    }
  }

  let rafId;
  function frame() {
    const nowCtx = ctx.currentTime;
    advancePhraseIfNeeded(nowCtx);
    autoplayTick(nowCtx); // inject synthetic taps before the auto-miss sweep
    judge.update(nowCtx);
    stage.tick(nowCtx, absChart, getGame, resolveCueType);

    if (nowCtx >= absChart.absoluteEndTime) {
      finishPlay();
      return;
    }
    rafId = requestAnimationFrame(frame);
  }
  rafId = requestAnimationFrame(frame);

  function finishPlay() {
    sessionEnded = true;
    detachAutoPause();
    pauseOverlayEl.hidden = true;
    cancelAnimationFrame(rafId);
    eventsAutoplayStopped = true;
    detachInput();
    for (const node of activeSustainNodes.values()) {
      try {
        node.stop();
      } catch {
        /* already stopped */
      }
    }
    activeSustainNodes.clear();
    if (currentPhraseIndex >= 0) {
      stage.forceCompletePanel(storyResult.panels[currentPhraseIndex]);
    }
    stage.releaseAll();
    try {
      src.stop();
    } catch {
      /* already stopped */
    }

    // counts.skipped (notes that passed while the tab was backgrounded - see
    // planPauseResume) is deliberately EXCLUDED here: it's neither a hit nor
    // a miss, so it counts toward neither the numerator nor the denominator.
    const judged = counts.perfect + counts.good + counts.avoided + counts.miss;
    const accuracy = judged > 0 ? (counts.perfect + counts.good + counts.avoided) / judged : 0;
    applyProgression(game, level, accuracy);
    const recalSuggestion = checkRecalibrateSuggestion(allSignedOffsets);
    showEndScreen({ seed, game, level, counts, score, accuracy, storyResult, allTapsMedianMs: medianOf(allSignedOffsets), recalSuggestion });
  }
}

// --- section B: recalibrate suggestion --------------------------------
// "If >=8 taps share a consistent direction and |median| > 60ms, offer
// 'Your taps are consistently N ms late - recalibrate?'"
const RECAL_MIN_TAPS = 8;
const RECAL_MIN_MEDIAN_MS = 60;
function checkRecalibrateSuggestion(allSignedOffsets) {
  if (allSignedOffsets.length < RECAL_MIN_TAPS) return null;
  const med = medianOf(allSignedOffsets);
  if (med == null || Math.abs(med) <= RECAL_MIN_MEDIAN_MS) return null;
  const sameDir = allSignedOffsets.filter((v) => Math.sign(v) === Math.sign(med)).length;
  if (sameDir < RECAL_MIN_TAPS) return null;
  return { medianMs: med, count: sameDir };
}

// --- progression -----------------------------------------------------------
const PROGRESSION_FORCED = FORCE_GAME != null || FORCE_LEVEL != null;

function applyProgression(game, level, accuracy) {
  if (PROGRESSION_FORCED) return; // ?game=/?level= is a debug override - never mutates saved progress
  storage.incrementGamesPlayed();
  const passed = accuracy >= 0.7;
  if (passed) {
    if (game.id !== 'remix') storage.markCleared(game.id);
    storage.setLevel(level + 1);
  }
  // Fail: level unchanged - "Back to menu"/"Play again" retries the same
  // level with a fresh seed (a new seed is drawn on every new run anyway).
}

// --- end -------------------------------------------------------------------
function showEndScreen({ seed, game, level, counts, score, accuracy, storyResult, allTapsMedianMs, recalSuggestion }) {
  showScreen('end');
  const good = accuracy >= 0.7;
  const endingPanel = good ? storyResult.goodEndingPanel : storyResult.badEndingPanel;

  const endImageHost = document.getElementById('end-image');
  endImageHost.innerHTML = '';
  const endImg = document.createElement('img');
  endImg.src = endingPanel.goodUrl;
  endImg.alt = '';
  endImg.className = 'end-image__canvas';
  endImageHost.appendChild(endImg);

  document.getElementById('end-title').textContent = good ? 'A good ending!' : 'A rough journey...';
  document.getElementById('end-caption').textContent = endingPanel.caption;
  document.getElementById('end-score').textContent = `Score: ${score}  (${game.mascot?.emoji || ''} ${game.name}, level ${level})`;
  document.getElementById('end-counts').textContent =
    `Perfect: ${counts.perfect}   Good: ${counts.good}   Avoided: ${counts.avoided}   Miss: ${counts.miss}` +
    (counts.skipped ? `   Skipped: ${counts.skipped}` : '') +
    `   Accuracy: ${Math.round(accuracy * 100)}%`;
  document.getElementById('end-seed').textContent = `Seed: ${seed}${good ? ` - next up: level ${storage.getLevel()}` : ' - try again'}`;

  // Section B: median signed offset over ALL taps (ignored included).
  const medianEl = document.getElementById('end-timing');
  if (allTapsMedianMs != null) {
    medianEl.hidden = false;
    medianEl.textContent = `Median timing: ${allTapsMedianMs >= 0 ? '+' : ''}${allTapsMedianMs.toFixed(0)}ms`;
  } else {
    medianEl.hidden = true;
  }

  const recalEl = document.getElementById('end-recalibrate');
  const recalBtn = document.getElementById('btn-end-recalibrate');
  if (recalSuggestion) {
    recalEl.hidden = false;
    recalBtn.hidden = false;
    const dir = recalSuggestion.medianMs >= 0 ? 'late' : 'early';
    recalEl.textContent = `Your taps are consistently ${Math.abs(recalSuggestion.medianMs).toFixed(0)}ms ${dir} - recalibrate?`;
    recalBtn.onclick = async () => {
      await resumeContext();
      startCalibration(() => {
        refreshMenu();
        showScreen('menu');
      });
    };
  } else {
    recalEl.hidden = true;
    recalBtn.hidden = true;
  }

  document.getElementById('btn-play-again').onclick = () => {
    refreshMenu();
    startRun(resolveSeed(null));
  };
  document.getElementById('btn-replay-seed').onclick = () => startRun(seed);
  document.getElementById('btn-end-menu').onclick = () => {
    refreshMenu();
    showScreen('menu');
  };
}

// --- boot --------------------------------------------------------------
showScreen('menu');
