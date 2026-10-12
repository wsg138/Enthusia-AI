import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const requireModule = createRequire(import.meta.url);
const baseline = requireModule('../../deploy/bloom/bloom-30b.js') as {
  MODEL_NAME: string;
  MODEL_SHA256: string;
  QUALITY_CASES: readonly { id: string; question: string }[];
};
const stressed = requireModule('../../deploy/bloom/bloom-30b-loadtest.js') as {
  MODEL_NAME: string;
  MODEL_SHA256: string;
  QUALITY_CASES: readonly { id: string; question: string }[];
};
const source = readFileSync('deploy/bloom/bloom-30b-loadtest.js', 'utf8');

describe('30B-A3B sustained CPU workload for SMP spark comparison', () => {
  it('reuses exactly the already-tested model file and question set', () => {
    expect(stressed.MODEL_NAME).toBe(baseline.MODEL_NAME);
    expect(stressed.MODEL_SHA256).toBe(baseline.MODEL_SHA256);
    expect(stressed.QUALITY_CASES.map(x => x.question)).toEqual(
      baseline.QUALITY_CASES.map(x => x.question),
    );
  });
  it('fails closed without cached model or owner-confirmed wiped split', () => {
    expect(source).toContain('existing-model-required-no-download');
    expect(source).toContain('existing-model-checksum-mismatch');
    expect(source).toContain('requireApprovedWipedServer();');
    expect(source).toContain('CC19EA3C WIPED FOR ENTHUSIA AI');
    expect(source).toContain('shared-host-inference-approval-required');
    expect(source).toContain("ENTHUSIA_BLOOM_INFERENCE_RUN_APPROVED !== '1'");
    expect(source).toContain('await verifyExistingModel()');
    expect(source).not.toContain('huggingface.co');
    expect(source).not.toMatch(/fetch\(MODEL_URL|model-download-http-failed|Downloading approved/);
  });
  it('does not trigger Pterodactyl automatic repeat after completed benchmark', () => {
    // The owner observed the panel restarting the benchmark on clean exit 0.
    // After llama-server is shut down, Node should remain idle until panel STOP.
    expect(source).toContain("main().then(() => {");
    expect(source).toContain("inference stopped. Idling until you manually STOP");
    expect(source).toContain("const hold = setInterval(() => {}, 60_000);");
    expect(source).toContain("process.once('SIGTERM', stop);");
    expect(source).toContain("process.once('SIGINT', stop);");
  });
  it('limits inference to four threads, 150 seconds, localhost and 80 percent memory cap', () => {
    expect(source).toContain('Date.now() - workloadStart < 150_000');
    expect(source).toContain('results.length < 120');
    expect(source).toContain("'--host', '127.0.0.1'");
    expect(source).toContain("'--threads', '4'");
    expect(source).toContain("'--parallel', '1'");
    expect(source).toContain('const stopAtFraction = 0.80;');
    expect(source).toContain('bloom-30b-loadtest-report.json');
    expect(source).toContain('workloadSeconds:');
    expect(source).not.toContain("'--host', '0.0.0.0'");
    expect(source).toContain('discord: false, minecraft: false, sftp: false, mysql: false');
  });
});
