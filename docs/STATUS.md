# TapESTORY — status

Last updated: 2026-09-23.

| Milestone | State | Notes |
| --- | --- | --- |
| **M1** procedural core | done | Clock, calibration, judging, procedural song + story, shadow-track reveal, endings |
| **M1.5** learnable minigames + art styles | done | 6 minigames + remix, holds, fake-outs, practice, level ladder; 7 art styles |
| **M1.6** playability fixes | done, pending user playtest | Calibration bug fixed, guides, practice feedback, hi-res pixel art |
| **M2** user uploads | not started | Local-only audio + image upload, DSP beat detection, IndexedDB cache |
| **M3** curated packs + online sources | not started | Offline curation script, attribution, optional Openverse fetch on the menu only |
| **Publish** | blocked | `git` is not installed in this environment; nothing is committed and Pages cannot be set up from here |

## Verified
- Learnability lint: 0 violations across 4800 generated charts.
- Calibration and judging regression tests: pass (run from the scratchpad; being moved into `tests/`).
- Full live playthrough: 30/30 Perfect, median offset 20.5 ms, 0 ignored, good ending.
- Art: 7 styles render a full story inside budget; pixel 5.9 ms / panel normal, 3.0 ms low-end.

## Not verified
- Real fingers on a real phone — the only test that settles whether the game feels right.
- Whether each minigame actually teaches its own rhythm (needs a human).

## In flight
- Nothing. `tests/` landed (`node tests/run.mjs` → 3/3 pass, exit 0) and the `?debug` overlay
  moved out of the way of the end-screen buttons.

## Next
1. User playtest of M1.6.
2. Install git, commit, then decide on publishing to GitHub Pages.
3. Scene-composition pass (near-empty panels, props below the horizon).
4. M2.
