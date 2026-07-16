import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { dirname, relative, resolve } from 'node:path';
import {
  ADAPTER_MANIFEST_SCHEMA,
  INTEGRATION_ENVELOPE_SCHEMA,
  canonicalSha256,
  createAdapterManifest,
  createIntegrationEnvelope,
  isSafeRelativePath,
  validateIntegrationEnvelope,
} from '../contracts.mjs';
import {
  isCredentialKey,
  redactUrlCredentials,
  urlCarriesCredentials,
} from '../../core/credential-safety.mjs';

export const FALLBACK_INTEGRATION_ENVELOPE_SCHEMA = INTEGRATION_ENVELOPE_SCHEMA;
export const FALLBACK_ADAPTER_MANIFEST_SCHEMA = ADAPTER_MANIFEST_SCHEMA;

const EXTERNAL_STATUSES = new Set(['passed', 'failed', 'pending', 'partial', 'unknown']);
const MANIFEST_DETAILS = new WeakMap();

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

export function assertPlainObject(value, label = 'value') {
  if (!isPlainObject(value)) throw new TypeError(`${label} must be a plain object.`);
  return value;
}

export function boundedInteger(value, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER, label = 'value' } = {}) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function fallbackCanonicalDigest(value) {
  return canonicalSha256(jsonClean(value));
}

export function normalizeExternalTrust(value) {
  const normalized = typeof value === 'string' ? value.toLowerCase() : 'observed';
  if (normalized === 'verified') return 'verified';
  if (normalized === 'untrusted') return 'untrusted';
  // observed/linked/self-attested and even an external "approved" claim remain self-attested.
  return 'self-attested';
}

export function normalizeExternalStatus(value, fallback = 'unknown') {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (EXTERNAL_STATUSES.has(normalized)) return normalized;
  if (['success', 'succeeded', 'pass', 'accepted', 'complete', 'completed'].includes(normalized)) return 'passed';
  if (['failure', 'error', 'errored', 'broken', 'cancelled', 'canceled'].includes(normalized)) return 'failed';
  if (['in_progress', 'in-progress', 'queued', 'running', 'building'].includes(normalized)) return 'pending';
  // External "approved" is deliberately not translated into an Axion pass.
  return fallback;
}

export async function canonicalDigest(value) {
  return canonicalSha256(jsonClean(value));
}

function jsonClean(value, stack = new Set()) {
  if (value === undefined) return null;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Bridge data cannot contain non-finite numbers.');
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonClean(item, stack));
  if (!isPlainObject(value)) throw new TypeError('Bridge data must contain only plain JSON objects and arrays.');
  if (stack.has(value)) throw new TypeError('Bridge data cannot contain cycles.');
  stack.add(value);
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) out[key] = jsonClean(child, stack);
  }
  stack.delete(value);
  return out;
}

function normalizeCommit(value) {
  if (typeof value !== 'string') return null;
  const commit = value.trim().toLowerCase();
  return /^[a-f0-9]{7,64}$/.test(commit) ? commit : null;
}

function artifactSha(artifact) {
  const value = artifact?.sha256 ?? artifact?.digest;
  if (typeof value !== 'string') throw new TypeError('Adapter artifact requires a SHA-256 digest.');
  const digest = value.toLowerCase().replace(/^sha256:/, '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new TypeError('Adapter artifact digest must be SHA-256.');
  return digest;
}

function normalizeArtifacts(artifacts) {
  return (Array.isArray(artifacts) ? artifacts : []).flatMap((artifact) => {
    const digest = artifactSha(artifact);
    const mediaType = typeof artifact.mediaType === 'string' && artifact.mediaType.trim()
      ? artifact.mediaType.trim()
      : 'application/octet-stream';
    const candidate = artifact.path ?? artifact.uri;
    // Core artifacts are verifiable local files. Never invent a local path for
    // remote/inline evidence; keep those immutable descriptors in metadata.
    if (!isSafeRelativePath(candidate)) return [];
    return [{
      path: candidate,
      mediaType,
      bytes: Number.isInteger(artifact.bytes) && artifact.bytes >= 0 ? artifact.bytes : 0,
      sha256: digest,
    }];
  });
}

export async function createAdapterEnvelope({
  manifest,
  capability,
  trust = 'observed',
  status = 'unknown',
  repository = {},
  coverage,
  artifacts = [],
  findings = [],
  metadata = {},
  generatedAt,
  expiresAt,
  now,
  maxAgeMs = 5 * 60_000,
  idSeed = {},
  operation,
}) {
  assertPlainObject(manifest, 'manifest');
  const at = generatedAt ?? new Date(now ?? Date.now()).toISOString();
  const expiry = expiresAt ?? new Date(Date.parse(at) + boundedInteger(maxAgeMs, 5 * 60_000, {
    min: 1_000,
    max: 365 * 24 * 60 * 60_000,
    label: 'maxAgeMs',
  })).toISOString();
  const safeTrust = normalizeExternalTrust(trust);
  const safeStatus = normalizeExternalStatus(status);
  const details = MANIFEST_DETAILS.get(manifest) ?? {};
  const lifecycle = operation ?? (/publish/i.test(capability) ? 'publish' : 'collect');
  if (!manifest.lifecycle.includes(lifecycle)) throw new Error(`${manifest.id} does not declare the ${lifecycle} lifecycle.`);
  const normalizedArtifacts = normalizeArtifacts(artifacts);
  const externalArtifacts = (Array.isArray(artifacts) ? artifacts : []).flatMap((artifact) => {
    const candidate = artifact?.path ?? artifact?.uri;
    if (isSafeRelativePath(candidate)) return [];
    const uri = sanitizeArtifactUri(artifact?.uri);
    return [{
      kind: String(artifact?.kind ?? 'artifact'),
      ...(uri ? { uri } : {}),
      mediaType: typeof artifact?.mediaType === 'string' ? artifact.mediaType : 'application/octet-stream',
      bytes: Number.isInteger(artifact?.bytes) && artifact.bytes >= 0 ? artifact.bytes : 0,
      sha256: artifactSha(artifact),
    }];
  });
  const bindingRepository = typeof repository?.remote === 'string' && repository.remote.trim()
    ? repository.remote.trim()
    : null;
  const bindingCommit = normalizeCommit(repository?.commit);
  const evidence = [
    `adapter:${manifest.id}@${manifest.version}`,
    ...(Array.isArray(artifacts) ? artifacts : []).map((artifact) => `artifact-sha256:${artifactSha(artifact)}`),
    ...(bindingCommit ? [`commit:${bindingCommit}`] : []),
  ];
  const envelope = createIntegrationEnvelope({
    provider: manifest.provider,
    kind: `${lifecycle}/${manifest.provider}`,
    createdAt: at,
    expiresAt: expiry,
    trust: { level: safeTrust, issuer: manifest.provider, evidence },
    binding: { repository: bindingRepository, commit: bindingCommit },
    permissions: manifest.permissions[lifecycle],
    payload: jsonClean({
      status: safeStatus,
      capability,
      providerVersion: manifest.version,
      coverage: coverage ?? null,
      findings,
      metadata: {
        ...metadata,
        ...(externalArtifacts.length ? { externalArtifacts } : {}),
        adapterCapabilities: details.capabilities ?? [],
        externalTrustCeiling: 'verified',
        approvalAuthority: false,
        collectionKey: await canonicalDigest(idSeed),
      },
    }),
    artifacts: normalizedArtifacts,
  });
  const issues = validateIntegrationEnvelope(envelope);
  if (issues.length) throw new Error(`Adapter emitted an invalid Bridge envelope: ${JSON.stringify(issues)}`);
  if (envelope?.trust?.level === 'approved' || envelope?.payload?.status === 'approved') {
    throw new Error('Adapter contract violation: an external adapter cannot emit approved trust or status.');
  }
  return envelope;
}

export async function adapterSchemas() {
  return {
    envelope: INTEGRATION_ENVELOPE_SCHEMA,
    manifest: ADAPTER_MANIFEST_SCHEMA,
  };
}

export function assertInputEnvelope(envelope, policy = {}) {
  const issues = validateIntegrationEnvelope(envelope, policy);
  if (issues.length) {
    const error = new Error(`Bridge envelope is invalid or rejected by policy: ${JSON.stringify(issues)}`);
    error.code = 'AXION_BRIDGE_ADAPTER_INPUT';
    error.issues = issues;
    throw error;
  }
  if (envelope.trust?.level === 'approved' || envelope.payload?.status === 'approved') {
    throw new Error('External adapter input cannot carry approved authority.');
  }
  return envelope;
}

export function defineManifest({ id, version = '1.0.0', kind = 'source', capabilities, permissions }) {
  if (!/^[a-z][a-z0-9-]{1,63}$/.test(id)) throw new TypeError('Adapter id is invalid.');
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new TypeError('Adapter version is invalid.');
  if (!['source', 'sink', 'source-sink'].includes(kind)) throw new TypeError('Adapter kind is invalid.');
  if (!Array.isArray(capabilities) || capabilities.length === 0 || capabilities.some((item) => typeof item !== 'string')) {
    throw new TypeError('Adapter capabilities must be a non-empty string array.');
  }
  // A manifest may only declare lifecycle methods the adapter object actually
  // implements. These concrete integrations expose collect and/or publish;
  // provider-specific discovery is returned inside the collected envelope.
  const lifecycle = kind === 'source' ? ['collect']
    : kind === 'sink' ? ['publish']
      : ['collect', 'publish'];
  const permissionMap = isPlainObject(permissions) && ['discover', 'collect', 'publish'].some((name) => Array.isArray(permissions[name]))
    ? permissions
    : { discover: [], collect: [], publish: [] };
  const manifest = createAdapterManifest({
    id,
    provider: id,
    version,
    lifecycle,
    permissions: Object.fromEntries(lifecycle.map((operation) => [operation, permissionMap[operation] ?? []])),
  });
  MANIFEST_DETAILS.set(manifest, { kind, capabilities: [...new Set(capabilities)] });
  return Object.freeze(manifest);
}

/**
 * Build the exact plain-object shape accepted by AdapterRegistry while keeping
 * the ergonomic named collect(ctx) / publish(ctx, envelope) exports.
 */
export function runtimeAdapter({ manifest, collect, publish }) {
  assertPlainObject(manifest, 'manifest');
  const adapter = { manifest };
  if (typeof collect === 'function') {
    adapter.collect = async (input = {}, context = {}) => {
      assertPlainObject(input, 'collect input');
      assertPlainObject(context, 'collect runtime context');
      return [await collect({ ...input, ...context })];
    };
  }
  if (typeof publish === 'function') {
    adapter.publish = async (input = {}, context = {}) => {
      assertPlainObject(input, 'publish input');
      assertPlainObject(context, 'publish runtime context');
      const { envelope, ...options } = input;
      return [await publish({ ...options, ...context }, envelope)];
    };
  }
  return Object.freeze(adapter);
}

export function normalizeRepository(repository = {}) {
  if (!isPlainObject(repository)) return {};
  const out = {};
  if (typeof repository.root === 'string' && repository.root.trim()) out.root = resolve(repository.root);
  if (typeof repository.remote === 'string' && repository.remote.trim()) out.remote = repository.remote.trim();
  if (typeof repository.commit === 'string' && repository.commit.trim()) out.commit = repository.commit.trim();
  return out;
}

export function commitsEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (!a || !b) return false;
  if (a === b) return true;
  return a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));
}

export function repositoryNamesEqual(left, right) {
  const normalize = (value) => {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim().replace(/\.git$/i, '').replace(/^git@github\.com:/i, 'https://github.com/');
    try {
      const url = new URL(trimmed);
      return `${url.hostname.toLowerCase()}/${url.pathname.replace(/^\/+|\/+$/g, '').toLowerCase()}`;
    } catch {
      return trimmed.replace(/^\/+|\/+$/g, '').toLowerCase();
    }
  };
  const a = normalize(left);
  const b = normalize(right);
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

export async function readLocalFileSecure(path, { root = process.cwd(), maxBytes = 10 * 1024 * 1024 } = {}) {
  if (typeof path !== 'string' || !path.trim()) throw new TypeError('A local file path is required.');
  const byteLimit = boundedInteger(maxBytes, 10 * 1024 * 1024, {
    min: 1, max: 64 * 1024 * 1024, label: 'maxBytes',
  });
  const rootReal = await realpath(resolve(root));
  const candidate = resolve(rootReal, path);
  const fileReal = await realpath(candidate);
  const rel = relative(rootReal, fileReal);
  if (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || resolve(fileReal) === rootReal) {
    throw new Error('Local artifact must be a regular file inside the configured repository root.');
  }
  const handle = await open(fileReal, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('Local artifact must be a regular file.');
    if (info.size > byteLimit) throw new Error(`Local artifact exceeds the ${byteLimit} byte limit.`);
    const allocated = Buffer.allocUnsafe(info.size);
    let offset = 0;
    while (offset < allocated.length) {
      const { bytesRead } = await handle.read(allocated, offset, allocated.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const probe = Buffer.allocUnsafe(1);
    const { bytesRead: grew } = await handle.read(probe, 0, 1, offset);
    if (grew > 0) throw new Error(`Local artifact exceeds the ${byteLimit} byte limit or changed while being read.`);
    const bytes = allocated.subarray(0, offset);
    return { bytes, path: fileReal, relativePath: rel.split('\\').join('/'), size: bytes.length };
  } finally {
    await handle.close();
  }
}

export function parseJsonBytes(bytes, label = 'JSON artifact') {
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString('utf8'));
    if (!isPlainObject(parsed) && !Array.isArray(parsed)) throw new Error('top-level value must be an object or array');
    return parsed;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

export function validateHttpUrl(value, {
  label = 'URL',
  allowHttpLoopback = true,
  httpsOnly = false,
  allowedOrigins,
  allowedHosts,
  allowSensitiveQuery = false,
} = {}) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError(`${label} must be an absolute HTTP(S) URL.`); }
  if (url.username || url.password) throw new Error(`${label} must not contain credentials.`);
  if (!allowSensitiveQuery && urlCarriesCredentials(url.href)) {
    throw new Error(`${label} must not carry credentials or secrets in its query string or fragment.`);
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label} must use HTTP or HTTPS.`);
  const loopback = isLoopbackHostname(url.hostname);
  if ((httpsOnly || url.protocol === 'http:') && url.protocol !== 'https:' && !(allowHttpLoopback && loopback)) {
    throw new Error(`${label} must use HTTPS (plain HTTP is allowed only for loopback testing).`);
  }
  if (Array.isArray(allowedOrigins) && allowedOrigins.length > 0) {
    const origins = new Set(allowedOrigins.map((entry) => new URL(entry).origin));
    if (!origins.has(url.origin)) throw new Error(`${label} origin is not allowlisted.`);
  }
  if (Array.isArray(allowedHosts) && allowedHosts.length > 0) {
    const hosts = new Set(allowedHosts.map((entry) => String(entry).toLowerCase()));
    if (!hosts.has(url.hostname.toLowerCase())) throw new Error(`${label} host is not allowlisted.`);
  }
  return url;
}

export function isLoopbackHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

export async function safeFetch(urlValue, {
  method = 'GET',
  headers = {},
  body,
  timeoutMs = 5_000,
  maxBytes = 10 * 1024 * 1024,
  allowRedirects = false,
  maxRedirects = 0,
  validateUrlOptions = {},
  fetchImpl = globalThis.fetch,
  signal,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('This adapter requires the Fetch API (Node.js 18+).');
  const timeout = boundedInteger(timeoutMs, 5_000, { min: 100, max: 120_000, label: 'timeoutMs' });
  const byteLimit = boundedInteger(maxBytes, 10 * 1024 * 1024, {
    min: 1, max: 64 * 1024 * 1024, label: 'maxBytes',
  });
  const redirects = boundedInteger(maxRedirects, 0, { min: 0, max: 5, label: 'maxRedirects' });
  let current = validateHttpUrl(urlValue, validateUrlOptions);
  const initialOrigin = current.origin;
  let followed = 0;
  while (true) {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error(`HTTP request timed out after ${timeout}ms.`));
    }, timeout);
    const onAbort = () => controller.abort(signal.reason ?? new Error('HTTP request aborted.'));
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const response = await fetchImpl(current, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: controller.signal,
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!allowRedirects || followed >= redirects || !location) {
          throw new Error(`HTTP redirect (${response.status}) was refused.`);
        }
        const next = validateHttpUrl(new URL(location, current).href, validateUrlOptions);
        if (next.origin !== initialOrigin) throw new Error('Cross-origin HTTP redirects are refused.');
        current = next;
        followed += 1;
        continue;
      }
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > byteLimit) {
        throw new Error(`HTTP response exceeds the ${byteLimit} byte limit.`);
      }
      const reader = response.body?.getReader?.();
      if (!reader) {
        const bytes = Buffer.from(await response.arrayBuffer());
        if (bytes.length > byteLimit) throw new Error(`HTTP response exceeds the ${byteLimit} byte limit.`);
        return { response, bytes, url: current, redirects: followed };
      }
      const chunks = [];
      let total = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > byteLimit) {
          await reader.cancel();
          throw new Error(`HTTP response exceeds the ${byteLimit} byte limit.`);
        }
        chunks.push(Buffer.from(value));
      }
      return { response, bytes: Buffer.concat(chunks), url: current, redirects: followed };
    } catch (error) {
      if (timedOut) throw new Error(`HTTP request timed out after ${timeout}ms.`);
      if (signal?.aborted) throw new Error('HTTP request was aborted.');
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
}

export function redactSecrets(value, { secretValues = [], additionalKeys = [] } = {}) {
  const exactKeys = new Set(additionalKeys.map((key) => String(key).toLowerCase()));
  const values = secretValues.filter((secret) => typeof secret === 'string' && secret.length >= 4);
  const visit = (item, key = '') => {
    const rawKey = String(key);
    const normalizedKey = rawKey.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    if (exactKeys.has(rawKey.toLowerCase()) || exactKeys.has(normalizedKey) || isCredentialKey(normalizedKey)) return '[REDACTED]';
    if (typeof item === 'string') {
      let output = redactUrlSecrets(item);
      for (const secret of values) output = output.split(secret).join('[REDACTED]');
      return output;
    }
    if (Array.isArray(item)) return item.map((entry) => visit(entry));
    if (isPlainObject(item)) {
      const out = {};
      for (const [childKey, childValue] of Object.entries(item)) out[childKey] = visit(childValue, childKey);
      return out;
    }
    return item;
  };
  return visit(value);
}

function redactUrlSecrets(value) {
  return redactUrlCredentials(value);
}

export function sanitizeArtifactUri(value) {
  if (typeof value !== 'string') return undefined;
  if (/^https?:\/\//i.test(value)) return redactUrlSecrets(value);
  return value;
}

export function truncate(value, max) {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function parentDirectory(path) {
  return dirname(path);
}
