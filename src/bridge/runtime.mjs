import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  BRIDGE_LIFECYCLES,
  BRIDGE_TRUST_LEVELS,
  INTEGRATION_ENVELOPE_SCHEMA,
  BridgeValidationError,
  assertIntegrationEnvelope,
  canonicalSha256,
  canonicalStringify,
  isSafeRelativePath,
  validateIntegrationEnvelope,
} from './contracts.mjs';
import { AdapterRegistry, BridgeRegistryError, resolveInsideRoot } from './registry.mjs';
import {
  isCredentialEnvReference,
  isCredentialKey,
  redactCredentialText,
  textCarriesCredentials,
  urlCarriesCredentials,
} from '../core/credential-safety.mjs';

export const BRIDGE_RUN_SCHEMA = 'axion-bridge-run/v1';
export const ARTIFACT_LEDGER_SCHEMA = 'axion-bridge-ledger/v1';
export const LEDGER_CONNECTION_SCHEMA = 'axion-bridge-connection/v1';
export const DEFAULT_BRIDGE_ARTIFACT_DIR = '.dk/bridge';
export const BRIDGE_LEDGER_FILE = 'ledger.json';
export const MAX_BRIDGE_LEDGER_BYTES = 64 * 1024 * 1024;

const HASH_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{7,64}$/;
const CONNECTION_STATUS = ['healthy', 'failed', 'incomplete'];
const MAX_BRIDGE_ARTIFACT_BYTES = 64 * 1024 * 1024;
const LEDGER_LOCK_TIMEOUT_MS = 15_000;
const LEDGER_LOCK_STALE_MS = 60_000;
const MAX_LEDGER_LOCK_BYTES = 4 * 1024;
const LEDGER_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));
const LEDGER_ERROR_MESSAGE = 'Bridge operation failed; raw diagnostics are withheld from the evidence ledger.';
const LEDGER_ERROR_CODES = new Set([
  'AXION_BRIDGE_ABORTED',
  'AXION_BRIDGE_ADAPTER',
  'AXION_BRIDGE_ADAPTER_INPUT',
  'AXION_BRIDGE_CONNECTION',
  'AXION_BRIDGE_DUPLICATE',
  'AXION_BRIDGE_EXISTS',
  'AXION_BRIDGE_FILE_TYPE',
  'AXION_BRIDGE_IDENTITY',
  'AXION_BRIDGE_INPUT',
  'AXION_BRIDGE_LEDGER',
  'AXION_BRIDGE_LIFECYCLE',
  'AXION_BRIDGE_LIFECYCLE_MISSING',
  'AXION_BRIDGE_LIMIT',
  'AXION_BRIDGE_MISSING',
  'AXION_BRIDGE_MODULE',
  'AXION_BRIDGE_OPTIONS',
  'AXION_BRIDGE_ORCHESTRATOR',
  'AXION_BRIDGE_OUTPUT',
  'AXION_BRIDGE_PARSE',
  'AXION_BRIDGE_PATH',
  'AXION_BRIDGE_PERMISSION',
  'AXION_BRIDGE_PROVIDER_MISSING',
  'AXION_BRIDGE_PUBLISH_INPUT',
  'AXION_BRIDGE_REGISTRY',
  'AXION_BRIDGE_REQUIRED_PROVIDER',
  'AXION_BRIDGE_ROOT',
  'AXION_BRIDGE_RUNTIME',
  'AXION_BRIDGE_SYMLINK',
  'AXION_BRIDGE_TIME',
  'AXION_BRIDGE_TIMEOUT',
  'AXION_BRIDGE_VALIDATION',
]);

export class BridgeRuntimeError extends Error {
  constructor(message, code = 'AXION_BRIDGE_RUNTIME', details = null) {
    super(message);
    this.name = 'BridgeRuntimeError';
    this.code = code;
    this.details = details;
  }
}
export class BridgeTimeoutError extends BridgeRuntimeError {
  constructor(adapter, operation, timeoutMs) {
    super(`Adapter ${adapter} timed out during ${operation} after ${timeoutMs} ms.`, 'AXION_BRIDGE_TIMEOUT', { adapter, operation, timeoutMs });
    this.name = 'BridgeTimeoutError';
  }
}
export class BridgeAbortError extends BridgeRuntimeError {
  constructor(adapter, operation, reason = null) {
    super(`Adapter ${adapter} was aborted during ${operation}.`, 'AXION_BRIDGE_ABORTED', { adapter, operation, reason: errorMessage(reason) });
    this.name = 'BridgeAbortError';
  }
}
export class BridgePermissionError extends BridgeRuntimeError {
  constructor(adapter, operation, missing) {
    super(`Adapter ${adapter} lacks granted permissions for ${operation}: ${missing.join(', ')}.`, 'AXION_BRIDGE_PERMISSION', { adapter, operation, missing });
    this.name = 'BridgePermissionError';
  }
}
export class BridgeRequiredProviderError extends BridgeRuntimeError {
  constructor(message, run) {
    super(message, 'AXION_BRIDGE_REQUIRED_PROVIDER', { run });
    this.name = 'BridgeRequiredProviderError';
    this.run = run;
  }
}
export class BridgeLedgerError extends BridgeRuntimeError {
  constructor(message, issues = []) {
    super(message, 'AXION_BRIDGE_LEDGER', { issues });
    this.name = 'BridgeLedgerError';
    this.issues = issues;
  }
}

export class BridgeRuntime {
  constructor(options = {}) {
    exactRuntimeOptions(options);
    this.registry = options.registry ?? new AdapterRegistry();
    if (!(this.registry instanceof AdapterRegistry)) throw new BridgeRuntimeError('registry must be an AdapterRegistry.', 'AXION_BRIDGE_OPTIONS');
    this.root = resolve(options.root ?? process.cwd());
    if (!existsSync(this.root) || !lstatSync(this.root).isDirectory()) throw new BridgeRuntimeError(`Bridge root is not a directory: ${this.root}.`, 'AXION_BRIDGE_ROOT');
    this.artifactDir = options.artifactDir ?? DEFAULT_BRIDGE_ARTIFACT_DIR;
    if (!isSafeRelativePath(this.artifactDir)) throw new BridgeRuntimeError('artifactDir must be a safe relative path.', 'AXION_BRIDGE_PATH');
    this.permissions = new Set(normalizeStringList(options.permissions ?? []));
    this.requiredProviders = new Set(normalizeStringList(options.requiredProviders ?? []));
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? 10_000);
    this.envelopePolicy = clone(options.envelopePolicy ?? {});
    this.repository = options.repository ?? this.root;
    if (typeof this.repository !== 'string' || !this.repository) throw new BridgeRuntimeError('repository must be a non-empty string.', 'AXION_BRIDGE_OPTIONS');
    this.commit = options.commit == null ? null : String(options.commit).toLowerCase();
    if (this.commit !== null && !COMMIT_RE.test(this.commit)) throw new BridgeRuntimeError('commit must be a 7-64 character hexadecimal id.', 'AXION_BRIDGE_OPTIONS');
    this.contractDigest = options.contractDigest ?? null;
    if (this.contractDigest !== null && !HASH_RE.test(this.contractDigest)) {
      throw new BridgeRuntimeError('contractDigest must be a SHA-256 digest.', 'AXION_BRIDGE_OPTIONS');
    }
    this.now = options.now ?? (() => new Date());
    if (typeof this.now !== 'function') throw new BridgeRuntimeError('now must be a function.', 'AXION_BRIDGE_OPTIONS');
    this.persistLedger = options.persistLedger !== false;
    this.verifyArtifacts = options.verifyArtifacts !== false;
    this.maxArtifactBytes = boundedArtifactBytes(options.maxArtifactBytes);
  }

  discover(input = {}, options = {}) { return this.run('discover', input, options); }
  collect(input = {}, options = {}) { return this.run('collect', input, options); }
  publish(input, options = {}) { return this.run('publish', input, options); }

  async run(operation, input = {}, options = {}) {
    if (!BRIDGE_LIFECYCLES.includes(operation)) throw new BridgeRuntimeError(`Unknown lifecycle ${operation}.`, 'AXION_BRIDGE_LIFECYCLE');
    exactRunOptions(options);
    const startedAt = iso(this.now());
    const runId = `run_${randomUUID().replaceAll('-', '')}`;
    const providers = normalizeProviders(options);
    const required = new Set([
      ...this.requiredProviders,
      ...normalizeStringList(options.requiredProviders ?? []),
    ]);
    const preflight = this.#preflight(operation, providers, required);
    if (preflight.failures.length) {
      for (const failure of preflight.failures) {
        await this.#recordFailure(operation, failure.provider, failure.provider, true, 'incomplete', failure.error, startedAt, 0, runId);
      }
      const run = finishRun(operation, startedAt, iso(this.now()), preflight.failures.map((failure) => failureResult(failure.provider, failure.provider, true, failure.error)), runId);
      throw new BridgeRequiredProviderError(`Required provider preflight failed for ${operation}.`, run);
    }

    if (operation === 'publish') validatePublishInput(input, this.#policy());
    const invocations = preflight.adapters.map((adapter) => this.#invoke(adapter, operation, input, {
      required: required.has(adapter.manifest.provider),
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      signal: options.signal,
    }));
    const results = await Promise.all(invocations);

    for (const result of results) await this.#recordResult(operation, input, result, runId);
    const run = finishRun(operation, startedAt, iso(this.now()), results, runId);
    const requiredFailure = results.find((result) => result.required && result.status !== 'fulfilled');
    if (requiredFailure) {
      throw new BridgeRequiredProviderError(`Required provider ${requiredFailure.provider} failed during ${operation}.`, run);
    }
    return run;
  }

  #preflight(operation, selectedProviders, required) {
    const failures = [];
    for (const provider of required) {
      const adapter = this.registry.getByProvider(provider);
      if (!adapter) failures.push({ provider, error: new BridgeRegistryError(`Required provider ${provider} is not registered.`, 'AXION_BRIDGE_PROVIDER_MISSING') });
      else if (!adapter.manifest.lifecycle.includes(operation)) failures.push({ provider, error: new BridgeRegistryError(`Required provider ${provider} does not implement ${operation}.`, 'AXION_BRIDGE_LIFECYCLE_MISSING') });
    }
    if (failures.length) return { failures, adapters: [] };
    const adapters = selectedProviders
      ? selectedProviders.map((provider) => {
        const adapter = this.registry.getByProvider(provider);
        if (!adapter) throw new BridgeRegistryError(`Selected provider ${provider} is not registered.`, 'AXION_BRIDGE_PROVIDER_MISSING');
        return adapter;
      })
      : this.registry.list(operation);
    for (const adapter of this.registry.requireProviders(required, operation)) if (!adapters.includes(adapter)) adapters.push(adapter);
    adapters.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
    return { failures, adapters };
  }

  async #invoke(adapter, operation, input, options) {
    const began = Date.now();
    const base = { adapter: adapter.manifest.id, provider: adapter.manifest.provider, required: options.required };
    try {
      const requiredPermissions = adapter.manifest.permissions[operation];
      const missing = requiredPermissions.filter((permission) => !hasGrant(this.permissions, permission));
      if (missing.length) throw new BridgePermissionError(adapter.manifest.id, operation, missing);
      const value = await invokeWithControl(adapter, operation, input, {
        root: this.root,
        manifest: adapter.manifest,
        timeoutMs: boundedTimeout(options.timeoutMs),
        signal: options.signal,
        now: iso(this.now()),
      });
      const normalized = this.#validateLifecycleOutput(operation, value);
      return { ...base, status: 'fulfilled', value: normalized, durationMs: Date.now() - began };
    } catch (error) {
      return { ...base, status: 'rejected', error: serializeError(error), durationMs: Date.now() - began };
    }
  }

  #validateLifecycleOutput(operation, value) {
    if (!Array.isArray(value)) throw new BridgeRuntimeError(`${operation} adapter output must be an array.`, 'AXION_BRIDGE_OUTPUT');
    if (operation === 'collect') {
      return value.map((envelope) => {
        const checked = clone(assertIntegrationEnvelope(envelope, this.#policy()));
        return clone(assertIntegrationEnvelope(
          snapshotEnvelopeArtifacts(this.root, this.artifactDir, checked, this.maxArtifactBytes),
          this.#policy(),
        ));
      });
    }
    if (operation === 'publish') {
      // Sinks may return ordinary provider receipts, or a first-class Bridge
      // envelope. Validate envelope-shaped receipts so they can become the
      // durable sink evidence instead of silently re-recording only the input.
      return value.map((item) => {
        if (item?.schema !== INTEGRATION_ENVELOPE_SCHEMA) return clone(item);
        const checked = clone(assertIntegrationEnvelope(item, this.#policy()));
        return clone(assertIntegrationEnvelope(
          snapshotEnvelopeArtifacts(this.root, this.artifactDir, checked, this.maxArtifactBytes),
          this.#policy(),
        ));
      });
    }
    canonicalStringify(value);
    return clone(value);
  }

  #policy() {
    return {
      ...this.envelopePolicy,
      now: iso(this.now()),
      ...(this.commit && this.envelopePolicy.expectedCommit == null ? { expectedCommit: this.commit } : {}),
      ...(this.repository && this.envelopePolicy.expectedRepository == null && this.envelopePolicy.bindRepository === true
        ? { expectedRepository: this.repository } : {}),
    };
  }

  async #recordResult(operation, input, result, runId) {
    if (!this.persistLedger) return;
    const inputEnvelopeDigest = operation === 'publish' && HASH_RE.test(input?.envelope?.digest ?? '')
      ? input.envelope.digest : null;
    const common = {
      adapter: result.adapter,
      provider: result.provider,
      operation,
      required: result.required,
      runId,
      ...(inputEnvelopeDigest ? { inputEnvelopeDigest } : {}),
      ...(this.contractDigest ? { contractDigest: this.contractDigest } : {}),
      durationMs: result.durationMs,
    };
    if (result.status !== 'fulfilled') {
      await this.#recordFailure(
        operation, result.adapter, result.provider, result.required, 'failed', result.error,
        iso(this.now()), result.durationMs, runId, inputEnvelopeDigest,
      );
      return;
    }
    const publishReceipts = operation === 'publish'
      ? result.value.filter((item) => item?.schema === INTEGRATION_ENVELOPE_SCHEMA)
      : [];
    const envelopes = operation === 'collect' ? result.value
      : operation === 'publish' ? publishReceipts
        : [];
    if (!envelopes.length) {
      await this.#appendLedger({ ...common, status: 'healthy', trust: 'untrusted' });
      return;
    }
    for (const envelope of envelopes) {
      await this.#appendLedger({ ...common, status: 'healthy', trust: envelope.trust.level, envelope });
    }
  }

  async #recordFailure(operation, adapter, provider, required, status, error, createdAt, durationMs, runId, inputEnvelopeDigest = null) {
    if (!this.persistLedger) return;
    await this.#appendLedger({
      adapter, provider, operation, required, status, trust: 'untrusted',
      ...(runId ? { runId } : {}),
      ...(inputEnvelopeDigest ? { inputEnvelopeDigest } : {}),
      ...(this.contractDigest ? { contractDigest: this.contractDigest } : {}),
      error: serializeError(error), durationMs, createdAt,
    });
  }

  async #appendLedger(connection) {
    appendArtifactLedger(this.root, connection, {
      artifactDir: this.artifactDir,
      repository: this.repository,
      commit: this.commit,
      now: this.now(),
      verifyArtifacts: this.verifyArtifacts,
      maxArtifactBytes: this.maxArtifactBytes,
    });
  }
}

export function createBridgeRuntime(options = {}) { return new BridgeRuntime(options); }

export async function invokeWithControl(adapter, operation, input, options) {
  const timeoutMs = boundedTimeout(options.timeoutMs);
  const controller = new AbortController();
  let timeout;
  let removeExternal = () => {};
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const abort = (error) => {
    if (!controller.signal.aborted) controller.abort(error);
    rejectAbort(error);
  };
  if (options.signal) {
    if (options.signal.aborted) abort(new BridgeAbortError(adapter.manifest.id, operation, options.signal.reason));
    else {
      const onAbort = () => abort(new BridgeAbortError(adapter.manifest.id, operation, options.signal.reason));
      options.signal.addEventListener('abort', onAbort, { once: true });
      removeExternal = () => options.signal.removeEventListener('abort', onAbort);
    }
  }
  timeout = setTimeout(() => abort(new BridgeTimeoutError(adapter.manifest.id, operation, timeoutMs)), timeoutMs);
  const context = {
    root: options.root,
    manifest: options.manifest,
    signal: controller.signal,
    now: options.now,
  };
  try {
    return await Promise.race([Promise.resolve().then(() => adapter[operation](input, context)), aborted]);
  } finally {
    clearTimeout(timeout);
    removeExternal();
  }
}

export function artifactLedgerPath(root, artifactDir = DEFAULT_BRIDGE_ARTIFACT_DIR) {
  if (!isSafeRelativePath(artifactDir)) throw new BridgeLedgerError('artifactDir must be a safe relative path.', [ledgerIssue('$artifactDir', 'unsafe-path', 'Expected a safe relative directory.')]);
  const directory = resolveInsideRoot(root, artifactDir, { allowMissing: true });
  return join(directory, BRIDGE_LEDGER_FILE);
}

export function emptyArtifactLedger(repository = {}, now = new Date()) {
  const repo = normalizeRepository(repository);
  const body = {
    schema: ARTIFACT_LEDGER_SCHEMA,
    generatedAt: iso(now),
    repository: repo,
    connections: [],
    summary: summarizeConnections([]),
    headHash: null,
  };
  return { ...body, digest: canonicalSha256(body) };
}

export function appendArtifactLedger(root, input, options = {}) {
  exactLedgerOptions(options);
  const maxArtifactBytes = boundedArtifactBytes(options.maxArtifactBytes);
  const path = artifactLedgerPath(root, options.artifactDir ?? DEFAULT_BRIDGE_ARTIFACT_DIR);
  mkdirLedgerDirectory(root, dirname(path));
  const lock = acquireLedgerLock(path);
  try {
  const loaded = readArtifactLedger(root, {
    artifactDir: options.artifactDir,
    repository: options.repository,
    commit: options.commit,
    now: options.now,
    verifyArtifacts: options.verifyArtifacts,
    maxArtifactBytes,
  });
  if (!loaded.ok) throw new BridgeLedgerError('Refusing to append to an invalid Bridge ledger.', loaded.issues);
  const repository = normalizeRepository({
    root: options.repository ?? loaded.ledger.repository.root,
    commit: options.commit === undefined ? loaded.ledger.repository.commit : options.commit,
  });
  const previousHash = loaded.ledger.connections.at(-1)?.entryHash ?? null;
  if (input?.envelope) assertCredentialSafeValue(input.envelope, 'Bridge envelope', { allowEnvReferences: false });
  const snapshottedInput = input?.envelope
    ? { ...input, envelope: snapshotEnvelopeArtifacts(root, options.artifactDir ?? DEFAULT_BRIDGE_ARTIFACT_DIR, input.envelope, maxArtifactBytes) }
    : input;
  const payload = normalizeConnection(snapshottedInput, { now: options.now ?? new Date(), previousHash });
  const id = `con_${canonicalSha256(payload).slice(0, 16)}`;
  const entry = { ...payload, id, entryHash: canonicalSha256({ ...payload, id }) };
  const connections = [...loaded.ledger.connections, entry];
  const body = {
    schema: ARTIFACT_LEDGER_SCHEMA,
    generatedAt: iso(options.now ?? new Date()),
    repository,
    connections,
    summary: summarizeConnections(connections),
    headHash: entry.entryHash,
  };
  const ledger = { ...body, digest: canonicalSha256(body) };
  const verified = verifyArtifactLedger(ledger, {
    root, verifyArtifacts: options.verifyArtifacts !== false, maxArtifactBytes,
  });
  if (!verified.ok) throw new BridgeLedgerError('Generated Bridge ledger failed self-verification.', verified.issues);
  const serialized = `${JSON.stringify(ledger, null, 2)}\n`;
  const serializedBytes = Buffer.byteLength(serialized);
  if (serializedBytes > MAX_BRIDGE_LEDGER_BYTES) {
    throw new BridgeLedgerError('Bridge ledger capacity exceeded; archive the current ledger before collecting more evidence.', [
      ledgerIssue('$', 'ledger-too-large', `Bridge ledger would exceed the ${MAX_BRIDGE_LEDGER_BYTES} byte limit.`),
    ]);
  }
  mkdirLedgerDirectory(root, dirname(path));
  atomicWrite(path, serialized);
  return { ledger, entry, path, headHash: entry.entryHash };
  } finally {
    releaseLedgerLock(lock);
  }
}

export function readArtifactLedger(root, options = {}) {
  exactReadLedgerOptions(options);
  const maxArtifactBytes = boundedArtifactBytes(options.maxArtifactBytes);
  const path = artifactLedgerPath(root, options.artifactDir ?? DEFAULT_BRIDGE_ARTIFACT_DIR);
  if (!existsSync(path)) {
    const ledger = emptyArtifactLedger({ root: options.repository ?? resolve(root), commit: options.commit ?? null }, options.now ?? new Date());
    return { ok: true, missing: true, ledger, issues: [], path, headHash: null };
  }
  let ledger;
  try {
    const safePath = resolveInsideRoot(root, slash(relative(root, path)));
    const size = lstatSync(safePath).size;
    if (size > MAX_BRIDGE_LEDGER_BYTES) {
      return {
        ok: false, missing: false, ledger: null,
        issues: [ledgerIssue('$', 'ledger-too-large', `Bridge ledger exceeds the ${MAX_BRIDGE_LEDGER_BYTES} byte limit.`)],
        path, headHash: null, summary: null,
      };
    }
    ledger = JSON.parse(readFileSync(safePath, 'utf8'));
  }
  catch (error) {
    return { ok: false, missing: false, ledger: null, issues: [ledgerIssue('$', 'invalid-json', error.message)], path, headHash: null };
  }
  const verified = verifyArtifactLedger(ledger, {
    root, verifyArtifacts: options.verifyArtifacts !== false, maxArtifactBytes,
  });
  return { ...verified, missing: false, ledger, path };
}

export function verifyArtifactLedger(ledger, options = {}) {
  const maxArtifactBytes = boundedArtifactBytes(options.maxArtifactBytes);
  const issues = [];
  exactLedger(ledger, issues);
  if (!isPlainObject(ledger)) return { ok: false, issues, headHash: null, summary: null };
  let previous = null;
  const ids = new Set();
  if (Array.isArray(ledger.connections)) {
    ledger.connections.forEach((entry, index) => {
      try {
        validateConnection(entry, index, previous, issues, { ...options, maxArtifactBytes });
      } catch {
        issues.push(ledgerIssue(`$.connections[${index}]`, 'malformed', 'Connection could not be safely validated.'));
      }
      if (ids.has(entry?.id)) issues.push(ledgerIssue(`$.connections[${index}].id`, 'duplicate', `Duplicate connection id ${entry.id}.`));
      ids.add(entry?.id);
      previous = typeof entry?.entryHash === 'string' ? entry.entryHash : null;
    });
  }
  const expectedSummary = Array.isArray(ledger.connections) ? summarizeConnections(ledger.connections) : null;
  if (expectedSummary && isPlainObject(ledger.summary)) {
    try {
      if (canonicalStringify(ledger.summary) !== canonicalStringify(expectedSummary)) issues.push(ledgerIssue('$.summary', 'summary-mismatch', 'Ledger summary does not match connections.'));
    } catch {
      issues.push(ledgerIssue('$.summary', 'malformed', 'Ledger summary could not be safely validated.'));
    }
  }
  if (ledger.headHash !== previous) issues.push(ledgerIssue('$.headHash', 'head-mismatch', 'Ledger headHash does not match the last connection.'));
  if (HASH_RE.test(ledger.digest ?? '')) {
    const { digest: _digest, ...body } = ledger;
    try {
      if (canonicalSha256(body) !== ledger.digest) issues.push(ledgerIssue('$.digest', 'digest-mismatch', 'Ledger digest does not match its canonical contents.'));
    } catch {
      issues.push(ledgerIssue('$.digest', 'malformed', 'Ledger contents cannot be canonicalized.'));
    }
  }
  return { ok: issues.length === 0, issues, headHash: previous, summary: expectedSummary };
}

function normalizeConnection(input, options) {
  const allowed = ['adapter', 'provider', 'operation', 'required', 'status', 'trust', 'runId', 'inputEnvelopeDigest', 'contractDigest', 'envelope', 'error', 'durationMs', 'createdAt'];
  if (!isPlainObject(input)) throw new BridgeLedgerError('Ledger connection input must be an object.');
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new BridgeLedgerError(`Unknown ledger connection fields: ${unknown.join(', ')}.`);
  if (input.envelope) assertIntegrationEnvelope(input.envelope);
  const payload = {
    schema: LEDGER_CONNECTION_SCHEMA,
    adapter: requiredString(input.adapter, 'adapter'),
    provider: requiredString(input.provider ?? input.adapter, 'provider'),
    operation: BRIDGE_LIFECYCLES.includes(input.operation) ? input.operation : failLedger('operation must be discover, collect, or publish.'),
    required: input.required === true,
    status: CONNECTION_STATUS.includes(input.status) ? input.status : failLedger('status must be healthy, failed, or incomplete.'),
    trust: BRIDGE_TRUST_LEVELS.includes(input.trust) ? input.trust : failLedger('trust is invalid.'),
    ...(input.runId != null ? { runId: bridgeRunId(input.runId) } : {}),
    ...(input.inputEnvelopeDigest != null ? { inputEnvelopeDigest: sha256String(input.inputEnvelopeDigest, 'inputEnvelopeDigest') } : {}),
    ...(input.contractDigest != null ? { contractDigest: sha256String(input.contractDigest, 'contractDigest') } : {}),
    ...(input.envelope ? { envelope: clone(input.envelope) } : {}),
    ...(input.error ? { error: normalizeError(input.error) } : {}),
    ...(input.durationMs != null ? { durationMs: finiteDuration(input.durationMs) } : {}),
    createdAt: iso(input.createdAt ?? options.now),
    previousHash: options.previousHash,
  };
  if (payload.status === 'healthy' && payload.error) throw new BridgeLedgerError('Healthy connections cannot contain an error.');
  if (payload.status !== 'healthy' && !payload.error) throw new BridgeLedgerError('Failed or incomplete connections require an error.');
  if (payload.inputEnvelopeDigest && payload.operation !== 'publish') {
    throw new BridgeLedgerError('inputEnvelopeDigest is valid only for publish entries.');
  }
  return payload;
}

function validateConnection(entry, index, previous, issues, options) {
  const path = `$.connections[${index}]`;
  const required = ['schema', 'id', 'adapter', 'provider', 'operation', 'required', 'status', 'trust', 'createdAt', 'previousHash', 'entryHash'];
  const optional = ['runId', 'inputEnvelopeDigest', 'contractDigest', 'envelope', 'error', 'durationMs'];
  if (!isPlainObject(entry)) { issues.push(ledgerIssue(path, 'type', 'Connection must be an object.')); return; }
  for (const key of Object.keys(entry)) if (![...required, ...optional].includes(key)) issues.push(ledgerIssue(`${path}.${key}`, 'unknown-key', `Unknown field ${key}.`));
  for (const key of required) if (!Object.prototype.hasOwnProperty.call(entry, key)) issues.push(ledgerIssue(`${path}.${key}`, 'required', `${key} is required.`));
  if (entry.schema !== LEDGER_CONNECTION_SCHEMA) issues.push(ledgerIssue(`${path}.schema`, 'schema', `Expected ${LEDGER_CONNECTION_SCHEMA}.`));
  if (!/^con_[a-f0-9]{16}$/.test(entry.id ?? '')) issues.push(ledgerIssue(`${path}.id`, 'id', 'Invalid connection id.'));
  for (const field of ['adapter', 'provider']) if (typeof entry[field] !== 'string' || !entry[field]) issues.push(ledgerIssue(`${path}.${field}`, 'string', `${field} must be non-empty.`));
  if (!BRIDGE_LIFECYCLES.includes(entry.operation)) issues.push(ledgerIssue(`${path}.operation`, 'enum', 'Unknown lifecycle.'));
  if (typeof entry.required !== 'boolean') issues.push(ledgerIssue(`${path}.required`, 'type', 'required must be boolean.'));
  if (!CONNECTION_STATUS.includes(entry.status)) issues.push(ledgerIssue(`${path}.status`, 'enum', 'Unknown connection status.'));
  if (!BRIDGE_TRUST_LEVELS.includes(entry.trust)) issues.push(ledgerIssue(`${path}.trust`, 'enum', 'Unknown trust level.'));
  if (entry.runId != null && !/^run_[a-f0-9]{32}$/.test(entry.runId)) issues.push(ledgerIssue(`${path}.runId`, 'id', 'runId is invalid.'));
  if (entry.inputEnvelopeDigest != null && !HASH_RE.test(entry.inputEnvelopeDigest)) issues.push(ledgerIssue(`${path}.inputEnvelopeDigest`, 'digest', 'inputEnvelopeDigest must be SHA-256.'));
  if (entry.inputEnvelopeDigest != null && entry.operation !== 'publish') issues.push(ledgerIssue(`${path}.inputEnvelopeDigest`, 'operation', 'inputEnvelopeDigest is valid only for publish entries.'));
  if (entry.contractDigest != null && !HASH_RE.test(entry.contractDigest)) issues.push(ledgerIssue(`${path}.contractDigest`, 'digest', 'contractDigest must be SHA-256.'));
  if (!isCanonicalIso(entry.createdAt)) issues.push(ledgerIssue(`${path}.createdAt`, 'timestamp', 'Expected canonical ISO timestamp.'));
  if (entry.previousHash !== previous) issues.push(ledgerIssue(`${path}.previousHash`, 'broken-chain', 'Connection previousHash does not match.'));
  if (!HASH_RE.test(entry.entryHash ?? '')) issues.push(ledgerIssue(`${path}.entryHash`, 'digest', 'Invalid entry hash.'));
  if (entry.envelope) {
    try {
      for (const issue of validateIntegrationEnvelope(entry.envelope)) issues.push(ledgerIssue(`${path}.envelope${issue.path.slice(1)}`, issue.code, issue.message));
    } catch {
      issues.push(ledgerIssue(`${path}.envelope`, 'malformed', 'Envelope could not be safely validated.'));
    }
    try { assertCredentialSafeValue(entry.envelope, 'Bridge envelope', { allowEnvReferences: false }); }
    catch (error) { issues.push(ledgerIssue(`${path}.envelope`, 'credential-exposure', error.message)); }
    if (entry.trust !== entry.envelope.trust?.level) issues.push(ledgerIssue(`${path}.trust`, 'trust-mismatch', 'Connection trust must match envelope trust.'));
    if (options.verifyArtifacts !== false && options.root && Array.isArray(entry.envelope?.artifacts)) {
      verifyEnvelopeArtifacts(entry.envelope, options.root, path, issues, options.maxArtifactBytes);
    }
  }
  if (entry.error != null) {
    const validShape = isPlainObject(entry.error)
      && Object.keys(entry.error).every((key) => ['code', 'message'].includes(key))
      && typeof entry.error.code === 'string' && typeof entry.error.message === 'string';
    if (!validShape) {
      issues.push(ledgerIssue(`${path}.error`, 'error-shape', 'error must contain only string code and message.'));
    } else {
      if (textCarriesCredentials(entry.error.code) || textCarriesCredentials(entry.error.message)) {
        issues.push(ledgerIssue(`${path}.error`, 'credential-exposure', 'Error diagnostics contain credential material.'));
      }
      if (!LEDGER_ERROR_CODES.has(entry.error.code) || entry.error.message !== LEDGER_ERROR_MESSAGE) {
        issues.push(ledgerIssue(`${path}.error`, 'error-canonical', 'Ledger errors must use a canonical code and withheld diagnostic message.'));
      }
    }
  }
  if (entry.status === 'healthy' && entry.error) issues.push(ledgerIssue(`${path}.error`, 'healthy-error', 'Healthy connection cannot contain error.'));
  if (entry.status !== 'healthy' && !entry.error) issues.push(ledgerIssue(`${path}.error`, 'missing-error', 'Non-healthy connection requires error.'));
  if (entry.durationMs != null && (!Number.isFinite(entry.durationMs) || entry.durationMs < 0)) issues.push(ledgerIssue(`${path}.durationMs`, 'range', 'durationMs must be non-negative.'));
  const { id, entryHash: _entryHash, ...payload } = entry;
  try {
    if (canonicalSha256(payload).slice(0, 16) !== String(id ?? '').slice(4)) issues.push(ledgerIssue(`${path}.id`, 'id-mismatch', 'Connection id does not match its contents.'));
    if (HASH_RE.test(entry.entryHash ?? '') && canonicalSha256({ ...payload, id }) !== entry.entryHash) issues.push(ledgerIssue(`${path}.entryHash`, 'hash-mismatch', 'Connection hash does not match its contents.'));
  } catch {
    issues.push(ledgerIssue(path, 'malformed', 'Connection contents cannot be canonicalized.'));
  }
}

function exactLedger(ledger, issues) {
  if (!isPlainObject(ledger)) { issues.push(ledgerIssue('$', 'type', 'Ledger must be an object.')); return; }
  const fields = ['schema', 'generatedAt', 'repository', 'connections', 'summary', 'headHash', 'digest'];
  for (const key of Object.keys(ledger)) if (!fields.includes(key)) issues.push(ledgerIssue(`$.${key}`, 'unknown-key', `Unknown field ${key}.`));
  for (const key of fields) if (!Object.prototype.hasOwnProperty.call(ledger, key)) issues.push(ledgerIssue(`$.${key}`, 'required', `${key} is required.`));
  if (ledger.schema !== ARTIFACT_LEDGER_SCHEMA) issues.push(ledgerIssue('$.schema', 'schema', `Expected ${ARTIFACT_LEDGER_SCHEMA}.`));
  if (!isCanonicalIso(ledger.generatedAt)) issues.push(ledgerIssue('$.generatedAt', 'timestamp', 'Expected canonical ISO timestamp.'));
  try { normalizeRepository(ledger.repository); } catch (error) { issues.push(ledgerIssue('$.repository', 'repository', error.message)); }
  if (!Array.isArray(ledger.connections)) issues.push(ledgerIssue('$.connections', 'type', 'connections must be an array.'));
  if (!isPlainObject(ledger.summary)) issues.push(ledgerIssue('$.summary', 'type', 'summary must be an object.'));
  else {
    const fields = ['total', 'healthy', 'failed', 'incomplete', 'requiredFailed'];
    for (const key of Object.keys(ledger.summary)) if (!fields.includes(key)) issues.push(ledgerIssue(`$.summary.${key}`, 'unknown-key', `Unknown summary field ${key}.`));
    for (const key of fields) if (!Number.isInteger(ledger.summary[key]) || ledger.summary[key] < 0) issues.push(ledgerIssue(`$.summary.${key}`, 'range', `${key} must be a non-negative integer.`));
  }
  if (ledger.headHash !== null && !HASH_RE.test(ledger.headHash ?? '')) issues.push(ledgerIssue('$.headHash', 'digest', 'headHash must be null or SHA-256.'));
  if (!HASH_RE.test(ledger.digest ?? '')) issues.push(ledgerIssue('$.digest', 'digest', 'digest must be SHA-256.'));
}

function snapshotEnvelopeArtifacts(root, artifactDir, envelope, maxArtifactBytes) {
  if (!Array.isArray(envelope?.artifacts) || envelope.artifacts.length === 0) return envelope;
  const objectsDir = `${artifactDir}/objects`;
  mkdirLedgerDirectory(root, resolve(root, objectsDir));
  let changed = false;
  const artifacts = envelope.artifacts.map((artifact) => {
    if (artifact.bytes > maxArtifactBytes) {
      throw new BridgeLedgerError(`Artifact exceeds the ${maxArtifactBytes} byte snapshot limit.`);
    }
    const source = resolveInsideRoot(root, artifact.path);
    const objectPath = `${objectsDir}/${artifact.sha256}`;
    const destination = resolveInsideRoot(root, objectPath, { allowMissing: true });
    if (artifact.path !== objectPath) changed = true;
    if (source === destination || existsSync(destination)) {
      verifySnapshotFile(destination, artifact, maxArtifactBytes);
      return { ...artifact, path: objectPath };
    }
    const temporary = `${destination}.tmp-${process.pid}-${randomUUID()}`;
    try {
      copyFileSync(source, temporary);
      verifySnapshotFile(temporary, artifact, maxArtifactBytes);
      // The object name is its digest. Concurrent writers may replace the same
      // path only with bytes that passed that exact digest check.
      renameSync(temporary, destination);
    } finally {
      try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort */ }
    }
    return { ...artifact, path: objectPath };
  });
  if (!changed) return envelope;
  const { digest: _digest, ...body } = { ...envelope, artifacts };
  return { ...body, digest: canonicalSha256(body) };
}

function verifySnapshotFile(path, artifact, maxArtifactBytes) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new BridgeLedgerError('Artifact snapshot must be a regular file.');
  if (stat.size !== artifact.bytes) throw new BridgeLedgerError('Artifact snapshot byte count does not match its descriptor.');
  if (stat.size > maxArtifactBytes) throw new BridgeLedgerError(`Artifact snapshot exceeds the ${maxArtifactBytes} byte limit.`);
  const descriptor = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
  } finally {
    closeSync(descriptor);
  }
  if (hash.digest('hex') !== artifact.sha256) throw new BridgeLedgerError('Artifact snapshot digest does not match its descriptor.');
  assertCredentialSafeSnapshot(path, artifact);
}

function assertCredentialSafeSnapshot(path, artifact) {
  const declaredJson = /(?:^|\/)(?:[a-z0-9.+-]+\+)?json(?:$|;)/i.test(artifact.mediaType ?? '');
  const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  const looksJson = /^[\s\r\n]*[\[{]/.test(text);
  if (!declaredJson && !looksJson) return;
  let value;
  try { value = JSON.parse(text); }
  catch {
    if (declaredJson) throw new BridgeLedgerError('A JSON artifact snapshot must contain valid JSON.');
    return;
  }
  assertCredentialSafeValue(value, 'JSON artifact snapshot', { allowEnvReferences: true });
}

function assertCredentialSafeValue(value, label, { allowEnvReferences }) {
  const stack = [{ value, path: '$' }];
  const seen = new WeakSet();
  let visited = 0;
  while (stack.length) {
    const current = stack.pop();
    if (++visited > 1_000_000) throw new BridgeLedgerError(`${label} is too complex for bounded credential scanning.`);
    if (typeof current.value === 'string') {
      if (urlCarriesCredentials(current.value)) {
        throw new BridgeLedgerError(`Refusing to persist credential-bearing URL at ${current.path}.`);
      }
      continue;
    }
    if (current.value && typeof current.value === 'object') {
      if (seen.has(current.value)) continue;
      seen.add(current.value);
    }
    if (Array.isArray(current.value)) {
      current.value.forEach((item, index) => stack.push({ value: item, path: `${current.path}[${index}]` }));
      continue;
    }
    if (!isPlainObject(current.value)) continue;
    for (const [key, nested] of Object.entries(current.value)) {
      const nestedPath = `${current.path}.${key}`;
      if (isCredentialKey(key)) {
        const normalized = String(key).replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[-.]+/g, '_').toLowerCase();
        const numericMetadata = typeof nested === 'number'
          && Number.isFinite(nested)
          && /_(?:age|bytes|count|length|size|ttl|version)$/.test(normalized);
        const safeMarker = nested == null || typeof nested === 'boolean' || numericMetadata
          || nested === '[REDACTED]'
          || (/(?:^|_)(?:sha256|digest|hash)$/.test(normalized)
            && typeof nested === 'string' && HASH_RE.test(nested));
        const safeEnv = allowEnvReferences && isCredentialEnvReference(key, nested);
        const designTokenContainer = /^(?:tokens|design_tokens|dtcg_tokens)$/.test(normalized)
          && nested && typeof nested === 'object';
        if (!safeMarker && !safeEnv && !designTokenContainer) {
          const scope = label === 'JSON artifact snapshot' ? 'JSON artifact ' : '';
          throw new BridgeLedgerError(`Refusing to persist credential-shaped ${scope}field ${nestedPath}.`);
        }
      }
      if (nested && typeof nested === 'object') stack.push({ value: nested, path: nestedPath });
      else if (typeof nested === 'string') stack.push({ value: nested, path: nestedPath });
    }
  }
}

function verifyEnvelopeArtifacts(envelope, root, path, issues, maxArtifactBytes) {
  envelope.artifacts.forEach((artifact, index) => {
    const at = `${path}.envelope.artifacts[${index}]`;
    let descriptor;
    try {
      const absolute = resolveInsideRoot(root, artifact.path);
      const stat = lstatSync(absolute);
      if (!stat.isFile()) throw new Error('Artifact is not a regular file.');
      if (artifact.bytes > maxArtifactBytes || stat.size > maxArtifactBytes) {
        issues.push(ledgerIssue(`${at}.bytes`, 'artifact-too-large', `Artifact exceeds the ${maxArtifactBytes} byte verification limit.`));
        return;
      }
      descriptor = openSync(absolute, 'r');
      const hash = createHash('sha256');
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let total = 0;
      while (true) {
        const count = readSync(descriptor, buffer, 0, buffer.length, null);
        if (count === 0) break;
        total += count;
        if (total > maxArtifactBytes) {
          issues.push(ledgerIssue(`${at}.bytes`, 'artifact-too-large', `Artifact exceeded the ${maxArtifactBytes} byte verification limit while being read.`));
          return;
        }
        hash.update(buffer.subarray(0, count));
      }
      if (total !== artifact.bytes) issues.push(ledgerIssue(`${at}.bytes`, 'artifact-size', 'Artifact byte count does not match.'));
      if (hash.digest('hex') !== artifact.sha256) issues.push(ledgerIssue(`${at}.sha256`, 'artifact-digest', 'Artifact digest does not match.'));
    } catch (error) {
      issues.push(ledgerIssue(`${at}.path`, 'artifact-missing', error.message));
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  });
}

function normalizeRepository(value) {
  const source = typeof value === 'string' ? { root: value, commit: null } : value;
  if (!isPlainObject(source)) throw new BridgeLedgerError('repository must be an object.');
  const unknown = Object.keys(source).filter((key) => !['root', 'commit'].includes(key));
  if (unknown.length || typeof source.root !== 'string' || !source.root) throw new BridgeLedgerError('repository requires only a non-empty root and optional commit.');
  const commit = source.commit == null ? null : String(source.commit).toLowerCase();
  if (commit !== null && !COMMIT_RE.test(commit)) throw new BridgeLedgerError('repository.commit is invalid.');
  return { root: source.root, commit };
}

function summarizeConnections(connections) {
  const valid = connections.filter(isPlainObject);
  return {
    total: connections.length,
    healthy: valid.filter((entry) => entry.status === 'healthy').length,
    failed: valid.filter((entry) => entry.status === 'failed').length,
    incomplete: valid.filter((entry) => entry.status === 'incomplete').length,
    requiredFailed: valid.filter((entry) => entry.required && entry.status !== 'healthy').length,
  };
}

function finishRun(operation, startedAt, finishedAt, results, runId) {
  const fulfilled = results.filter((result) => result.status === 'fulfilled').length;
  const rejected = results.length - fulfilled;
  return {
    schema: BRIDGE_RUN_SCHEMA,
    runId,
    operation,
    startedAt,
    finishedAt,
    status: rejected ? (fulfilled ? 'partial' : 'failed') : 'passed',
    results,
    summary: { total: results.length, fulfilled, rejected, requiredFailed: results.filter((result) => result.required && result.status !== 'fulfilled').length },
  };
}

function normalizeProviders(options) {
  if (options.provider != null && options.providers != null) throw new BridgeRuntimeError('Use provider or providers, not both.', 'AXION_BRIDGE_OPTIONS');
  if (options.provider != null) return [requiredString(options.provider, 'provider')];
  if (options.providers != null) return normalizeStringList(options.providers);
  return null;
}
function validatePublishInput(input, policy) {
  if (!isPlainObject(input) || !Object.prototype.hasOwnProperty.call(input, 'envelope')) throw new BridgeRuntimeError('publish input must contain envelope.', 'AXION_BRIDGE_INPUT');
  assertIntegrationEnvelope(input.envelope, policy);
}
function hasGrant(grants, permission) {
  if (grants.has(permission) || grants.has('*')) return true;
  const namespace = permission.split(':')[0];
  return grants.has(`${namespace}:*`);
}
function boundedTimeout(value) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 300_000) throw new BridgeRuntimeError('timeoutMs must be an integer from 1 to 300000.', 'AXION_BRIDGE_OPTIONS');
  return number;
}
function boundedArtifactBytes(value) {
  if (value == null) return MAX_BRIDGE_ARTIFACT_BYTES;
  if (!Number.isInteger(value) || value < 1 || value > MAX_BRIDGE_ARTIFACT_BYTES) {
    throw new BridgeRuntimeError(`maxArtifactBytes must be an integer from 1 to ${MAX_BRIDGE_ARTIFACT_BYTES}.`, 'AXION_BRIDGE_OPTIONS');
  }
  return value;
}
function failureResult(adapter, provider, required, error) {
  return { adapter, provider, required, status: 'rejected', error: serializeError(error), durationMs: 0 };
}
function serializeError(error) {
  return { code: canonicalLedgerErrorCode(error?.code), message: errorMessage(error) };
}
function normalizeError(error) {
  return { code: canonicalLedgerErrorCode(error?.code), message: LEDGER_ERROR_MESSAGE };
}
function canonicalLedgerErrorCode(value) {
  return typeof value === 'string' && LEDGER_ERROR_CODES.has(value) ? value : 'AXION_BRIDGE_ADAPTER';
}
function errorMessage(error) {
  let message;
  try { message = String(error?.message ?? error ?? 'Unknown Bridge error'); }
  catch { message = 'Unknown Bridge error'; }
  const bounded = message.replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 2000);
  return redactCredentialText(bounded, LEDGER_ERROR_MESSAGE);
}
function requiredString(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 64) throw new BridgeRuntimeError(`${field} must be a non-empty string up to 64 characters.`, 'AXION_BRIDGE_INPUT');
  return value;
}
function sha256String(value, field) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) throw new BridgeLedgerError(`${field} must be a SHA-256 digest.`);
  return value;
}
function bridgeRunId(value) {
  if (typeof value !== 'string' || !/^run_[a-f0-9]{32}$/.test(value)) throw new BridgeLedgerError('runId is invalid.');
  return value;
}
function finiteDuration(value) {
  if (!Number.isFinite(value) || value < 0) throw new BridgeLedgerError('durationMs must be non-negative.');
  return Math.round(value);
}
function failLedger(message) { throw new BridgeLedgerError(message); }
function iso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BridgeRuntimeError('Invalid timestamp.', 'AXION_BRIDGE_TIME');
  return date.toISOString();
}
function isCanonicalIso(value) {
  if (typeof value !== 'string') return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}
function normalizeStringList(values) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value)) throw new BridgeRuntimeError('Expected an array of non-empty strings.', 'AXION_BRIDGE_OPTIONS');
  return [...new Set(values)].sort();
}
function clone(value) { return JSON.parse(canonicalStringify(value)); }
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function exactRuntimeOptions(options) {
  exactKeys(options, ['registry', 'root', 'artifactDir', 'permissions', 'requiredProviders', 'timeoutMs', 'envelopePolicy', 'repository', 'commit', 'contractDigest', 'now', 'persistLedger', 'verifyArtifacts', 'maxArtifactBytes'], 'runtime');
}
function exactRunOptions(options) { exactKeys(options, ['provider', 'providers', 'requiredProviders', 'timeoutMs', 'signal'], 'run'); }
function exactLedgerOptions(options) { exactKeys(options, ['artifactDir', 'repository', 'commit', 'now', 'verifyArtifacts', 'maxArtifactBytes'], 'ledger'); }
function exactReadLedgerOptions(options) { exactKeys(options, ['artifactDir', 'repository', 'commit', 'now', 'verifyArtifacts', 'maxArtifactBytes'], 'ledger read'); }
function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) throw new BridgeRuntimeError(`${label} options must be an object.`, 'AXION_BRIDGE_OPTIONS');
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new BridgeRuntimeError(`Unknown ${label} options: ${unknown.join(', ')}.`, 'AXION_BRIDGE_OPTIONS');
}
function mkdirLedgerDirectory(root, target) {
  const rel = slash(relative(root, target));
  if (!rel || rel === '.') return;
  let cursor = resolve(root);
  for (const part of rel.split('/')) {
    cursor = join(cursor, part);
    try { mkdirSync(cursor); }
    catch (error) { if (error?.code !== 'EEXIST') throw error; }
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new BridgeLedgerError(`Unsafe ledger directory ${rel}.`);
  }
}
function acquireLedgerLock(ledgerPath) {
  const path = `${ledgerPath}.lock`;
  const deadline = Date.now() + LEDGER_LOCK_TIMEOUT_MS;
  const token = randomUUID();
  while (true) {
    if (tryCreateLedgerLock(path, token)) return { path, token };
    if (tryRecoverStaleLedgerLock(path)) continue;
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new BridgeLedgerError('Timed out waiting for the Bridge ledger lock.', [
        ledgerIssue('$lock', 'ledger-lock-timeout', `Ledger remained locked for ${LEDGER_LOCK_TIMEOUT_MS} ms.`),
      ]);
    }
    Atomics.wait(LEDGER_LOCK_WAIT, 0, 0, Math.min(10, remaining));
  }
}
function tryCreateLedgerLock(path, token) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify({
      schema: 'axion-bridge-ledger-lock/v1', token, pid: process.pid,
      createdAt: new Date().toISOString(),
    })}\n`, 'utf8');
    return true;
  } catch (error) {
    if (error?.code === 'EEXIST') return false;
    try { if (descriptor !== undefined && existsSync(path)) unlinkSync(path); } catch { /* best effort for our partial lock */ }
    throw new BridgeLedgerError('Could not acquire the Bridge ledger lock.', [
      ledgerIssue('$lock', 'ledger-lock-io', error?.message ?? String(error)),
    ]);
  } finally {
    try { if (descriptor !== undefined) closeSync(descriptor); } catch { /* best effort */ }
  }
}
function tryRecoverStaleLedgerLock(path) {
  const recoveryPath = `${path}.recovery`;
  const recoveryToken = randomUUID();
  if (!tryCreateLedgerLock(recoveryPath, recoveryToken)) {
    const recovery = inspectLedgerLock(recoveryPath);
    if (isRecoverableLedgerLock(recovery)) removeLedgerLockIfOwned({ path: recoveryPath, token: recovery.metadata?.token });
    return false;
  }
  try {
    const state = inspectLedgerLock(path);
    if (!state.exists) return true;
    if (!isRecoverableLedgerLock(state)) return false;
    try { unlinkSync(path); }
    catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new BridgeLedgerError('Could not recover a stale Bridge ledger lock.', [
          ledgerIssue('$lock', 'ledger-lock-recovery', error?.message ?? String(error)),
        ]);
      }
    }
    return true;
  } finally {
    removeLedgerLockIfOwned({ path: recoveryPath, token: recoveryToken });
  }
}
function inspectLedgerLock(path) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, ageMs: 0, malformed: false, metadata: null };
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new BridgeLedgerError('Unsafe Bridge ledger lock path.', [
      ledgerIssue('$lock', 'unsafe-ledger-lock', 'Ledger lock must be a regular file and may not be a symbolic link.'),
    ]);
  }
  const ageMs = Math.max(0, Date.now() - stat.mtimeMs);
  if (stat.size > MAX_LEDGER_LOCK_BYTES) return { exists: true, ageMs, malformed: true, metadata: null };
  try {
    const metadata = JSON.parse(readFileSync(path, 'utf8'));
    const valid = metadata?.schema === 'axion-bridge-ledger-lock/v1'
      && typeof metadata.token === 'string' && metadata.token.length > 0
      && Number.isSafeInteger(metadata.pid) && metadata.pid > 0
      && isCanonicalIso(metadata.createdAt);
    return { exists: true, ageMs, malformed: !valid, metadata: valid ? metadata : null };
  } catch {
    return { exists: true, ageMs, malformed: true, metadata: null };
  }
}
function isRecoverableLedgerLock(state) {
  if (!state.exists) return true;
  if (state.malformed) return state.ageMs >= LEDGER_LOCK_STALE_MS;
  return !processIsAlive(state.metadata.pid);
}
function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}
function releaseLedgerLock(lock) { removeLedgerLockIfOwned(lock); }
function removeLedgerLockIfOwned({ path, token }) {
  if (!token) return false;
  let state;
  try { state = inspectLedgerLock(path); }
  catch { return false; }
  if (!state.exists || state.metadata?.token !== token) return false;
  try { unlinkSync(path); return true; }
  catch (error) { return error?.code === 'ENOENT'; }
}
function atomicWrite(destination, content) {
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, destination);
  } finally {
    try { if (existsSync(temporary)) unlinkSync(temporary); } catch { /* best effort */ }
  }
}
function slash(value) { return value.split(sep).join('/'); }
function ledgerIssue(path, code, message) { return { path, code, message }; }
