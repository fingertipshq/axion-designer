export {
  type AxionBridgeTrustLevel,
  type AxionBridgeLifecycle,
  type AxionBridgeIssue,
  type AxionBridgeAdapterManifest,
  type AxionBridgeArtifact,
  type AxionBridgeEnvelope,
  type AxionBridgeAudit,
  ADAPTER_MANIFEST_SCHEMA,
  INTEGRATION_ENVELOPE_SCHEMA,
  ARTIFACT_LEDGER_SCHEMA,
  MAX_BRIDGE_LEDGER_BYTES,
  createAdapterManifest,
  validateAdapterManifest,
  createIntegrationEnvelope,
  validateIntegrationEnvelope,
  AdapterRegistry,
  BridgeRuntime,
  createBridgeRuntime,
  readArtifactLedger,
  verifyArtifactLedger,
  bridgeGitIdentity,
  bridgeConnectionContractDigest,
  builtInAdapterCatalog,
  syncBridge,
  auditBridge,
  latestBridgeEnvelope,
  ingestBridgeEnvelope,
  initializeBridgeManifest,
  safeFetch,
} from '../../index.js';

import type {
  AxionBridgeAdapterManifest,
  AxionBridgeEnvelope,
  AxionBridgeIssue,
  AxionBridgeLifecycle,
  AxionBridgeTrustLevel,
  DkBridgeConnection,
  DkResolvedConfig,
} from '../../index.js';

export const BRIDGE_LIFECYCLES: readonly AxionBridgeLifecycle[];
export const BRIDGE_TRUST_LEVELS: readonly AxionBridgeTrustLevel[];
export const BRIDGE_RUN_SCHEMA: 'axion-bridge-run/v1';
export const LEDGER_CONNECTION_SCHEMA: 'axion-bridge-connection/v1';
export const BRIDGE_STATUS_SCHEMA: 'axion-bridge-status/v1';
export const BRIDGE_CONFIG_SCHEMA: 'axion-bridge-config/v1';
export const DEFAULT_BRIDGE_ARTIFACT_DIR: '.dk/bridge';
export const BRIDGE_LEDGER_FILE: 'ledger.json';

export class BridgeValidationError extends Error {
  code: string;
  issues: AxionBridgeIssue[];
  constructor(message: string, issues?: AxionBridgeIssue[]);
}
export class BridgeRegistryError extends Error {
  code: string;
  details: unknown;
  constructor(message: string, code?: string, details?: unknown);
}
export class BridgeRuntimeError extends Error {
  code: string;
  details: unknown;
  constructor(message: string, code?: string, details?: unknown);
}
export class BridgeTimeoutError extends BridgeRuntimeError {
  constructor(adapter: string, operation: AxionBridgeLifecycle, timeoutMs: number);
}
export class BridgeAbortError extends BridgeRuntimeError {
  constructor(adapter: string, operation: AxionBridgeLifecycle, reason?: unknown);
}
export class BridgePermissionError extends BridgeRuntimeError {
  constructor(adapter: string, operation: AxionBridgeLifecycle, missing: string[]);
}
export class BridgeRequiredProviderError extends BridgeRuntimeError {
  run: Record<string, unknown>;
  constructor(message: string, run: Record<string, unknown>);
}
export class BridgeLedgerError extends BridgeRuntimeError {
  issues: AxionBridgeIssue[];
  constructor(message: string, issues?: AxionBridgeIssue[]);
}
export class BridgeOrchestratorError extends Error {
  code: string;
  details: unknown;
  constructor(message: string, code?: string, details?: unknown);
}

export function canonicalStringify(value: unknown): string;
export function canonicalSha256(value: unknown): string;
export function integrationEnvelopeDigest(envelope: AxionBridgeEnvelope | Record<string, unknown>): string;
export function assertAdapterManifest(manifest: unknown): AxionBridgeAdapterManifest;
export function assertIntegrationEnvelope<T = unknown>(
  envelope: unknown,
  policy?: Record<string, unknown>,
): AxionBridgeEnvelope<T>;
export function trustRank(level: AxionBridgeTrustLevel): number;
export function isSafeRelativePath(value: unknown): value is string;

export interface AxionBridgeAdapter {
  manifest: AxionBridgeAdapterManifest;
  discover?: (input?: Record<string, unknown>, context?: Record<string, unknown>) => Promise<unknown[]>;
  collect?: (input?: Record<string, unknown>, context?: Record<string, unknown>) => Promise<AxionBridgeEnvelope[]>;
  publish?: (input: Record<string, unknown>, context?: Record<string, unknown>) => Promise<unknown[]>;
}
export function createMemoryEnvelopeAdapter(options?: {
  id?: string;
  provider?: string;
  version?: string;
  envelopes?: AxionBridgeEnvelope[];
}): AxionBridgeAdapter;
export function createFileEnvelopeAdapter(options: {
  id?: string;
  provider?: string;
  version?: string;
  root: string;
}): AxionBridgeAdapter;
export function resolveInsideRoot(
  root: string,
  relativePath: string,
  options?: { allowMissing?: boolean; allowMissingRoot?: boolean },
): string;

export function invokeWithControl(
  adapter: AxionBridgeAdapter,
  operation: AxionBridgeLifecycle,
  input: Record<string, unknown>,
  options: Record<string, unknown>,
): Promise<unknown>;
export function artifactLedgerPath(root: string, artifactDir?: string): string;
export function emptyArtifactLedger(
  repository?: string | { root: string; commit?: string | null },
  now?: string | number | Date,
): Record<string, unknown>;
export function appendArtifactLedger(
  root: string,
  input: Record<string, unknown>,
  options?: Record<string, unknown>,
): { ledger: Record<string, unknown>; entry: Record<string, unknown>; path: string; headHash: string };
export function createConnectionAdapter(
  connection: DkBridgeConnection,
  context?: Record<string, unknown>,
): Promise<AxionBridgeAdapter>;
