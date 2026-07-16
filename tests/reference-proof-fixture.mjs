import { createHash } from 'node:crypto';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appProofCaseId } from '../src/proof/app-proof.mjs';

export function writeTrustedAppProofFixture(root, options) {
  const width = options.width;
  const height = options.height;
  const viewportName = options.viewportName ?? 'reference';
  const routeName = options.routeName ?? 'home';
  const routePath = options.routePath ?? '/';
  const state = options.state ?? 'default';
  const theme = options.theme ?? 'light';
  const url = options.url ?? `http://127.0.0.1:4173${routePath}`;
  const startedMs = options.startedAt == null
    ? Date.now() - 60_000
    : Date.parse(options.startedAt);
  const finishedMs = startedMs + 10_000;
  const ledgerMs = finishedMs + 1_000;
  const startedAt = new Date(startedMs).toISOString();
  const finishedAt = new Date(finishedMs).toISOString();
  const generatedAt = new Date(ledgerMs).toISOString();
  const matrix = { route: routeName, state, viewport: viewportName, theme };
  const id = appProofCaseId(matrix);
  const screenshotPath = `.dk/proof/screenshots/${id}.png`;
  const proofPath = '.dk/proof/app-proof.json';
  const ledgerPath = '.dk/report.json';
  const screenshotSha256 = digest(options.screenshotBytes);
  const configHash = options.configHash ?? 'a'.repeat(64);
  const coverage = {
    routes: [{ name: routeName, url }],
    states: [state],
    viewports: [{ name: viewportName, width, height }],
    themes: [{ name: theme, colorScheme: theme === 'dark' ? 'dark' : 'light' }],
    plannedCases: 1,
    completedCases: 1,
    failedCases: 0,
    screenshotCases: 1,
  };
  const proof = {
    schemaVersion: 2,
    kind: 'axion-app-proof',
    configHash,
    tags: ['wcag2a', 'wcag2aa'],
    coverageStatus: 'complete',
    qualityStatus: 'clean',
    startedAt,
    finishedAt,
    discovery: 'explicit-routes',
    coverage,
    summary: { cases: 1, failed: 0, violations: 0 },
    results: [{
      id,
      file: `app:${routePath}`,
      target: `app:${routePath} [state=${state}, viewport=${viewportName}, theme=${theme}]`,
      url,
      matrix,
      violations: [],
      usedTokens: [],
      screenshot: {
        path: screenshotPath,
        sha256: screenshotSha256,
        bytes: options.screenshotBytes.length,
        width,
        height,
        fullPage: true,
      },
    }],
    usedTokens: [],
  };
  const ledger = {
    version: 2,
    generatedAt,
    preset: 'recommended',
    tokenHash: 'fixture-token-hash',
    runtimeVersion: '1.0.0',
    configHash: 'b'.repeat(16),
    sourceFingerprint: null,
    directionHash: null,
    direction: null,
    counts: { error: 0, warn: 0, info: 0 },
    exitCode: 0,
    status: 'passed',
    filesScanned: options.sourcePaths?.length ?? 0,
    suppressed: 0,
    baselined: 0,
    configErrors: [],
    fatal: false,
    full: false,
    partial: true,
    scope: { targets: null, files: options.sourcePaths ?? [] },
    gates: [{ id: 'a11y', status: 'ran', findings: 0, emits: ['appProofCoverage'] }],
    findings: [],
    emits: {
      appProofCoverage: coverage,
      appProofArtifact: proofPath,
      appProofConfigHash: configHash,
      appProofTags: proof.tags,
    },
  };

  for (const relative of options.sourcePaths ?? []) {
    const old = new Date(startedMs - 10_000);
    utimesSync(join(root, relative), old, old);
  }
  mkdirSync(join(root, '.dk', 'proof', 'screenshots'), { recursive: true });
  writeFileSync(join(root, screenshotPath), options.screenshotBytes);
  writeFileSync(join(root, proofPath), `${JSON.stringify(proof, null, 2)}\n`);
  writeFileSync(join(root, ledgerPath), `${JSON.stringify(ledger)}\n`);
  utimesSync(join(root, screenshotPath), new Date(finishedMs - 1_000), new Date(finishedMs - 1_000));
  utimesSync(join(root, proofPath), new Date(finishedMs), new Date(finishedMs));
  utimesSync(join(root, ledgerPath), new Date(ledgerMs), new Date(ledgerMs));

  return { id, screenshotPath, proofPath, ledgerPath, proof, ledger, startedAt, finishedAt, generatedAt };
}

function digest(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
