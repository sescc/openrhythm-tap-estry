// js/storage.js
// Thin wrapper around localStorage for calibration + settings. Wrapped in
// try/catch because localStorage can throw (private browsing, disabled
// storage, etc.) - the game should degrade gracefully (just re-calibrate
// every visit) rather than crash.

import { buildOutboxRow, enqueueOutbox } from './net/merge.js';

const KEY_CALIBRATION_MS = 'ord.calibrationOffsetMs';
const KEY_CALIBRATION_SPREAD_MS = 'ord.calibrationSpreadMs';
const KEY_CALIBRATED = 'ord.calibrated';
const KEY_LOWEND = 'ord.lowEnd';
const KEY_LAST_SEED = 'ord.lastSeed';
const KEY_LEVEL = 'ord.level';
const KEY_CLEARED = 'ord.cleared'; // JSON {gameId: true}
const KEY_GAMES_PLAYED = 'ord.gamesPlayed';
const KEY_PRACTICED_CUES = 'ord.practicedCues'; // JSON ["gameId:cueId", ...]
const KEY_GUIDES_PREF = 'ord.guidesPref'; // '1' | '0' | absent (absent = auto: on while uncleared)
const KEY_STORAGE_VERSION = 'ord.storageVersion';

// M1.6: the calibration bug (nearest-click pairing replacing count-based
// pairing - see js/calibration.js) means any offset stored by the OLD code
// is potentially a whole-beat-shifted garbage value that would keep a
// returning player's taps ignored forever even after the fix ships. Bumping
// the version wipes calibration AND (per the user's explicit choice)
// progress, so nobody keeps playing on top of a broken calibration without
// realizing recalibrating would fix it.
const STORAGE_VERSION = 2;

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // ignore - storage unavailable
  }
}

export function getCalibrationOffsetMs() {
  const v = safeGet(KEY_CALIBRATION_MS);
  return v === null ? 0 : parseFloat(v);
}

/** `spreadMs` (the MAD of the kept taps - see js/calibration.js) is stored
 * alongside the offset purely for display (menu/calibrate screen "offset
 * AND spread"); it's never subtracted from anything. */
export function setCalibrationOffsetMs(ms, spreadMs) {
  safeSet(KEY_CALIBRATION_MS, String(ms));
  if (spreadMs != null) safeSet(KEY_CALIBRATION_SPREAD_MS, String(spreadMs));
  safeSet(KEY_CALIBRATED, '1');
}

export function getCalibrationSpreadMs() {
  const v = safeGet(KEY_CALIBRATION_SPREAD_MS);
  return v === null ? null : parseFloat(v);
}

export function isCalibrated() {
  return safeGet(KEY_CALIBRATED) === '1';
}

export function getLowEndPref() {
  const v = safeGet(KEY_LOWEND);
  return v === '1';
}

export function setLowEndPref(on) {
  safeSet(KEY_LOWEND, on ? '1' : '0');
}

export function getLastSeed() {
  return safeGet(KEY_LAST_SEED);
}

export function setLastSeed(seed) {
  safeSet(KEY_LAST_SEED, String(seed));
}

// --- progression (M1.5) ---------------------------------------------------

export function getLevel() {
  const v = safeGet(KEY_LEVEL);
  return v === null ? 1 : Math.max(1, parseInt(v, 10) || 1);
}

export function setLevel(level) {
  safeSet(KEY_LEVEL, String(Math.max(1, Math.floor(level))));
}

function safeParseJson(str, fallback) {
  if (!str) return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

export function getCleared() {
  return safeParseJson(safeGet(KEY_CLEARED), {});
}

export function markCleared(gameId) {
  const cleared = getCleared();
  cleared[gameId] = true;
  safeSet(KEY_CLEARED, JSON.stringify(cleared));
}

export function getClearedIds() {
  return Object.keys(getCleared());
}

export function getGamesPlayed() {
  const v = safeGet(KEY_GAMES_PLAYED);
  return v === null ? 0 : Math.max(0, parseInt(v, 10) || 0);
}

export function incrementGamesPlayed() {
  const n = getGamesPlayed() + 1;
  safeSet(KEY_GAMES_PLAYED, String(n));
  return n;
}

export function getPracticedCues() {
  return new Set(safeParseJson(safeGet(KEY_PRACTICED_CUES), []));
}

export function markCuePracticed(gameId, cueId) {
  const set = getPracticedCues();
  set.add(`${gameId}:${cueId}`);
  safeSet(KEY_PRACTICED_CUES, JSON.stringify(Array.from(set)));
}

export function isCuePracticed(gameId, cueId) {
  return getPracticedCues().has(`${gameId}:${cueId}`);
}

// --- guides (M1.6) ---------------------------------------------------------
// null = no explicit player override ("auto": guides on while a game is
// uncleared, off once cleared - see js/main.js guidesEnabledFor()).

export function getGuidesPref() {
  const v = safeGet(KEY_GUIDES_PREF);
  if (v === '1') return true;
  if (v === '0') return false;
  return null;
}

export function setGuidesPref(on) {
  safeSet(KEY_GUIDES_PREF, on ? '1' : '0');
}

export function clearGuidesPref() {
  try {
    localStorage.removeItem(KEY_GUIDES_PREF);
  } catch {
    /* storage unavailable */
  }
}

// --- storage migration (M1.6) ----------------------------------------------
/**
 * Call once at boot. Wipes calibration + progression when the stored
 * version is older than STORAGE_VERSION (see its own comment above for why:
 * the M1.5 calibration bug could have stored a garbage offset, and the user
 * explicitly chose a full progress reset alongside the fix). Idempotent -
 * safe to call every page load.
 */
export function migrateIfNeeded() {
  const stored = safeGet(KEY_STORAGE_VERSION);
  const storedVersion = stored === null ? 0 : parseInt(stored, 10) || 0;
  if (storedVersion >= STORAGE_VERSION) return false;

  for (const key of [
    KEY_CALIBRATION_MS,
    KEY_CALIBRATION_SPREAD_MS,
    KEY_CALIBRATED,
    KEY_LEVEL,
    KEY_CLEARED,
    KEY_GAMES_PLAYED,
    KEY_PRACTICED_CUES,
  ]) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* storage unavailable */
    }
  }
  safeSet(KEY_STORAGE_VERSION, String(STORAGE_VERSION));
  return true; // caller can use this to show a one-time "we reset your progress" note
}

// --- accounts / sync (section C) --------------------------------------
// Session, outbox, device id/label, and the progress <-> snapshot bridge
// used by js/net/merge.js + js/net/sync.js. Calibration is deliberately
// NEVER part of any of this - it's per-device, not per-player (see
// js/calibration.js's own header for why latency varies device-to-device).

const KEY_SESSION = 'ord.session'; // JSON {accessToken, refreshToken, expiresAtMs, userId, email}
const KEY_OUTBOX = 'ord.outbox'; // JSON array of queued `plays` rows, one per finished game
const KEY_DEVICE_ID = 'ord.deviceId';
const KEY_DEVICE_LABEL = 'ord.deviceLabel';

export function getSession() {
  return safeParseJson(safeGet(KEY_SESSION), null);
}

export function setSession(session) {
  safeSet(KEY_SESSION, JSON.stringify(session));
}

export function clearSession() {
  try {
    localStorage.removeItem(KEY_SESSION);
  } catch {
    /* storage unavailable */
  }
}

/** RFC4122-ish v4 uuid. Prefers the real crypto.randomUUID() (every
 * evergreen browser + Node 19+); the fallback is only for an environment
 * without it and doesn't need to be cryptographically strong - it's a
 * dedupe key (plays.client_id) and a device label, not a secret. */
function randomUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** A random id generated once per device/browser profile and cached - NOT
 * tied to any account, so it stays stable across sign-in/out and is what
 * lets "My progress" show which device a play came from. */
export function getDeviceId() {
  let id = safeGet(KEY_DEVICE_ID);
  if (!id) {
    id = randomUuid();
    safeSet(KEY_DEVICE_ID, id);
  }
  return id;
}

export function getDeviceLabel() {
  const stored = safeGet(KEY_DEVICE_LABEL);
  if (stored) return stored;
  try {
    return /mobi/i.test(navigator.userAgent || '') ? 'Phone' : 'This device';
  } catch {
    return 'This device';
  }
}

export function setDeviceLabel(label) {
  safeSet(KEY_DEVICE_LABEL, String(label).slice(0, 40));
}

// --- progress snapshot (js/net/merge.js's input/output shape) --------------

export function getProgressSnapshot() {
  return {
    level: getLevel(),
    cleared: getClearedIds(),
    practicedCues: Array.from(getPracticedCues()),
    gamesPlayed: getGamesPlayed(),
  };
}

/** Writes a merged snapshot back into the existing per-field storage keys
 * (KEY_LEVEL/KEY_CLEARED/KEY_PRACTICED_CUES/KEY_GAMES_PLAYED) so every
 * other existing reader (getLevel/getCleared/isCuePracticed/...) keeps
 * working unchanged after a sync. */
export function applyProgressSnapshot(snapshot) {
  if (!snapshot) return;
  setLevel(snapshot.level || 1);
  const clearedObj = {};
  for (const id of snapshot.cleared || []) clearedObj[id] = true;
  safeSet(KEY_CLEARED, JSON.stringify(clearedObj));
  safeSet(KEY_PRACTICED_CUES, JSON.stringify(Array.from(new Set(snapshot.practicedCues || []))));
  safeSet(KEY_GAMES_PLAYED, String(Math.max(0, snapshot.gamesPlayed || 0)));
}

// --- outbox (queued `plays` rows, flushed while online) ---------------------

export function getOutbox() {
  return safeParseJson(safeGet(KEY_OUTBOX), []);
}

export function setOutbox(rows) {
  safeSet(KEY_OUTBOX, JSON.stringify(rows));
}

export function clearOutbox() {
  safeSet(KEY_OUTBOX, '[]');
}

/** Appends one finished play to the outbox, tagged with a fresh
 * client-generated uuid (`client_id`) - the dedupe key the server relies on
 * (supabase/schema.sql's unique(user_id, client_id) + js/net/sync.js
 * pushPlays' `Prefer: resolution=ignore-duplicates`), so a retried flush
 * can never insert the same play twice. The actual row-shape/dedupe logic
 * is js/net/merge.js's buildOutboxRow/enqueueOutbox (pure, Node-tested) -
 * this is just id generation (the one bit of impurity, crypto.randomUUID())
 * plus the localStorage read/write. Returns the row actually queued. */
export function enqueuePlay(play) {
  const row = buildOutboxRow(play, randomUuid(), getDeviceLabel());
  setOutbox(enqueueOutbox(getOutbox(), row));
  return row;
}
