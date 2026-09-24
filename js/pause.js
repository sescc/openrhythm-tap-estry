// js/pause.js
// Detects "the player left" (tab hidden, window blurred, or the page is
// being torn down for bfcache/navigation) and calls back at most once per
// occurrence. Three separate browser signals because no single one is
// reliable everywhere:
//   - visibilitychange is the canonical signal, but on some mobile Safari
//     versions it can fire late (after audio has already kept playing a
//     noticeable amount) when the user switches app via the app-switcher.
//   - blur fires immediately in that case, so it's trusted on its own too
//     (not gated on document.hidden - on desktop, losing window focus while
//     a rhythm game is running is itself a good reason to pause; there's no
//     real-player scenario where that's an unwanted false positive).
//   - pagehide covers the tab being suspended into bfcache / actually
//     navigated away, which blur/visibilitychange don't always cover.
// All three are deliberately over-inclusive rather than under-inclusive:
// missing a real "the player left" event is the bug this file exists to
// prevent (see CLAUDE.md), and pausing one extra time (e.g. a spurious
// desktop blur) just means one extra tap to resume.
export function attachAutoPause(onHidden) {
  let armed = true; // false while already "away" - re-armed on return

  function trigger(source) {
    if (!armed) return;
    armed = false;
    onHidden(source);
  }
  function handleVisibility() {
    if (document.hidden) trigger('visibilitychange');
    else armed = true;
  }
  function handleBlur() {
    trigger('blur');
  }
  function handleFocus() {
    armed = true;
  }
  function handlePageHide() {
    trigger('pagehide');
  }

  document.addEventListener('visibilitychange', handleVisibility);
  window.addEventListener('blur', handleBlur);
  window.addEventListener('focus', handleFocus);
  window.addEventListener('pagehide', handlePageHide);

  return () => {
    document.removeEventListener('visibilitychange', handleVisibility);
    window.removeEventListener('blur', handleBlur);
    window.removeEventListener('focus', handleFocus);
    window.removeEventListener('pagehide', handlePageHide);
  };
}
