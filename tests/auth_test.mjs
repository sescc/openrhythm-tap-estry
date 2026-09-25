// tests/auth_test.mjs
// Regression/behaviour test for js/net/auth.js's PURE parts: the exact
// shape of every auth request it builds (URL/method/headers/body), the
// token-refresh timing decision, and the error-message mapping. No
// network/DOM - js/net/auth.js is deliberately structured so these are
// exported as plain functions separate from the actual fetch calls (see
// its own header comment, mirroring js/calibration.js's split of pure math
// from DOM/audio glue). Also covers js/net/sync.js's one pure request
// builder (buildPlaysInsertRequest) for the same reason - see the
// on_conflict regression case below. Run directly with
// `node tests/auth_test.mjs`, or via `node tests/run.mjs`.

import {
  authHeaders,
  buildOtpRequest,
  buildVerifyRequest,
  buildSignupRequest,
  buildPasswordSignInRequest,
  buildRefreshRequest,
  buildSetPasswordRequest,
  buildLogoutRequest,
  needsRefresh,
  REFRESH_MARGIN_MS,
  mapAuthError,
} from '../js/net/auth.js';
import { buildPlaysInsertRequest } from '../js/net/sync.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from '../js/config.js';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

// --- request builders: URL, method, headers, body --------------------------
// js/config.js ships with empty SUPABASE_URL/SUPABASE_ANON_KEY by default
// (guest-only until a real project is configured - see README "Setting up
// accounts") - these checks only rely on the builders using whatever
// js/config.js currently exports, not on a real project being configured.

{
  const req = buildOtpRequest('player@example.com');
  assert(req.url === `${SUPABASE_URL}/auth/v1/otp`, `buildOtpRequest: wrong url ${req.url}`);
  assert(req.method === 'POST', 'buildOtpRequest: should POST');
  assert(req.headers.apikey === SUPABASE_ANON_KEY, 'buildOtpRequest: apikey header should be the anon key');
  assert(req.headers['Content-Type'] === 'application/json', 'buildOtpRequest: should send JSON');
  const body = JSON.parse(req.body);
  assert(body.email === 'player@example.com' && body.create_user === true, `buildOtpRequest: wrong body ${req.body}`);
}

{
  const req = buildVerifyRequest('player@example.com', '123456');
  assert(req.url === `${SUPABASE_URL}/auth/v1/verify`, `buildVerifyRequest: wrong url ${req.url}`);
  assert(req.method === 'POST', 'buildVerifyRequest: should POST');
  const body = JSON.parse(req.body);
  assert(body.type === 'email' && body.email === 'player@example.com' && body.token === '123456', `buildVerifyRequest: wrong body ${req.body}`);
}

{
  const req = buildSignupRequest('player@example.com', 'hunter22');
  assert(req.url === `${SUPABASE_URL}/auth/v1/signup`, `buildSignupRequest: wrong url ${req.url}`);
  const body = JSON.parse(req.body);
  assert(body.email === 'player@example.com' && body.password === 'hunter22', `buildSignupRequest: wrong body ${req.body}`);
}

{
  const req = buildPasswordSignInRequest('player@example.com', 'hunter22');
  assert(req.url === `${SUPABASE_URL}/auth/v1/token?grant_type=password`, `buildPasswordSignInRequest: wrong url ${req.url}`);
  const body = JSON.parse(req.body);
  assert(body.email === 'player@example.com' && body.password === 'hunter22', `buildPasswordSignInRequest: wrong body ${req.body}`);
}

{
  const req = buildRefreshRequest('refresh-token-abc');
  assert(req.url === `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, `buildRefreshRequest: wrong url ${req.url}`);
  const body = JSON.parse(req.body);
  assert(body.refresh_token === 'refresh-token-abc', `buildRefreshRequest: wrong body ${req.body}`);
}

{
  const req = buildSetPasswordRequest('access-token-xyz', 'newpassword1');
  assert(req.url === `${SUPABASE_URL}/auth/v1/user`, `buildSetPasswordRequest: wrong url ${req.url}`);
  assert(req.method === 'PUT', 'buildSetPasswordRequest: should PUT');
  assert(req.headers.Authorization === 'Bearer access-token-xyz', `buildSetPasswordRequest: wrong Authorization header ${req.headers.Authorization}`);
  assert(req.headers.apikey === SUPABASE_ANON_KEY, 'buildSetPasswordRequest: apikey header should still be the anon key');
  const body = JSON.parse(req.body);
  assert(body.password === 'newpassword1', `buildSetPasswordRequest: wrong body ${req.body}`);
}

{
  const req = buildLogoutRequest('access-token-xyz');
  assert(req.url === `${SUPABASE_URL}/auth/v1/logout`, `buildLogoutRequest: wrong url ${req.url}`);
  assert(req.method === 'POST', 'buildLogoutRequest: should POST');
  assert(req.headers.Authorization === 'Bearer access-token-xyz', 'buildLogoutRequest: wrong Authorization header');
}

// --- buildPlaysInsertRequest: the on_conflict regression --------------------
// Bug (coordinator review): pushPlays POSTed with `Prefer: resolution=
// ignore-duplicates` but no `on_conflict` param. Without it, PostgREST's
// upsert falls back to the PRIMARY KEY (`id`, never sent by a queued row) as
// the conflict target, so a RETRIED row that collides with the real
// (user_id, client_id) unique constraint gets a 409 instead of being
// silently skipped - res.ok is false, and applyFlushResult (js/net/
// merge.js) then keeps the WHOLE batch queued forever, failing identically
// on every future flush. The fix names the real conflict target explicitly.

{
  const rows = [{ user_id: 'u1', client_id: 'c1', game_id: 'echo', level: 1, accuracy: 0.9 }];
  const req = buildPlaysInsertRequest(rows);
  assert(req.path.startsWith('/rest/v1/plays'), `buildPlaysInsertRequest: wrong path base ${req.path}`);
  assert(req.path.includes('on_conflict=user_id,client_id'), `buildPlaysInsertRequest: missing on_conflict, got ${req.path}`);
  assert(req.method === 'POST', 'buildPlaysInsertRequest: should POST');
  assert(req.headers.Prefer === 'resolution=ignore-duplicates,return=minimal', `buildPlaysInsertRequest: wrong Prefer header ${req.headers.Prefer}`);
  assert(req.headers['Content-Type'] === 'application/json', 'buildPlaysInsertRequest: should send JSON');
  const body = JSON.parse(req.body);
  assert(Array.isArray(body) && body.length === 1 && body[0].client_id === 'c1', `buildPlaysInsertRequest: wrong body ${req.body}`);
}

// --- authHeaders: signed-in vs signed-out (anon key fallback) -------------

{
  const signedIn = authHeaders('real-access-token');
  assert(signedIn.apikey === SUPABASE_ANON_KEY, 'authHeaders: apikey should always be the anon key');
  assert(signedIn.Authorization === 'Bearer real-access-token', 'authHeaders: should use the access token when signed in');

  const signedOut = authHeaders(null);
  assert(signedOut.Authorization === `Bearer ${SUPABASE_ANON_KEY}`, 'authHeaders: should fall back to the anon key as the bearer token when signed out');

  const undefinedToken = authHeaders(undefined);
  assert(undefinedToken.Authorization === `Bearer ${SUPABASE_ANON_KEY}`, 'authHeaders: undefined token should also fall back to the anon key');
}

// --- needsRefresh: the "within 60s of expiry" decision --------------------

{
  const now = 1_000_000;
  assert(needsRefresh(null, now) === false, 'needsRefresh: no session at all should not ask for a refresh (that is a signed-out question)');
  assert(needsRefresh({ expiresAtMs: now + REFRESH_MARGIN_MS + 5000 }, now) === false, 'needsRefresh: comfortably not-yet-expiring should be false');
  assert(needsRefresh({ expiresAtMs: now + REFRESH_MARGIN_MS - 1 }, now) === true, 'needsRefresh: just inside the margin should be true');
  assert(needsRefresh({ expiresAtMs: now + REFRESH_MARGIN_MS }, now) === true, 'needsRefresh: exactly at the margin should be true (<=)');
  assert(needsRefresh({ expiresAtMs: now - 500 }, now) === true, 'needsRefresh: already-expired should be true');
}

// --- mapAuthError: friendly messages, never the raw Supabase shape --------

{
  assert(/offline/i.test(mapAuthError(null, null)), 'mapAuthError: status=null (network error) should mention being offline');
  assert(/wait/i.test(mapAuthError(429, null)), 'mapAuthError: 429 should mention waiting/rate limiting');
  assert(/code/i.test(mapAuthError(400, { error_code: 'otp_expired' })), 'mapAuthError: 400 otp_expired should mention the code being wrong/expired');
  assert(/code/i.test(mapAuthError(400, { msg: 'Token has expired or is invalid' })), 'mapAuthError: a 400 whose message mentions the token should still map to a code-specific message');
  const wrongPw = mapAuthError(400, { error_description: 'Invalid login credentials' });
  assert(typeof wrongPw === 'string' && wrongPw.length > 0 && !/error_description/i.test(wrongPw), 'mapAuthError: 400 invalid credentials should surface a plain message, not the raw field name');
  assert(mapAuthError(500, null).length > 0, 'mapAuthError: an unrecognised status should still return SOME message, never throw/undefined');
}

const ok = failures === 0;
console.log(ok ? 'PASS - all auth request/refresh/error-mapping checks passed' : `FAIL - ${failures} check(s) failed`);
if (!ok) process.exitCode = 1;
