export type ReferenceKind =
  | 'reference-manifest/v1'
  | 'visual-decomposition/v1'
  | 'component-mapping/v1'
  | 'reconstruction-plan/v1'
  | 'reference-comparison/v1';

export interface ArtifactResult<T = Record<string, unknown>> {
  path: string;
  sha256: string;
  bytes: number;
  artifact: T;
}

export class ReferenceSystemError extends Error { code: string; }
export class ReferenceValidationError extends ReferenceSystemError { issues: string[]; }
export function isReferenceSystemError(error: unknown): boolean;

export class ReferenceSystem {
  readonly projectRoot: string;
  readonly projectRootSha256: string;
  readonly directory: string;
  readonly paths: { directory: string; manifest: string; assets: string };
  artifactPaths(referenceId: string): Record<'manifest' | 'decomposition' | 'mapping' | 'plan' | 'comparison', string>;
  registerReferences(inputs: Array<Record<string, unknown>>, options?: { replace?: boolean }): ArtifactResult;
  readManifest(options?: { verifyAssets?: boolean }): ArtifactResult;
  readArtifact(path: string, options?: { validateLinks?: boolean }): ArtifactResult;
  validateArtifact(input: string | Record<string, unknown>, context?: Record<string, unknown>): string[];
  writeVisualDecomposition(input: Record<string, unknown>): ArtifactResult;
  writeComponentMapping(input: Record<string, unknown>): ArtifactResult;
  writeReconstructionPlan(input: Record<string, unknown>): ArtifactResult;
  compareReference(input: Record<string, unknown>): ArtifactResult;
  scanWholeReferenceBackground(files: string[]): Record<string, unknown>;
  inspectStatus(): Record<string, unknown>;
  verifyManifestAssets(manifest: Record<string, unknown>): true;
}

export function createReferenceSystem(
  projectRoot: string,
  options?: { directory?: string; clock?: () => Date | string | number },
): ReferenceSystem;
export function validateReferenceArtifact(artifact: unknown, context?: Record<string, unknown>): string[];
export function assertValidReferenceArtifact<T>(artifact: T, context?: Record<string, unknown>): T;
export function inspectImage(bytes: Uint8Array, declaredExtension?: string | null): Record<string, unknown>;
export function pngPixelStats(bytes: Uint8Array): Record<string, unknown> | null;
export function sha256(bytes: Uint8Array | string): string;
export function compareImageEvidence(
  reference: Record<string, unknown>,
  referenceBytes: Uint8Array,
  candidatePath: string,
  candidateBytes: Uint8Array,
  options?: { includePixelStats?: boolean },
): Record<string, unknown>;
export function scanWholeReferenceBackground(
  projectRoot: string,
  manifest: Record<string, unknown>,
  implementationFiles?: string[],
): Record<string, unknown>;
export function deriveHighestDeltas(
  metrics: Record<string, unknown>,
  regionFindings: Array<Record<string, unknown>>,
  policy: Record<string, unknown>,
  capture?: Record<string, unknown> | null,
): Array<Record<string, unknown>>;

export const REFERENCE_KINDS: Readonly<Record<string, ReferenceKind>>;
export const REFERENCE_LIMITS: Readonly<Record<string, unknown>>;
export const REFERENCE_FILENAMES: Readonly<Record<string, string | ((referenceId: string) => string)>>;
export const DEFAULT_REFERENCE_DIRECTORY: '.dk/reference';
export const ALLOWED_OPERATIONS: readonly string[];
export const LICENCE_STATUSES: readonly string[];
export const PROVENANCE_TYPES: readonly string[];
