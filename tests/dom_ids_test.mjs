// tests/dom_ids_test.mjs
// Regression test for the end-screen "buttons do nothing" bug: index.html
// was missing #end-seed, so showEndScreen() threw at
// `document.getElementById('end-seed').textContent = ...` BEFORE it reached
// the lines that assign the Play again / Replay / Back to menu button
// handlers - which is why those stayed null forever. No existing test
// catches this class of bug (a JS module reaching for a DOM element that
// was never added/renamed in the HTML), since none of them load index.html
// or run a real DOM. This one just checks every literal id passed to
// document.getElementById('...') anywhere in js/**/*.js exists as
// id="..." in index.html. Run directly with `node tests/dom_ids_test.mjs`,
// or via `node tests/run.mjs`.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

function listJs(dir) {
  const out = [];
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...listJs(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out;
}

const jsFiles = listJs('js');
const idPattern = /getElementById\(\s*(['"])([^'"]+)\1\s*\)/g;
const referencedIds = new Map(); // id -> Set of files referencing it

for (const file of jsFiles) {
  const text = readFileSync(join(ROOT, file), 'utf8');
  let m;
  while ((m = idPattern.exec(text))) {
    const id = m[2];
    if (!referencedIds.has(id)) referencedIds.set(id, new Set());
    referencedIds.get(id).add(file);
  }
}

const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
const htmlIdPattern = /\bid=(['"])([^'"]+)\1/g;
const htmlIds = new Set();
let hm;
while ((hm = htmlIdPattern.exec(html))) htmlIds.add(hm[2]);

for (const [id, files] of referencedIds) {
  assert(htmlIds.has(id), `getElementById('${id}') (used in ${Array.from(files).join(', ')}) has no matching id="${id}" in index.html`);
}

const ok = failures === 0;
console.log(ok ? `PASS - every getElementById id (${referencedIds.size}) exists in index.html` : `FAIL - ${failures} check(s) failed`);
if (!ok) process.exitCode = 1;
