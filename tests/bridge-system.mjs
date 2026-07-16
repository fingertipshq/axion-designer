#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createIntegrationEnvelope } from '../src/bridge/contracts.mjs';
import {
  auditBridge,
  bridgeConnectionContractDigest,
  bridgeGitIdentity,
  createConnectionAdapter,
  ingestBridgeEnvelope,
  syncBridge,
} from '../src/bridge/orchestrator.mjs';
import { appendArtifactLedger } from '../src/bridge/runtime.mjs';
import { loadConfig } from '../src/core/config.mjs';
import { collectStudioSnapshot } from '../src/studio/data.mjs';

const project = mkdtempSync(join(tmpdir(), 'axion-bridge-system-'));
const initProject = mkdtempSync(join(tmpdir(), 'axion-bridge-init-'));
const roleProject = mkdtempSync(join(tmpdir(), 'axion-bridge-role-'));
const ingestProject = mkdtempSync(join(tmpdir(), 'axion-bridge-ingest-'));
const duplicateProject = mkdtempSync(join(tmpdir(), 'axion-bridge-duplicate-'));
const noiseProject = mkdtempSync(join(tmpdir(), 'axion-bridge-noise-'));
const cli = resolve('bin/dk.mjs');

try {
  put(project, 'design/tokens.json', JSON.stringify({
    color: {
      text: { primary: { $type: 'color', $value: '#111111' } },
      surface: { page: { $type: 'color', $value: '#ffffff' } },
    },
  }, null, 2));
  put(project, 'styles/tokens.css', ':root {\n  --color-surface-page: #ffffff;\n  --color-text-primary: #111111;\n}\n');
  put(project, 'index.html', '<!doctype html><title>Bridge fixture</title>');
  put(project, 'storybook/index.json', JSON.stringify({
    v: 5,
    entries: {
      'button--default': { id: 'button--default', type: 'story', title: 'System/Button', name: 'Default', importPath: './Button.stories.tsx' },
      'button--disabled': { id: 'button--disabled', type: 'story', title: 'System/Button', name: 'Disabled', importPath: './Button.stories.tsx' },
    },
  }, null, 2));
  put(project, 'design/bridge.json', JSON.stringify({
    $schema: 'https://unpkg.com/axion-designer/bridge.schema.json',
    schema: 'axion-bridge-config/v1',
    connections: [{
      id: 'storybook-main', adapter: 'storybook', role: 'source', required: true,
      trust: 'verified', source: 'storybook/index.json', permissions: ['fs:read', 'network:storybook'],
      options: { expectedSha256: createHash('sha256').update(readFileSync(join(project, 'storybook/index.json'))).digest('hex') },
    }, {
      id: 'delivery-hook', adapter: 'webhook', role: 'sink', required: false,
      trust: 'linked', permissions: ['network:webhook-allowlist', 'env:AXION_WEBHOOK_ENDPOINT', 'env:AXION_WEBHOOK_TOKEN'],
      options: {
        allowlist: ['https://hooks.example.test'],
        endpointEnv: 'AXION_WEBHOOK_ENDPOINT',
        tokenEnv: 'AXION_WEBHOOK_TOKEN',
      },
    }],
  }, null, 2));
  put(project, 'dk.config.json', JSON.stringify({
    $schema: 'https://unpkg.com/axion-designer/dk.schema.json',
    tokens: { source: 'design/tokens.json', output: { css: 'styles/tokens.css' } },
    targets: ['index.html'],
    bridge: { enabled: true, source: 'design/bridge.json', artifactDir: '.dk/bridge', freshnessMs: 86_400_000 },
    gates: { bridge: { enabled: true } },
  }, null, 2));

  const catalog = run(process.cwd(), ['bridge', 'catalog', '--json']);
  assert.equal(catalog.status, 0, catalog.stderr);
  assert(JSON.parse(catalog.stdout).adapters.find((adapter) => adapter.id === 'storybook')?.capabilities.includes('storybook.index.read'));

  const doctor = run(project, ['bridge', 'doctor', '--json']);
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).checks[0].status, 'ready');

  put(roleProject, 'design/bridge.json', JSON.stringify({
    schema: 'axion-bridge-config/v1',
    connections: [{
      id: 'github-actions', adapter: 'github', role: 'source', required: true,
      permissions: [
        'env:GITHUB_ACTIONS', 'env:GITHUB_REPOSITORY', 'env:GITHUB_SHA', 'env:GITHUB_RUN_ID',
        'env:GITHUB_RUN_ATTEMPT', 'env:GITHUB_WORKFLOW', 'env:GITHUB_REF', 'env:GITHUB_EVENT_NAME',
        'env:GITHUB_SERVER_URL', 'env:GITHUB_API_URL',
      ],
    }, {
      id: 'github-checks', adapter: 'github', role: 'sink', required: true,
      permissions: [
        'env:GITHUB_ACTIONS', 'env:GITHUB_REPOSITORY', 'env:GITHUB_SHA', 'env:GITHUB_RUN_ID',
        'env:GITHUB_RUN_ATTEMPT', 'env:GITHUB_WORKFLOW', 'env:GITHUB_REF', 'env:GITHUB_EVENT_NAME',
        'env:GITHUB_SERVER_URL', 'env:GITHUB_API_URL', 'env:GITHUB_TOKEN',
        'network:github-api', 'github:checks.write',
      ],
    }],
  }, null, 2));
  const roleDoctor = run(roleProject, ['bridge', 'doctor', '--json']);
  assert.equal(roleDoctor.status, 0, roleDoctor.stderr);
  assert(roleDoctor.stdout && JSON.parse(roleDoctor.stdout).checks.every((check) => check.status === 'ready'),
    'doctor must validate only the lifecycle used by each connection role');
  const roleManifest = JSON.parse(readFileSync(join(roleProject, 'design/bridge.json'), 'utf8'));
  roleManifest.connections.push({
    id: 'storybook-both', adapter: 'storybook', role: 'both', required: false,
    permissions: ['fs:read', 'network:storybook'], source: 'storybook/index.json',
  });
  put(roleProject, 'design/bridge.json', JSON.stringify(roleManifest, null, 2));
  const invalidBothDoctor = run(roleProject, ['bridge', 'doctor', '--json']);
  assert.equal(invalidBothDoctor.status, 0, 'optional invalid role remains visible without blocking');
  const invalidBothBody = JSON.parse(invalidBothDoctor.stdout);
  assert.equal(invalidBothBody.status, 'incomplete');
  assert(invalidBothBody.checks.find((check) => check.id === 'storybook-both')?.issues
    .some((issue) => issue.code === 'lifecycle-missing' && issue.operation === 'publish'));
  const bridgeApi = new URL('../src/bridge/index.mjs', import.meta.url).href;
  put(roleProject, 'nested-esm/package.json', JSON.stringify({ type: 'module' }));
  put(roleProject, 'nested-esm/adapter.js', `
import { createAdapterManifest } from ${JSON.stringify(bridgeApi)};
export const manifest = createAdapterManifest({
  id: 'nested-esm', provider: 'nested-esm', version: '1.0.0',
  lifecycle: ['collect'], permissions: { discover: [], collect: [], publish: [] },
});
export async function collect() { return []; }
`);
  const nestedEsmAdapter = await createConnectionAdapter({
    id: 'nested-esm-main', adapter: 'nested-esm', module: 'nested-esm/adapter.js', permissions: [],
  }, { root: roleProject });
  assert.equal(typeof nestedEsmAdapter.collect, 'function',
    'content-addressed custom modules preserve nested package.json ESM boundaries');

  put(roleProject, 'lifecycle-mismatch.mjs', `
import { createAdapterManifest } from ${JSON.stringify(bridgeApi)};
export const manifest = createAdapterManifest({
  id: 'lifecycle-mismatch', provider: 'lifecycle-mismatch', version: '1.0.0',
  lifecycle: ['collect'], permissions: { discover: [], collect: [], publish: [] },
});
export async function collect() { return []; }
export async function publish() { return []; }
`);
  await assert.rejects(() => createConnectionAdapter({
    id: 'mismatch-main', adapter: 'lifecycle-mismatch', module: 'lifecycle-mismatch.mjs', permissions: [],
  }, { root: roleProject }), /lifecycle exports do not match/i,
  'custom adapters cannot execute an undeclared lifecycle with empty permissions');
  put(roleProject, 'spoof-source.mjs', `
import { createAdapterManifest, createIntegrationEnvelope } from ${JSON.stringify(bridgeApi)};
export const manifest = createAdapterManifest({
  id: 'spoof-source', provider: 'honest-provider', version: '1.0.0',
  lifecycle: ['collect'], permissions: { discover: [], collect: [], publish: [] },
});
export async function collect() {
  return [createIntegrationEnvelope({
    provider: 'github', kind: 'collect/github',
    trust: { level: 'self-attested', issuer: 'spoof-source', evidence: [] },
    binding: { repository: null, commit: null }, permissions: [],
    payload: { status: 'passed', capability: 'spoofed.provider' },
  })];
}
`);
  const spoofAdapter = await createConnectionAdapter({
    id: 'spoof-main', adapter: 'spoof-source', module: 'spoof-source.mjs', permissions: [],
  }, { root: roleProject });
  await assert.rejects(() => spoofAdapter.collect({}, {
    signal: new AbortController().signal, now: '2026-07-15T00:00:00.000Z',
  }), (error) => error?.issues?.some((issue) => issue.code === 'provider-denied'),
  'a live custom adapter cannot emit evidence under another provider identity');

  const before = run(project, ['bridge', 'status', '--json']);
  assert.equal(before.status, 1, 'required, unsynced provider must fail closed');
  assert.equal(JSON.parse(before.stdout).summary.requiredFailed, 1);

  const synced = run(project, ['bridge', 'sync', '--json']);
  assert.equal(synced.status, 0, synced.stderr);
  const syncBody = JSON.parse(synced.stdout);
  assert.equal(syncBody.status, 'incomplete', 'an optional sink stays visible until publishing is explicitly requested');
  assert.equal(syncBody.envelopes.length, 1);
  assert.equal(syncBody.audit.connections[0].trust, 'verified');
  const sourceOnlyPublish = run(project, ['bridge', 'sync', 'storybook-main', '--publish', '--json']);
  assert.equal(sourceOnlyPublish.status, 2, 'filtered publish cannot silently succeed with zero selected sinks');
  assert.match(JSON.parse(sourceOnlyPublish.stdout).error.message, /No sink connection was selected/i);

  const ledger = JSON.parse(readFileSync(join(project, '.dk/bridge/ledger.json'), 'utf8'));
  assert.equal(ledger.schema, 'axion-bridge-ledger/v1');
  assert.equal(ledger.connections.length, 1);
  assert.equal(ledger.connections[0].provider, 'storybook-main');
  assert.equal(ledger.connections[0].envelope.payload.coverage.stories, 2);
  assert.match(ledger.connections[0].contractDigest, /^[a-f0-9]{64}$/,
    'persisted evidence is bound to its exact non-secret connection contract');

  const resolved = await loadConfig(project);
  const changedContract = auditBridge({
    ...resolved,
    bridge: {
      ...resolved.bridge,
      connections: resolved.bridge.connections.map((connection) => connection.id === 'storybook-main'
        ? { ...connection, options: { ...connection.options, contractRevision: 'changed-after-sync' } }
        : connection),
    },
  });
  assert.equal(changedContract.status, 'failed',
    'old healthy evidence cannot satisfy a changed required connection contract');
  assert(changedContract.issues.some((issue) => issue.connection === 'storybook-main' && issue.code === 'contract-mismatch'));
  const requiredSinkConnection = {
    id: 'required-check-sink', adapter: 'github', role: 'sink', required: true,
    trust: 'linked', permissions: [], options: {},
  };
  const deferredConfig = {
    ...resolved,
    bridge: {
      ...resolved.bridge,
      connections: [...resolved.bridge.connections, requiredSinkConnection],
    },
  };
  const deferredRequiredSink = auditBridge(deferredConfig);
  assert.equal(deferredRequiredSink.status, 'incomplete');
  assert.equal(deferredRequiredSink.summary.requiredFailed, 0,
    'an unattempted sink stays deferred until explicit --publish instead of deadlocking source verification');
  const requiredSinkAudit = auditBridge(deferredConfig, { evaluateSinks: true });
  assert.equal(requiredSinkAudit.status, 'failed');
  assert.equal(requiredSinkAudit.summary.requiredFailed, 1,
    '--require-sinks must fail closed when a required publish receipt is absent');
  await assert.rejects(() => syncBridge({
    ...resolved,
    bridge: { ...resolved.bridge, connections: [requiredSinkConnection] },
  }, { publish: true }), (error) => error?.code === 'AXION_BRIDGE_PUBLISH_INPUT'
    && /requires fresh source envelopes/i.test(error?.message),
  'explicit publish cannot silently skip a required sink when no source envelopes were collected');
  const optionalBrokenSink = await syncBridge({
    ...resolved,
    bridge: {
      ...resolved.bridge,
      connections: [
        resolved.bridge.connections.find((connection) => connection.id === 'storybook-main'),
        {
          id: 'broken-delivery', adapter: 'broken-sink', module: 'missing-sink-adapter.mjs',
          role: 'sink', required: false, trust: 'linked', permissions: [],
        },
      ],
    },
  }, { publish: true });
  assert.equal(optionalBrokenSink.status, 'incomplete');
  assert.equal(optionalBrokenSink.runs.at(-1)?.role, 'sink', 'failed publish runs keep their real sink role');
  assert(optionalBrokenSink.audit.issues.some((issue) => issue.code === 'current-run-failed'),
    'a pre-runtime publish failure remains visible even without a ledger receipt');
  const delivered = await syncBridge(resolved, {
    publish: true,
    env: {
      AXION_WEBHOOK_ENDPOINT: 'https://hooks.example.test/axion',
      AXION_WEBHOOK_TOKEN: 'test-only-secret-value',
    },
    fetch: async () => new Response(JSON.stringify({ id: 'delivery-42', status: 'accepted' }), {
      status: 202, headers: { 'content-type': 'application/json' },
    }),
  });
  assert.equal(delivered.status, 'passed');
  assert(delivered.runs.some((item) => item.connection === 'delivery-hook' && item.role === 'sink'));
  const deliveredLedger = JSON.parse(readFileSync(join(project, '.dk/bridge/ledger.json'), 'utf8'));
  const sinkEntry = deliveredLedger.connections.findLast((entry) => entry.provider === 'delivery-hook');
  assert.equal(sinkEntry.envelope.provider, 'webhook-sink', 'sink receipt envelope is persisted instead of replaying the source envelope');
  assert(!JSON.stringify(deliveredLedger).includes('test-only-secret-value'));

  const staleHealthySource = resolved.bridge.connections.find((connection) => connection.id === 'storybook-main');
  const replacementSource = createIntegrationEnvelope({
    provider: 'storybook', kind: 'collect/storybook',
    trust: { level: 'verified', issuer: 'receipt-binding-test', evidence: ['fixture:new-source'] },
    binding: { repository: null, commit: null }, permissions: ['fs:read', 'network:storybook'],
    payload: { status: 'passed', capability: 'ui.component-state.discover', findings: [], metadata: {} },
  });
  appendArtifactLedger(project, {
    adapter: 'storybook', provider: 'storybook-main', operation: 'collect', required: true,
    status: 'healthy', trust: replacementSource.trust.level,
    runId: `run_${'b'.repeat(32)}`,
    contractDigest: bridgeConnectionContractDigest(staleHealthySource, project),
    envelope: replacementSource, durationMs: 0,
  }, { artifactDir: '.dk/bridge', repository: project, commit: null });
  const receiptDriftConfig = {
    ...resolved,
    bridge: {
      ...resolved.bridge,
      connections: resolved.bridge.connections.map((connection) => connection.id === 'delivery-hook'
        ? { ...connection, required: true } : connection),
    },
  };
  const receiptDrift = auditBridge(receiptDriftConfig, { evaluateSinks: true });
  assert.equal(receiptDrift.status, 'failed',
    'a receipt for source A cannot satisfy a later source B at the same repository/commit');
  assert(receiptDrift.issues.some((issue) => issue.connection === 'delivery-hook' && issue.code === 'source-receipt-missing'));

  const restoredDelivery = await syncBridge(resolved, {
    publish: true,
    env: {
      AXION_WEBHOOK_ENDPOINT: 'https://hooks.example.test/axion',
      AXION_WEBHOOK_TOKEN: 'test-only-secret-value',
    },
    fetch: async () => new Response(JSON.stringify({ id: 'delivery-43', status: 'accepted' }), {
      status: 202, headers: { 'content-type': 'application/json' },
    }),
  });
  assert.equal(restoredDelivery.status, 'passed', 'republishing the latest source set restores sink policy');

  const currentFailure = await syncBridge({
    ...resolved,
    bridge: {
      ...resolved.bridge,
      connections: [{ ...staleHealthySource, required: false, module: 'missing-storybook-adapter.mjs' }],
    },
  });
  assert.equal(currentFailure.status, 'incomplete', 'an old healthy entry cannot conceal the current adapter startup failure');
  assert.equal(currentFailure.runs[0].role, 'source');
  assert(currentFailure.audit.issues.some((issue) => issue.connection === 'storybook-main' && issue.code === 'current-run-failed'));

  put(project, 'opaque-sink.mjs', `
import { createAdapterManifest } from ${JSON.stringify(bridgeApi)};
export const manifest = createAdapterManifest({
  id: 'opaque-sink', provider: 'opaque-sink', version: '1.0.0',
  lifecycle: ['publish'], permissions: { discover: [], collect: [], publish: [] },
});
export async function publish() { return [{ status: 'accepted-without-verifiable-envelope' }]; }
`);
  const opaqueReceipt = await syncBridge({
    ...resolved,
    bridge: {
      ...resolved.bridge,
      connections: [staleHealthySource, {
        id: 'opaque-delivery', adapter: 'opaque-sink', module: 'opaque-sink.mjs',
        role: 'sink', required: true, trust: 'linked', permissions: [],
      }],
    },
  }, { publish: true });
  assert.equal(opaqueReceipt.status, 'failed', 'an opaque return value cannot masquerade as a durable sink receipt');
  assert(opaqueReceipt.audit.issues.some((issue) => issue.connection === 'opaque-delivery' && issue.code === 'missing-envelope'));

  put(roleProject, 'multi-statuses.mjs', `export const statuses = ['failed', 'passed'];`);
  put(roleProject, 'multi-envelope-source.mjs', `
import { createAdapterManifest, createIntegrationEnvelope } from ${JSON.stringify(bridgeApi)};
import { statuses } from './multi-statuses.mjs';
export const manifest = createAdapterManifest({
  id: 'multi-envelope-source', provider: 'multi-envelope-source', version: '1.0.0',
  lifecycle: ['collect'], permissions: { discover: [], collect: [], publish: [] },
});
export async function collect() {
  return statuses.map((status) => createIntegrationEnvelope({
    provider: 'multi-envelope-source', kind: 'collect/multi-envelope-source',
    trust: { level: 'self-attested', issuer: 'multi-envelope-source', evidence: [] },
    binding: { repository: null, commit: null }, permissions: [],
    payload: { status, capability: 'multi-envelope.fixture', findings: [], metadata: {} },
  }));
}
`);
  const multiEnvelopeConfig = {
    cwd: roleProject,
    bridge: {
      artifactDir: resolve(roleProject, '.dk/multi-envelope'), timeoutMs: 5_000,
      freshnessMs: 86_400_000, maxArtifactBytes: 2 * 1024 * 1024,
      connections: [{
        id: 'multi-main', adapter: 'multi-envelope-source', module: 'multi-envelope-source.mjs',
        role: 'source', required: true, trust: 'linked', permissions: [], options: {},
      }],
    },
  };
  const multiEnvelope = await syncBridge(multiEnvelopeConfig);
  assert.equal(multiEnvelope.status, 'failed',
    'a passing final envelope cannot hide a failed envelope from the same collect run');
  assert(multiEnvelope.audit.issues.some((issue) => issue.connection === 'multi-main' && issue.code === 'provider-failed'));
  // Regression: on a CI runner the ambient identity (GITHUB_SHA et al) turns
  // into an expected-commit policy. Unbound fixture envelopes must remain
  // admissible there — absence of a binding is not a contradiction of one.
  const multiEnvelopeOnCi = await syncBridge(multiEnvelopeConfig, {
    env: { GITHUB_SHA: 'a'.repeat(40), GITHUB_REPOSITORY: 'fingertipshq/axion-designer' },
  });
  assert.equal(multiEnvelopeOnCi.status, 'failed',
    'ambient CI identity must not reject unbound envelopes outright');
  assert(multiEnvelopeOnCi.audit.issues.some((issue) => issue.connection === 'multi-main' && issue.code === 'provider-failed'),
    'CI identity keeps the same failed-envelope aggregation semantics as a local run');
  put(roleProject, 'multi-statuses.mjs', `export const statuses = ['failed', 'passed']; // implementation revision`);
  assert(auditBridge(multiEnvelopeConfig).issues.some((issue) => issue.connection === 'multi-main' && issue.code === 'contract-mismatch'),
    'changing a local transitive adapter dependency invalidates evidence from the old module graph');
  put(roleProject, 'multi-statuses.mjs', `export const statuses = ['passed'];`);
  const reloadedMultiEnvelope = await syncBridge(multiEnvelopeConfig);
  assert.equal(reloadedMultiEnvelope.status, 'passed',
    'a long-lived process executes a changed transitive dependency instead of Node cached code');
  const reloadedMultiLedger = JSON.parse(readFileSync(join(roleProject, '.dk/multi-envelope/ledger.json'), 'utf8'));
  const reloadedMultiEntry = reloadedMultiLedger.connections.findLast((entry) => entry.provider === 'multi-main');
  assert.equal(reloadedMultiEntry.envelope.payload.status, 'passed');
  assert.equal(reloadedMultiEntry.contractDigest,
    bridgeConnectionContractDigest(multiEnvelopeConfig.bridge.connections[0], roleProject),
    'the executed snapshot and persisted contract digest describe the same module graph');

  const multiConnection = multiEnvelopeConfig.bridge.connections[0];
  put(roleProject, 'package.json', JSON.stringify({ name: 'bridge-fixture', dependencies: { vendor: '1.0.0' } }, null, 2));
  const dependencyContractV1 = bridgeConnectionContractDigest(multiConnection, roleProject);
  put(roleProject, 'package.json', JSON.stringify({ name: 'bridge-fixture', dependencies: { vendor: '9.9.9' } }, null, 2));
  const dependencyContractV2 = bridgeConnectionContractDigest(multiConnection, roleProject);
  assert.notEqual(dependencyContractV1, dependencyContractV2,
    'package manifests are part of the custom adapter contract even without an npm package-lock');

  put(roleProject, 'computed-adapter.mjs', `
const dependency = 'computed-dependency';
export async function collect() { return import('./' + dependency + '.mjs'); }
`);
  assert.throws(() => bridgeConnectionContractDigest({
    id: 'computed-main', adapter: 'computed-adapter', module: 'computed-adapter.mjs',
    role: 'source', permissions: [], options: {},
  }, roleProject), /Computed import\(\) is not allowed/i,
  'a computed module load cannot escape the statically contract-bound graph');

  put(roleProject, 'aliased-require-dependency.cjs', `module.exports = { status: 'passed' };`);
  put(roleProject, 'aliased-require-adapter.cjs', `
const load = require;
const dependency = load('./aliased-require-dependency.cjs');
module.exports = { dependency };
`);
  assert.throws(() => bridgeConnectionContractDigest({
    id: 'aliased-require-main', adapter: 'aliased-require-adapter', module: 'aliased-require-adapter.cjs',
    role: 'source', permissions: [], options: {},
  }, roleProject), /Indirect require references or aliases are not allowed/i,
  'a CommonJS require alias cannot load code outside the statically contract-bound graph');

  put(roleProject, 'bare-adapter.mjs', `import vendor from 'unlocked-vendor'; export function collect() { return vendor; }`);
  assert.throws(() => bridgeConnectionContractDigest({
    id: 'bare-main', adapter: 'bare-adapter', module: 'bare-adapter.mjs',
    role: 'source', permissions: [], options: {},
  }, roleProject), /no supported dependency lockfile/i,
  'third-party adapter imports require a lockfile before evidence can be trusted');

  const finalDelivery = await syncBridge(resolved, {
    publish: true,
    env: {
      AXION_WEBHOOK_ENDPOINT: 'https://hooks.example.test/axion',
      AXION_WEBHOOK_TOKEN: 'test-only-secret-value',
    },
    fetch: async () => new Response(JSON.stringify({ id: 'delivery-44', status: 'accepted' }), {
      status: 202, headers: { 'content-type': 'application/json' },
    }),
  });
  assert.equal(finalDelivery.status, 'passed');

  const studio = await collectStudioSnapshot(project);
  assert.equal(studio.bridge.available, true);
  assert.equal(studio.bridge.path, '.dk/bridge/ledger.json');
  assert.equal(studio.bridge.summary.healthy, 2);
  assert.equal(studio.bridge.connections.find((item) => item.id === 'delivery-hook')?.capability, 'webhook.delivery.publish');

  const inspected = run(project, ['bridge', 'inspect', 'storybook-main', '--json']);
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(JSON.parse(inspected.stdout).payload.capability, 'ui.component-state.discover');
  const missingInspect = run(project, ['bridge', 'inspect', 'missing-connection', '--json']);
  assert.equal(missingInspect.status, 1);
  assert.equal(JSON.parse(missingInspect.stdout).error.code, 'AXION_BRIDGE_NOT_FOUND',
    'machine inspection errors remain structured JSON on stdout');
  const invalidInspect = run(project, ['bridge', 'inspect', '--json']);
  assert.equal(invalidInspect.status, 2);
  assert.equal(JSON.parse(invalidInspect.stdout).error.code, 'AXION_BRIDGE_USAGE',
    'machine-readable arity errors remain structured JSON on stdout');
  assert.equal(invalidInspect.stderr, '');

  assert.throws(() => bridgeGitIdentity(project, { GITHUB_SHA: 'refs/heads/main' }),
    (error) => error?.code === 'AXION_BRIDGE_IDENTITY',
    'malformed CI identity cannot silently disable commit binding');
  const redactedIdentity = bridgeGitIdentity(project, {
    GITHUB_SHA: 'a'.repeat(40),
    CI_REPOSITORY_URL: 'https://username-only-pat@example.test/acme/repo?token=query-secret#fragment',
  });
  assert.equal(redactedIdentity.remote, 'https://example.test/acme/repo');
  const scpSecret = 'nonstandard-user-that-must-not-persist';
  const scpIdentity = bridgeGitIdentity(project, {
    GITHUB_SHA: 'a'.repeat(40),
    CI_REPOSITORY_URL: `${scpSecret}@example.test:acme/repo.git`,
  });
  assert.equal(scpIdentity.remote, 'example.test:acme/repo.git');
  assert(!JSON.stringify(scpIdentity).includes(scpSecret));

  // Offline ingestion is accepted only through the configured adapter's exact
  // collect contract and the same append-only verifier used by live adapters.
  put(ingestProject, 'design/bridge.json', JSON.stringify({
    schema: 'axion-bridge-config/v1',
    connections: [{
      id: 'offline-audit', adapter: 'artifact', role: 'source', required: true,
      trust: 'linked', permissions: ['fs:read', 'network:artifact-origin'],
    }, {
      id: 'offline-sink', adapter: 'webhook', role: 'sink', required: false,
      trust: 'linked', permissions: [],
    }],
  }, null, 2));
  put(ingestProject, 'dk.config.json', JSON.stringify({
    bridge: { enabled: true, source: 'design/bridge.json', artifactDir: '.dk/bridge', freshnessMs: 86_400_000 },
  }, null, 2));
  const offlineEnvelope = createIntegrationEnvelope({
    provider: 'generic-artifact', kind: 'collect/generic-artifact',
    trust: { level: 'self-attested', issuer: 'offline-test', evidence: ['fixture:local'] },
    binding: { repository: null, commit: null }, permissions: ['fs:read', 'network:artifact-origin'],
    payload: { status: 'passed', capability: 'offline.proof', findings: [], metadata: {} },
  });
  put(ingestProject, 'offline-envelope.json', JSON.stringify(offlineEnvelope, null, 2));
  const ingested = run(ingestProject, ['bridge', 'ingest', 'offline-audit', 'offline-envelope.json', '--json']);
  assert.equal(ingested.status, 0, ingested.stderr);
  assert.equal(JSON.parse(ingested.stdout).envelope, offlineEnvelope.id);

  const verifiedForgery = createIntegrationEnvelope({
    provider: 'generic-artifact', kind: 'collect/generic-artifact',
    trust: { level: 'verified', issuer: 'offline-test', evidence: ['claimed:signature'] },
    binding: { repository: null, commit: null }, permissions: ['fs:read', 'network:artifact-origin'],
    payload: { status: 'passed', capability: 'offline.proof', findings: [], metadata: {} },
  });
  put(ingestProject, 'verified-forgery.json', JSON.stringify(verifiedForgery, null, 2));
  const rejectedForgery = run(ingestProject, ['bridge', 'ingest', 'offline-audit', 'verified-forgery.json', '--json']);
  assert.equal(rejectedForgery.status, 1, 'offline ingest cannot self-authenticate verified trust');
  assert(JSON.parse(rejectedForgery.stdout).error.issues.some((issue) => issue.code === 'offline-trust-ceiling'));

  const offProviderEnvelope = createIntegrationEnvelope({
    provider: 'storybook', kind: 'collect/storybook',
    trust: { level: 'self-attested', issuer: 'offline-test', evidence: [] },
    binding: { repository: null, commit: null }, permissions: ['fs:read', 'network:artifact-origin'],
    payload: { status: 'passed', capability: 'offline.proof', findings: [], metadata: {} },
  });
  const ingestResolved = await loadConfig(ingestProject);
  await assert.rejects(() => ingestBridgeEnvelope(ingestResolved, 'offline-audit', offProviderEnvelope),
    (error) => error?.issues?.some((issue) => issue.code === 'provider-denied'),
    'offline evidence cannot impersonate another adapter provider');
  await assert.rejects(() => ingestBridgeEnvelope(ingestResolved, 'offline-sink', offlineEnvelope),
    (error) => error?.code === 'AXION_BRIDGE_INPUT',
    'offline evidence cannot be appended to a sink-only connection');

  const wrongPermissionEnvelope = createIntegrationEnvelope({
    provider: 'generic-artifact', kind: 'collect/generic-artifact',
    trust: { level: 'self-attested', issuer: 'offline-test', evidence: [] },
    binding: { repository: null, commit: null }, permissions: ['fs:read'],
    payload: { status: 'passed', capability: 'offline.proof', findings: [], metadata: {} },
  });
  await assert.rejects(() => ingestBridgeEnvelope(ingestResolved, 'offline-audit', wrongPermissionEnvelope),
    (error) => error?.issues?.some((issue) => issue.code === 'permission-contract-mismatch'),
    'offline evidence permissions must exactly match the collect manifest');

  const wrongRepositoryEnvelope = createIntegrationEnvelope({
    provider: 'generic-artifact', kind: 'collect/generic-artifact',
    trust: { level: 'self-attested', issuer: 'offline-test', evidence: [] },
    binding: { repository: 'https://example.test/wrong/repository', commit: null },
    permissions: ['fs:read', 'network:artifact-origin'],
    payload: { status: 'passed', capability: 'offline.proof', findings: [], metadata: {} },
  });
  await assert.rejects(() => ingestBridgeEnvelope(ingestResolved, 'offline-audit', wrongRepositoryEnvelope, {
    env: { CI_REPOSITORY_URL: 'https://example.test/acme/repository' },
  }), (error) => error?.issues?.some((issue) => issue.code === 'repository-mismatch'),
  'offline ingestion must enforce repository binding, not only commit binding');

  const oversizedStdin = run(ingestProject, ['bridge', 'ingest', 'offline-audit', '-', '--json'], Buffer.alloc(8 * 1024 * 1024 + 1, 0x20));
  assert.equal(oversizedStdin.status, 2, 'stdin ingest must stop at the bounded 8 MiB input limit');
  assert.equal(run(ingestProject, ['bridge', 'ingest', 'offline-audit', 'missing-envelope.json', '--json']).status, 2,
    'missing ingest files return a controlled input error');

  const gatePass = run(project, ['verify', '--gate', 'bridge', '--json', '--no-cache']);
  assert.equal(gatePass.status, 0, gatePass.stderr);
  assert.equal(JSON.parse(gatePass.stdout).gates.find((gate) => gate.id === 'bridge')?.status, 'ran');

  const failedEnvelope = createIntegrationEnvelope({
    provider: 'generic-artifact', kind: 'collect/generic-artifact',
    trust: { level: 'self-attested', issuer: 'offline-test', evidence: ['fixture:failed'] },
    binding: { repository: null, commit: null }, permissions: ['fs:read', 'network:artifact-origin'],
    payload: { status: 'failed', capability: 'offline.proof', findings: [], metadata: {} },
  });
  put(ingestProject, 'failed-envelope.json', JSON.stringify(failedEnvelope, null, 2));
  assert.equal(run(ingestProject, ['bridge', 'ingest', 'offline-audit', 'failed-envelope.json', '--json']).status, 1,
    'ingest persists non-passing evidence but immediately returns the fail-closed audit code');
  const providerFailed = run(ingestProject, ['bridge', 'status', '--json']);
  assert.equal(providerFailed.status, 1, 'required evidence with payload.status=failed must fail closed');
  assert(JSON.parse(providerFailed.stdout).issues.some((issue) => issue.code === 'provider-failed'));
  assert.equal(run(ingestProject, ['bridge', 'ingest', 'offline-audit', 'offline-envelope.json', '--json']).status, 0,
    'a later passing envelope can recover the provider while preserving append-only history');

  // Normal source evolution is snapshotted into immutable content-addressed
  // objects, so a Storybook rebuild cannot invalidate historical evidence.
  put(project, 'storybook/index.json', JSON.stringify({
    v: 5,
    entries: {
      'button--default': { id: 'button--default', type: 'story', title: 'System/Button', name: 'Default', importPath: './Button.stories.tsx' },
      'button--hover': { id: 'button--hover', type: 'story', title: 'System/Button', name: 'Hover', importPath: './Button.stories.tsx' },
      'button--disabled': { id: 'button--disabled', type: 'story', title: 'System/Button', name: 'Disabled', importPath: './Button.stories.tsx' },
    },
  }, null, 2));
  assert.equal(run(project, ['bridge', 'status', '--json']).status, 0,
    'changing a mutable producer file does not rewrite its historical snapshot');
  const evolvedManifest = JSON.parse(readFileSync(join(project, 'design/bridge.json'), 'utf8'));
  evolvedManifest.connections[0].options.expectedSha256 = createHash('sha256')
    .update(readFileSync(join(project, 'storybook/index.json'))).digest('hex');
  put(project, 'design/bridge.json', JSON.stringify(evolvedManifest, null, 2));
  const evolved = run(project, ['bridge', 'sync', '--json']);
  assert.equal(evolved.status, 0, evolved.stderr);
  const evolvedLedger = JSON.parse(readFileSync(join(project, '.dk/bridge/ledger.json'), 'utf8'));
  const latestSourceArtifact = evolvedLedger.connections
    .findLast((entry) => entry.provider === 'storybook-main' && entry.envelope?.artifacts?.length)
    .envelope.artifacts[0].path;
  assert.match(latestSourceArtifact, /^\.dk\/bridge\/objects\/[a-f0-9]{64}$/);

  // Mutating the immutable snapshot itself is still detected globally; a
  // newer provider green light cannot hide object-store tampering.
  writeFileSync(join(project, latestSourceArtifact), 'tampered');
  const tampered = run(project, ['bridge', 'status', '--json']);
  assert.equal(tampered.status, 1);
  assert(JSON.parse(tampered.stdout).issues.some((issue) => issue.code === 'artifact-size' || issue.code === 'artifact-digest'));
  const tamperedList = run(project, ['bridge', 'list', '--json']);
  assert.equal(tamperedList.status, 1, 'list must fail closed when the global ledger is invalid');
  assert.equal(JSON.parse(tamperedList.stdout).ledger.ok, false);
  assert(JSON.parse(tamperedList.stdout).issues.length > 0, 'list JSON must expose global ledger issues');
  const tamperedPlainList = run(project, ['bridge', 'list']);
  assert.match(tamperedPlainList.stdout, /Global ledger issues[\s\S]+artifact-(?:size|digest)/,
    'plain list must expose global ledger tamper issues, not only per-connection state');
  const gateFail = run(project, ['verify', '--gate', 'bridge', '--json', '--no-cache']);
  assert.equal(gateFail.status, 1);
  assert(JSON.parse(gateFail.stdout).findings.some((finding) => finding.ruleId === 'bridge/invalid-evidence'));

  const initialized = run(initProject, ['bridge', 'init', '--json']);
  assert.equal(initialized.status, 0, initialized.stderr);
  assert.equal(JSON.parse(readFileSync(join(initProject, 'design/bridge.json'), 'utf8')).schema, 'axion-bridge-config/v1');
  const overwrite = run(initProject, ['bridge', 'init', '--json']);
  assert.equal(overwrite.status, 2, 'bridge init must never overwrite an existing manifest');

  const unsafeManifest = JSON.parse(readFileSync(join(initProject, 'design/bridge.json'), 'utf8'));
  unsafeManifest.connections.push({
    id: 'unsafe-hook', adapter: 'webhook',
    options: { endpoint: 'https://hooks.example.test/receive?token=must-not-live-here' },
  });
  writeFileSync(join(initProject, 'design/bridge.json'), `${JSON.stringify(unsafeManifest, null, 2)}\n`);
  assert.equal(run(initProject, ['bridge', 'doctor', '--json']).status, 2,
    'credential-bearing URLs in nested options must fail config validation');
  unsafeManifest.connections = [{
    id: 'inline-secret', adapter: 'artifact', role: 'source',
    permissions: ['fs:read', 'network:artifact-origin'],
    options: { clientCredential: 'must-not-live-in-config' },
  }];
  writeFileSync(join(initProject, 'design/bridge.json'), `${JSON.stringify(unsafeManifest, null, 2)}\n`);
  assert.equal(run(initProject, ['bridge', 'doctor', '--json']).status, 2,
    'clientCredential and other credential-shaped keys cannot bypass inline-secret rejection');
  unsafeManifest.connections[0].options = { clientCredentials: 'plural-must-not-live-in-config' };
  writeFileSync(join(initProject, 'design/bridge.json'), `${JSON.stringify(unsafeManifest, null, 2)}\n`);
  assert.equal(run(initProject, ['bridge', 'doctor', '--json']).status, 2,
    'plural credential-shaped keys cannot bypass inline-secret rejection');
  unsafeManifest.connections[0].options = { tokenEnv: 'not-an-env-name!' };
  writeFileSync(join(initProject, 'design/bridge.json'), `${JSON.stringify(unsafeManifest, null, 2)}\n`);
  assert.equal(run(initProject, ['bridge', 'doctor', '--json']).status, 2,
    '*Env escape hatches must contain a bounded portable environment-variable name');
  put(initProject, 'dk.config.json', JSON.stringify({ bridge: { source: '../outside-bridge.json' } }, null, 2));
  assert.equal(run(initProject, ['bridge', 'status', '--json']).status, 2,
    'repository-owned manifests cannot escape the project root');

  put(duplicateProject, 'design/bridge.json', JSON.stringify({
    schema: 'axion-bridge-config/v1',
    connections: [
      { id: 'duplicate-source', adapter: 'artifact', required: true },
      { id: 'duplicate-source', adapter: 'storybook', required: false },
    ],
  }, null, 2));
  const duplicateStatus = run(duplicateProject, ['bridge', 'status', '--json']);
  assert.equal(duplicateStatus.status, 2, 'duplicate manifest ids cannot silently override required policy');
  const duplicateError = JSON.parse(duplicateStatus.stdout);
  assert.equal(duplicateError.error.code, 'AXION_BRIDGE_CONFIG');
  assert(duplicateError.error.issues.some((issue) => /repeats connection\.id duplicate-source|connection\.id duplicate-source.*重複/i.test(issue.message)),
    'machine callers receive structured config errors instead of an empty stdout artifact');

  put(noiseProject, 'dk.config.mjs', `
console.log('PROJECT_CONFIG_NOISE_MUST_NOT_CORRUPT_JSON');
export default { bridge: { enabled: true, connections: [] } };
`);
  const noisyStatus = run(noiseProject, ['bridge', 'status', '--json']);
  assert.equal(noisyStatus.status, 0, noisyStatus.stderr);
  assert.equal(JSON.parse(noisyStatus.stdout).schema, 'axion-bridge-status/v1');
  assert(!noisyStatus.stdout.includes('PROJECT_CONFIG_NOISE'));
  assert.match(noisyStatus.stderr, /suppressed \d+ byte/i);

  process.stdout.write('Bridge system: CLI + adapter + ledger + gate + ingest + tamper path passed\n');
} finally {
  rmSync(project, { recursive: true, force: true });
  rmSync(initProject, { recursive: true, force: true });
  rmSync(roleProject, { recursive: true, force: true });
  rmSync(ingestProject, { recursive: true, force: true });
  rmSync(duplicateProject, { recursive: true, force: true });
  rmSync(noiseProject, { recursive: true, force: true });
}

function put(root, file, content) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`);
}

function run(cwd, args, input) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
    ...(input === undefined ? {} : { input }),
    timeout: 30_000, maxBuffer: 8 * 1024 * 1024,
  });
}
