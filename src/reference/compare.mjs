import { basename, extname } from 'node:path';
import { REFERENCE_LIMITS } from './constants.mjs';
import { ReferenceSystemError, ReferenceValidationError } from './errors.mjs';
import { decodePngRgba, inspectImage, sha256 } from './image.mjs';
import { readRegularFileInside, scopeAllowsProjectPath } from './safety.mjs';

const TEXT_EXTENSIONS = new Set([
  '.css', '.scss', '.sass', '.less', '.html', '.htm', '.js', '.mjs', '.cjs',
  '.jsx', '.ts', '.tsx', '.vue', '.svelte', '.astro', '.mdx',
]);

export function compareImageEvidence(reference, referenceBytes, candidatePath, candidateBytes, options = {}) {
  const candidateMeta = inspectImage(candidateBytes, extname(candidatePath));
  const exactHashMatch = reference.sha256 === candidateMeta.sha256;
  const dimensions = {
    match: reference.width === candidateMeta.width && reference.height === candidateMeta.height,
    reference: { width: reference.width, height: reference.height },
    candidate: { width: candidateMeta.width, height: candidateMeta.height },
    widthDeltaPx: Math.abs(reference.width - candidateMeta.width),
    heightDeltaPx: Math.abs(reference.height - candidateMeta.height),
    aspectRatioDelta: round6(Math.abs(reference.width / reference.height - candidateMeta.width / candidateMeta.height)),
  };
  let pixelStats = null;
  if (options.includePixelStats !== false && reference.format === 'png' && candidateMeta.format === 'png' && dimensions.match) {
    const before = decodePngRgba(referenceBytes);
    const after = decodePngRgba(candidateBytes);
    if (before && after) {
      let absoluteDelta = 0;
      let maxChannelDelta = 0;
      let changedPixels = 0;
      for (let pixel = 0; pixel < before.stats.pixels; pixel++) {
        let changed = false;
        for (let channel = 0; channel < 4; channel++) {
          const index = pixel * 4 + channel;
          const delta = Math.abs(before.rgba[index] - after.rgba[index]);
          absoluteDelta += delta;
          maxChannelDelta = Math.max(maxChannelDelta, delta);
          if (delta > 0) changed = true;
        }
        if (changed) changedPixels++;
      }
      const meanAbsoluteChannelDelta = round6(absoluteDelta / (before.stats.pixels * 4));
      pixelStats = {
        reference: before.stats,
        candidate: after.stats,
        meanAbsoluteChannelDelta,
        normalizedMeanDelta: round6(meanAbsoluteChannelDelta / 255),
        changedPixelRatio: round6(changedPixels / before.stats.pixels),
        maxChannelDelta,
      };
    }
  }
  return {
    candidateMeta,
    metrics: { exactHashMatch, dimensions, pixelStats },
  };
}

export function scanWholeReferenceBackground(projectRoot, manifest, implementationFiles = []) {
  if (!Array.isArray(implementationFiles)) throw new ReferenceValidationError(['implementationFiles must be an array']);
  if (implementationFiles.length === 0) return { status: 'not-scanned', scannedFiles: [], sourceDigests: [], findings: [] };
  if (implementationFiles.length > REFERENCE_LIMITS.maxImplementationFiles) {
    throw new ReferenceSystemError(
      'DK_REFERENCE_SCAN_LIMIT',
      `implementationFiles may contain at most ${REFERENCE_LIMITS.maxImplementationFiles} paths`,
    );
  }
  const scannedFiles = [];
  const sourceDigests = [];
  const findings = [];
  const unique = new Set();
  for (const file of implementationFiles) {
    if (unique.has(file)) throw new ReferenceValidationError([`implementationFiles contains a duplicate path: ${file}`]);
    unique.add(file);
    const extension = extname(file).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) {
      throw new ReferenceValidationError([`implementation file is not a supported text source: ${file}`]);
    }
    const authorized = manifest.references.some((reference) => scopeAllowsProjectPath(reference.authorizedScope, file));
    if (!authorized) throw new ReferenceValidationError([`implementation file is outside every reference authorized scope: ${file}`]);
    const loaded = readRegularFileInside(projectRoot, file, {
      label: `implementation file ${file}`,
      maxBytes: REFERENCE_LIMITS.maxImplementationFileBytes,
    });
    const text = loaded.bytes.toString('utf8');
    if (text.includes('\u0000')) throw new ReferenceValidationError([`implementation file is not UTF-8 text: ${file}`]);
    scannedFiles.push(loaded.relative);
    sourceDigests.push({ path: loaded.relative, sha256: sha256(loaded.bytes), bytes: loaded.bytes.length });
    for (const reference of manifest.references) {
      if (!scopeAllowsProjectPath(reference.authorizedScope, loaded.relative)) continue;
      findings.push(...scanTextForReference(text, loaded.relative, reference));
    }
  }
  return { status: findings.length ? 'fail' : 'pass', scannedFiles, sourceDigests, findings };
}

function scanTextForReference(text, file, reference) {
  const aliases = [reference.storedPath, reference.originalPath, basename(reference.storedPath), basename(reference.originalPath)]
    .filter(Boolean).map(escapeRegExp);
  if (!aliases.length) return [];
  const aliasPattern = `(?:${aliases.join('|')})`;
  const patterns = [
    {
      ruleId: 'reference/no-whole-image-background',
      message: 'A complete registered reference image must not be used as a CSS background.',
      regex: new RegExp(`(?:background(?:-image)?\\s*:|backgroundImage\\s*[:=])[^;\\n}]*${aliasPattern}`, 'gi'),
    },
    {
      ruleId: 'reference/no-full-viewport-reference-img',
      message: 'A complete registered reference image must not be stretched over the viewport.',
      regex: new RegExp(`<img\\b(?=[^>]*(?:src\\s*=\\s*["'][^"']*${aliasPattern}[^"']*["']|src\\s*=\\s*\\{[^}]*${aliasPattern}[^}]*\\}))(?=[^>]*(?:width\\s*=\\s*["']?(?:${reference.width}|100%|100vw)|height\\s*=\\s*["']?(?:${reference.height}|100%|100vh)|style\\s*=\\s*["'][^"']*(?:position\\s*:\\s*(?:fixed|absolute)|inset\\s*:\\s*0)))[^>]*>`, 'gi'),
    },
  ];
  const findings = [];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      findings.push({
        file,
        line: 1 + countNewlines(text, match.index ?? 0),
        ruleId: pattern.ruleId,
        message: pattern.message,
        referenceId: reference.id,
      });
    }
  }
  return findings;
}

export function deriveHighestDeltas(metrics, regionFindings, policy, capture = null) {
  const deltas = [];
  if (!metrics.dimensions.match) {
    const reference = metrics.dimensions.reference;
    const score = clamp01(Math.max(
      metrics.dimensions.widthDeltaPx / reference.width,
      metrics.dimensions.heightDeltaPx / reference.height,
      metrics.dimensions.aspectRatioDelta,
    ));
    deltas.push({
      id: 'metric-dimensions', type: 'dimensions', severity: severityFor(score), score: round6(score),
      summary: `Rendered size differs by ${metrics.dimensions.widthDeltaPx}px × ${metrics.dimensions.heightDeltaPx}px.`, source: 'metric',
    });
  }
  if (metrics.pixelStats && metrics.pixelStats.normalizedMeanDelta > 0) {
    const score = metrics.pixelStats.normalizedMeanDelta;
    deltas.push({
      id: 'metric-pixel-stats', type: 'pixel-stats', severity: severityFor(score), score,
      summary: `Position-aware mean RGBA channel delta is ${metrics.pixelStats.meanAbsoluteChannelDelta}; ${metrics.pixelStats.changedPixelRatio} of pixels changed.`, source: 'metric',
    });
  }
  if (!metrics.exactHashMatch) {
    deltas.push({
      id: 'metric-content-hash', type: 'content-hash', severity: 'low', score: 0.1,
      summary: 'Rendered PNG bytes do not exactly match the registered reference.', source: 'metric',
    });
  }
  for (const finding of regionFindings) {
    deltas.push({
      id: `region-${finding.id}`, type: finding.type, severity: finding.severity, score: finding.score,
      summary: finding.summary, source: 'region',
    });
  }
  for (let index = 0; index < policy.findings.length; index++) {
    const finding = policy.findings[index];
    deltas.push({
      id: `policy-${index + 1}`, type: finding.ruleId, severity: 'critical', score: 1,
      summary: finding.message, source: 'policy',
    });
  }
  if (capture?.status === 'unattested') {
    deltas.push({
      id: 'attestation-app-proof', type: 'capture-attestation', severity: 'medium', score: 0.49,
      summary: capture.reason, source: 'attestation',
    });
  }
  return deltas
    .sort((a, b) => b.score - a.score || severityRank(b.severity) - severityRank(a.severity) || a.id.localeCompare(b.id))
    .slice(0, 3);
}

export function comparisonStatus(metrics, highestDeltas, policy, capture = null) {
  if (policy.status === 'not-scanned') return 'incomplete';
  if (policy.status === 'fail' || highestDeltas.some((delta) => delta.severity === 'critical' || delta.score >= 0.5)) return 'mismatch';
  if (capture?.status && capture.status !== 'attested') return 'review';
  const materialDeltas = highestDeltas.filter((delta) => delta.type !== 'content-hash');
  const spatiallyEqual = metrics.pixelStats
    && metrics.pixelStats.normalizedMeanDelta === 0
    && metrics.pixelStats.changedPixelRatio === 0;
  if (metrics.dimensions.match && materialDeltas.length === 0 && (spatiallyEqual || metrics.exactHashMatch)) return 'match';
  return 'review';
}

export function normalizeRegionFindings(findings = []) {
  if (!Array.isArray(findings)) throw new ReferenceValidationError(['regionFindings must be an array']);
  return findings.map((finding, index) => ({
    id: normalizeId(finding?.id ?? `finding-${index + 1}`, `regionFindings[${index}].id`),
    regionId: finding?.regionId == null ? null : normalizeId(finding.regionId, `regionFindings[${index}].regionId`),
    type: requiredText(finding?.type, `regionFindings[${index}].type`),
    severity: requiredChoice(finding?.severity, ['info', 'low', 'medium', 'high', 'critical'], `regionFindings[${index}].severity`),
    score: requiredScore(finding?.score, `regionFindings[${index}].score`),
    summary: requiredText(finding?.summary, `regionFindings[${index}].summary`),
    evidence: normalizeStringArray(finding?.evidence ?? [], `regionFindings[${index}].evidence`),
  }));
}

export function comparisonInputsSha256(
  reference,
  candidateMeta,
  reconstructionPlan,
  viewport,
  metrics,
  regionFindings,
  policy,
  capture,
  highestDeltas,
  status,
) {
  return sha256(Buffer.from(JSON.stringify({
    reference: { id: reference.id, sha256: reference.sha256, viewport: reference.viewport },
    candidate: { sha256: candidateMeta.sha256, width: candidateMeta.width, height: candidateMeta.height },
    reconstructionPlan,
    viewport,
    metrics,
    regionFindings,
    policy,
    capture,
    highestDeltas,
    status,
  }), 'utf8'));
}

function normalizeId(value, at) {
  const text = requiredText(value, at).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/.test(text)) throw new ReferenceValidationError([`${at} must be a lowercase safe id`]);
  return text;
}

function requiredText(value, at) {
  if (typeof value !== 'string' || !value.trim()) throw new ReferenceValidationError([`${at} must be a non-empty string`]);
  return value.trim();
}

function requiredChoice(value, choices, at) {
  if (!choices.includes(value)) throw new ReferenceValidationError([`${at} must be one of: ${choices.join(', ')}`]);
  return value;
}

function requiredScore(value, at) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) throw new ReferenceValidationError([`${at} must be between 0 and 1`]);
  return round6(value);
}

function normalizeStringArray(value, at) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new ReferenceValidationError([`${at} must be an array of non-empty strings`]);
  }
  return [...new Set(value.map((item) => item.trim()))];
}

function severityFor(score) {
  if (score >= 0.75) return 'critical';
  if (score >= 0.5) return 'high';
  if (score >= 0.25) return 'medium';
  if (score > 0) return 'low';
  return 'info';
}

function severityRank(value) {
  return ['info', 'low', 'medium', 'high', 'critical'].indexOf(value);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function countNewlines(text, end) {
  let count = 0;
  for (let index = 0; index < end; index++) if (text.charCodeAt(index) === 10) count++;
  return count;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, value));
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
