export const REFERENCE_KINDS = Object.freeze({
  manifest: 'reference-manifest/v1',
  decomposition: 'visual-decomposition/v1',
  mapping: 'component-mapping/v1',
  plan: 'reconstruction-plan/v1',
  comparison: 'reference-comparison/v1',
});

export const REFERENCE_LIMITS = Object.freeze({
  maxReferences: 5,
  maxBytesPerReference: 20 * 1024 * 1024,
  maxImageDimension: 16_384,
  maxImagePixels: 100_000_000,
  maxArtifactBytes: 2 * 1024 * 1024,
  maxImplementationFileBytes: 2 * 1024 * 1024,
  maxImplementationFiles: 200,
  allowedFormats: Object.freeze(['png', 'jpeg', 'webp']),
});

export const DEFAULT_REFERENCE_DIRECTORY = '.dk/reference';

export const REFERENCE_FILENAMES = Object.freeze({
  manifest: 'reference-manifest.json',
  decomposition: (referenceId) => `visual-decomposition.${referenceId}.json`,
  mapping: (referenceId) => `component-mapping.${referenceId}.json`,
  plan: (referenceId) => `reconstruction-plan.${referenceId}.json`,
  comparison: (referenceId) => `reference-comparison.${referenceId}.json`,
});

export const ALLOWED_OPERATIONS = Object.freeze([
  'decompose',
  'map-components',
  'plan-reconstruction',
  'reconstruct',
  'compare',
  'extract-assets',
]);

export const LICENCE_STATUSES = Object.freeze([
  'owned',
  'licensed',
  'permission-granted',
  'public-domain',
  'unknown',
]);

export const PROVENANCE_TYPES = Object.freeze([
  'user-provided',
  'url-capture',
  'figma-export',
  'screen-recording-frame',
  'generated',
  'other',
]);

export const REGION_ROLES = Object.freeze([
  'page', 'header', 'navigation', 'main', 'section', 'card', 'form',
  'control', 'content', 'media', 'decoration', 'footer', 'overlay', 'other',
]);

export const MAPPING_STRATEGIES = Object.freeze(['reuse', 'adapt', 'create']);
export const PLAN_ACTIONS = Object.freeze(['reuse', 'create', 'modify', 'integrate', 'verify']);
export const DELTA_SEVERITIES = Object.freeze(['info', 'low', 'medium', 'high', 'critical']);

