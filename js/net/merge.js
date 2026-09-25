// js/net/merge.js
// Pure progress-merge + outbox-dedupe logic - no DOM/fetch/localStorage.
// Mirrors js/calibration.js's split of pure decision math from the network/
// DOM glue (js/net/sync.js, js/net/accountUi.js), so it's directly
// Node-testable via a plain import (see tests/merge_test.mjs).

/**
 * Merge rule, exactly as decided in CLAUDE.md section C:
 *   level = max, cleared = union, practiced_cues = union, games_played = max.
 * `local` and `remote` are both shaped like js/storage.js's
 * getProgressSnapshot(): { level, cleared: string[], practicedCues: string[],
 * gamesPlayed }. `remote` may be null (no cloud row yet - a brand new
 * account, or the very first sync) - the local snapshot then just passes
 * through unchanged (still a fresh copy, not the same reference). Called on
 * every sign-in AND on every pull (js/net/sync.js syncNow()), so it must be
 * idempotent: merging a snapshot with an identical one is a no-op.
 */
export function mergeProgress(local, remote) {
  const base = local || { level: 1, cleared: [], practicedCues: [], gamesPlayed: 0 };
  if (!remote) {
    return {
      level: base.level || 1,
      cleared: unique(base.cleared || []),
      practicedCues: unique(base.practicedCues || []),
      gamesPlayed: base.gamesPlayed || 0,
    };
  }
  return {
    level: Math.max(base.level || 1, remote.level || 1),
    cleared: unique([...(base.cleared || []), ...(remote.cleared || [])]),
    practicedCues: unique([...(base.practicedCues || []), ...(remote.practicedCues || [])]),
    gamesPlayed: Math.max(base.gamesPlayed || 0, remote.gamesPlayed || 0),
  };
}

function unique(arr) {
  return Array.from(new Set(arr));
}

/** Order-insensitive equality of two progress snapshots (cleared/
 * practicedCues compared as sets) - used by tests/merge_test.mjs to check
 * mergeProgress's idempotence without caring about array order. */
export function progressSnapshotsEqual(a, b) {
  if (!a || !b) return a === b;
  return a.level === b.level && a.gamesPlayed === b.gamesPlayed && sameSet(a.cleared, b.cleared) && sameSet(a.practicedCues, b.practicedCues);
}

function sameSet(a, b) {
  const sa = new Set(a || []);
  const sb = new Set(b || []);
  if (sa.size !== sb.size) return false;
  for (const v of sa) if (!sb.has(v)) return false;
  return true;
}

/**
 * Removes outbox rows that share a `client_id` with an earlier row (keeps
 * the first occurrence, preserves order otherwise). A client-side
 * belt-and-braces companion to the server-side dedupe (supabase/schema.sql's
 * unique(user_id, client_id) + js/net/sync.js pushPlays' `Prefer:
 * resolution=ignore-duplicates`) - so even a local bug that enqueues the
 * same finished play twice only ever sends it once.
 */
export function dedupeOutbox(outbox) {
  const seen = new Set();
  const out = [];
  for (const row of outbox || []) {
    if (!row || seen.has(row.client_id)) continue;
    seen.add(row.client_id);
    out.push(row);
  }
  return out;
}

// --- outbox enqueue/flush bookkeeping (pure) --------------------------
// js/storage.js owns the actual localStorage I/O and the one bit of
// impurity these need (a fresh client_id - crypto.randomUUID()); everything
// about WHAT to store where is decided here so it's directly testable.

/** Builds one outbox row from a finished play plus an externally-supplied
 * client id and device label - never mutates `play`. Id GENERATION is kept
 * out of this file on purpose (js/storage.js is the only place
 * crypto.randomUUID() is called) so this stays pure and deterministic
 * for tests. */
export function buildOutboxRow(play, clientId, deviceLabel) {
  return { ...play, client_id: clientId, device_label: deviceLabel };
}

/** Appends `row` to `outbox` and returns a NEW array (never mutates the
 * input), then dedupes by client_id - safe to call more than once with the
 * same row (e.g. a caller that retries after an error it can't tell
 * succeeded or not). */
export function enqueueOutbox(outbox, row) {
  return dedupeOutbox([...(outbox || []), row]);
}

/**
 * What's left in the outbox after one flush attempt. A flush is a single
 * atomic batch insert (js/net/sync.js pushPlays) - PostgREST either accepts
 * the whole batch or the request fails outright; there is no per-row
 * partial success in this design, so the bookkeeping is simply "clear on
 * success, keep everything on failure" (a failed flush is retried in full
 * on the next menu visit - see js/net/accountUi.js onMenuShown()). Pulled
 * out as its own pure function (rather than inlined in js/net/sync.js) so
 * this all-or-nothing CONTRACT is itself something tests/merge_test.mjs can
 * pin down directly, with a stubbed transport standing in for the real
 * fetch/localStorage.
 */
export function applyFlushResult(outbox, flushSucceeded) {
  return flushSucceeded ? [] : outbox;
}
