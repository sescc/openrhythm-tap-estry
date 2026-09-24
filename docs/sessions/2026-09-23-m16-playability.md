# Session — 2026-09-23 — M1.6 playability (calibration, guides, practice, pixel art)

Immutable. New findings go in a new log plus updates to the living docs.

## Where this started
The user playtested M1.5 on a real device and **hit zero notes in every game**. Every tap logged
`ignored tap @ <time>` with no offset, so it was undiagnosable from inside the game. M1 (plain
constant beats) had been playable.

## Root cause (fixed)
`js/main.js:162` paired the *n*-th tap with the *n*-th metronome click **by counting taps**:
```js
const offsetMs = (rawTime - clickTimes[tapCount]) * 1000;
```
One missed, early or extra tap shifted every later pairing by a whole beat (600 ms at CAL_BPM 100).
The median was stored unclamped and then subtracted from every tap in play, pushing all of them
outside the ±150 ms window, permanently, in every game.

**Why no test caught it:** `?autoplay=` taps at chart times, where the stored offset cancels out.
The offset only affects real human input. 4800 linted charts and ~20 autoplay runs were all blind
to it. This is the session's main lesson: *a self-play harness cannot validate an input transform.*

## Decisions made
- Calibration pairs taps to the **nearest click by time**, rejects outliers (MAD), needs ≥ 6 valid
  taps, clamps to ±200 ms, and **re-runs rather than storing** an implausible result. It now shows
  the offset and spread, and adds a 4-tap verify step. (`js/calibration.js`, pure and testable.)
- Ignored taps carry `nearestNote` and `deltaMs`; the end screen shows a median over *all* taps and
  offers a recalibrate prompt when ≥ 8 taps agree in direction with |median| > 60 ms.
- Guides: a soft tick at each expected tap plus an approach ring, on until a game is cleared,
  overridable by menu toggle or `?guides=`. Chosen by the user over audio-only or always-on.
- Judgement windows stay fixed (user's choice) — the fix was the bug, not leniency.
- Practice gained a timeline with a playhead, Listen → "Your turn" phases, per-tap direction and
  milliseconds, a tally and a pass bar. It previously gave no signal at all.
- Progress and calibration were **deliberately wiped** via a storage version bump, since the old
  values were produced under the broken calibration.
- Pixel art: ≈3× weight, internal frame 112×81 → 320×230 (192×138 low-end), 26-colour ramped
  palette with lit/shadow sides, rim light and ambient occlusion. A 15-bit RGB lookup table replaced
  the per-pixel palette search, so it renders **faster than before** despite 8× the pixels.

## Decisions discarded
- Widening hit windows at low levels — rejected by the user; the real defect was the offset.
- Swapping `img.decode()` for `createImageBitmap` to dodge the hidden-page hang — rejected because
  it weakens the "already decoded, zero-hitch" guarantee; waiting for visibility keeps it intact.

## Bugs found and fixed this session
1. Calibration index pairing (above) — the headline bug.
2. A diagnostic nearest-note lookup trusted a boundary hint and misreported the delta; found by the
   new end-to-end test.
3. `img.decode()` never settles while the page is hidden → the loading screen hung forever. Found by
   direct probe: a trivial 640×480 blob was still pending after 6 s hidden, 0 ms visible.
4. `getImageData()` on a GPU-backed canvas cost 9–13 ms at the new pixel resolution → fixed with
   `willReadFrequently: true`.

## Benchmarks
- Full-size panel render (normal / low-end, ms): geometric 0.4/0.5, papercut 0.4/0.5, neon 0.8/0.8,
  watercolour 0.9/0.6, ink 1.5/1.5, **pixel 5.9/3.0** (was 8.7/4.5), crayon 8.1/6.4.
- Whole low-end story: 63 ms (budget 3000 ms). Pixel panels encode to ~161 KB vs ~16 KB for
  watercolour (dither compresses poorly); decoded memory is identical across styles.
- Quantise cost informing the resolution choice: 112×81/14 colours 3.7 ms; 320×230/32 9.8 ms naive;
  480×345/32 21 ms; 640×460/48 68.6 ms.

## Tests run
- `node <scratchpad>/calibration_test.mjs` → PASS (9 scenarios incl. the missed-first-tap trigger).
- `node <scratchpad>/judging_e2e_test.mjs` → PASS (±30 ms scores; ±600 ms ignored, delta reported).
- `tools/lint.html` → 0 violations across 4800 charts.
- Live: `?autoplay=events&game=echo&level=1&debug&seed=3` → 30/30 Perfect, median 20.5 ms, 0 ignored,
  good ending, no console errors.

## Live execution state
- Static server on **port 8080** via the `static` config in `.claude/launch.json`
  (`npx --yes http-server -p 8080 -c-1 .`).
- A Sonnet subagent is **in flight**: moving the three tests into `tests/` with a `node tests/run.mjs`
  runner, and stopping the `?debug` overlay covering the end-screen buttons.
- Nothing is committed anywhere: **`git` is not installed in this environment**.

## Environment traps worth knowing
- This desktop pane reports `document.hidden === true` at rest, which **fully suspends**
  `requestAnimationFrame` (not merely throttles it) and stalls any playthrough, and blocks
  `img.decode()` so loading never finishes. A real `computer` click makes it visible again — that is
  how the live run above was completed. Prefer direct module imports for anything timing-sensitive.
- A long multi-canvas page screenshots blank here; composite renders onto one canvas and screenshot
  that instead.
- Re-importing a module with `?v=` does not reload *its* un-versioned imports; only a full navigation
  does. Two measurements were briefly wrong because of this.

## Resume commands
```bash
cd C:\FMW\Code\Claude\OpenRhythmOD; python -m http.server 8080
```
- Play: `http://localhost:8080` — calibrate once first.
- Self-play check: `http://localhost:8080/?autoplay=events&game=echo&level=1&debug&seed=3`
- Learnability sweep: `http://localhost:8080/tools/lint.html`
- Art contact sheet: `http://localhost:8080/tools/styles.html`
- Force a style / game / level: `?style=pixel`, `?game=swing&level=8`, `?guides=on|off`, `?lowend`
- Tests (once landed): `node tests/run.mjs`

## Open ends
1. **The user's playtest of M1.6 is the next real checkpoint** — nothing here proves the game feels
   right with real fingers.
2. Install git, commit this work, then decide on GitHub Pages.
3. Scene composition: near-empty panels (horizon off-frame), props rendering below the horizon.
4. Mascot animations are generic; practice has no visual metronome.
5. M2 (uploads) and M3 (curated/online packs) untouched.
