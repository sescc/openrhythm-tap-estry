// js/story/loader.js
// Story SOURCE ABSTRACTION - the one place that knows where a game's story
// comes from. M1 only implements 'procedural'. Later milestones add cases
// to loadStory() without changing anything else: js/main.js just calls
// loadStory(sourceType, params, onProgress) and gets back the same panel
// shape regardless of source, and stage.js never knows the difference.
//
//   M1  'procedural' - storygen.js + styles/*.js (this file). Each style
//                       module exports { id, name, cost, renderScene,
//                       renderFumbled } (see styles/index.js); the style is
//                       chosen per game (seeded, weighted, ?style= override)
//                       so this is no longer watercolour-only.
//   M2  'upload'      - user-picked local images, in filename order, fumbled
//                        via a bitmap filter (a style module gains a
//                        fumbleBitmap()-style export; this file gains a case
//                        that decodes the files and calls it instead of
//                        renderScene/renderFumbled)
//   M3  'pack'         - a curated packs/*.json manifest (committed assets)
//   M3  'openverse'    - "Surprise me (online)": fetched + decoded before
//                        play, same panel shape, falls back to 'procedural'
//                        on any failure
//
// Every source also does the "zero-delay pictures" work: every panel (good
// AND fumbled variants, both endings) is fully rendered/decoded here, during
// the Loading screen, before play starts. Progress is reported panel by
// panel via onProgress(fraction, label), yielding to the event loop between
// panels so the progress bar can actually repaint.
//
// Each panel is rendered to a canvas ONCE per variant (good, fumbled), then
// immediately converted to a compressed image (WebP/JPEG) via canvas.toBlob,
// wrapped in an object URL, and decoded once with img.decode() so it's
// already warm in the browser's image cache. The canvas is then dropped
// (js/assets.js releaseCanvas). js/render/stage.js creates its own <img>
// elements pointing at the same URLs - the browser shares the decoded
// bitmap across all of them, so there is no per-copy memory cost no matter
// how many reveal "regions" a panel has (see stage.js for how regions are
// now done with CSS masks over two shared images, not N separate bitmaps).

import { generateStory } from './storygen.js';
import { pickStyle, getStyle } from './styles/index.js';
import { subRng } from '../rng.js';
import { getBudget, releaseCanvas } from '../assets.js';

const isDebug = () => {
  try {
    return new URLSearchParams(location.search).has('debug');
  } catch {
    return false;
  }
};

/** Read `?style=<id>` from the page URL, if it names a real style. This is
 * the debug override mentioned in the M1.5 plan; params.forceStyle (an API
 * caller can pass this directly) is checked first, then the URL. */
function urlForcedStyleId() {
  try {
    const id = new URLSearchParams(location.search).get('style');
    return id && getStyle(id) ? id : null;
  } catch {
    return null;
  }
}

export const SOURCE_TYPES = {
  PROCEDURAL: 'procedural',
  // PACK: 'pack', UPLOAD: 'upload', OPENVERSE: 'openverse'  (M2/M3)
};

const BAND_AXES = ['x', 'y', 'diag'];

let cachedImageMime = null;
/** WebP if the browser can encode it, else JPEG (both are fine - the
 * rendered scenes are fully opaque, so no alpha channel is needed). */
function preferredImageMime() {
  if (cachedImageMime) return cachedImageMime;
  const probe = document.createElement('canvas');
  probe.width = 1;
  probe.height = 1;
  const supportsWebp = probe.toDataURL('image/webp').indexOf('data:image/webp') === 0;
  cachedImageMime = supportsWebp ? 'image/webp' : 'image/jpeg';
  return cachedImageMime;
}

// --- visibility-safe decode --------------------------------------------
// Chrome defers ALL HTMLImageElement decode work while the page is hidden:
// `img.decode()` doesn't just run slowly, it never settles at all (probed
// directly - a trivial 640x480 blob's decode() was still pending 6s later
// with the tab backgrounded, vs. 0ms once visible). A player very plausibly
// taps Play and immediately switches apps or locks their phone, so the
// loading screen must not `await warmup.decode()` unconditionally - that
// hangs "Painting the story..." forever with no way back. See the D/edge-
// case log entry in CLAUDE.md for the full writeup.

/** Resolves once the page is visible (no-ops immediately if already
 * visible). Never rejects, never times out - the loading screen is
 * *meant* to sit here indefinitely while the player is away, and resumes
 * on its own via `visibilitychange` with no tap required. */
function onceVisible() {
  if (!document.hidden) return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = () => {
      if (!document.hidden) {
        document.removeEventListener('visibilitychange', onChange);
        resolve();
      }
    };
    document.addEventListener('visibilitychange', onChange);
  });
}

/** Resolves the first time the page goes hidden. Returns a `cancel()` to
 * remove the listener when the caller no longer needs it (e.g. because the
 * thing it was racing against already won) - without this every decode
 * attempt would leak one listener. */
function onceHidden() {
  let listener;
  const promise = new Promise((resolve) => {
    listener = () => {
      if (document.hidden) resolve();
    };
    document.addEventListener('visibilitychange', listener);
  });
  return { promise, cancel: () => document.removeEventListener('visibilitychange', listener) };
}

/**
 * Decode `url` into the browser's image cache, robust to the page being
 * hidden for any part of (or all of) the wait:
 *  - Never calls `img.decode()` while `document.hidden` - waits for
 *    `visibilitychange` first (reporting the wait via `onWaiting`, once
 *    per hidden spell) so the caller can show an honest loading status.
 *  - A decode already in flight when the page goes hidden AGAIN can also
 *    stall forever (same underlying Chrome behaviour), so the attempt is
 *    raced against the next hide and, if lost, abandoned and retried with
 *    a fresh `<img>` once visible again. This recovers from any number of
 *    visibility flips without hanging and without needing player input.
 *  - If the page never becomes visible again, this simply never resolves
 *    (matching "the loading screen waits for you") - it does not throw,
 *    retry-storm, or otherwise misbehave; the one `visibilitychange`
 *    listener it's parked on is inert until the page unloads.
 * Returns the time (ms) spent waiting on visibility, so callers can log
 * decode-vs-wait time separately.
 */
async function decodeWhenVisible(url, onWaiting) {
  let waitMs = 0;
  for (;;) {
    if (document.hidden) {
      const waitStart = performance.now();
      onWaiting?.();
      await onceVisible();
      waitMs += performance.now() - waitStart;
    }
    const img = new Image();
    img.src = url;
    const hidden = onceHidden();
    const outcome = await Promise.race([
      img.decode().then(
        () => 'decoded',
        () => 'decode-error'
      ),
      hidden.promise.then(() => 'hidden-again'),
    ]);
    hidden.cancel();
    if (outcome === 'decoded') return { waitMs };
    if (outcome === 'decode-error') {
      // A real decode failure (corrupt blob, etc.) - not a visibility
      // problem, so surface it instead of retrying forever.
      throw new Error(`image decode failed for ${url}`);
    }
    // outcome === 'hidden-again': the page hid before this decode()
    // settled; loop back around (which re-waits for visibility) and retry
    // with a fresh <img>.
  }
}

/**
 * Compress a canvas to a Blob, wrap it in an object URL, and decode it once
 * so later <img> elements reusing this URL never cause a visible decode
 * delay. Returns just the URL - the canvas is the caller's to release.
 * `onWaiting` is called (possibly more than once, across visibility flips)
 * whenever this has to pause for the page to become visible; `timing`, if
 * given, accumulates `{decodeMs, waitMs}` for ?debug logging.
 */
async function canvasToDecodedUrl(canvas, onWaiting, timing) {
  const mime = preferredImageMime();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, mime, 0.88));
  const url = URL.createObjectURL(blob);
  const t0 = performance.now();
  const { waitMs } = await decodeWhenVisible(url, onWaiting);
  if (timing) {
    timing.waitMs += waitMs;
    timing.decodeMs += performance.now() - t0 - waitMs;
  }
  return url;
}

async function yieldToEventLoop() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function loadProceduralStory(params) {
  const { seed, numPhrases, regionCounts, lowEnd, stylePrefs, forceStyle, onProgress } = params;
  const budget = getBudget(lowEnd);

  const storyRng = subRng(seed, 'story');
  const story = generateStory(storyRng, numPhrases);

  // Style selection: an explicit forceStyle param wins, then ?style=<id> in
  // the URL, else a seeded weighted pick (uniform unless stylePrefs given).
  // Low-end mode drops cost-3 styles from the pool unless forced.
  const styleRng = subRng(seed, 'style');
  const forcedId = (forceStyle && getStyle(forceStyle)) ? forceStyle : urlForcedStyleId();
  const style = pickStyle(styleRng, { stylePrefs, forceStyle: forcedId, lowEnd });

  // Every style's renderScene/renderFumbled multiplies width/height by dpr
  // to get the actual device-pixel canvas size, so the LOGICAL size passed
  // in here must already be divided by dpr - otherwise the final canvas
  // exceeds maxEdge.
  const dpr = Math.min(budget.maxDpr, window.devicePixelRatio || 1);
  const width = Math.round(budget.maxEdge / dpr);
  const height = Math.round(width * 0.72);
  const layers = budget.watercolorLayers; // only watercolor.js reads this
  const renderOpts = { width, height, dpr, lowEnd, layers };

  const totalSteps = 1 + numPhrases * 2 + 2;
  let doneSteps = 0;
  async function step(label) {
    doneSteps++;
    onProgress?.(doneSteps / totalSteps, label);
    await yieldToEventLoop();
  }
  const artRng = (tag) => subRng(seed, `art:${tag}`);
  const revealRng = (tag) => subRng(seed, `reveal:${tag}`);

  // Decode timing (?debug) and the "page went hidden mid-load" status -
  // see canvasToDecodedUrl/decodeWhenVisible above. `onWaiting` reports
  // through the SAME onProgress callback main.js already renders verbatim
  // (setProgress(frac, label) just sets progressLabel.textContent), so no
  // change is needed on the main.js side for this honest status text.
  const decodeTiming = { decodeMs: 0, waitMs: 0 };
  const onWaiting = () => onProgress?.(doneSteps / totalSteps, "Paused while you're away - come back to finish loading");

  const renderStart = performance.now();

  // Cover: single-region, good-only. fumbledUrl mirrors goodUrl so every
  // panel (cover/phrase/ending) shares one shape - see js/render/stage.js.
  const coverCanvas = style.renderScene(story.cover.scene, artRng('cover'), renderOpts);
  const coverUrl = await canvasToDecodedUrl(coverCanvas, onWaiting, decodeTiming);
  releaseCanvas(coverCanvas);
  await step('cover');
  const coverPanel = {
    caption: story.cover.caption,
    regionCount: 1,
    goodUrl: coverUrl,
    fumbledUrl: coverUrl,
    bandAxis: 'x',
  };

  // One panel per phrase. Each is rendered ONCE per variant (good, fumbled)
  // - reveal "regions" are CSS mask bands over these two shared images at
  // display time (js/render/stage.js), not separate pre-sliced bitmaps.
  const panels = [];
  for (let i = 0; i < numPhrases; i++) {
    const storyPanel = story.panels[i];
    const tag = `panel${i}`;

    const goodCanvas = style.renderScene(storyPanel.scene, artRng(tag), renderOpts);
    const goodUrl = await canvasToDecodedUrl(goodCanvas, onWaiting, decodeTiming);
    releaseCanvas(goodCanvas);
    await step(`${tag}-good`);

    const fumbledCanvas = style.renderFumbled(storyPanel.scene, artRng(tag), renderOpts);
    const fumbledUrl = await canvasToDecodedUrl(fumbledCanvas, onWaiting, decodeTiming);
    releaseCanvas(fumbledCanvas);
    await step(`${tag}-fumbled`);

    const count = Math.max(1, regionCounts?.[i] ?? 1);
    const bandAxis = revealRng(tag).pick(BAND_AXES);
    panels.push({ index: i, caption: storyPanel.caption, regionCount: count, goodUrl, fumbledUrl, bandAxis });
  }

  // Endings: single-region, shown whole (goodEnding never fumbles;
  // badEnding IS the fumbled-rendered scene - that's the outcome, not a
  // per-region reveal state - so fumbledUrl mirrors goodUrl for both).
  const goodEndingCanvas = style.renderScene(story.goodEnding.scene, artRng('good-ending'), renderOpts);
  const goodEndingUrl = await canvasToDecodedUrl(goodEndingCanvas, onWaiting, decodeTiming);
  releaseCanvas(goodEndingCanvas);
  await step('good-ending');

  const badEndingCanvas = style.renderFumbled(story.badEnding.scene, artRng('bad-ending'), renderOpts);
  const badEndingUrl = await canvasToDecodedUrl(badEndingCanvas, onWaiting, decodeTiming);
  releaseCanvas(badEndingCanvas);
  await step('bad-ending');

  if (isDebug()) {
    const ms = performance.now() - renderStart;
    // eslint-disable-next-line no-console
    console.log(
      `[story] style=${style.id} (${style.name}, cost ${style.cost}) lowEnd=${!!lowEnd} ` +
      `panels=${numPhrases} totalRenderMs=${ms.toFixed(0)} avgPanelMs=${(ms / (numPhrases * 2 + 3)).toFixed(1)} ` +
      `decodeMs=${decodeTiming.decodeMs.toFixed(0)} visibilityWaitMs=${decodeTiming.waitMs.toFixed(0)}`
    );
  }

  return {
    story,
    styleId: style.id,
    coverPanel,
    panels,
    goodEndingPanel: {
      caption: story.goodEnding.caption,
      regionCount: 1,
      goodUrl: goodEndingUrl,
      fumbledUrl: goodEndingUrl,
    },
    badEndingPanel: {
      caption: story.badEnding.caption,
      regionCount: 1,
      goodUrl: badEndingUrl,
      fumbledUrl: badEndingUrl,
    },
  };
}

/**
 * @param {string} sourceType - one of SOURCE_TYPES
 * @param {{
 *   seed:(string|number), numPhrases:number, regionCounts:number[], lowEnd:boolean,
 *   stylePrefs?: Record<string,number>, forceStyle?: string
 * }} params
 *   stylePrefs and forceStyle are OPTIONAL (new in M1.5) - omit them and you
 *   get the old default behaviour (a uniformly-random seeded style pick, or
 *   whatever ?style=<id> names in the URL). Existing callers that only ever
 *   passed {seed, numPhrases, regionCounts, lowEnd} keep working unchanged.
 * @param {(fraction:number, label:string)=>void} onProgress
 */
export async function loadStory(sourceType, params, onProgress) {
  switch (sourceType) {
    case SOURCE_TYPES.PROCEDURAL:
      return loadProceduralStory({ ...params, onProgress });
    default:
      throw new Error(
        `Unknown story source "${sourceType}" - only "${SOURCE_TYPES.PROCEDURAL}" is implemented in M1.`
      );
  }
}
