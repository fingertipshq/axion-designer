#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDriftBenchmark, renderDriftBenchmarkHtml } from '../src/benchmark/drift.mjs';

const report = await runDriftBenchmark();
assert.equal(report.schema, 'dk-drift-benchmark/v1');
assert.equal(report.status, 'passed');
assert.equal(report.timeoutMs, 30_000);
assert.equal(report.rounds, 10);
assert.equal(report.completedRounds, 10);
assert.equal(report.detected, 10);
assert.equal(report.recovered, 10);
assert.equal(report.detectionRate, 1);
assert.equal(report.recoveryRate, 1);
assert.equal(report.unexpectedFindings, 0);
assert.equal(report.timeouts, 0);
assert.equal(report.failure, null);
assert.equal(new Set(report.results.map((round) => round.id)).size, 10);
assert(report.results.every((round) => round.observedRules.includes(round.expectedRule)));
assert.match(report.proofHash, /^[a-f0-9]{64}$/);
const html = renderDriftBenchmarkHtml(report);
assert(html.includes(report.proofHash));
assert(html.includes('Ten edits entered. Ten drifts were caught.'));

const contractRoot = mkdtempSync(join(tmpdir(), 'axion-benchmark-contract-'));
try {
  const pristine = readdirSync(contractRoot);
  await assert.rejects(
    runDriftBenchmark({ cli: join(contractRoot, 'missing-cli.mjs'), tempRoot: contractRoot }),
    /Axion CLI not found/,
  );
  assert.deepEqual(readdirSync(contractRoot), pristine, 'invalid CLI paths allocate no temporary workspace');
  await assert.rejects(
    runDriftBenchmark({ scaffold: join(contractRoot, 'missing-scaffold'), tempRoot: contractRoot }),
    /Axion scaffold not found/,
  );
  assert.deepEqual(readdirSync(contractRoot), pristine, 'invalid scaffold paths allocate no temporary workspace');
  await assert.rejects(runDriftBenchmark({ timeoutMs: 99 }), /between 100 and 300000/);
  await assert.rejects(runDriftBenchmark({ timeoutMs: 300_001 }), /between 100 and 300000/);

  const hangingCli = join(contractRoot, 'hanging-cli.mjs');
  writeFileSync(hangingCli, 'setInterval(() => {}, 1000);\n');
  const timeoutStarted = Date.now();
  const timedOut = await runDriftBenchmark({
    cli: hangingCli,
    tempRoot: contractRoot,
    timeoutMs: 100,
    throwOnFailure: false,
  });
  assert(Date.now() - timeoutStarted < 5_000, 'a hung verifier is killed at the bounded timeout instead of hanging CI');
  assert.equal(timedOut.status, 'failed');
  assert.equal(timedOut.timeoutMs, 100);
  assert.equal(timedOut.timeouts, 1);
  assert.equal(timedOut.completedRounds, 0);
  assert.equal(timedOut.failure?.kind, 'timeout');
  assert.equal(timedOut.failure?.phase, 'baseline');
  assert.match(timedOut.failure?.message ?? '', /timed out after 100 ms/);
  assert.match(timedOut.proofHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(readdirSync(contractRoot), ['hanging-cli.mjs'], 'timed-out runs clean their temporary workspace');
  const failedHtml = renderDriftBenchmarkHtml(timedOut);
  assert(failedHtml.includes('The benchmark stopped at its safety boundary.'));
  assert(failedHtml.includes('This report is failed evidence, not a partial pass.'));
  assert(!failedHtml.includes('Ten edits entered. Ten drifts were caught.'), 'failed HTML never renders the passing claim');
  await assert.rejects(
    runDriftBenchmark({ cli: hangingCli, tempRoot: contractRoot, timeoutMs: 100 }),
    (error) => error?.report?.status === 'failed'
      && error.report.failure?.kind === 'timeout'
      && /^[a-f0-9]{64}$/.test(error.report.proofHash),
    'throwOnFailure retains the failed timeout report as machine-readable evidence',
  );
  assert.deepEqual(readdirSync(contractRoot), ['hanging-cli.mjs'], 'throwing timeout runs also clean their workspace');
} finally {
  rmSync(contractRoot, { recursive: true, force: true });
}

console.log(`P3 benchmark: PASS (${report.detected}/10 detected, ${report.recovered}/10 recovered, ${report.unexpectedFindings} clean-check findings)`);
