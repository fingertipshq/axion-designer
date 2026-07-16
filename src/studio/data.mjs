/* ============================================================
   Axion Studio data model.

   Reads existing Axion artifacts without mutating the project or re-running
   verification. All returned structures are JSON-serializable and safe for a
   local HTTP API consumer.
   ============================================================ */
import {
  existsSync,
  readdirSync,
  realpathSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  extname,
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from 'node:path';
import { loadConfig } from '../core/config.mjs';
import { hashDirection, hashDirectionBindings } from '../core/direction.mjs';
import { buildManifest, loadTokens, resolve as resolveToken } from '../core/tokens.mjs';
import { defaultApprovalHistoryPath, readApprovalHistory } from '../core/approvals.mjs';
import { indexRepository } from '../system/indexer.mjs';
import { auditBridge } from '../bridge/orchestrator.mjs';
import { MAX_BRIDGE_LEDGER_BYTES } from '../bridge/runtime.mjs';
import { REFERENCE_KINDS, REFERENCE_LIMITS, createReferenceSystem } from '../reference/index.mjs';
import { inspectImage } from '../reference/image.mjs';
import { readRegularFileInside } from '../reference/safety.mjs';

export const STUDIO_SNAPSHOT_SCHEMA = 'dk-studio-snapshot/v1';

/**
 * Collect the current direction, Taste Lock, ledger, proof, graph and Git state.
 * @param {string} root
 * @param {{graph?:object,now?:string|Date}} options
 */
export async function collectStudioSnapshot(root = process.cwd(), options = {}) {
  const cwd = resolvePath(root);
  const errors = [];
  let config;
  let configFailures = [];
  try {
    config = await loadConfig(cwd);
    configFailures = fatalConfigIssues(config.errors);
  }
  catch (error) {
    configFailures = [{
      source: 'config', status: 'config-error', code: 'config-error',
      path: 'dk.config', message: error.message,
    }];
    config = fallbackConfig(cwd);
  }
  errors.push(...configFailures);

  const graph = options.graph ?? indexRepository(cwd, { now: options.now, tokensPath: config.tokensPath });
  const directionDoc = readJson(config.directionPath, errors, 'direction');
  const directionLock = readJson(config.directionLockPath, errors, 'direction-lock');
  const approvalPath = defaultApprovalHistoryPath(config.directionLockPath);
  const approvalHistory = summarizeApprovalHistory(
    readApprovalHistory(approvalPath),
    directionLock,
    cwd,
    approvalPath,
  );
  const tokenState = readTokenState(config.tokensPath, errors);
  const direction = summarizeDirection(directionDoc, directionLock, tokenState.tokens, config, approvalHistory);
  const reportPath = findBestReport(cwd);
  const report = reportPath ? readJson(reportPath, errors, 'ledger') : null;
  const ledger = summarizeLedger(report, reportPath, cwd);
  const git = collectGitSummary(cwd);
  const previews = discoverPreviews(graph);
  const bridge = configFailures.length
    ? bridgeConfigErrorState(config, configFailures)
    : readBridgeState(cwd, config, errors, options.now);
  const reference = await collectStudioReferenceState(cwd);
  if (reference.status === 'invalid' && reference.issues?.length) {
    errors.push({ source: 'reference', message: reference.issues[0].message });
  }

  return {
    schema: STUDIO_SNAPSHOT_SCHEMA,
    generatedAt: normalizeNow(options.now),
    project: {
      name: cwd.split(sep).at(-1),
      root: cwd,
      preset: config.presetName ?? 'recommended',
      configFile: config.configFile ?? null,
    },
    direction,
    approvals: approvalHistory,
    tokens: {
      available: !!tokenState.tokens,
      path: relativePath(cwd, config.tokensPath),
      hash: tokenState.manifest?.tokenHash ?? ledger.tokenHash ?? null,
      count: tokenState.manifest?.count ?? graph.stats?.kinds?.token ?? 0,
      darkCount: tokenState.manifest?.darkCount ?? 0,
    },
    ledger,
    proof: graph.proof,
    graph: {
      schema: graph.schema,
      stats: graph.stats,
      warningCount: graph.warnings?.length ?? 0,
    },
    git,
    bridge,
    reference,
    previews,
    errors,
  };
}

const STUDIO_REFERENCE_SCHEMA = 'dk-studio-reference/v1';
const REFERENCE_MANIFEST_PATH = '.dk/reference/reference-manifest.json';
const REFERENCE_ASSET_PATTERN = /^\.dk\/reference\/assets\/([a-f0-9]{64})\.(png|jpe?g|webp)$/i;
const REFERENCE_COMPARISON_FILE = /^reference-comparison\.([a-zA-Z0-9][a-zA-Z0-9._-]{0,127})\.json$/;

/**
 * Build the read-only Studio surface for Reference artifacts. An absent
 * manifest is a normal empty state. Once artifacts exist they must pass the
 * Reference engine validator, fixed-root binding, digest links, and asset
 * checks before Studio exposes even an opaque image URL.
 */
export async function collectStudioReferenceState(root = process.cwd()) {
  return (await buildStudioReferenceState(root)).surface;
}

/** Resolve an opaque Studio asset token back to validated image bytes. */
export async function resolveStudioReferenceAsset(root, token) {
  if (!/^[a-f0-9]{64}$/i.test(String(token ?? ''))) {
    throw new Error('Denied malformed Reference asset token.');
  }
  const { authorized } = await buildStudioReferenceState(root);
  const asset = authorized.find((entry) => entry.token === token);
  if (!asset) throw new Error('Reference asset is not authorized by current validated artifacts.');
  return {
    bytes: asset.bytes,
    mediaType: asset.mediaType,
    sha256: asset.sha256,
    byteLength: asset.bytes.length,
  };
}

async function buildStudioReferenceState(projectRoot) {
  const root = realpathSync(resolvePath(projectRoot));
  const referenceSystem = createReferenceSystem(root);
  const absent = {
    schema: STUDIO_REFERENCE_SCHEMA,
    available: false,
    status: 'absent',
    items: [],
    issues: [],
  };
  if (!existsSync(join(root, REFERENCE_MANIFEST_PATH))) return { surface: absent, authorized: [] };

  const issues = [];
  const authorized = [];
  let manifestFile;
  let manifest;
  try {
    manifestFile = await readValidatedReferenceArtifact(root, REFERENCE_MANIFEST_PATH, REFERENCE_KINDS.manifest);
    manifest = manifestFile.artifact;
  } catch (error) {
    issues.push(referenceIssue(error, root, 'manifest-invalid'));
    return {
      surface: { ...absent, status: 'invalid', issues },
      authorized,
    };
  }

  const references = Array.isArray(manifest.references) ? manifest.references.slice(0, REFERENCE_LIMITS.maxReferences) : [];
  if (!references.length) {
    issues.push({ code: 'manifest-empty', message: 'The validated Reference manifest contains no registered references.' });
    return {
      surface: { ...absent, available: true, status: 'invalid', manifestDigest: manifestFile.sha256, issues },
      authorized,
    };
  }

  const comparisons = new Map();
  const invalidComparisonIds = new Set();
  let comparisonNames = [];
  try {
    const artifactDirectory = dirname(manifestFile.absolute);
    comparisonNames = readdirSync(artifactDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && REFERENCE_COMPARISON_FILE.test(entry.name))
      .map((entry) => entry.name)
      .sort()
      .slice(0, REFERENCE_LIMITS.maxReferences);
  } catch (error) {
    issues.push(referenceIssue(error, root, 'comparison-directory'));
  }
  for (const name of comparisonNames) {
    const idFromName = name.match(REFERENCE_COMPARISON_FILE)?.[1];
    const path = `.dk/reference/${name}`;
    try {
      const engineFile = referenceSystem.readArtifact(path);
      const file = { ...engineFile, absolute: join(root, engineFile.path) };
      const comparison = file.artifact;
      if (comparison.referenceId !== idFromName) throw new Error('Comparison filename and referenceId do not match.');
      const manifestLink = comparison.manifest;
      if (manifestLink?.path !== REFERENCE_MANIFEST_PATH || String(manifestLink?.sha256 ?? '').toLowerCase() !== manifestFile.sha256) {
        throw new Error('Comparison is not digest-bound to the current Reference manifest.');
      }
      comparisons.set(comparison.referenceId, { ...file, artifact: comparison });
    } catch (error) {
      if (idFromName) invalidComparisonIds.add(idFromName);
      issues.push(referenceIssue(error, root, 'comparison-invalid', idFromName));
    }
  }

  const items = [];
  const seenIds = new Set();
  for (const reference of references) {
    const id = boundedString(reference?.id ?? reference?.referenceId, 128);
    if (!id || seenIds.has(id)) {
      issues.push({ code: 'reference-id', message: 'A registered reference has a missing or duplicate ID.' });
      continue;
    }
    seenIds.add(id);
    const itemIssueStart = issues.length;
    const comparisonFile = comparisons.get(id) ?? null;
    const comparison = comparisonFile?.artifact ?? null;
    let decomposition = null;
    const decompositionPath = `.dk/reference/visual-decomposition.${id}.json`;
    if (existsSync(join(root, decompositionPath))) {
      try {
        const decompositionFile = await readValidatedReferenceArtifact(root, decompositionPath, REFERENCE_KINDS.decomposition, { manifest });
        if (decompositionFile.artifact.referenceId !== id) throw new Error('Decomposition filename and referenceId do not match.');
        const manifestLink = decompositionFile.artifact.manifest;
        if (manifestLink?.path !== REFERENCE_MANIFEST_PATH || String(manifestLink?.sha256 ?? '').toLowerCase() !== manifestFile.sha256) {
          throw new Error('Decomposition is not digest-bound to the current Reference manifest.');
        }
        decomposition = decompositionFile.artifact;
      } catch (error) {
        issues.push(referenceIssue(error, root, 'decomposition-invalid', id));
      }
    }
    let referenceAsset = null;
    let renderAsset = null;
    try {
      const privateAsset = validatedStudioAsset(root, id, 'reference', referenceAssetInput(reference));
      authorized.push(privateAsset);
      referenceAsset = publicStudioAsset(privateAsset);
    } catch (error) {
      issues.push(referenceIssue(error, root, 'reference-asset-invalid', id));
    }
    if (comparison) {
      try {
        if (!referenceAsset) throw new Error('Render image cannot be authorized while its registered reference is invalid.');
        const declaredReference = referenceAssetInput(comparison.reference ?? comparison.source ?? null);
        if (declaredReference?.sha256 && referenceAsset?.sha256
          && declaredReference.sha256.toLowerCase() !== referenceAsset.sha256.toLowerCase()) {
          throw new Error('Comparison reference digest does not match the registered reference.');
        }
        const privateAsset = validatedStudioAsset(root, id, 'render', renderAssetInput(comparison));
        authorized.push(privateAsset);
        renderAsset = publicStudioAsset(privateAsset);
      } catch (error) {
        issues.push(referenceIssue(error, root, 'render-asset-invalid', id));
      }
    }
    const generated = comparison?.generated && typeof comparison.generated === 'object' ? comparison.generated : {};
    const policy = comparison?.policy && typeof comparison.policy === 'object' ? comparison.policy : {};
    const capture = normalizeCaptureAttestation(comparison?.capture, root);
    const paired = !!referenceAsset && !!renderAsset;
    const itemInvalid = invalidComparisonIds.has(id) || issues.length > itemIssueStart;
    items.push({
      id,
      label: boundedString(reference?.label ?? reference?.name ?? id, 160),
      status: itemInvalid ? 'invalid' : !comparison ? 'incomplete' : paired ? studioComparisonStatus(comparison, capture) : 'invalid',
      createdAt: boundedString(comparison?.createdAt ?? reference?.createdAt ?? manifest.createdAt, 64) || null,
      viewport: normalizeViewport(comparison?.viewport ?? generated.viewport ?? reference?.viewport),
      provenance: normalizeProvenance(reference),
      authorizedScope: normalizeAuthorizedScope(reference?.authorizedScope),
      digest: comparisonFile?.sha256 ?? null,
      exactMatch: normalizeBoolean(generated.exactMatch ?? comparison?.exactMatch ?? comparison?.metrics?.exactHashMatch ?? comparison?.metrics?.exactMatch),
      metrics: normalizeComparisonMetrics(comparison?.metrics ?? generated.metrics),
      dimensions: normalizeDimensions(comparison?.metrics?.dimensions ?? generated.dimensions ?? comparison?.dimensions),
      capture,
      highestDeltas: normalizeDeltas(generated.highestDeltas ?? comparison?.highestDeltas ?? comparison?.deltas, root),
      regions: normalizeRegions(
        generated.regions ?? generated.regionFindings ?? comparison?.regions ?? comparison?.regionFindings,
        decomposition?.regions,
      ),
      policy: normalizeScalarObject(policy),
      referenceAsset,
      renderAsset,
    });
  }

  const pairedCount = items.filter((item) => item.referenceAsset && item.renderAsset).length;
  const status = issues.length ? 'invalid' : pairedCount === items.length ? 'ready' : 'incomplete';
  const invalidReferenceIds = new Set(items.filter((item) => item.status === 'invalid').map((item) => item.id));
  return {
    surface: {
      schema: STUDIO_REFERENCE_SCHEMA,
      available: items.length > 0,
      status,
      manifestDigest: manifestFile.sha256,
      itemCount: items.length,
      pairedCount,
      items,
      issues: issues.slice(0, 24),
    },
    authorized: authorized.filter((asset) => !invalidReferenceIds.has(asset.referenceId)),
  };
}

async function readValidatedReferenceArtifact(root, projectPath, expectedKind, context = {}) {
  const file = readRegularFileInside(root, projectPath, {
    label: 'Reference artifact',
    maxBytes: REFERENCE_LIMITS.maxArtifactBytes,
  });
  let artifact;
  try { artifact = JSON.parse(file.bytes.toString('utf8')); }
  catch { throw new Error('Reference artifact is not valid JSON.'); }
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact) || artifact.kind !== expectedKind) {
    throw new Error(`Reference artifact must have kind ${expectedKind}.`);
  }
  let module;
  try { module = await import('../reference/index.mjs'); }
  catch { module = await import('../reference/validate.mjs'); }
  if (typeof module.assertValidReferenceArtifact !== 'function') {
    throw new Error('Reference artifact validator is unavailable.');
  }
  module.assertValidReferenceArtifact(artifact, context);
  const rootDigest = createHash('sha256').update(root).digest('hex');
  if (artifact.projectRootSha256 !== rootDigest) {
    throw new Error('Reference artifact is bound to a different project root.');
  }
  return {
    artifact,
    absolute: file.absolute,
    relative: file.relative,
    sha256: createHash('sha256').update(file.bytes).digest('hex'),
  };
}

function validatedStudioAsset(root, referenceId, role, input) {
  const descriptor = normalizeAssetInput(input);
  if (!descriptor.path || !descriptor.sha256) throw new Error(`${role} image descriptor is incomplete.`);
  const match = descriptor.path.match(REFERENCE_ASSET_PATTERN);
  if (!match || match[1].toLowerCase() !== descriptor.sha256.toLowerCase()) {
    throw new Error(`${role} image must use the digest-addressed Reference asset directory.`);
  }
  const file = readRegularFileInside(root, descriptor.path, {
    label: `${role} image`,
    maxBytes: REFERENCE_LIMITS.maxBytesPerReference,
  });
  const metadata = inspectImage(file.bytes, extname(file.absolute));
  if (metadata.sha256 !== descriptor.sha256.toLowerCase()) throw new Error(`${role} image digest does not match its artifact.`);
  if (descriptor.bytes != null && Number(descriptor.bytes) !== file.bytes.length) throw new Error(`${role} image byte count does not match its artifact.`);
  const token = createHash('sha256').update(`${referenceId}\0${role}\0${file.relative}\0${metadata.sha256}`).digest('hex');
  return {
    token,
    role,
    referenceId,
    path: file.relative,
    bytes: file.bytes,
    sha256: metadata.sha256,
    width: metadata.width,
    height: metadata.height,
    mediaType: metadata.mediaType,
  };
}

function publicStudioAsset(asset) {
  return {
    id: asset.token,
    url: `/api/reference-asset/${asset.token}`,
    sha256: asset.sha256,
    bytes: asset.bytes.length,
    width: asset.width,
    height: asset.height,
    mediaType: asset.mediaType,
  };
}

function referenceAssetInput(value) {
  if (!value || typeof value !== 'object') return null;
  return value.asset ?? value.image ?? value.file ?? value;
}

function renderAssetInput(comparison) {
  if (!comparison || typeof comparison !== 'object') return null;
  const generated = comparison.generated && typeof comparison.generated === 'object' ? comparison.generated : {};
  return generated.render ?? generated.image ?? generated.asset
    ?? comparison.render ?? comparison.rendered ?? comparison.candidate ?? null;
}

function normalizeAssetInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { path: null, sha256: null, bytes: null };
  const nested = value.asset && typeof value.asset === 'object' ? value.asset : value;
  return {
    path: boundedString(nested.path ?? nested.storedPath ?? nested.file ?? nested.assetPath, 512),
    sha256: boundedString(nested.sha256 ?? nested.digest, 64).toLowerCase(),
    bytes: nested.bytes ?? nested.byteLength ?? null,
  };
}

function normalizeViewport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const width = Number(value.width);
  const height = Number(value.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return {
    name: boundedString(value.name ?? value.label, 80) || null,
    width: Math.min(REFERENCE_LIMITS.maxImageDimension, Math.round(width)),
    height: Math.min(REFERENCE_LIMITS.maxImageDimension, Math.round(height)),
    ...(Number.isFinite(Number(value.deviceScaleFactor)) ? { deviceScaleFactor: Math.max(0.1, Math.min(8, Number(value.deviceScaleFactor))) } : {}),
  };
}

function normalizeProvenance(reference) {
  const provenance = reference?.provenance && typeof reference.provenance === 'object' ? reference.provenance : {};
  const licence = reference?.licence && typeof reference.licence === 'object'
    ? reference.licence : reference?.license && typeof reference.license === 'object' ? reference.license : {};
  const scope = reference?.authorizedScope && typeof reference.authorizedScope === 'object' ? reference.authorizedScope : {};
  return {
    source: boundedString(provenance.source ?? provenance.type ?? reference?.source, 240) || null,
    url: boundedString(provenance.url ?? provenance.sourceUrl, 500) || null,
    label: boundedString(provenance.label ?? provenance.title, 160) || null,
    creator: boundedString(provenance.creator ?? provenance.author, 160) || null,
    license: boundedString(licence.status ?? licence.name ?? reference?.licenceStatus ?? reference?.licenseStatus, 120) || null,
    authorizedUse: boundedString(scope.summary ?? scope.purpose ?? reference?.authorizedUse, 240)
      || (Array.isArray(scope.operations) ? scope.operations.slice(0, 8).map((item) => boundedString(item, 50)).filter(Boolean).join(', ') : null),
  };
}

function normalizeAuthorizedScope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { projectPaths: [], routes: [], operations: [] };
  const strings = (input, limit, length) => Array.isArray(input)
    ? input.slice(0, limit).map((item) => boundedString(item, length)).filter(Boolean) : [];
  return {
    projectPaths: strings(value.projectPaths, 40, 300),
    routes: strings(value.routes, 40, 200),
    operations: strings(value.operations, 12, 50),
  };
}

function normalizeCaptureAttestation(value, root) {
  const unattested = (reason) => ({
    status: 'unattested',
    reason: sanitizeArtifactText(reason || 'No browser capture attestation is available.', root, 800),
    proof: null,
    ledger: null,
    case: null,
  });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unattested();
  if (value.status !== 'attested') return unattested(value.reason || 'Browser capture is not attested.');

  const proofSha256 = safeDigest(value.proof?.sha256);
  const ledgerSha256 = safeDigest(value.ledger?.sha256);
  const screenshotSha256 = safeDigest(value.case?.screenshot?.sha256);
  const routePath = safeRoutePath(value.case?.route?.path);
  const routeName = safeOneLine(value.case?.route?.name, 120);
  const state = safeOneLine(value.case?.state, 120);
  const theme = safeOneLine(value.case?.theme, 120);
  const capturedAt = safeTimestamp(value.case?.capturedAt);
  const viewport = normalizeViewport(value.case?.viewport);
  if (!proofSha256 || !ledgerSha256 || !screenshotSha256 || !routePath || !routeName
      || !state || !theme || !capturedAt || !viewport) {
    return unattested('Browser capture attestation became incomplete during Studio normalization.');
  }
  return {
    status: 'attested',
    reason: null,
    proof: {
      sha256: proofSha256,
      configHash: safeDigest(value.proof?.configHash),
      startedAt: safeTimestamp(value.proof?.startedAt),
      finishedAt: safeTimestamp(value.proof?.finishedAt),
    },
    ledger: {
      sha256: ledgerSha256,
      generatedAt: safeTimestamp(value.ledger?.generatedAt),
      runtimeVersion: safeOneLine(value.ledger?.runtimeVersion, 80),
      configHash: safeHexPrefix(value.ledger?.configHash),
      sourceFingerprint: value.ledger?.sourceFingerprint == null ? null : safeHexPrefix(value.ledger.sourceFingerprint),
      partial: value.ledger?.partial === true,
    },
    case: {
      id: safeOneLine(value.case?.id, 80),
      route: { name: routeName, path: routePath },
      state,
      theme,
      viewport,
      capturedAt,
      screenshot: {
        sha256: screenshotSha256,
        bytes: Number.isInteger(value.case?.screenshot?.bytes) ? value.case.screenshot.bytes : null,
        width: Number.isInteger(value.case?.screenshot?.width) ? value.case.screenshot.width : null,
        height: Number.isInteger(value.case?.screenshot?.height) ? value.case.screenshot.height : null,
        fullPage: value.case?.screenshot?.fullPage === true,
      },
    },
  };
}

function normalizeDeltas(value, root) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 12).flatMap((delta, index) => {
    if (!delta || typeof delta !== 'object' || Array.isArray(delta)) return [];
    return [{
      id: boundedString(delta.id, 100) || `delta-${index + 1}`,
      dimension: boundedString(delta.dimension ?? delta.kind ?? delta.name ?? delta.type, 100) || 'visual',
      score: finiteOrNull(delta.score ?? delta.value ?? delta.delta ?? delta.magnitude),
      severity: boundedString(delta.severity, 20) || null,
      summary: sanitizeArtifactText(delta.summary ?? delta.message ?? delta.reason ?? delta.recommendation, root, 500) || null,
    }];
  });
}

function normalizeRegions(value, decompositionRegions = []) {
  const authored = Array.isArray(decompositionRegions) ? decompositionRegions.slice(0, 50) : [];
  const authoredById = new Map(authored.map((region) => [region?.id, region]));
  const findings = Array.isArray(value) ? value : [];
  const normalized = findings.slice(0, 50).flatMap((region, index) => {
    if (!region || typeof region !== 'object' || Array.isArray(region)) return [];
    const authoredRegion = authoredById.get(region.regionId ?? region.id) ?? null;
    const sourceBounds = region.bounds ?? region.rect ?? region.box ?? authoredRegion?.bounds;
    const bounds = sourceBounds && typeof sourceBounds === 'object' ? Object.fromEntries(
      ['x', 'y', 'width', 'height'].map((key) => [key, finiteOrNull(sourceBounds[key])]),
    ) : null;
    return [{
      id: boundedString(region.id, 100) || `region-${index + 1}`,
      label: boundedString(authoredRegion?.label ?? region.label ?? region.name ?? region.role ?? region.type, 120) || `Region ${index + 1}`,
      severity: boundedString(region.severity, 20) || 'info',
      summary: boundedString(region.summary ?? region.message ?? region.reason ?? region.recommendation ?? authoredRegion?.description, 500) || null,
      ...(bounds && Object.values(bounds).every((item) => item != null) ? { bounds } : {}),
    }];
  });
  const coveredIds = new Set(findings.map((region) => region?.regionId ?? region?.id).filter(Boolean));
  for (const region of authored) {
    if (!region?.id || coveredIds.has(region.id) || normalized.length >= 50) continue;
    const sourceBounds = region.bounds;
    const bounds = sourceBounds && typeof sourceBounds === 'object' ? Object.fromEntries(
      ['x', 'y', 'width', 'height'].map((key) => [key, finiteOrNull(sourceBounds[key])]),
    ) : null;
    normalized.push({
      id: boundedString(region.id, 100),
      label: boundedString(region.label ?? region.role, 120) || region.id,
      severity: 'info',
      summary: boundedString(region.description, 500) || 'Authored visual region.',
      ...(bounds && Object.values(bounds).every((item) => item != null) ? { bounds } : {}),
    });
  }
  return normalized;
}

function normalizeScalarObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const output = {};
  for (const [key, item] of Object.entries(value).slice(0, 24)) {
    const safeKey = boundedString(key, 80);
    if (!safeKey || !['string', 'number', 'boolean'].includes(typeof item)) continue;
    output[safeKey] = typeof item === 'string' ? boundedString(item, 240) : item;
  }
  return output;
}

function normalizeComparisonMetrics(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalizedMeanDelta = finiteOrNull(value.pixelStats?.normalizedMeanDelta);
  return {
    ...(typeof value.exactHashMatch === 'boolean' ? { exactHashMatch: value.exactHashMatch } : {}),
    ...(typeof value.dimensions?.match === 'boolean' ? { dimensionMatch: value.dimensions.match } : {}),
    ...(normalizedMeanDelta != null ? {
      normalizedMeanDelta,
      pixelSimilarity: Math.max(0, Math.min(1, 1 - normalizedMeanDelta)),
    } : {}),
    ...(finiteOrNull(value.pixelStats?.meanAbsoluteChannelDelta) != null
      ? { meanAbsoluteChannelDelta: finiteOrNull(value.pixelStats.meanAbsoluteChannelDelta) } : {}),
    ...(finiteOrNull(value.pixelStats?.changedPixelRatio) != null
      ? { changedPixelRatio: finiteOrNull(value.pixelStats.changedPixelRatio) } : {}),
    ...(finiteOrNull(value.pixelStats?.maxChannelDelta) != null
      ? { maxChannelDelta: finiteOrNull(value.pixelStats.maxChannelDelta) } : {}),
  };
}

function normalizeDimensions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return {
    ...(typeof value.match === 'boolean' ? { match: value.match } : {}),
    ...(finiteOrNull(value.widthDeltaPx) != null ? { widthDeltaPx: finiteOrNull(value.widthDeltaPx) } : {}),
    ...(finiteOrNull(value.heightDeltaPx) != null ? { heightDeltaPx: finiteOrNull(value.heightDeltaPx) } : {}),
    ...(finiteOrNull(value.aspectRatioDelta) != null ? { aspectRatioDelta: finiteOrNull(value.aspectRatioDelta) } : {}),
  };
}

function comparisonStatus(comparison) {
  const candidate = comparison.policy?.status ?? comparison.generated?.status ?? comparison.status;
  if (typeof candidate === 'string' && candidate.length <= 40) return candidate;
  return normalizeBoolean(comparison.generated?.exactMatch ?? comparison.exactMatch) === true ? 'matched' : 'ready';
}

function studioComparisonStatus(comparison, capture) {
  const status = comparisonStatus(comparison);
  if (capture?.status !== 'attested' && ['match', 'matched', 'complete', 'completed', 'pass', 'passed', 'ready'].includes(status)) {
    return 'review';
  }
  return status;
}

function sanitizeArtifactText(value, root, limit) {
  let text = typeof value === 'string' ? value : '';
  const aliases = [root, root?.startsWith('/private/') ? root.slice('/private'.length) : null]
    .filter(Boolean).sort((a, b) => b.length - a.length);
  for (const alias of aliases) text = text.split(alias).join('<project>');
  text = text
    .replace(/<(?:project|project-root)>(?:\/[^\s'"),;:]+)+/g, '<project-file>')
    .replace(/<project-root>/g, '<project>')
    .replace(/(?:\/(?:private\/)?var|\/Users|\/home|\/tmp|\/etc)(?:\/[^\s'"),;:]+)+/g, '<redacted-path>')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.slice(0, limit);
}

function safeOneLine(value, limit) {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, limit)
    : '';
}
function safeTimestamp(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value.slice(0, 64) : null; }
function safeDigest(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : null; }
function safeHexPrefix(value) { return typeof value === 'string' && /^[a-f0-9]{16}$/.test(value) ? value : null; }
function safeRoutePath(value) {
  const route = safeOneLine(value, 240);
  return route.startsWith('/') && !route.startsWith('//') && !route.includes('://') ? route : null;
}

function normalizeBoolean(value) { return typeof value === 'boolean' ? value : null; }
function finiteOrNull(value) { const numeric = Number(value); return Number.isFinite(numeric) ? Math.max(-1_000_000, Math.min(1_000_000, numeric)) : null; }
function boundedString(value, limit) { return typeof value === 'string' ? value.slice(0, limit) : ''; }
function referenceIssue(error, root, code, referenceId = null) {
  const raw = String(error?.message ?? error ?? 'Reference evidence could not be read.');
  const message = raw.split(root).join('<project>').replace(/[\r\n\t]+/g, ' ').slice(0, 500);
  return { code: boundedString(error?.code, 80) || code, message, ...(referenceId ? { referenceId } : {}) };
}

function fatalConfigIssues(findings = []) {
  return findings
    .filter((finding) => finding?.meta?.configFatal === true)
    .map((finding) => ({
      source: 'config', status: 'config-error', code: 'config-error',
      path: finding.meta?.configPath ?? finding.file ?? 'dk.config',
      message: String(finding.message ?? 'Invalid project configuration.'),
      ...(finding.fix ? { fix: String(finding.fix) } : {}),
    }));
}

function bridgeConfigErrorState(config, failures) {
  const connections = (config.bridge?.connections ?? []).map((connection) => ({
    id: connection.id,
    adapter: connection.adapter,
    role: connection.role ?? 'source',
    enabled: connection.enabled !== false,
    required: connection.required === true,
    requestedTrust: connection.trust ?? 'linked',
    permissions: [...(connection.permissions ?? [])],
    status: 'config-error',
    trust: connection.trust ?? 'linked',
    generatedAt: null,
    expiresAt: null,
    provider: connection.adapter ?? null,
    capability: null,
    commit: null,
    artifactCount: 0,
    findingCount: 0,
    durationMs: null,
    error: 'Bridge configuration is invalid.',
    digest: null,
    envelopeId: null,
    operations: {},
    issues: failures.map((failure) => ({
      severity: 'error', code: 'config-error', path: failure.path,
      message: failure.message,
    })),
  }));
  const issues = failures.map((failure) => ({
    severity: 'error', connection: null, code: 'config-error',
    path: failure.path, message: failure.message,
  }));
  return {
    schema: 'axion-bridge-studio/v1',
    status: 'config-error',
    reason: 'config-error',
    enabled: config.bridge?.enabled === true || config.gates?.bridge?.enabled === true,
    available: false,
    path: null,
    generatedAt: null,
    repository: null,
    connections,
    summary: {
      total: connections.length,
      healthy: 0,
      failed: connections.length,
      incomplete: 0,
      requiredFailed: connections.filter((connection) => connection.required).length,
    },
    issues,
    ledger: null,
    error: `Bridge configuration is invalid (${failures.length} fatal issue${failures.length === 1 ? '' : 's'}).`,
  };
}

function readBridgeState(root, config, errors, now) {
  const configured = (config.bridge?.connections ?? []).map((connection) => ({
    id: connection.id,
    adapter: connection.adapter,
    role: connection.role ?? 'source',
    enabled: connection.enabled !== false,
    required: connection.required === true,
    requestedTrust: connection.trust ?? 'linked',
    permissions: [...(connection.permissions ?? [])],
  }));
  const artifactDir = config.bridge?.artifactDir ?? resolvePath(root, '.dk/bridge');
  let ledgerPath;
  try { ledgerPath = resolveInside(root, join(artifactDir, 'ledger.json')); }
  catch (error) {
    errors.push({ source: 'bridge', message: error.message });
    return bridgeSurface(config, configured, null, null, error.message, root, null);
  }
  if (!existsSync(ledgerPath)) {
    return bridgeSurface(config, configured, null, ledgerPath, null, root, readBridgeAudit(config, errors, now));
  }
  let ledger;
  try {
    const stat = statSync(ledgerPath);
    if (stat.size > MAX_BRIDGE_LEDGER_BYTES) throw new Error(`Bridge ledger exceeds the ${MAX_BRIDGE_LEDGER_BYTES} byte limit.`);
    ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
  } catch (error) {
    errors.push({ source: 'bridge', message: error.message });
    // Core audit uses the same bound and reports a stable ledger-too-large
    // integrity issue without loading oversized JSON into memory.
    return bridgeSurface(config, configured, null, ledgerPath, error.message, root, readBridgeAudit(config, errors, now));
  }
  return bridgeSurface(config, configured, ledger, ledgerPath, null, root, readBridgeAudit(config, errors, now));
}

function readBridgeAudit(config, errors, now) {
  try {
    return auditBridge(config, {
      verifyArtifacts: true,
      evaluateSinks: false,
      ...(now != null ? { now } : {}),
    });
  } catch (error) {
    errors.push({ source: 'bridge-audit', message: error.message });
    return null;
  }
}

function bridgeSurface(config, configured, ledger, ledgerPath, readError, root, audit) {
  const persisted = Array.isArray(ledger?.connections) ? ledger.connections
    : Array.isArray(ledger?.entries) ? ledger.entries : [];
  const auditedById = new Map((audit?.connections ?? []).map((connection) => [connection.id, connection]));
  const latestByOperation = new Map();
  const entryByEnvelope = new Map();
  for (const entry of persisted) {
    const id = entry.provider ?? entry.connectionId;
    latestByOperation.set(`${id}:${entry.operation ?? 'collect'}`, entry);
    const envelope = entry.envelope ?? entry.latest ?? null;
    if (envelope?.id) entryByEnvelope.set(envelope.id, entry);
  }
  const connections = configured.map((connection) => {
    const audited = auditedById.get(connection.id) ?? null;
    const role = connection.role ?? 'source';
    const preferredOperation = role === 'sink' || role === 'both' ? 'publish' : 'collect';
    const entry = (audited?.envelopeId ? entryByEnvelope.get(audited.envelopeId) : null)
      ?? latestByOperation.get(`${connection.id}:${preferredOperation}`)
      ?? (role === 'both' ? latestByOperation.get(`${connection.id}:collect`) : null)
      ?? null;
    const envelope = entry?.envelope ?? entry?.latest ?? null;
    return {
      ...connection,
      status: audited?.status ?? entry?.status ?? (connection.enabled ? 'not-synced' : 'disabled'),
      trust: audited?.trust ?? envelope?.trust?.level ?? entry?.trust ?? connection.requestedTrust,
      generatedAt: audited?.generatedAt ?? envelope?.createdAt ?? entry?.createdAt ?? null,
      expiresAt: envelope?.expiresAt ?? entry?.expiresAt ?? null,
      provider: envelope?.provider ?? entry?.provider ?? connection.adapter,
      capability: envelope?.payload?.capability ?? entry?.capability ?? null,
      commit: audited?.commit ?? envelope?.binding?.commit ?? entry?.commit ?? null,
      artifactCount: envelope?.artifacts?.length ?? entry?.artifacts?.length ?? 0,
      findingCount: envelope?.payload?.findings?.length ?? entry?.findings?.length ?? 0,
      durationMs: entry?.durationMs ?? null,
      error: entry?.error?.message ?? entry?.error ?? null,
      digest: envelope?.digest ?? entry?.digest ?? null,
      envelopeId: audited?.envelopeId ?? envelope?.id ?? null,
      operations: audited?.operations ?? {},
      issues: audited?.issues ?? [],
    };
  });
  // Keep ledger-only entries visible (for example, a connection removed after
  // the last run) without exposing provider-specific metadata or credentials.
  for (const entry of persisted) {
    const id = entry.provider ?? entry.connectionId;
    if (!id || connections.some((connection) => connection.id === id)) continue;
    const envelope = entry.envelope ?? entry.latest ?? null;
    connections.push({
      id, adapter: entry.adapter ?? envelope?.provider ?? 'external', role: 'source',
      enabled: false, required: false, requestedTrust: 'linked', permissions: [],
      status: 'detached', trust: envelope?.trust?.level ?? entry.trust ?? 'untrusted',
      generatedAt: envelope?.createdAt ?? entry.createdAt ?? null,
      expiresAt: envelope?.expiresAt ?? entry.expiresAt ?? null,
      provider: envelope?.provider ?? entry.provider ?? null,
      capability: envelope?.payload?.capability ?? entry.capability ?? null,
      commit: envelope?.binding?.commit ?? entry.commit ?? null,
      artifactCount: envelope?.artifacts?.length ?? 0,
      findingCount: envelope?.payload?.findings?.length ?? 0,
      durationMs: entry.durationMs ?? null, error: entry.error?.message ?? entry.error ?? null,
      digest: envelope?.digest ?? entry.digest ?? null,
    });
  }
  const fallbackHealthy = connections.filter((connection) => ['passed', 'healthy', 'verified', 'synced'].includes(connection.status)).length;
  const fallbackFailed = connections.filter((connection) => ['failed', 'error', 'invalid', 'stale'].includes(connection.status)).length;
  const fallbackRequiredFailed = connections.filter((connection) => connection.required
    && !['passed', 'healthy', 'verified', 'synced'].includes(connection.status)).length;
  return {
    schema: ledger?.schema ?? 'axion-bridge-studio/v1',
    status: audit?.status ?? (readError ? 'failed' : 'unknown'),
    enabled: config.bridge?.enabled === true || config.gates?.bridge?.enabled === true,
    available: !!ledger,
    path: ledgerPath ? relativePath(root, ledgerPath) : null,
    generatedAt: ledger?.generatedAt ?? null,
    repository: ledger?.repository ?? null,
    connections,
    summary: audit?.summary ?? {
      total: connections.length,
      healthy: fallbackHealthy,
      failed: fallbackFailed,
      incomplete: Math.max(0, connections.length - fallbackHealthy - fallbackFailed),
      requiredFailed: fallbackRequiredFailed,
    },
    issues: audit?.issues ?? [],
    ledger: audit?.ledger ?? null,
    error: readError,
  };
}

/** Read a constrained source excerpt for graph/detail panels. */
export function readSourceExcerpt(root, file, line = 1, context = 4) {
  const cwd = resolvePath(root);
  const canonicalRoot = realpathSync(cwd);
  const target = resolveInside(cwd, file);
  const ext = extname(target).toLowerCase();
  if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro', '.html', '.htm', '.css', '.scss', '.less', '.json', '.md'].includes(ext)) {
    throw new Error(`Unsupported source type: ${ext || '(none)'}`);
  }
  const source = readFileSync(target, 'utf8');
  if (Buffer.byteLength(source) > 1024 * 1024) throw new Error('Source file exceeds the 1 MiB inspector limit.');
  const lines = source.split('\n');
  const at = Math.max(1, Math.min(Number(line) || 1, lines.length));
  const radius = Math.max(0, Math.min(Number(context) || 4, 20));
  const start = Math.max(1, at - radius);
  const end = Math.min(lines.length, at + radius);
  return {
    file: relativePath(canonicalRoot, target),
    line: at,
    start,
    end,
    language: ext.slice(1) || 'text',
    lines: lines.slice(start - 1, end).map((text, index) => ({ number: start + index, text })),
  };
}

export function resolveInside(root, file) {
  const cwd = resolvePath(root);
  const rootReal = realpathSync(cwd);
  const target = resolvePath(cwd, String(file ?? ''));
  if (!isContained(cwd, target)) {
    throw new Error('Path escapes the Studio project root.');
  }
  // Canonicalize the deepest existing ancestor. This catches both a target
  // symlink and a symlinked parent before a later stat/read can follow it.
  const suffix = [];
  let probe = target;
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    suffix.unshift(basename(probe));
    probe = parent;
  }
  const canonicalParent = realpathSync(probe);
  const canonicalTarget = resolvePath(canonicalParent, ...suffix);
  if (!isContained(rootReal, canonicalTarget)) {
    throw new Error('Path escapes the Studio project root through a symbolic link.');
  }
  return canonicalTarget;
}

function isContained(root, target) {
  const rel = relative(root, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function summarizeDirection(doc, lock, tokens, config, approvals) {
  if (!doc) {
    return {
      available: false, required: !!config.directionRequired,
      path: relativePath(config.cwd, config.directionPath),
      lockPath: relativePath(config.cwd, config.directionLockPath),
      status: 'absent', name: null, approved: false, locked: false, matches: false,
      currentHash: null, currentBindingHash: null, baselineHash: null, baselineBindingHash: null,
      context: null, identity: null, bindings: [],
      approvals,
    };
  }
  let currentHash = null;
  let currentBindingHash = null;
  try { currentHash = hashDirection(doc); } catch { /* malformed direction is displayed, not hidden */ }
  try {
    currentBindingHash = hashDirectionBindings(doc, (path, mode) => tokens ? resolveToken(tokens, path, mode) : null);
  } catch { /* malformed bindings remain visible */ }
  const bindings = Object.entries(doc.bindings ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([role, path]) => ({
    role,
    path,
    light: tokens ? resolveToken(tokens, path, 'light') : null,
    dark: tokens ? resolveToken(tokens, path, 'dark') : null,
  }));
  const locked = !!lock?.directionHash && !!lock?.bindingHash;
  const matches = locked && lock.directionHash === currentHash && lock.bindingHash === currentBindingHash;
  return {
    available: true,
    required: !!config.directionRequired,
    path: relativePath(config.cwd, config.directionPath),
    lockPath: relativePath(config.cwd, config.directionLockPath),
    status: doc.status ?? 'draft',
    name: doc.name ?? null,
    approved: doc.status === 'approved',
    locked,
    matches,
    drift: locked ? {
      direction: lock.directionHash !== currentHash,
      bindings: lock.bindingHash !== currentBindingHash,
    } : null,
    currentHash,
    currentBindingHash,
    baselineHash: lock?.directionHash ?? null,
    baselineBindingHash: lock?.bindingHash ?? null,
    context: doc.context ?? null,
    identity: doc.identity ?? null,
    bindings,
    approvals,
  };
}

function summarizeApprovalHistory(loaded, lock, root, path) {
  const entries = loaded.history?.entries ?? [];
  const lockRequiresHistory = typeof lock?.approvalHeadHash === 'string';
  let status = 'verified';
  const issues = [...(loaded.issues ?? [])];
  if (!loaded.ok) status = 'invalid';
  else if (!entries.length) status = lockRequiresHistory ? 'invalid' : 'empty';
  else {
    const latest = entries.at(-1);
    const stale = !lock
      || latest.directionHash !== lock.directionHash
      || latest.bindingHash !== lock.bindingHash
      || (lockRequiresHistory && lock.approvalHeadHash !== loaded.headHash);
    if (stale) status = 'stale';
  }
  if (lockRequiresHistory && loaded.missing) {
    status = 'invalid';
    issues.push({ code: 'missing-history', index: null, message: 'Taste Lock commits to an approval history that is missing.' });
  } else if (lockRequiresHistory && !entries.length && loaded.ok) {
    issues.push({ code: 'empty-history', index: null, message: 'Taste Lock commits to an empty approval history.' });
  }
  const latest = entries.at(-1) ?? null;
  return {
    schema: 'dk-approval-history-check/v1',
    path: relativePath(root, path),
    status,
    ok: status === 'verified',
    chainValid: !!loaded.ok,
    missing: !!loaded.missing,
    count: entries.length,
    headHash: loaded.headHash ?? null,
    lockHeadHash: lock?.approvalHeadHash ?? null,
    latest,
    entries: entries.slice(-100).reverse(),
    issues,
  };
}

function summarizeLedger(report, reportPath, root) {
  if (!report) {
    return {
      available: false, path: null, status: 'not-run', generatedAt: null,
      tokenHash: null, direction: null,
      counts: { error: 0, warn: 0, info: 0 },
      filesScanned: 0, gates: [], findings: [], suppressed: 0, baselined: 0,
      appProof: null,
    };
  }
  const activeGateCounts = new Map();
  for (const finding of report.findings ?? []) {
    const gate = gateForRule(finding?.ruleId);
    activeGateCounts.set(gate, (activeGateCounts.get(gate) ?? 0) + 1);
  }
  return {
    available: true,
    path: relativePath(root, reportPath),
    status: report.status ?? (report.exitCode ? 'failed' : 'passed'),
    generatedAt: report.generatedAt ?? null,
    tokenHash: report.tokenHash ?? report.emits?.manifest?.tokenHash ?? null,
    direction: report.direction ?? null,
    counts: report.counts ?? countFindings(report.findings),
    filesScanned: report.filesScanned ?? 0,
    gates: (report.gates ?? []).map((gate) => ({
      id: gate.id,
      status: gate.status ?? 'unknown',
      // Persisted gate.findings is the pre-policy raw count. Studio presents
      // the final actionable ledger count so allowlisted/baselined findings do
      // not contradict an otherwise clear report; raw evidence stays visible.
      findingCount: activeGateCounts.get(gate.id) ?? 0,
      rawFindingCount: gate.rawFindingCount ?? gate.findings ?? gate.findingCount ?? 0,
      reason: gate.reason ?? null,
      attempted: gate.attempted ?? true,
      blocking: !!gate.blocking,
    })),
    findings: (report.findings ?? []).slice(0, 500).map((finding) => ({
      ruleId: finding.ruleId,
      severity: finding.severity,
      file: finding.file ?? null,
      line: finding.line ?? null,
      col: finding.col ?? null,
      message: finding.message,
      evidence: finding.evidence ?? null,
      fix: finding.fix ?? null,
    })),
    suppressed: report.suppressed ?? 0,
    baselined: report.baselined ?? 0,
    full: !!report.full,
    partial: !!report.partial,
    appProof: report.emits?.appProofArtifact ? {
      artifact: report.emits.appProofArtifact,
      configHash: report.emits.appProofConfigHash ?? null,
      discovery: report.emits.appProofDiscovery ?? null,
      coverage: report.emits.appProofCoverage ?? null,
      summary: report.emits.appProofSummary ?? null,
    } : null,
  };
}

function gateForRule(ruleId) {
  const id = String(ruleId ?? 'unknown');
  if (id.startsWith('tokens/ssot')) return 'ssot-sync';
  if (id.startsWith('tokens/')) return 'contract';
  if (id.startsWith('slop/') || id.startsWith('brand/') || id.startsWith('spacing/')) return 'slop';
  if (id.startsWith('css/')) return 'css-strict';
  if (id.startsWith('a11y/')) return 'a11y';
  if (id.startsWith('visual/')) return 'visual';
  if (id.startsWith('direction/')) return 'direction';
  if (id.startsWith('config/')) return 'config';
  return id.split('/')[0];
}

function readTokenState(path, errors) {
  if (!existsSync(path)) return { tokens: null, manifest: null };
  try {
    const tokens = loadTokens(path);
    return { tokens, manifest: buildManifest(tokens) };
  } catch (error) {
    errors.push({ source: 'tokens', message: error.message });
    return { tokens: null, manifest: null };
  }
}

function discoverPreviews(graph) {
  const candidates = [];
  const seen = new Set();
  for (const node of graph.nodes ?? []) {
    if (node.kind !== 'route' || !/\.html?$/i.test(node.file ?? '')) continue;
    if (/(?:^|\/)(?:fixtures|golden|output|tests?)(?:\/|$)/i.test(node.file)) continue;
    if (String(node.file).split('/').some((segment) => segment.startsWith('.'))) continue;
    if (seen.has(node.file)) continue;
    seen.add(node.file);
    candidates.push({ route: node.label, file: node.file, label: labelForPreview(node) });
  }
  return candidates.sort((a, b) => {
    if (a.route === '/') return -1;
    if (b.route === '/') return 1;
    return a.route.localeCompare(b.route);
  });
}

function labelForPreview(node) {
  if (node.label === '/') return 'Home';
  return node.label.split('/').filter(Boolean).at(-1)?.replace(/[-_]/g, ' ') ?? node.file;
}

function collectGitSummary(cwd) {
  const inside = git(cwd, ['rev-parse', '--is-inside-work-tree']);
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { available: false, branch: null, head: null, root: null, clean: true, files: [], summary: emptyDiffSummary() };
  }
  const root = git(cwd, ['rev-parse', '--show-toplevel']).stdout.trim() || cwd;
  const branch = git(cwd, ['branch', '--show-current']).stdout.trim() || '(detached)';
  const head = git(cwd, ['rev-parse', '--short', 'HEAD']).stdout.trim() || null;
  const status = git(cwd, ['status', '--porcelain=v1', '--untracked-files=normal', '--', '.']);
  const files = status.stdout.split('\n').filter(Boolean).slice(0, 300).map(parseStatusLine);
  const unstaged = parseNumstat(git(cwd, ['diff', '--numstat', '--', '.']).stdout);
  const staged = parseNumstat(git(cwd, ['diff', '--cached', '--numstat', '--', '.']).stdout);
  const merged = mergeNumstat(unstaged, staged, files);
  return {
    available: true,
    root,
    branch,
    head,
    clean: files.length === 0,
    files,
    summary: merged,
    truncated: status.stdout.split('\n').filter(Boolean).length > files.length,
  };
}

function git(cwd, args) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 2500,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
  });
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

function parseStatusLine(line) {
  const index = line[0] ?? ' ';
  const worktree = line[1] ?? ' ';
  const raw = line.slice(3);
  const file = raw.includes(' -> ') ? raw.split(' -> ').at(-1) : raw;
  return { file, index, worktree, status: statusLabel(index, worktree) };
}

function statusLabel(index, worktree) {
  const code = `${index}${worktree}`;
  if (code === '??') return 'untracked';
  if (code.includes('R')) return 'renamed';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('M')) return 'modified';
  if (code.includes('U')) return 'conflict';
  return 'changed';
}

function parseNumstat(value) {
  const rows = [];
  for (const line of value.split('\n').filter(Boolean)) {
    const [add, del, ...fileParts] = line.split('\t');
    rows.push({ file: fileParts.join('\t'), additions: add === '-' ? 0 : Number(add) || 0, deletions: del === '-' ? 0 : Number(del) || 0 });
  }
  return rows;
}

function mergeNumstat(unstaged, staged, statusFiles) {
  const byFile = new Map();
  for (const row of [...unstaged, ...staged]) {
    const current = byFile.get(row.file) ?? { file: row.file, additions: 0, deletions: 0 };
    current.additions += row.additions;
    current.deletions += row.deletions;
    byFile.set(row.file, current);
  }
  for (const file of statusFiles) if (!byFile.has(file.file)) byFile.set(file.file, { file: file.file, additions: 0, deletions: 0 });
  const files = [...byFile.values()].sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions) || a.file.localeCompare(b.file));
  return {
    changed: statusFiles.length,
    additions: files.reduce((sum, row) => sum + row.additions, 0),
    deletions: files.reduce((sum, row) => sum + row.deletions, 0),
    files: files.slice(0, 100),
  };
}

function findBestReport(root) {
  const primary = [join(root, '.dk', 'report.json'), join(root, 'output', 'verify-full.json')];
  for (const path of primary) if (isFile(path)) return path;
  return null;
}

function readJson(path, errors, source) {
  if (!path || !existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) {
    errors.push({ source, message: error.message, path });
    return null;
  }
}

function fallbackConfig(cwd) {
  return {
    cwd,
    presetName: 'recommended', configFile: null,
    tokensPath: join(cwd, 'design', 'tokens.json'),
    directionPath: join(cwd, 'design', 'direction.json'),
    directionLockPath: join(cwd, 'design', 'direction.lock.json'),
    directionRequired: false,
  };
}

function countFindings(findings = []) {
  const counts = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] = (counts[finding.severity] ?? 0) + 1;
  return counts;
}

function resolveSafeRelative(root, path) {
  // macOS temp roots may be exposed through `/var` while realpath resolves to
  // `/private/var`. Compare canonical roots so Studio never leaks an absolute
  // path or lets that alias inflate mobile layout.
  let canonicalRoot;
  try { canonicalRoot = realpathSync(resolvePath(root)); }
  catch { canonicalRoot = resolvePath(root); }
  const rel = relative(canonicalRoot, resolvePath(path));
  return rel && !rel.startsWith('..') ? slash(rel) : path;
}
function relativePath(root, path) { return path ? resolveSafeRelative(root, path) : null; }
function slash(path) { return path.split(sep).join('/'); }
function isFile(path) { try { return statSync(path).isFile(); } catch { return false; } }
function emptyDiffSummary() { return { changed: 0, additions: 0, deletions: 0, files: [] }; }
function normalizeNow(now) { return now instanceof Date ? now.toISOString() : typeof now === 'string' ? now : new Date().toISOString(); }
