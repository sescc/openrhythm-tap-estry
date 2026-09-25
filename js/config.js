// js/config.js
// Supabase project config for accounts / cross-device progress (section C).
// Both values are PUBLIC by design - the key only ever grants what the RLS
// policies in supabase/schema.sql allow (every table is scoped to
// `auth.uid()`). See README.md "Setting up accounts (Supabase)" for exactly
// where to find these two values.
//
// Leave both empty (the default) to run guest-only, exactly like before
// this feature existed: js/net/auth.js and js/net/sync.js both check
// isConfigured() first and no-op (or return a friendly "not set up" result)
// rather than ever calling fetch() with an empty URL. js/net/accountUi.js
// shows "Accounts not set up" everywhere instead of the real sign-in UI.

export const SUPABASE_URL = 'https://porxqjiuhovccagdzwty.supabase.co/rest/v1/';
// The Publishable key (`sb_publishable_...`) from Project Settings > API
// Keys - a legacy `anon` JWT (`eyJ...`) also still works. NEVER the Secret
// key (`sb_secret_...`) or a legacy `service_role` JWT - isConfigured()
// below refuses to use either.
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_J6ssvFo5EIROKZGy2Eo0xA_PngYGsI3';

/** True if `key` looks like a Supabase SECRET (new-style `sb_secret_...`)
 * or legacy `service_role` JWT, rather than a publishable/anon key. Pure
 * and exported separately from isConfigured() so tests/auth_test.mjs can
 * check it against arbitrary strings without needing to change this
 * module's own (fixed, build-time) exports. */
export function looksSecretKey(key) {
  if (!key) return false;
  if (key.startsWith('sb_secret_')) return true;
  // A legacy Supabase key is a JWT (three base64url segments); decode the
  // payload (segment 2) and check its `role` claim. Anything that isn't a
  // decodable 3-segment JWT just isn't a recognised secret shape - not an
  // error, since the new-style publishable key isn't a JWT at all.
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
      if (payload && payload.role === 'service_role') return true;
    } catch {
      /* not decodable - not a recognised secret shape */
    }
  }
  return false;
}

/** A secret key must NEVER ship to the browser - if SUPABASE_PUBLISHABLE_KEY
 * looks like one (pasted in by mistake), this logs a clear console error
 * and reports "not configured" rather than using it, same as if the field
 * had been left empty. */
export function isConfigured() {
  if (!SUPABASE_URL || !SUPABASE_PUBLISHABLE_KEY) return false;
  if (looksSecretKey(SUPABASE_PUBLISHABLE_KEY)) {
    console.error(
      'js/config.js: SUPABASE_PUBLISHABLE_KEY looks like a SECRET (or legacy service_role) key, not a publishable/anon key - refusing to use it. ' +
        'A secret key must never ship to the browser. Copy the "Publishable key" from Project Settings > API Keys instead (see README.md "Setting up accounts (Supabase)").'
    );
    return false;
  }
  return true;
}

/** The Supabase dashboard's "Project URL" / "Connect" panel shows the API
 * URL WITH a `/rest/v1` (or, elsewhere in the dashboard, `/auth/v1`) suffix
 * already on it - pasting that as-is into SUPABASE_URL doubles up on every
 * request (`/rest/v1/rest/v1/...`, `/rest/v1/auth/v1/...`), which 404s.
 * normaliseSupabaseUrl() trims whitespace/trailing slashes and strips a
 * trailing `/rest/v1`, `/auth/v1` or `/storage/v1` (case-insensitive) so
 * either form of what someone pastes works. Pure/exported for
 * tests/auth_test.mjs. */
export function normaliseSupabaseUrl(url) {
  if (!url) return '';
  let out = url.trim();
  out = out.replace(/\/+$/, '');
  out = out.replace(/\/(rest|auth|storage)\/v1$/i, '');
  out = out.replace(/\/+$/, '');
  return out;
}

// The one URL every js/net/* request is actually built from - see
// normaliseSupabaseUrl() above for why this is not just SUPABASE_URL
// itself. Never edit SUPABASE_URL/SUPABASE_PUBLISHABLE_KEY above to "fix"
// this - they're the player's pasted-in values, verbatim; this line is what
// tolerates either form they might have pasted.
export const SUPABASE_BASE_URL = normaliseSupabaseUrl(SUPABASE_URL);
