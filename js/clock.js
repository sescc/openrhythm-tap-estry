// js/clock.js
// AudioContext wrapper - the ONLY clock the game uses for timing. Never use
// Date.now() or a bare rAF timestamp for judging; rAF is only for *reading*
// ctx.currentTime once per frame to drive visuals.

let ctx = null;

/** Lazily create (but do not resume) the shared AudioContext. */
export function getContext() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
  }
  return ctx;
}

/** Must be called from a user gesture handler (e.g. a button click). */
export async function resumeContext() {
  const c = getContext();
  if (c.state === 'suspended') {
    await c.resume();
  }
  return c;
}

/** Current audio-clock time in seconds. */
export function now() {
  return getContext().currentTime;
}

/**
 * Convert a DOM event's timeStamp (performance.now()-domain milliseconds)
 * into AudioContext time (seconds), compensating for output latency.
 *
 * Deliberately does NOT subtract the user calibration offset - calibration
 * is *measured* using this same function (raw tap time minus click time), so
 * baking the offset in here would make a second calibration run measure
 * against an already-corrected clock and the error would compound. Callers
 * that need a calibrated tap time (js/input.js) subtract the stored offset
 * themselves, once, at the judging site.
 */
export function eventToContextTime(eventTimeStamp) {
  const c = getContext();
  let contextTimeAtEvent;

  if (typeof c.getOutputTimestamp === 'function') {
    const out = c.getOutputTimestamp();
    if (out && typeof out.contextTime === 'number' && typeof out.performanceTime === 'number') {
      // Both fields describe the same real-world instant: the sample that is
      // hitting the speaker right now. contextTime is in the AudioContext's
      // clock (seconds); performanceTime is in performance.now()'s clock
      // (milliseconds). The difference is the drift between the two clocks,
      // recomputed fresh every call since it changes slowly over time.
      const driftSec = out.contextTime - out.performanceTime / 1000;
      contextTimeAtEvent = eventTimeStamp / 1000 + driftSec;
    }
  }

  if (contextTimeAtEvent !== undefined) {
    // getOutputTimestamp already describes what is audible, so output
    // latency is baked in - subtracting it again would double-count it.
    return contextTimeAtEvent;
  }

  // Fallback for browsers without getOutputTimestamp: currentTime is the
  // sample being *scheduled* now, which reaches the speaker `latency` later.
  const latency = (typeof c.outputLatency === 'number' ? c.outputLatency : undefined) ?? c.baseLatency ?? 0;
  return c.currentTime - latency;
}

/** True once the AudioContext exists and is running. */
export function isRunning() {
  return !!ctx && ctx.state === 'running';
}
