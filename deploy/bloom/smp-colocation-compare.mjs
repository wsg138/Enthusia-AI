/**
 * Offline Spark-window comparison for the Enthusia AI / SMP co-location study.
 * Requires owner-reviewed, normalized UTC windows. Never contacts Bloom or SMP.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const phases = new Set(['off', 'idle', 'inference', 'recovery']);
const sha256 = /^[a-f0-9]{64}$/;
const number = (value, name, min, max) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(name + ' must be finite and within its expected range');
  }
  return value;
};
const timestamp = (value, name) => {
  if (typeof value !== 'string' ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(value)) {
    throw new Error(name + ' must be an ISO UTC timestamp ending in Z');
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== value.slice(0, 19)) {
    throw new Error(name + ' must be an actual UTC instant');
  }
  return ms;
};
const midpoint = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const rounded = (n) => n === null ? null : Math.round(n * 1000) / 1000;
const overlap = (a, b, c, d) => Math.max(0, Math.min(b, d) - Math.max(a, c));
const summarize = (rows) => {
  if (!rows.length) return null;
  const average = (field) => rows.reduce((sum, row) => sum + row[field], 0) / rows.length;
  const quantile = (field) => rows.some((row) => row[field] == null)
    ? null : rounded(midpoint(rows.map((row) => row[field])));
  return {
    windows: rows.length,
    meanTps: rounded(average('tps')),
    medianWindowP50Ms: quantile('msptP50'),
    medianWindowP95Ms: quantile('msptP95'),
    medianWindowP99Ms: quantile('msptP99'),
    meanPlayers: rounded(average('players')),
    meanLoadedChunks: rounded(average('loadedChunks')),
  };
};

export function compareSmpColocation(input) {
  if (!input || input.schemaVersion !== 1 || !Array.isArray(input.windows) ||
      input.windows.length < 2 || input.windows.length > 100) {
    throw new Error('Expected schemaVersion 1 and 2-100 Spark windows');
  }
  if (!input.workload || typeof input.workload !== 'object') {
    throw new Error('Actual AI inference UTC workload timestamps required');
  }
  const loadFrom = timestamp(input.workload.startUtc, 'workload.startUtc');
  const loadTo = timestamp(input.workload.endUtc, 'workload.endUtc');
  if (loadTo <= loadFrom) throw new Error('AI inference workload end must follow start');
  if (!Number.isInteger(input.workload.threads)) throw new Error('Inference thread count must be integer');
  number(input.workload.threads, 'inference threads', 1, 64);

  const windows = input.windows.map((row, index) => {
    const label = 'windows[' + index + ']';
    if (!row || !phases.has(row.phase)) throw new Error(label + '.phase invalid');
    const start = timestamp(row.startUtc, label + '.startUtc');
    const end = timestamp(row.endUtc, label + '.endUtc');
    if (end - start < 45000 || end - start > 180000) throw new Error(label + ' duration outside 45-180s');
    if (!sha256.test(row.loreItemsSha256 || '') || !row.smpBuild || !row.activityLabel) {
      throw new Error(label + ' requires LoreItems SHA-256, SMP build and activityLabel');
    }
    number(row.players, label + '.players', 0, 10000);
    number(row.loadedChunks, label + '.loadedChunks', 0, 1000000);
    number(row.tps, label + '.tps', 0, 20.1);
    number(row.msptP50, label + '.msptP50', 0, 60000);
    if (row.msptP95 != null) number(row.msptP95, label + '.msptP95', row.msptP50, 60000);
    if (row.msptP99 != null) number(row.msptP99, label + '.msptP99', row.msptP95 ?? row.msptP50, 60000);
    return { ...row, start, end, overlap: overlap(start, end, loadFrom, loadTo) / (end - start) };
  });
  const chronological = [...windows].sort((a, b) => a.start - b.start);
  for (let i = 1; i < chronological.length; i++) {
    if (chronological[i].start < chronological[i - 1].end) {
      throw new Error('Spark windows overlap; duplicate intervals are invalid');
    }
  }

  const group = (phase) => windows.filter((row) => row.phase === phase);
  const baseline = group('off');
  const inference = group('inference');
  const idle = group('idle');
  const recovery = group('recovery');
  const off = summarize(baseline);
  const on = summarize(inference);
  const warnings = [];
  if (baseline.length < 2 || inference.length < 2) warnings.push('Need two OFF and two INFERENCE windows');
  if ([...baseline, ...idle, ...recovery].some((row) => row.overlap > 0)) {
    warnings.push('An OFF/IDLE/RECOVERY window overlaps inference');
  }
  if (inference.some((row) => row.overlap < 0.8)) {
    warnings.push('An INFERENCE window has less than 80% verified AI workload overlap');
  }
  if (off && on) {
    if (new Set([...baseline, ...inference].map((row) =>
      row.loreItemsSha256 + '/' + row.smpBuild)).size !== 1) {
      warnings.push('Different LoreItems JAR SHA or SMP build between OFF and INFERENCE');
    }
    if (new Set([...baseline, ...inference].map((row) => row.activityLabel)).size !== 1) {
      warnings.push('SMP activity labels differ; player workload may be confounded');
    }
    if (Math.abs(off.meanPlayers - on.meanPlayers) > Math.max(1, off.meanPlayers * 0.1)) {
      warnings.push('Player counts differ by more than one player or 10%');
    }
    if (Math.abs(off.meanLoadedChunks - on.meanLoadedChunks) >
        Math.max(100, off.meanLoadedChunks * 0.25)) {
      warnings.push('Loaded chunk counts differ by more than 100 or 25%');
    }
    if (off.medianWindowP95Ms === null || on.medianWindowP95Ms === null) {
      warnings.push('p95 MSPT unavailable; cannot clear all metrics');
    }
  }
  if (!idle.length) warnings.push('Missing AI-loaded/idle window');
  if (!recovery.length) warnings.push('Missing recovery window');
  const differences = off && on ? {
    meanTps: rounded(on.meanTps - off.meanTps),
    medianWindowP50Ms: rounded(on.medianWindowP50Ms - off.medianWindowP50Ms),
    medianWindowP95Ms: on.medianWindowP95Ms == null || off.medianWindowP95Ms == null
      ? null : rounded(on.medianWindowP95Ms - off.medianWindowP95Ms),
  } : null;
  const disqualifying = warnings.filter((w) =>
    w !== 'Missing AI-loaded/idle window' && w !== 'Missing recovery window');
  let assessment = 'INCONCLUSIVE';
  if (differences && baseline.length >= 2 && inference.length >= 2 &&
      !warnings.some((w) => w.includes('overlaps inference') ||
        w.includes('80% verified') || w.includes('Different LoreItems'))) {
    if (differences.meanTps < -0.5 || differences.medianWindowP50Ms > 10 ||
        (differences.medianWindowP95Ms != null && differences.medianWindowP95Ms > 10)) {
      assessment = 'OBSERVED_REGRESSION_WITH_CONFOUNDERS';
    } else if (!disqualifying.length) {
      assessment = 'NO_CLEAR_REGRESSION_IN_MATCHED_WINDOWS';
    }
  }
  return {
    assessment,
    baseline: off,
    inference: on,
    idle: summarize(idle),
    recovery: summarize(recovery),
    differences,
    inferenceWorkloadUtc: {
      start: new Date(loadFrom).toISOString(),
      end: new Date(loadTo).toISOString(),
    },
    warnings,
    caveat: 'These are medians of window percentiles, NOT pooled tick percentiles. Spark does not sample the AI container. Correlation is not CPU attribution and this is never a production-safety certification.',
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length !== 3) {
    console.error('Usage: node smp-colocation-compare.mjs <normalized-spark-windows.json>');
    process.exitCode = 2;
  } else {
    try {
      console.log(JSON.stringify(compareSmpColocation(
        JSON.parse(readFileSync(process.argv[2], 'utf8'))), null, 2));
    } catch (error) {
      console.error('Comparison refused: ' + (error instanceof Error ? error.message : 'invalid input'));
      process.exitCode = 2;
    }
  }
}
