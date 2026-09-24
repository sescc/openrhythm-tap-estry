// tests/sw_test.mjs
// Regression test for the service-worker precache stamp (offline support):
// tools/stamp-sw.mjs writes sw.js's VERSION/ASSETS from the files actually on
// disk, and this test checks sw.js hasn't drifted from that - a stale stamp
// would mean the service worker precaches the wrong files, or never installs
// a new version at all. Run directly with `node tests/sw_test.mjs`, or via
// `node tests/run.mjs`.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { computeStamp, readStamp, ROOT } from '../tools/stamp-sw.mjs';

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

function arraysEqual(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);
}

const stamped = readStamp();
const current = computeStamp();

assert(stamped.version !== 'unstamped', "sw.js VERSION is 'unstamped' - run `node tools/stamp-sw.mjs`");
assert(
  stamped.version === current.version,
  `sw.js VERSION (${stamped.version}) doesn't match the files on disk (${current.version}) - run \`node tools/stamp-sw.mjs\``
);
assert(
  arraysEqual(stamped.assets, current.assets),
  "sw.js ASSETS doesn't match the files on disk - run `node tools/stamp-sw.mjs`"
);

for (const asset of current.assets) {
  if (asset === './') continue;
  assert(existsSync(join(ROOT, asset)), `asset '${asset}' does not exist on disk`);
  assert(!asset.startsWith('tools/'), `asset '${asset}' is under tools/ (dev-only, must not be precached)`);
  assert(!asset.startsWith('tests/'), `asset '${asset}' is under tests/ (dev-only, must not be precached)`);
}
assert(!current.assets.includes('sw.js'), 'sw.js should not precache itself');

const ok = failures === 0;
console.log(ok ? `PASS - sw.js stamp matches disk (${current.assets.length} assets)` : `FAIL - ${failures} check(s) failed`);
if (!ok) process.exitCode = 1;
