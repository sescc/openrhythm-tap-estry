// js/net/accountUi.js
// Wires the account chip (menu), #screen-account (sign in / create account)
// and #screen-progress (recent plays, best accuracy, set password, sign
// out) to js/net/auth.js + js/net/sync.js + js/storage.js. This is the only
// file that touches those new DOM ids - js/main.js only ever calls the
// three small hooks below (init/onMenuShown/recordPlay), per the plan's
// file-ownership split with the gameplay agent.
//
// Local-first, always: with js/config.js unconfigured (empty URL/key,
// isConfigured() false) the chip and both new screens show "Accounts not
// set up" and every handler here early-returns before ever calling
// js/net/auth.js or js/net/sync.js (both of which would themselves refuse
// with the same message anyway - belt and braces) - guest play is
// completely unaffected (D11).

import { isConfigured } from '../config.js';
import * as auth from './auth.js';
import * as sync from './sync.js';
import * as storage from '../storage.js';
import { getGame, GAMES } from '../games/index.js';

const RESEND_COOLDOWN_S = 60;

let showScreenFn = null; // injected by init() - avoids a circular import with js/main.js
let els = null;
let mode = 'code'; // 'code' | 'password' - which half of #screen-account is showing
let pendingEmail = ''; // the email the current code was sent to (Verify/Resend need it)
let resendTimer = null;
let resendRemaining = 0;

function q(id) {
  return document.getElementById(id);
}

function cacheEls() {
  els = {
    chip: q('account-chip'),
    chipName: q('btn-account-chip-name'),
    chipSignout: q('btn-account-chip-signout'),

    accountStatus: q('account-status'),
    accountError: q('account-error'),
    stepEmail: q('account-step-email'),
    email: q('account-email'),
    btnSendCode: q('btn-account-send-code'),
    btnUsePassword: q('btn-account-use-password'),

    stepCode: q('account-step-code'),
    code: q('account-code'),
    btnVerify: q('btn-account-verify'),
    btnResend: q('btn-account-resend'),
    btnCodeBack: q('btn-account-code-back'),

    stepPassword: q('account-step-password'),
    pwEmail: q('account-pw-email'),
    password: q('account-password'),
    btnSignInPassword: q('btn-account-signin-password'),
    btnSignUpPassword: q('btn-account-signup-password'),
    btnUseCode: q('btn-account-use-code'),

    stepName: q('account-step-name'),
    displayName: q('account-display-name'),
    btnNameSave: q('btn-account-name-save'),
    btnNameSkip: q('btn-account-name-skip'),

    btnAccountBack: q('btn-account-back'),

    progressStatus: q('progress-status'),
    progressSummary: q('progress-summary'),
    progressBest: q('progress-best'),
    progressPlays: q('progress-plays'),
    progressPassword: q('progress-password'),
    btnSetPassword: q('btn-progress-set-password'),
    progressPasswordStatus: q('progress-password-status'),
    btnProgressSignout: q('btn-progress-signout'),
    btnProgressBack: q('btn-progress-back'),
  };
}

// --- small helpers -----------------------------------------------------

function isOffline() {
  try {
    return navigator.onLine === false;
  } catch {
    return false;
  }
}

function showError(msg) {
  els.accountError.textContent = msg;
  els.accountError.hidden = !msg;
}

function gameLabel(gameId) {
  const g = getGame(gameId);
  return g ? `${g.mascot?.emoji || ''} ${g.name}`.trim() : gameId;
}

function resetAccountScreen() {
  showError('');
  els.accountStatus.textContent = 'Sign in to keep your progress across devices.';
  els.email.value = '';
  els.code.value = '';
  els.password.value = '';
  els.pwEmail.value = '';
  els.displayName.value = '';
  setStep('email');
  stopResendCooldown();
}

/** Exactly one of the four step blocks is visible at a time. */
function setStep(step) {
  els.stepEmail.hidden = step !== 'email';
  els.stepCode.hidden = step !== 'code';
  els.stepPassword.hidden = step !== 'password';
  els.stepName.hidden = step !== 'name';
}

function stopResendCooldown() {
  if (resendTimer) clearInterval(resendTimer);
  resendTimer = null;
  resendRemaining = 0;
  els.btnResend.disabled = false;
  els.btnResend.textContent = 'Resend code';
}

function startResendCooldown() {
  resendRemaining = RESEND_COOLDOWN_S;
  els.btnResend.disabled = true;
  els.btnResend.textContent = `Resend code (${resendRemaining}s)`;
  resendTimer = setInterval(() => {
    resendRemaining--;
    if (resendRemaining <= 0) {
      stopResendCooldown();
      return;
    }
    els.btnResend.textContent = `Resend code (${resendRemaining}s)`;
  }, 1000);
}

// --- chip ----------------------------------------------------------------

async function refreshChip() {
  const session = storage.getSession();
  if (!session) {
    els.chipName.textContent = 'Guest · Sign in';
    els.chipSignout.hidden = true;
    return;
  }
  let label = session.email || 'Signed in';
  if (isConfigured()) {
    try {
      const profile = await sync.pullProfile(session.userId);
      if (profile?.display_name) label = profile.display_name;
    } catch {
      /* offline/error - fall back to the email we already have */
    }
  }
  els.chipName.textContent = `${label} · My progress`;
  els.chipSignout.hidden = false;
}

// --- account screen: code flow ------------------------------------------

async function handleSendCode() {
  if (!isConfigured()) return;
  const email = els.email.value.trim();
  showError('');
  if (!email) {
    showError('Enter your email first.');
    return;
  }
  if (isOffline()) {
    showError("You're offline - check your connection and try again.");
    return;
  }
  els.btnSendCode.disabled = true;
  els.accountStatus.textContent = 'Sending a code...';
  const result = await auth.requestOtp(email);
  els.btnSendCode.disabled = false;
  if (!result.ok) {
    showError(result.message);
    els.accountStatus.textContent = 'Sign in to keep your progress across devices.';
    return;
  }
  pendingEmail = email;
  els.accountStatus.textContent = `We sent a 6-digit code to ${email}.`;
  setStep('code');
  els.code.value = '';
  els.code.focus();
  startResendCooldown();
}

async function handleResend() {
  if (!isConfigured() || els.btnResend.disabled) return;
  showError('');
  if (isOffline()) {
    showError("You're offline - check your connection and try again.");
    return;
  }
  const result = await auth.requestOtp(pendingEmail);
  if (!result.ok) {
    showError(result.message);
    return;
  }
  els.accountStatus.textContent = `We sent a new code to ${pendingEmail}.`;
  startResendCooldown();
}

async function handleVerify() {
  if (!isConfigured()) return;
  const token = els.code.value.trim();
  showError('');
  if (!/^\d{6}$/.test(token)) {
    showError('Enter the 6-digit code.');
    return;
  }
  if (isOffline()) {
    showError("You're offline - check your connection and try again.");
    return;
  }
  els.btnVerify.disabled = true;
  els.accountStatus.textContent = 'Checking...';
  const result = await auth.verifyOtp(pendingEmail, token);
  els.btnVerify.disabled = false;
  if (!result.ok) {
    showError(result.message);
    els.accountStatus.textContent = `We sent a 6-digit code to ${pendingEmail}.`;
    return;
  }
  await afterSignIn();
}

// --- account screen: password flow ---------------------------------------

function switchToPasswordMode() {
  mode = 'password';
  showError('');
  els.pwEmail.value = els.email.value;
  setStep('password');
}

function switchToCodeMode() {
  mode = 'code';
  showError('');
  setStep('email');
}

async function handleSignInPassword() {
  if (!isConfigured()) return;
  const email = els.pwEmail.value.trim();
  const password = els.password.value;
  showError('');
  if (!email || !password) {
    showError('Enter your email and password.');
    return;
  }
  if (isOffline()) {
    showError("You're offline - check your connection and try again.");
    return;
  }
  els.btnSignInPassword.disabled = true;
  const result = await auth.signInPassword(email, password);
  els.btnSignInPassword.disabled = false;
  if (!result.ok) {
    showError(result.message);
    return;
  }
  await afterSignIn();
}

async function handleSignUpPassword() {
  if (!isConfigured()) return;
  const email = els.pwEmail.value.trim();
  const password = els.password.value;
  showError('');
  if (!email || password.length < 6) {
    showError('Enter your email and a password of at least 6 characters.');
    return;
  }
  if (isOffline()) {
    showError("You're offline - check your connection and try again.");
    return;
  }
  els.btnSignUpPassword.disabled = true;
  const result = await auth.signUpPassword(email, password);
  els.btnSignUpPassword.disabled = false;
  if (!result.ok) {
    showError(result.message);
    return;
  }
  if (result.needsConfirmation) {
    els.accountStatus.textContent = 'Check your email to confirm your account, then sign in.';
    return;
  }
  await afterSignIn();
}

// --- post sign-in: prompt once for a display name -------------------------

async function afterSignIn() {
  showError('');
  const session = storage.getSession();
  let hasName = false;
  try {
    const profile = session ? await sync.pullProfile(session.userId) : null;
    hasName = Boolean(profile?.display_name);
  } catch {
    /* offline right after sign-in - skip the prompt, sync will catch up later */
  }
  if (hasName) {
    await finishSignIn();
    return;
  }
  els.accountStatus.textContent = '';
  setStep('name');
  els.displayName.focus();
}

async function handleSaveDisplayName() {
  const name = els.displayName.value.trim();
  const session = storage.getSession();
  if (name && session) {
    try {
      await sync.pushDisplayName(session.userId, name);
    } catch {
      /* best-effort - not fatal to sign-in */
    }
  }
  await finishSignIn();
}

async function handleSkipDisplayName() {
  await finishSignIn();
}

async function finishSignIn() {
  stopResendCooldown();
  await refreshChip();
  showScreenFn('menu');
  // Merge local+cloud progress right away rather than waiting for the next
  // menu visit - onMenuShown() below also does this on every subsequent
  // visit, but the player just signed in, they've earned an immediate sync.
  sync.syncNow().catch(() => {});
}

// --- progress screen -------------------------------------------------------

function renderProgressBest(plays) {
  const bestByGame = new Map();
  for (const p of plays) {
    const prev = bestByGame.get(p.game_id);
    if (prev == null || p.accuracy > prev) bestByGame.set(p.game_id, p.accuracy);
  }
  els.progressBest.innerHTML = '';
  if (bestByGame.size === 0) {
    els.progressBest.textContent = 'No plays recorded yet.';
    return;
  }
  for (const [gameId, accuracy] of bestByGame) {
    const row = document.createElement('div');
    row.className = 'progress-row';
    row.textContent = `${gameLabel(gameId)}: ${Math.round(accuracy * 100)}%`;
    els.progressBest.appendChild(row);
  }
}

function renderProgressPlays(plays) {
  els.progressPlays.innerHTML = '';
  if (plays.length === 0) {
    els.progressPlays.textContent = 'Nothing yet - play a game and it will show up here.';
    return;
  }
  for (const p of plays.slice(0, 15)) {
    const row = document.createElement('div');
    row.className = 'progress-row';
    const when = p.played_at ? new Date(p.played_at).toLocaleString() : '';
    row.textContent = `${gameLabel(p.game_id)} L${p.level} - ${Math.round(p.accuracy * 100)}% - ${when}${p.device_label ? ` - ${p.device_label}` : ''}`;
    els.progressPlays.appendChild(row);
  }
}

async function openProgressScreen() {
  showScreenFn('progress');
  els.progressPasswordStatus.textContent = '';
  els.progressPassword.value = '';
  if (!isConfigured()) {
    els.progressStatus.textContent = 'Accounts not set up.';
    els.progressSummary.textContent = '';
    els.progressBest.textContent = '';
    els.progressPlays.textContent = '';
    return;
  }
  const session = storage.getSession();
  if (!session) {
    els.progressStatus.textContent = 'Not signed in.';
    return;
  }
  els.progressStatus.textContent = `Signed in as ${session.email}.`;
  els.progressBest.textContent = 'Loading...';
  els.progressPlays.textContent = 'Loading...';

  const syncResult = await sync.syncNow().catch(() => ({ ok: false, reason: 'network' }));
  const snapshot = storage.getProgressSnapshot();
  els.progressSummary.textContent =
    `Level ${snapshot.level} - ${snapshot.cleared.length} of ${GAMES.length} game(s) cleared - ${snapshot.gamesPlayed} game(s) played` +
    (syncResult.ok ? '' : syncResult.reason === 'offline' ? ' (offline - showing local progress)' : ' (could not reach the server - showing local progress)');

  try {
    const plays = await sync.pullPlays(session.userId, 50);
    renderProgressBest(plays);
    renderProgressPlays(plays);
  } catch {
    els.progressBest.textContent = "Couldn't load - check your connection.";
    els.progressPlays.textContent = '';
  }
}

async function handleSetPassword() {
  const password = els.progressPassword.value;
  els.progressPasswordStatus.textContent = '';
  if (password.length < 6) {
    els.progressPasswordStatus.textContent = 'Use at least 6 characters.';
    return;
  }
  if (isOffline()) {
    els.progressPasswordStatus.textContent = "You're offline - check your connection and try again.";
    return;
  }
  els.btnSetPassword.disabled = true;
  const result = await auth.setPassword(password);
  els.btnSetPassword.disabled = false;
  els.progressPasswordStatus.textContent = result.ok ? 'Password set - you can now sign in with it too.' : result.message;
  if (result.ok) els.progressPassword.value = '';
}

async function handleSignOut() {
  await auth.signOut(); // keeps local progress - only the session is cleared
  await refreshChip();
  showScreenFn('menu');
}

// --- public API --------------------------------------------------------

export function init({ showScreen }) {
  showScreenFn = showScreen;
  cacheEls();

  els.chipName.addEventListener('click', () => {
    if (storage.getSession()) openProgressScreen();
    else {
      resetAccountScreen();
      if (!isConfigured()) {
        els.accountStatus.textContent = "Accounts not set up. See the README's \"Setting up accounts (Supabase)\" section.";
      }
      showScreenFn('account');
    }
  });
  els.chipSignout.addEventListener('click', () => handleSignOut());

  els.btnSendCode.addEventListener('click', handleSendCode);
  els.btnUsePassword.addEventListener('click', switchToPasswordMode);
  els.btnVerify.addEventListener('click', handleVerify);
  els.btnResend.addEventListener('click', handleResend);
  els.btnCodeBack.addEventListener('click', () => {
    showError('');
    stopResendCooldown();
    setStep('email');
  });
  els.btnSignInPassword.addEventListener('click', handleSignInPassword);
  els.btnSignUpPassword.addEventListener('click', handleSignUpPassword);
  els.btnUseCode.addEventListener('click', switchToCodeMode);
  els.btnNameSave.addEventListener('click', handleSaveDisplayName);
  els.btnNameSkip.addEventListener('click', handleSkipDisplayName);
  els.btnAccountBack.addEventListener('click', () => {
    stopResendCooldown();
    showScreenFn('menu');
  });

  els.btnSetPassword.addEventListener('click', handleSetPassword);
  els.btnProgressSignout.addEventListener('click', handleSignOut);
  els.btnProgressBack.addEventListener('click', () => showScreenFn('menu'));

  if (!isConfigured()) {
    els.chipName.textContent = 'Accounts not set up';
    els.chipSignout.hidden = true;
  } else {
    refreshChip();
  }
}

/** Called from js/main.js's showScreen('menu') - refreshes the chip and, if
 * signed in, pulls+merges+pushes progress and flushes any queued offline
 * plays. Fire-and-forget: the menu itself never waits on the network
 * (D11 - and a slow/offline network must never block the menu). */
export function onMenuShown() {
  if (!els) return; // init() hasn't run yet (shouldn't happen - defensive)
  refreshChip();
  if (isConfigured() && storage.getSession()) {
    sync.syncNow().catch(() => {});
  }
}

/** Called from js/main.js right after a run finishes (before/around
 * showEndScreen). Queues the play locally and, if signed in, tries an
 * immediate flush - offline or signed-out, it's a no-op beyond the local
 * enqueue (which itself only happens when signed in - a guest's plays are
 * simply not tracked server-side, matching D11's guest-is-default design).
 * Never awaited by the caller - recording sync state must never delay the
 * end screen appearing. */
export function recordPlay({ game, level, seed, accuracy, counts, allTapsMedianMs }) {
  if (!isConfigured()) return;
  const session = storage.getSession();
  if (!session) return;
  const row = {
    game_id: game.id,
    level,
    seed: String(seed),
    accuracy,
    perfect: counts?.perfect || 0,
    good: counts?.good || 0,
    miss: counts?.miss || 0,
    avoided: counts?.avoided || 0,
    median_timing_ms: allTapsMedianMs != null ? Math.round(allTapsMedianMs) : null,
    played_at: new Date().toISOString(),
  };
  storage.enqueuePlay(row);
  if (!isOffline()) {
    sync.flushOutbox(session.userId).catch(() => {});
  }
}
