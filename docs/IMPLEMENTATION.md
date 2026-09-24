# TapESTORY — implementation mapping

Every row in `ARCHITECTURE.md` maps here to `file:symbol`, to `planned`, or to `open question`.
A row pointing at something that no longer exists is drift: fix the code or fix the row.

## Data
| Object | Realised by |
| --- | --- |
| `Seed` | `js/rng.js:resolveSeed`, `js/rng.js:makeRng`, `js/rng.js:subRng` (independent streams: chart / synth / sfx / story) |
| `Chart` | `js/songform.js:buildChart` → `js/chart.js:assembleChart`; per-game material from `js/games/*.js:compose` |
| `AbsChart` | `js/chart.js:toAbsoluteChart` (called once in `js/main.js:startPlay`) |
| `SongBuffer` | `js/audio/synth.js:renderSong` (voices in `js/audio/voices.js`, clicks/blips in `js/audio/cues.js`) |
| `SfxPack` | `js/audio/sfx.js:renderAllPacks`, `js/audio/sfx.js:renderGuidePack`, played by `:playBuffer` / `:scheduleBuffer` |
| `StoryPanels` | `js/story/loader.js:loadStory`; art by `js/story/styles/*.js:renderScene` / `:renderFumbled`; picked by `js/story/styles/index.js:pickStyle` |
| `Judgement` | `js/input.js:createJudge` (`judgeTap`, `judgeRelease`, `update`) |
| `Calibration` | `js/calibration.js:pairTapsToClicks`, `:computeCalibration`, `:computeVerifyResiduals`; stored via `js/storage.js:setCalibrationOffsetMs` |
| `Progress` | `js/storage.js` (`getLevel`, `markCleared`, `markCuePracticed`, `getGuidesPref`, `migrateIfNeeded`) |

## Transformations
| Transformation | Realised by |
| --- | --- |
| Compose a chart from a seed | `js/songform.js:buildChart`, level knobs in `:levelParamsFor` |
| Audibility law (every note predicted by an earlier cue) | `js/songform.js:lintChart`, swept by `tools/lint.html` |
| Render the song | `js/audio/synth.js:renderSong` |
| Render the story | `js/story/loader.js:loadStory` |
| Judge a tap | `js/input.js:createJudge`; windows exported from `js/input.js` |
| Map a DOM event to audio time | `js/clock.js:eventToContextTime` |
| Compute a calibration offset | `js/calibration.js:computeCalibration` |
| Re-plan after a pause | `js/songform.js:planPauseResume` |
| Pick the next game / remix | `js/games/index.js:pickNextGame`, `:isRemixTurn`, `js/games/remix.js:pickSubGames` |

## Locations and transmissions
| Model row | Realised by |
| --- | --- |
| `AudioContext` singleton, gesture-gated | `js/clock.js:getContext`, `:resumeContext`, `:now`, `:isRunning` |
| Backgrounding signal | `js/pause.js:attachAutoPause` (visibilitychange + blur + pagehide) |
| Pause / resume wiring | `js/main.js` `pauseNow` / `resumeNow` |
| Decode gated on visibility | `js/story/loader.js:decodeWhenVisible` |
| Stage: pooled DOM, transform/opacity only | `js/render/stage.js:createStage` |
| Device budget / low-end mode | `js/assets.js:detectLowEnd`, `:getBudget` |
| Input attachment (pointer, key, hold, cancel) | `js/input.js:attachInput` |

## Tests
| Law | Test |
| --- | --- |
| Calibration pairing survives a missed / extra / early tap | `tests/calibration_test.mjs` |
| A correctly-timed tap scores; a 600 ms tap is ignored and reports its delta | `tests/judging_e2e_test.mjs` |
| Pause/resume skips fairly and never resumes mid-phrase | `tests/pause_test.mjs` |
| All of the above, one command | `tests/run.mjs` (`node tests/run.mjs`, nonzero exit on failure) |
| Audibility law across every game and level | `tools/lint.html` (4800 charts, 0 violations) |

## Known dead or unmapped rows
- Mascot animations are one shared vocabulary rather than per-game; `ARCHITECTURE.md` does not
  claim otherwise, but the M1.5 plan did.
- No row maps to version control: `git` is absent in this environment, so nothing is committed.
