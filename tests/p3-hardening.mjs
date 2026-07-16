#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { validateConfig } from '../src/core/config.mjs';
import { renderSummary } from '../src/core/report.mjs';
import { indexRepository, writeSystemGraph } from '../src/system/indexer.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, 'bin/dk.mjs');

const schema = JSON.parse(readFileSync(join(repo, 'dk.schema.json'), 'utf8'));
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const schemaAcceptsState = (state) => validateSchema({
  proof: { baseUrl: 'http://127.0.0.1:3000', states: [state] },
});
assert.equal(schemaAcceptsState({ name: 'default' }), true,
  `schema must accept the runtime-valid default state object: ${JSON.stringify(validateSchema.errors)}`);
assert.equal(schemaAcceptsState({ name: 'default', actions: [] }), true,
  `schema must accept an explicit empty default action list: ${JSON.stringify(validateSchema.errors)}`);
assert.equal(schemaAcceptsState({ name: 'loaded', waitFor: '#ready' }), true,
  `schema must accept a named state with a wait target: ${JSON.stringify(validateSchema.errors)}`);
assert.equal(schemaAcceptsState({ name: 'loaded' }), false,
  'non-default states without actions or waitFor must fail the published schema');

for (const [action, accepted, message] of [
  [{ type: 'fill', selector: '#name', value: '' }, true, 'fill with value'],
  [{ type: 'fill', selector: '#name', value: ['not-runtime-valid'] }, false, 'fill with non-string value'],
  [{ type: 'fill', selector: '#name' }, false, 'fill without value'],
  [{ type: 'select', selector: '#plan', value: ['pro'] }, true, 'select with value'],
  [{ type: 'select', selector: '#plan' }, false, 'select without value'],
  [{ type: 'press', selector: '#search', key: 'Enter' }, true, 'press with key'],
  [{ type: 'press', selector: '#search' }, false, 'press without key'],
]) {
  assert.equal(schemaAcceptsState({ name: 'interactive', actions: [action] }), accepted,
    `published schema contract mismatch for ${message}: ${JSON.stringify(validateSchema.errors)}`);
}

for (const [config, expectedPath, suggestion] of [
  [{ proofs: { baseUrl: 'http://127.0.0.1:3000' } }, 'dk.config.proofs', 'proof'],
  [{ gates: { visaul: { enabled: true } } }, 'gates.visaul', 'visual'],
  [{ direction: { requird: true } }, 'direction.requird', 'required'],
]) {
  const { errors } = validateConfig(config);
  assert(errors.some((error) => error.meta?.configFatal && error.meta?.configPath === expectedPath
    && error.meta?.suggestion === suggestion), `${expectedPath} must fail closed with a suggestion`);
}

assert(validateConfig({ tokens: { output: { css: true } } }).errors.some((error) =>
  error.meta?.configFatal && error.meta?.configPath === 'tokens.output.css'));
for (const [config, path] of [
  [{ tokens: { source: 42 } }, 'tokens.source'],
  [{ gates: { a11y: { enabled: 'yes' } } }, 'gates.a11y.enabled'],
  [{ contrast: { modes: ['light', 'sepia'] } }, 'contrast.modes'],
  [{ enforce: { spacing: 'maybe' } }, 'enforce.spacing'],
  [{ allowlist: { 'slop/example': '*.html' } }, 'allowlist.slop/example'],
  [{ slop: { rules: [{ id: 'brand/no-bad', zone: 'all', pattern: '[', severity: 'error' }] } }, 'slop.rules[0].pattern'],
  [{ slop: { rules: [{ id: 'brand/no-bad', zone: 'all', pattern: 'bad', flags: 'gg' }] } }, 'slop.rules[0].flags'],
  [{ slop: { rules: [{ id: 'brand/no-bad', zone: 'all', pattern: 'bad', message: 42 }] } }, 'slop.rules[0].message'],
]) {
  assert(validateConfig(config).errors.some((error) => error.meta?.configFatal && error.meta?.configPath === path),
    `${path} must fail closed without crashing config resolution`);
}

const missingValueCases = [
  ['verify', '--gate'], ['report', '--out'], ['build', '--format'], ['new', 'unused', '--preset'],
  ['design', 'lock', '--accept', '--reason'], ['design', 'lock', '--accept', '--actor'],
  ['proof', '--app'], ['proof', '--routes'], ['studio', '--port'], ['studio', '--host'],
  ['system', '--out'], ['benchmark', '--out'],
];
for (const args of missingValueCases) {
  const run = spawnSync(process.execPath, [cli, ...args], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 2, `${args.join(' ')} must reject a missing value`);
  assert.match(run.stderr, /requires a value|缺少值/, `${args.join(' ')} must explain the missing value`);
}

for (const args of [
  ['slop', '--gate', 'visual'],
  ['slop', '--full'],
  ['slop', '--require-gates'],
]) {
  const run = spawnSync(process.execPath, [cli, ...args], {
    cwd: repo, encoding: 'utf8', env: { ...process.env, DK_LANG: 'en' },
  });
  assert.equal(run.status, 2, `${args.join(' ')} must fail closed instead of silently ignoring verify orchestration`);
  assert.match(run.stderr, /fixed alias for the slop gate/);
  assert.match(run.stderr, /dk verify --gate <id>|dk verify --full/);
  assert.equal(run.stdout, '', `${args.join(' ')} emits no misleading pass report`);
}
const slopHelp = spawnSync(process.execPath, [cli, 'slop', '--help'], {
  cwd: repo, encoding: 'utf8', env: { ...process.env, DK_LANG: 'en' },
});
assert.equal(slopHelp.status, 0);
assert.match(slopHelp.stdout, /fixed alias for dk verify --gate slop/);
assert.match(slopHelp.stdout, /--gate, --full, and --require-gates are rejected with exit 2/);

const proofWithoutApp = spawnSync(process.execPath, [cli, 'proof', '--json'], {
  cwd: repo, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
});
assert.equal(proofWithoutApp.status, 2, 'dk proof must never pass without proof config or --app');
assert.match(proofWithoutApp.stderr, /proof\.baseUrl|real Web app proof contract|Web App 證據設定/);
assert.equal(proofWithoutApp.stdout, '', 'a rejected proof command emits no misleading success JSON');

const conflictPath = join(repo, 'output', 'surface-conflict.sarif');
rmSync(conflictPath, { force: true });
const surfaceConflict = spawnSync(process.execPath, [
  cli, 'verify', '--json', '--sarif', '--out', 'output/surface-conflict.sarif',
], { cwd: repo, encoding: 'utf8' });
assert.equal(surfaceConflict.status, 2, 'multiple report surfaces must fail closed before verification');
assert.match(surfaceConflict.stderr, /cannot be combined|不能同時指定/);
assert.equal(surfaceConflict.stdout, '');
assert.throws(() => readFileSync(conflictPath), { code: 'ENOENT' }, 'a rejected surface mix writes no mislabeled artifact');

const benchmarkRoot = mkdtempSync(join(tmpdir(), 'dk-benchmark-surface-'));
try {
  const benchmark = spawnSync(process.execPath, [cli, 'benchmark', '--json', '--html', 'report.html'], {
    cwd: benchmarkRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(benchmark.status, 0, `combined benchmark surfaces must pass: ${benchmark.stderr}`);
  assert.equal(JSON.parse(benchmark.stdout).schema, 'dk-drift-benchmark/v1');
  assert.match(readFileSync(join(benchmarkRoot, 'report.html'), 'utf8'), /^<!doctype html>/i,
    '--json --html must write HTML to the HTML destination while preserving JSON stdout');
} finally {
  rmSync(benchmarkRoot, { recursive: true, force: true });
}

const graphRoot = mkdtempSync(join(tmpdir(), 'dk-system-budget-'));
try {
  writeFileSync(join(graphRoot, 'a.js'), `export const a = '${'a'.repeat(48)}';\n`);
  writeFileSync(join(graphRoot, 'b.js'), `export const b = '${'b'.repeat(48)}';\n`);
  const graph = indexRepository(graphRoot, { maxBytes: 1_024, maxTotalBytes: 80, now: '2026-01-01T00:00:00.000Z' });
  assert.equal(graph.stats.sourceFiles, 1, 'System Graph keeps source memory within the aggregate byte budget');
  assert(graph.warnings.some((warning) => warning.kind === 'total-size'), 'aggregate truncation is explicit evidence');
  const graphPath = writeSystemGraph(graph, 'output/graph.json', { root: graphRoot });
  assert.equal(JSON.parse(readFileSync(graphPath, 'utf8')).schema, 'dk-system-graph/v1');
  assert.throws(
    () => writeSystemGraph(graph, join(dirname(graphRoot), 'escaped-system-graph.json'), { root: graphRoot }),
    (error) => error?.code === 'DK_UNSAFE_WRITE',
    'public System Graph writes fail closed outside their declared project root',
  );
} finally {
  rmSync(graphRoot, { recursive: true, force: true });
}

const routes = Array.from({ length: 200 }, (_, index) => ({
  name: `route-${index}`,
  url: `https://example.test/${'long-segment-'.repeat(20)}${index}`,
}));
const summary = renderSummary({
  tokenHash: 'a'.repeat(64), directionHash: null, exitCode: 0,
  counts: { error: 0, warn: 0, info: 0 }, filesScanned: 1,
  findings: [], gates: [{ id: 'a11y', status: 'ran' }], configErrors: [],
  emits: {
    appProofDiscovery: 'explicit-routes', appProofArtifact: '.dk/proof/app-proof.json',
    appProofCoverage: {
      routes, states: ['default'], viewports: [{ name: 'desktop' }], themes: [{ name: 'light' }],
      plannedCases: 200, completedCases: 200, failedCases: 0, screenshotCases: 200,
    },
    appProofSummary: { cases: 200, failed: 0, violations: 0 },
  },
}, { presetName: 'strict' });
assert(Buffer.byteLength(summary) < 10 * 1024, '--summary must stay below its documented 10KB bound');
const parsed = JSON.parse(summary);
assert.equal(parsed.proof.coverage.routes, 200);
assert.equal(parsed.proof.coverage.screenshotCases, 200);

const longFindings = Array.from({ length: 20 }, (_, index) => ({
  ruleId: `custom/${String(index).padStart(2, '0')}-${'x'.repeat(700)}`,
  severity: 'error', file: 'index.html', message: 'bounded summary probe',
}));
const worstCase = renderSummary({
  tokenHash: 'b'.repeat(64), exitCode: 1, counts: { error: 20, warn: 0, info: 0 },
  filesScanned: 1, findings: longFindings, configErrors: [],
  gates: [{ id: 'slop', status: 'ran' }], emits: {},
}, { presetName: 'strict' });
assert(Buffer.byteLength(worstCase) < 10 * 1024, 'adversarially long custom rule IDs must still respect the 10KB summary contract');
const bounded = JSON.parse(worstCase);
assert.equal(bounded.rules.top.reduce((sum, item) => sum + item.count, 0) + (bounded.rules.other?.count ?? 0), 20);
assert(bounded.truncated?.strings > 0, 'summary reports display-string truncation instead of silently clipping');

process.stdout.write('P3 hardening: PASS (config/schema, CLI surfaces, System Graph budgets/writes, bounded summary)\n');
