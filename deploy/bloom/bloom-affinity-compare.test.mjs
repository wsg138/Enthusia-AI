import assert from 'node:assert/strict';
import test from 'node:test';
import {compareBloomAffinity, parseCpuList} from './bloom-affinity-compare.mjs';

const topo = cpus => cpus.map(cpu => ({
  cpu, socket: '0', core: String(cpu % 16),
  siblings: (cpu % 16) + ',' + ((cpu % 16) + 16),
}));
const probe = (cpus, timeUTC = '2026-10-12T15:00:00.000Z') => ({
  timeUTC, modelStarted: false,
  processAllowedCpus: cpus, cgroupEffectiveCpus: cpus,
  cgroupConfiguredCpus: cpus, cpuQuotaPeriod: '3200000 100000',
  logicalCpuTopology: topo(Array.from({length: 32}, (_, n) => n)),
});
const compare = (smp, ai, samePhysicalHostConfirmed = true) =>
  compareBloomAffinity({smp, ai, samePhysicalHostConfirmed});

test('expand bounded CPU ranges, dedupe, reject malformed cpulists', () => {
  assert.deepEqual(parseCpuList('0-2,4,4,16-17'), [0,1,2,4,16,17]);
  for (const raw of ['', 'unavailable', '1-0', '1--3', '0-5000', '0,a', '0-', ' 0-1 ']) {
    assert.throws(() => parseCpuList(raw));
  }
});

test('fully overlapping AI and SMP permissions identified without assuming contention', () => {
  const result = compare(probe('0-31'), probe('0-31'));
  assert.equal(result.classification, 'OVERLAPPING_ALLOWED_LOGICAL_CPUS');
  assert.equal(result.sharedAllowedLogicalCpus.length, 32);
  assert.match(result.caveat, /not where the Minecraft main thread/);
});

test('distinct logical CPUs may share the same physical SMT cores', () => {
  const result = compare(probe('0-3'), probe('16-19'));
  assert.equal(result.classification, 'DISJOINT_LOGICAL_CPUS_SHARED_PHYSICAL_CORES');
  assert.deepEqual(result.sharedAllowedLogicalCpus, []);
  assert.deepEqual(result.sharedObservedPhysicalCoreKeys, ['0:0','0:1','0:2','0:3']);
});

test('distinct physical core groups still are not exclusive host reservations', () => {
  const result = compare(probe('0-1,16-17'), probe('2-3,18-19'));
  assert.equal(result.classification, 'DISJOINT_OBSERVED_CORE_SETS_NOT_RESERVED');
  assert.deepEqual(result.sharedObservedPhysicalCoreKeys, []);
});

test('process affinity narrower than cgroup is honored', () => {
  const p = probe('0-31');
  p.processAllowedCpus = '0-1';
  const result = compare(p, probe('2-3'));
  assert.deepEqual(result.smpAllowedLogicalCpus, [0,1]);
  assert.deepEqual(result.sharedAllowedLogicalCpus, []);
});

test('no same-host confirmation means inconclusive evidence', () => {
  const result = compare(probe('0-31'), probe('0-31'), false);
  assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
  assert.match(result.warnings[0], /not been independently confirmed/);
});

test('time gap over fifteen minutes means allocation may have changed', () => {
  const result = compare(probe('0-1', '2026-10-12T14:00:00.000Z'), probe('0-1'));
  assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.warnings.some(w => w.includes('15 minutes')));
});

test('missing topology must not certify physical core separation', () => {
  const game = probe('0-1');
  game.logicalCpuTopology = [{cpu:0, socket:0, core:0, siblings:'0,16'}];
  const result = compare(game, probe('2-3'));
  assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.warnings.some(w => w.includes('contradictory CPU topology')));
});

test('mismatched process and cgroup ranges must be refused', () => {
  const p = probe('0-1');
  p.processAllowedCpus = '2-3';
  assert.throws(() => compare(p, probe('4-5')));
});

test('model-started or malformed timestamp reports are rejected', () => {
  const p = probe('0-31');
  p.modelStarted = true;
  assert.throws(() => compare(p, probe('0-31')));
  p.modelStarted = false;
  p.timeUTC = 'yesterday';
  assert.throws(() => compare(p, probe('0-31')));
});

test('cross-report disagreements on same logical CPU topology are inconclusive', () => {
  const ai = probe('2-3');
  ai.logicalCpuTopology[0].core = '99';
  const result = compare(probe('0-1'), ai);
  assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.sharedObservedPhysicalCoreKeys, null);
  assert.ok(result.warnings.some(w => w.includes('contradictory CPU topology')));
});

test('a read-only host SMP report need not include AI-specific modelStarted marker', () => {
  const smp = probe('0-1');
  delete smp.modelStarted;
  const result = compare(smp, probe('2-3'));
  assert.equal(result.classification, 'DISJOINT_OBSERVED_CORE_SETS_NOT_RESERVED');
});

test('inconsistent SMT sibling membership cannot certify core isolation', () => {
  const game = probe('0-1');
  game.logicalCpuTopology[0].siblings = '0,15';
  const result = compare(game, probe('2-3'));
  assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
  assert.ok(result.warnings.some(w => w.includes('contradictory CPU topology')));
});

test('two reports with inconsistent sibling maps are inconclusive', () => {
  const ai = probe('2-3');
  ai.logicalCpuTopology[0].siblings = '0';
  ai.logicalCpuTopology[16].siblings = '16';
  const result = compare(probe('0-1'), ai);
  assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.sharedObservedPhysicalCoreKeys, null);
});

test('cross-report SMT siblings cannot claim separate physical cores using partial rows', () => {
  const smp = probe('0');
  smp.logicalCpuTopology = [{cpu: 0, socket: 0, core: 0, siblings: '0,16'}];
  const ai = probe('16');
  ai.logicalCpuTopology = [{cpu: 16, socket: 0, core: 5, siblings: '16'}];
  const result = compare(smp, ai);
  assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.sharedObservedPhysicalCoreKeys, null);
  assert.ok(result.warnings.some(w => w.includes('contradictory CPU topology')));
});

test('cross-report SMT sibling links must be reciprocated even with matching core IDs', () => {
  const smp = probe('0');
  smp.logicalCpuTopology = [{cpu: 0, socket: 0, core: 0, siblings: '0,16'}];
  const ai = probe('16');
  ai.logicalCpuTopology = [{cpu: 16, socket: 0, core: 0, siblings: '16'}];
  const result = compare(smp, ai);
  assert.equal(result.classification, 'INSUFFICIENT_EVIDENCE');
  assert.equal(result.sharedObservedPhysicalCoreKeys, null);
});

test('consistent reciprocal partial SMP/AI rows detect a shared physical SMT core', () => {
  const smp = probe('0');
  smp.logicalCpuTopology = [{cpu: 0, socket: 0, core: 0, siblings: '0,16'}];
  const ai = probe('16');
  ai.logicalCpuTopology = [{cpu: 16, socket: 0, core: 0, siblings: '0,16'}];
  const result = compare(smp, ai);
  assert.equal(result.classification, 'DISJOINT_LOGICAL_CPUS_SHARED_PHYSICAL_CORES');
  assert.deepEqual(result.sharedObservedPhysicalCoreKeys, ['0:0']);
});
