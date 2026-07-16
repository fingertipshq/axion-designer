import {
  ALLOWED_OPERATIONS,
  DELTA_SEVERITIES,
  LICENCE_STATUSES,
  MAPPING_STRATEGIES,
  PLAN_ACTIONS,
  PROVENANCE_TYPES,
  REFERENCE_KINDS,
  REFERENCE_LIMITS,
  REGION_ROLES,
} from './constants.mjs';
import { ReferenceValidationError } from './errors.mjs';
import { sha256 } from './image.mjs';
import { comparisonStatus, deriveHighestDeltas } from './compare.mjs';
import { scopeAllowsProjectPath, scopeAllowsRoute, validateProjectRelativePath } from './safety.mjs';
import { appProofCaseId } from '../proof/app-proof.mjs';

const HEX_256 = /^[a-f0-9]{64}$/;
const HEX_16 = /^[a-f0-9]{16}$/;
const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const KINDS = new Set(Object.values(REFERENCE_KINDS));
const SEVERITY = new Set(DELTA_SEVERITIES);

export function validateReferenceArtifact(artifact, context = {}) {
  const issues = [];
  if (!record(artifact)) return ['artifact must be an object'];
  if (!KINDS.has(artifact.kind)) return [`kind must be one of: ${[...KINDS].join(', ')}`];
  validateCommon(artifact, issues);
  if (artifact.kind === REFERENCE_KINDS.manifest) validateManifest(artifact, issues);
  else {
    validateArtifactReference(artifact.manifest, 'manifest', issues);
    nonempty(artifact.referenceId, 'referenceId', issues);
    if (context.manifest) validateManifestBinding(artifact, context.manifest, issues);
    if (artifact.kind === REFERENCE_KINDS.decomposition) validateDecomposition(artifact, context, issues);
    if (artifact.kind === REFERENCE_KINDS.mapping) validateMapping(artifact, context, issues);
    if (artifact.kind === REFERENCE_KINDS.plan) validatePlan(artifact, context, issues);
    if (artifact.kind === REFERENCE_KINDS.comparison) validateComparison(artifact, context, issues);
  }
  return issues;
}

export function assertValidReferenceArtifact(artifact, context = {}) {
  const issues = validateReferenceArtifact(artifact, context);
  if (issues.length) throw new ReferenceValidationError(issues);
  return artifact;
}

function validateCommon(value, issues) {
  nonempty(value.artifactId, 'artifactId', issues);
  if (typeof value.artifactId === 'string' && !SAFE_ID.test(value.artifactId)) {
    issues.push('artifactId must be a lowercase safe id');
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    issues.push('createdAt must be an ISO timestamp');
  }
  digest(value.projectRootSha256, 'projectRootSha256', issues);
}

function validateManifest(value, issues) {
  exactKeys(value, ['kind', 'artifactId', 'createdAt', 'projectRootSha256', 'limits', 'references'], 'manifest', issues);
  exactKeys(value.limits, ['maxReferences', 'maxBytesPerReference', 'allowedFormats'], 'limits', issues);
  if (value.limits?.maxReferences !== REFERENCE_LIMITS.maxReferences) issues.push(`limits.maxReferences must be ${REFERENCE_LIMITS.maxReferences}`);
  if (value.limits?.maxBytesPerReference !== REFERENCE_LIMITS.maxBytesPerReference) issues.push(`limits.maxBytesPerReference must be ${REFERENCE_LIMITS.maxBytesPerReference}`);
  stringArray(value.limits?.allowedFormats, 'limits.allowedFormats', issues, { nonempty: true, unique: true });
  if (JSON.stringify(value.limits?.allowedFormats) !== JSON.stringify([...REFERENCE_LIMITS.allowedFormats])) {
    issues.push(`limits.allowedFormats must be ${REFERENCE_LIMITS.allowedFormats.join(', ')}`);
  }
  if (!Array.isArray(value.references)) issues.push('references must be an array');
  else {
    if (value.references.length > REFERENCE_LIMITS.maxReferences) issues.push(`references may contain at most ${REFERENCE_LIMITS.maxReferences} entries`);
    const ids = new Set();
    for (let i = 0; i < value.references.length; i++) {
      const entry = value.references[i];
      const at = `references[${i}]`;
      validateReferenceEntry(entry, at, issues);
      if (ids.has(entry?.id)) issues.push(`${at}.id duplicates another reference`);
      ids.add(entry?.id);
    }
  }
}

function validateReferenceEntry(value, at, issues) {
  exactKeys(value, [
    'id', 'originalPath', 'storedPath', 'format', 'mediaType', 'bytes', 'width', 'height', 'sha256',
    'provenance', 'licence', 'viewport', 'authorizedScope',
  ], at, issues);
  nonempty(value?.id, `${at}.id`, issues);
  if (typeof value?.id === 'string' && !SAFE_ID.test(value.id)) issues.push(`${at}.id must be a lowercase safe id`);
  for (const key of ['originalPath', 'storedPath']) {
    const pathIssue = validateProjectRelativePath(value?.[key], `${at}.${key}`);
    if (pathIssue) issues.push(pathIssue);
  }
  oneOf(value?.format, REFERENCE_LIMITS.allowedFormats, `${at}.format`, issues);
  const media = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[value?.format];
  if (value?.mediaType !== media) issues.push(`${at}.mediaType must match format`);
  integer(value?.bytes, `${at}.bytes`, issues, 1, REFERENCE_LIMITS.maxBytesPerReference);
  integer(value?.width, `${at}.width`, issues, 1, REFERENCE_LIMITS.maxImageDimension);
  integer(value?.height, `${at}.height`, issues, 1, REFERENCE_LIMITS.maxImageDimension);
  if (Number.isInteger(value?.width) && Number.isInteger(value?.height)
      && value.width * value.height > REFERENCE_LIMITS.maxImagePixels) issues.push(`${at} exceeds the maximum pixel count`);
  digest(value?.sha256, `${at}.sha256`, issues);
  validateProvenance(value?.provenance, `${at}.provenance`, issues);
  validateLicence(value?.licence, `${at}.licence`, issues);
  validateViewport(value?.viewport, `${at}.viewport`, issues, { named: false });
  validateAuthorizedScope(value?.authorizedScope, `${at}.authorizedScope`, issues);
  if (value?.licence?.status === 'unknown') {
    const disallowed = (value?.authorizedScope?.operations ?? []).filter((operation) => operation !== 'decompose');
    if (disallowed.length) issues.push(`${at}.authorizedScope.operations may only contain decompose while licence status is unknown`);
  }
}

function validateProvenance(value, at, issues) {
  exactKeys(value, ['type', 'source', 'capturedAt', 'author', 'notes'], at, issues);
  oneOf(value?.type, PROVENANCE_TYPES, `${at}.type`, issues);
  nonempty(value?.source, `${at}.source`, issues);
  optionalTimestamp(value?.capturedAt, `${at}.capturedAt`, issues);
  optionalString(value?.author, `${at}.author`, issues);
  optionalString(value?.notes, `${at}.notes`, issues);
}

function validateLicence(value, at, issues) {
  exactKeys(value, ['status', 'identifier', 'termsUrl', 'attribution', 'notes'], at, issues);
  oneOf(value?.status, LICENCE_STATUSES, `${at}.status`, issues);
  optionalString(value?.identifier, `${at}.identifier`, issues);
  optionalUrl(value?.termsUrl, `${at}.termsUrl`, issues);
  optionalString(value?.attribution, `${at}.attribution`, issues);
  optionalString(value?.notes, `${at}.notes`, issues);
}

function validateAuthorizedScope(value, at, issues) {
  exactKeys(value, ['projectPaths', 'routes', 'operations', 'notes'], at, issues);
  stringArray(value?.projectPaths, `${at}.projectPaths`, issues, { unique: true });
  stringArray(value?.routes, `${at}.routes`, issues, { unique: true });
  if (!(value?.projectPaths?.length || value?.routes?.length)) issues.push(`${at} must authorize at least one project path or route`);
  for (let i = 0; i < (value?.projectPaths?.length ?? 0); i++) {
    const raw = value.projectPaths[i];
    const base = raw.endsWith('/**') ? raw.slice(0, -3) : raw;
    const pathIssue = validateProjectRelativePath(base, `${at}.projectPaths[${i}]`);
    if (pathIssue) issues.push(pathIssue);
  }
  stringArray(value?.operations, `${at}.operations`, issues, { nonempty: true, unique: true });
  for (const operation of value?.operations ?? []) oneOf(operation, ALLOWED_OPERATIONS, `${at}.operations`, issues);
  optionalString(value?.notes, `${at}.notes`, issues);
}

function validateDecomposition(value, context, issues) {
  exactKeys(value, [
    'kind', 'artifactId', 'createdAt', 'projectRootSha256', 'manifest', 'referenceId', 'authoredBy',
    'canvas', 'global', 'regions', 'assumptions', 'unresolved',
  ], 'decomposition', issues);
  validateAuthor(value.authoredBy, 'authoredBy', issues);
  exactKeys(value.canvas, ['width', 'height'], 'canvas', issues);
  integer(value.canvas?.width, 'canvas.width', issues, 1, REFERENCE_LIMITS.maxImageDimension);
  integer(value.canvas?.height, 'canvas.height', issues, 1, REFERENCE_LIMITS.maxImageDimension);
  const reference = context.manifest ? findReference(context.manifest, value.referenceId) : null;
  if (reference && (value.canvas?.width !== reference.width || value.canvas?.height !== reference.height)) {
    issues.push('canvas dimensions must match the registered reference');
  }
  exactKeys(value.global, ['summary', 'layout', 'palette', 'typography', 'spacing'], 'global', issues);
  nonempty(value.global?.summary, 'global.summary', issues);
  for (const key of ['layout', 'palette', 'typography', 'spacing']) stringArray(value.global?.[key], `global.${key}`, issues, { unique: true });
  stringArray(value.assumptions, 'assumptions', issues, { unique: true });
  stringArray(value.unresolved, 'unresolved', issues, { unique: true });
  if (!Array.isArray(value.regions) || value.regions.length === 0) issues.push('regions must be a non-empty array');
  const ids = new Set();
  for (let index = 0; index < (value.regions?.length ?? 0); index++) {
    const region = value.regions[index];
    const at = `regions[${index}]`;
    exactKeys(region, ['id', 'label', 'role', 'bounds', 'description', 'confidence', 'visual', 'evidence'], at, issues);
    nonempty(region?.id, `${at}.id`, issues);
    if (typeof region?.id === 'string' && !SAFE_ID.test(region.id)) issues.push(`${at}.id must be a lowercase safe id`);
    if (ids.has(region?.id)) issues.push(`${at}.id duplicates another region`);
    ids.add(region?.id);
    nonempty(region?.label, `${at}.label`, issues);
    oneOf(region?.role, REGION_ROLES, `${at}.role`, issues);
    validateBounds(region?.bounds, `${at}.bounds`, value.canvas, issues);
    nonempty(region?.description, `${at}.description`, issues);
    number(region?.confidence, `${at}.confidence`, issues, 0, 1);
    exactKeys(region?.visual, ['layout', 'colors', 'typography', 'spacing', 'assets'], `${at}.visual`, issues);
    nonempty(region?.visual?.layout, `${at}.visual.layout`, issues);
    for (const key of ['colors', 'typography', 'spacing', 'assets']) stringArray(region?.visual?.[key], `${at}.visual.${key}`, issues, { unique: true });
    stringArray(region?.evidence, `${at}.evidence`, issues, { unique: true });
  }
  requireOperation(reference, 'decompose', issues);
}

function validateMapping(value, context, issues) {
  exactKeys(value, [
    'kind', 'artifactId', 'createdAt', 'projectRootSha256', 'manifest', 'referenceId', 'decomposition',
    'authoredBy', 'mappings', 'unmappedRegions',
  ], 'mapping', issues);
  validateArtifactReference(value.decomposition, 'decomposition', issues);
  validateAuthor(value.authoredBy, 'authoredBy', issues);
  if (!Array.isArray(value.mappings) || value.mappings.length === 0) issues.push('mappings must be a non-empty array');
  if (!Array.isArray(value.unmappedRegions)) issues.push('unmappedRegions must be an array');
  const reference = context.manifest ? findReference(context.manifest, value.referenceId) : null;
  if (context.decomposition) {
    if (context.decomposition.referenceId !== value.referenceId) issues.push('decomposition is bound to a different referenceId');
    if (context.decomposition.manifest?.sha256 !== value.manifest?.sha256) issues.push('decomposition is bound to a different manifest');
  }
  const mappingIds = new Set();
  const accounted = new Set();
  for (let index = 0; index < (value.mappings?.length ?? 0); index++) {
    const mapping = value.mappings[index];
    const at = `mappings[${index}]`;
    exactKeys(mapping, ['id', 'regionIds', 'target', 'strategy', 'rationale', 'confidence'], at, issues);
    nonempty(mapping?.id, `${at}.id`, issues);
    if (typeof mapping?.id === 'string' && !SAFE_ID.test(mapping.id)) issues.push(`${at}.id must be a lowercase safe id`);
    if (mappingIds.has(mapping?.id)) issues.push(`${at}.id duplicates another mapping`);
    mappingIds.add(mapping?.id);
    stringArray(mapping?.regionIds, `${at}.regionIds`, issues, { nonempty: true, unique: true });
    for (const id of mapping?.regionIds ?? []) {
      if (accounted.has(id)) issues.push(`${at}.regionIds accounts for ${id} more than once`);
      accounted.add(id);
    }
    exactKeys(mapping?.target, ['projectPath', 'exportName', 'route'], `${at}.target`, issues);
    const pathIssue = validateProjectRelativePath(mapping?.target?.projectPath, `${at}.target.projectPath`);
    if (pathIssue) issues.push(pathIssue);
    if (reference && !scopeAllowsProjectPath(reference.authorizedScope, mapping?.target?.projectPath ?? '')) {
      issues.push(`${at}.target.projectPath is outside the reference authorized scope`);
    }
    optionalString(mapping?.target?.exportName, `${at}.target.exportName`, issues);
    optionalString(mapping?.target?.route, `${at}.target.route`, issues);
    if (reference && !scopeAllowsRoute(reference.authorizedScope, mapping?.target?.route)) {
      issues.push(`${at}.target.route is outside the reference authorized scope`);
    }
    oneOf(mapping?.strategy, MAPPING_STRATEGIES, `${at}.strategy`, issues);
    nonempty(mapping?.rationale, `${at}.rationale`, issues);
    number(mapping?.confidence, `${at}.confidence`, issues, 0, 1);
  }
  const unmappedIds = new Set();
  for (let index = 0; index < (value.unmappedRegions?.length ?? 0); index++) {
    const item = value.unmappedRegions[index];
    const at = `unmappedRegions[${index}]`;
    exactKeys(item, ['regionId', 'reason'], at, issues);
    nonempty(item?.regionId, `${at}.regionId`, issues);
    nonempty(item?.reason, `${at}.reason`, issues);
    if (unmappedIds.has(item?.regionId) || accounted.has(item?.regionId)) issues.push(`${at}.regionId is accounted for more than once`);
    unmappedIds.add(item?.regionId);
    accounted.add(item?.regionId);
  }
  if (context.decomposition) {
    const expected = new Set(context.decomposition.regions.map((region) => region.id));
    for (const id of accounted) if (!expected.has(id)) issues.push(`mapping refers to unknown region: ${id}`);
    for (const id of expected) if (!accounted.has(id)) issues.push(`mapping does not account for region: ${id}`);
  }
  requireOperation(reference, 'map-components', issues);
}

function validatePlan(value, context, issues) {
  exactKeys(value, [
    'kind', 'artifactId', 'createdAt', 'projectRootSha256', 'manifest', 'referenceId', 'componentMapping',
    'authoredBy', 'rules', 'steps', 'verification',
  ], 'plan', issues);
  validateArtifactReference(value.componentMapping, 'componentMapping', issues);
  validateAuthor(value.authoredBy, 'authoredBy', issues);
  exactKeys(value.rules, ['noWholeReferenceBackground', 'preserveExistingStack', 'assetReuse', 'scopeEnforced'], 'rules', issues);
  if (value.rules?.noWholeReferenceBackground !== true) issues.push('rules.noWholeReferenceBackground must be true');
  if (value.rules?.preserveExistingStack !== true) issues.push('rules.preserveExistingStack must be true');
  if (value.rules?.scopeEnforced !== true) issues.push('rules.scopeEnforced must be true');
  oneOf(value.rules?.assetReuse, ['exact-or-cropped', 'exact-only'], 'rules.assetReuse', issues);
  const reference = context.manifest ? findReference(context.manifest, value.referenceId) : null;
  if (context.mapping) {
    if (context.mapping.referenceId !== value.referenceId) issues.push('componentMapping is bound to a different referenceId');
    if (context.mapping.manifest?.sha256 !== value.manifest?.sha256) issues.push('componentMapping is bound to a different manifest');
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) issues.push('steps must be a non-empty array');
  const stepIds = new Set();
  let hasVerify = false;
  for (let index = 0; index < (value.steps?.length ?? 0); index++) {
    const step = value.steps[index];
    const at = `steps[${index}]`;
    exactKeys(step, ['id', 'order', 'title', 'action', 'targets', 'mappingIds', 'dependsOn', 'acceptance'], at, issues);
    nonempty(step?.id, `${at}.id`, issues);
    if (stepIds.has(step?.id)) issues.push(`${at}.id duplicates another step`);
    stepIds.add(step?.id);
    if (step?.order !== index + 1) issues.push(`${at}.order must be ${index + 1}`);
    nonempty(step?.title, `${at}.title`, issues);
    oneOf(step?.action, PLAN_ACTIONS, `${at}.action`, issues);
    if (step?.action === 'verify') hasVerify = true;
    stringArray(step?.targets, `${at}.targets`, issues, { nonempty: step?.action !== 'verify', unique: true });
    for (let i = 0; i < (step?.targets?.length ?? 0); i++) {
      const target = step.targets[i];
      const pathIssue = validateProjectRelativePath(target, `${at}.targets[${i}]`);
      if (pathIssue) issues.push(pathIssue);
      if (reference && !scopeAllowsProjectPath(reference.authorizedScope, target)) issues.push(`${at}.targets[${i}] is outside the reference authorized scope`);
    }
    stringArray(step?.mappingIds, `${at}.mappingIds`, issues, { unique: true });
    stringArray(step?.dependsOn, `${at}.dependsOn`, issues, { unique: true });
    for (const dependency of step?.dependsOn ?? []) if (!stepIds.has(dependency)) issues.push(`${at}.dependsOn must refer to an earlier step: ${dependency}`);
    stringArray(step?.acceptance, `${at}.acceptance`, issues, { nonempty: true, unique: true });
  }
  if (!hasVerify) issues.push('steps must contain at least one verify action');
  exactKeys(value.verification, ['viewports', 'implementationFiles', 'requiredComparisons'], 'verification', issues);
  if (!Array.isArray(value.verification?.viewports) || value.verification.viewports.length === 0) issues.push('verification.viewports must be a non-empty array');
  if (Array.isArray(value.verification?.viewports) && value.verification.viewports.length !== 1) {
    issues.push('verification.viewports must contain exactly one viewport in reference artifact v1');
  }
  for (let i = 0; i < (value.verification?.viewports?.length ?? 0); i++) validateViewport(value.verification.viewports[i], `verification.viewports[${i}]`, issues, { named: true });
  stringArray(value.verification?.implementationFiles, 'verification.implementationFiles', issues, { nonempty: true, unique: true });
  for (let i = 0; i < (value.verification?.implementationFiles?.length ?? 0); i++) {
    const path = value.verification.implementationFiles[i];
    const pathIssue = validateProjectRelativePath(path, `verification.implementationFiles[${i}]`);
    if (pathIssue) issues.push(pathIssue);
    if (reference && !scopeAllowsProjectPath(reference.authorizedScope, path)) issues.push(`verification.implementationFiles[${i}] is outside the reference authorized scope`);
  }
  integer(value.verification?.requiredComparisons, 'verification.requiredComparisons', issues, 1, 1);
  if (value.verification?.requiredComparisons !== 1) issues.push('verification.requiredComparisons must be 1 in reference artifact v1');
  const implementationSet = new Set(value.verification?.implementationFiles ?? []);
  for (let index = 0; index < (value.steps?.length ?? 0); index++) {
    const step = value.steps[index];
    if (step?.action === 'verify') continue;
    for (const target of step?.targets ?? []) {
      if (!implementationSet.has(target)) issues.push(`steps[${index}].targets must be included in verification.implementationFiles: ${target}`);
    }
  }
  if (reference && value.verification?.viewports?.[0]) {
    const viewport = value.verification.viewports[0];
    if (viewport.width !== reference.viewport.width
      || viewport.height !== reference.viewport.height
      || viewport.deviceScaleFactor !== reference.viewport.deviceScaleFactor) {
      issues.push('verification viewport must match the registered reference viewport');
    }
  }
  if (context.mapping) {
    const mappingIds = new Set(context.mapping.mappings.map((mapping) => mapping.id));
    for (const step of value.steps ?? []) {
      for (const id of step.mappingIds ?? []) if (!mappingIds.has(id)) issues.push(`plan refers to unknown mapping: ${id}`);
    }
    for (const mapping of context.mapping.mappings) {
      if (!implementationSet.has(mapping.target.projectPath)) {
        issues.push(`verification.implementationFiles must include mapped target: ${mapping.target.projectPath}`);
      }
    }
  }
  requireOperation(reference, 'plan-reconstruction', issues);
}

function validateComparison(value, context, issues) {
  exactKeys(value, [
    'kind', 'artifactId', 'createdAt', 'projectRootSha256', 'manifest', 'referenceId', 'reconstructionPlan', 'viewport', 'generated',
    'candidate', 'capture', 'metrics', 'regionFindings', 'policy', 'highestDeltas', 'status',
  ], 'comparison', issues);
  validateArtifactReference(value.reconstructionPlan, 'reconstructionPlan', issues);
  validateViewport(value.viewport, 'viewport', issues, { named: true });
  exactKeys(value.generated, ['engine', 'engineVersion', 'inputsSha256'], 'generated', issues);
  if (value.generated?.engine !== 'axion-reference-core') issues.push('generated.engine must be axion-reference-core');
  if (value.generated?.engineVersion !== 1) issues.push('generated.engineVersion must be 1');
  digest(value.generated?.inputsSha256, 'generated.inputsSha256', issues);
  validateImageEvidence(value.candidate, 'candidate', issues);
  const reference = context.manifest ? findReference(context.manifest, value.referenceId) : null;
  validateCaptureAttestation(value.capture, value.candidate, value.viewport, value.createdAt, reference, issues);
  exactKeys(value.metrics, ['exactHashMatch', 'dimensions', 'pixelStats'], 'metrics', issues);
  if (typeof value.metrics?.exactHashMatch !== 'boolean') issues.push('metrics.exactHashMatch must be boolean');
  validateDimensionsMetric(value.metrics?.dimensions, issues);
  if (value.metrics?.pixelStats !== null) validatePixelMetric(value.metrics?.pixelStats, issues);
  if (!Array.isArray(value.regionFindings)) issues.push('regionFindings must be an array');
  for (let i = 0; i < (value.regionFindings?.length ?? 0); i++) validateRegionFinding(value.regionFindings[i], `regionFindings[${i}]`, issues);
  validatePolicy(value.policy, issues);
  if (!Array.isArray(value.highestDeltas) || value.highestDeltas.length > 3) issues.push('highestDeltas must contain at most 3 entries');
  for (let i = 0; i < (value.highestDeltas?.length ?? 0); i++) validateDelta(value.highestDeltas[i], `highestDeltas[${i}]`, issues);
  for (let i = 1; i < (value.highestDeltas?.length ?? 0); i++) {
    if (value.highestDeltas[i].score > value.highestDeltas[i - 1].score) issues.push('highestDeltas must be sorted by descending score');
  }
  oneOf(value.status, ['match', 'review', 'mismatch', 'incomplete'], 'status', issues);
  if (context.plan) {
    if (context.plan.referenceId !== value.referenceId) issues.push('reconstructionPlan is bound to a different referenceId');
    if (context.plan.manifest?.sha256 !== value.manifest?.sha256) issues.push('reconstructionPlan is bound to a different manifest');
    if (JSON.stringify(value.viewport) !== JSON.stringify(context.plan.verification?.viewports?.[0])) {
      issues.push('comparison viewport must match the reconstruction plan viewport');
    }
    const expectedFiles = context.plan.verification?.implementationFiles ?? [];
    if (JSON.stringify(value.policy?.noWholeReferenceBackground?.scannedFiles) !== JSON.stringify(expectedFiles)) {
      issues.push('policy scannedFiles must exactly match reconstructionPlan verification.implementationFiles');
    }
  }
  const expectedDeltas = value.metrics && Array.isArray(value.regionFindings) && value.policy?.noWholeReferenceBackground
    ? deriveHighestDeltas(value.metrics, value.regionFindings, value.policy.noWholeReferenceBackground, value.capture)
    : null;
  if (expectedDeltas && JSON.stringify(value.highestDeltas) !== JSON.stringify(expectedDeltas)) {
    issues.push('highestDeltas do not match the deterministic comparison evidence');
  }
  const expectedStatus = expectedDeltas
    ? comparisonStatus(value.metrics, expectedDeltas, value.policy.noWholeReferenceBackground, value.capture)
    : null;
  if (expectedStatus && value.status !== expectedStatus) {
    issues.push(`status must be ${expectedStatus} for the recorded comparison evidence`);
  }
  if (reference && value.candidate && value.metrics) {
    if (value.metrics.exactHashMatch !== (reference.sha256 === value.candidate.sha256)) {
      issues.push('metrics.exactHashMatch contradicts the registered and candidate SHA-256 digests');
    }
    const expectedDimensions = {
      match: reference.width === value.candidate.width && reference.height === value.candidate.height,
      reference: { width: reference.width, height: reference.height },
      candidate: { width: value.candidate.width, height: value.candidate.height },
      widthDeltaPx: Math.abs(reference.width - value.candidate.width),
      heightDeltaPx: Math.abs(reference.height - value.candidate.height),
      aspectRatioDelta: round6(Math.abs(reference.width / reference.height - value.candidate.width / value.candidate.height)),
    };
    if (JSON.stringify(value.metrics.dimensions) !== JSON.stringify(expectedDimensions)) {
      issues.push('metrics.dimensions contradicts registered and candidate image metadata');
    }
    const expectedInputs = sha256(Buffer.from(JSON.stringify({
      reference: { id: reference.id, sha256: reference.sha256, viewport: reference.viewport },
      candidate: { sha256: value.candidate.sha256, width: value.candidate.width, height: value.candidate.height },
      reconstructionPlan: value.reconstructionPlan,
      viewport: value.viewport,
      metrics: value.metrics,
      regionFindings: value.regionFindings,
      policy: value.policy?.noWholeReferenceBackground,
      capture: value.capture,
      highestDeltas: value.highestDeltas,
      status: value.status,
    }), 'utf8'));
    if (value.generated?.inputsSha256 !== expectedInputs) issues.push('generated.inputsSha256 does not bind the comparison inputs');
  }
  requireOperation(reference, 'compare', issues);
}

function validateCaptureAttestation(value, candidate, comparisonViewport, comparisonCreatedAt, reference, issues) {
  exactKeys(value, ['status', 'reason', 'proof', 'ledger', 'case'], 'capture', issues);
  oneOf(value?.status, ['attested', 'unattested'], 'capture.status', issues);
  if (value?.status === 'unattested') {
    nonempty(value.reason, 'capture.reason', issues);
    if (value.proof !== null || value.ledger !== null || value.case !== null) {
      issues.push('unattested capture must not claim proof, ledger, or case evidence');
    }
    return;
  }
  if (value?.status !== 'attested') return;
  if (value.reason !== null) issues.push('attested capture.reason must be null');

  exactKeys(value.proof, ['path', 'sha256', 'configHash', 'startedAt', 'finishedAt'], 'capture.proof', issues);
  if (value.proof?.path !== '.dk/proof/app-proof.json') issues.push('capture.proof.path must be .dk/proof/app-proof.json');
  digest(value.proof?.sha256, 'capture.proof.sha256', issues);
  digest(value.proof?.configHash, 'capture.proof.configHash', issues);
  requiredTimestamp(value.proof?.startedAt, 'capture.proof.startedAt', issues);
  requiredTimestamp(value.proof?.finishedAt, 'capture.proof.finishedAt', issues);
  if (timestampOrder(value.proof?.startedAt, value.proof?.finishedAt) > 0) {
    issues.push('capture.proof.finishedAt must not predate startedAt');
  }

  exactKeys(value.ledger, [
    'path', 'sha256', 'generatedAt', 'runtimeVersion', 'configHash', 'sourceFingerprint', 'partial',
  ], 'capture.ledger', issues);
  if (value.ledger?.path !== '.dk/report.json') issues.push('capture.ledger.path must be .dk/report.json');
  digest(value.ledger?.sha256, 'capture.ledger.sha256', issues);
  requiredTimestamp(value.ledger?.generatedAt, 'capture.ledger.generatedAt', issues);
  nonempty(value.ledger?.runtimeVersion, 'capture.ledger.runtimeVersion', issues);
  if (typeof value.ledger?.configHash !== 'string' || !HEX_16.test(value.ledger.configHash)) {
    issues.push('capture.ledger.configHash must be a 16-character lowercase SHA-256 prefix');
  }
  if (value.ledger?.sourceFingerprint !== null
      && (typeof value.ledger?.sourceFingerprint !== 'string' || !HEX_16.test(value.ledger.sourceFingerprint))) {
    issues.push('capture.ledger.sourceFingerprint must be null or a 16-character lowercase SHA-256 prefix');
  }
  if (typeof value.ledger?.partial !== 'boolean') issues.push('capture.ledger.partial must be boolean');
  if (value.ledger?.partial === false && value.ledger?.sourceFingerprint === null) {
    issues.push('a full capture ledger must include sourceFingerprint');
  }
  if (timestampOrder(value.proof?.finishedAt, value.ledger?.generatedAt) > 0) {
    issues.push('capture.ledger.generatedAt must not predate App Proof completion');
  }

  exactKeys(value.case, [
    'id', 'url', 'route', 'state', 'theme', 'viewport', 'capturedAt', 'screenshot',
  ], 'capture.case', issues);
  if (typeof value.case?.id !== 'string' || !/^case_[a-f0-9]{24}$/.test(value.case.id)) {
    issues.push('capture.case.id must be a deterministic App Proof case id');
  }
  optionalUrl(value.case?.url, 'capture.case.url', issues);
  if (value.case?.url === null) issues.push('capture.case.url must be a non-null HTTP(S) URL');
  exactKeys(value.case?.route, ['name', 'path'], 'capture.case.route', issues);
  nonempty(value.case?.route?.name, 'capture.case.route.name', issues);
  if (typeof value.case?.route?.path !== 'string' || !value.case.route.path.startsWith('/')) {
    issues.push('capture.case.route.path must be an absolute URL route');
  }
  nonempty(value.case?.state, 'capture.case.state', issues);
  nonempty(value.case?.theme, 'capture.case.theme', issues);
  validateViewport(value.case?.viewport, 'capture.case.viewport', issues, { named: true });
  if (value.case?.id && value.case?.route?.name && value.case?.state
      && value.case?.viewport?.name && value.case?.theme
      && value.case.id !== appProofCaseId({
        route: value.case.route.name,
        state: value.case.state,
        viewport: value.case.viewport.name,
        theme: value.case.theme,
      })) {
    issues.push('capture.case.id does not match its route/state/viewport/theme matrix');
  }
  requiredTimestamp(value.case?.capturedAt, 'capture.case.capturedAt', issues);
  if (value.case?.capturedAt !== value.proof?.finishedAt) {
    issues.push('capture.case.capturedAt must equal the durable App Proof completion bound');
  }
  if (timestampOrder(value.ledger?.generatedAt, comparisonCreatedAt) > 0) {
    issues.push('comparison.createdAt must not predate its App Proof evidence ledger');
  }
  if (JSON.stringify(value.case?.viewport) !== JSON.stringify(comparisonViewport)) {
    issues.push('capture case viewport and comparison viewport must match exactly');
  }
  if (value.case?.viewport?.deviceScaleFactor !== 1) {
    issues.push('App Proof v2 capture attestation requires deviceScaleFactor 1');
  }
  if (reference && JSON.stringify({
    width: value.case?.viewport?.width,
    height: value.case?.viewport?.height,
    deviceScaleFactor: value.case?.viewport?.deviceScaleFactor,
  }) !== JSON.stringify(reference.viewport)) {
    issues.push('capture case viewport must match the registered reference viewport');
  }
  if (reference?.authorizedScope?.routes?.length
      && !scopeAllowsRoute(reference.authorizedScope, value.case?.route?.path)) {
    issues.push('capture case route is outside the reference authorized scope');
  }

  const shot = value.case?.screenshot;
  exactKeys(shot, ['path', 'sha256', 'bytes', 'width', 'height', 'fullPage'], 'capture.case.screenshot', issues);
  const shotPathIssue = validateProjectRelativePath(shot?.path, 'capture.case.screenshot.path');
  if (shotPathIssue) issues.push(shotPathIssue);
  if (value.case?.id && shot?.path !== `.dk/proof/screenshots/${value.case.id}.png`) {
    issues.push('capture.case.screenshot.path must be the deterministic App Proof case path');
  }
  digest(shot?.sha256, 'capture.case.screenshot.sha256', issues);
  integer(shot?.bytes, 'capture.case.screenshot.bytes', issues, 1, REFERENCE_LIMITS.maxBytesPerReference);
  integer(shot?.width, 'capture.case.screenshot.width', issues, 1, REFERENCE_LIMITS.maxImageDimension);
  integer(shot?.height, 'capture.case.screenshot.height', issues, 1, REFERENCE_LIMITS.maxImageDimension);
  if (shot?.fullPage !== true) issues.push('capture.case.screenshot.fullPage must be true');
  if (shot?.width !== value.case?.viewport?.width || shot?.height !== value.case?.viewport?.height) {
    issues.push('capture screenshot viewport metadata must match capture.case.viewport');
  }
  if (candidate?.format !== 'png' || candidate?.mediaType !== 'image/png'
      || candidate?.sha256 !== shot?.sha256 || candidate?.bytes !== shot?.bytes) {
    issues.push('attested candidate bytes must match the App Proof PNG screenshot');
  }
}

function validateImageEvidence(value, at, issues) {
  exactKeys(value, ['path', 'format', 'mediaType', 'bytes', 'width', 'height', 'sha256'], at, issues);
  const pathIssue = validateProjectRelativePath(value?.path, `${at}.path`);
  if (pathIssue) issues.push(pathIssue);
  oneOf(value?.format, REFERENCE_LIMITS.allowedFormats, `${at}.format`, issues);
  const media = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' }[value?.format];
  if (value?.mediaType !== media) issues.push(`${at}.mediaType must match format`);
  integer(value?.bytes, `${at}.bytes`, issues, 1, REFERENCE_LIMITS.maxBytesPerReference);
  integer(value?.width, `${at}.width`, issues, 1, REFERENCE_LIMITS.maxImageDimension);
  integer(value?.height, `${at}.height`, issues, 1, REFERENCE_LIMITS.maxImageDimension);
  digest(value?.sha256, `${at}.sha256`, issues);
}

function validateDimensionsMetric(value, issues) {
  exactKeys(value, ['match', 'reference', 'candidate', 'widthDeltaPx', 'heightDeltaPx', 'aspectRatioDelta'], 'metrics.dimensions', issues);
  if (typeof value?.match !== 'boolean') issues.push('metrics.dimensions.match must be boolean');
  for (const side of ['reference', 'candidate']) {
    exactKeys(value?.[side], ['width', 'height'], `metrics.dimensions.${side}`, issues);
    integer(value?.[side]?.width, `metrics.dimensions.${side}.width`, issues, 1, REFERENCE_LIMITS.maxImageDimension);
    integer(value?.[side]?.height, `metrics.dimensions.${side}.height`, issues, 1, REFERENCE_LIMITS.maxImageDimension);
  }
  integer(value?.widthDeltaPx, 'metrics.dimensions.widthDeltaPx', issues, 0, REFERENCE_LIMITS.maxImageDimension);
  integer(value?.heightDeltaPx, 'metrics.dimensions.heightDeltaPx', issues, 0, REFERENCE_LIMITS.maxImageDimension);
  number(value?.aspectRatioDelta, 'metrics.dimensions.aspectRatioDelta', issues, 0, Number.MAX_SAFE_INTEGER);
}

function validatePixelMetric(value, issues) {
  exactKeys(value, [
    'reference', 'candidate', 'meanAbsoluteChannelDelta', 'normalizedMeanDelta', 'changedPixelRatio', 'maxChannelDelta',
  ], 'metrics.pixelStats', issues);
  validateStats(value?.reference, 'metrics.pixelStats.reference', issues);
  validateStats(value?.candidate, 'metrics.pixelStats.candidate', issues);
  number(value?.meanAbsoluteChannelDelta, 'metrics.pixelStats.meanAbsoluteChannelDelta', issues, 0, 255);
  number(value?.normalizedMeanDelta, 'metrics.pixelStats.normalizedMeanDelta', issues, 0, 1);
  number(value?.changedPixelRatio, 'metrics.pixelStats.changedPixelRatio', issues, 0, 1);
  integer(value?.maxChannelDelta, 'metrics.pixelStats.maxChannelDelta', issues, 0, 255);
}

function validateStats(value, at, issues) {
  exactKeys(value, ['pixels', 'meanRgba', 'standardDeviationRgba'], at, issues);
  integer(value?.pixels, `${at}.pixels`, issues, 1, REFERENCE_LIMITS.maxImagePixels);
  numericArray(value?.meanRgba, `${at}.meanRgba`, issues, 4, 0, 255);
  numericArray(value?.standardDeviationRgba, `${at}.standardDeviationRgba`, issues, 4, 0, 255);
}

function validateRegionFinding(value, at, issues) {
  exactKeys(value, ['id', 'regionId', 'type', 'severity', 'score', 'summary', 'evidence'], at, issues);
  nonempty(value?.id, `${at}.id`, issues);
  if (value?.regionId !== null) nonempty(value?.regionId, `${at}.regionId`, issues);
  nonempty(value?.type, `${at}.type`, issues);
  oneOf(value?.severity, DELTA_SEVERITIES, `${at}.severity`, issues);
  number(value?.score, `${at}.score`, issues, 0, 1);
  nonempty(value?.summary, `${at}.summary`, issues);
  stringArray(value?.evidence, `${at}.evidence`, issues, { unique: true });
}

function validatePolicy(value, issues) {
  exactKeys(value, ['noWholeReferenceBackground'], 'policy', issues);
  const check = value?.noWholeReferenceBackground;
  exactKeys(check, ['status', 'scannedFiles', 'sourceDigests', 'findings'], 'policy.noWholeReferenceBackground', issues);
  oneOf(check?.status, ['pass', 'fail', 'not-scanned'], 'policy.noWholeReferenceBackground.status', issues);
  stringArray(check?.scannedFiles, 'policy.noWholeReferenceBackground.scannedFiles', issues, { unique: true });
  if (!Array.isArray(check?.sourceDigests)) issues.push('policy.noWholeReferenceBackground.sourceDigests must be an array');
  for (let i = 0; i < (check?.sourceDigests?.length ?? 0); i++) {
    const source = check.sourceDigests[i];
    const at = `policy.noWholeReferenceBackground.sourceDigests[${i}]`;
    exactKeys(source, ['path', 'sha256', 'bytes'], at, issues);
    const pathIssue = validateProjectRelativePath(source?.path, `${at}.path`);
    if (pathIssue) issues.push(pathIssue);
    digest(source?.sha256, `${at}.sha256`, issues);
    integer(source?.bytes, `${at}.bytes`, issues, 1, REFERENCE_LIMITS.maxImplementationFileBytes);
  }
  if (Array.isArray(check?.sourceDigests)
    && JSON.stringify(check.sourceDigests.map((source) => source.path)) !== JSON.stringify(check.scannedFiles)) {
    issues.push('policy sourceDigests paths must exactly match scannedFiles');
  }
  if (!Array.isArray(check?.findings)) issues.push('policy.noWholeReferenceBackground.findings must be an array');
  for (let i = 0; i < (check?.findings?.length ?? 0); i++) {
    const finding = check.findings[i];
    const at = `policy.noWholeReferenceBackground.findings[${i}]`;
    exactKeys(finding, ['file', 'line', 'ruleId', 'message', 'referenceId'], at, issues);
    const pathIssue = validateProjectRelativePath(finding?.file, `${at}.file`);
    if (pathIssue) issues.push(pathIssue);
    integer(finding?.line, `${at}.line`, issues, 1, Number.MAX_SAFE_INTEGER);
    nonempty(finding?.ruleId, `${at}.ruleId`, issues);
    nonempty(finding?.message, `${at}.message`, issues);
    nonempty(finding?.referenceId, `${at}.referenceId`, issues);
  }
  if (check?.status === 'pass' && (!check.scannedFiles?.length || check.findings?.length)) issues.push('a passing background policy requires scanned files and zero findings');
  if (check?.status === 'fail' && !check.findings?.length) issues.push('a failing background policy requires findings');
  if (check?.status === 'not-scanned' && (check.scannedFiles?.length || check.sourceDigests?.length || check.findings?.length)) {
    issues.push('not-scanned policy cannot claim scanned files, source digests, or findings');
  }
}

function validateDelta(value, at, issues) {
  exactKeys(value, ['id', 'type', 'severity', 'score', 'summary', 'source'], at, issues);
  nonempty(value?.id, `${at}.id`, issues);
  nonempty(value?.type, `${at}.type`, issues);
  oneOf(value?.severity, DELTA_SEVERITIES, `${at}.severity`, issues);
  number(value?.score, `${at}.score`, issues, 0, 1);
  nonempty(value?.summary, `${at}.summary`, issues);
  oneOf(value?.source, ['metric', 'region', 'policy', 'attestation'], `${at}.source`, issues);
}

function validateManifestBinding(artifact, manifest, issues) {
  if (manifest.kind !== REFERENCE_KINDS.manifest) issues.push('context.manifest has the wrong kind');
  if (manifest.projectRootSha256 !== artifact.projectRootSha256) issues.push('artifact is bound to a different project root');
  if (!findReference(manifest, artifact.referenceId)) issues.push(`referenceId is not registered: ${artifact.referenceId}`);
}

function validateArtifactReference(value, at, issues) {
  exactKeys(value, ['path', 'sha256'], at, issues);
  const pathIssue = validateProjectRelativePath(value?.path, `${at}.path`);
  if (pathIssue) issues.push(pathIssue);
  digest(value?.sha256, `${at}.sha256`, issues);
}

function validateAuthor(value, at, issues) {
  exactKeys(value, ['type', 'name', 'model'], at, issues);
  oneOf(value?.type, ['human', 'codex', 'tool'], `${at}.type`, issues);
  optionalString(value?.name, `${at}.name`, issues);
  optionalString(value?.model, `${at}.model`, issues);
}

function validateBounds(value, at, canvas, issues) {
  exactKeys(value, ['x', 'y', 'width', 'height', 'unit'], at, issues);
  number(value?.x, `${at}.x`, issues, 0, REFERENCE_LIMITS.maxImageDimension);
  number(value?.y, `${at}.y`, issues, 0, REFERENCE_LIMITS.maxImageDimension);
  number(value?.width, `${at}.width`, issues, Number.MIN_VALUE, REFERENCE_LIMITS.maxImageDimension);
  number(value?.height, `${at}.height`, issues, Number.MIN_VALUE, REFERENCE_LIMITS.maxImageDimension);
  if (value?.unit !== 'px') issues.push(`${at}.unit must be px`);
  if (numberValue(value?.x) && numberValue(value?.width) && numberValue(canvas?.width) && value.x + value.width > canvas.width) issues.push(`${at} exceeds canvas width`);
  if (numberValue(value?.y) && numberValue(value?.height) && numberValue(canvas?.height) && value.y + value.height > canvas.height) issues.push(`${at} exceeds canvas height`);
}

function validateViewport(value, at, issues, { named }) {
  exactKeys(value, named ? ['name', 'width', 'height', 'deviceScaleFactor'] : ['width', 'height', 'deviceScaleFactor'], at, issues);
  if (named) nonempty(value?.name, `${at}.name`, issues);
  integer(value?.width, `${at}.width`, issues, 1, REFERENCE_LIMITS.maxImageDimension);
  integer(value?.height, `${at}.height`, issues, 1, REFERENCE_LIMITS.maxImageDimension);
  number(value?.deviceScaleFactor, `${at}.deviceScaleFactor`, issues, 0.1, 8);
}

function findReference(manifest, id) {
  return manifest?.references?.find((entry) => entry.id === id) ?? null;
}

function requireOperation(reference, operation, issues) {
  if (!reference) return;
  if (reference.licence?.status === 'unknown' && operation !== 'decompose') {
    issues.push(`reference licence is unknown; ${operation} is not authorized`);
    return;
  }
  if (!reference.authorizedScope.operations.includes(operation)) issues.push(`reference is not authorized for operation: ${operation}`);
}

function exactKeys(value, allowed, at, issues) {
  if (!record(value)) { issues.push(`${at} must be an object`); return; }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) issues.push(`${at}.${key} is not supported`);
  for (const key of allowed) if (!(key in value)) issues.push(`${at}.${key} is required`);
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonempty(value, at, issues) {
  if (typeof value !== 'string' || !value.trim()) issues.push(`${at} must be a non-empty string`);
}

function optionalString(value, at, issues) {
  if (value !== null && (typeof value !== 'string' || !value.trim())) issues.push(`${at} must be null or a non-empty string`);
}

function optionalTimestamp(value, at, issues) {
  if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) issues.push(`${at} must be null or an ISO timestamp`);
}

function requiredTimestamp(value, at, issues) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) issues.push(`${at} must be an ISO timestamp`);
}

function timestampOrder(left, right) {
  const leftTime = Date.parse(left ?? '');
  const rightTime = Date.parse(right ?? '');
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) ? leftTime - rightTime : 0;
}

function optionalUrl(value, at, issues) {
  if (value === null) return;
  if (typeof value !== 'string') { issues.push(`${at} must be null or an http(s) URL`); return; }
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('unsafe URL');
  } catch { issues.push(`${at} must be null or an http(s) URL without credentials`); }
}

function stringArray(value, at, issues, options = {}) {
  if (!Array.isArray(value)) { issues.push(`${at} must be an array`); return; }
  if (options.nonempty && value.length === 0) issues.push(`${at} must not be empty`);
  const seen = new Set();
  for (let index = 0; index < value.length; index++) {
    nonempty(value[index], `${at}[${index}]`, issues);
    if (options.unique && seen.has(value[index])) issues.push(`${at}[${index}] duplicates another value`);
    seen.add(value[index]);
  }
}

function numericArray(value, at, issues, length, min, max) {
  if (!Array.isArray(value) || value.length !== length) { issues.push(`${at} must contain exactly ${length} numbers`); return; }
  value.forEach((entry, index) => number(entry, `${at}[${index}]`, issues, min, max));
}

function oneOf(value, choices, at, issues) {
  if (!choices.includes(value)) issues.push(`${at} must be one of: ${choices.join(', ')}`);
}

function integer(value, at, issues, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) issues.push(`${at} must be an integer from ${min} to ${max}`);
}

function number(value, at, issues, min, max) {
  if (!numberValue(value) || value < min || value > max) issues.push(`${at} must be a finite number from ${min} to ${max}`);
}

function numberValue(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function digest(value, at, issues) {
  if (typeof value !== 'string' || !HEX_256.test(value)) issues.push(`${at} must be a lowercase SHA-256 digest`);
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export const validationInternals = Object.freeze({ SAFE_ID, HEX_256, SEVERITY });
