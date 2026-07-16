#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDriftBenchmark, renderDriftBenchmarkHtml } from '../src/benchmark/drift.mjs';
import { safeWriteFileSync } from '../src/core/safe-write.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'output', 'p3-benchmark');

try {
  const report = await runDriftBenchmark({ keepWorkspace: process.env.DK_KEEP_BENCHMARK_WORKSPACE === '1' });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  const html = renderDriftBenchmarkHtml(report);
  safeWriteFileSync(root, join(out, 'report.json'), json);
  safeWriteFileSync(root, join(out, 'report.html'), html);
  safeWriteFileSync(root, join(out, 'checksums.json'), `${JSON.stringify({
    algorithm: 'sha256',
    files: {
      'report.json': createHash('sha256').update(json).digest('hex'),
      'report.html': createHash('sha256').update(html).digest('hex'),
    },
  }, null, 2)}\n`);
  process.stdout.write([
    '',
    'Axion Designer P3 drift benchmark: PASS',
    `  detection  ${report.detected}/${report.rounds}`,
    `  recovery   ${report.recovered}/${report.rounds}`,
    `  clean       ${report.cleanChecks} checks · ${report.unexpectedFindings} unexpected findings`,
    `  latency     ${report.medianDetectionMs} ms median · ${report.p95DetectionMs} ms p95`,
    `  proof       ${report.proofHash}`,
    `  report      ${relative(root, join(out, 'report.html'))}`,
    '',
  ].join('\n'));
} catch (error) {
  if (error.report) {
    safeWriteFileSync(root, join(out, 'report.failed.json'), `${JSON.stringify(error.report, null, 2)}\n`);
  }
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
}
