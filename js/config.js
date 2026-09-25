// js/config.js
// Supabase project config for accounts / cross-device progress (section C).
// Both values are PUBLIC by design - the anon key only ever grants what the
// RLS policies in supabase/schema.sql allow (every table is scoped to
// `auth.uid()`). See README.md "Setting up accounts (Supabase)" for how to
// get these two values.
//
// Leave both empty (the default) to run guest-only, exactly like before
// this feature existed: js/net/auth.js and js/net/sync.js both check
// isConfigured() first and no-op (or return a friendly "not set up" result)
// rather than ever calling fetch() with an empty URL. js/net/accountUi.js
// shows "Accounts not set up" everywhere instead of the real sign-in UI.

export const SUPABASE_URL = '';
export const SUPABASE_ANON_KEY = '';

export function isConfigured() {
  return Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);
}
