// js/assets.js
// Shared "zero-delay pictures" budget helpers: sizing caps and canvas
// release bookkeeping so the loading screen keeps decoded memory modest.
//
// In M1 (procedural art only) this is a small set of pure helpers used by
// js/story/loader.js and js/story/watercolor.js. In M2/M3 this file grows
// into the real preload+decode pool (sliding window over uploaded/curated
// bitmaps, hard byte cap) described in the architecture doc - the budget
// numbers below are already sized for that.

/** Is this device considered low-end (auto-detected, or forced via ?lowend)? */
export function detectLowEnd(forceParam) {
  if (forceParam) return true;
  const mem = navigator.deviceMemory; // not supported in all browsers
  const cores = navigator.hardwareConcurrency;
  if (typeof mem === 'number' && mem <= 2) return true;
  if (typeof cores === 'number' && cores <= 4) return true;
  return false;
}

/** Longest-edge / DPR / audio-sample-rate / watercolour-layer budget. */
export function getBudget(lowEnd) {
  return {
    maxEdge: lowEnd ? 720 : 1280,
    maxDpr: 2,
    audioSampleRate: lowEnd ? 22050 : 44100,
    watercolorLayers: lowEnd ? 2 : 4,
    maxTotalBytesEstimate: lowEnd ? 60 * 1024 * 1024 : 150 * 1024 * 1024,
  };
}

/** Rough RGBA byte estimate for a canvas, for the soft memory budget. */
export function estimateCanvasBytes(canvas) {
  return canvas.width * canvas.height * 4;
}

/**
 * Release a canvas's backing store as soon as it's no longer needed (e.g.
 * once a panel's reveal-region canvases have been sliced from it). Setting
 * width/height to 0 drops the pixel buffer immediately rather than waiting
 * on GC.
 */
export function releaseCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 0;
  canvas.height = 0;
}
