/**
 * @enthusia/training-evaluation — evaluation CLI.
 *
 * Runs the seed golden dataset against a built-in mock system and writes a
 * machine-readable JSON report. No real model is evaluated — this proves the
 * harness, the dataset, and the report pipeline end to end.
 *
 * Usage:
 *   node ./dist/cli.js [--system ideal|stale|leaking|silent|over|naive] [--out report.json]
 */
import { writeFile } from 'node:fs/promises';
import { evaluate } from './evaluate.js';
import { SEED_GOLDEN_CASES, GOLDEN_DATASET_NAME, GOLDEN_DATASET_VERSION, GOLDEN_DATASET_FROZEN } from './golden/index.js';
import { reportToJson, renderMarkdownSummary } from './report/index.js';
import {
  idealSystem,
  staleSystem,
  leakingSystem,
  silentSystem,
  overEscalatingSystem,
  naiveSystem,
} from './mocks/systems.js';
import type { SystemUnderTest } from './types.js';

const SYSTEMS: Record<string, SystemUnderTest> = {
  ideal: idealSystem,
  stale: staleSystem,
  leaking: leakingSystem,
  silent: silentSystem,
  over: overEscalatingSystem,
  naive: naiveSystem,
};

function usage(): string {
  return [
    'usage: cli.js [--system ideal|stale|leaking|silent|over|naive] [--out report.json]',
    '',
    'Runs the seed golden dataset against a mock system under test and',
    'prints a machine-readable JSON report to stdout (or --out <file>).',
  ].join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let systemName = 'ideal';
  let out: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--system' && args[i + 1] !== undefined) {
      systemName = args[i + 1] as string;
      i += 1;
    } else if (args[i] === '--out' && args[i + 1] !== undefined) {
      out = args[i + 1] as string;
      i += 1;
    } else if (args[i] === '--help' || args[i] === '-h') {
      process.stdout.write(`${usage()}\n`);
      return;
    } else {
      process.stderr.write(`unknown argument: ${args[i]}\n${usage()}\n`);
      process.exitCode = 2;
      return;
    }
  }

  const sut = SYSTEMS[systemName];
  if (sut === undefined) {
    process.stderr.write(`unknown system: ${systemName}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }

  const report = await evaluate(sut, SEED_GOLDEN_CASES, {
    systemName: `mock:${systemName}`,
    dataset: {
      name: GOLDEN_DATASET_NAME,
      version: GOLDEN_DATASET_VERSION,
      frozen: GOLDEN_DATASET_FROZEN,
    },
  });

  const json = reportToJson(report);
  if (out !== undefined) {
    await writeFile(out, json, 'utf-8');
    process.stdout.write(`wrote ${out}\n`);
  } else {
    process.stdout.write(`${json}\n`);
  }
  process.stderr.write(
    `${renderMarkdownSummary(report).split('\n').slice(0, 6).join('\n')}\n`,
  );
  if (report.summary.failed > 0) process.exitCode = 1;
}

await main();
