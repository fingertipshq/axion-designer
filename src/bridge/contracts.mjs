import { createHash } from 'node:crypto';

export const ADAPTER_MANIFEST_SCHEMA = 'axion-bridge-adapter/v1';
export const INTEGRATION_ENVELOPE_SCHEMA = 'axion-bridge-envelope/v1';

export const BRIDGE_LIFECYCLES = Object.freeze(['discover', 'collect', 'publish']);
export const BRIDGE_TRUST_LEVELS = Object.freeze(['untrusted', 'self-attested', 'verified']);

const ID_RE = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const KIND_RE = /^[a-z][a-z0-9]*(?:[._/-][a-z0-9]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{7,64}$/;
const PERMISSION_RE = /^[a-z][a-z0-9.-]*:[A-Za-z0-9*._/@-]+$/;

export class BridgeValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'BridgeValidationError';
    this.code = 'AXION_BRIDGE_VALIDATION';
    this.issues = issues;
  }
}

/** RFC-8785-like canonical JSON for the JSON subset used by Bridge contracts. */
export function canonicalStringify(value) {
  const ancestors = new Set();

  function visit(current, path) {
    if (current === null) return 'null';
    if (typeof current === 'string' || typeof current === 'boolean') return JSON.stringify(current);
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new BridgeValidationError(`Cannot canonicalize non-finite number at ${path}.`, [issue(path, 'non-json-number', 'Expected a finite JSON number.')]);
      return Object.is(current, -0) ? '0' : JSON.stringify(current);
    }
    if (typeof current !== 'object') {
      throw new BridgeValidationError(`Cannot canonicalize ${typeof current} at ${path}.`, [issue(path, 'non-json-value', 'Expected a JSON value.')]);
    }
    if (ancestors.has(current)) throw new BridgeValidationError(`Cannot canonicalize a cycle at ${path}.`, [issue(path, 'cycle', 'Cyclic values are not supported.')]);
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const values = [];
        for (let index = 0; index < current.length; index++) {
          if (!Object.prototype.hasOwnProperty.call(current, index)) {
            throw new BridgeValidationError(`Cannot canonicalize a sparse array at ${path}[${index}].`, [issue(`${path}[${index}]`, 'sparse-array', 'Sparse arrays are not valid Bridge data.')]);
          }
          values.push(visit(current[index], `${path}[${index}]`));
        }
        return `[${values.join(',')}]`;
      }
      if (!isPlainObject(current)) {
        throw new BridgeValidationError(`Cannot canonicalize a non-plain object at ${path}.`, [issue(path, 'non-plain-object', 'Expected a plain JSON object.')]);
      }
      const fields = Object.keys(current).sort().map((key) => `${JSON.stringify(key)}:${visit(current[key], `${path}.${key}`)}`);
      return `{${fields.join(',')}}`;
    } finally {
      ancestors.delete(current);
    }
  }

  return visit(value, '$');
}

export function canonicalSha256(value) {
  return createHash('sha256').update(canonicalStringify(value)).digest('hex');
}

export function createAdapterManifest(input) {
  const issues = [];
  exactObject(input, ['id', 'provider', 'version', 'lifecycle', 'permissions'], '$', issues);
  if (isPlainObject(input?.permissions)) exactObject(input.permissions, BRIDGE_LIFECYCLES, '$.permissions', issues);
  if (issues.length) throw new BridgeValidationError('Adapter manifest input is invalid.', issues);
  const lifecycle = orderedUnique(input.lifecycle ?? [], BRIDGE_LIFECYCLES);
  const body = {
    schema: ADAPTER_MANIFEST_SCHEMA,
    id: input.id,
    provider: input.provider ?? input.id,
    version: input.version ?? '1.0.0',
    lifecycle,
    permissions: Object.fromEntries(BRIDGE_LIFECYCLES.map((name) => [name, sortedUnique(input.permissions?.[name] ?? [])])),
  };
  const manifest = { ...body, digest: canonicalSha256(body) };
  assertAdapterManifest(manifest);
  return canonicalClone(manifest);
}

export function validateAdapterManifest(manifest) {
  const issues = [];
  exactObject(manifest, ['schema', 'id', 'provider', 'version', 'lifecycle', 'permissions', 'digest'], '$', issues);
  if (!isPlainObject(manifest)) return issues;
  requiredKeys(manifest, ['schema', 'id', 'provider', 'version', 'lifecycle', 'permissions', 'digest'], '$', issues);
  if (manifest.schema !== ADAPTER_MANIFEST_SCHEMA) push(issues, '$.schema', 'schema', `Expected ${ADAPTER_MANIFEST_SCHEMA}.`);
  if (!ID_RE.test(manifest.id ?? '') || manifest.id.length > 64) push(issues, '$.id', 'id', 'Expected a lowercase provider-safe identifier up to 64 characters.');
  if (!ID_RE.test(manifest.provider ?? '') || manifest.provider.length > 64) push(issues, '$.provider', 'provider', 'Expected a lowercase provider identifier up to 64 characters.');
  if (!VERSION_RE.test(manifest.version ?? '')) push(issues, '$.version', 'version', 'Expected a semantic version.');
  stringArray(manifest.lifecycle, '$.lifecycle', issues, { allowed: BRIDGE_LIFECYCLES, unique: true, nonEmpty: true });

  exactObject(manifest.permissions, BRIDGE_LIFECYCLES, '$.permissions', issues);
  if (isPlainObject(manifest.permissions)) {
    requiredKeys(manifest.permissions, BRIDGE_LIFECYCLES, '$.permissions', issues);
    for (const operation of BRIDGE_LIFECYCLES) {
      stringArray(manifest.permissions[operation], `$.permissions.${operation}`, issues, { pattern: PERMISSION_RE, unique: true });
      if (!manifest.lifecycle?.includes?.(operation) && (manifest.permissions[operation]?.length ?? 0) > 0) {
        push(issues, `$.permissions.${operation}`, 'inactive-permission', `Permissions cannot be declared for inactive lifecycle ${operation}.`);
      }
    }
  }
  if (!HASH_RE.test(manifest.digest ?? '')) push(issues, '$.digest', 'digest', 'Expected a lowercase SHA-256 digest.');
  if (!issues.length) {
    const { digest: _digest, ...body } = manifest;
    if (canonicalSha256(body) !== manifest.digest) push(issues, '$.digest', 'digest-mismatch', 'Manifest digest does not match its canonical contents.');
  }
  return issues;
}

export function assertAdapterManifest(manifest) {
  const issues = validateAdapterManifest(manifest);
  if (issues.length) throw new BridgeValidationError('Adapter manifest is invalid.', issues);
  return manifest;
}

export function createIntegrationEnvelope(input, options = {}) {
  const inputIssues = [];
  exactObject(input, ['id', 'provider', 'kind', 'createdAt', 'expiresAt', 'trust', 'binding', 'permissions', 'payload', 'artifacts'], '$', inputIssues);
  if (isPlainObject(input?.trust)) exactObject(input.trust, ['level', 'issuer', 'evidence'], '$.trust', inputIssues);
  if (isPlainObject(input?.binding)) exactObject(input.binding, ['repository', 'commit'], '$.binding', inputIssues);
  if (!isPlainObject(input) || !Object.prototype.hasOwnProperty.call(input, 'payload')) {
    push(inputIssues, '$.payload', 'required', 'payload is required, including when its value is null.');
  }
  if (inputIssues.length) throw new BridgeValidationError('Integration envelope input is invalid.', inputIssues);
  const createdAt = normalizeTimestamp(input.createdAt ?? options.now ?? new Date());
  const base = {
    schema: INTEGRATION_ENVELOPE_SCHEMA,
    provider: input.provider,
    kind: input.kind,
    createdAt,
    expiresAt: input.expiresAt == null ? null : normalizeTimestamp(input.expiresAt),
    trust: {
      level: input.trust?.level ?? 'untrusted',
      issuer: input.trust?.issuer ?? input.provider,
      evidence: sortedUnique(input.trust?.evidence ?? []),
    },
    binding: {
      repository: input.binding?.repository ?? null,
      commit: input.binding?.commit == null ? null : String(input.binding.commit).toLowerCase(),
    },
    permissions: sortedUnique(input.permissions ?? []),
    payload: canonicalClone(input.payload),
    artifacts: canonicalClone(input.artifacts ?? []),
  };
  const id = input.id ?? `env_${canonicalSha256(base).slice(0, 16)}`;
  const body = { schema: base.schema, id, ...Object.fromEntries(Object.entries(base).slice(1)) };
  const envelope = { ...body, digest: canonicalSha256(body) };
  assertIntegrationEnvelope(envelope);
  return canonicalClone(envelope);
}

export function integrationEnvelopeDigest(envelope) {
  if (!isPlainObject(envelope)) throw new BridgeValidationError('Envelope must be an object.', [issue('$', 'type', 'Expected an object.')]);
  const { digest: _digest, ...body } = envelope;
  return canonicalSha256(body);
}

export function validateIntegrationEnvelope(envelope, policy = {}) {
  const issues = [];
  exactObject(envelope, ['schema', 'id', 'provider', 'kind', 'createdAt', 'expiresAt', 'trust', 'binding', 'permissions', 'payload', 'artifacts', 'digest'], '$', issues);
  if (!isPlainObject(envelope)) return issues;
  requiredKeys(envelope, ['schema', 'id', 'provider', 'kind', 'createdAt', 'expiresAt', 'trust', 'binding', 'permissions', 'payload', 'artifacts', 'digest'], '$', issues);
  if (envelope.schema !== INTEGRATION_ENVELOPE_SCHEMA) push(issues, '$.schema', 'schema', `Expected ${INTEGRATION_ENVELOPE_SCHEMA}.`);
  if (!/^env_[a-f0-9]{16}$/.test(envelope.id ?? '')
    && (!ID_RE.test(envelope.id ?? '') || envelope.id.length > 64)) push(issues, '$.id', 'id', 'Expected env_<16 hex> or a provider-safe identifier up to 64 characters.');
  if (!ID_RE.test(envelope.provider ?? '') || envelope.provider.length > 64) push(issues, '$.provider', 'provider', 'Expected a lowercase provider identifier up to 64 characters.');
  if (!KIND_RE.test(envelope.kind ?? '')) push(issues, '$.kind', 'kind', 'Expected a lowercase kind identifier.');
  timestamp(envelope.createdAt, '$.createdAt', issues);
  if (envelope.expiresAt !== null) timestamp(envelope.expiresAt, '$.expiresAt', issues);
  if (isIso(envelope.createdAt) && isIso(envelope.expiresAt) && Date.parse(envelope.expiresAt) <= Date.parse(envelope.createdAt)) {
    push(issues, '$.expiresAt', 'freshness-order', 'expiresAt must be later than createdAt.');
  }

  exactObject(envelope.trust, ['level', 'issuer', 'evidence'], '$.trust', issues);
  if (isPlainObject(envelope.trust)) {
    requiredKeys(envelope.trust, ['level', 'issuer', 'evidence'], '$.trust', issues);
    if (!BRIDGE_TRUST_LEVELS.includes(envelope.trust.level)) push(issues, '$.trust.level', 'trust', `Expected ${BRIDGE_TRUST_LEVELS.join(', ')}.`);
    nonEmptyString(envelope.trust.issuer, '$.trust.issuer', issues, 256);
    stringArray(envelope.trust.evidence, '$.trust.evidence', issues, { unique: true, maxItems: 64, maxLength: 2048 });
  }

  exactObject(envelope.binding, ['repository', 'commit'], '$.binding', issues);
  if (isPlainObject(envelope.binding)) {
    requiredKeys(envelope.binding, ['repository', 'commit'], '$.binding', issues);
    if (envelope.binding.repository !== null) nonEmptyString(envelope.binding.repository, '$.binding.repository', issues, 1024);
    if (envelope.binding.commit !== null && !COMMIT_RE.test(envelope.binding.commit ?? '')) push(issues, '$.binding.commit', 'commit', 'Expected a 7-64 character lowercase hexadecimal commit id.');
  }

  stringArray(envelope.permissions, '$.permissions', issues, { pattern: PERMISSION_RE, unique: true, maxItems: 128 });
  if (!isJsonValue(envelope.payload)) push(issues, '$.payload', 'payload', 'Expected a finite, acyclic JSON value.');
  if (!Array.isArray(envelope.artifacts)) push(issues, '$.artifacts', 'type', 'Expected an array.');
  else envelope.artifacts.forEach((artifact, index) => validateArtifact(artifact, `$.artifacts[${index}]`, issues));
  if (!HASH_RE.test(envelope.digest ?? '')) push(issues, '$.digest', 'digest', 'Expected a lowercase SHA-256 digest.');
  if (!issues.length && integrationEnvelopeDigest(envelope) !== envelope.digest) push(issues, '$.digest', 'digest-mismatch', 'Envelope digest does not match its canonical contents.');

  applyEnvelopePolicy(envelope, policy, issues);
  return issues;
}

export function assertIntegrationEnvelope(envelope, policy = {}) {
  const issues = validateIntegrationEnvelope(envelope, policy);
  if (issues.length) throw new BridgeValidationError('Integration envelope is invalid or rejected by policy.', issues);
  return envelope;
}

export function trustRank(level) {
  return BRIDGE_TRUST_LEVELS.indexOf(level);
}

export function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..');
}

function applyEnvelopePolicy(envelope, policy, issues) {
  if (!isPlainObject(policy)) {
    push(issues, '$policy', 'type', 'Policy must be an object.');
    return;
  }
  const nowConfigured = Object.prototype.hasOwnProperty.call(policy, 'now')
    || policy.maxAgeMs != null || policy.clockSkewMs != null;
  const now = nowConfigured ? Date.parse(normalizeTimestamp(policy.now ?? new Date())) : null;
  const skew = finiteNonNegative(policy.clockSkewMs, 300_000);
  if (now != null && isIso(envelope.createdAt) && Date.parse(envelope.createdAt) > now + skew) {
    push(issues, '$.createdAt', 'from-future', 'Envelope creation time exceeds the allowed clock skew.');
  }
  if (now != null && isIso(envelope.expiresAt) && Date.parse(envelope.expiresAt) <= now) {
    push(issues, '$.expiresAt', 'stale', 'Envelope has expired.');
  }
  if (policy.maxAgeMs != null) {
    if (!Number.isFinite(policy.maxAgeMs) || policy.maxAgeMs < 0) push(issues, '$policy.maxAgeMs', 'range', 'maxAgeMs must be a non-negative finite number.');
    else if (now != null && isIso(envelope.createdAt) && now - Date.parse(envelope.createdAt) > policy.maxAgeMs) {
      push(issues, '$.createdAt', 'stale', `Envelope is older than ${policy.maxAgeMs} ms.`);
    }
  }
  const minimumTrust = policy.minimumTrust ?? policy.minTrust;
  if (minimumTrust != null) {
    if (!BRIDGE_TRUST_LEVELS.includes(minimumTrust)) push(issues, '$policy.minimumTrust', 'trust', 'Unknown minimum trust level.');
    else if (trustRank(envelope.trust?.level) < trustRank(minimumTrust)) push(issues, '$.trust.level', 'insufficient-trust', `Envelope trust is below ${minimumTrust}.`);
  }
  // Binding policy separates absence from contradiction. An unbound envelope
  // stays admissible (its trust level already grades it); a binding that names
  // a DIFFERENT commit or repository is evidence from somewhere else and is
  // rejected. Connections that must not accept unbound evidence opt in via
  // requireCommit / requireRepository.
  if (policy.requireCommit && !envelope.binding?.commit) push(issues, '$.binding.commit', 'commit-required', 'A commit binding is required.');
  if (policy.requireRepository && !envelope.binding?.repository) push(issues, '$.binding.repository', 'repository-required', 'A repository binding is required.');
  if (policy.expectedCommit != null && envelope.binding?.commit != null
    && envelope.binding.commit !== String(policy.expectedCommit).toLowerCase()) {
    push(issues, '$.binding.commit', 'commit-mismatch', `Expected commit ${policy.expectedCommit}.`);
  }
  if (policy.expectedRepository != null && envelope.binding?.repository != null
    && envelope.binding.repository !== policy.expectedRepository) {
    push(issues, '$.binding.repository', 'repository-mismatch', `Expected repository ${policy.expectedRepository}.`);
  }
  if (Array.isArray(policy.allowedProviders) && !policy.allowedProviders.includes(envelope.provider)) {
    push(issues, '$.provider', 'provider-denied', `Provider ${envelope.provider} is not allowed.`);
  }
  if (Array.isArray(policy.allowedKinds) && !policy.allowedKinds.includes(envelope.kind)) {
    push(issues, '$.kind', 'kind-denied', `Envelope kind ${envelope.kind} is not allowed.`);
  }
  for (const permission of policy.requiredPermissions ?? []) {
    if (!envelope.permissions?.includes?.(permission)) push(issues, '$.permissions', 'permission-missing', `Envelope does not declare ${permission}.`);
  }
}

function validateArtifact(artifact, path, issues) {
  exactObject(artifact, ['path', 'mediaType', 'bytes', 'sha256'], path, issues);
  if (!isPlainObject(artifact)) return;
  requiredKeys(artifact, ['path', 'mediaType', 'bytes', 'sha256'], path, issues);
  if (!isSafeRelativePath(artifact.path)) push(issues, `${path}.path`, 'unsafe-path', 'Artifact path must remain relative and cannot contain traversal segments.');
  nonEmptyString(artifact.mediaType, `${path}.mediaType`, issues, 256);
  if (!Number.isInteger(artifact.bytes) || artifact.bytes < 0) push(issues, `${path}.bytes`, 'range', 'Artifact bytes must be a non-negative integer.');
  if (!HASH_RE.test(artifact.sha256 ?? '')) push(issues, `${path}.sha256`, 'digest', 'Expected a lowercase SHA-256 digest.');
}

function exactObject(value, allowed, path, issues) {
  if (!isPlainObject(value)) {
    push(issues, path, 'type', 'Expected a plain object.');
    return;
  }
  for (const key of Object.keys(value)) if (!allowed.includes(key)) push(issues, `${path}.${key}`, 'unknown-key', `Unknown field ${key}.`);
}

function requiredKeys(value, required, path, issues) {
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(value, key)) push(issues, `${path}.${key}`, 'required', `${key} is required.`);
}

function stringArray(value, path, issues, options = {}) {
  if (!Array.isArray(value)) { push(issues, path, 'type', 'Expected an array.'); return; }
  if (options.nonEmpty && value.length === 0) push(issues, path, 'empty', 'Expected at least one entry.');
  if (options.maxItems != null && value.length > options.maxItems) push(issues, path, 'too-many', `Expected at most ${options.maxItems} entries.`);
  const seen = new Set();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !entry || (options.maxLength != null && entry.length > options.maxLength)) {
      push(issues, `${path}[${index}]`, 'string', 'Expected a non-empty bounded string.');
    } else if (options.allowed && !options.allowed.includes(entry)) push(issues, `${path}[${index}]`, 'enum', `Unknown value ${entry}.`);
    else if (options.pattern && !options.pattern.test(entry)) push(issues, `${path}[${index}]`, 'pattern', `Invalid value ${entry}.`);
    if (options.unique && seen.has(entry)) push(issues, `${path}[${index}]`, 'duplicate', `Duplicate value ${entry}.`);
    seen.add(entry);
  });
}

function nonEmptyString(value, path, issues, maxLength) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) push(issues, path, 'string', `Expected a non-empty string up to ${maxLength} characters.`);
}

function timestamp(value, path, issues) {
  if (!isIso(value)) push(issues, path, 'timestamp', 'Expected a canonical ISO-8601 UTC timestamp.');
}

function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BridgeValidationError('Timestamp is invalid.', [issue('$timestamp', 'timestamp', 'Expected a valid timestamp.')]);
  return date.toISOString();
}

function isIso(value) {
  if (value === null) return false;
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

function isJsonValue(value) {
  try { canonicalStringify(value); return true; } catch { return false; }
}

function canonicalClone(value) {
  return JSON.parse(canonicalStringify(value));
}

function orderedUnique(values, order) {
  if (!Array.isArray(values)) return values;
  const set = new Set(values);
  return order.filter((value) => set.has(value));
}

function sortedUnique(values) {
  if (!Array.isArray(values)) return values;
  return [...new Set(values)].sort();
}

function finiteNonNegative(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function push(issues, path, code, message) { issues.push(issue(path, code, message)); }
function issue(path, code, message) { return { path, code, message }; }
