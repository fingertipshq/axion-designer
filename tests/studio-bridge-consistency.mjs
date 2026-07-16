#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createIntegrationEnvelope } from '../src/bridge/contracts.mjs';
import { bridgeConnectionContractDigest } from '../src/bridge/orchestrator.mjs';
import { appendArtifactLedger } from '../src/bridge/runtime.mjs';
import { loadConfig } from '../src/core/config.mjs';
import { collectStudioSnapshot } from '../src/studio/data.mjs';
import { startStudio } from '../src/studio/server.mjs';

const root = mkdtempSync(join(tmpdir(), 'axion-studio-bridge-'));
const artifactDir = '.dk/bridge';
const evidenceIds = {};
const contractDigests = new Map();
let studio;

try {
  put('design/tokens.json', JSON.stringify({
    color: {
      text: { primary: { $type: 'color', $value: '#111111' } },
      surface: { page: { $type: 'color', $value: '#ffffff' } },
    },
  }, null, 2));
  put('index.html', '<!doctype html><title>Bridge consistency</title>');
  put('dk.config.json', JSON.stringify({
    tokens: { source: 'design/tokens.json' },
    targets: ['index.html'],
    bridge: {
      enabled: false,
      source: 'design/bridge.json',
      artifactDir,
      freshnessMs: 86_400_000,
    },
    gates: { bridge: { enabled: true } },
  }, null, 2));
  put('design/bridge.json', JSON.stringify({
    schema: 'axion-bridge-config/v1',
    connections: [{
      id: 'dual-main', adapter: 'github', role: 'both', required: true,
      trust: 'linked', permissions: [],
    }, {
      id: 'required-sink', adapter: 'webhook', role: 'sink', required: true,
      trust: 'linked', permissions: [],
    }, {
      id: 'stale-source', adapter: 'artifact', role: 'source', required: false,
      trust: 'linked', permissions: ['fs:read', 'network:artifact-origin'],
    }],
  }, null, 2));
  const resolvedConfig = await loadConfig(root);
  for (const connection of resolvedConfig.bridge.connections) {
    contractDigests.set(connection.id, bridgeConnectionContractDigest(connection, root));
  }

  // Publish is deliberately older than collect. Studio must follow the
  // orchestrator's per-operation selection (publish first for `both`) rather
  // than blindly displaying the provider's final raw ledger entry.
  const collectEvidence = evidence('collect/github', 'ci.run.evidence', '2026-07-15T02:01:00.000Z');
  const publishEvidence = evidence('publish/github', 'github.checks.publish', '2026-07-15T02:00:00.000Z');
  append('dual-main', 'publish', publishEvidence, '2026-07-15T02:00:00.000Z', 'github', true, collectEvidence.digest);
  append('dual-main', 'collect', collectEvidence, '2026-07-15T02:01:00.000Z');
  append('required-sink', 'collect', evidence(
    'collect/webhook-sink', 'historical.webhook.collect', '2026-07-15T02:01:30.000Z', 'webhook-sink',
  ), '2026-07-15T02:01:30.000Z', 'webhook');
  append('stale-source', 'collect', evidence(
    'collect/generic-artifact', 'artifact.evidence.read', '2020-01-01T00:00:00.000Z', 'generic-artifact',
  ), '2026-07-15T02:01:40.000Z', 'artifact', false);

  const snapshot = await collectStudioSnapshot(root, { now: '2026-07-15T02:02:00.000Z' });
  assert.equal(snapshot.bridge.enabled, true, 'the Bridge gate alone enables the Studio integration surface');
  assert.equal(snapshot.bridge.status, 'incomplete');
  assert.equal(snapshot.bridge.summary.total, 3);
  assert.equal(snapshot.bridge.summary.healthy, 1);
  assert.equal(snapshot.bridge.summary.incomplete, 2);
  assert.equal(snapshot.bridge.summary.requiredFailed, 0,
    'a required pure sink is deferred when Studio audits with evaluateSinks=false');

  const dual = snapshot.bridge.connections.find((connection) => connection.id === 'dual-main');
  assert.equal(dual.status, 'healthy');
  assert.equal(dual.capability, 'github.checks.publish',
    'UI detail follows the publish envelope selected by the per-operation audit');
  assert.equal(dual.operations.collect.status, 'healthy');
  assert.equal(dual.operations.publish.status, 'healthy');
  assert.equal(dual.envelopeId, evidenceIds.publish);

  const sink = snapshot.bridge.connections.find((connection) => connection.id === 'required-sink');
  assert.equal(sink.status, 'incomplete');
  assert.equal(sink.operations.publish.status, 'incomplete');
  assert.equal(sink.capability, null, 'historical collect evidence cannot satisfy or decorate a pure sink');
  assert.equal(sink.envelopeId, null);
  assert(sink.issues.some((issue) => issue.code === 'source-receipt-missing'
    && issue.operation === 'publish' && issue.severity === 'warn'));
  const stale = snapshot.bridge.connections.find((connection) => connection.id === 'stale-source');
  assert.equal(stale.status, 'incomplete');
  assert.equal(stale.operations.collect.status, 'incomplete');
  assert(stale.issues.some((issue) => issue.code === 'stale'
    && issue.operation === 'collect' && issue.severity === 'warn'));

  studio = await startStudio({ root, port: 0, cacheTtl: 0 });
  await assertBridgeDiagnostics();

  const ledgerPath = join(root, artifactDir, 'ledger.json');
  const validLedgerSource = readFileSync(ledgerPath, 'utf8');
  const invalidLedger = JSON.parse(validLedgerSource);
  invalidLedger.digest = '0'.repeat(64);
  writeFileSync(ledgerPath, `${JSON.stringify(invalidLedger, null, 2)}\n`);
  const invalidSnapshot = await collectStudioSnapshot(root, { now: '2026-07-15T02:02:00.000Z' });
  assert.equal(invalidSnapshot.bridge.status, 'failed');
  assert.equal(invalidSnapshot.bridge.ledger.ok, false);
  assert(invalidSnapshot.bridge.issues.some((issue) => issue.severity === 'error' && issue.connection == null));
  await assertBridgeBadge('invalid ledger');

  // A config-fatal manifest must stop before the old, valid ledger is read.
  // Duplicate IDs are merged for safe inspection, but remain fatal evidence.
  writeFileSync(ledgerPath, validLedgerSource);
  const duplicateManifest = JSON.parse(readFileSync(join(root, 'design/bridge.json'), 'utf8'));
  duplicateManifest.connections.push({ ...duplicateManifest.connections[0] });
  put('design/bridge.json', JSON.stringify(duplicateManifest, null, 2));
  const configFailed = await collectStudioSnapshot(root, { now: '2026-07-15T02:02:00.000Z' });
  assert(configFailed.errors.some((issue) => issue.status === 'config-error'
    && issue.code === 'config-error'
    && issue.path === 'bridge.source.connections[3].id'));
  assert.equal(configFailed.bridge.status, 'config-error');
  assert.equal(configFailed.bridge.reason, 'config-error');
  assert.equal(configFailed.bridge.available, false);
  assert.equal(configFailed.bridge.ledger, null);
  assert.equal(configFailed.bridge.summary.healthy, 0);
  assert(configFailed.bridge.connections.every((connection) => connection.status === 'config-error'));
  await assertBridgeBadge('config error');

  process.stdout.write('Studio Bridge consistency: audit + diagnostics + integrity + config-fatal UI passed\n');
} finally {
  if (studio) await studio.close();
  rmSync(root, { recursive: true, force: true });
}

function evidence(kind, capability, createdAt, provider = 'github') {
  const envelope = createIntegrationEnvelope({
    provider, kind, createdAt,
    trust: { level: 'self-attested', issuer: provider, evidence: ['ci:fixture'] },
    binding: { repository: null, commit: null },
    permissions: [],
    payload: { status: 'passed', capability, findings: [], metadata: {} },
  });
  evidenceIds[kind.startsWith('publish/') ? 'publish' : 'collect'] = envelope.id;
  return envelope;
}

function append(provider, operation, envelope, now, adapter = 'github', required = true, inputEnvelopeDigest = null) {
  appendArtifactLedger(root, {
    adapter, provider, operation, required,
    status: 'healthy', trust: envelope.trust.level,
    ...(inputEnvelopeDigest ? { inputEnvelopeDigest } : {}),
    ...(contractDigests.get(provider) ? { contractDigest: contractDigests.get(provider) } : {}),
    envelope, createdAt: now,
  }, { artifactDir, repository: root, commit: null, now });
}

function put(file, source) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source.endsWith('\n') ? source : `${source}\n`);
}

async function assertBridgeBadge(expected) {
  return withStudioPage(async (page) => {
    await page.waitForSelector('#bridge-ledger-state.bad');
    assert.equal(await page.locator('#bridge-ledger-state').textContent(), expected);
  });
}

async function assertBridgeDiagnostics() {
  return withStudioPage(async (page) => {
    await page.route('**/api/snapshot', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const sink = body.bridge.connections.find((connection) => connection.id === 'required-sink');
      sink.issues.push(...Array.from({ length: 12 }, (_, index) => ({
        severity: 'warn', operation: 'publish', code: `unsafe-${index}<code>`,
        message: index === 0
          ? '<img id="diagnostic-xss" src=x onerror="window.__diagnosticXss=true">'
          : `bounded diagnostic ${index}`,
      })));
      await route.fulfill({ response, json: body });
    });
    await page.reload();
    const sink = page.locator('[data-connection-id="required-sink"]');
    await sink.waitFor();
    const publish = sink.locator('.operation-chip[data-operation="publish"]');
    assert.equal(await publish.locator('code').textContent(), 'publish');
    assert.equal(await publish.locator('strong').textContent(), 'incomplete');
    const missingReceipt = sink.locator('.connection-issue').filter({ hasText: 'source-receipt-missing' });
    assert.equal(await missingReceipt.count(), 1);
    assert.match(await missingReceipt.textContent(), /publish/i);
    assert.match(await missingReceipt.textContent(), /No publish receipt covers the latest evidence/i);
    assert.equal(await sink.locator('.connection-issue').count(), 6, 'diagnostics are capped in the DOM');
    assert.match(await sink.locator('.connection-diagnostic-more').textContent(), /\+7 more diagnostics/i);
    assert.equal(await sink.locator('#diagnostic-xss').count(), 0, 'diagnostic HTML is escaped, not parsed');
    assert.match(await sink.locator('.connection-diagnostics').textContent(), /<img id="diagnostic-xss"/);

    const stale = page.locator('[data-connection-id="stale-source"]');
    const collect = stale.locator('.operation-chip[data-operation="collect"]');
    assert.equal(await collect.locator('code').textContent(), 'collect');
    assert.equal(await collect.locator('strong').textContent(), 'incomplete');
    const staleIssue = stale.locator('.connection-issue').filter({ hasText: 'stale' });
    assert.equal(await staleIssue.count(), 1);
    assert.match(await staleIssue.textContent(), /collect/i);
    assert.match(await staleIssue.textContent(), /Envelope is older than/i);
  });
}

async function withStudioPage(callback) {
  let chromium;
  try { ({ chromium } = await import('@playwright/test')); }
  catch {
    process.stdout.write('Studio Bridge browser checks: skipped (Playwright unavailable)\n');
    return;
  }
  let browser;
  try { browser = await chromium.launch(); }
  catch {
    process.stdout.write('Studio Bridge browser checks: skipped (Chromium unavailable)\n');
    return;
  }
  try {
    const page = await browser.newPage();
    await page.goto(`${studio.url}/#connections`);
    await callback(page);
  } finally {
    await browser.close();
  }
}
