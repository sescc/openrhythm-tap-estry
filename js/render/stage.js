// js/render/stage.js
// Play-screen presentation: the panel picture (masked reveal-band images),
// sticker pops, judgement text flashes, the beat pulse and cue bounce
// indicators. All pooled DOM, all tap-time animation is transform/opacity
// only (see css/game.css .stage__* rules).
//
// Reveal design: showPanel() runs ONCE per phrase boundary and pre-creates
// every region's <img> elements up front (two per region - good + fumbled -
// both pointing at the panel's two shared, already-decoded image URLs from
// js/story/loader.js). Each gets a CSS mask-image band (a soft-edged slice
// of the picture along X, Y or a diagonal) so the browser decodes/composites
// it, not us. revealRegion() at tap time is then just `style.opacity = '1'`
// on the matching pre-created element - no allocation, no canvas drawing.
// Because each region's good/fumbled images are independent DOM nodes, a
// miss only flips THAT region's own band to its fumbled image; every other
// region keeps whatever it already showed.

const STICKER_COUNT = 16;
const JUDGEMENT_POOL_SIZE = 3;
const GUIDE_POOL_SIZE = 8;

/** 'doubleChirp' -> 'Double Chirp', 'readygoSlow' -> 'Readygo Slow'. Good
 * enough for a transient first-appearance label without needing a separate
 * display-name field on every game's cueTypes entry. */
function prettifyCueId(cueId) {
  const spaced = cueId.replace(/([a-z])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// Small inline SVG stickers (star, heart, note, sparkle, drop). Colour is
// set per-pop via the --sticker-color CSS custom property.
const STICKER_SVGS = [
  '<svg viewBox="0 0 24 24"><path d="M12 2l2.9 6.9L22 9.5l-5.5 4.8L18 22l-6-3.6L6 22l1.5-7.7L2 9.5l7.1-.6z" fill="var(--sticker-color,#f2c14e)"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-10-9.2C.4 8 2 4 6 4c2 0 3.5 1 4 2.5C10.5 5 12 4 14 4c4 0 5.6 4 4 7.8-2.5 4.6-10 9.2-10 9.2z" fill="var(--sticker-color,#e17b6b)"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M9 3v12.1c-.6-.4-1.3-.6-2-.6-2 0-3.5 1.3-3.5 3s1.5 3 3.5 3 3.5-1.3 3.5-3V7h6V3z" fill="var(--sticker-color,#7a6ea8)"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M12 2l1.2 4.8L18 8l-4.8 1.2L12 14l-1.2-4.8L6 8l4.8-1.2z" fill="var(--sticker-color,#f6e27a)"/></svg>',
  '<svg viewBox="0 0 24 24"><path d="M12 2s6 7.5 6 12a6 6 0 11-12 0c0-4.5 6-12 6-12z" fill="var(--sticker-color,#5c9ee6)"/></svg>',
];

const JUDGEMENT_COLOR = { perfect: '#f2c14e', good: '#8fbf9f', avoided: '#8fbf9f', miss: '#a3a3a3' };
const JUDGEMENT_TEXT = { perfect: 'Perfect!', good: 'Good', avoided: 'Nice!', miss: 'Miss' };
const STICKER_COLOR = { perfect: '#f2c14e', good: '#5c9ee6', avoided: '#5c9ee6' };

/**
 * A soft-edged CSS mask-image gradient covering band `index` of `count`
 * along `axis` ('x' = left-to-right, 'y' = bottom-to-top, 'diag' = 135deg).
 * Neighbouring bands' feather zones overlap slightly so there's no hard
 * seam between two revealed regions; count===1 degenerates to "fully
 * visible" (used by the single-region cover/ending panels).
 */
function buildBandMask(axis, index, count) {
  const start = index / count;
  const end = (index + 1) / count;
  const feather = Math.min(0.12, (end - start) * 0.35);
  const s0 = Math.max(0, start - feather) * 100;
  const s1 = start * 100;
  const s2 = end * 100;
  const s3 = Math.min(1, end + feather) * 100;
  const stops = `transparent ${s0}%, black ${s1}%, black ${s2}%, transparent ${s3}%`;
  if (axis === 'y') return `linear-gradient(to top, ${stops})`;
  if (axis === 'diag') return `linear-gradient(135deg, ${stops})`;
  return `linear-gradient(to right, ${stops})`;
}

function makeRegionImg(url, maskCss, zIndex) {
  const img = document.createElement('img');
  img.src = url;
  img.alt = '';
  img.draggable = false;
  img.className = 'stage__region-img';
  img.style.maskImage = maskCss;
  img.style.webkitMaskImage = maskCss;
  img.style.zIndex = String(zIndex);
  return img;
}

function clearPanelDom(panelData) {
  if (!panelData) return;
  panelData._regionEls?.forEach(({ good, fumbled }) => {
    good.remove();
    fumbled.remove();
  });
  panelData._washEl?.remove();
  panelData._regionEls = null;
  panelData._washEl = null;
}

/** Object URLs are only ever shown by one panel instance in this linear
 * game, so it's always safe to free them once we've moved past that panel. */
function revokePanelUrls(panelData) {
  if (!panelData || panelData._urlsRevoked) return;
  URL.revokeObjectURL(panelData.goodUrl);
  if (panelData.fumbledUrl && panelData.fumbledUrl !== panelData.goodUrl) {
    URL.revokeObjectURL(panelData.fumbledUrl);
  }
  panelData._urlsRevoked = true;
}

/**
 * Build the play-screen stage inside `container` (an existing DOM element,
 * left empty by index.html) and return its control API.
 */
export function createStage(container) {
  container.innerHTML = '';
  container.classList.add('stage');

  const picture = document.createElement('div');
  picture.className = 'stage__picture';

  const cueIcon = document.createElement('div');
  cueIcon.className = 'stage__cue-icon';
  cueIcon.textContent = '♪'; // placeholder until the first real cue names its own glyph

  // First-appearance label ("Chirp", "Bonk"...) - fades in next to the cue
  // icon the FIRST time this session a given cueId sounds, then never again
  // for that cueId (see the `seenCueIds` set in bounceCue()).
  const cueName = document.createElement('div');
  cueName.className = 'stage__cue-name';
  const seenCueIds = new Set();

  const pulse = document.createElement('div');
  pulse.className = 'stage__pulse';

  // Mascot corner: one pre-created element, its emoji/label swapped per
  // game (and, in a remix, per section - see setMascot()). All animation is
  // transform/opacity via CSS classes, except the hold "inflate" (Balloon
  // Pump), which needs a continuous value driven every frame from the
  // active hold's progress - see tick()/holdMascotProgress().
  const mascot = document.createElement('div');
  mascot.className = 'stage__mascot';
  const mascotEmoji = document.createElement('span');
  mascotEmoji.className = 'stage__mascot-emoji';
  mascot.appendChild(mascotEmoji);

  const caption = document.createElement('div');
  caption.className = 'stage__caption';

  // cueIcon/pulse/mascot are anchored to the PICTURE's own corners (not the
  // whole .stage, which also includes the caption paragraph below it) - a
  // bottom-anchored element like the mascot would otherwise land past the
  // caption instead of the picture's bottom-right corner, especially once
  // the caption wraps to two lines on a narrow (375px) screen.
  picture.append(cueIcon, cueName, pulse, mascot);
  container.append(picture, caption);

  // Guide markers (section C): a pooled ring per UPCOMING note, assigned
  // dynamically as notes come into range and released once they pass -
  // never allocated on the tap path, only re-styled (transform/opacity).
  const guidePool = [];
  for (let i = 0; i < GUIDE_POOL_SIZE; i++) {
    const el = document.createElement('div');
    el.className = 'stage__guide';
    picture.appendChild(el);
    guidePool.push({ el, target: null });
  }
  let guidesEnabled = false;

  const judgementPool = [];
  for (let i = 0; i < JUDGEMENT_POOL_SIZE; i++) {
    const el = document.createElement('div');
    el.className = 'stage__judgement';
    picture.appendChild(el);
    judgementPool.push(el);
  }
  let judgementIdx = 0;

  const stickerPool = [];
  for (let i = 0; i < STICKER_COUNT; i++) {
    const el = document.createElement('div');
    el.className = 'stage__sticker';
    el.innerHTML = STICKER_SVGS[i % STICKER_SVGS.length];
    picture.appendChild(el);
    stickerPool.push(el);
  }
  let stickerIdx = 0;

  let activePanel = null;
  let lastBeatFloor = -1;
  let cueSweepIdx = 0;
  let currentMascotGameId = null;
  let activeHoldNote = null; // set on holdPress, cleared once its release is final
  let guideTargets = []; // [{note, isRelease}], built once per song by setGuideTargets()

  /** Called once per song (and again after a pause/resume time-shift plans
   * new notes in - though the SAME note objects are reused there, so this
   * doesn't strictly need re-calling on resume, only on a fresh song). Reads
   * note.time/.releaseTime live each frame rather than snapshotting them, so
   * it stays correct even if planPauseResume() shifts those times later. */
  function setGuideTargets(notes) {
    guideTargets = [];
    for (const n of notes) {
      if (n.fake) continue; // never telegraph a fake - that's the whole point of it
      guideTargets.push({ note: n, isRelease: false });
      if (n.kind === 'hold') guideTargets.push({ note: n, isRelease: true });
    }
    guidePool.forEach((g) => {
      g.target = null;
      g.el.style.opacity = '0';
    });
  }

  function setGuidesEnabled(on) {
    guidesEnabled = !!on;
    if (!guidesEnabled) {
      guidePool.forEach((g) => {
        g.target = null;
        g.el.style.opacity = '0';
      });
    }
  }

  /** Switch the mascot corner to `game` ({emoji,label}, or a gameId string
   * resolved via `resolveGame`). No-op if it's already showing. */
  function setMascot(game, resolveGame) {
    const g = typeof game === 'string' ? resolveGame?.(game) : game;
    if (!g || g.id === currentMascotGameId) return;
    currentMascotGameId = g.id;
    mascotEmoji.textContent = g.mascot?.emoji || '🎵';
    mascot.setAttribute('aria-label', g.mascot?.label || g.name || '');
    mascot.style.transform = ''; // reset any leftover hold-inflate scale
  }

  function mascotCuePulse() {
    mascot.classList.remove('stage__mascot--cue');
    void mascot.offsetWidth;
    mascot.classList.add('stage__mascot--cue');
  }

  function mascotJudgePulse(judgement) {
    const cls = judgement === 'miss' ? 'stage__mascot--miss' : 'stage__mascot--good';
    mascot.classList.remove('stage__mascot--good', 'stage__mascot--miss');
    void mascot.offsetWidth;
    mascot.classList.add(cls);
  }

  /** Pre-creates every region's DOM up front - the only place per-panel
   * <img> elements are created. Tap time only ever flips opacity. */
  function showPanel(panelData) {
    if (activePanel && activePanel !== panelData) {
      clearPanelDom(activePanel);
      revokePanelUrls(activePanel);
    }
    activePanel = panelData;
    caption.textContent = panelData.caption || '';

    // Faint pencil-sketch under-wash so unrevealed regions aren't blank.
    const washEl = document.createElement('img');
    washEl.src = panelData.goodUrl;
    washEl.alt = '';
    washEl.draggable = false;
    washEl.className = 'stage__wash';
    picture.appendChild(washEl);
    panelData._washEl = washEl;

    const n = Math.max(1, panelData.regionCount);
    const axis = panelData.bandAxis || 'x';
    const regionEls = [];
    for (let i = 0; i < n; i++) {
      const mask = buildBandMask(axis, i, n);
      const goodImg = makeRegionImg(panelData.goodUrl, mask, i + 1);
      const fumbledImg = makeRegionImg(panelData.fumbledUrl, mask, i + 1);
      picture.appendChild(goodImg);
      picture.appendChild(fumbledImg);
      regionEls.push({ good: goodImg, fumbled: fumbledImg, revealed: false });
    }
    panelData._regionEls = regionEls;
  }

  /** Tap-time reveal: opacity flip on an already-existing element only. */
  function revealRegion(panelData, regionIndex, variant) {
    const entry = panelData?._regionEls?.[regionIndex];
    if (!entry || entry.revealed) return;
    const el = variant === 'fumbled' ? entry.fumbled : entry.good;
    el.style.opacity = '1';
    entry.revealed = true;
  }

  /** Force-reveal any regions of this panel that never got judged (e.g. a
   * rest phrase with no taps, or the player stopped tapping mid-phrase) -
   * always as the good variant. Each region is independent now, so this
   * has to visit all of them rather than "reveal the last cumulative one". */
  function forceCompletePanel(panelData) {
    if (!panelData?._regionEls) return;
    for (let i = 0; i < panelData._regionEls.length; i++) {
      revealRegion(panelData, i, 'good');
    }
  }

  function popSticker(judgement) {
    if (!STICKER_COLOR[judgement]) return;
    const el = stickerPool[stickerIdx];
    stickerIdx = (stickerIdx + 1) % stickerPool.length;
    el.style.setProperty('--sticker-color', STICKER_COLOR[judgement]);
    el.style.left = `${15 + Math.random() * 70}%`;
    el.style.top = `${15 + Math.random() * 60}%`;
    el.classList.remove('stage__sticker--pop');
    void el.offsetWidth; // restart animation
    el.classList.add('stage__sticker--pop');
  }

  function flashJudgement(judgement) {
    const el = judgementPool[judgementIdx];
    judgementIdx = (judgementIdx + 1) % judgementPool.length;
    el.textContent = JUDGEMENT_TEXT[judgement] || '';
    el.style.color = JUDGEMENT_COLOR[judgement] || '#fff';
    el.classList.remove('stage__judgement--flash');
    void el.offsetWidth;
    el.classList.add('stage__judgement--flash');
  }

  function pulseBeat() {
    pulse.classList.remove('stage__pulse--active');
    void pulse.offsetWidth;
    pulse.classList.add('stage__pulse--active');
  }

  /** `cue` is a chart cue ({cueId, srcGame, ...}); `cueTypeInfo` is the
   * {glyph, meaning} entry from that game's own cueTypes list (looked up by
   * the caller, which has access to the games registry - stage.js doesn't
   * import js/games/* to stay a leaf module). Falls back to a generic note
   * glyph for cues with no registered type (e.g. remix's meta 'oddMeter'). */
  function bounceCue(cueId, cueTypeInfo) {
    cueIcon.textContent = cueTypeInfo?.glyph || '♪';
    cueIcon.classList.remove('stage__cue-icon--bounce');
    void cueIcon.offsetWidth;
    cueIcon.classList.add('stage__cue-icon--bounce');

    if (cueId && !seenCueIds.has(cueId)) {
      seenCueIds.add(cueId);
      cueName.textContent = prettifyCueId(cueId);
      cueName.classList.remove('stage__cue-name--show');
      void cueName.offsetWidth;
      cueName.classList.add('stage__cue-name--show');
    }
  }

  /** Guide markers: a pooled ring per upcoming note, converging over ~1 beat
   * and landing on it; holds get a second ring for their release. Assignment
   * and per-frame transform/opacity updates only - no allocation. */
  function updateGuides(nowCtx, beatDuration) {
    if (!guidesEnabled) return;
    const horizon = beatDuration * 1.05;
    const grace = 0.05;
    for (const g of guidePool) {
      if (!g.target) continue;
      const t = g.target.isRelease ? g.target.note.releaseTime : g.target.note.time;
      if (nowCtx > t + grace) {
        g.target = null;
        g.el.style.opacity = '0';
      }
    }
    for (const target of guideTargets) {
      const t = target.isRelease ? target.note.releaseTime : target.note.time;
      if (t == null || t < nowCtx || t - nowCtx > horizon) continue;
      if (guidePool.some((g) => g.target === target)) continue;
      const free = guidePool.find((g) => g.target === null);
      if (free) free.target = target;
    }
    for (const g of guidePool) {
      if (!g.target) continue;
      const t = g.target.isRelease ? g.target.note.releaseTime : g.target.note.time;
      const progress = 1 - Math.min(1, Math.max(0, (t - nowCtx) / beatDuration));
      const scale = 2.3 - 1.3 * progress; // shrinks from 2.3x down to landing at 1x
      g.el.style.opacity = String((0.2 + progress * 0.75).toFixed(3));
      g.el.style.transform = `translate(-50%, -50%) scale(${scale.toFixed(3)})`;
      g.el.classList.toggle('stage__guide--release', !!g.target.isRelease);
    }
  }

  /** Called for every judge event - both the intermediate holdPress pulse
   * (final:false, no reveal yet) and the terminal judgement (final:true,
   * which reveals the region exactly once). */
  function onJudged(evt, resolveGame) {
    const { note, judgement, phase, final = true } = evt;
    if (phase === 'holdPress') {
      activeHoldNote = judgement === 'perfect' || judgement === 'good' ? note : null;
      mascotJudgePulse(judgement);
      return;
    }
    if (note === activeHoldNote) activeHoldNote = null;
    if (note && note.srcGame) setMascot(note.srcGame, resolveGame);
    flashJudgement(judgement);
    mascotJudgePulse(judgement);
    if (judgement === 'perfect' || judgement === 'good' || judgement === 'avoided') {
      popSticker(judgement);
    }
    if (note && activePanel && note.phraseIndex === activePanel.index) {
      revealRegion(activePanel, note.regionIndex, judgement === 'miss' ? 'fumbled' : 'good');
    }
  }

  /** Call every animation frame with the current absolute chart + time.
   * `resolveGame(id)` (js/games/index.js getGame) lets a remix chart's cues
   * switch the mascot corner to whichever sub-game a cue actually belongs
   * to, right as it sounds. `resolveCueType(srcGame, cueId)` looks up that
   * cue's {glyph, meaning} for the corner icon + first-appearance label -
   * stage.js stays a leaf module (no js/games/* import) by taking it as a
   * callback instead. */
  function tick(nowCtx, chart, resolveGame, resolveCueType) {
    if (!chart) return;
    const beatsElapsed = (nowCtx - chart.startTime) / chart.beatDuration;
    const beatFloor = Math.floor(beatsElapsed);
    if (beatsElapsed >= 0 && beatFloor !== lastBeatFloor) {
      lastBeatFloor = beatFloor;
      pulseBeat();
    }
    while (cueSweepIdx < chart.cues.length && chart.cues[cueSweepIdx].time <= nowCtx) {
      const cue = chart.cues[cueSweepIdx];
      if (cue.srcGame) setMascot(cue.srcGame, resolveGame);
      bounceCue(cue.cueId, resolveCueType?.(cue.srcGame, cue.cueId));
      mascotCuePulse();
      cueSweepIdx++;
    }
    updateGuides(nowCtx, chart.beatDuration);
    // Balloon Pump-style inflate: while a hold's press has resolved but its
    // release hasn't, scale the mascot up toward its release time. Harmless
    // (near-instant 0->1) for any other game's occasional hold notes.
    if (activeHoldNote) {
      const span = activeHoldNote.releaseTime - activeHoldNote.time;
      const t = span > 0 ? Math.min(1, Math.max(0, (nowCtx - activeHoldNote.time) / span)) : 1;
      mascot.style.transform = `scale(${(1 + 0.6 * t).toFixed(3)})`;
    }
  }

  /** For a panel that will never be shown (gameplay jumped straight past
   * it - e.g. a very late/throttled frame crossed more than one phrase
   * boundary at once) - free its blob URLs without touching the DOM, since
   * no DOM was ever created for it. Safe to call even if it later somehow
   * does get shown-and-revoked normally (idempotent via _urlsRevoked). */
  function discardPanel(panelData) {
    revokePanelUrls(panelData);
  }

  /** Release whatever panel is still active (call when leaving Play). */
  function releaseAll() {
    clearPanelDom(activePanel);
    revokePanelUrls(activePanel);
    activePanel = null;
  }

  function reset() {
    releaseAll();
    lastBeatFloor = -1;
    cueSweepIdx = 0;
    activeHoldNote = null;
    currentMascotGameId = null;
    guideTargets = [];
    guidePool.forEach((g) => {
      g.target = null;
      g.el.style.opacity = '0';
    });
  }

  return {
    showPanel,
    revealRegion,
    forceCompletePanel,
    discardPanel,
    onJudged,
    tick,
    releaseAll,
    reset,
    setMascot,
    setGuideTargets,
    setGuidesEnabled,
  };
}
