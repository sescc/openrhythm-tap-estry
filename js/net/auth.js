// js/net/auth.js
// Supabase Auth over plain `fetch` - no SDK, no CDN (D5). Default sign-in is
// a passwordless 6-digit email code; "Use a password instead" is the
// alternate path. See CLAUDE.md section C for the corrected flow and
// supabase/schema.sql / README.md "Setting up accounts" for the project
// side of this.
//
// Request-BUILDING is kept pure and exported separately from the actual
// fetch calls - mirrors js/calibration.js's split of pure math from the
// DOM/audio glue in js/main.js - so tests/auth_test.mjs can check the exact
// URL/method/headers/body of every request, the refresh-timing decision,
// and the error-message mapping, all with zero network dependency.

import { SUPABASE_URL, SUPABASE_ANON_KEY, isConfigured } from '../config.js';
import * as storage from '../storage.js';

const JSON_HEADERS = { 'Content-Type': 'application/json' };

/** Every auth/REST call sends `apikey: <anon key>` always, plus
 * `Authorization: Bearer <token>` - the current access token when signed
 * in, the anon key itself when not (this is the corrected behaviour from
 * the plan's headline: both auth endpoints and REST endpoints follow this
 * same rule). Exported/pure so tests can check the header shape directly. */
export function authHeaders(accessToken) {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
  };
}

// --- pure request builders (URL/method/headers/body only - no fetch) ------

export function buildOtpRequest(email) {
  return {
    url: `${SUPABASE_URL}/auth/v1/otp`,
    method: 'POST',
    headers: { ...JSON_HEADERS, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, create_user: true }),
  };
}

export function buildVerifyRequest(email, token) {
  return {
    url: `${SUPABASE_URL}/auth/v1/verify`,
    method: 'POST',
    headers: { ...JSON_HEADERS, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ type: 'email', email, token }),
  };
}

export function buildSignupRequest(email, password) {
  return {
    url: `${SUPABASE_URL}/auth/v1/signup`,
    method: 'POST',
    headers: { ...JSON_HEADERS, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  };
}

export function buildPasswordSignInRequest(email, password) {
  return {
    url: `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    method: 'POST',
    headers: { ...JSON_HEADERS, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ email, password }),
  };
}

export function buildRefreshRequest(refreshToken) {
  return {
    url: `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
    method: 'POST',
    headers: { ...JSON_HEADERS, apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify({ refresh_token: refreshToken }),
  };
}

export function buildSetPasswordRequest(accessToken, password) {
  return {
    url: `${SUPABASE_URL}/auth/v1/user`,
    method: 'PUT',
    headers: { ...JSON_HEADERS, ...authHeaders(accessToken) },
    body: JSON.stringify({ password }),
  };
}

export function buildLogoutRequest(accessToken) {
  return {
    url: `${SUPABASE_URL}/auth/v1/logout`,
    method: 'POST',
    headers: authHeaders(accessToken),
    body: undefined,
  };
}

// --- pure refresh-decision + error-mapping ---------------------------------

export const REFRESH_MARGIN_MS = 60000; // "within 60s of expiry" (plan)

/** True once `session.expiresAtMs` is within REFRESH_MARGIN_MS of `nowMs`
 * (or already past it). False for a missing session - nothing to refresh,
 * that's a "signed out" question, not a refresh-timing one. */
export function needsRefresh(session, nowMs) {
  if (!session || !session.expiresAtMs) return false;
  return session.expiresAtMs - nowMs <= REFRESH_MARGIN_MS;
}

/** Maps a failed response (status/bodyJson from a parsed Supabase error, or
 * status=null for a request that never got a response at all - offline/DNS/
 * CORS) to a short, player-facing message. Never surfaces the raw Supabase
 * error shape. Pure - exported for tests/auth_test.mjs. */
export function mapAuthError(status, bodyJson) {
  if (status == null) return "You're offline - check your connection and try again.";
  if (status === 429) return 'Too many attempts - please wait a minute and try again.';
  const code = bodyJson?.error_code || bodyJson?.error;
  const text = `${bodyJson?.msg || bodyJson?.error_description || ''}`;
  if (status === 400 && (code === 'otp_expired' || code === 'invalid_token' || /otp|token|code/i.test(text))) {
    return 'That code is wrong or has expired - double check it, or resend a new one.';
  }
  if (status === 400 || status === 401 || status === 403) {
    return bodyJson?.error_description || bodyJson?.msg || 'Wrong email or password - please try again.';
  }
  if (status === 422) {
    return bodyJson?.error_description || bodyJson?.msg || "That didn't work - please check your details.";
  }
  return bodyJson?.error_description || bodyJson?.msg || 'Something went wrong - please try again.';
}

// --- session shape + storage -------------------------------------------
// { accessToken, refreshToken, expiresAtMs, userId, email }. Persisted via
// js/storage.js (getSession/setSession/clearSession) - all localStorage
// access stays centralised there, per the existing project convention.

function sessionFromAuthResponse(json, fallbackEmail) {
  if (!json || !json.access_token) return null;
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    expiresAtMs: Date.now() + (json.expires_in || 3600) * 1000,
    userId: json.user?.id,
    email: json.user?.email || fallbackEmail,
  };
}

async function doFetch({ url, method, headers, body }) {
  let res;
  try {
    res = await fetch(url, { method, headers, body });
  } catch {
    return { ok: false, status: null, json: null }; // network error - never reached the server
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null; // e.g. logout's 204 No Content
  }
  return { ok: res.ok, status: res.status, json };
}

export function getSession() {
  return storage.getSession();
}

export function isSignedIn() {
  return Boolean(storage.getSession());
}

export async function requestOtp(email) {
  if (!isConfigured()) return { ok: false, message: 'Accounts not set up.' };
  const { ok, status, json } = await doFetch(buildOtpRequest(email));
  if (!ok) return { ok: false, message: mapAuthError(status, json) };
  return { ok: true };
}

export async function verifyOtp(email, token) {
  if (!isConfigured()) return { ok: false, message: 'Accounts not set up.' };
  const { ok, status, json } = await doFetch(buildVerifyRequest(email, token));
  if (!ok) return { ok: false, message: mapAuthError(status, json) };
  const session = sessionFromAuthResponse(json, email);
  if (!session) return { ok: false, message: 'Something went wrong - please try again.' };
  storage.setSession(session);
  return { ok: true, session };
}

export async function signUpPassword(email, password) {
  if (!isConfigured()) return { ok: false, message: 'Accounts not set up.' };
  const { ok, status, json } = await doFetch(buildSignupRequest(email, password));
  if (!ok) return { ok: false, message: mapAuthError(status, json) };
  const session = sessionFromAuthResponse(json, email);
  if (session) storage.setSession(session);
  // If email confirmation is on (off by default per the setup steps), the
  // signup succeeds but returns no session yet - the caller shows a "check
  // your email" message rather than treating this as a hard failure.
  return { ok: true, session, needsConfirmation: !session };
}

export async function signInPassword(email, password) {
  if (!isConfigured()) return { ok: false, message: 'Accounts not set up.' };
  const { ok, status, json } = await doFetch(buildPasswordSignInRequest(email, password));
  if (!ok) return { ok: false, message: mapAuthError(status, json) };
  const session = sessionFromAuthResponse(json, email);
  if (!session) return { ok: false, message: 'Something went wrong - please try again.' };
  storage.setSession(session);
  return { ok: true, session };
}

async function doRefresh(session) {
  const { ok, json } = await doFetch(buildRefreshRequest(session.refreshToken));
  if (!ok) return null;
  const fresh = sessionFromAuthResponse(json, session.email);
  if (fresh) storage.setSession(fresh);
  return fresh;
}

/** Returns a session guaranteed usable right now: refreshes first if it's
 * within REFRESH_MARGIN_MS of expiry (or already expired). Returns null if
 * signed out, or if a needed refresh fails outright - the caller then
 * treats that as signed-out (js/net/sync.js, js/net/accountUi.js), clearing
 * the stale session rather than retrying forever. */
export async function ensureFreshSession() {
  const session = storage.getSession();
  if (!session) return null;
  if (!needsRefresh(session, Date.now())) return session;
  const fresh = await doRefresh(session);
  if (!fresh) {
    storage.clearSession();
    return null;
  }
  return fresh;
}

export async function setPassword(password) {
  if (!isConfigured()) return { ok: false, message: 'Accounts not set up.' };
  const session = await ensureFreshSession();
  if (!session) return { ok: false, message: 'Please sign in again.' };
  const { ok, status, json } = await doFetch(buildSetPasswordRequest(session.accessToken, password));
  if (!ok) return { ok: false, message: mapAuthError(status, json) };
  return { ok: true };
}

/** Signs out. Only clears the session - never touches progression/
 * calibration storage, per the plan ("Sign out clears the session but
 * keeps local progress"). Best-effort server-side logout: if it fails
 * (offline, already-expired token), the local session is still gone. */
export async function signOut() {
  const session = storage.getSession();
  storage.clearSession();
  if (!session || !isConfigured()) return { ok: true };
  try {
    await doFetch(buildLogoutRequest(session.accessToken));
  } catch {
    /* best-effort - already cleared locally either way */
  }
  return { ok: true };
}

/** One retry-on-401 wrapper for REST calls (js/net/sync.js uses this for
 * every progress/plays request). ensureFreshSession() covers the common
 * case proactively (refresh before it's needed); the 401-then-retry-once
 * here covers a token that expired precisely mid-request or was revoked
 * server-side - "refresh...on a 401, retry once" per the plan. */
export async function authorizedFetch(path, opts = {}) {
  if (!isConfigured()) throw new Error('Supabase not configured');
  const session = await ensureFreshSession();
  const url = `${SUPABASE_URL}${path}`;
  const headers1 = { ...(opts.headers || {}), ...authHeaders(session?.accessToken) };
  let res = await fetch(url, { ...opts, headers: headers1 });
  if (res.status === 401 && session) {
    const fresh = await doRefresh(session);
    if (fresh) {
      const headers2 = { ...(opts.headers || {}), ...authHeaders(fresh.accessToken) };
      res = await fetch(url, { ...opts, headers: headers2 });
    }
  }
  return res;
}
