// js/net/sync.js
// Pull/merge/push `progress`, insert `plays`, and read/write `profiles`, via
// Supabase's PostgREST endpoints (plain fetch - no SDK, D5). This module is
// the only thing in the app that ever makes those calls, and it's only ever
// invoked from js/net/accountUi.js, itself only ever invoked from the menu/
// end/account/progress screens (never during play - D11; sw.js already
// ignores cross-origin requests, so none of this is ever cached).
//
// Pure merge/outbox logic lives in js/net/merge.js so it's directly
// Node-testable without a fetch mock; this file is the (untested-by-Node,
// reviewed-by-hand) glue that actually talks to the network.

import { isConfigured } from '../config.js';
import { authorizedFetch, ensureFreshSession } from './auth.js';
import * as storage from '../storage.js';
import { mergeProgress, applyFlushResult } from './merge.js';

const PROGRESS_PATH = '/rest/v1/progress';
const PLAYS_PATH = '/rest/v1/plays';
const PROFILES_PATH = '/rest/v1/profiles';

async function safeJson(res) {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

export async function pullProgress(userId) {
  const res = await authorizedFetch(`${PROGRESS_PATH}?user_id=eq.${userId}&select=*`, { method: 'GET' });
  if (!res.ok) return null;
  const rows = await safeJson(res);
  if (!Array.isArray(rows) || !rows[0]) return null;
  const row = rows[0];
  // DB column names -> js/storage.js's getProgressSnapshot() shape.
  return {
    level: row.level,
    cleared: row.cleared || [],
    practicedCues: row.practiced_cues || [],
    gamesPlayed: row.games_played,
  };
}

/** Upserts the one `progress` row for this user. `Prefer: resolution=
 * merge-duplicates` is correct here because `progress` is meant to be
 * mutated in place (its RLS policy allows update) - contrast with
 * pushPlays below, which deliberately uses a DIFFERENT Prefer value because
 * `plays` does not allow update. */
export async function pushProgress(userId, snapshot) {
  const row = {
    user_id: userId,
    level: snapshot.level,
    cleared: snapshot.cleared,
    practiced_cues: snapshot.practicedCues,
    games_played: snapshot.gamesPlayed,
    updated_at: new Date().toISOString(),
  };
  const res = await authorizedFetch(PROGRESS_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify([row]),
  });
  return res.ok;
}

export async function pullProfile(userId) {
  const res = await authorizedFetch(`${PROFILES_PATH}?id=eq.${userId}&select=*`, { method: 'GET' });
  if (!res.ok) return null;
  const rows = await safeJson(res);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

export async function pushDisplayName(userId, displayName) {
  const res = await authorizedFetch(`${PROFILES_PATH}?id=eq.${userId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
    body: JSON.stringify({ display_name: displayName }),
  });
  return res.ok;
}

export async function pullPlays(userId, limit = 50) {
  const res = await authorizedFetch(`${PLAYS_PATH}?user_id=eq.${userId}&select=*&order=played_at.desc&limit=${limit}`, { method: 'GET' });
  if (!res.ok) return [];
  const rows = await safeJson(res);
  return Array.isArray(rows) ? rows : [];
}

/** Pure request builder for the `plays` batch insert - URL (incl.
 * `on_conflict`), method, headers and body only, no fetch. Exported so
 * tests/auth_test.mjs can assert the exact shape with zero network
 * dependency (mirrors js/net/auth.js's own build*Request functions).
 *
 * `on_conflict=user_id,client_id` is REQUIRED alongside `Prefer:
 * resolution=ignore-duplicates`: without it, PostgREST's upsert falls back
 * to the table's PRIMARY KEY (`id`) as the conflict target - since a queued
 * row never carries an `id`, a RETRY that collides with the
 * `(user_id, client_id)` unique constraint instead raises a 409 (no
 * matching PK to no-op against), which fails the whole batch and leaves it
 * stuck in the outbox forever on every future flush. Naming the real
 * conflict target fixes that. `plays.client_id` is unique per user
 * (supabase/schema.sql's `plays_user_client_unique` constraint); dedupe
 * guard is server-side via `ignore-duplicates`/DO NOTHING - see the
 * `pushPlays` comment below for why NOT `merge-duplicates`. */
export function buildPlaysInsertRequest(rows) {
  return {
    path: `${PLAYS_PATH}?on_conflict=user_id,client_id`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  };
}

/** Inserts a batch of queued `plays` rows in one request. The dedupe guard
 * is server-side: `plays.client_id` is unique per user (supabase/
 * schema.sql), and `Prefer: resolution=ignore-duplicates` (with the
 * matching `on_conflict` - see buildPlaysInsertRequest above) skips any row
 * that already exists instead of erroring - a retried flush (e.g. the
 * response to a previous flush never arrived) can never insert twice.
 * `ignore-duplicates` is used INSTEAD OF `merge-duplicates` deliberately:
 * `plays` has no UPDATE policy (append-only, insert+select only per RLS),
 * so a merge-duplicates upsert's implicit UPDATE-on-conflict would be
 * blocked by RLS on every retry; DO NOTHING never attempts a write on
 * conflict, so it's the one that actually works under that policy. */
export async function pushPlays(userId, rows) {
  if (rows.length === 0) return true;
  const body = rows.map(({ client_id, device_label, game_id, level, seed, accuracy, perfect, good, miss, avoided, median_timing_ms, played_at }) => ({
    user_id: userId,
    client_id,
    device_label,
    game_id,
    level,
    seed,
    accuracy,
    perfect,
    good,
    miss,
    avoided,
    median_timing_ms,
    played_at,
  }));
  const req = buildPlaysInsertRequest(body);
  const res = await authorizedFetch(req.path, { method: req.method, headers: req.headers, body: req.body });
  return res.ok;
}

/** Sends every queued play in one batch insert; only drops the outbox once
 * the request genuinely succeeds (a network failure leaves it queued for
 * the next menu visit - see js/net/accountUi.js onMenuShown()). The
 * all-or-nothing bookkeeping itself is js/net/merge.js's applyFlushResult
 * (pure, Node-tested) - this is just the fetch call and the localStorage
 * write. */
export async function flushOutbox(userId) {
  const outbox = storage.getOutbox();
  if (outbox.length === 0) return true;
  const ok = await pushPlays(userId, outbox);
  storage.setOutbox(applyFlushResult(outbox, ok));
  return ok;
}

/** Full sync: pull remote progress, merge with local (mergeProgress - see
 * js/net/merge.js for the exact rule), apply the merged snapshot locally,
 * push it back, then flush the outbox. Called on sign-in and on every menu
 * visit while signed in (js/main.js's showScreen('menu') hook, via
 * accountUi.onMenuShown()). No-op when unconfigured, offline, or signed
 * out - guest play is completely unaffected either way (D11/local-first). */
export async function syncNow() {
  if (!isConfigured()) return { ok: false, reason: 'unconfigured' };
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, reason: 'offline' };
  const session = await ensureFreshSession();
  if (!session) return { ok: false, reason: 'signed-out' };

  try {
    const remote = await pullProgress(session.userId);
    const local = storage.getProgressSnapshot();
    const merged = mergeProgress(local, remote);
    storage.applyProgressSnapshot(merged);
    await pushProgress(session.userId, merged);
    await flushOutbox(session.userId);
    return { ok: true, merged };
  } catch {
    return { ok: false, reason: 'network' };
  }
}
