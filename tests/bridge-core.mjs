import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ADAPTER_MANIFEST_SCHEMA,
  ARTIFACT_LEDGER_SCHEMA,
  AdapterRegistry,
  BridgeRequiredProviderError,
  BridgeValidationError,
  MAX_BRIDGE_LEDGER_BYTES,
  appendArtifactLedger,
  artifactLedgerPath,
  canonicalSha256,
  canonicalStringify,
  createAdapterManifest,
  createBridgeRuntime,
  createFileEnvelopeAdapter,
  createIntegrationEnvelope,
  createMemoryEnvelopeAdapter,
  readArtifactLedger,
  validateAdapterManifest,
  validateIntegrationEnvelope,
  verifyArtifactLedger,
} from '../src/bridge/index.mjs';
import {
  redactUrlCredentials,
  urlCarriesCredentials,
} from '../src/core/credential-safety.mjs';

const NOW = '2026-07-15T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

function envelope(overrides = {}) {
  return createIntegrationEnvelope({
    provider: 'fixture',
    kind: 'ui-proof',
    createdAt: NOW,
    expiresAt: '2026-07-16T00:00:00.000Z',
    trust: { level: 'verified', issuer: 'fixture-ci', evidence: ['attestation://fixture/1'] },
    binding: { repository: 'fixture/repo', commit: COMMIT },
    permissions: ['fixture:read'],
    payload: { route: '/', passed: true },
    artifacts: [],
    ...overrides,
  });
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'axion-bridge-'));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeoutMs} ms.`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function captureProcess(child) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => resolve({ code: null, signal: null, stdout, stderr: `${stderr}${error.stack ?? error}` }));
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('canonical JSON and SHA-256 are stable across object key order', () => {
  const left = { z: [3, { b: 2, a: 1 }], a: true };
  const right = { a: true, z: [3, { a: 1, b: 2 }] };
  assert.equal(canonicalStringify(left), canonicalStringify(right));
  assert.equal(canonicalSha256(left), canonicalSha256(right));
  const cyclic = {}; cyclic.self = cyclic;
  assert.throws(() => canonicalStringify(cyclic), BridgeValidationError);
});

test('adapter manifests are versioned, strict, permission-declared, and digest-bound', () => {
  const manifest = createAdapterManifest({
    id: 'figma-file', provider: 'figma', version: '1.2.3',
    lifecycle: ['publish', 'collect'],
    permissions: { collect: ['figma:read'], publish: ['figma:write'] },
  });
  assert.equal(manifest.schema, ADAPTER_MANIFEST_SCHEMA);
  assert.deepEqual(manifest.lifecycle, ['collect', 'publish']);
  assert.equal(validateAdapterManifest(manifest).length, 0);
  assert(validateAdapterManifest({ ...manifest, provider: 'other' }).some((item) => item.code === 'digest-mismatch'));
  assert.throws(() => createAdapterManifest({ id: 'x', lifecycle: ['collect'], permissions: { collect: [], mystery: [] } }), BridgeValidationError);
  assert(validateAdapterManifest({ ...manifest, extra: true }).some((item) => item.code === 'unknown-key'));
});

test('integration envelopes enforce digest, trust, freshness, commit, and permissions', () => {
  const value = envelope();
  assert.equal(validateIntegrationEnvelope(value).length, 0);
  assert.equal(validateIntegrationEnvelope(value, {
    now: NOW, minimumTrust: 'verified', expectedCommit: COMMIT,
    expectedRepository: 'fixture/repo', requiredPermissions: ['fixture:read'],
  }).length, 0);
  assert(validateIntegrationEnvelope({ ...value, payload: { passed: false } }).some((item) => item.code === 'digest-mismatch'));
  assert(validateIntegrationEnvelope({ ...value, unknown: true }).some((item) => item.code === 'unknown-key'));
  assert(validateIntegrationEnvelope(value, { now: '2026-07-17T00:00:00.000Z' }).some((item) => item.code === 'stale'));
  assert(validateIntegrationEnvelope(value, { minimumTrust: 'verified', expectedCommit: 'b'.repeat(40) }).some((item) => item.code === 'commit-mismatch'));
  const weak = envelope({ trust: { level: 'untrusted', issuer: 'fixture', evidence: [] } });
  assert(validateIntegrationEnvelope(weak, { minimumTrust: 'self-attested' }).some((item) => item.code === 'insufficient-trust'));
  assert(validateIntegrationEnvelope(value, { requiredPermissions: ['fixture:write'] }).some((item) => item.code === 'permission-missing'));
});

test('registry rejects duplicate providers and lifecycle/implementation mismatch', () => {
  const registry = new AdapterRegistry();
  const first = createMemoryEnvelopeAdapter({ id: 'mem-a', provider: 'memory-a' });
  registry.register(first);
  assert.throws(() => registry.register(createMemoryEnvelopeAdapter({ id: 'mem-b', provider: 'memory-a' })), /duplicate/i);
  const manifest = createAdapterManifest({ id: 'broken', lifecycle: ['collect'], permissions: { collect: [] } });
  assert.throws(() => registry.register({ manifest }), /implement collect/);
});

test('memory adapter supports publish/discover/collect through permission-gated runtime', async () => {
  const ws = workspace();
  try {
    const registry = new AdapterRegistry([createMemoryEnvelopeAdapter()]);
    const runtime = createBridgeRuntime({
      registry, root: ws.root, artifactDir: 'bridge-artifacts',
      permissions: ['memory:*'], requiredProviders: ['memory'],
      repository: 'fixture/repo', commit: COMMIT, now: () => new Date(NOW),
      envelopePolicy: { minimumTrust: 'verified', expectedRepository: 'fixture/repo' },
    });
    const value = envelope();
    const published = await runtime.publish({ envelope: value }, { provider: 'memory' });
    assert.equal(published.status, 'passed');
    const discovered = await runtime.discover({}, { provider: 'memory' });
    assert.equal(discovered.results[0].value[0].digest, value.digest);
    const collected = await runtime.collect({ id: value.id }, { provider: 'memory' });
    assert.equal(collected.results[0].value[0].id, value.id);

    const ledgerPath = join(ws.root, 'bridge-artifacts', 'ledger.json');
    assert.equal(artifactLedgerPath(ws.root, 'bridge-artifacts'), ledgerPath);
    const loaded = readArtifactLedger(ws.root, { artifactDir: 'bridge-artifacts' });
    assert.equal(loaded.ok, true, JSON.stringify(loaded.issues));
    assert.equal(loaded.ledger.schema, ARTIFACT_LEDGER_SCHEMA);
    assert.equal(loaded.ledger.repository.commit, COMMIT);
    assert.equal(loaded.ledger.connections.length, 3);
    assert.deepEqual(loaded.ledger.summary, { total: 3, healthy: 3, failed: 0, incomplete: 0, requiredFailed: 0 });
  } finally { ws.cleanup(); }
});

test('runtime denies undeclared grants before calling an adapter', async () => {
  const ws = workspace();
  try {
    const runtime = createBridgeRuntime({
      registry: new AdapterRegistry([createMemoryEnvelopeAdapter()]), root: ws.root,
      permissions: [], requiredProviders: ['memory'], now: () => new Date(NOW),
    });
    await assert.rejects(() => runtime.collect({}), (error) => {
      assert(error instanceof BridgeRequiredProviderError);
      assert.equal(error.run.results[0].error.code, 'AXION_BRIDGE_PERMISSION');
      return true;
    });
    const ledger = readArtifactLedger(ws.root);
    assert.equal(ledger.ledger.summary.requiredFailed, 1);
  } finally { ws.cleanup(); }
});

test('required provider is fail-closed and persisted as incomplete when missing', async () => {
  const ws = workspace();
  try {
    const runtime = createBridgeRuntime({
      root: ws.root, registry: new AdapterRegistry(), requiredProviders: ['figma'],
      now: () => new Date(NOW),
    });
    await assert.rejects(() => runtime.discover(), (error) => {
      assert(error instanceof BridgeRequiredProviderError);
      assert.equal(error.run.summary.requiredFailed, 1);
      return true;
    });
    const loaded = readArtifactLedger(ws.root);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.ledger.connections[0].adapter, 'figma');
    assert.equal(loaded.ledger.connections[0].status, 'incomplete');
    assert.equal(loaded.ledger.summary.requiredFailed, 1);
  } finally { ws.cleanup(); }
});

test('optional provider failure remains visible without failing the whole call', async () => {
  const ws = workspace();
  try {
    const manifest = createAdapterManifest({ id: 'optional', lifecycle: ['discover'], permissions: { discover: [] } });
    const registry = new AdapterRegistry([{ manifest, async discover() { throw new Error('offline'); } }]);
    const runtime = createBridgeRuntime({ root: ws.root, registry, now: () => new Date(NOW) });
    const result = await runtime.discover();
    assert.equal(result.status, 'failed');
    assert.equal(result.results[0].error.message, 'offline');
    const selected = await runtime.discover({}, { provider: 'optional' });
    assert.equal(selected.status, 'failed', 'selecting an optional provider must not silently promote it to required');
    assert.equal(selected.results[0].required, false);
    const loaded = readArtifactLedger(ws.root);
    assert.equal(loaded.ledger.summary.failed, 2);
    assert.equal(loaded.ledger.summary.requiredFailed, 0);
  } finally { ws.cleanup(); }
});

test('runtime withholds raw adapter failures from the ledger and verifier rejects legacy exposure', async () => {
  const ws = workspace();
  try {
    const secret = 'correct-horse-battery-staple';
    const dsn = `postgres://bridge:${secret}@db.example.test/design`;
    const manifest = createAdapterManifest({ id: 'hostile-error', lifecycle: ['discover'], permissions: { discover: [] } });
    const adapter = {
      manifest,
      async discover() {
        const error = new Error(`database failed at ${dsn}; password=${secret}`);
        error.code = `password=${secret}`;
        throw error;
      },
    };
    const runtime = createBridgeRuntime({ root: ws.root, registry: new AdapterRegistry([adapter]), now: () => new Date(NOW) });
    const run = await runtime.discover();
    assert.equal(run.status, 'failed');
    assert.equal(run.results[0].error.code, 'AXION_BRIDGE_ADAPTER');
    assert.match(run.results[0].error.message, /raw diagnostics are withheld/i);
    assert.doesNotMatch(JSON.stringify(run), new RegExp(secret));

    const loaded = readArtifactLedger(ws.root);
    assert.equal(loaded.ok, true, JSON.stringify(loaded.issues));
    assert.deepEqual(loaded.ledger.connections[0].error, {
      code: 'AXION_BRIDGE_ADAPTER',
      message: 'Bridge operation failed; raw diagnostics are withheld from the evidence ledger.',
    });
    assert.doesNotMatch(readFileSync(loaded.path, 'utf8'), new RegExp(secret));
    assert.doesNotMatch(readFileSync(loaded.path, 'utf8'), /postgres:\/\//i);

    const exposed = JSON.parse(JSON.stringify(loaded.ledger));
    exposed.connections[0].error.message = `password=${secret}`;
    const rejected = verifyArtifactLedger(exposed);
    assert.equal(rejected.ok, false);
    assert(rejected.issues.some((issue) => issue.path === '$.connections[0].error' && issue.code === 'credential-exposure'));
    assert(rejected.issues.some((issue) => issue.path === '$.connections[0].error' && issue.code === 'error-canonical'));
  } finally { ws.cleanup(); }
});

test('adapter timeout aborts and fails a required provider', async () => {
  const ws = workspace();
  try {
    const manifest = createAdapterManifest({ id: 'slow', lifecycle: ['collect'], permissions: { collect: [] } });
    const slow = {
      manifest,
      collect(_input, { signal }) {
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      },
    };
    const runtime = createBridgeRuntime({ root: ws.root, registry: new AdapterRegistry([slow]), requiredProviders: ['slow'], timeoutMs: 25, now: () => new Date(NOW) });
    await assert.rejects(() => runtime.collect({}), (error) => {
      assert(error instanceof BridgeRequiredProviderError);
      assert.equal(error.run.results[0].error.code, 'AXION_BRIDGE_TIMEOUT');
      return true;
    });
  } finally { ws.cleanup(); }
});

test('external AbortSignal propagates a structured abort failure', async () => {
  const ws = workspace();
  try {
    const manifest = createAdapterManifest({ id: 'abortable', lifecycle: ['discover'], permissions: { discover: [] } });
    const adapter = { manifest, discover: () => new Promise(() => {}) };
    const runtime = createBridgeRuntime({
      root: ws.root, registry: new AdapterRegistry([adapter]), requiredProviders: ['abortable'],
      timeoutMs: 5_000, now: () => new Date(NOW),
    });
    const controller = new AbortController();
    const pending = runtime.discover({}, { provider: 'abortable', signal: controller.signal });
    controller.abort('test abort');
    await assert.rejects(() => pending, (error) => {
      assert.equal(error.run.results[0].error.code, 'AXION_BRIDGE_ABORTED');
      return true;
    });
  } finally { ws.cleanup(); }
});

test('file envelope adapter is bounded to its root and interoperates through runtime', async () => {
  const ws = workspace();
  try {
    const files = join(ws.root, 'envelopes');
    const fileAdapter = createFileEnvelopeAdapter({ root: files });
    const runtime = createBridgeRuntime({
      root: ws.root, registry: new AdapterRegistry([fileAdapter]),
      permissions: ['file:*'], requiredProviders: ['file'],
      repository: 'fixture/repo', commit: COMMIT, now: () => new Date(NOW),
    });
    const value = envelope();
    await runtime.publish({ envelope: value, path: 'nested/proof.json' }, { provider: 'file' });
    const collected = await runtime.collect({ path: 'nested/proof.json' }, { provider: 'file' });
    assert.equal(collected.results[0].value[0].digest, value.digest);
    await assert.rejects(() => fileAdapter.publish({ envelope: value, path: '../escape.json' }), /Unsafe relative path/);

    const outside = join(ws.root, 'outside'); mkdirSync(outside);
    symlinkSync(outside, join(files, 'linked'));
    await assert.rejects(() => fileAdapter.collect({ path: 'linked' }), /Symlink traversal/);
  } finally { ws.cleanup(); }
});

test('ledger verifies chain, canonical digest, summaries, and artifact bytes', () => {
  const ws = workspace();
  try {
    mkdirSync(join(ws.root, 'proof'));
    const artifactPath = join(ws.root, 'proof', 'screen.png');
    const bytes = Buffer.from('not-really-a-png');
    writeFileSync(artifactPath, bytes);
    const value = envelope({
      artifacts: [{
        path: 'proof/screen.png', mediaType: 'image/png', bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }],
    });
    appendArtifactLedger(ws.root, {
      adapter: 'fixture', provider: 'fixture', operation: 'collect', required: true,
      status: 'healthy', trust: 'verified', envelope: value, durationMs: 12,
    }, { artifactDir: 'records', repository: 'fixture/repo', commit: COMMIT, now: NOW });
    const loaded = readArtifactLedger(ws.root, { artifactDir: 'records' });
    assert.equal(loaded.ok, true, JSON.stringify(loaded.issues));
    assert.equal(verifyArtifactLedger(loaded.ledger, { root: ws.root }).ok, true);
    const snapshotRelative = loaded.ledger.connections[0].envelope.artifacts[0].path;
    assert.equal(snapshotRelative, `records/objects/${createHash('sha256').update(bytes).digest('hex')}`);
    const snapshotPath = join(ws.root, snapshotRelative);

    writeFileSync(artifactPath, 'tampered');
    assert.equal(readArtifactLedger(ws.root, { artifactDir: 'records' }).ok, true,
      'normal source regeneration cannot invalidate immutable historical evidence');

    writeFileSync(snapshotPath, 'tampered');
    const tamperedArtifact = readArtifactLedger(ws.root, { artifactDir: 'records' });
    assert.equal(tamperedArtifact.ok, false);
    assert(tamperedArtifact.issues.some((item) => item.code === 'artifact-size' || item.code === 'artifact-digest'));

    writeFileSync(snapshotPath, bytes);
    const path = join(ws.root, 'records', 'ledger.json');
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    onDisk.connections[0].status = 'failed';
    writeFileSync(path, `${JSON.stringify(onDisk, null, 2)}\n`);
    const tamperedLedger = readArtifactLedger(ws.root, { artifactDir: 'records' });
    assert.equal(tamperedLedger.ok, false);
    assert(tamperedLedger.issues.some((item) => ['summary-mismatch', 'id-mismatch', 'hash-mismatch', 'digest-mismatch'].includes(item.code)));
  } finally { ws.cleanup(); }
});

test('content-addressed JSON snapshots refuse credential-shaped raw fields', () => {
  const ws = workspace();
  try {
    mkdirSync(join(ws.root, 'proof'));
    const bytes = Buffer.from(JSON.stringify({ status: 'passed', api_token: 'must-not-persist' }));
    writeFileSync(join(ws.root, 'proof', 'unsafe.json'), bytes);
    const value = envelope({
      artifacts: [{
        path: 'proof/unsafe.json', mediaType: 'application/json', bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }],
    });
    assert.throws(() => appendArtifactLedger(ws.root, {
      adapter: 'fixture', provider: 'fixture', operation: 'collect', required: true,
      status: 'healthy', trust: 'verified', envelope: value,
    }, { artifactDir: 'records', repository: 'fixture/repo', commit: COMMIT, now: NOW }),
    /credential-shaped JSON artifact field/i);
    assert.equal(existsSync(join(ws.root, 'records', 'ledger.json')), false);
    assert.equal(existsSync(join(ws.root, 'records', 'ledger.json.lock')), false);

    const disguised = Buffer.from(JSON.stringify({ status: 'passed', clientCredentials: 'also-must-not-persist' }));
    writeFileSync(join(ws.root, 'proof', 'disguised.txt'), disguised);
    assert.throws(() => appendArtifactLedger(ws.root, {
      adapter: 'fixture', provider: 'fixture', operation: 'collect', required: true,
      status: 'healthy', trust: 'verified', envelope: envelope({ artifacts: [{
        path: 'proof/disguised.txt', mediaType: 'text/plain', bytes: disguised.length,
        sha256: createHash('sha256').update(disguised).digest('hex'),
      }] }),
    }, { artifactDir: 'records-disguised', repository: 'fixture/repo', commit: COMMIT, now: NOW }),
    /credential-shaped JSON artifact field/i,
    'JSON content sniffing must not trust a self-declared non-JSON media type');

    assert.throws(() => appendArtifactLedger(ws.root, {
      adapter: 'fixture', provider: 'fixture', operation: 'collect', required: true,
      status: 'healthy', trust: 'verified', envelope: envelope({
        payload: { status: 'passed', accessToken: 'offline-envelope-token-must-not-persist' },
      }),
    }, { artifactDir: 'records-envelope', repository: 'fixture/repo', commit: COMMIT, now: NOW }),
    /credential-shaped field \$\.payload\.accessToken/i,
    'offline/custom envelopes are scanned even when they contain no artifact');
  } finally { ws.cleanup(); }
});

test('credential scanning rejects numeric secrets but permits explicit non-secret numeric metadata', () => {
  const unsafe = workspace();
  try {
    assert.throws(() => appendArtifactLedger(unsafe.root, {
      adapter: 'fixture', provider: 'fixture', operation: 'collect', required: true,
      status: 'healthy', trust: 'verified', envelope: envelope({ payload: { status: 'passed', password: 123456 } }),
    }, { artifactDir: 'records', now: NOW }), /credential-shaped field \$\.payload\.password/i);
    assert.equal(existsSync(join(unsafe.root, 'records', 'ledger.json')), false);
  } finally { unsafe.cleanup(); }

  const safe = workspace();
  try {
    const digest = 'b'.repeat(64);
    appendArtifactLedger(safe.root, {
      adapter: 'fixture', provider: 'fixture', operation: 'collect', required: true,
      status: 'healthy', trust: 'verified', envelope: envelope({
        payload: {
          status: 'passed', passwordLength: 12, tokenCount: 4,
          hasCredentials: false, passwordHash: digest,
        },
      }),
    }, { artifactDir: 'records', now: NOW });
    assert.equal(readArtifactLedger(safe.root, { artifactDir: 'records' }).ok, true);
  } finally { safe.cleanup(); }
});

test('credential-bearing non-HTTP DSNs are detected, redacted, and refused in evidence', () => {
  const secret = 'dsn-password';
  const dsn = `postgres://bridge:${secret}@db.example.test/design?sslmode=require#token=fragment-secret`;
  assert.equal(urlCarriesCredentials(dsn), true);
  const redacted = redactUrlCredentials(dsn);
  assert.equal(redacted, 'postgres://db.example.test/design?sslmode=require');
  assert.doesNotMatch(redacted, /bridge|dsn-password|fragment-secret/);
  assert.equal(urlCarriesCredentials('postgres://db.example.test/design?sslmode=require'), false);

  const ws = workspace();
  try {
    assert.throws(() => appendArtifactLedger(ws.root, {
      adapter: 'fixture', provider: 'fixture', operation: 'collect', required: true,
      status: 'healthy', trust: 'verified', envelope: envelope({ payload: { status: 'passed', database: dsn } }),
    }, { artifactDir: 'records', now: NOW }), /credential-bearing URL/i);
    assert.equal(existsSync(join(ws.root, 'records', 'ledger.json')), false);
  } finally { ws.cleanup(); }
});

test('ledger verification is total for malformed connection entries', () => {
  const malformed = {
    schema: ARTIFACT_LEDGER_SCHEMA,
    generatedAt: NOW,
    repository: { root: 'fixture/repo', commit: COMMIT },
    connections: [null],
    summary: { total: 1, healthy: 0, failed: 0, incomplete: 0, requiredFailed: 0 },
    headHash: null,
    digest: '0'.repeat(64),
  };
  const verified = verifyArtifactLedger(malformed);
  assert.equal(verified.ok, false);
  assert(verified.issues.some((issue) => issue.path === '$.connections[0]' && issue.code === 'type'));

  const missingSummary = {
    schema: ARTIFACT_LEDGER_SCHEMA,
    generatedAt: NOW,
    repository: { root: 'fixture/repo', commit: COMMIT },
    connections: [],
    headHash: null,
    digest: '0'.repeat(64),
  };
  let missingSummaryResult;
  assert.doesNotThrow(() => { missingSummaryResult = verifyArtifactLedger(missingSummary); });
  assert.equal(missingSummaryResult.ok, false);
  assert(missingSummaryResult.issues.some((issue) => issue.path === '$.summary' && issue.code === 'required'));

  const malformedEnvelope = {
    ...malformed,
    connections: [{
      schema: 'axion-bridge-connection/v1', id: 'con_0000000000000000',
      adapter: 'fixture', provider: 'fixture', operation: 'collect', required: false,
      status: 'healthy', trust: 'untrusted', createdAt: NOW, previousHash: null,
      entryHash: '0'.repeat(64), envelope: {},
    }],
  };
  let malformedEnvelopeResult;
  assert.doesNotThrow(() => { malformedEnvelopeResult = verifyArtifactLedger(malformedEnvelope); });
  assert.equal(malformedEnvelopeResult.ok, false);
});

test('ledger path is always artifactDir/ledger.json and traversal is rejected', () => {
  const ws = workspace();
  try {
    assert.equal(artifactLedgerPath(ws.root, 'config/artifacts'), join(ws.root, 'config', 'artifacts', 'ledger.json'));
    assert.throws(() => artifactLedgerPath(ws.root, '../outside'), /safe relative path/);
  } finally { ws.cleanup(); }
});

test('ledger reads are centrally bounded for CLI, Studio, gate, and MCP consumers', () => {
  const ws = workspace();
  try {
    const directory = join(ws.root, 'bounded');
    mkdirSync(directory);
    const path = join(directory, 'ledger.json');
    writeFileSync(path, '{}');
    truncateSync(path, MAX_BRIDGE_LEDGER_BYTES + 1);
    const loaded = readArtifactLedger(ws.root, { artifactDir: 'bounded' });
    assert.equal(loaded.ok, false);
    assert(loaded.issues.some((issue) => issue.code === 'ledger-too-large'));
  } finally { ws.cleanup(); }
});

test('ledger artifact verification streams files and enforces the configured byte cap', () => {
  const ws = workspace();
  try {
    mkdirSync(join(ws.root, 'proof'));
    const bytes = Buffer.alloc(2048, 0x61);
    writeFileSync(join(ws.root, 'proof', 'bounded.bin'), bytes);
    const value = envelope({
      artifacts: [{
        path: 'proof/bounded.bin', mediaType: 'application/octet-stream', bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }],
    });
    appendArtifactLedger(ws.root, {
      adapter: 'fixture', provider: 'fixture', operation: 'collect', required: true,
      status: 'healthy', trust: 'verified', envelope: value,
    }, { artifactDir: 'bounded-artifacts', maxArtifactBytes: 4096, now: NOW });
    assert.equal(readArtifactLedger(ws.root, {
      artifactDir: 'bounded-artifacts', maxArtifactBytes: 4096,
    }).ok, true);
    const overPolicy = readArtifactLedger(ws.root, {
      artifactDir: 'bounded-artifacts', maxArtifactBytes: 1024,
    });
    assert.equal(overPolicy.ok, false);
    assert(overPolicy.issues.some((issue) => issue.code === 'artifact-too-large'));
  } finally { ws.cleanup(); }
});

test('ledger append serializes 20 synchronized processes without lost updates or EEXIST races', async () => {
  const ws = workspace();
  try {
    const workerPath = join(ws.root, 'ledger-worker.mjs');
    const runtimeUrl = new URL('../src/bridge/runtime.mjs', import.meta.url).href;
    writeFileSync(workerPath, `
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendArtifactLedger } from ${JSON.stringify(runtimeUrl)};
const [index, root, now] = process.argv.slice(2);
writeFileSync(join(root, \`ready-\${index}\`), '');
while (!existsSync(join(root, 'go'))) await new Promise((resolve) => setTimeout(resolve, 2));
appendArtifactLedger(root, {
  adapter: 'fixture', provider: \`worker-\${index}\`, operation: 'collect', required: false,
  status: 'healthy', trust: 'untrusted', createdAt: now,
}, { artifactDir: 'race-ledger', repository: 'fixture/repo', commit: ${JSON.stringify(COMMIT)}, now });
`);
    const children = Array.from({ length: 20 }, (_, index) => {
      const child = spawn(process.execPath, [workerPath, String(index), ws.root, NOW], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return captureProcess(child);
    });
    await waitUntil(() => Array.from({ length: 20 }, (_, index) => existsSync(join(ws.root, `ready-${index}`))).every(Boolean));
    writeFileSync(join(ws.root, 'go'), '');
    const results = await Promise.all(children);
    assert.deepEqual(results.map(({ code }) => code), Array(20).fill(0), JSON.stringify(results, null, 2));
    assert(results.every(({ stderr }) => stderr === ''), JSON.stringify(results, null, 2));

    const loaded = readArtifactLedger(ws.root, { artifactDir: 'race-ledger' });
    assert.equal(loaded.ok, true, JSON.stringify(loaded.issues));
    assert.equal(loaded.ledger.connections.length, 20);
    assert.equal(new Set(loaded.ledger.connections.map(({ provider }) => provider)).size, 20);
    assert.equal(existsSync(`${loaded.path}.lock`), false);
    assert.equal(existsSync(`${loaded.path}.lock.recovery`), false);
  } finally { ws.cleanup(); }
});

test('ledger append recovers an abandoned stale lock and releases its owned lock on failure', () => {
  const stale = workspace();
  try {
    const ledgerPath = artifactLedgerPath(stale.root, 'stale-ledger');
    mkdirSync(join(stale.root, 'stale-ledger'));
    const lockPath = `${ledgerPath}.lock`;
    writeFileSync(lockPath, '{abandoned');
    const old = new Date(Date.now() - 120_000);
    utimesSync(lockPath, old, old);
    appendArtifactLedger(stale.root, {
      adapter: 'fixture', provider: 'stale-recovery', operation: 'collect', required: false,
      status: 'healthy', trust: 'untrusted', createdAt: NOW,
    }, { artifactDir: 'stale-ledger', now: NOW });
    assert.equal(readArtifactLedger(stale.root, { artifactDir: 'stale-ledger' }).ledger.connections.length, 1);
    assert.equal(existsSync(lockPath), false);
  } finally { stale.cleanup(); }

  const failing = workspace();
  try {
    const directory = join(failing.root, 'invalid-ledger');
    mkdirSync(directory);
    const ledgerPath = join(directory, 'ledger.json');
    writeFileSync(ledgerPath, '{}');
    assert.throws(() => appendArtifactLedger(failing.root, {
      adapter: 'fixture', provider: 'failure-cleanup', operation: 'collect', required: false,
      status: 'healthy', trust: 'untrusted', createdAt: NOW,
    }, { artifactDir: 'invalid-ledger', now: NOW }), /invalid Bridge ledger/i);
    assert.equal(existsSync(`${ledgerPath}.lock`), false);
  } finally { failing.cleanup(); }
});

let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    passed++;
    process.stdout.write(`\u2713 ${name}\n`);
  } catch (error) {
    process.stderr.write(`\u2717 ${name}\n${error?.stack ?? error}\n`);
    process.exitCode = 1;
    break;
  }
}
if (!process.exitCode) process.stdout.write(`Bridge core: ${passed}/${tests.length} passed\n`);
