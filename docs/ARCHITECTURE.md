# TapESTORY — architecture (intent)

Normative and hand-authored. This says what the system is *supposed* to be; `IMPLEMENTATION.md`
maps each row to real code. Where they disagree, one of the two is wrong — say which and fix it.

> Grounding note: this session could not read the supercharge `FRAMEWORK.md` (the skill's files are
> outside the shell sandbox), so the four categories below are used as the skill body describes them
> — data, transformations, locations, transmissions — without citing numbered framework rules.
> Re-ground these sections when FRAMEWORK.md is readable.

## The one-line intent
A static page that, from a single seed and with no network, produces a song and a picture-story that
a person plays by tapping in time — where every tap is *predictable from sound the player already
heard*, and every tap is judged against the audio hardware clock rather than wall time.

## Data (`Dat`)
| Object | What it is | Invariant |
| --- | --- | --- |
| `Seed` | One integer; the whole run derives from it | Same seed ⇒ same song, chart, story, art style |
| `Chart` | Sections, phrases, `notes[]`, `cues[]`, meter, bpm | Times are **relative to song start** until shifted exactly once |
| `AbsChart` | The chart shifted onto the AudioContext timeline | Every consumer downstream sees absolute time only |
| `SongBuffer` | One rendered `AudioBuffer` (backing + baked cues) | Cue onsets in the audio equal `chart.cues[].time` |
| `SfxPack` | Pre-rendered response/guide buffers, per game | Exists before play begins; never synthesised mid-song |
| `StoryPanels` | Per phrase: a good and a fumbled image, already decoded | Decoded before play; never fetched or decoded during play |
| `Judgement` | Per note: perfect / good / miss / avoided / skipped | Assigned once; `skipped` is excluded from accuracy entirely |
| `Calibration` | One signed offset (ms) plus its spread | Clamped to ±200 ms; an unmeasurable run is re-run, never stored |
| `Progress` | Level, cleared games, practised cues, guides preference | Versioned; a version bump may wipe it deliberately |

## Transformations (`Trn`)
`Seed → Chart` (compose) · `Chart → SongBuffer` (render offline) · `Chart → SfxPack` ·
`Seed → StoryPanels` (render, encode, decode) · `Chart → AbsChart` (shift once) ·
`(tap, AbsChart) → Judgement` (judge) · `(taps, clicks) → Calibration` (pair, reject outliers, median) ·
`(AbsChart, pause, resume) → AbsChart′` (re-plan at a phrase boundary).

**Laws this layer must satisfy** (each is checkable, and each has been violated at least once here):
1. *Single clock.* Every judged time derives from `AudioContext`. Wall time and frame time are not
   permitted in the judging path.
2. *Latency compensation is applied exactly once.* `getOutputTimestamp()` is already audible time.
3. *Audibility.* Every judged note is predictable from a cue that sounded ≥ 1 beat earlier —
   enforced mechanically by `lintChart`, not by review.
4. *Zero work at tap time.* A tap changes `opacity`/`transform` on pre-created DOM; it allocates
   nothing, decodes nothing, lays out nothing.
5. *One shift.* Relative→absolute happens exactly once per run (plus once per resume).
6. *Fairness.* A note the player was not present for (backgrounded) is `skipped`, never `miss`.

## Locations (`Loc`)
| Location | Holds | Notes |
| --- | --- | --- |
| Main thread / DOM | Screens, stage, pooled visual elements | The only writer of visible state |
| `AudioContext` (audio thread) | The timeline of record | Suspended until a user gesture |
| `OfflineAudioContext` | Song and SFX rendering | Runs during loading only |
| Blob store + image decoder | Encoded panels and their decoded bitmaps | Decode is visibility-gated by the browser |
| `localStorage` | `Calibration`, `Progress` | May be absent or throw; never required for play |

## Transmissions (`Trm`)
| Carrier | From → To | Failure mode it must survive |
| --- | --- | --- |
| `event.timeStamp` → context time | DOM event → judging | A wrong mapping silently kills all scoring |
| `AudioBufferSourceNode.start(when)` | Chart → speaker | Scheduling in the past drops the sound |
| Blob URL → `<img>` → decoded bitmap | Renderer → stage | `decode()` never settles while the page is hidden |
| `visibilitychange` / `blur` | Browser → pause | Mobile Safari can report it late |
| `localStorage` read/write | Session → next session | Absent, blocked, or holding a stale schema |

## Deliberate constraints
- **No build step, no dependencies, no CDN.** The page must run as plain files from a static host.
- **Procedural first.** Content is generated, so it cannot run out and needs no licence.
- **Shadow track.** Good and fumbled art are the same moment, so the story cannot jump illogically.
- **The player makes the response sound.** The backing never plays the answer.

## Open questions
- No version control in this environment (`git` is not installed), so nothing is committed and
  GitHub Pages publication is blocked.
- Scene composition can still produce near-empty panels (horizon off-frame; props below the horizon).
- Real-device timing has been verified only through synthetic input.
