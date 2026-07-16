/* ============================================================
   Axion Bridge orchestration.

   The low-level runtime executes one adapter contract. This layer turns the
   repository-owned `bridge.connections` list into isolated adapter instances,
   binds every result to Git identity, and federates source envelopes to sinks.
   No adapter receives a permission that was not declared by its connection.
   ============================================================ */
import { createHash } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { builtinModules, createRequire } from 'node:module';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AdapterRegistry } from './registry.mjs';
import {
  BridgeValidationError,
  INTEGRATION_ENVELOPE_SCHEMA,
  canonicalSha256,
  createAdapterManifest,
  validateAdapterManifest,
  validateIntegrationEnvelope,
} from './contracts.mjs';
import {
  appendArtifactLedger,
  createBridgeRuntime,
  readArtifactLedger,
} from './runtime.mjs';
import { safeWriteFileSync } from '../core/safe-write.mjs';

export const BRIDGE_STATUS_SCHEMA = 'axion-bridge-status/v1';
export const BRIDGE_CONFIG_SCHEMA = 'axion-bridge-config/v1';

const BUILTIN_MODULES = Object.freeze({
  artifact: './adapters/generic-artifact.mjs',
  chromatic: './adapters/chromatic.mjs',
  figma: './adapters/figma.mjs',
  github: './adapters/github.mjs',
  preview: './adapters/preview.mjs',
  storybook: './adapters/storybook.mjs',
  webhook: './adapters/webhook-sink.mjs',
});
const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, name.startsWith('node:') ? name.slice(5) : `node:${name}`]));
const CONNECTION_CONTRACT_DIGEST = Symbol('axion.bridge.connectionContractDigest');
const CONNECTION_SOURCE_MANIFEST = Symbol('axion.bridge.connectionSourceManifest');

export class BridgeOrchestratorError extends Error {
  constructor(message, code = 'AXION_BRIDGE_ORCHESTRATOR', details = null) {
    super(message);
    this.name = 'BridgeOrchestratorError';
    this.code = code;
    this.details = details;
  }
}

export function bridgeGitIdentity(root = process.cwd(), env = process.env) {
  const cwd = resolve(root);
  const command = (args) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 3_000, maxBuffer: 256 * 1024 });
    return result.status === 0 ? result.stdout.trim() : null;
  };
  let commit = null;
  for (const [name, value] of [
    ['GITHUB_SHA', env.GITHUB_SHA],
    ['CI_COMMIT_SHA', env.CI_COMMIT_SHA],
    ['BUILD_SOURCEVERSION', env.BUILD_SOURCEVERSION],
  ]) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (!/^[a-f0-9]{7,64}$/i.test(value.trim())) {
      throw new BridgeOrchestratorError(
        `${name} is not a valid hexadecimal commit id; refusing to weaken commit binding.`,
        'AXION_BRIDGE_IDENTITY',
        { variable: name },
      );
    }
    commit = value.trim().toLowerCase();
    break;
  }
  if (!commit) {
    const detected = command(['rev-parse', 'HEAD']);
    commit = typeof detected === 'string' && /^[a-f0-9]{7,64}$/i.test(detected)
      ? detected.toLowerCase() : null;
  }
  const remote = env.GITHUB_REPOSITORY ? `https://github.com/${env.GITHUB_REPOSITORY}`
    : env.CI_REPOSITORY_URL || env.BUILD_REPOSITORY_URI || command(['config', '--get', 'remote.origin.url']);
  return {
    root: cwd,
    remote: cleanRemote(remote),
    commit,
  };
}

/**
 * Fingerprint the exact non-secret connection contract and adapter code that
 * produced a ledger entry. Audit requires this digest to match before old
 * evidence can satisfy the current configuration.
 */
export function bridgeConnectionContractDigest(connection, root = process.cwd()) {
  return prepareConnectionContract(connection, root).digest;
}

function prepareConnectionContract(connection, root = process.cwd()) {
  assertConnection(connection);
  const cwd = realpathSync(resolve(root));
  let implementation;
  let custom = null;
  if (connection.module) {
    const absolute = isAbsolute(connection.module) ? connection.module : resolve(cwd, connection.module);
    const canonical = realpathSync(absolute);
    const rel = slash(relative(cwd, canonical));
    if (!rel || rel.startsWith('../') || isAbsolute(rel)) {
      throw new BridgeOrchestratorError('Custom adapter module escapes the repository.', 'AXION_BRIDGE_MODULE');
    }
    const graph = fingerprintModuleGraph(canonical, cwd);
    const dependencyFiles = fingerprintDependencyFiles(cwd);
    if (graph.bareImports.length > 0 && !dependencyFiles.some((file) => file.lockfile)) {
      throw new BridgeOrchestratorError(
        `Custom adapter imports third-party packages (${graph.bareImports.join(', ')}) but the repository has no supported dependency lockfile.`,
        'AXION_BRIDGE_MODULE',
      );
    }
    implementation = {
      type: 'repository-module',
      entry: rel,
      files: graph.files,
      bareImports: graph.bareImports,
      dependencyFiles,
    };
    custom = { entry: canonical, graph };
  } else {
    const specifier = BUILTIN_MODULES[connection.adapter];
    if (!specifier) {
      throw new BridgeOrchestratorError(
        `Unknown built-in adapter ${connection.adapter}; provide an explicit repository-local module.`,
        'AXION_BRIDGE_ADAPTER',
      );
    }
    const path = fileURLToPath(new URL(specifier, import.meta.url));
    const packageRoot = realpathSync(fileURLToPath(new URL('../../', import.meta.url)));
    implementation = {
      type: 'builtin',
      id: connection.adapter,
      files: fingerprintModuleGraph(path, packageRoot).files,
    };
  }
  const digest = canonicalSha256({
    schema: 'axion-bridge-connection-contract/v1',
    connection: {
      id: connection.id,
      adapter: connection.adapter,
      role: connection.role ?? 'source',
      trust: connection.trust ?? 'linked',
      permissions: [...new Set(connection.permissions ?? [])].sort(),
      source: portableContractSource(connection.source, cwd),
      options: connection.options ?? {},
    },
    implementation,
  });
  return { cwd, digest, implementation, custom };
}

export async function builtInAdapterCatalog() {
  const rows = [];
  for (const [id, specifier] of Object.entries(BUILTIN_MODULES)) {
    const mod = await import(specifier);
    rows.push({
      id,
      version: mod.manifest?.version ?? '1.0.0',
      kind: mod.manifest?.kind ?? inferRole(mod),
      capabilities: [...(mod.capabilities ?? mod.manifest?.capabilities ?? [])],
      permissions: normalizePermissionMap(mod.manifest?.permissions, mod),
    });
  }
  return rows.sort((a, b) => a.id.localeCompare(b.id));
}

export async function createConnectionAdapter(connection, context = {}) {
  assertConnection(connection);
  const root = context.root ?? process.cwd();
  const module = await loadConnectionModule(connection, root);
  const lifecycle = ['discover', 'collect', 'publish'].filter((operation) => typeof module[operation] === 'function');
  if (!lifecycle.length) throw new BridgeOrchestratorError(`Adapter ${connection.adapter} exposes no Bridge lifecycle.`, 'AXION_BRIDGE_ADAPTER');
  const declaredLifecycle = [...(module.manifest?.lifecycle ?? [])].sort();
  const implementedLifecycle = [...lifecycle].sort();
  if (declaredLifecycle.length !== implementedLifecycle.length
    || declaredLifecycle.some((operation, index) => operation !== implementedLifecycle[index])) {
    throw new BridgeOrchestratorError(
      `Adapter ${connection.adapter} lifecycle exports do not match its manifest.`,
      'AXION_BRIDGE_ADAPTER',
      { declared: declaredLifecycle, implemented: implementedLifecycle },
    );
  }
  const permissions = normalizePermissionMap(module.manifest?.permissions, module);
  const manifest = createAdapterManifest({
    id: module.manifest.id,
    provider: connection.id,
    version: module.manifest?.version ?? '1.0.0',
    lifecycle,
    permissions,
  });
  const adapter = { manifest };
  const adapterContext = () => ({
    ...(connection.options ?? {}),
    ...(connection.source ? { source: connection.source } : {}),
    root: resolve(context.root ?? process.cwd()),
    repository: context.repository,
    expectedCommit: context.repository?.commit ?? null,
    expectedRepository: context.repository?.remote ?? null,
    timeoutMs: context.timeoutMs,
    maxBytes: context.maxArtifactBytes,
    maxAgeMs: context.freshnessMs,
    env: context.env ?? process.env,
    fetch: context.fetch ?? globalThis.fetch,
  });
  if (module.discover) adapter.discover = async (input, runtimeContext) => {
    const result = await module.discover({ ...adapterContext(), ...input, signal: runtimeContext.signal, now: runtimeContext.now });
    return Array.isArray(result) ? result : [result];
  };
  if (module.collect) adapter.collect = async (input, runtimeContext) => {
    const result = await module.collect({ ...adapterContext(), ...input, signal: runtimeContext.signal, now: runtimeContext.now });
    return validateModuleOutput(Array.isArray(result) ? result : [result], 'collect', module.manifest);
  };
  if (module.publish) adapter.publish = async (input, runtimeContext) => {
    const result = await module.publish({ ...adapterContext(), ...input, signal: runtimeContext.signal, now: runtimeContext.now }, input.envelope);
    return validateModuleOutput(Array.isArray(result) ? result : [result], 'publish', module.manifest);
  };
  Object.defineProperties(adapter, {
    [CONNECTION_CONTRACT_DIGEST]: {
      value: module[CONNECTION_CONTRACT_DIGEST] ?? bridgeConnectionContractDigest(connection, root),
    },
    [CONNECTION_SOURCE_MANIFEST]: { value: module.manifest },
  });
  return adapter;
}

export async function syncBridge(config, options = {}) {
  const root = resolve(config.cwd ?? process.cwd());
  const bridge = config.bridge ?? {};
  const repository = bridgeGitIdentity(root, options.env ?? process.env);
  const selected = options.ids?.length ? new Set(options.ids) : null;
  const configured = (bridge.connections ?? []).filter((connection) => connection.enabled !== false
    && (!selected || selected.has(connection.id)));
  if (selected) {
    const unknown = [...selected].filter((id) => !configured.some((connection) => connection.id === id));
    if (unknown.length) throw new BridgeOrchestratorError(`Unknown or disabled connection: ${unknown.join(', ')}.`, 'AXION_BRIDGE_CONNECTION');
  }
  const sourceConnections = configured.filter((connection) => connection.role !== 'sink');
  const sinkConnections = configured.filter((connection) => connection.role === 'sink' || connection.role === 'both');
  if (options.publish === true && sinkConnections.length === 0) {
    throw new BridgeOrchestratorError(
      selected
        ? 'No sink connection was selected; include at least one sink id or omit ids when using --publish.'
        : 'No enabled sink connection is configured for --publish.',
      'AXION_BRIDGE_CONNECTION',
    );
  }
  if (options.publish === true && sourceConnections.length === 0) {
    throw new BridgeOrchestratorError(
      'No source connection was selected; --publish requires fresh source envelopes from the same sync.',
      'AXION_BRIDGE_PUBLISH_INPUT',
    );
  }
  const runs = [];
  const envelopes = [];

  // Ledger appends are intentionally serialized: the append-only hash chain
  // must never race even when provider I/O could otherwise run concurrently.
  for (const connection of sourceConnections) {
    try {
      const adapter = await createConnectionAdapter(connection, {
        root, repository, timeoutMs: bridge.timeoutMs, maxArtifactBytes: bridge.maxArtifactBytes,
        freshnessMs: bridge.freshnessMs, env: options.env, fetch: options.fetch,
      });
      if (!adapter.collect) continue;
      const contractDigest = adapter[CONNECTION_CONTRACT_DIGEST];
      const registry = new AdapterRegistry([adapter]);
      const runtime = createBridgeRuntime({
        registry, root, artifactDir: relativeArtifactDir(root, bridge.artifactDir),
        permissions: connection.permissions ?? [], requiredProviders: connection.required ? [connection.id] : [],
        contractDigest,
        maxArtifactBytes: bridge.maxArtifactBytes,
        timeoutMs: bridge.timeoutMs, repository: repository.root, commit: repository.commit,
        envelopePolicy: {
          maxAgeMs: bridge.freshnessMs,
          ...(repository.remote ? { expectedRepository: repository.remote } : {}),
        },
      });
      const run = await runtime.collect({}, { provider: connection.id });
      runs.push({ connection: connection.id, role: connection.role ?? 'source', ...run });
      for (const result of run.results ?? []) {
        if (result.status === 'fulfilled') envelopes.push(...(result.value ?? []).map((envelope) => ({ connection: connection.id, envelope })));
      }
    } catch (error) {
      runs.push(failedRun(connection.id, connection.role ?? 'source', error));
      if (connection.required) throw attachRuns(error, runs);
    }
  }

  if (options.publish === true) {
    for (const connection of sinkConnections) {
      try {
        if (!envelopes.length) {
          throw new BridgeOrchestratorError(
            `Sink ${connection.id} cannot publish because this sync collected no source envelopes.`,
            'AXION_BRIDGE_PUBLISH_INPUT',
          );
        }
        const adapter = await createConnectionAdapter(connection, {
          root, repository, timeoutMs: bridge.timeoutMs, maxArtifactBytes: bridge.maxArtifactBytes,
          freshnessMs: bridge.freshnessMs, env: options.env, fetch: options.fetch,
        });
        if (!adapter.publish) continue;
        const contractDigest = adapter[CONNECTION_CONTRACT_DIGEST];
        const runtime = createBridgeRuntime({
          registry: new AdapterRegistry([adapter]), root,
          artifactDir: relativeArtifactDir(root, bridge.artifactDir),
          permissions: connection.permissions ?? [], requiredProviders: connection.required ? [connection.id] : [],
          contractDigest,
          maxArtifactBytes: bridge.maxArtifactBytes,
          timeoutMs: bridge.timeoutMs, repository: repository.root, commit: repository.commit,
          envelopePolicy: {
            maxAgeMs: bridge.freshnessMs,
            ...(repository.remote ? { expectedRepository: repository.remote } : {}),
          },
        });
        for (const source of envelopes) {
          const run = await runtime.publish({ envelope: source.envelope }, { provider: connection.id });
          runs.push({ connection: connection.id, source: source.connection, role: 'sink', ...run });
        }
      } catch (error) {
        runs.push(failedRun(connection.id, 'sink', error));
        if (connection.required) throw attachRuns(error, runs);
      }
    }
  }

  const status = mergeCurrentRunFailures(
    auditBridge(config, { repository, evaluateSinks: options.publish === true }),
    runs,
    configured,
    options.publish === true,
  );
  return {
    schema: 'axion-bridge-sync/v1',
    generatedAt: new Date().toISOString(),
    repository,
    status: status.status,
    runs,
    envelopes: envelopes.map(({ connection, envelope }) => ({ connection, id: envelope.id, digest: envelope.digest })),
    audit: status,
  };
}

export function auditBridge(config, options = {}) {
  const root = resolve(config.cwd ?? process.cwd());
  const bridge = config.bridge ?? {};
  const repository = options.repository ?? bridgeGitIdentity(root, options.env ?? process.env);
  const loaded = readArtifactLedger(root, {
    artifactDir: relativeArtifactDir(root, bridge.artifactDir),
    repository: repository.root,
    commit: repository.commit,
    verifyArtifacts: options.verifyArtifacts !== false,
    maxArtifactBytes: bridge.maxArtifactBytes,
  });
  const issues = loaded.issues.map((issue) => ({ severity: 'error', connection: null, ...issue }));
  const ledgerEntries = loaded.ok && Array.isArray(loaded.ledger?.connections)
    ? loaded.ledger.connections.filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry))
    : [];
  const latest = latestConnectionRuns(ledgerEntries, (entry) => `${entry.provider}:${entry.operation}`);
  const latestPublishByInput = latestConnectionRuns(
    ledgerEntries,
    (entry) => entry.operation === 'publish' && entry.inputEnvelopeDigest
      ? `${entry.provider}:${entry.inputEnvelopeDigest}` : null,
  );
  const contractStates = new Map();
  for (const connection of bridge.connections ?? []) {
    if (connection.enabled === false) continue;
    try {
      contractStates.set(connection.id, { digest: bridgeConnectionContractDigest(connection, root), error: null });
    } catch (error) {
      contractStates.set(connection.id, { digest: null, error });
    }
  }
  // The current source set is the latest complete collect run for every
  // enabled source/both connection whose contract still matches. Sink proof
  // must cover this exact set, never merely the latest receipt by timestamp.
  const sourceInputs = new Map();
  for (const connection of bridge.connections ?? []) {
    if (connection.enabled === false || connection.role === 'sink') continue;
    const contract = contractStates.get(connection.id);
    const entries = latest.get(`${connection.id}:collect`) ?? [];
    for (const entry of entries) {
      if (!entry.envelope || !contract?.digest || entry.contractDigest !== contract.digest) continue;
      if (entry.adapter !== configuredManifestId(connection)) continue;
      sourceInputs.set(entry.envelope.digest, {
        digest: entry.envelope.digest,
        connection: connection.id,
        envelopeId: entry.envelope.id,
      });
    }
  }
  const connections = [];
  for (const connection of bridge.connections ?? []) {
    if (connection.enabled === false) {
      connections.push({ id: connection.id, adapter: connection.adapter, required: connection.required === true, status: 'disabled', issues: [] });
      continue;
    }
    const localIssues = [];
    const role = connection.role ?? 'source';
    const expectedOperations = role === 'sink' ? ['publish'] : role === 'both' ? ['collect', 'publish'] : ['collect'];
    const { digest: expectedContractDigest, error: contractError } = contractStates.get(connection.id) ?? { digest: null, error: null };
    const operationStates = {};
    const operationEntries = {};
    for (const operation of expectedOperations) {
      const blocking = connection.required === true
        && (operation === 'collect' || options.evaluateSinks === true);
      const operationIssues = [];
      let entries = latest.get(`${connection.id}:${operation}`) ?? [];
      if (contractError) {
        operationIssues.push(auditIssue(
          blocking ? 'error' : 'warn',
          'contract-unavailable',
          `Current connection contract cannot be verified: ${serializeError(contractError).message}`,
        ));
      }
      if (operation === 'publish' && sourceInputs.size) {
        entries = [];
        for (const source of sourceInputs.values()) {
          const receiptRun = latestPublishByInput.get(`${connection.id}:${source.digest}`);
          if (receiptRun?.length) entries.push(...receiptRun);
          else {
            operationIssues.push(auditIssue(
              blocking ? 'error' : 'warn',
              'source-receipt-missing',
              `No publish receipt covers the latest evidence ${source.envelopeId} from ${source.connection}.`,
              '$.inputEnvelopeDigest',
            ));
          }
        }
      } else if (operation === 'publish' && entries.length) {
        operationIssues.push(auditIssue(
          blocking ? 'error' : 'warn',
          'source-evidence-missing',
          'Publish receipts cannot satisfy policy because no current contract-bound source evidence is available.',
          '$.inputEnvelopeDigest',
        ));
      }
      operationEntries[operation] = entries;
      if (!entries.length && !(operation === 'publish' && sourceInputs.size)) {
        operationIssues.push(auditIssue(
          blocking ? 'error' : 'warn',
          'missing-evidence',
          operation === 'publish'
            ? 'No publish receipt exists; sink execution is deferred until sync --publish.'
            : 'No collect evidence has been recorded.',
        ));
      }
      for (const entry of entries) {
        if (operation === 'publish' && !entry.inputEnvelopeDigest) {
          operationIssues.push(auditIssue(
            blocking ? 'error' : 'warn',
            'source-receipt-unbound',
            'Publish evidence predates source-digest binding; publish the current source set again.',
            '$.inputEnvelopeDigest',
          ));
        }
        if (entry.adapter !== configuredManifestId(connection)) {
          operationIssues.push(auditIssue(
            blocking ? 'error' : 'warn',
            'adapter-mismatch',
            `Ledger evidence was produced by ${entry.adapter}, not the configured ${configuredManifestId(connection)} adapter contract.`,
          ));
        }
        if (!entry.contractDigest) {
          operationIssues.push(auditIssue(
            blocking ? 'error' : 'warn',
            'contract-unbound',
            'Ledger evidence predates connection-contract binding; run bridge sync again.',
          ));
        } else if (expectedContractDigest && entry.contractDigest !== expectedContractDigest) {
          operationIssues.push(auditIssue(
            blocking ? 'error' : 'warn',
            'contract-mismatch',
            'Connection settings or adapter implementation changed after this evidence was recorded; run bridge sync again.',
          ));
        }
        if (entry.status !== 'healthy') {
          operationIssues.push(auditIssue(blocking ? 'error' : 'warn', 'provider-failed', entry.error?.message ?? `Provider status is ${entry.status}.`));
        }
        if (entry.envelope) {
          const trust = trustPolicy(connection.trust);
          const policy = {
            now: options.now ?? new Date(), maxAgeMs: bridge.freshnessMs,
            ...(trust ? { minimumTrust: trust } : {}),
            ...(repository.commit ? { expectedCommit: repository.commit } : {}),
            ...(repository.remote ? { expectedRepository: repository.remote } : {}),
          };
          for (const problem of validateIntegrationEnvelope(entry.envelope, policy)) {
            operationIssues.push(auditIssue(blocking ? 'error' : 'warn', problem.code, problem.message, problem.path));
          }
          const providerStatus = entry.envelope.payload?.status;
          if (providerStatus !== 'passed') {
            const code = providerStatus === 'failed' ? 'provider-failed' : 'provider-incomplete';
            const state = typeof providerStatus === 'string' && providerStatus ? providerStatus : 'missing';
            operationIssues.push(auditIssue(
              blocking ? 'error' : 'warn',
              code,
              `Evidence payload status is ${state}; only passed evidence is healthy.`,
              '$.payload.status',
            ));
          }
        } else {
          operationIssues.push(auditIssue(blocking ? 'error' : 'warn', 'missing-envelope', `${operation} completed without an evidence envelope.`));
        }
      }
      const entry = entries.at(-1) ?? null;
      localIssues.push(...operationIssues.map((issue) => ({ ...issue, operation })));
      operationStates[operation] = {
        status: operationIssues.some((issue) => issue.severity === 'error') ? 'failed' : operationIssues.length ? 'incomplete' : 'healthy',
        trust: entry?.trust ?? null,
        generatedAt: entry?.envelope?.createdAt ?? entry?.createdAt ?? null,
        envelopeId: entry?.envelope?.id ?? null,
        envelopeIds: entries.flatMap((candidate) => candidate.envelope ? [candidate.envelope.id] : []),
        runId: entry?.runId ?? null,
        contractDigest: entry?.contractDigest ?? null,
      };
    }
    const entries = operationEntries.publish?.length ? operationEntries.publish : operationEntries.collect ?? [];
    const entry = entries.at(-1) ?? null;
    issues.push(...localIssues.map((issue) => ({ ...issue, connection: connection.id })));
    connections.push({
      id: connection.id, adapter: connection.adapter, required: connection.required === true,
      status: localIssues.some((issue) => issue.severity === 'error') ? 'failed' : localIssues.length ? 'incomplete' : 'healthy',
      trust: entry?.trust ?? null, generatedAt: entry?.envelope?.createdAt ?? entry?.createdAt ?? null,
      commit: entry?.envelope?.binding?.commit ?? null, envelopeId: entry?.envelope?.id ?? null,
      operations: operationStates, issues: localIssues,
    });
  }
  const requiredFailed = connections.filter((connection) => connection.required && connection.status === 'failed').length;
  const failed = issues.some((issue) => issue.severity === 'error');
  return {
    schema: BRIDGE_STATUS_SCHEMA,
    generatedAt: new Date(options.now ?? Date.now()).toISOString(),
    status: !loaded.ok || failed ? 'failed' : issues.length ? 'incomplete' : 'passed',
    repository,
    ledger: { path: loaded.path, missing: loaded.missing, ok: loaded.ok, headHash: loaded.headHash, summary: loaded.summary },
    summary: {
      total: connections.length,
      healthy: connections.filter((connection) => connection.status === 'healthy').length,
      failed: connections.filter((connection) => connection.status === 'failed').length,
      incomplete: connections.filter((connection) => connection.status === 'incomplete').length,
      requiredFailed,
    },
    connections,
    issues,
  };
}

export function latestBridgeEnvelope(config, id) {
  const root = resolve(config.cwd ?? process.cwd());
  const loaded = readArtifactLedger(root, {
    artifactDir: relativeArtifactDir(root, config.bridge?.artifactDir),
    maxArtifactBytes: config.bridge?.maxArtifactBytes,
  });
  if (!loaded.ok) throw new BridgeOrchestratorError('Bridge ledger is invalid.', 'AXION_BRIDGE_LEDGER', loaded.issues);
  const entry = [...(loaded.ledger.connections ?? [])].reverse().find((candidate) => candidate.provider === id && candidate.envelope);
  return entry?.envelope ?? null;
}

export async function ingestBridgeEnvelope(config, connectionId, envelope, options = {}) {
  const connection = (config.bridge?.connections ?? []).find((candidate) => candidate.id === connectionId && candidate.enabled !== false);
  if (!connection) throw new BridgeOrchestratorError(`Unknown or disabled connection ${connectionId}.`, 'AXION_BRIDGE_CONNECTION');
  if (connection.role === 'sink') {
    throw new BridgeOrchestratorError('Offline ingest is only valid for source or both connections.', 'AXION_BRIDGE_INPUT');
  }
  const root = resolve(config.cwd ?? process.cwd());
  // Loading the contract is deliberate: offline evidence must satisfy the
  // same provider/lifecycle/permission declaration as live collection.
  const adapter = await createConnectionAdapter(connection, { root });
  const sourceManifest = adapter[CONNECTION_SOURCE_MANIFEST];
  if (!sourceManifest.lifecycle.includes('collect')) {
    throw new BridgeOrchestratorError(`Adapter ${connection.adapter} cannot ingest collect evidence.`, 'AXION_BRIDGE_ADAPTER');
  }
  const expectedProvider = sourceManifest.provider;
  const expectedKind = `collect/${expectedProvider}`;
  const expectedPermissions = [...(sourceManifest.permissions.collect ?? [])].sort();
  const missingGrants = expectedPermissions.filter((permission) => !permissionGranted(connection.permissions ?? [], permission));
  if (missingGrants.length) {
    throw new BridgeOrchestratorError(
      `Connection ${connection.id} does not grant its collect permissions.`,
      'AXION_BRIDGE_PERMISSION',
      { missing: missingGrants },
    );
  }
  const repository = bridgeGitIdentity(config.cwd, options.env ?? process.env);
  const recordedAt = options.now ?? new Date();
  const problems = [];
  if (envelope?.trust?.level === 'verified') {
    problems.push({
      path: '$.trust.level', code: 'offline-trust-ceiling',
      message: 'Offline ingest cannot authenticate a verified claim; use self-attested/linked trust or collect through the adapter.',
    });
  }
  const actualPermissions = Array.isArray(envelope?.permissions) ? [...envelope.permissions].sort() : [];
  if (actualPermissions.length !== expectedPermissions.length
    || actualPermissions.some((permission, index) => permission !== expectedPermissions[index])) {
    problems.push({
      path: '$.permissions', code: 'permission-contract-mismatch',
      message: `Envelope permissions must exactly match the ${connection.adapter} collect manifest.`,
    });
  }
  problems.push(...validateIntegrationEnvelope(envelope, {
    now: recordedAt, maxAgeMs: config.bridge?.freshnessMs,
    ...(repository.commit ? { expectedCommit: repository.commit } : {}),
    ...(repository.remote ? { expectedRepository: repository.remote } : {}),
    ...(trustPolicy(connection.trust) ? { minimumTrust: trustPolicy(connection.trust) } : {}),
    allowedProviders: [expectedProvider],
    allowedKinds: [expectedKind],
    requiredPermissions: expectedPermissions,
  }));
  if (problems.length) throw new BridgeValidationError('Ingested envelope failed Bridge policy.', problems);
  const contractDigest = adapter[CONNECTION_CONTRACT_DIGEST];
  const runId = `run_${canonicalSha256({
    operation: 'ingest', connection: connection.id, envelope: envelope.digest,
    createdAt: new Date(recordedAt).toISOString(),
  }).slice(0, 32)}`;
  return appendArtifactLedger(config.cwd, {
    adapter: sourceManifest.id, provider: connection.id, operation: 'collect', required: connection.required === true,
    status: 'healthy', trust: envelope.trust.level, runId, contractDigest, envelope, durationMs: 0,
  }, {
    artifactDir: relativeArtifactDir(config.cwd, config.bridge?.artifactDir), repository: repository.root,
    commit: repository.commit, now: recordedAt, verifyArtifacts: true,
    maxArtifactBytes: config.bridge?.maxArtifactBytes,
  });
}

export function initializeBridgeManifest(root, sourcePath = 'design/bridge.json') {
  const cwd = resolve(root);
  const target = isAbsolute(sourcePath) ? sourcePath : resolve(cwd, sourcePath);
  const relativeTarget = slash(relative(cwd, target));
  if (!relativeTarget || relativeTarget === '.' || relativeTarget.startsWith('../') || isAbsolute(relativeTarget)) {
    throw new BridgeOrchestratorError('Bridge manifest must stay inside the repository.', 'AXION_BRIDGE_PATH');
  }
  if (existsSync(target)) {
    throw new BridgeOrchestratorError(`Bridge manifest already exists: ${relativeTarget}.`, 'AXION_BRIDGE_EXISTS');
  }
  const manifest = {
    $schema: 'https://unpkg.com/axion-designer/bridge.schema.json',
    schema: BRIDGE_CONFIG_SCHEMA,
    connections: [],
  };
  safeWriteFileSync(cwd, target, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path: target, manifest };
}

async function loadConnectionModule(connection, root) {
  if (connection.module) {
    // Importing the repository file directly would let Node's process-wide ESM
    // and CommonJS caches reuse an earlier transitive dependency. Materialize
    // the exact bytes that were fingerprinted under a content-addressed path,
    // so every changed local graph gets a fresh URL while an unchanged graph
    // safely reuses the same module instance.
    const prepared = prepareConnectionContract(connection, root);
    // Keep executable module snapshots outside the evidence artifactDir. CI
    // uploads Bridge evidence, not a second copy of repository source code.
    const cacheRoot = resolve(prepared.cwd, '.dk', 'cache', 'bridge-modules', prepared.digest);
    for (const snapshot of prepared.custom.graph.snapshots) {
      safeWriteFileSync(prepared.cwd, resolve(cacheRoot, snapshot.path), snapshot.source, { mode: snapshot.mode });
    }
    const entryRel = slash(relative(prepared.cwd, prepared.custom.entry));
    const cachedEntry = resolve(cacheRoot, entryRel);
    if (hashFile(cachedEntry) !== prepared.custom.graph.files.find((file) => file.path === entryRel)?.sha256) {
      throw new BridgeOrchestratorError('Content-addressed adapter snapshot failed verification.', 'AXION_BRIDGE_MODULE');
    }
    const imported = await import(pathToFileURL(cachedEntry).href);
    const module = imported.default && typeof imported.default === 'object'
      ? { ...imported.default, ...imported }
      : { ...imported };
    if (!module.manifest) {
      throw new BridgeOrchestratorError('Custom adapter must export a versioned Bridge manifest.', 'AXION_BRIDGE_ADAPTER');
    }
    const manifestIssues = validateAdapterManifest(module.manifest);
    if (manifestIssues.length) {
      throw new BridgeOrchestratorError('Custom adapter manifest is invalid.', 'AXION_BRIDGE_ADAPTER', manifestIssues);
    }
    if (module.manifest.id !== connection.adapter) {
      throw new BridgeOrchestratorError(`Custom module manifest id ${module.manifest.id} does not match ${connection.adapter}.`, 'AXION_BRIDGE_ADAPTER');
    }
    Object.defineProperty(module, CONNECTION_CONTRACT_DIGEST, { value: prepared.digest });
    return module;
  }
  const specifier = BUILTIN_MODULES[connection.adapter];
  if (!specifier) throw new BridgeOrchestratorError(`Unknown built-in adapter ${connection.adapter}; provide an explicit repository-local module.`, 'AXION_BRIDGE_ADAPTER');
  return import(specifier);
}

function normalizePermissionMap(source, module) {
  const map = { discover: [], collect: [], publish: [] };
  for (const operation of Object.keys(map)) {
    if (typeof module[operation] !== 'function') continue;
    const values = source?.[operation] ?? [];
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !/^[a-z][a-z0-9.-]*:[A-Za-z0-9*._/@-]+$/.test(value))) {
      throw new BridgeOrchestratorError(`Adapter permissions for ${operation} are invalid.`, 'AXION_BRIDGE_PERMISSION');
    }
    map[operation] = [...new Set(values)].sort();
  }
  return map;
}

function validateModuleOutput(items, operation, manifest) {
  const expectedProvider = manifest.provider;
  const expectedKind = `${operation}/${expectedProvider}`;
  for (const item of items) {
    if (operation === 'publish' && item?.schema !== INTEGRATION_ENVELOPE_SCHEMA) continue;
    const issues = validateIntegrationEnvelope(item, {
      allowedProviders: [expectedProvider],
      allowedKinds: [expectedKind],
      requiredPermissions: manifest.permissions?.[operation] ?? [],
    });
    if (issues.length) {
      throw new BridgeValidationError(`${manifest.id} emitted evidence outside its ${operation} contract.`, issues);
    }
  }
  return items;
}

function assertConnection(connection) {
  if (!connection || typeof connection !== 'object' || Array.isArray(connection)) throw new BridgeOrchestratorError('Connection must be an object.');
  if (!/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(connection.id ?? '') || connection.id.length > 64) {
    throw new BridgeOrchestratorError(`Connection id ${JSON.stringify(connection.id)} is not portable.`, 'AXION_BRIDGE_CONNECTION');
  }
  if (typeof connection.adapter !== 'string' || !connection.adapter) throw new BridgeOrchestratorError('Connection adapter is required.', 'AXION_BRIDGE_CONNECTION');
}

function latestConnectionRuns(entries, keyFor) {
  const groups = new Map();
  const latest = new Map();
  for (const entry of entries) {
    const key = keyFor(entry);
    if (!key) continue;
    // Legacy entries had no run id and therefore form a one-entry run. This
    // preserves ledger readability while preventing them from masquerading as
    // a complete modern multi-envelope run.
    const run = entry.runId ?? `legacy:${entry.id}`;
    const groupKey = `${key}\u0000${run}`;
    const group = groups.get(groupKey) ?? [];
    group.push(entry);
    groups.set(groupKey, group);
    latest.set(key, group);
  }
  return latest;
}
function inferRole(module) { return module.publish && module.collect ? 'source-sink' : module.publish ? 'sink' : 'source'; }
function relativeArtifactDir(root, value) {
  const absolute = value ? resolve(value) : resolve(root, '.dk/bridge');
  const rel = slash(relative(resolve(root), absolute));
  if (!rel || rel === '.' || rel.startsWith('../') || isAbsolute(rel)) throw new BridgeOrchestratorError('bridge.artifactDir must remain inside the repository.', 'AXION_BRIDGE_PATH');
  return rel;
}
function trustPolicy(value) { return value === 'verified' ? 'verified' : value === 'linked' ? 'self-attested' : 'untrusted'; }
function permissionGranted(grants, required) {
  const set = new Set(grants);
  return set.has('*') || set.has(required) || set.has(`${required.split(':')[0]}:*`);
}
function auditIssue(severity, code, message, path = null) { return { severity, code, message, path }; }
function failedRun(connection, role, error) {
  return { schema: 'axion-bridge-run/v1', connection, role, status: 'failed', results: [], error: serializeError(error) };
}

function mergeCurrentRunFailures(audit, runs, configured, evaluateSinks) {
  const configuredById = new Map(configured.map((connection) => [connection.id, connection]));
  for (const run of runs) {
    if (run.status === 'passed') continue;
    const connection = configuredById.get(run.connection);
    const state = audit.connections.find((candidate) => candidate.id === run.connection);
    if (!connection || !state) continue;
    const operation = run.operation ?? (run.role === 'sink' ? 'publish' : 'collect');
    const alreadyVisible = state.issues.some((issue) => issue.operation === operation
      && ['provider-failed', 'current-run-failed'].includes(issue.code));
    if (alreadyVisible) continue;
    const blocking = connection.required === true && (operation === 'collect' || evaluateSinks);
    const error = run.error ?? run.results?.find((result) => result.status === 'rejected')?.error;
    const issue = {
      severity: blocking ? 'error' : 'warn',
      code: 'current-run-failed',
      message: error?.message ?? `The current ${operation} run did not pass.`,
      path: null,
      operation,
    };
    state.issues.push(issue);
    if (state.operations?.[operation]) {
      state.operations[operation].status = blocking ? 'failed' : 'incomplete';
    }
    state.status = state.issues.some((item) => item.severity === 'error')
      ? 'failed' : state.issues.length ? 'incomplete' : 'healthy';
    audit.issues.push({ ...issue, connection: connection.id });
  }
  audit.summary.healthy = audit.connections.filter((connection) => connection.status === 'healthy').length;
  audit.summary.failed = audit.connections.filter((connection) => connection.status === 'failed').length;
  audit.summary.incomplete = audit.connections.filter((connection) => connection.status === 'incomplete').length;
  audit.summary.requiredFailed = audit.connections.filter((connection) => connection.required && connection.status === 'failed').length;
  audit.status = !audit.ledger.ok || audit.issues.some((issue) => issue.severity === 'error')
    ? 'failed' : audit.issues.length ? 'incomplete' : 'passed';
  return audit;
}
function attachRuns(error, runs) { error.bridgeRuns = runs; return error; }
function serializeError(error) { return { code: error?.code ?? 'AXION_BRIDGE_ADAPTER', message: String(error?.message ?? error).slice(0, 2000) }; }
function cleanRemote(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const input = value.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    try {
      const url = new URL(input);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      return url.href;
    } catch {
      return null;
    }
  }
  // Preserve ordinary SCP-style Git remotes (`git@host:org/repo`) while
  // removing a nonstandard user field that may actually be a PAT/token.
  const stripped = input.split(/[?#]/, 1)[0] || '';
  const scp = stripped.match(/^([^@/:]+)@([^:]+):(.+)$/);
  if (scp && !['git', 'ssh'].includes(scp[1].toLowerCase())) return `${scp[2]}:${scp[3]}`;
  return stripped || null;
}
function portableContractSource(value, root) {
  if (typeof value !== 'string') return null;
  if (!isAbsolute(value)) return value;
  const rel = slash(relative(root, value));
  return rel && !rel.startsWith('../') && !isAbsolute(rel) ? rel : value;
}
function configuredManifestId(connection) {
  if (connection.module) return connection.adapter;
  return connection.adapter === 'artifact' ? 'generic-artifact'
    : connection.adapter === 'webhook' ? 'webhook-sink'
      : connection.adapter;
}
function fingerprintModuleGraph(entryPath, logicalRoot) {
  const queue = [realpathSync(entryPath)];
  const seen = new Set();
  const files = [];
  const snapshots = [];
  const bareImports = new Set();
  while (queue.length) {
    const current = queue.shift();
    if (seen.has(current)) continue;
    if (seen.size >= 256) {
      throw new BridgeOrchestratorError('Adapter module graph exceeds 256 local files.', 'AXION_BRIDGE_MODULE');
    }
    seen.add(current);
    const stat = statSync(current);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
      throw new BridgeOrchestratorError('Adapter modules must be regular files no larger than 2 MiB.', 'AXION_BRIDGE_MODULE');
    }
    const source = readFileSync(current, 'utf8');
    const rel = slash(relative(logicalRoot, current));
    const repositoryLocal = rel && !rel.startsWith('../') && !isAbsolute(rel);
    files.push({
      path: repositoryLocal ? rel : 'external-module',
      sha256: createHash('sha256').update(source).digest('hex'),
    });
    // A custom adapter's exact repository-local graph is scanned recursively.
    // Externally installed package internals are bound by the dependency
    // manifest/lockfile; a direct file URL is retained as a hashed leaf.
    if (!repositoryLocal) continue;
    snapshots.push({ path: rel, source, mode: stat.mode & 0o777 });
    // Preserve Node's `.js` ESM/CommonJS package boundaries inside the
    // content-addressed mirror. Without the applicable package.json files, a
    // nested adapter could be fingerprinted as ESM but executed as CommonJS
    // (or the reverse) after it is moved under `.dk/cache`.
    for (const manifestPath of packageScopeFiles(current, logicalRoot)) {
      if (!seen.has(manifestPath)) queue.push(manifestPath);
    }
    for (const specifier of moduleSpecifiers(source, current)) {
      if (isThirdPartySpecifier(specifier)) bareImports.add(packageSpecifier(specifier));
      const dependency = resolveModuleDependency(current, specifier);
      if (dependency && !seen.has(dependency)) queue.push(dependency);
    }
  }
  return {
    files: files.sort((left, right) => left.path.localeCompare(right.path) || left.sha256.localeCompare(right.sha256)),
    bareImports: [...bareImports].sort(),
    snapshots: snapshots.sort((left, right) => left.path.localeCompare(right.path)),
  };
}
function packageScopeFiles(modulePath, logicalRoot) {
  const files = [];
  let directory = dirname(modulePath);
  while (directory === logicalRoot || !slash(relative(logicalRoot, directory)).startsWith('../')) {
    const manifest = resolve(directory, 'package.json');
    try {
      if (existsSync(manifest) && statSync(manifest).isFile()) files.push(realpathSync(manifest));
    } catch { /* malformed or racing package boundaries fail later during load */ }
    if (directory === logicalRoot) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return files;
}
// acorn is loaded lazily so the zero-dependency core chain never requires it:
// only custom-adapter static analysis parses JavaScript, and a missing
// dependency at that point is a fail-closed finding, not a silent skip.
let cachedAcornParse = null;
function parseJavaScript(source, options) {
  if (!cachedAcornParse) {
    try {
      cachedAcornParse = createRequire(import.meta.url)('acorn').parse;
    } catch {
      throw new BridgeOrchestratorError(
        'Custom adapter analysis requires the optional "acorn" dependency; run npm install for the package that provides axion-designer.',
        'AXION_BRIDGE_MODULE',
      );
    }
  }
  return cachedAcornParse(source, options);
}

function moduleSpecifiers(source, path) {
  if (extname(path) === '.json') return [];
  let ast;
  const options = { ecmaVersion: 'latest', allowHashBang: true };
  try {
    ast = parseJavaScript(source, { ...options, sourceType: extname(path) === '.cjs' ? 'script' : 'module' });
  } catch (moduleError) {
    if (extname(path) !== '.js') {
      throw new BridgeOrchestratorError(`Cannot parse adapter module ${slash(path)}: ${moduleError.message}`, 'AXION_BRIDGE_MODULE');
    }
    try { ast = parseJavaScript(source, { ...options, sourceType: 'script' }); }
    catch (scriptError) {
      throw new BridgeOrchestratorError(`Cannot parse adapter module ${slash(path)}: ${scriptError.message}`, 'AXION_BRIDGE_MODULE');
    }
  }
  const values = new Set();
  const stack = [{ node: ast, parent: null, key: null }];
  let visited = 0;
  while (stack.length) {
    const { node, parent, key } = stack.pop();
    if (!node || typeof node !== 'object') continue;
    if (++visited > 1_000_000) {
      throw new BridgeOrchestratorError('Adapter syntax tree exceeds the bounded analysis limit.', 'AXION_BRIDGE_MODULE');
    }
    if (['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration'].includes(node.type)
      && typeof node.source?.value === 'string') values.add(node.source.value);
    if (node.type === 'ImportExpression') {
      if (node.source?.type !== 'Literal' || typeof node.source.value !== 'string') {
        throw new BridgeOrchestratorError('Computed import() is not allowed in a contract-bound custom adapter.', 'AXION_BRIDGE_MODULE');
      }
      values.add(node.source.value);
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
      if (node.arguments.length !== 1 || node.arguments[0]?.type !== 'Literal' || typeof node.arguments[0].value !== 'string') {
        throw new BridgeOrchestratorError('Computed require() is not allowed in a contract-bound custom adapter.', 'AXION_BRIDGE_MODULE');
      }
      values.add(node.arguments[0].value);
    }
    if (node.type === 'Identifier' && node.name === 'require'
      && !(parent?.type === 'CallExpression' && key === 'callee')) {
      throw new BridgeOrchestratorError(
        'Indirect require references or aliases are not allowed in a contract-bound custom adapter.',
        'AXION_BRIDGE_MODULE',
      );
    }
    if (node.type === 'MemberExpression') {
      const property = node.computed && node.property?.type === 'Literal'
        ? node.property.value
        : !node.computed && node.property?.type === 'Identifier' ? node.property.name : null;
      if (property === 'require') {
        throw new BridgeOrchestratorError(
          'module.require and other indirect require access are not allowed in a contract-bound custom adapter.',
          'AXION_BRIDGE_MODULE',
        );
      }
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'eval') {
      throw new BridgeOrchestratorError('eval() is not allowed in a contract-bound custom adapter.', 'AXION_BRIDGE_MODULE');
    }
    if (['CallExpression', 'NewExpression'].includes(node.type)
      && node.callee?.type === 'Identifier' && node.callee.name === 'Function') {
      throw new BridgeOrchestratorError('Dynamic Function construction is not allowed in a contract-bound custom adapter.', 'AXION_BRIDGE_MODULE');
    }
    if (node.type === 'Identifier' && node.name === 'createRequire') {
      throw new BridgeOrchestratorError('createRequire() is not allowed in a contract-bound custom adapter.', 'AXION_BRIDGE_MODULE');
    }
    for (const [key, child] of Object.entries(node)) {
      if (['start', 'end', 'loc', 'range'].includes(key)) continue;
      if (Array.isArray(child)) child.forEach((item) => {
        if (item && typeof item === 'object') stack.push({ node: item, parent: node, key });
      });
      else if (child && typeof child === 'object') stack.push({ node: child, parent: node, key });
    }
  }
  return values;
}
function isThirdPartySpecifier(specifier) {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:')
    && !NODE_BUILTINS.has(specifier);
}
function packageSpecifier(specifier) {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}
function fingerprintDependencyFiles(root) {
  const lockfiles = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb']);
  return ['package.json', ...lockfiles]
    .filter((name) => existsSync(resolve(root, name)))
    .map((name) => ({ path: name, sha256: hashFile(resolve(root, name)), lockfile: lockfiles.has(name) }));
}
function resolveModuleDependency(importer, specifier) {
  if (typeof specifier !== 'string'
    || (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('file:'))) return null;
  let base;
  try {
    base = specifier.startsWith('file:')
      ? fileURLToPath(new URL(specifier))
      : isAbsolute(specifier) ? specifier : resolve(dirname(importer), specifier.split(/[?#]/, 1)[0]);
  } catch {
    return null;
  }
  const candidates = extname(base)
    ? [base]
    : [base, `${base}.mjs`, `${base}.js`, `${base}.cjs`, `${base}.json`, resolve(base, 'index.mjs'), resolve(base, 'index.js')];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return realpathSync(candidate);
    } catch { /* a broken optional import will be handled by the module loader */ }
  }
  return null;
}
function hashFile(path) {
  const descriptor = openSync(path, 'r');
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    while (true) {
      const count = readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      hash.update(buffer.subarray(0, count));
    }
    return hash.digest('hex');
  } finally {
    closeSync(descriptor);
  }
}
function slash(value) { return value.split(sep).join('/'); }
