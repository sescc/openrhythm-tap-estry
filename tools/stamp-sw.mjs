// tools/stamp-sw.mjs
// Rewrites the VERSION and ASSETS lines of sw.js from the files on disk.
// Run `node tools/stamp-sw.mjs` before every deploy. This is a maintenance
// helper, not a build step: the site runs as plain files either way, it just
// won't pick up new offline caches until sw.js is re-stamped.
// tests/sw_test.mjs imports computeStamp() to check sw.js is current.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SW_PATH = join(ROOT, 'sw.js');

// Everything the game loads. tools/ and tests/ are dev-only and not cached.
const FIXED = ['index.html', 'css/game.css', 'manifest.webmanifest', 'icon.svg'];

function listJs(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listJs(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

export function computeStamp() {
  const files = [...FIXED, ...listJs('js').sort()];
  const hash = createHash('sha256');
  for (const f of files) {
    // Normalise CRLF so a Windows checkout and the deployed copy hash the same.
    const text = readFileSync(join(ROOT, f), 'utf8').replace(/\r\n/g, '\n');
    hash.update(f + '\0' + text + '\0');
  }
  return { version: hash.digest('hex').slice(0, 12), assets: ['./', ...files] };
}

export function readStamp(src = readFileSync(SW_PATH, 'utf8')) {
  const version = src.match(/^const VERSION = '([^']*)'; \/\/ stamp:version$/m)?.[1];
  const assetsJson = src.match(/^const ASSETS = (\[[\s\S]*?\]); \/\/ stamp:assets$/m)?.[1];
  return { version, assets: assetsJson ? JSON.parse(assetsJson.replace(/'/g, '"')) : undefined };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { version, assets } = computeStamp();
  const list = '[\n' + assets.map((a) => `  '${a}',`).join('\n').replace(/,$/, '') + '\n]';
  let src = readFileSync(SW_PATH, 'utf8');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  src = src
    .replace(/^const VERSION = '[^']*'; \/\/ stamp:version$/m, `const VERSION = '${version}'; // stamp:version`)
    .replace(/^const ASSETS = \[[\s\S]*?\]; \/\/ stamp:assets$/m, `const ASSETS = ${list.replace(/\n/g, eol)}; // stamp:assets`);
  writeFileSync(SW_PATH, src);
  console.log(`sw.js stamped: VERSION=${version}, ${assets.length} assets`);
}
