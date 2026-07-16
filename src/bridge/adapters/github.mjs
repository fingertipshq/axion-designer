import { isAbsolute, relative } from 'node:path';
import {
  assertInputEnvelope,
  commitsEqual,
  createAdapterEnvelope,
  defineManifest,
  isLoopbackHostname,
  isPlainObject,
  parseJsonBytes,
  redactSecrets,
  runtimeAdapter,
  safeFetch,
  sanitizeArtifactUri,
  sha256,
  truncate,
  validateHttpUrl,
} from './common.mjs';

const ANNOTATION_LIMIT = 50;

export const capabilities = Object.freeze(['github.actions.discover', 'github.checks.publish']);

export const manifest = defineManifest({
  id: 'github',
  version: '1.0.0',
  kind: 'source-sink',
  capabilities,
  permissions: {
    discover: ['env:GITHUB_ACTIONS', 'env:GITHUB_REPOSITORY', 'env:GITHUB_SHA'],
    collect: [
      'env:GITHUB_ACTIONS', 'env:GITHUB_REPOSITORY', 'env:GITHUB_SHA', 'env:GITHUB_RUN_ID',
      'env:GITHUB_RUN_ATTEMPT', 'env:GITHUB_WORKFLOW', 'env:GITHUB_REF', 'env:GITHUB_EVENT_NAME',
      'env:GITHUB_SERVER_URL', 'env:GITHUB_API_URL',
    ],
    publish: [
      'env:GITHUB_ACTIONS', 'env:GITHUB_REPOSITORY', 'env:GITHUB_SHA', 'env:GITHUB_RUN_ID',
      'env:GITHUB_RUN_ATTEMPT', 'env:GITHUB_WORKFLOW', 'env:GITHUB_REF', 'env:GITHUB_EVENT_NAME',
      'env:GITHUB_SERVER_URL', 'env:GITHUB_API_URL', 'env:GITHUB_TOKEN', 'network:github-api',
      'github:checks.write',
    ],
  },
});

export function discoverGitHubActions(env = process.env) {
  if (!isPlainObject(env) && env !== process.env) throw new TypeError('GitHub Actions environment must be an object.');
  const active = String(env.GITHUB_ACTIONS ?? '').toLowerCase() === 'true';
  const repository = typeof env.GITHUB_REPOSITORY === 'string' ? env.GITHUB_REPOSITORY.trim() : '';
  const sha = typeof env.GITHUB_SHA === 'string' ? env.GITHUB_SHA.trim() : '';
  if (repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error('GITHUB_REPOSITORY must use the owner/repository form.');
  }
  if (sha && !/^[0-9a-f]{7,64}$/i.test(sha)) throw new Error('GITHUB_SHA is not a valid Git commit identifier.');
  const serverUrl = typeof env.GITHUB_SERVER_URL === 'string' && env.GITHUB_SERVER_URL
    ? validateHttpUrl(env.GITHUB_SERVER_URL, { label: 'GITHUB_SERVER_URL', allowHttpLoopback: true }).origin
    : 'https://github.com';
  const apiUrl = typeof env.GITHUB_API_URL === 'string' && env.GITHUB_API_URL
    ? validateHttpUrl(env.GITHUB_API_URL, { label: 'GITHUB_API_URL', allowHttpLoopback: true }).href.replace(/\/$/, '')
    : 'https://api.github.com';
  return {
    active,
    repository: repository || null,
    sha: sha || null,
    runId: env.GITHUB_RUN_ID || null,
    runAttempt: env.GITHUB_RUN_ATTEMPT || null,
    workflow: env.GITHUB_WORKFLOW || null,
    ref: env.GITHUB_REF || null,
    eventName: env.GITHUB_EVENT_NAME || null,
    serverUrl,
    apiUrl,
    runUrl: active && repository && env.GITHUB_RUN_ID
      ? `${serverUrl}/${repository}/actions/runs/${encodeURIComponent(env.GITHUB_RUN_ID)}`
      : null,
  };
}

export async function collect(ctx = {}) {
  const actions = discoverGitHubActions(isPlainObject(ctx.env) ? ctx.env : process.env);
  const complete = actions.active && Boolean(actions.repository && actions.sha);
  const findings = [];
  if (actions.active && !complete) findings.push({
    ruleId: 'github/actions-context-incomplete',
    severity: 'error',
    message: 'GitHub Actions is active, but GITHUB_REPOSITORY or GITHUB_SHA is missing.',
  });
  return createAdapterEnvelope({
    manifest,
    capability: 'github.actions.discover',
    trust: complete ? 'verified' : 'observed',
    status: complete ? 'passed' : actions.active ? 'failed' : 'unknown',
    repository: {
      root: ctx.root,
      remote: actions.repository ? `${actions.serverUrl}/${actions.repository}` : undefined,
      commit: actions.sha ?? undefined,
    },
    coverage: { complete, actionsEnvironment: actions.active },
    findings,
    metadata: {
      actions: { ...actions, apiUrl: sanitizeArtifactUri(actions.apiUrl), serverUrl: sanitizeArtifactUri(actions.serverUrl) },
      requestedPermission: 'none',
    },
    now: ctx.now,
    maxAgeMs: ctx.maxAgeMs ?? 10 * 60_000,
    idSeed: { repository: actions.repository, sha: actions.sha, runId: actions.runId },
  });
}

function annotationPath(finding, root) {
  let file = finding?.file ?? finding?.location?.file ?? finding?.path;
  if (typeof file !== 'string' || !file.trim()) return null;
  file = file.trim();
  if (isAbsolute(file)) {
    if (!root) return null;
    file = relative(root, file);
  }
  file = file.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!file || file === '..' || file.startsWith('../') || file.startsWith('/')) return null;
  return file;
}

function findingLine(finding, key, fallback) {
  const value = finding?.[key] ?? finding?.location?.[key];
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

function githubAnnotations(findings, root) {
  const output = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    const path = annotationPath(finding, root);
    if (!path) continue;
    const start = findingLine(finding, 'line', findingLine(finding, 'startLine', 1));
    const end = Math.max(start, findingLine(finding, 'endLine', start));
    const severity = String(finding.severity ?? finding.level ?? '').toLowerCase();
    output.push({
      path,
      start_line: start,
      end_line: end,
      annotation_level: ['error', 'fatal'].includes(severity) ? 'failure'
        : ['warning', 'warn'].includes(severity) ? 'warning'
          : 'notice',
      message: truncate(finding.message ?? finding.title ?? finding.ruleId ?? 'Axion finding', 64_000),
      title: truncate(finding.title ?? finding.ruleId ?? 'Axion finding', 255),
    });
    if (output.length >= ANNOTATION_LIMIT) break;
  }
  return output;
}

function conclusion(status) {
  if (status === 'passed') return 'success';
  if (status === 'failed') return 'failure';
  if (status === 'pending') return 'neutral';
  return 'neutral';
}

export async function publish(ctx = {}, envelope) {
  assertInputEnvelope(envelope);
  if (ctx.token !== undefined) throw new Error('GitHub credentials must be read from GITHUB_TOKEN, not passed as adapter input.');
  const env = isPlainObject(ctx.env) ? ctx.env : process.env;
  const actions = discoverGitHubActions(env);
  if (!actions.active || !actions.repository || !actions.sha) {
    throw new Error('GitHub Checks publication requires a complete GitHub Actions environment.');
  }
  const token = env.GITHUB_TOKEN;
  if (typeof token !== 'string' || !token) throw new Error('GITHUB_TOKEN is required to publish a check run.');
  if (!commitsEqual(envelope.binding?.commit, actions.sha)) {
    throw new Error('Refusing to publish a check for an envelope that is not bound to GITHUB_SHA.');
  }
  const [owner, repository] = actions.repository.split('/');
  const api = validateHttpUrl(actions.apiUrl, { label: 'GitHub API URL', allowHttpLoopback: true });
  if (api.protocol !== 'https:' && !isLoopbackHostname(api.hostname)) {
    throw new Error('GitHub Checks publication requires HTTPS outside loopback tests.');
  }
  const basePath = api.pathname.replace(/\/$/, '');
  const url = new URL(`${basePath}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/check-runs`, `${api.origin}/`);
  const sourceFindings = redactSecrets(
    Array.isArray(envelope.payload?.findings) ? envelope.payload.findings : [],
    { secretValues: [token] },
  );
  const annotations = githubAnnotations(sourceFindings, ctx.root);
  const eligibleCount = sourceFindings.filter((finding) => annotationPath(finding, ctx.root)).length;
  const omitted = Math.max(0, eligibleCount - annotations.length);
  const detailsUrl = ctx.detailsUrl
    ? validateHttpUrl(ctx.detailsUrl, { label: 'GitHub check details URL', allowHttpLoopback: true }).href
    : actions.runUrl;
  const body = {
    name: truncate(ctx.name ?? 'Axion Design Governance', 100),
    head_sha: actions.sha,
    status: 'completed',
    conclusion: conclusion(envelope.payload?.status),
    ...(detailsUrl ? { details_url: detailsUrl } : {}),
    external_id: truncate(envelope.id, 255),
    output: {
      title: truncate(ctx.title ?? `Axion: ${envelope.payload?.status ?? 'unknown'}`, 255),
      summary: truncate(
        `${envelope.provider}/${envelope.payload?.capability ?? 'unknown'} emitted ${envelope.payload?.status ?? 'unknown'} at trust=${envelope.trust?.level}.`
          + (omitted ? ` ${omitted} annotation(s) omitted after GitHub's ${ANNOTATION_LIMIT}-annotation request limit.` : ''),
        64_000,
      ),
      annotations,
    },
  };
  const result = await safeFetch(url.href, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'axion-designer-bridge',
    },
    body: JSON.stringify(body),
    timeoutMs: ctx.timeoutMs,
    maxBytes: 1024 * 1024,
    fetchImpl: ctx.fetch,
    signal: ctx.signal,
    validateUrlOptions: { label: 'GitHub Checks API URL', allowHttpLoopback: true, allowedHosts: [url.hostname] },
  });
  if (result.response.status !== 201) {
    throw new Error(`GitHub Checks API returned HTTP ${result.response.status}.`);
  }
  const response = parseJsonBytes(result.bytes, 'GitHub Checks API response');
  return createAdapterEnvelope({
    manifest,
    capability: 'github.checks.publish',
    trust: 'verified',
    status: 'passed',
    repository: {
      root: ctx.root,
      remote: `${actions.serverUrl}/${actions.repository}`,
      commit: actions.sha,
    },
    coverage: {
      complete: omitted === 0,
      annotationsPublished: annotations.length,
      annotationsOmitted: omitted,
      annotationLimit: ANNOTATION_LIMIT,
    },
    artifacts: [{
      kind: 'github-check-run',
      uri: sanitizeArtifactUri(response.html_url ?? response.url ?? detailsUrl),
      mediaType: 'application/json',
      bytes: result.bytes.length,
      digest: `sha256:${sha256(result.bytes)}`,
    }],
    metadata: {
      checkRunId: response.id ?? null,
      checkRunUrl: sanitizeArtifactUri(response.html_url ?? response.url),
      sourceEnvelopeId: envelope.id,
      sourceEnvelopeDigest: envelope.digest,
      requestedPermission: 'checks:write',
      tokenPersisted: false,
    },
    now: ctx.now,
    maxAgeMs: ctx.maxAgeMs ?? 10 * 60_000,
    idSeed: { sourceEnvelopeDigest: envelope.digest, checkRunId: response.id ?? null },
  });
}

export default runtimeAdapter({ manifest, collect, publish });
