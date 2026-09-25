// sw.js
// Offline support: precaches the whole site on the first visit, so after
// that every game and seed plays with no connection (music and art are
// generated in the browser - there is nothing else to fetch).
// VERSION and ASSETS are rewritten by `node tools/stamp-sw.mjs`; run it
// before every deploy (tests/sw_test.mjs fails if they are stale). A changed
// VERSION changes this file's bytes, which is what makes browsers install
// the new version on the next visit.

const VERSION = '87220dbe4bbc'; // stamp:version
const ASSETS = [
  './',
  'index.html',
  'css/game.css',
  'manifest.webmanifest',
  'icon.svg',
  'js/assets.js',
  'js/audio/cues.js',
  'js/audio/sfx.js',
  'js/audio/synth.js',
  'js/audio/voices.js',
  'js/calibration.js',
  'js/chart.js',
  'js/clock.js',
  'js/config.js',
  'js/games/bounce.js',
  'js/games/echo.js',
  'js/games/index.js',
  'js/games/pump.js',
  'js/games/ready.js',
  'js/games/remix.js',
  'js/games/swing.js',
  'js/games/triplet.js',
  'js/input.js',
  'js/main.js',
  'js/net/accountUi.js',
  'js/net/auth.js',
  'js/net/merge.js',
  'js/net/sync.js',
  'js/pause.js',
  'js/practice.js',
  'js/render/stage.js',
  'js/rng.js',
  'js/songform.js',
  'js/storage.js',
  'js/story/loader.js',
  'js/story/storygen.js',
  'js/story/styles/crayon.js',
  'js/story/styles/geom.js',
  'js/story/styles/geometric.js',
  'js/story/styles/index.js',
  'js/story/styles/ink.js',
  'js/story/styles/neon.js',
  'js/story/styles/papercut.js',
  'js/story/styles/parts.js',
  'js/story/styles/pixel.js',
  'js/story/styles/scene.js',
  'js/story/styles/watercolor.js'
]; // stamp:assets

const CACHE = 'tapestry-' + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache:'reload' skips the HTTP cache, so a stale copy is never precached
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  // Safe even mid-game: an open tab has already loaded every module it will
  // ever use (no dynamic imports), so dropping the old cache can't break it.
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('tapestry-') && k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  // Navigations ignore the query string so ?seed= / ?game= / ?debug etc.
  // all resolve to the cached index.html.
  const opts = req.mode === 'navigate' ? { ignoreSearch: true } : undefined;
  event.respondWith(
    caches.open(CACHE)
      .then((cache) => cache.match(req, opts))
      .then((hit) => hit || fetch(req))
  );
});
