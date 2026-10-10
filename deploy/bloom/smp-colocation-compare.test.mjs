import assert from 'node:assert/strict';
import test from 'node:test';
import { compareSmpColocation } from './smp-colocation-compare.mjs';

const sha = 'a'.repeat(64);
const at = (minutes) => new Date(Date.UTC(2026, 9, 10, 0, minutes)).toISOString();
function window(phase, minute, patch = {}) {
  const busy = phase === 'inference';
  return {
    phase, startUtc: at(minute), endUtc: at(minute + 1),
    loreItemsSha256: sha, smpBuild: 'Paper 26.2', activityLabel: 'matched-survival',
    players: 14, loadedChunks: 3000, tps: busy ? 16.8 : 19.98,
    msptP50: busy ? 40 : 15, msptP95: busy ? 75 : 32,
    msptP99: busy ? 120 : 60, ...patch,
  };
}
function scenario() {
  return {
    schemaVersion: 1, workload: {startUtc: at(4), endUtc: at(6), threads: 4},
    windows: [
      window('off', 0), window('off', 1),
      window('idle', 2), window('idle', 3),
      window('inference', 4), window('inference', 5),
      window('recovery', 6),
    ],
  };
}
test('reports correlated regression without claiming AI causality', () => {
  const result = compareSmpColocation(scenario());
  assert.equal(result.assessment, 'OBSERVED_REGRESSION_WITH_CONFOUNDERS');
  assert.equal(result.differences.meanTps, -3.18);
  assert.equal(result.differences.medianWindowP95Ms, 43);
  assert.match(result.caveat, /NOT pooled tick percentiles/);
});
test('only complete and matched conditions produce a no-clear-regression assessment', () => {
  const data = scenario();
  data.windows.filter((w) => w.phase === 'inference').forEach((w) => {
    w.tps = 19.95; w.msptP50 = 16; w.msptP95 = 34; w.msptP99 = 65;
  });
  assert.equal(compareSmpColocation(data).assessment, 'NO_CLEAR_REGRESSION_IN_MATCHED_WINDOWS');
});
test('missing p95 does not silently pass a benign-looking test', () => {
  const data = scenario();
  data.windows.filter((w) => w.phase === 'inference').forEach((w) => {
    w.tps = 19.95; w.msptP50 = 16; delete w.msptP95; delete w.msptP99;
  });
  const result = compareSmpColocation(data);
  assert.equal(result.assessment, 'INCONCLUSIVE');
  assert.ok(result.warnings.some((w) => w.includes('p95 MSPT')));
});
test('version mismatch prevents clearance', () => {
  const data = scenario();
  data.windows[4].loreItemsSha256 = 'b'.repeat(64);
  assert.equal(compareSmpColocation(data).assessment, 'INCONCLUSIVE');
});
test('inference timestamps require actual overlap with Spark windows', () => {
  const data = scenario();
  data.workload.startUtc = at(7); data.workload.endUtc = at(9);
  assert.equal(compareSmpColocation(data).assessment, 'INCONCLUSIVE');
});
test('different SMP activity or player demand prevents clearance', () => {
  const data = scenario();
  data.windows[4].activityLabel = 'rapid-exploration';
  data.windows[5].players = 24;
  data.windows.filter((w) => w.phase === 'inference').forEach((w) => {
    w.tps = 19.99; w.msptP50 = 15; w.msptP95 = 32;
  });
  const result = compareSmpColocation(data);
  assert.equal(result.assessment, 'INCONCLUSIVE');
  assert.ok(result.warnings.some((w) => w.includes('Player counts')));
});
test('rejects malformed inputs instead of deriving a misleading comparison', () => {
  const invalidCases = [
    (d) => { d.windows[3].startUtc = at(1); },
    (d) => { d.windows[0].startUtc = 'tomorrow'; },
    (d) => { d.windows[0].loreItemsSha256 = 'not-a-sha'; },
    (d) => { d.windows[0].msptP95 = 4; },
    (d) => { d.workload.endUtc = d.workload.startUtc; },
  ];
  for (const mutate of invalidCases) {
    const data = scenario(); mutate(data);
    assert.throws(() => compareSmpColocation(data));
  }
});
test('no idle/recovery windows remain explicit gaps', () => {
  const data = scenario();
  data.windows = data.windows.filter((w) => ['off', 'inference'].includes(w.phase));
  const result = compareSmpColocation(data);
  assert.equal(result.assessment, 'OBSERVED_REGRESSION_WITH_CONFOUNDERS');
  assert.equal(result.warnings.length, 2);
});
