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
import { pairTapsToClicks, isCountInTap, computeCalibration, computeVerifyResiduals, VERIFY_TAPS, CAL_BPM, COUNT_IN_BEATS, VERIFY_COUNT_IN_BEATS } from './calibration.js';
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
const SW_PARAM = urlParams.get('sw'); // 'on' | 'off' | null

// --- offline support -------------------------------------------------------
// Registering sw.js precaches the whole site so it loads and plays with no
// connection after one visit (music/art are generated in-browser - there's
// nothing else to fetch). Skipped on localhost (unless ?sw=on) so a dev
// server never serves a stale cached module while editing; ?sw=off tears
// an existing registration back out for testing.
if ('serviceWorker' in navigator) {
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (SW_PARAM === 'off') {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      for (const reg of regs) reg.unregister();
      pushDebugRow(`sw: unregistered ${regs.length} registration(s) (?sw=off)`);
    });
  } else if (!isLocalhost || SW_PARAM === 'on') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js')
        .then((reg) => pushDebugRow(`sw: registered (scope ${reg.scope})`))
        .catch((err) => pushDebugRow(`sw: register failed: ${err}`));
    });
  }
}

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
// See js/calibration.js for the pairing/outlier/range math (and why it
// replaces the old count-based pairing that caused the M1.5 zero-hits bug,
// and the old symmetric clamp that rejected genuine Bluetooth latency).
const CAL_TAPS = 12;
const CAL_MAX_ATTEMPTS = 4;
const LEAD_IN = 0.3; // seconds of scheduling headroom before the first count-in click

// Tracks whichever calibration run is currently in flight, if any, so a
// fresh startCalibration() call can cancel a stale one first (e.g. if it's
// somehow re-entered before a previous run's tail end finished unwinding).
let activeCalibrationRun = null;

/** One calibration attempt-sequence's cancellable state: a dedicated
 * GainNode every calibration click is routed through (so Back can silence
 * anything already scheduled just by disconnecting it), a `cancelled` flag
 * checked after every await in the flow, and the set of pending
 * setTimeouts / the in-flight waitForTaps resolver so Back can also
 * short-circuit those immediately rather than leaving them to fire later
 * against a screen nobody's looking at. */
function createCalibrationRun(ctx) {
  const gain = ctx.createGain();
  gain.gain.value = 1;
  gain.connect(ctx.destination);
  let cancelled = false;
  let pendingTapResolver = null;
  const timers = new Set();
  return {
    ctx,
    dest: gain,
    get cancelled() {
      return cancelled;
    },
    /** setTimeout, but auto-cleared on cancel and no-op if it fires after. */
    schedule(fn, delayMs) {
      const id = setTimeout(() => {
        timers.delete(id);
        if (!cancelled) fn();
      }, delayMs);
      timers.add(id);
      return id;
    },
    setTapResolver(fn) {
      pendingTapResolver = fn;
    },
    clearTapResolver() {
      pendingTapResolver = null;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      try {
        gain.disconnect();
      } catch {
        /* already disconnected */
      }
      const resolve = pendingTapResolver;
      pendingTapResolver = null;
      resolve?.();
    },
  };
}

function startCalibration(onDone) {
  activeCalibrationRun?.cancel();
  showScreen('calibrate');
  const statusEl = document.getElementById('calibrate-status');
  const detailEl = document.getElementById('calibrate-detail');
  const countdownEl = document.getElementById('calibrate-countdown');
  const tapArea = document.getElementById('calibrate-taparea');
  const backBtn = document.getElementById('btn-calibrate-back');

  statusEl.textContent = 'Get ready...';
  detailEl.textContent = '';
  countdownEl.textContent = '';

  const run = createCalibrationRun(getContext());
  activeCalibrationRun = run;

  // Back: abort immediately (checked after every await below), silence
  // anything already scheduled, and go straight to the menu WITHOUT saving
  // anything or calling onDone - so Play's first-calibration path can't
  // accidentally start a run, and Recalibrate's existing offset is left
  // untouched.
  backBtn.onclick = () => {
    run.cancel();
    refreshMenu();
    showScreen('menu');
  };

  // The count-in starts immediately - there's no separate "Start tapping"
  // button any more. Every caller of startCalibration() is itself a click
  // handler that already awaited resumeContext(), so the autoplay-gesture
  // requirement is already satisfied by the time we get here.
  runCalibrationFlow(run, statusEl, detailEl, countdownEl, tapArea, onDone);
}

/** Resolves with an array of raw tap AudioContext times, once `count`
 * RECORDED taps have arrived or `timeoutMs` has elapsed (whichever first).
 * A tap that lands during the count-in (before `firstClickTime`, by the
 * same asymmetric-window logic used everywhere else - see
 * js/calibration.js isCountInTap()) is dropped BY TIME before it's ever
 * pushed, so it can't consume one of the `count` slots or shift later
 * pairing - the exact class of bug js/calibration.js's own pairing fix
 * exists for. `run.cancel()` makes a pending call resolve immediately (with
 * whatever taps happened to land) - the caller checks `run.cancelled`
 * right after and discards the result either way. No release handling
 * needed - calibration only ever cares about presses. */
function waitForTaps(run, tapArea, count, timeoutMs, firstClickTime, beatDur, onProgress) {
  return new Promise((resolve) => {
    const taps = [];
    let done = false;
    let timer;
    const detach = attachInput(
      tapArea,
      (rawTime) => {
        if (done) return;
        if (isCountInTap(rawTime, firstClickTime, beatDur)) return;
        taps.push(rawTime);
        onProgress?.(taps.length, count);
        if (taps.length >= count) finish();
      },
      null
    );
    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      detach();
      run.clearTapResolver();
      resolve(taps);
    }
    timer = setTimeout(finish, timeoutMs);
    run.setTapResolver(finish);
  });
}

/** Schedules the on-screen "4 3 2 1 Tap!" countdown in sync with the
 * count-in clicks, via setTimeout keyed off ctx time (the calibrate screen
 * has no per-frame visual otherwise, and a beat-synced setTimeout is exact
 * enough for on-screen text). Routed through run.schedule() so Back both
 * clears any not-yet-fired digit and stops a stray one from landing on the
 * menu screen afterwards. */
function scheduleCountdown(run, countdownEl, startAt, beats, beatDur) {
  for (let i = 0; i < beats; i++) {
    const delayMs = Math.max(0, (startAt + i * beatDur - run.ctx.currentTime) * 1000);
    run.schedule(() => {
      countdownEl.textContent = String(beats - i);
    }, delayMs);
  }
  const tapDelayMs = Math.max(0, (startAt + beats * beatDur - run.ctx.currentTime) * 1000);
  run.schedule(() => {
    countdownEl.textContent = 'Tap!';
  }, tapDelayMs);
  const clearDelayMs = Math.max(0, (startAt + (beats + 1) * beatDur - run.ctx.currentTime) * 1000);
  run.schedule(() => {
    countdownEl.textContent = '';
  }, clearDelayMs);
}

async function runCalibrationFlow(run, statusEl, detailEl, countdownEl, tapArea, onDone) {
  const beatDur = 60 / CAL_BPM;
  for (let attempt = 1; attempt <= CAL_MAX_ATTEMPTS; attempt++) {
    if (run.cancelled) return;
    const ctx = run.ctx;
    statusEl.textContent = attempt === 1 ? 'Get ready...' : `Let's try again (attempt ${attempt}/${CAL_MAX_ATTEMPTS})...`;
    detailEl.textContent = '';
    countdownEl.textContent = '';

    // Count-in: 4 lower-pitched clicks + a big on-screen 4-3-2-1 countdown,
    // THEN the 12 recorded (higher-pitched) clicks - no visual pulse during
    // those, and the status just says to tap along with the sound (on
    // Bluetooth, a synced visual would lead the audio and bias the tap).
    const startAt = ctx.currentTime + LEAD_IN;
    for (let i = 0; i < COUNT_IN_BEATS; i++) {
      scheduleClick(ctx, run.dest, startAt + i * beatDur, { freq: 900, gain: 0.45 });
    }
    scheduleCountdown(run, countdownEl, startAt, COUNT_IN_BEATS, beatDur);

    const firstClickTime = startAt + COUNT_IN_BEATS * beatDur;
    const clickTimes = [];
    for (let i = 0; i < CAL_TAPS; i++) {
      const t = firstClickTime + i * beatDur;
      clickTimes.push(t);
      scheduleClick(ctx, run.dest, t, { freq: 1500, gain: 0.5 });
    }
    run.schedule(() => {
      statusEl.textContent = 'Tap along with the sound.';
    }, Math.max(0, (firstClickTime - ctx.currentTime) * 1000));

    const timeoutMs = ((COUNT_IN_BEATS + CAL_TAPS) * beatDur + 2.5) * 1000;
    const tapTimes = await waitForTaps(run, tapArea, CAL_TAPS, timeoutMs, firstClickTime, beatDur, (n, total) => {
      detailEl.textContent = `${n} / ${total}`;
    });
    if (run.cancelled) return;

    const { offsetsMs, rejectedCount } = pairTapsToClicks(tapTimes, clickTimes, beatDur);
    const result = computeCalibration(offsetsMs);
    if (!result.ok) {
      statusEl.textContent = "That didn't look right - let's try again.";
      detailEl.textContent = result.reason;
      await sleep(1600);
      if (run.cancelled) return;
      continue;
    }

    // Not saved yet - only once the whole flow (including verify) finishes
    // without being cancelled, so a Back press during verify leaves
    // whatever was stored before untouched.
    statusEl.textContent = `Measured offset: ${result.offsetMs >= 0 ? '+' : ''}${result.offsetMs.toFixed(0)}ms`;
    detailEl.textContent = `Spread: ±${result.spreadMs.toFixed(0)}ms over ${result.keptCount} taps` + (rejectedCount ? ` (${rejectedCount} tap(s) not near any click)` : '');
    await sleep(1400);
    if (run.cancelled) return;

    await runCalibrationVerify(run, statusEl, detailEl, countdownEl, tapArea, result.offsetMs, beatDur);
    if (run.cancelled) return;

    storage.setCalibrationOffsetMs(result.offsetMs, result.spreadMs);
    statusEl.textContent = 'Calibrated!';
    detailEl.textContent = result.offsetMs > 150 ? "Bluetooth audio adds some delay - we've compensated." : '';
    await sleep(900);
    if (run.cancelled) return;
    onDone();
    return;
  }

  if (run.cancelled) return;
  // Repeated failures: don't loop forever - fall back to a neutral offset
  // rather than leaving the player stuck on this screen.
  storage.setCalibrationOffsetMs(0, null);
  statusEl.textContent = "Still having trouble - using no offset for now. You can Recalibrate anytime from the menu.";
  detailEl.textContent = '';
  await sleep(2000);
  if (run.cancelled) return;
  onDone();
}

/** A short verify pass AFTER measuring (but before saving) the offset:
 * a 2-click count-in, then prints each tap's residual (how far off it
 * lands once the just-measured offset is applied) so a bad calibration is
 * visible immediately rather than discovered mid-song. Informational only
 * - doesn't gate proceeding. */
async function runCalibrationVerify(run, statusEl, detailEl, countdownEl, tapArea, offsetMs, beatDur) {
  const ctx = run.ctx;
  statusEl.textContent = 'Quick check - keep tapping with the clicks...';
  detailEl.textContent = '';
  countdownEl.textContent = '';

  const startAt = ctx.currentTime + LEAD_IN;
  for (let i = 0; i < VERIFY_COUNT_IN_BEATS; i++) {
    scheduleClick(ctx, run.dest, startAt + i * beatDur, { freq: 900, gain: 0.4 });
  }
  scheduleCountdown(run, countdownEl, startAt, VERIFY_COUNT_IN_BEATS, beatDur);

  const firstClickTime = startAt + VERIFY_COUNT_IN_BEATS * beatDur;
  const clickTimes = [];
  for (let i = 0; i < VERIFY_TAPS; i++) {
    const t = firstClickTime + i * beatDur;
    clickTimes.push(t);
    scheduleClick(ctx, run.dest, t, { freq: 1700, gain: 0.45 });
  }
  const timeoutMs = ((VERIFY_COUNT_IN_BEATS + VERIFY_TAPS) * beatDur + 2) * 1000;
  const tapTimes = await waitForTaps(run, tapArea, VERIFY_TAPS, timeoutMs, firstClickTime, beatDur, null);
  if (run.cancelled) return;

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
    // The INNER track, not the outer clipping strip - see css/game.css
    // .practice-timeline__track: markers/playhead are positioned relative
    // to this (inset from the strip's edges by the largest marker's own
    // radius) so a marker at 0%/100% sits fully inside instead of being
    // half-clipped by the strip's own overflow:hidden.
    timelineEl: document.getElementById('practice-timeline-track'),
    playheadEl: document.getElementById('practice-playhead'),
    legendFakeEl: document.getElementById('practice-legend-fake'),
    hearBtn: document.getElementById('btn-practice-hear'),
    continueBtn: document.getElementById('btn-practice-continue'),
    skipBtn: document.getElementById('btn-practice-skip'),
  };
}

// Every practiceListen()/practiceAttemptRound() audio+rAF session
// CURRENTLY in flight - each adds its own stop callback right after it
// creates its nodes, and removes itself on natural completion. A Set (not
// a single pointer) because a "Hear it again" replay clicked during the
// FIRST Listen can leave more than one session alive at once - a single
// pointer would just get overwritten, and Skip could never reach the
// earlier one. Skip calls every stop in here; "Hear it again" is disabled
// for the duration of a scored round (see practiceAttemptRound) so it can
// only ever overlap with another Listen, never with judging itself.
const activePracticeStops = new Set();
function stopAllPracticeAudio() {
  for (const stop of Array.from(activePracticeStops)) stop();
  activePracticeStops.clear();
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
  els.hearBtn.onclick = () => {
    stopAllPracticeAudio();
    practiceListen(runCtx, section, els);
  };

  let skipped = false;
  const finishSkip = () => {
    skipped = true;
    stopAllPracticeAudio();
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

// Practice's own count-in (separate from calibration's - different tempo,
// different screen) - 4 beats, shown as "4 3 2 1 <label>" on els.phaseEl,
// same treatment for BOTH Listen and Your turn (previously only Your turn
// had a count-in at all, and it showed a static "Get ready..." rather than
// a synced countdown).
const PRACTICE_COUNT_IN_BEATS = 4;

/** Positions one pre-created marker per note/cue along the timeline strip
 * (static once built - only the playhead animates per frame). Cue markers
 * are hollow (the "listen" half of call-and-response) and show the cue's
 * own glyph; tap markers stay filled (the "tap" half); a FAKE note (don't
 * tap) never renders as a filled tap dot - it gets its own "X" marker, and
 * toggles the legend's "don't tap" span on for this section only if one is
 * actually present. Every marker's DOM element is stashed directly on the
 * note object (`n._markerEl`) so practiceAttemptRound's onJudged can
 * recolour the right one in O(1) - evt.note there is the SAME object, per
 * js/input.js's "mutated in place". */
function buildPracticeTimeline(timelineEl, notes, cues, sectionStart, sectionDur, legendFakeEl) {
  timelineEl.querySelectorAll('.practice-timeline__note, .practice-timeline__cue').forEach((el) => el.remove());
  const pctOf = (t) => (sectionDur > 0 ? Math.min(100, Math.max(0, ((t - sectionStart) / sectionDur) * 100)) : 0);
  for (const c of cues) {
    const el = document.createElement('div');
    el.className = 'practice-timeline__cue';
    el.style.left = `${pctOf(c.time).toFixed(2)}%`;
    el.textContent = c.glyph;
    timelineEl.appendChild(el);
  }
  let hasFake = false;
  for (const n of notes) {
    const el = document.createElement('div');
    el.className = 'practice-timeline__note' + (n.kind === 'hold' ? ' practice-timeline__note--hold' : '') + (n.fake ? ' practice-timeline__note--fake' : '');
    el.style.left = `${pctOf(n.time).toFixed(2)}%`;
    if (n.fake) {
      el.textContent = '✕';
      hasFake = true;
    }
    timelineEl.appendChild(el);
    n._markerEl = el;
  }
  if (legendFakeEl) legendFakeEl.hidden = !hasFake;
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

/** The section's own CUES (the "listen" half - chirps, bonks, whooshes...),
 * shifted the same way practiceSectionNotes shifts its notes, each carrying
 * the glyph its game's cueTypes registers for it (see stage.js's
 * resolveCueType for the equivalent lookup on the real Play screen -
 * practice never covers remix, so a direct game.cueTypes lookup is enough
 * here without needing a srcGame-aware callback). */
function practiceSectionCues(chart, game, section, playStart) {
  return chart.cues
    .filter((c) => c.time >= section.startTime && c.time < section.endTime)
    .map((c) => {
      const info = (game.cueTypes || []).find((ct) => ct.id === c.cueId);
      return { time: c.time - section.startTime + playStart, glyph: info?.glyph || '♪' };
    });
}

/** Schedules the "4 3 2 1 <label>" phase-text countdown in sync with the
 * count-in clicks, via setTimeout keyed off ctx time (mirrors
 * scheduleCountdown() in the calibration flow above). Returns the timer
 * ids so the caller's own stopThis() can clear any not-yet-fired digit -
 * without that, a "Hear it again" replay clicked during a still-running
 * count-in would show a mix of the old and new sequence's digits. */
function practiceScheduleCountIn(ctx, phaseEl, countInStart, beatDur, label) {
  phaseEl.textContent = '';
  const timers = [];
  for (let i = 0; i < PRACTICE_COUNT_IN_BEATS; i++) {
    const delayMs = Math.max(0, (countInStart + i * beatDur - ctx.currentTime) * 1000);
    timers.push(
      setTimeout(() => {
        phaseEl.textContent = String(PRACTICE_COUNT_IN_BEATS - i);
      }, delayMs)
    );
  }
  const labelDelayMs = Math.max(0, (countInStart + PRACTICE_COUNT_IN_BEATS * beatDur - ctx.currentTime) * 1000);
  timers.push(
    setTimeout(() => {
      phaseEl.textContent = label;
    }, labelDelayMs)
  );
  return timers;
}

/** Listen phase: a count-in, then the demo plays through - INCLUDING the
 * response sound, mirroring Play's own hold sound exactly (js/main.js
 * startPlay's onJudged/holdPress handling): a plain tap gets pack.tapGood
 * at its own time; a hold gets a LOOPED pack.holdSustain started at press
 * and stopped at releaseTime (scheduled via the AudioBufferSourceNode's own
 * start/stop, not setTimeout - sample-accurate regardless of how far ahead
 * it's scheduled), then pack.holdRelease at releaseTime - never a tapGood
 * blip at a hold's press, which Play never plays either. Falls back to
 * tapGood at the press if a pack has no holdSustain. All of this sounds
 * like a correctly-played round (D16: the player normally makes this sound
 * themselves, so a silent demo wouldn't sound like a "correct run" at all).
 * No input, nothing scored. EVERY sound this phase schedules - count-in,
 * song slice, guide ticks, response sfx - is routed through one dedicated
 * GainNode (`bus`, disconnected in stopThis) rather than straight to
 * ctx.destination, so Skip (or an overlapping "Hear it again") can silence
 * all of it at once, not just the tracked hold-sustain loops - the same
 * pattern as calibration's per-run GainNode (js/main.js
 * createCalibrationRun). Adds its own stop to the shared
 * `activePracticeStops` set (see above) rather than a single pointer, since
 * a replay clicked during an earlier still-playing Listen can leave more
 * than one of these alive at once. */
function practiceListen(runCtx, section, els) {
  // Stop any OTHER practice session still playing first (a replay clicked
  // during a still-running Listen, or during the "Still getting the hang
  // of it" prompt) - otherwise its audio (including a hold's looped
  // sustain node) keeps mixing into this one, and its own rAF loop fights
  // this one for the playhead.
  stopAllPracticeAudio();
  return new Promise((resolve) => {
    const ctx = getContext();
    const { game, chart, songBuffer, guidePack, sfxPacks } = runCtx;
    if (!section) {
      resolve();
      return;
    }
    els.feedbackEl.textContent = '';
    els.feedbackEl.className = 'practice-feedback';
    els.playheadEl.style.left = '0%';

    const bus = ctx.createGain();
    bus.connect(ctx.destination);

    const calibrationOffsetSec = storage.getCalibrationOffsetMs() / 1000;
    const beatDur = chart.beatDuration;
    const countInStart = ctx.currentTime + 0.2;
    const countInTimers = practiceScheduleCountIn(ctx, els.phaseEl, countInStart, beatDur, 'Listen...');
    for (let b = 0; b < PRACTICE_COUNT_IN_BEATS; b++) {
      scheduleClick(ctx, bus, countInStart + b * beatDur, { freq: 1000, gain: 0.4 });
    }
    const playStart = countInStart + PRACTICE_COUNT_IN_BEATS * beatDur;

    const sectionDur = section.endTime - section.startTime;
    const notes = practiceSectionNotes(chart, section, playStart);
    const cues = practiceSectionCues(chart, game, section, playStart);
    buildPracticeTimeline(els.timelineEl, notes, cues, playStart, sectionDur, els.legendFakeEl);

    const src = ctx.createBufferSource();
    src.buffer = songBuffer;
    src.connect(bus);
    const safeDur = Math.min(sectionDur, songBuffer.duration - section.startTime);
    src.start(playStart, section.startTime, Math.max(0.1, safeDur));

    if (guidePack) {
      for (const n of notes) {
        if (n.fake) continue; // never telegraph a fake - see D66/stage.js setGuideTargets
        scheduleBuffer(ctx, guidePack.tick, bus, n.time, { gain: 0.4 });
        if (n.kind === 'hold' && n.releaseTime != null) scheduleBuffer(ctx, guidePack.release, bus, n.releaseTime, { gain: 0.35 });
      }
    }
    const pack = sfxPacks.get(game.id);
    const sustainNodes = [];
    if (pack) {
      for (const n of notes) {
        if (n.fake) continue;
        if (n.kind === 'hold' && n.releaseTime != null) {
          if (pack.holdSustain) {
            const node = scheduleBuffer(ctx, pack.holdSustain, bus, n.time, { loop: true, gain: 0.7 });
            if (node) {
              try {
                node.stop(n.releaseTime);
              } catch {
                /* already stopped */
              }
              sustainNodes.push(node);
            }
          } else if (pack.tapGood) {
            scheduleBuffer(ctx, pack.tapGood, bus, n.time, { gain: 0.7 }); // fallback: pack has no holdSustain
          }
          if (pack.holdRelease) scheduleBuffer(ctx, pack.holdRelease, bus, n.releaseTime, { gain: 0.65 });
        } else if (pack.tapGood) {
          scheduleBuffer(ctx, pack.tapGood, bus, n.time, { gain: 0.7 });
        }
      }
    }

    // +Math.max(0, calibrationOffsetSec): on a laggy device the offset
    // playhead (visualNow = now - offset) doesn't reach 100% until
    // sectionDur+offset real seconds have passed - without this the demo
    // cuts off (and the playhead visibly freezes short of the end) before
    // that on any offset bigger than the old fixed 0.3s pad.
    const endAt = playStart + sectionDur + 0.3 + Math.max(0, calibrationOffsetSec);
    let rafId;
    function frame() {
      const now = ctx.currentTime;
      const visualNow = now - calibrationOffsetSec;
      const rel = visualNow < playStart ? 0 : sectionDur > 0 ? Math.max(0, Math.min(1, (visualNow - playStart) / sectionDur)) : 0;
      els.playheadEl.style.left = `${(rel * 100).toFixed(2)}%`;
      if (now < endAt) rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    let done = false;
    const stopThis = () => {
      if (done) return;
      done = true;
      activePracticeStops.delete(stopThis);
      for (const id of countInTimers) clearTimeout(id);
      cancelAnimationFrame(rafId);
      for (const node of sustainNodes) {
        try {
          node.stop();
        } catch {
          /* already stopped */
        }
      }
      sustainNodes.length = 0;
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        bus.disconnect();
      } catch {
        /* already disconnected */
      }
    };
    activePracticeStops.add(stopThis);

    setTimeout(
      () => {
        stopThis();
        resolve();
      },
      (endAt - ctx.currentTime) * 1000
    );
  });
}

/** "Your turn": a count-in, then a scored (practice-only) attempt against
 * the section's own notes, with per-tap direction+ms feedback, per-dot
 * hit/miss colouring, and a timeline playhead (both offset by the stored
 * calibration the same way the real Play screen's guides are - see
 * js/render/stage.js tick()). Resolves 'pass' or 'fail' (>=70% good+ =
 * pass, same bar the real game clears at). "Hear it again" is disabled for
 * the round's whole duration (restored in stopThis regardless of how the
 * round ends): a replay stopping THIS round's own rAF/input via the shared
 * activePracticeStops set would silently zero out tally.total, which
 * "passed = tally.total > 0 ? ... : true" would then count as an automatic
 * pass. All sfx this round schedules (count-in, guide ticks, live response
 * hits) route through one GainNode (`bus`) the same way practiceListen's
 * does, so Skip mid-round silences everything at once. */
function practiceAttemptRound(runCtx, section, els) {
  // Stop any leftover Listen replay first - see practiceListen's own
  // comment above. "Hear it again" is disabled for the rest of THIS
  // function's own duration (below), but a replay started just before this
  // round began (e.g. during the initial Listen) could otherwise still be
  // playing when the round's own count-in starts.
  stopAllPracticeAudio();
  return new Promise((resolve) => {
    const ctx = getContext();
    const { game, chart, songBuffer, guidePack, sfxPacks } = runCtx;
    if (!section) {
      resolve('pass');
      return;
    }
    els.feedbackEl.textContent = '';
    els.feedbackEl.className = 'practice-feedback';
    els.playheadEl.style.left = '0%';
    els.hearBtn.disabled = true;

    const bus = ctx.createGain();
    bus.connect(ctx.destination);

    const calibrationOffsetSec = storage.getCalibrationOffsetMs() / 1000;
    const beatDur = chart.beatDuration;
    const countInStart = ctx.currentTime + 0.2;
    const countInTimers = practiceScheduleCountIn(ctx, els.phaseEl, countInStart, beatDur, 'Your turn!');
    for (let b = 0; b < PRACTICE_COUNT_IN_BEATS; b++) {
      scheduleClick(ctx, bus, countInStart + b * beatDur, { freq: 1600, gain: 0.5 });
    }
    const playStart = countInStart + PRACTICE_COUNT_IN_BEATS * beatDur;

    const sectionDur = section.endTime - section.startTime;
    const notes = practiceSectionNotes(chart, section, playStart);
    const cues = practiceSectionCues(chart, game, section, playStart);
    buildPracticeTimeline(els.timelineEl, notes, cues, playStart, sectionDur, els.legendFakeEl);

    const src = ctx.createBufferSource();
    src.buffer = songBuffer;
    src.connect(bus);
    const safeDur = Math.min(sectionDur, songBuffer.duration - section.startTime);
    src.start(playStart, section.startTime, Math.max(0.1, safeDur));

    if (guidePack) {
      for (const n of notes) {
        if (n.fake) continue; // never telegraph a fake - see D66/stage.js setGuideTargets
        scheduleBuffer(ctx, guidePack.tick, bus, n.time, { gain: 0.55 });
        if (n.kind === 'hold' && n.releaseTime != null) scheduleBuffer(ctx, guidePack.release, bus, n.releaseTime, { gain: 0.5 });
      }
    }

    const tally = { good: 0, total: 0 };
    const pack = sfxPacks.get(game.id);
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

        // Sound + per-dot colour mirror Play's own rule exactly (js/main.js
        // startPlay's onJudged): hitting sounds good, missing is silent,
        // and an AUTO-resolved event (e.g. a correctly-avoided fake once
        // its window passes with no tap) plays no response sound either -
        // no active tap happened, so nothing should sound like one did.
        if (evt.source !== 'auto' && evt.judgement !== 'miss' && pack) {
          const buf = evt.phase === 'holdRelease' ? pack.holdRelease : pack.tapGood;
          if (buf) playBuffer(ctx, buf, bus, { gain: 0.8 });
        }
        if (evt.note?._markerEl) {
          evt.note._markerEl.classList.toggle('practice-timeline__note--hit', good);
          evt.note._markerEl.classList.toggle('practice-timeline__note--miss', !good);
        }

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

    // +Math.max(0, calibrationOffsetSec): judge.update()'s own auto-miss
    // sweep now resolves each note at heard-time note.time+offset+
    // MISS_WINDOW (see js/input.js) - without extending endAt to match, a
    // note near the section's end on a laggy device could still be
    // unresolved when detach()/cancelAnimationFrame() fire, dropping it out
    // of tally.total entirely and inflating the pass ratio.
    const endAt = playStart + sectionDur + 0.5 + Math.max(0, calibrationOffsetSec);
    let rafId;
    function frame() {
      const now = ctx.currentTime;
      judge.update(now);
      const visualNow = now - calibrationOffsetSec;
      const rel = visualNow < playStart ? 0 : sectionDur > 0 ? Math.max(0, Math.min(1, (visualNow - playStart) / sectionDur)) : 0;
      els.playheadEl.style.left = `${(rel * 100).toFixed(2)}%`;
      if (now < endAt) rafId = requestAnimationFrame(frame);
    }
    rafId = requestAnimationFrame(frame);

    let done = false;
    const stopThis = () => {
      if (done) return;
      done = true;
      activePracticeStops.delete(stopThis);
      for (const id of countInTimers) clearTimeout(id);
      detach();
      cancelAnimationFrame(rafId);
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        bus.disconnect();
      } catch {
        /* already disconnected */
      }
      els.hearBtn.disabled = false;
    };
    activePracticeStops.add(stopThis);

    setTimeout(
      () => {
        stopThis();
        const passed = tally.total > 0 ? tally.good / tally.total >= PRACTICE_PASS_RATIO : true;
        resolve(passed ? 'pass' : 'fail');
      },
      (endAt - ctx.currentTime) * 1000
    );
  });
}

// --- play ------------------------------------------------------------------
function startPlay(runCtx) {
  // A practice Listen/round can still be mid-flight when this is reached
  // (Skip; or "Continue anyway" after a "Hear it again" replay was left
  // running) - stop it so its audio doesn't keep playing into Play. No-op
  // for the AUTOPLAY/remix path (maybeStartPractice skips practice
  // entirely there), which never adds anything to this set.
  stopAllPracticeAudio();
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
    // M1.7: the song-end check now waits for visualNow (nowCtx -
    // calibrationOffsetSec) to reach absoluteEndTime, not raw nowCtx - so
    // on a laggy device there's a window of up to the stored offset AFTER
    // the song audio has already finished playing where sessionEnded is
    // still false. A blur/visibilitychange landing in that window would
    // otherwise pause a song that's already over and then resumeNow() would
    // schedule a pointless count-in and restart `src` past the end of the
    // buffer. The frame loop's own visualNow-aware check will call
    // finishPlay() within that same window regardless, so just don't pause.
    if (ctx.currentTime >= absChart.absoluteEndTime) return;
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

  // M1.7: takes visualNow (nowCtx - calibrationOffsetSec), NOT the raw
  // clock - the same "heard" time judge.update()'s auto-miss sweep and
  // stage.tick()'s visuals use (see js/input.js update(), js/render/
  // stage.js tick()). On a laggy device (e.g. +250ms) this delays the panel
  // advance to match: without it, a phrase's last note could still be
  // waiting on its (now correctly later) auto-miss deadline when the panel
  // had already flipped to the next one and force-completed it as "good"
  // regardless of whether the player ever got a chance to tap it.
  function advancePhraseIfNeeded(visualNow) {
    let target = currentPhraseIndex;
    while (target + 1 < absChart.phrases.length && visualNow >= absChart.phrases[target + 1].startTime) {
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
    // Same "heard" transform as judge.update()'s auto-miss sweep and
    // stage.tick()'s visuals (js/input.js, js/render/stage.js) - keeps
    // phrase-advance and song-end consistent with when a note's own
    // auto-miss deadline actually resolves on a laggy device.
    const visualNow = nowCtx - calibrationOffsetSec;
    advancePhraseIfNeeded(visualNow);
    autoplayTick(nowCtx); // inject synthetic taps before the auto-miss sweep - deliberately on the RAW schedule, see judgeTap(note.time + calibrationOffsetSec, ...) above
    judge.update(nowCtx); // applies calibrationOffsetSec internally (js/input.js) - keep passing the raw clock
    stage.tick(nowCtx, absChart, getGame, resolveCueType, calibrationOffsetSec);

    // Wait for the offset too: ends only once the "heard" clock reaches
    // absoluteEndTime, so the final note's (now correctly later) auto-miss
    // deadline has actually had a chance to resolve before judge.update()
    // stops being called at all. absoluteEndTime already carries several
    // seconds of margin past the last note's own deadline (verified via a
    // direct buildChart sweep: minimum ~4.05s across every game/level
    // tested), which comfortably covers the worst case of MISS_WINDOW
    // (150ms) + MAX_OFFSET_MS (450ms) = 600ms added here.
    if (visualNow >= absChart.absoluteEndTime) {
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

  // Button handlers assigned FIRST, before any DOM text writes below: a
  // missing/renamed element in the text-filling code that follows must
  // never again leave these buttons unassigned (the exact M1.7 "end-screen
  // buttons do nothing" bug - #end-seed didn't exist, so the old code threw
  // here before ever reaching these three assignments, and every button on
  // the screen stayed null forever). See tests/dom_ids_test.mjs.
  document.getElementById('btn-play-again').onclick = () => {
    refreshMenu();
    startRun(resolveSeed(null));
  };
  document.getElementById('btn-replay-seed').onclick = () => startRun(seed);
  document.getElementById('btn-end-menu').onclick = () => {
    refreshMenu();
    showScreen('menu');
  };

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
}

// --- boot --------------------------------------------------------------
showScreen('menu');
