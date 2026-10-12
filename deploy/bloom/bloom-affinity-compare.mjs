/**
 * Offline comparison of two saved Bloom CPU-affinity reports.
 * No host access, subprocesses, network requests, or resource changes.
 */
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const MAX_CPU = 4095;
const MAX_CPUS = 4096;
const MAX_SKEW_MS = 15 * 60 * 1000;

/** Expand a bounded Linux cpulist without unbounded allocations. */
export function parseCpuList(raw, label = 'cpulist') {
  if (typeof raw !== 'string' || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(raw)) {
    throw new Error(label + ' must be a Linux cpulist (e.g. 0-3,8)');
  }
  const cpus = new Set();
  for (const span of raw.split(',')) {
    const [loRaw, hiRaw = loRaw] = span.split('-');
    const lo = Number(loRaw);
    const hi = Number(hiRaw);
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) ||
        lo < 0 || hi < lo || hi > MAX_CPU || hi - lo >= MAX_CPUS) {
      throw new Error(label + ' contains an invalid or excessive CPU range');
    }
    for (let n = lo; n <= hi; n++) cpus.add(n);
    if (cpus.size > MAX_CPUS) throw new Error(label + ' exceeds CPU limit');
  }
  if (!cpus.size) throw new Error(label + ' is empty');
  return [...cpus].sort((a, b) => a - b);
}

function timestamp(raw, label) {
  if (typeof raw !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(raw)) {
    throw new Error(label + ' must be a UTC ISO timestamp');
  }
  const value = Date.parse(raw);
  if (!Number.isFinite(value) || new Date(value).toISOString().slice(0, 19) !== raw.slice(0, 19)) {
    throw new Error(label + ' is not a valid UTC timestamp');
  }
  return value;
}

const intersection = (left, right) => {
  const allowed = new Set(right);
  return left.filter(cpu => allowed.has(cpu));
};

/** Validate a saved report and intersect process/cgroup allowed CPU sets. */
export function inspectReport(report, label) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error(label + ' must be a probe JSON object');
  }
  if (report.modelStarted === true || (label === 'ai' && report.modelStarted !== false)) {
    throw new Error(label + ' must describe a no-inference diagnostic');
  }
  const at = timestamp(report.timeUTC, label + '.timeUTC');
  const process = parseCpuList(report.processAllowedCpus, label + '.processAllowedCpus');
  const cgroup = parseCpuList(report.cgroupEffectiveCpus, label + '.cgroupEffectiveCpus');
  const permitted = intersection(process, cgroup);
  if (!permitted.length) throw new Error(label + ' process and cgroup CPU sets disagree');

  const topology = new Map();
  const siblingsByCpu = new Map();
  let invalidOrMissingTopology = false;
  if (!Array.isArray(report.logicalCpuTopology) ||
      report.logicalCpuTopology.length > MAX_CPUS) invalidOrMissingTopology = true;
  for (const row of Array.isArray(report.logicalCpuTopology) ? report.logicalCpuTopology : []) {
    if (!row || !Number.isSafeInteger(row.cpu) || row.cpu < 0 || row.cpu > MAX_CPU ||
        !/^\d+$/.test(String(row.socket)) || !/^\d+$/.test(String(row.core))) {
      invalidOrMissingTopology = true;
      continue;
    }
    const key = String(row.socket) + ':' + String(row.core);
    if (topology.has(row.cpu) && topology.get(row.cpu) !== key) invalidOrMissingTopology = true;
    topology.set(row.cpu, key);
    try {
      if (typeof row.siblings !== 'string') {
        invalidOrMissingTopology = true;
      } else {
        const siblings = parseCpuList(row.siblings, label + '.siblings');
        siblingsByCpu.set(row.cpu, siblings);
        if (!siblings.includes(row.cpu)) invalidOrMissingTopology = true;
      }
    } catch { invalidOrMissingTopology = true; }
  }
  for (const [cpu, siblings] of siblingsByCpu) {
    for (const sibling of siblings) {
      // For visible SMT siblings, both topology and reciprocal membership
      // must agree before claiming full physical core separation.
      if (topology.has(sibling) && topology.get(sibling) !== topology.get(cpu)) {
        invalidOrMissingTopology = true;
      }
      if (siblingsByCpu.has(sibling) && !siblingsByCpu.get(sibling).includes(cpu)) {
        invalidOrMissingTopology = true;
      }
    }
  }
  if (permitted.some(cpu => !topology.has(cpu))) invalidOrMissingTopology = true;

  return {
    at, permitted, logicalCpuCount: permitted.length, topology, siblingsByCpu,
    topologyComplete: !invalidOrMissingTopology,
    configuredCpuSet: report.cgroupConfiguredCpus ?? null,
    cpuQuotaPeriod: report.cpuQuotaPeriod ?? null,
  };
}

/**
 * Compares permissions, not observed CPU scheduling or actual physical reservations.
 * The host-identity flag is an operator assertion, not independently verified.
 */
export function compareBloomAffinity({smp, ai, samePhysicalHostConfirmed = false}) {
  if (typeof samePhysicalHostConfirmed !== 'boolean') {
    throw new Error('samePhysicalHostConfirmed must be boolean');
  }
  const game = inspectReport(smp, 'smp');
  const model = inspectReport(ai, 'ai');
  const sharedLogicalCpus = intersection(game.permitted, model.permitted);
  const topologyDisagrees = [...game.topology].some(([cpu, core]) =>
    model.topology.has(cpu) && model.topology.get(cpu) !== core);
  const siblingsDisagree = [...game.siblingsByCpu].some(([cpu, siblings]) =>
    model.siblingsByCpu.has(cpu) &&
    siblings.join(',') !== model.siblingsByCpu.get(cpu).join(','));
  const coreIds = r => new Set(r.permitted.map(cpu => r.topology.get(cpu)).filter(Boolean));
  const smpCores = coreIds(game);
  const aiCores = coreIds(model);
  const sharedPhysicalCoreKeys = [...smpCores].filter(key => aiCores.has(key)).sort();
  const secondsBetweenReports = Math.round(Math.abs(game.at - model.at) / 1000);
  const warnings = [];

  if (!samePhysicalHostConfirmed) {
    warnings.push('Same physical host has not been independently confirmed; equal CPU numbers are not proof of overlap');
  }
  if (Math.abs(game.at - model.at) > MAX_SKEW_MS) {
    warnings.push('Probe timestamps differ by more than 15 minutes; may represent different host allocation states');
  }
  if (!game.topologyComplete || !model.topologyComplete ||
      topologyDisagrees || siblingsDisagree) {
    warnings.push('Incomplete, inconsistent or contradictory CPU topology; SMT/physical core separation cannot be established');
  }

  let classification = 'INSUFFICIENT_EVIDENCE';
  if (!warnings.length) {
    if (sharedLogicalCpus.length) classification = 'OVERLAPPING_ALLOWED_LOGICAL_CPUS';
    else if (sharedPhysicalCoreKeys.length) classification = 'DISJOINT_LOGICAL_CPUS_SHARED_PHYSICAL_CORES';
    else classification = 'DISJOINT_OBSERVED_CORE_SETS_NOT_RESERVED';
  }
  return {
    classification, samePhysicalHostConfirmed,
    smpAllowedLogicalCpus: game.permitted,
    aiAllowedLogicalCpus: model.permitted,
    sharedAllowedLogicalCpus: sharedLogicalCpus,
    sharedObservedPhysicalCoreKeys: game.topologyComplete && model.topologyComplete &&
        !topologyDisagrees && !siblingsDisagree
      ? sharedPhysicalCoreKeys : null,
    secondsBetweenReports,
    warnings,
    caveat: 'This offline report compares permissions, not where the Minecraft main thread or llama.cpp actually ran. It does not measure scheduler waiting, cache contention, or memory bandwidth, and cannot prove reserved/exclusive cores or safe co-location.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 5 || process.argv[4] !== '--same-host-confirmed') {
    console.error('Usage: node bloom-affinity-compare.mjs <smp-probe.json> <ai-probe.json> --same-host-confirmed');
    process.exitCode = 2;
  } else {
    try {
      const smp = JSON.parse(readFileSync(process.argv[2], 'utf8'));
      const ai = JSON.parse(readFileSync(process.argv[3], 'utf8'));
      console.log(JSON.stringify(compareBloomAffinity({smp, ai, samePhysicalHostConfirmed: true}), null, 2));
    } catch (e) {
      console.error('Cannot compare Bloom CPU allocation: ' + (e instanceof Error ? e.message : 'invalid report'));
      process.exitCode = 2;
    }
  }
}
