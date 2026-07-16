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
  repositoryNamesEqual,
  runtimeAdapter,
  sanitizeArtifactUri,
  sha256,
  validateHttpUrl,
} from './common.mjs';

export const capabilities = Object.freeze(['chromatic.build.read', 'visual-regression.observe']);

export const manifest = defineManifest({
  id: 'chromatic',
  version: '1.0.0',
  kind: 'source',
  capabilities,
  permissions: {
    discover: [],
    collect: ['fs:read',
      'CHROMATIC_BUILD_URL', 'CHROMATIC_BUILD_STATUS', 'CHROMATIC_BUILD_NUMBER',
      'CHROMATIC_COMMIT', 'GITHUB_REPOSITORY', 'GITHUB_SHA', 'GITHUB_REF_NAME',
    ].map((name) => name === 'fs:read' ? name : `env:${name}`),
    publish: [],
  },
});

function pickString(...values) {
  return values.find((value) => typeof value === 'string' && value.trim())?.trim() ?? null;
}

function normalizePayload(payload) {
  const build = isPlainObject(payload.build) ? payload.build : payload;
  const git = isPlainObject(build.git) ? build.git : isPlainObject(payload.git) ? payload.git : {};
  const project = isPlainObject(payload.project) ? payload.project : {};
  const statusRaw = pickString(build.status, build.state, build.result, payload.status, payload.state);
  return {
    statusRaw,
    status: normalizeExternalStatus(statusRaw),
    commit: pickString(build.commit, build.commitSha, build.sha, git.commit, git.sha, payload.commit, payload.sha),
    repository: pickString(
      build.repository,
      build.repositorySlug,
      git.repository,
      git.repositorySlug,
      payload.repository,
      payload.repositorySlug,
      project.repository,
    ),
    buildUrl: pickString(build.webUrl, build.buildUrl, build.url, payload.webUrl, payload.buildUrl, payload.url),
    buildNumber: build.number ?? build.buildNumber ?? payload.number ?? payload.buildNumber ?? null,
    branch: pickString(build.branch, git.branch, payload.branch),
    projectName: pickString(project.name, payload.projectName),
  };
}

async function sourcePayload(ctx) {
  if (isPlainObject(ctx.webhook)) {
    const bytes = Buffer.from(JSON.stringify(ctx.webhook));
    const limit = boundedInteger(ctx.maxBytes, 5 * 1024 * 1024, {
      min: 1, max: 64 * 1024 * 1024, label: 'maxBytes',
    });
    if (bytes.length > limit) throw new Error(`Chromatic webhook exceeds the ${limit} byte limit.`);
    return { payload: ctx.webhook, bytes, source: 'webhook', uri: null };
  }
  if (typeof ctx.source === 'string') {
    if (/^https?:\/\//i.test(ctx.source)) {
      throw new Error('Chromatic JSON artifacts must be supplied as local files or parsed webhook payloads; remote fetching is not enabled.');
    }
    const root = resolve(ctx.root ?? process.cwd());
    const local = await readLocalFileSecure(ctx.source, { root, maxBytes: ctx.maxBytes ?? 5 * 1024 * 1024 });
    return {
      payload: parseJsonBytes(local.bytes, 'Chromatic JSON artifact'),
      bytes: local.bytes,
      source: 'artifact',
      uri: local.relativePath,
    };
  }
  const env = isPlainObject(ctx.env) ? ctx.env : process.env;
  const safe = {
    status: env.CHROMATIC_BUILD_STATUS ?? null,
    buildUrl: env.CHROMATIC_BUILD_URL ?? null,
    buildNumber: env.CHROMATIC_BUILD_NUMBER ?? null,
    commit: env.CHROMATIC_COMMIT ?? env.GITHUB_SHA ?? null,
    repository: env.GITHUB_REPOSITORY ?? null,
    branch: env.GITHUB_REF_NAME ?? null,
  };
  const bytes = Buffer.from(JSON.stringify(safe));
  return { payload: safe, bytes, source: 'environment', uri: null };
}

export async function collect(ctx = {}) {
  const source = await sourcePayload(ctx);
  const build = normalizePayload(source.payload);
  let buildUrl = null;
  const findings = [];
  if (build.buildUrl) {
    try {
      buildUrl = validateHttpUrl(build.buildUrl, {
        label: 'Chromatic build URL',
        allowHttpLoopback: ctx.testMode === true,
        httpsOnly: ctx.testMode !== true,
      }).href;
    } catch (error) {
      findings.push({ ruleId: 'chromatic/build-url-invalid', severity: 'error', message: error.message });
    }
  } else {
    findings.push({
      ruleId: 'chromatic/build-url-missing',
      severity: 'warning',
      message: 'Chromatic result has no build URL, so reviewers cannot inspect the external build.',
    });
  }
  const expectedCommit = ctx.expectedCommit ?? ctx.repository?.commit ?? null;
  const expectedRepository = ctx.expectedRepository ?? ctx.repository?.remote ?? null;
  const commitBound = expectedCommit ? commitsEqual(build.commit, expectedCommit) : false;
  const repositoryBound = expectedRepository ? repositoryNamesEqual(build.repository, expectedRepository) : false;
  if (expectedCommit && !commitBound) findings.push({
    ruleId: 'chromatic/commit-mismatch',
    severity: 'error',
    message: 'Chromatic build commit does not match the expected repository commit.',
  });
  if (expectedRepository && !repositoryBound) findings.push({
    ruleId: 'chromatic/repository-mismatch',
    severity: 'error',
    message: 'Chromatic build repository does not match the expected repository.',
  });
  if (build.status === 'unknown') findings.push({
    ruleId: 'chromatic/status-unknown',
    severity: 'warning',
    message: `Chromatic status “${build.statusRaw ?? 'missing'}” is not a recognized build result and cannot be promoted.`,
  });
  const bindingFailed = findings.some((finding) => finding.severity === 'error');
  const fullyBound = Boolean(expectedCommit && expectedRepository && commitBound && repositoryBound && buildUrl);
  const sourceDigest = sha256(source.bytes);
  const buildReferenceBytes = buildUrl ? Buffer.from(JSON.stringify({ buildUrl, buildNumber: build.buildNumber })) : null;
  const externalStatus = bindingFailed ? 'failed' : build.status;
  return createAdapterEnvelope({
    manifest,
    capability: 'visual-regression.observe',
    trust: fullyBound ? 'verified' : 'observed',
    status: externalStatus,
    repository: {
      root: ctx.root,
      remote: expectedRepository ?? build.repository ?? undefined,
      commit: expectedCommit ?? build.commit ?? undefined,
    },
    coverage: {
      complete: false,
      externalBuildObserved: true,
      commitBound,
      repositoryBound,
      routes: null,
      states: null,
      viewports: null,
      themes: null,
    },
    artifacts: [
      ...(source.uri ? [{
        kind: 'chromatic-json',
        uri: source.uri,
        mediaType: 'application/json',
        bytes: source.bytes.length,
        digest: `sha256:${sourceDigest}`,
      }] : []),
      ...(buildUrl ? [{
        kind: 'chromatic-build',
        uri: sanitizeArtifactUri(buildUrl),
        mediaType: 'text/html',
        bytes: buildReferenceBytes.length,
        digest: `sha256:${sha256(buildReferenceBytes)}`,
      }] : []),
    ],
    findings,
    metadata: {
      source: source.source,
      sourceStatus: build.statusRaw,
      buildStatus: build.status,
      buildNumber: build.buildNumber,
      buildUrl: sanitizeArtifactUri(buildUrl),
      branch: build.branch,
      projectName: build.projectName,
      reportedCommit: build.commit,
      reportedRepository: build.repository,
      proven: false,
      promotionEligible: false,
      promotionReason: 'A single external Chromatic result is supporting evidence, not complete Axion route/state/viewport/theme proof.',
    },
    now: ctx.now,
    maxAgeMs: ctx.maxAgeMs ?? 24 * 60 * 60_000,
    idSeed: { sourceDigest, buildNumber: build.buildNumber, expectedCommit, expectedRepository },
  });
}

export default runtimeAdapter({ manifest, collect });
