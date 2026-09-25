# TapESTORY

A tiny, static, dependency-free rhythm game: every playthrough procedurally
generates its own song (drums/bass/chords/melody + a call-and-response beat
chart) and its own watercolour storybook, from a single random seed. Tap on
the beat to paint the story in and pop a sticker; miss the beat and you see
the story's "fumbled" shadow-track version of that moment instead - the
story never stops, it just goes a little wrong. Land at ~70% accuracy or
better across the whole song for the good ending.

This is **Milestone 1**: a fully playable, fully offline core. No uploads,
no curated asset packs, no network requests of any kind - everything is
generated in the browser from the seed. It's plain ES modules with no
build step and no external dependencies/CDNs, so it runs as-is from
GitHub Pages (or any static file server).

## Running locally

You need *some* static file server (ES modules can't be loaded via
`file://`). Two ready-made options:

```powershell
# Option A: via .claude/launch.json (uses npx http-server)
npx --yes http-server -p 8080 -c-1 .

# Option B: Python's built-in server
python -m http.server 8080
```

Then open `http://localhost:8080/` in a browser.

## Controls

- **Tap anywhere on the picture** (pointerdown) **or press any key** exactly
  on the beat.
- Listen for the short "call" blip before a call-and-response phrase - it
  plays the rhythm you then echo.
- A well-timed tap paints the current story panel in further and pops a
  sticker. A missed beat reveals the fumbled (drained-colour, tilted,
  ink-blotted) version of that same bit of story instead - the story keeps
  moving regardless.

## Calibration

Every device/browser has a slightly different audio output latency (Bluetooth
earphones add the most, often 150-350ms), so the first time you play, and any
time you choose "Recalibrate timing" from the menu, you tap along with a
metronome at 80 BPM. Four count-in clicks with an on-screen 4-3-2-1 countdown
come first (taps during the count-in are ignored), then 12 recorded clicks.
Tap along with the *sound*, not the screen. Each tap is paired with the click
it's closest to in time (by time, not by counting), outliers are rejected
(median absolute deviation), and offsets from -200ms to +450ms are accepted;
anything outside that re-runs rather than storing a bad guess. A short verify
pass follows. The measured offset and its spread are shown on the menu and
saved to `localStorage`. "Back" leaves calibration at any point without
saving. Judging, the on-screen guides and story progress all follow when you
*hear* the sound (the scheduled time plus the measured offset).

## Testing

There's no build step and no test framework dependency - regression tests
are plain ES modules under `tests/`, run directly with Node (no browser):

```powershell
node tests/run.mjs
```

Runs every `tests/*_test.mjs` file, prints a PASS/FAIL line per file, and
exits with a nonzero code if any of them failed. These specifically guard
against the M1.6 calibration bug (a missed/extra tap during calibration
used to shift every later pairing by a whole beat, silently making every
real tap in every game land outside the judging window - `?autoplay=`
never caught it because it taps at exact chart times, so the same wrong
offset cancels out on both sides) and the pause/resume time-shift math
(section: backgrounding mid-song). Run them after any code change. They
also check that `sw.js` is freshly stamped (`sw_test`) and that every
element id the code looks up exists in `index.html` (`dom_ids_test`).

## URL parameters (useful for testing)

- `?seed=<anything>` - reproduce an exact song/chart/story. The seed is also
  written back into the URL automatically and shown on the end screen.
- `?debug` - shows a small overlay with every judged tap's offset in
  milliseconds plus a running mean/median, and logs ignored stray taps too.
- `?autoplay=perfect` - simulates a tap at the exact time of every note (a
  scripted "reach the good ending" run).
- `?autoplay=miss` - simulates no taps at all, so every note auto-misses
  150ms after its time (a scripted "reach the bad ending" run).
- `?lowend` - forces low-end mode (smaller images, fewer watercolour paint
  layers, 22.05kHz audio render) regardless of device detection.
- `?sw=on` / `?sw=off` - register / unregister the offline service worker.
  It is skipped on localhost by default so a dev server never serves stale
  cached modules.

## Offline play

After one visit, `sw.js` has cached the whole site, so every game and seed
plays with no connection, including reloads and later visits. It can also be
installed as an app (`manifest.webmanifest`). The service worker is not
registered on `localhost` (so a dev server never serves stale files); add
`?sw=on` to test it locally and `?sw=off` to remove it.

## Setting up accounts (Supabase)

Accounts and cross-device progress (section C) are **optional** - with
`js/config.js` left as-is (empty `SUPABASE_URL`/`SUPABASE_ANON_KEY`), every
account UI shows "Accounts not set up" and the game works exactly as it did
before this feature existed: guest play, local-only progress. Everything
below is only needed if you want sign-in + synced progress to actually work.

1. **Create a free Supabase project** at [supabase.com](https://supabase.com).
2. **In Auth > Providers > Email:**
   - turn the Email provider **on**;
   - turn **"Confirm email" off** (for this demo - so a password sign-up gets
     a session immediately instead of waiting on a confirmation email).
3. **In Auth > Sign In / Providers (or "Auth settings", depending on the
   dashboard version) set the OTP length to 6 and the expiry to about 600
   seconds (10 minutes).**
4. **Edit the "Magic Link" email template** (Auth > Email Templates) to show
   the code instead of a link, since the app calls the same endpoint for
   both and just uses the code (`{{ .Token }}`), not the link. A minimal
   template body:

   ```html
   <h2>Your TapESTORY sign-in code</h2>
   <p>Enter this code in the app:</p>
   <p style="font-size: 28px; font-weight: 700; letter-spacing: 4px;">{{ .Token }}</p>
   <p>It expires in 10 minutes.</p>
   ```
5. **Optional but recommended: add a free custom SMTP sender** (Auth >
   Settings > SMTP), e.g. [Resend](https://resend.com) or
   [Brevo](https://www.brevo.com) - both have a free tier. Supabase's
   built-in email sender only allows a few emails per hour, which is too few
   once more than one or two people are trying the app. For a live demo
   without depending on anyone's inbox (or the rate limit), a pre-made
   password test account is the reliable fallback - sign it up once via
   "Use a password instead" and share those credentials.
6. **Set the Site URL** (Auth > URL Configuration) to your GitHub Pages URL,
   and **add `http://localhost:8080` as an additional redirect URL** for
   local testing.
7. **Run `supabase/schema.sql`** once in the SQL editor (Database > SQL
   Editor > New query, paste, Run). It creates `profiles`, `progress` and
   `plays` with row-level security enabled on all three (every policy scoped
   to `auth.uid()`), plus the triggers that create a `profiles` row on
   sign-up and keep `updated_at` current. It's written to be safe to re-run.
8. **Paste the project URL and anon key into `js/config.js`** (Project
   Settings > API in the dashboard):

   ```js
   export const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
   export const SUPABASE_ANON_KEY = 'eyJ...'; // the "anon" / "public" key, NOT the service_role key
   ```

   The anon key is **public by design** - it ships in the client bundle for
   every Supabase project, and row-level security (not key secrecy) is what
   actually protects the data. Never put the `service_role` key anywhere in
   client code.

**Free-tier note:** a Supabase free project **pauses after about 7 days of
inactivity**. One click ("Restore") in the dashboard brings it back - just
remember to do that before a demo if the project's been idle a while.

## Deploying your own copy

The game itself needs no build and no dependencies. Node.js (v20 or newer) is
needed only for two maintenance commands: running the tests and stamping
the service worker.

1. Clone and check it runs:

   ```bash
   git clone https://github.com/<you>/openrhythm-tapestry.git
   cd openrhythm-tapestry
   npx --yes http-server -p 8080 -c-1 .
   ```

   Then open `http://localhost:8080/`.

2. **After changing any file the game loads** (`index.html`, anything under
   `js/` or `css/`, `manifest.webmanifest`, `icon.svg`), re-stamp the service
   worker and run the tests:

   ```bash
   node tools/stamp-sw.mjs
   node tests/run.mjs
   ```

   `tools/stamp-sw.mjs` rewrites the `VERSION` (a content hash) and `ASSETS`
   list at the top of `sw.js`. Browsers only fetch updated files when `sw.js`
   itself changes, so if you skip this step, returning players keep the old
   version forever. `tests/sw_test.mjs` fails with "run `node
   tools/stamp-sw.mjs`" if you forget. Changes to `tools/`, `tests/`, `docs/`
   or the README don't need a re-stamp.

3. Commit the stamped `sw.js` together with your changes and push.

4. Publish with GitHub Pages: repository **Settings > Pages > Build and
   deployment > Source: Deploy from a branch**, then choose your branch and
   the `/ (root)` folder. The site is served at
   `https://<you>.github.io/openrhythm-tapestry/`. All paths are relative, so
   it works under that subpath (or any other static host) unchanged.

## How it works, briefly

- `js/clock.js` - the only clock: `AudioContext.currentTime`, with output
  latency compensation via `getOutputTimestamp()`.
- `js/chart.js` + `js/audio/synth.js` - a chart-first pattern library
  (steady beats, call-and-response, off-beats, double taps, rests) rendered
  once to a single `AudioBuffer` via `OfflineAudioContext`.
- `js/story/storygen.js` + `js/story/watercolor.js` + `js/story/fumble.js` -
  a seeded story grammar painted with layered, low-opacity, recursively
  deformed polygons (Tyler Hobbs-style watercolour), with a "fumbled"
  variant for misses.
- `js/story/loader.js` - the story **source abstraction**. M1 only
  implements `'procedural'`; it's the single place a later milestone plugs
  in `'upload'`/`'pack'`/`'openverse'` without touching `main.js` or
  `js/render/stage.js`.
- `js/render/stage.js` - pooled DOM (stickers, judgement flash, beat pulse,
  cue bounce) and the panel "wash reveal" (each panel is pre-sliced into N
  cumulative, soft-edged regions; a tap just flips one pooled canvas's
  opacity from 0 to 1).
- Everything (whole song + every good/fumbled panel + both endings) is
  rendered during the Loading screen before Play starts - see "Known
  limitations" below for the one caveat on this.

## Roadmap (not part of M1)

- **M2 - uploads**: a beat-detection Web Worker (onset envelope -> tempo
  autocorrelation -> beat-phase DP) for user-picked audio, grid-subdivision
  charts, a user image set as the story (fumbled via a bitmap filter
  instead of a re-render), an IndexedDB cache keyed by file hash, and a
  manual BPM/offset nudge UI.
- **M3 - curated + online**: `tools/curate.mjs` pulling CC0/PD watercolours
  and music from the Art Institute of Chicago, Cleveland Museum of Art,
  Wikimedia Commons, Internet Archive and Openverse into committed
  `packs/*.json` with full attribution, plus an in-menu "Surprise me
  (online)" Openverse/Jamendo path that falls back to procedural on any
  failure.
- **Deploy**: `git init`, push, enable GitHub Pages. Not done here - pushing
  is outward-facing and needs your go-ahead.

## Deviations from the plan

- **Song length vs. BPM/phrase-count.** The plan asks for BPM 90-140, 8-10
  phrases of 8 beats, a 2-bar count-in, and a total song length of roughly
  60-80s. Those four numbers don't all fit together at every roll: at the
  high end of the BPM range with only 8 phrases, a song comes out closer to
  35-40s. Rather than stretch the phrase count past 10 (which would also
  mean more panels to render on low-end devices) the BPM draw is biased
  toward the lower half of the range (`90 + rng()^2 * 50`) and phrase count
  stays fixed at 8-10. Most seeds land in or near the 60-80s window; a
  minority of high-BPM, low-phrase-count seeds run shorter. Noted rather
  than "fixed" per an explicit design tradeoff (phrase count and the 2-bar
  count-in are pinned more firmly by the spec than the duration's "~").
- **Region-reveal slicing** uses a cumulative left-to-right soft-edged
  gradient mask (`destination-in`) rather than literally stacking every
  region canvas in the DOM at once: only the most-recently-revealed region
  ever needs to go to `opacity: 1`, since it already contains everything
  revealed before it baked in. Still transform/opacity-only at tap time,
  and DOM canvases are inserted lazily (on reveal) rather than
  pre-inserted-but-hidden, which keeps the play screen's DOM small.
- **Panel memory release** happens per-phrase rather than only via a
  generic "sliding window": `js/render/stage.js` frees a panel's good+
  fumbled region canvases (`canvas.width = canvas.height = 0`) as soon as
  gameplay moves past it, which is what keeps ~8-10 panels x 2 variants
  within the memory budget in `js/assets.js` (M1 doesn't need the fuller
  decode-pool machinery that plan describes for M2/M3's larger bitmap
  packs, so `js/assets.js` currently only exports the budget numbers and
  the release helper - the pool itself is a natural M2 addition).

## Known limitations (M1)

- No uploads, curated packs, or online sources yet - see Roadmap above.
- Calibration pairs taps with clicks by nearest time, not sequence, so a
  missed, extra, or double tap during the run no longer misaligns the rest
  of it (see `tests/calibration_test.mjs`). It still needs at least 6 taps
  landing within half a beat of some click to produce a result at all.
- `ctx.getOutputTimestamp()` isn't implemented in every older browser; the
  clock falls back to `ctx.currentTime` directly in that case, which is
  slightly less accurate but still audio-clock-based (never `Date.now()`).
- Story variety is generated from a fairly small grammar (6 heroes, 6
  goals, 5 palettes, a handful of caption templates per beat) - plenty of
  combinatorial variety for M1, but repeat phrasing is noticeable after
  many replays.
- The stray-tap leniency (taps outside the Good window are ignored, not
  penalized) means a badly uncalibrated device can look like "nothing is
  happening" rather than "you're mistiming it" - `?debug` is the way to
  diagnose that (it logs ignored taps too, with a running mean/median of
  judged offsets).
