// tests/merge_test.mjs
// Regression/behaviour test for js/net/merge.js: the progress-merge rule
// (level=max, cleared=union, practiced_cues=union, games_played=max),
// idempotence of merging, and the outbox enqueue/dedupe/flush bookkeeping -
// all pure functions, so this needs no localStorage/fetch/DOM (a stubbed
// "transport" - a plain boolean - stands in for a real network flush). Run
// directly with `node tests/merge_test.mjs`, or via `node tests/run.mjs`.

import { mergeProgress, progressSnapshotsEqual, dedupeOutbox, buildOutboxRow, enqueueOutbox, applyFlushResult } from '../js/net/merge.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

// --- mergeProgress: the exact rule from CLAUDE.md section C ---------------

{
  const local = { level: 3, cleared: ['echo', 'bounce'], practicedCues: ['echo:chirp'], gamesPlayed: 5 };
  const remote = { level: 5, cleared: ['pump', 'bounce'], practicedCues: ['pump:whistle'], gamesPlayed: 2 };
  const merged = mergeProgress(local, remote);
  assert(merged.level === 5, `level should take the higher value (max), got ${merged.level}`);
  assert(merged.gamesPlayed === 5, `gamesPlayed should take the higher value (max), got ${merged.gamesPlayed}`);
  assert(
    new Set(merged.cleared).size === 3 && ['echo', 'bounce', 'pump'].every((id) => merged.cleared.includes(id)),
    `cleared should be the union, got ${JSON.stringify(merged.cleared)}`
  );
  assert(
    new Set(merged.practicedCues).size === 2 && ['echo:chirp', 'pump:whistle'].every((id) => merged.practicedCues.includes(id)),
    `practicedCues should be the union, got ${JSON.stringify(merged.practicedCues)}`
  );
}

// --- no remote row yet (brand new account / first ever sync) --------------

{
  const local = { level: 4, cleared: ['echo'], practicedCues: ['echo:chirp'], gamesPlayed: 7 };
  const merged = mergeProgress(local, null);
  assert(progressSnapshotsEqual(merged, local), 'merging with a null remote should pass the local snapshot through unchanged');
  assert(merged !== local, 'merging with a null remote should still return a fresh object, not the same reference');
}

// --- no local snapshot either (defensive - shouldn't happen in practice) --

{
  const merged = mergeProgress(null, { level: 2, cleared: ['bounce'], practicedCues: [], gamesPlayed: 1 });
  assert(merged.level === 2 && merged.cleared.includes('bounce'), 'merging with a null local should fall back to a fresh base and still take the remote values');
}

// --- idempotence: merging a snapshot with an identical one is a no-op -----

{
  const snapshot = { level: 6, cleared: ['echo', 'pump', 'swing'], practicedCues: ['echo:chirp', 'pump:whistle'], gamesPlayed: 9 };
  const merged = mergeProgress(snapshot, snapshot);
  assert(progressSnapshotsEqual(merged, snapshot), 'merging a snapshot with itself should be a no-op (idempotent)');

  // Also idempotent across a SECOND merge with the same remote (simulates
  // "sync ran twice in a row with nothing new on either side").
  const mergedAgain = mergeProgress(merged, snapshot);
  assert(progressSnapshotsEqual(mergedAgain, snapshot), 'a second merge against the same remote should still equal the original');
}

// --- union dedupes overlapping ids, doesn't just concatenate --------------

{
  const local = { level: 1, cleared: ['echo', 'echo'], practicedCues: ['echo:chirp'], gamesPlayed: 0 };
  const remote = { level: 1, cleared: ['echo'], practicedCues: ['echo:chirp'], gamesPlayed: 0 };
  const merged = mergeProgress(local, remote);
  assert(merged.cleared.length === 1, `cleared union should dedupe, got ${JSON.stringify(merged.cleared)}`);
  assert(merged.practicedCues.length === 1, `practicedCues union should dedupe, got ${JSON.stringify(merged.practicedCues)}`);
}

// --- dedupeOutbox -----------------------------------------------------------

{
  const outbox = [{ client_id: 'a', v: 1 }, { client_id: 'b', v: 2 }, { client_id: 'a', v: 3 }];
  const deduped = dedupeOutbox(outbox);
  assert(deduped.length === 2, `dedupeOutbox should drop the repeated client_id, got ${deduped.length} rows`);
  assert(deduped[0].v === 1, 'dedupeOutbox should keep the FIRST occurrence, not the last');
}

// --- buildOutboxRow / enqueueOutbox: pure, non-mutating --------------------

{
  const play = { game_id: 'echo', level: 3, accuracy: 0.9 };
  const row = buildOutboxRow(play, 'client-123', 'This device');
  assert(row.client_id === 'client-123' && row.device_label === 'This device', 'buildOutboxRow should attach client_id/device_label');
  assert(row.game_id === 'echo' && row.accuracy === 0.9, 'buildOutboxRow should keep the original play fields');
  assert(play.client_id === undefined, 'buildOutboxRow must not mutate the input play object');

  const outbox1 = [];
  const outbox2 = enqueueOutbox(outbox1, row);
  assert(outbox1.length === 0, 'enqueueOutbox must not mutate the input array');
  assert(outbox2.length === 1 && outbox2[0].client_id === 'client-123', 'enqueueOutbox should append the row');

  // Enqueuing the SAME row object twice (e.g. a caller retrying after an
  // ambiguous result) must not double-queue it - same client_id, deduped.
  const outbox3 = enqueueOutbox(outbox2, row);
  assert(outbox3.length === 1, 'enqueueOutbox should dedupe a row with an already-queued client_id');
}

// --- applyFlushResult: all-or-nothing bookkeeping, stubbed transport ------
// "Transport" here is just a boolean the test controls directly, standing
// in for whatever js/net/sync.js's real pushPlays() would have returned -
// this is deliberately network-free.

{
  const outbox = [
    buildOutboxRow({ game_id: 'echo', level: 1 }, 'c1', 'Phone'),
    buildOutboxRow({ game_id: 'pump', level: 2 }, 'c2', 'Phone'),
  ];

  const stubbedTransportSuccess = true;
  const afterSuccess = applyFlushResult(outbox, stubbedTransportSuccess);
  assert(afterSuccess.length === 0, 'a successful flush should clear the whole outbox');

  const stubbedTransportFailure = false;
  const afterFailure = applyFlushResult(outbox, stubbedTransportFailure);
  assert(afterFailure === outbox, 'a failed flush should leave the outbox exactly as it was (queued for the next attempt)');
  assert(afterFailure.length === 2, 'a failed flush should not drop any queued rows');
}

// --- end-to-end outbox lifecycle using only the pure primitives -----------
// enqueue two plays -> simulate a failed flush (nothing lost) -> simulate a
// successful flush (outbox drains) -> enqueue a new play after that (starts
// clean, not still carrying the old ones).

{
  let outbox = [];
  outbox = enqueueOutbox(outbox, buildOutboxRow({ game_id: 'echo', level: 1 }, 'a', 'Phone'));
  outbox = enqueueOutbox(outbox, buildOutboxRow({ game_id: 'pump', level: 4 }, 'b', 'Phone'));
  assert(outbox.length === 2, 'two enqueues should leave two rows queued');

  outbox = applyFlushResult(outbox, false); // offline - flush failed
  assert(outbox.length === 2, 'a failed flush mid-lifecycle should not lose queued plays');

  outbox = applyFlushResult(outbox, true); // back online - flush succeeded
  assert(outbox.length === 0, 'a successful flush mid-lifecycle should drain the outbox');

  outbox = enqueueOutbox(outbox, buildOutboxRow({ game_id: 'swing', level: 2 }, 'c', 'Phone'));
  assert(outbox.length === 1 && outbox[0].client_id === 'c', 'enqueuing after a drain should start from empty, not carry old rows');
}

const ok = failures === 0;
console.log(ok ? 'PASS - all merge/outbox checks passed' : `FAIL - ${failures} check(s) failed`);
if (!ok) process.exitCode = 1;
