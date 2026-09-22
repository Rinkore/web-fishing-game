'use strict';

const fs = require('node:fs');
const file = process.argv[2];
if (!file) throw new Error('Usage: node summarize-go-tests.js <go-test.jsonl>');
const report = { packages: { pass: 0, fail: 0, skip: 0 }, tests: { pass: 0, fail: 0, skip: 0 }, skipped: [], skipDetails: [], failures: [], incompletePackages: [], incompleteTests: [], malformedLines: [], databaseEnvironmentMissing: false };
const packages = new Map();
const tests = new Map();
const terminal = new Set(['pass', 'fail', 'skip']);
let events = 0;
let lineNumber = 0;
for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
  lineNumber++;
  const line = raw.replace(/^\uFEFF/, '');
  if (!line.trim()) continue;
  if (line.includes('requires isolated PostgreSQL via FISHING_GO_TEST_DATABASE_URL')) report.databaseEnvironmentMissing = true;
  let event;
  try { event = JSON.parse(line); } catch {
    // Compiler diagnostics may be plain text; a truncated JSON event is not a completed run.
    if (line.trimStart().startsWith('{')) report.malformedLines.push(lineNumber);
    continue;
  }
  if (!event || !event.Action) continue;
  events++;
  if (event.Action === 'build-fail') report.failures.push(event.ImportPath || event.Package || 'build');
  if (!event.Package) {
    if (['start', 'run', ...terminal].includes(event.Action)) report.malformedLines.push(lineNumber);
    continue;
  }
  if (!packages.has(event.Package)) packages.set(event.Package, { started: false, terminal: null });
  const pkg = packages.get(event.Package);
  if (event.Action === 'start') pkg.started = true;
  const key = `${event.Package}${event.Test ? '/' + event.Test : ''}`;
  let state = pkg;
  if (event.Test) {
    if (!tests.has(key)) tests.set(key, { terminal: null, output: [] });
    state = tests.get(key);
    if (event.Output) {
      state.output.push(event.Output.trimEnd());
      if (state.output.length > 12) state.output.shift();
    }
  }
  if (terminal.has(event.Action)) {
    if (state.terminal) report.malformedLines.push(lineNumber);
    state.terminal = event.Action;
    report[event.Test ? 'tests' : 'packages'][event.Action]++;
    if (event.Action === 'skip' && event.Test) {
      report.skipped.push(key);
      report.skipDetails.push({ test: key, output: state.output });
    }
    if (event.Action === 'fail') report.failures.push(key);
  }
}
for (const [name, state] of packages) {
  if (!state.started || !state.terminal) report.incompletePackages.push(name);
}
for (const [name, state] of tests) {
  if (!state.terminal) report.incompleteTests.push(name);
}
report.events = events;
report.completed = events > 0 && packages.size > 0 && report.incompletePackages.length === 0 && report.incompleteTests.length === 0 && report.malformedLines.length === 0;
report.passed = report.completed && report.packages.fail === 0 && report.tests.fail === 0 && report.failures.length === 0 && !report.databaseEnvironmentMissing;
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
