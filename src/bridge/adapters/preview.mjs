import {
  commitsEqual,
  createAdapterEnvelope,
  defineManifest,
  isPlainObject,
  runtimeAdapter,
  safeFetch,
  sanitizeArtifactUri,
  sha256,
  validateHttpUrl,
} from './common.mjs';

export const capabilities = Object.freeze(['preview.health.verify', 'preview.commit-url.bind']);

export const manifest = defineManifest({
  id: 'preview',
  version: '1.0.0',
  kind: 'source',
  capabilities,
  permissions: {
    discover: [],
    collect: ['network:preview'],
    publish: [],
  },
});

function jsonBody(bytes, contentType) {
  if (!/\bjson\b/i.test(contentType ?? '') || bytes.length === 0) return null;
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function responseCommit(response, body) {
  const headers = ['x-axion-commit', 'x-commit-sha', 'x-git-commit-sha', 'x-vercel-git-commit-sha'];
  for (const name of headers) {
    const value = response.headers.get(name);
    if (value) return value.trim();
  }
  for (const name of ['commit', 'commitSha', 'sha', 'gitCommitSha']) {
    if (typeof body?.[name] === 'string' && body[name].trim()) return body[name].trim();
  }
  return null;
}

function comparableUrl(value) {
  const url = validateHttpUrl(value, { label: 'Expected preview URL', allowHttpLoopback: true });
  url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

export async function collect(ctx = {}) {
  const baseValue = ctx.url ?? ctx.baseUrl;
  if (typeof baseValue !== 'string' || !baseValue.trim()) throw new TypeError('preview.collect requires ctx.url or ctx.baseUrl.');
  const base = validateHttpUrl(baseValue, { label: 'Preview URL', allowHttpLoopback: true });
  const healthPath = typeof ctx.healthPath === 'string' && ctx.healthPath.trim() ? ctx.healthPath : '/';
  const target = new URL(healthPath, base);
  if (target.origin !== base.origin) throw new Error('Preview healthPath must remain on the configured preview origin.');
  const result = await safeFetch(target.href, {
    timeoutMs: ctx.timeoutMs,
    maxBytes: ctx.maxBytes ?? 1024 * 1024,
    allowRedirects: ctx.allowRedirects === true,
    maxRedirects: ctx.maxRedirects ?? (ctx.allowRedirects === true ? 2 : 0),
    fetchImpl: ctx.fetch,
    signal: ctx.signal,
    validateUrlOptions: { label: 'Preview health URL', allowHttpLoopback: true },
  });
  const body = jsonBody(result.bytes, result.response.headers.get('content-type'));
  const reportedCommit = responseCommit(result.response, body);
  const expectedCommit = ctx.expectedCommit ?? ctx.repository?.commit ?? null;
  const commitBound = expectedCommit ? commitsEqual(reportedCommit, expectedCommit) : null;
  const expectedUrl = ctx.expectedUrl ? comparableUrl(ctx.expectedUrl) : null;
  const expectedOrigin = ctx.expectedOrigin
    ? validateHttpUrl(ctx.expectedOrigin, { label: 'Expected preview origin', allowHttpLoopback: true }).origin
    : null;
  const finalComparable = comparableUrl(result.url.href);
  const urlBound = expectedUrl ? finalComparable === expectedUrl
    : expectedOrigin ? result.url.origin === expectedOrigin
      : null;
  const healthy = result.response.status >= 200 && result.response.status < 300;
  const findings = [];
  if (!healthy) findings.push({
    ruleId: 'preview/health-failed',
    severity: 'error',
    message: `Preview health endpoint returned HTTP ${result.response.status}.`,
  });
  if (expectedCommit && !reportedCommit) findings.push({
    ruleId: 'preview/commit-missing',
    severity: 'error',
    message: 'The preview did not expose a commit identifier, so it cannot be bound to the expected source revision.',
  });
  else if (expectedCommit && !commitBound) findings.push({
    ruleId: 'preview/commit-mismatch',
    severity: 'error',
    message: `Preview commit ${reportedCommit} does not match expected commit ${expectedCommit}.`,
  });
  if ((expectedUrl || expectedOrigin) && !urlBound) findings.push({
    ruleId: 'preview/url-mismatch',
    severity: 'error',
    message: 'The final preview URL does not match the configured URL binding.',
  });
  const passed = healthy && !findings.some((finding) => finding.severity === 'error');
  const hasBinding = Boolean(expectedCommit || expectedUrl || expectedOrigin);
  return createAdapterEnvelope({
    manifest,
    capability: 'preview.commit-url.bind',
    trust: passed && hasBinding ? 'verified' : 'observed',
    status: passed ? 'passed' : 'failed',
    repository: {
      root: ctx.root,
      remote: ctx.repository?.remote,
      commit: expectedCommit ?? reportedCommit ?? undefined,
    },
    coverage: {
      complete: passed && hasBinding,
      endpointsPlanned: 1,
      endpointsHealthy: healthy ? 1 : 0,
      commitBound,
      urlBound,
    },
    artifacts: [{
      kind: 'preview-health-response',
      uri: sanitizeArtifactUri(result.url.href),
      mediaType: result.response.headers.get('content-type') ?? 'application/octet-stream',
      bytes: result.bytes.length,
      digest: `sha256:${sha256(result.bytes)}`,
    }],
    findings,
    metadata: {
      httpStatus: result.response.status,
      redirects: result.redirects,
      reportedCommit,
      expectedCommit,
      finalUrl: sanitizeArtifactUri(result.url.href),
      bindingRequired: hasBinding,
    },
    now: ctx.now,
    maxAgeMs: ctx.maxAgeMs ?? 2 * 60_000,
    idSeed: {
      url: result.url.href,
      expectedCommit,
      responseDigest: sha256(result.bytes),
    },
  });
}

export default runtimeAdapter({ manifest, collect });
