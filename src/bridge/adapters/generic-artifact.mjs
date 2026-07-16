import { resolve } from 'node:path';
import {
  boundedInteger,
  commitsEqual,
  createAdapterEnvelope,
  defineManifest,
  isPlainObject,
  normalizeExternalStatus,
  parseJsonBytes,
  readLocalFileSecure,
  redactSecrets,
  repositoryNamesEqual,
  runtimeAdapter,
  safeFetch,
  sanitizeArtifactUri,
  sha256,
} from './common.mjs';

export const capabilities = Object.freeze(['artifact.json.read', 'artifact.integrity.bind']);

export const manifest = defineManifest({
  id: 'generic-artifact',
  version: '1.0.0',
  kind: 'source',
  capabilities,
  permissions: {
    discover: [],
    collect: ['fs:read', 'network:artifact-origin'],
    publish: [],
  },
});

function normalizedExpectedDigest(value) {
  if (value === undefined || value === null) return null;
  const digest = String(value).toLowerCase().replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new TypeError('expectedSha256 must be a 64-character SHA-256 digest.');
  return digest;
}

async function load(ctx) {
  if (isPlainObject(ctx.artifact) || Array.isArray(ctx.artifact)) {
    const bytes = Buffer.from(JSON.stringify(ctx.artifact));
    const limit = boundedInteger(ctx.maxBytes, 5 * 1024 * 1024, {
      min: 1, max: 64 * 1024 * 1024, label: 'maxBytes',
    });
    if (bytes.length > limit) throw new Error(`Generic artifact exceeds the ${limit} byte limit.`);
    return { payload: ctx.artifact, bytes, uri: null, source: 'inline' };
  }
  if (typeof ctx.source !== 'string' || !ctx.source.trim()) {
    throw new TypeError('generic-artifact.collect requires ctx.source or ctx.artifact.');
  }
  if (/^https?:\/\//i.test(ctx.source)) {
    const result = await safeFetch(ctx.source, {
      timeoutMs: ctx.timeoutMs,
      maxBytes: ctx.maxBytes ?? 5 * 1024 * 1024,
      allowRedirects: ctx.allowRedirects === true,
      maxRedirects: ctx.maxRedirects ?? 0,
      fetchImpl: ctx.fetch,
      signal: ctx.signal,
      validateUrlOptions: {
        label: 'Generic artifact URL',
        allowHttpLoopback: true,
        httpsOnly: false,
      },
    });
    if (!result.response.ok) throw new Error(`Generic artifact returned HTTP ${result.response.status}.`);
    return {
      payload: parseJsonBytes(result.bytes, 'Generic artifact'),
      bytes: result.bytes,
      uri: result.url.href,
      source: 'http',
    };
  }
  const root = resolve(ctx.root ?? process.cwd());
  const local = await readLocalFileSecure(ctx.source, { root, maxBytes: ctx.maxBytes ?? 5 * 1024 * 1024 });
  return {
    payload: parseJsonBytes(local.bytes, 'Generic artifact'),
    bytes: local.bytes,
    uri: local.relativePath,
    source: 'file',
  };
}

function reportedRepository(payload) {
  if (typeof payload?.repository === 'string') return payload.repository;
  if (isPlainObject(payload?.repository)) return payload.repository.remote ?? payload.repository.url ?? payload.repository.name ?? null;
  return payload?.repo ?? payload?.repositoryUrl ?? null;
}

function reportedCommit(payload) {
  return payload?.commit ?? payload?.commitSha ?? payload?.sha ?? payload?.repository?.commit ?? null;
}

export async function collect(ctx = {}) {
  const loaded = await load(ctx);
  const actualDigest = sha256(loaded.bytes);
  const expectedDigest = normalizedExpectedDigest(ctx.expectedSha256);
  const digestBound = expectedDigest ? actualDigest === expectedDigest : false;
  const expectedCommit = ctx.expectedCommit ?? ctx.repository?.commit ?? null;
  const expectedRepository = ctx.expectedRepository ?? ctx.repository?.remote ?? null;
  const commit = reportedCommit(loaded.payload);
  const repository = reportedRepository(loaded.payload);
  const commitBound = expectedCommit ? commitsEqual(commit, expectedCommit) : false;
  const repositoryBound = expectedRepository ? repositoryNamesEqual(repository, expectedRepository) : false;
  const findings = [];
  if (expectedDigest && !digestBound) findings.push({
    ruleId: 'artifact/digest-mismatch',
    severity: 'error',
    message: 'Generic artifact SHA-256 does not match expectedSha256.',
  });
  if (expectedCommit && !commitBound) findings.push({
    ruleId: 'artifact/commit-mismatch',
    severity: 'error',
    message: 'Generic artifact commit does not match the expected commit.',
  });
  if (expectedRepository && !repositoryBound) findings.push({
    ruleId: 'artifact/repository-mismatch',
    severity: 'error',
    message: 'Generic artifact repository does not match the expected repository.',
  });
  if (ctx.expectedSchema && loaded.payload?.schema !== ctx.expectedSchema) findings.push({
    ruleId: 'artifact/schema-mismatch',
    severity: 'error',
    message: `Generic artifact schema does not match expected schema ${ctx.expectedSchema}.`,
  });
  const sourceStatus = loaded.payload?.status;
  const normalizedStatus = normalizeExternalStatus(sourceStatus);
  if (String(sourceStatus ?? '').toLowerCase() === 'approved') findings.push({
    ruleId: 'artifact/external-approval-not-authority',
    severity: 'warning',
    message: 'External “approved” status was retained only as source context and cannot grant Axion approval.',
  });
  const failed = findings.some((finding) => finding.severity === 'error');
  const hasExpectedBinding = Boolean(expectedDigest || (expectedCommit && expectedRepository));
  const allBindingsPass = (!expectedDigest || digestBound)
    && (!expectedCommit || commitBound)
    && (!expectedRepository || repositoryBound);
  return createAdapterEnvelope({
    manifest,
    capability: 'artifact.integrity.bind',
    trust: hasExpectedBinding && allBindingsPass ? 'verified' : 'observed',
    status: failed ? 'failed' : normalizedStatus,
    repository: {
      root: ctx.root,
      remote: expectedRepository ?? repository ?? undefined,
      commit: expectedCommit ?? commit ?? undefined,
    },
    coverage: {
      complete: hasExpectedBinding && allBindingsPass,
      digestBound,
      commitBound,
      repositoryBound,
    },
    artifacts: [{
      kind: 'generic-json-artifact',
      uri: sanitizeArtifactUri(loaded.uri) ?? 'inline:json',
      mediaType: 'application/json',
      bytes: loaded.bytes.length,
      digest: `sha256:${actualDigest}`,
    }],
    findings,
    metadata: {
      source: loaded.source,
      sourceSchema: loaded.payload?.schema ?? null,
      sourceStatus: sourceStatus ?? null,
      payload: ctx.includePayload === false ? undefined : redactSecrets(loaded.payload, {
        secretValues: ctx.secretValues,
        additionalKeys: ctx.redactKeys,
      }),
      promotionEligible: false,
    },
    now: ctx.now,
    maxAgeMs: ctx.maxAgeMs,
    idSeed: { actualDigest, expectedDigest, expectedCommit, expectedRepository },
  });
}

export default runtimeAdapter({ manifest, collect });
