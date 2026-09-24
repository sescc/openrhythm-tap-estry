# OpenRhythmOD

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

Every device/browser has a slightly different audio output latency, so the
first time you play (and any time from the menu's always-available
"Recalibrate timing" button) you'll be asked to tap along with 12 clicks.
Each tap is paired with whichever click it's actually closest to **in
time** (not by counting position - a missed or extra tap no longer throws
off every later pairing), outliers are rejected (median absolute
deviation), and the result is clamped to ±200ms - anything further off
just re-runs rather than storing a bad guess. A short 4-tap verify pass
follows, printing each tap's residual so a bad calibration is visible
immediately. The measured offset and its spread are shown on the
calibrate screen and on the menu, and saved to `localStorage`.

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
(section: backgrounding mid-song). Run them after touching
`js/calibration.js`, `js/input.js`, `js/songform.js`, or `js/pause.js`.

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
