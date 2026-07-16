import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  AdapterRegistry,
  INTEGRATION_ENVELOPE_SCHEMA,
  createBridgeRuntime,
  createIntegrationEnvelope,
  readArtifactLedger,
  validateAdapterManifest,
  validateIntegrationEnvelope,
} from '../src/bridge/index.mjs';
import * as chromatic from '../src/bridge/adapters/chromatic.mjs';
import * as figma from '../src/bridge/adapters/figma.mjs';
import * as genericArtifact from '../src/bridge/adapters/generic-artifact.mjs';
import * as github from '../src/bridge/adapters/github.mjs';
import * as preview from '../src/bridge/adapters/preview.mjs';
import * as storybook from '../src/bridge/adapters/storybook.mjs';
import * as webhookSink from '../src/bridge/adapters/webhook-sink.mjs';

const NOW = '2026-07-15T00:00:00.000Z';
const COMMIT = 'a'.repeat(40);
const OTHER_COMMIT = 'b'.repeat(40);
const REPOSITORY = 'acme/app';
const FIGMA_TOKEN = 'figma-secret-token-123';
const GITHUB_TOKEN = 'github-secret-token-123';
const WEBHOOK_TOKEN = 'webhook-secret-token-123';
const WEBHOOK_PATH_SECRET = 'whsec-path-secret-456';
const WEBHOOK_RESPONSE_SECRET = 'response-path-secret-789';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function assertEnvelope(value, provider = null) {
  assert.equal(value.schema, INTEGRATION_ENVELOPE_SCHEMA);
  assert.equal(validateIntegrationEnvelope(value).length, 0, JSON.stringify(validateIntegrationEnvelope(value)));
  if (provider) assert.equal(value.provider, provider);
  assert(['untrusted', 'self-attested', 'verified'].includes(value.trust.level));
  assert.notEqual(value.trust.level, 'approved');
  assert.notEqual(value.payload.status, 'approved');
  assert.equal(value.payload.metadata.externalTrustCeiling, 'verified');
  assert.equal(value.payload.metadata.approvalAuthority, false);
  return value;
}

function fixtureEnvelope(findings = [], metadata = {}) {
  return createIntegrationEnvelope({
    provider: 'fixture',
    kind: 'collect/fixture',
    createdAt: NOW,
    expiresAt: '2026-07-16T00:00:00.000Z',
    trust: { level: 'verified', issuer: 'fixture-ci', evidence: ['fixture:attestation'] },
    binding: { repository: REPOSITORY, commit: COMMIT },
    permissions: [],
    payload: {
      status: 'failed', capability: 'fixture.verify', providerVersion: '1.0.0',
      coverage: { complete: true }, findings, metadata,
    },
    artifacts: [],
  });
}

function startMockServer() {
  const seen = { figmaTokens: [], github: [], webhooks: [] };
  const storybookIndex = {
    v: 5,
    entries: {
      'button--primary': { id: 'button--primary', title: 'Atoms/Button', name: 'Primary', type: 'story', importPath: './Button.stories.js' },
      'button--disabled': { id: 'button--disabled', title: 'Atoms/Button', name: 'Disabled', type: 'story' },
      'button--docs': { id: 'button--docs', title: 'Atoms/Button', name: 'Docs', type: 'docs' },
      'input--empty': { id: 'input--empty', title: 'Atoms/Input', name: 'Empty', type: 'story' },
    },
  };
  const genericBody = Buffer.from(JSON.stringify({ schema: 'vendor-proof/v1', status: 'passed', repository: REPOSITORY, commit: COMMIT }));
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const readBody = async () => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      return Buffer.concat(chunks);
    };
    if (url.pathname === '/storybook/index.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(storybookIndex));
      return;
    }
    if (url.pathname === '/figma/v1/files/FILE_1') {
      seen.figmaTokens.push(request.headers['x-figma-token']);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        name: 'Axion',
        components: { c1: { name: 'Button', description: 'Primary action', key: 'key-1' } },
        componentSets: { cs1: { name: 'Button states', key: 'set-1' } },
        styles: { s1: { name: 'Brand/Primary', styleType: 'FILL' } },
      }));
      return;
    }
    if (url.pathname === '/figma/v1/files/FILE_1/variables/local') {
      seen.figmaTokens.push(request.headers['x-figma-token']);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ meta: { variables: {
        v1: { name: 'color.brand.primary', resolvedType: 'COLOR', variableCollectionId: 'collection-1', valuesByMode: { light: '#3366ff' } },
      } } }));
      return;
    }
    if (url.pathname === '/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'x-axion-commit': COMMIT });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: '/health' });
      response.end();
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => {
        if (!response.destroyed) {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ ok: true, commit: COMMIT }));
        }
      }, 250);
      return;
    }
    if (url.pathname === '/generic.json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(genericBody);
      return;
    }
    if (url.pathname.endsWith('/repos/acme/app/check-runs') && request.method === 'POST') {
      const body = JSON.parse((await readBody()).toString('utf8'));
      seen.github.push({ headers: request.headers, body });
      response.writeHead(201, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ id: 901, html_url: 'https://github.example/checks/901' }));
      return;
    }
    if (url.pathname.startsWith('/hook') && request.method === 'POST') {
      const body = JSON.parse((await readBody()).toString('utf8'));
      seen.webhooks.push({ headers: request.headers, body, path: url.pathname });
      response.writeHead(202, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: 'delivery-1', status: 'accepted',
        url: `https://receipts.example.test/delivery/${WEBHOOK_RESPONSE_SECRET}#token=fragment-secret`,
      }));
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve({
        origin: `http://127.0.0.1:${address.port}`,
        seen,
        storybookIndex,
        genericBody,
        close: () => new Promise((done, fail) => server.close((error) => error ? fail(error) : done())),
      });
    });
  });
}

const root = mkdtempSync(join(tmpdir(), 'axion-bridge-adapters-'));
const mock = await startMockServer();

test('all manifests and default adapters satisfy the current core registry contract', () => {
  const modules = [storybook, figma, preview, github, chromatic, genericArtifact, webhookSink];
  for (const module of modules) {
    assert.equal(validateAdapterManifest(module.manifest).length, 0, module.manifest.id);
    assert(Array.isArray(module.capabilities) && module.capabilities.length > 0, module.manifest.id);
    assert(Object.isFrozen(module.capabilities), module.manifest.id);
    new AdapterRegistry([module.default]);
    assert.deepEqual(Object.keys(module.default).sort(), ['manifest', ...module.manifest.lifecycle].sort());
  }
});

test('Storybook reads local and HTTP index.json and emits component/state coverage', async () => {
  const directory = join(root, 'storybook');
  await import('node:fs/promises').then(({ mkdir }) => mkdir(directory));
  const indexBytes = Buffer.from(JSON.stringify(mock.storybookIndex));
  writeFileSync(join(directory, 'index.json'), indexBytes);
  const local = assertEnvelope(await storybook.collect({ root, source: 'storybook', now: NOW }), 'storybook');
  assert.equal(local.trust.level, 'self-attested');
  assert.equal(local.payload.metadata.producerCommitProven, false);
  assert.deepEqual(local.payload.coverage, { complete: true, components: 2, states: 3, stories: 3 });
  assert.equal(local.payload.metadata.stories[0].id, 'button--disabled');
  const pinned = assertEnvelope(await storybook.collect({
    root, source: 'storybook', expectedSha256: sha256(indexBytes), now: NOW,
  }), 'storybook');
  assert.equal(pinned.trust.level, 'verified');
  assert.equal(pinned.payload.metadata.digestBound, true);
  await assert.rejects(() => storybook.collect({
    root, source: 'storybook', expectedSha256: '0'.repeat(64), now: NOW,
  }), /does not match expectedSha256/i);
  const remote = assertEnvelope(await storybook.collect({ source: `${mock.origin}/storybook`, now: NOW }), 'storybook');
  assert.equal(remote.trust.level, 'self-attested');
  assert.equal(remote.payload.coverage.stories, 3);
  assert(remote.payload.metadata.externalArtifacts[0].uri.endsWith('/storybook/index.json'));
  assert.equal(remote.artifacts.length, 0);
});

test('Storybook default adapter runs through BridgeRuntime and returns the required envelope array', async () => {
  const runtime = createBridgeRuntime({
    root,
    registry: new AdapterRegistry([storybook.default]),
    permissions: storybook.manifest.permissions.collect,
    requiredProviders: ['storybook'],
    now: () => new Date(NOW),
    persistLedger: false,
  });
  const run = await runtime.collect({ source: 'storybook' }, { provider: 'storybook' });
  assert.equal(run.status, 'passed');
  assertEnvelope(run.results[0].value[0], 'storybook');
});

test('remote evidence survives persisted ledger verification without inventing repo-local artifact files', async () => {
  const runtimeRoot = join(root, 'remote-runtime');
  mkdirSync(runtimeRoot);
  const runtime = createBridgeRuntime({
    root: runtimeRoot,
    registry: new AdapterRegistry([storybook.default]),
    permissions: storybook.manifest.permissions.collect,
    requiredProviders: ['storybook'],
    now: () => new Date(NOW),
  });
  const run = await runtime.collect({ source: `${mock.origin}/storybook` }, { provider: 'storybook' });
  assert.equal(run.status, 'passed');
  const envelope = assertEnvelope(run.results[0].value[0], 'storybook');
  assert.equal(envelope.artifacts.length, 0);
  assert.equal(envelope.payload.metadata.externalArtifacts.length, 1);
  const ledger = readArtifactLedger(runtimeRoot);
  assert.equal(ledger.ok, true, JSON.stringify(ledger.issues));
});

test('Figma reads local exports and official REST-shaped file/variables endpoints without persisting tokens', async () => {
  const localPayload = {
    components: { c1: { name: 'Card', key: 'card-key' } },
    tokens: { color: { brand: { $type: 'color', $value: '#3366ff' } } },
  };
  writeFileSync(join(root, 'figma-export.json'), JSON.stringify(localPayload));
  const local = assertEnvelope(await figma.collect({ root, source: 'figma-export.json', now: NOW }), 'figma');
  assert.equal(local.trust.level, 'self-attested');
  const localPinned = assertEnvelope(await figma.collect({
    root, source: 'figma-export.json', expectedSha256: sha256(Buffer.from(JSON.stringify(localPayload))), now: NOW,
  }), 'figma');
  assert.equal(localPinned.trust.level, 'verified');
  assert.equal(local.payload.coverage.components, 1);
  assert.equal(local.payload.coverage.tokens, 1);

  const before = readdirSync(root).sort();
  const remote = assertEnvelope(await figma.collect({
    fileKey: 'FILE_1',
    apiBaseUrl: `${mock.origin}/figma/v1/`,
    testMode: true,
    env: { FIGMA_ACCESS_TOKEN: FIGMA_TOKEN },
    now: NOW,
  }), 'figma');
  assert.equal(remote.trust.level, 'verified');
  assert.equal(remote.payload.metadata.authenticatedSource, true);
  assert.equal(remote.payload.metadata.producerCommitProven, false);
  assert.equal(remote.payload.coverage.components, 1);
  assert.equal(remote.payload.coverage.variables, 1);
  assert.deepEqual(mock.seen.figmaTokens, [FIGMA_TOKEN, FIGMA_TOKEN]);
  assert(!JSON.stringify(remote).includes(FIGMA_TOKEN));
  assert.deepEqual(readdirSync(root).sort(), before);
  await assert.rejects(() => figma.collect({ fileKey: 'FILE_1', token: FIGMA_TOKEN }), /environment variable/);
});

test('Preview verifies health plus commit/URL binding and fails closed on mismatch, redirects, secrets, and timeout', async () => {
  const healthy = assertEnvelope(await preview.collect({
    url: mock.origin, healthPath: '/health', expectedCommit: COMMIT,
    expectedUrl: `${mock.origin}/health`, repository: { remote: REPOSITORY }, now: NOW,
    timeoutMs: 60_000, maxAgeMs: 365 * 24 * 60 * 60_000,
  }), 'preview');
  assert.equal(healthy.trust.level, 'verified');
  assert.equal(healthy.payload.status, 'passed');
  assert.equal(healthy.payload.coverage.commitBound, true);
  assert.equal(healthy.payload.coverage.urlBound, true);

  const mismatch = assertEnvelope(await preview.collect({
    url: mock.origin, healthPath: '/health', expectedCommit: OTHER_COMMIT, now: NOW,
  }), 'preview');
  assert.equal(mismatch.payload.status, 'failed');
  assert.equal(mismatch.trust.level, 'self-attested');
  assert(mismatch.payload.findings.some((finding) => finding.ruleId === 'preview/commit-mismatch'));

  await assert.rejects(() => preview.collect({ url: mock.origin, healthPath: '/redirect' }), /redirect.*refused/i);
  await assert.rejects(() => preview.collect({ url: mock.origin, healthPath: '/slow', timeoutMs: 100 }), /timed out/i);
  await assert.rejects(() => preview.collect({ url: `http://user:pass@127.0.0.1:${new URL(mock.origin).port}` }), /credentials/i);
  await assert.rejects(() => preview.collect({ url: `${mock.origin}?token=leak`, healthPath: '/health' }), /query string/i);
});

test('GitHub discovers Actions context and publishes a commit-bound Check with at most 50 annotations', async () => {
  const env = {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: REPOSITORY, GITHUB_SHA: COMMIT,
    GITHUB_RUN_ID: '42', GITHUB_RUN_ATTEMPT: '1', GITHUB_WORKFLOW: 'ui-proof',
    GITHUB_SERVER_URL: mock.origin, GITHUB_API_URL: `${mock.origin}/api/v3`,
    GITHUB_TOKEN,
  };
  const actions = assertEnvelope(await github.collect({ env, now: NOW }), 'github');
  assert.equal(actions.trust.level, 'verified');
  assert.equal(actions.binding.commit, COMMIT);
  assert(!JSON.stringify(actions).includes(GITHUB_TOKEN));

  const findings = Array.from({ length: 55 }, (_, index) => ({
    ruleId: `contrast/${index}`, severity: index % 2 ? 'warning' : 'error',
    message: index === 0 ? `Finding ${index} accidentally included ${GITHUB_TOKEN}` : `Finding ${index}`,
    file: `src/component-${index}.js`, line: index + 1,
  }));
  const source = fixtureEnvelope(findings);
  const receipt = assertEnvelope(await github.publish({ env, root, now: NOW }, source), 'github');
  assert.equal(mock.seen.github.length, 1);
  assert.equal(mock.seen.github[0].headers.authorization, `Bearer ${GITHUB_TOKEN}`);
  assert.equal(mock.seen.github[0].body.head_sha, COMMIT);
  assert.equal(mock.seen.github[0].body.output.annotations.length, 50);
  assert(!JSON.stringify(mock.seen.github[0].body).includes(GITHUB_TOKEN));
  assert(JSON.stringify(mock.seen.github[0].body).includes('[REDACTED]'));
  assert.equal(receipt.payload.coverage.annotationsOmitted, 5);
  assert.equal(receipt.payload.coverage.complete, false);
  assert(!JSON.stringify(receipt).includes(GITHUB_TOKEN));
  await assert.rejects(() => github.publish({ env: { ...env, GITHUB_SHA: OTHER_COMMIT } }, source), /not bound/i);
});

test('Chromatic binds build/repository/commit while keeping a single pass explicitly non-proven', async () => {
  const envelope = assertEnvelope(await chromatic.collect({
    webhook: {
      status: 'passed', commit: COMMIT, repository: REPOSITORY,
      buildUrl: `${mock.origin}/chromatic/build/7`, buildNumber: 7,
    },
    expectedCommit: COMMIT, expectedRepository: REPOSITORY, testMode: true, now: NOW,
  }), 'chromatic');
  assert.equal(envelope.trust.level, 'verified');
  assert.equal(envelope.payload.status, 'passed');
  assert.equal(envelope.payload.coverage.complete, false);
  assert.equal(envelope.payload.metadata.proven, false);
  assert.equal(envelope.payload.metadata.promotionEligible, false);

  const externalApproval = assertEnvelope(await chromatic.collect({
    webhook: { status: 'approved', commit: COMMIT, repository: REPOSITORY, buildUrl: `${mock.origin}/chromatic/build/8` },
    expectedCommit: COMMIT, expectedRepository: REPOSITORY, testMode: true, now: NOW,
  }), 'chromatic');
  assert.equal(externalApproval.payload.status, 'unknown');
  await assert.rejects(() => chromatic.collect({
    webhook: { status: 'passed', padding: 'x'.repeat(2048) }, maxBytes: 1024, now: NOW,
  }), /Chromatic webhook exceeds the 1024 byte limit/i);
});

test('Generic artifacts support local/HTTP/inline integrity binding and redact vendor secrets', async () => {
  const payload = {
    schema: 'vendor-proof/v1', status: 'approved', repository: REPOSITORY, commit: COMMIT,
    api_token: 'payload-secret-123', clientSecret: 'camel-secret-123', nested: { password: 'password-secret-123' },
    accessKey: 'access-key-secret-123', credentials: 'plural-credentials-secret-123',
    clientCredentials: 'plural-client-credentials-secret-123',
    homepage: 'https://basic-user:basic-pass@example.test/proof?token=url-query-secret#access_token=fragment-secret',
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  const inline = assertEnvelope(await genericArtifact.collect({
    artifact: payload, expectedSha256: sha256(bytes), expectedSchema: 'vendor-proof/v1', now: NOW,
  }), 'generic-artifact');
  assert.equal(inline.trust.level, 'verified');
  assert.equal(inline.payload.status, 'unknown');
  assert.equal(inline.payload.metadata.payload.api_token, '[REDACTED]');
  assert.equal(inline.payload.metadata.payload.clientSecret, '[REDACTED]');
  assert.equal(inline.payload.metadata.payload.accessKey, '[REDACTED]');
  assert.equal(inline.payload.metadata.payload.credentials, '[REDACTED]');
  assert.equal(inline.payload.metadata.payload.clientCredentials, '[REDACTED]');
  assert.equal(inline.payload.metadata.payload.nested.password, '[REDACTED]');
  assert(!JSON.stringify(inline).includes('basic-user'));
  assert(!JSON.stringify(inline).includes('basic-pass'));
  assert(!JSON.stringify(inline).includes('url-query-secret'));
  assert(!JSON.stringify(inline).includes('fragment-secret'));
  assert(inline.payload.findings.some((finding) => finding.ruleId === 'artifact/external-approval-not-authority'));

  writeFileSync(join(root, 'vendor-proof.json'), mock.genericBody);
  const local = assertEnvelope(await genericArtifact.collect({
    root, source: 'vendor-proof.json', expectedSha256: sha256(mock.genericBody), now: NOW,
  }), 'generic-artifact');
  assert.equal(local.payload.status, 'passed');
  const remote = assertEnvelope(await genericArtifact.collect({
    source: `${mock.origin}/generic.json`, expectedSha256: sha256(mock.genericBody), now: NOW,
  }), 'generic-artifact');
  assert.equal(remote.payload.coverage.digestBound, true);

  const mismatch = assertEnvelope(await genericArtifact.collect({
    artifact: payload, expectedSha256: '0'.repeat(64), now: NOW,
  }), 'generic-artifact');
  assert.equal(mismatch.payload.status, 'failed');
  assert.equal(mismatch.trust.level, 'self-attested');
  await assert.rejects(() => genericArtifact.collect({
    artifact: { padding: 'x'.repeat(2048) }, maxBytes: 1024, now: NOW,
  }), /Generic artifact exceeds the 1024 byte limit/i);
});

test('Local artifact readers reject symlink escape from the repository root', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'axion-outside-'));
  try {
    writeFileSync(join(outside, 'escape.json'), JSON.stringify({ status: 'passed' }));
    symlinkSync(join(outside, 'escape.json'), join(root, 'escape.json'));
    await assert.rejects(() => genericArtifact.collect({ root, source: 'escape.json' }), /inside the configured repository root/i);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('Webhook sink enforces HTTPS allowlisting, redacts recursively, and emits stable idempotency keys', async () => {
  const source = fixtureEnvelope([], {
    api_token: 'payload-secret-123',
    nested: {
      password: 'password-secret-123', note: `contains ${WEBHOOK_TOKEN}`,
      homepage: 'https://nested-user:nested-pass@example.test/path?credential=nested-query-secret',
    },
  });
  const ctx = {
    endpoint: `${mock.origin}/hook/services/${WEBHOOK_PATH_SECRET}`, allowlist: [mock.origin], testMode: true,
    env: { AXION_WEBHOOK_TOKEN: WEBHOOK_TOKEN }, now: NOW,
  };
  const first = assertEnvelope(await webhookSink.publish(ctx, source), 'webhook-sink');
  const second = assertEnvelope(await webhookSink.publish(ctx, source), 'webhook-sink');
  assert.equal(mock.seen.webhooks.length, 2);
  assert(mock.seen.webhooks[0].path.includes(WEBHOOK_PATH_SECRET), 'delivery must still target the configured path');
  assert.equal(mock.seen.webhooks[0].headers.authorization, `Bearer ${WEBHOOK_TOKEN}`);
  assert.equal(mock.seen.webhooks[0].headers['idempotency-key'], mock.seen.webhooks[1].headers['idempotency-key']);
  const delivered = JSON.stringify(mock.seen.webhooks[0].body);
  assert(!delivered.includes('payload-secret-123'));
  assert(!delivered.includes('password-secret-123'));
  assert(!delivered.includes(WEBHOOK_TOKEN));
  assert(!delivered.includes('nested-user'));
  assert(!delivered.includes('nested-pass'));
  assert(!delivered.includes('nested-query-secret'));
  assert(delivered.includes('[REDACTED]'));
  assert(!JSON.stringify(first).includes(WEBHOOK_TOKEN));
  assert(!JSON.stringify(first).includes(WEBHOOK_PATH_SECRET));
  assert(!JSON.stringify(first).includes(WEBHOOK_RESPONSE_SECRET));
  assert.equal(first.payload.metadata.externalArtifacts[0].uri, `${mock.origin}/`);
  assert.match(first.payload.metadata.endpointSha256, /^[a-f0-9]{64}$/);
  assert.equal(first.payload.metadata.idempotencyKey, second.payload.metadata.idempotencyKey);
  const envEndpoint = assertEnvelope(await webhookSink.publish({
    ...ctx,
    endpoint: undefined,
    env: {
      AXION_WEBHOOK_ENDPOINT: `${mock.origin}/hook/services/${WEBHOOK_PATH_SECRET}`,
      AXION_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
    },
  }, source), 'webhook-sink');
  assert(!JSON.stringify(envEndpoint).includes(WEBHOOK_PATH_SECRET));

  await assert.rejects(() => webhookSink.publish({ ...ctx, env: {} }, source), /AXION_WEBHOOK_TOKEN is required/i,
    'a declared webhook credential cannot silently downgrade to anonymous delivery');
  await assert.rejects(() => webhookSink.publish({ ...ctx, allowlist: ['https://example.com'] }, source), /allowlisted/i);
  await assert.rejects(() => webhookSink.publish({ ...ctx, testMode: false, allowInlineEndpoint: true }, source), /HTTPS/i);
  await assert.rejects(() => webhookSink.publish({ ...ctx, endpoint: `http://user:pass@127.0.0.1:${new URL(mock.origin).port}/hook` }, source), /credentials/i);
  await assert.rejects(() => webhookSink.publish({ ...ctx, endpoint: `${mock.origin}/hook#access_token=fragment-secret` }, source), /fragment/i);
  await assert.rejects(() => webhookSink.publish({
    endpoint: 'https://hooks.example.test/services/path-secret',
    allowlist: ['https://hooks.example.test'],
    env: { AXION_WEBHOOK_TOKEN: WEBHOOK_TOKEN },
  }, source), /must come from endpointEnv/i,
  'formal mode keeps path-bearing endpoint URLs out of repository config by default');
  await assert.rejects(() => webhookSink.publish({ ...ctx, maxResponseBytes: 64 * 1024 * 1024 + 1 }, source),
    /maxBytes must be an integer between 1 and 67108864/i,
    'sink response overrides remain bounded to 64 MiB');
});

let passed = 0;
try {
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
} finally {
  await mock.close();
  rmSync(root, { recursive: true, force: true });
}
if (!process.exitCode) process.stdout.write(`Bridge adapters: ${passed}/${tests.length} passed\n`);
