// tests/run.mjs
// Tiny test runner: `node tests/run.mjs`. Runs every *_test.mjs in this
// directory (each is a plain ES module - importing it runs its assertions
// and its own PASS/FAIL line), aggregates the result, and exits nonzero if
// any of them failed or threw. No test framework/dependency - this project
// has none, on purpose (see README.md).

const TEST_FILES = ['calibration_test.mjs', 'judging_e2e_test.mjs', 'pause_test.mjs'];

let anyFailed = false;

for (const file of TEST_FILES) {
  console.log(`\n--- ${file} ---`);
  process.exitCode = undefined; // each test file sets this itself on failure - reset before each
  try {
    await import(`./${file}`);
  } catch (err) {
    console.log(`  FAIL: ${file} threw: ${err?.stack || err}`);
    anyFailed = true;
    continue;
  }
  if (process.exitCode) anyFailed = true;
}

process.exitCode = anyFailed ? 1 : 0;
console.log(anyFailed ? '\n=== FAIL - one or more test files failed ===' : '\n=== PASS - all test files passed ===');
