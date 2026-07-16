import { existsSync, lstatSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { safeWriteFileSync } from '../core/safe-write.mjs';
import {
  DEFAULT_REFERENCE_DIRECTORY,
  REFERENCE_FILENAMES,
  REFERENCE_KINDS,
  REFERENCE_LIMITS,
} from './constants.mjs';
import { ReferenceSystemError, ReferenceValidationError } from './errors.mjs';
import { inspectImage, sha256 } from './image.mjs';
import {
  assertNoSymlinkComponents,
  fixProjectRoot,
  readRegularFileInside,
  relativeProjectPath,
  resolveInsideProject,
} from './safety.mjs';
import { assertValidReferenceArtifact, validateReferenceArtifact } from './validate.mjs';
import {
  compareImageEvidence,
  comparisonInputsSha256,
  comparisonStatus,
  deriveHighestDeltas,
  normalizeRegionFindings,
  scanWholeReferenceBackground,
} from './compare.mjs';
import { buildAppProofCaptureAttestation } from './attestation.mjs';

export class ReferenceSystem {
  constructor(projectRoot, options = {}) {
    this.projectRoot = fixProjectRoot(projectRoot);
    this.projectRootSha256 = sha256(Buffer.from(this.projectRoot, 'utf8'));
    this.clock = typeof options.clock === 'function' ? options.clock : () => new Date();
    const requested = options.directory ?? DEFAULT_REFERENCE_DIRECTORY;
    this.directory = relativeProjectPath(this.projectRoot, requested, 'reference directory');
    this.directoryPath = resolveInsideProject(this.projectRoot, this.directory, 'reference directory');
    assertNoSymlinkComponents(this.projectRoot, this.directoryPath, 'reference directory');
  }

  get paths() {
    return Object.freeze({
      directory: this.directory,
      manifest: `${this.directory}/${REFERENCE_FILENAMES.manifest}`,
      assets: `${this.directory}/assets`,
    });
  }

  artifactPaths(referenceId) {
    const id = safeId(referenceId, 'referenceId');
    return Object.freeze({
      manifest: this.paths.manifest,
      decomposition: `${this.directory}/${REFERENCE_FILENAMES.decomposition(id)}`,
      mapping: `${this.directory}/${REFERENCE_FILENAMES.mapping(id)}`,
      plan: `${this.directory}/${REFERENCE_FILENAMES.plan(id)}`,
      comparison: `${this.directory}/${REFERENCE_FILENAMES.comparison(id)}`,
    });
  }

  registerReferences(inputs, options = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new ReferenceValidationError(['references must be a non-empty array']);
    }
    const previous = options.replace === true || !existsSync(resolve(this.projectRoot, this.paths.manifest))
      ? []
      : this.readManifest().artifact.references;
    if (previous.length + inputs.length > REFERENCE_LIMITS.maxReferences) {
      throw new ReferenceValidationError([`a manifest may register at most ${REFERENCE_LIMITS.maxReferences} references`]);
    }
    const now = this.timestamp();
    const ids = new Set(previous.map((reference) => reference.id));
    const prepared = [];
    for (let index = 0; index < inputs.length; index++) {
      const input = normalizeRegistrationInput(inputs[index], index, now);
      if (ids.has(input.id)) throw new ReferenceValidationError([`reference id already exists: ${input.id}`]);
      ids.add(input.id);
      const loaded = readRegularFileInside(this.projectRoot, input.path, {
        label: `references[${index}].path`,
        maxBytes: REFERENCE_LIMITS.maxBytesPerReference,
      });
      const metadata = inspectImage(loaded.bytes, extname(loaded.absolute));
      const storedPath = `${this.directory}/assets/${metadata.sha256}.${metadata.extension}`;
      prepared.push({
        bytes: loaded.bytes,
        entry: {
          id: input.id,
          originalPath: loaded.relative,
          storedPath,
          format: metadata.format,
          mediaType: metadata.mediaType,
          bytes: metadata.bytes,
          width: metadata.width,
          height: metadata.height,
          sha256: metadata.sha256,
          provenance: input.provenance,
          licence: input.licence,
          viewport: input.viewport,
          authorizedScope: input.authorizedScope,
        },
      });
    }
    const artifact = {
      kind: REFERENCE_KINDS.manifest,
      artifactId: 'reference-manifest',
      createdAt: now,
      projectRootSha256: this.projectRootSha256,
      limits: {
        maxReferences: REFERENCE_LIMITS.maxReferences,
        maxBytesPerReference: REFERENCE_LIMITS.maxBytesPerReference,
        allowedFormats: [...REFERENCE_LIMITS.allowedFormats],
      },
      references: [...previous, ...prepared.map((item) => item.entry)],
    };
    assertValidReferenceArtifact(artifact);
    // Validate the complete transaction before writing any content. Assets are
    // content-addressed, so a crash can at worst leave a harmless orphan; the
    // manifest is always replaced atomically after every asset is durable.
    for (const item of prepared) this.writeContentAddressedAsset(item.entry.storedPath, item.bytes, item.entry.sha256);
    return this.writeJson(this.paths.manifest, artifact);
  }

  readManifest(options = {}) {
    const result = this.readArtifact(this.paths.manifest, { validateLinks: false });
    if (result.artifact.kind !== REFERENCE_KINDS.manifest) {
      throw new ReferenceValidationError([`${this.paths.manifest} is not a ${REFERENCE_KINDS.manifest}`]);
    }
    if (options.verifyAssets !== false) this.verifyManifestAssets(result.artifact);
    return result;
  }

  readArtifact(path, options = {}) {
    const relativePath = this.assertArtifactPath(path);
    const loaded = readRegularFileInside(this.projectRoot, relativePath, {
      label: 'reference artifact',
      maxBytes: REFERENCE_LIMITS.maxArtifactBytes,
    });
    let artifact;
    try { artifact = JSON.parse(loaded.bytes.toString('utf8')); }
    catch (error) {
      throw new ReferenceSystemError('DK_REFERENCE_JSON', `reference artifact is not valid JSON: ${relativePath}`, { cause: error });
    }
    if (artifact?.projectRootSha256 !== this.projectRootSha256) {
      throw new ReferenceValidationError([`${relativePath} is bound to a different project root`]);
    }
    let context = {};
    if (options.validateLinks !== false && artifact.kind !== REFERENCE_KINDS.manifest) {
      const manifestResult = this.readLinkedArtifact(artifact.manifest, REFERENCE_KINDS.manifest);
      context.manifest = manifestResult.artifact;
      if (artifact.kind === REFERENCE_KINDS.mapping) {
        const decomposition = this.readLinkedArtifact(artifact.decomposition, REFERENCE_KINDS.decomposition);
        context.decomposition = decomposition.artifact;
      } else if (artifact.kind === REFERENCE_KINDS.plan) {
        const mapping = this.readLinkedArtifact(artifact.componentMapping, REFERENCE_KINDS.mapping);
        context.mapping = mapping.artifact;
      } else if (artifact.kind === REFERENCE_KINDS.comparison) {
        const plan = this.readLinkedArtifact(artifact.reconstructionPlan, REFERENCE_KINDS.plan);
        context.plan = plan.artifact;
      }
    }
    assertValidReferenceArtifact(artifact, context);
    if (artifact.kind === REFERENCE_KINDS.comparison) {
      this.verifyComparisonAsset(artifact, context.manifest);
      this.verifyComparisonSources(artifact, context.manifest, context.plan);
      this.verifyComparisonCapture(artifact, context.manifest, context.plan);
    }
    return { path: loaded.relative, sha256: sha256(loaded.bytes), bytes: loaded.bytes.length, artifact };
  }

  validateArtifact(input, context = {}) {
    try {
      if (typeof input === 'string') this.readArtifact(input);
      else {
        if (input?.projectRootSha256 !== this.projectRootSha256) return ['artifact is bound to a different project root'];
        assertValidReferenceArtifact(input, context);
      }
      return [];
    } catch (error) {
      if (error instanceof ReferenceValidationError) return [...error.issues];
      return [String(error?.message ?? error)];
    }
  }

  writeVisualDecomposition(input) {
    requireInputObject(input, 'decomposition');
    const manifestResult = this.readManifest();
    const reference = requireReference(manifestResult.artifact, input.referenceId);
    const artifact = {
      kind: REFERENCE_KINDS.decomposition,
      artifactId: `visual-decomposition.${reference.id}`,
      createdAt: this.timestamp(),
      projectRootSha256: this.projectRootSha256,
      manifest: artifactReference(manifestResult),
      referenceId: reference.id,
      authoredBy: normalizeAuthor(input.authoredBy),
      canvas: { width: reference.width, height: reference.height },
      global: input.global,
      regions: input.regions,
      assumptions: input.assumptions ?? [],
      unresolved: input.unresolved ?? [],
    };
    assertValidReferenceArtifact(artifact, { manifest: manifestResult.artifact });
    return this.writeJson(this.artifactPaths(reference.id).decomposition, artifact);
  }

  writeComponentMapping(input) {
    requireInputObject(input, 'component mapping');
    const manifestResult = this.readManifest();
    const reference = requireReference(manifestResult.artifact, input.referenceId);
    const decompositionResult = this.readArtifact(
      input.decompositionPath ?? this.artifactPaths(reference.id).decomposition,
    );
    if (decompositionResult.artifact.kind !== REFERENCE_KINDS.decomposition
      || decompositionResult.artifact.referenceId !== reference.id) {
      throw new ReferenceValidationError(['decompositionPath must name a decomposition for the same referenceId']);
    }
    const artifact = {
      kind: REFERENCE_KINDS.mapping,
      artifactId: `component-mapping.${reference.id}`,
      createdAt: this.timestamp(),
      projectRootSha256: this.projectRootSha256,
      manifest: artifactReference(manifestResult),
      referenceId: reference.id,
      decomposition: artifactReference(decompositionResult),
      authoredBy: normalizeAuthor(input.authoredBy),
      mappings: input.mappings,
      unmappedRegions: input.unmappedRegions ?? [],
    };
    assertValidReferenceArtifact(artifact, { manifest: manifestResult.artifact, decomposition: decompositionResult.artifact });
    return this.writeJson(this.artifactPaths(reference.id).mapping, artifact);
  }

  writeReconstructionPlan(input) {
    requireInputObject(input, 'reconstruction plan');
    const manifestResult = this.readManifest();
    const reference = requireReference(manifestResult.artifact, input.referenceId);
    const mappingResult = this.readArtifact(input.mappingPath ?? this.artifactPaths(reference.id).mapping);
    if (mappingResult.artifact.kind !== REFERENCE_KINDS.mapping
      || mappingResult.artifact.referenceId !== reference.id) {
      throw new ReferenceValidationError(['mappingPath must name a component mapping for the same referenceId']);
    }
    const artifact = {
      kind: REFERENCE_KINDS.plan,
      artifactId: `reconstruction-plan.${reference.id}`,
      createdAt: this.timestamp(),
      projectRootSha256: this.projectRootSha256,
      manifest: artifactReference(manifestResult),
      referenceId: reference.id,
      componentMapping: artifactReference(mappingResult),
      authoredBy: normalizeAuthor(input.authoredBy),
      rules: {
        noWholeReferenceBackground: true,
        preserveExistingStack: true,
        assetReuse: input.rules?.assetReuse ?? 'exact-or-cropped',
        scopeEnforced: true,
      },
      steps: input.steps,
      verification: input.verification,
    };
    assertValidReferenceArtifact(artifact, { manifest: manifestResult.artifact, mapping: mappingResult.artifact });
    return this.writeJson(this.artifactPaths(reference.id).plan, artifact);
  }

  compareReference(input) {
    requireInputObject(input, 'reference comparison');
    const manifestResult = this.readManifest();
    const reference = requireReference(manifestResult.artifact, input.referenceId);
    const planPath = input.planPath ?? this.artifactPaths(reference.id).plan;
    if (!existsSync(resolve(this.projectRoot, planPath))) {
      throw new ReferenceValidationError(['a validated reconstruction plan is required before comparison']);
    }
    const planResult = this.readArtifact(planPath);
    if (planResult.artifact.kind !== REFERENCE_KINDS.plan
      || planResult.artifact.referenceId !== reference.id) {
      throw new ReferenceValidationError(['planPath must name a reconstruction plan for the same referenceId']);
    }
    const plannedImplementationFiles = planResult.artifact.verification.implementationFiles;
    const requestedImplementationFiles = input.implementationFiles;
    if (!Array.isArray(requestedImplementationFiles) || requestedImplementationFiles.length === 0) {
      throw new ReferenceValidationError(['implementationFiles must explicitly include every file declared by the reconstruction plan']);
    }
    const requestedSet = new Set(requestedImplementationFiles);
    const plannedSet = new Set(plannedImplementationFiles);
    if (requestedSet.size !== requestedImplementationFiles.length
      || requestedSet.size !== plannedSet.size
      || [...plannedSet].some((file) => !requestedSet.has(file))) {
      throw new ReferenceValidationError(['implementationFiles must exactly match verification.implementationFiles in the reconstruction plan']);
    }
    const referenceFile = readRegularFileInside(this.projectRoot, reference.storedPath, {
      label: `stored reference ${reference.id}`,
      maxBytes: REFERENCE_LIMITS.maxBytesPerReference,
    });
    if (sha256(referenceFile.bytes) !== reference.sha256) {
      throw new ReferenceSystemError('DK_REFERENCE_INTEGRITY', `stored reference digest does not match manifest: ${reference.id}`);
    }
    const candidateFile = readRegularFileInside(this.projectRoot, input.candidatePath, {
      label: 'candidate image',
      maxBytes: REFERENCE_LIMITS.maxBytesPerReference,
    });
    const compared = compareImageEvidence(
      reference,
      referenceFile.bytes,
      candidateFile.relative,
      candidateFile.bytes,
      { includePixelStats: input.includePixelStats !== false },
    );
    const regionFindings = normalizeRegionFindings(input.regionFindings ?? []);
    const policyCheck = scanWholeReferenceBackground(
      this.projectRoot,
      manifestResult.artifact,
      plannedImplementationFiles,
    );
    const policy = { noWholeReferenceBackground: policyCheck };
    const viewport = planResult.artifact.verification.viewports[0];
    const capture = buildAppProofCaptureAttestation(this.projectRoot, {
      candidatePath: candidateFile.relative,
      candidate: compared.candidateMeta,
      reference,
      viewport,
    });
    const highestDeltas = deriveHighestDeltas(compared.metrics, regionFindings, policyCheck, capture);
    const status = comparisonStatus(compared.metrics, highestDeltas, policyCheck, capture);
    const candidateStoredPath = `${this.directory}/assets/${compared.candidateMeta.sha256}.${compared.candidateMeta.extension}`;
    this.writeContentAddressedAsset(candidateStoredPath, candidateFile.bytes, compared.candidateMeta.sha256);
    const createdAt = this.timestamp();
    const candidate = {
      path: candidateStoredPath,
      format: compared.candidateMeta.format,
      mediaType: compared.candidateMeta.mediaType,
      bytes: compared.candidateMeta.bytes,
      width: compared.candidateMeta.width,
      height: compared.candidateMeta.height,
      sha256: compared.candidateMeta.sha256,
    };
    const artifact = {
      kind: REFERENCE_KINDS.comparison,
      artifactId: `reference-comparison.${reference.id}`,
      createdAt,
      projectRootSha256: this.projectRootSha256,
      manifest: artifactReference(manifestResult),
      referenceId: reference.id,
      reconstructionPlan: artifactReference(planResult),
      viewport,
      generated: {
        engine: 'axion-reference-core',
        engineVersion: 1,
        inputsSha256: comparisonInputsSha256(
          reference,
          compared.candidateMeta,
          artifactReference(planResult),
          viewport,
          compared.metrics,
          regionFindings,
          policyCheck,
          capture,
          highestDeltas,
          status,
        ),
      },
      candidate,
      capture,
      metrics: compared.metrics,
      regionFindings,
      policy,
      highestDeltas,
      status,
    };
    assertValidReferenceArtifact(artifact, { manifest: manifestResult.artifact, plan: planResult.artifact });
    return this.writeJson(this.artifactPaths(reference.id).comparison, artifact);
  }

  scanWholeReferenceBackground(implementationFiles) {
    const manifest = this.readManifest().artifact;
    return scanWholeReferenceBackground(this.projectRoot, manifest, implementationFiles);
  }

  inspectStatus() {
    const manifestAbsolute = resolve(this.projectRoot, this.paths.manifest);
    let manifestEntry;
    try { manifestEntry = lstatSync(manifestAbsolute); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        return { schema: 'axion-reference-status/v1', status: 'missing', manifest: null, references: [], issues: [] };
      }
      return {
        schema: 'axion-reference-status/v1', status: 'invalid', manifest: null, references: [],
        issues: [error?.message ?? String(error)],
      };
    }
    if (manifestEntry.isSymbolicLink() || !manifestEntry.isFile()) {
      return {
        schema: 'axion-reference-status/v1', status: 'invalid', manifest: null, references: [],
        issues: ['Reference manifest must be a regular project-local file.'],
      };
    }
    let manifestResult;
    try { manifestResult = this.readManifest(); }
    catch (error) {
      return {
        schema: 'axion-reference-status/v1', status: 'invalid', manifest: null, references: [],
        issues: [error?.message ?? String(error)],
      };
    }
    if (manifestResult.artifact.references.length === 0) {
      return {
        schema: 'axion-reference-status/v1', status: 'invalid',
        manifest: { path: manifestResult.path, sha256: manifestResult.sha256 }, references: [],
        issues: ['Reference manifest must contain at least one registered reference.'],
      };
    }

    const issues = [];
    const expectedKinds = {
      decomposition: REFERENCE_KINDS.decomposition,
      mapping: REFERENCE_KINDS.mapping,
      plan: REFERENCE_KINDS.plan,
      comparison: REFERENCE_KINDS.comparison,
    };
    const references = manifestResult.artifact.references.map((reference) => {
      const paths = this.artifactPaths(reference.id);
      const stages = {};
      let comparison = null;
      for (const stage of Object.keys(expectedKinds)) {
        const absolute = resolve(this.projectRoot, paths[stage]);
        try { lstatSync(absolute); }
        catch (error) {
          if (error?.code === 'ENOENT') { stages[stage] = 'missing'; continue; }
          stages[stage] = 'invalid';
          issues.push(`${reference.id}/${stage}: ${error?.message ?? String(error)}`);
          continue;
        }
        try {
          const result = this.readArtifact(paths[stage]);
          if (result.artifact.kind !== expectedKinds[stage] || result.artifact.referenceId !== reference.id) {
            throw new ReferenceValidationError([`${paths[stage]} is not ${expectedKinds[stage]} for ${reference.id}`]);
          }
          stages[stage] = 'valid';
          if (stage === 'comparison') {
            comparison = {
              status: result.artifact.status,
              highestDeltas: result.artifact.highestDeltas.slice(0, 3),
            };
          }
        } catch (error) {
          stages[stage] = 'invalid';
          issues.push(`${reference.id}/${stage}: ${error?.message ?? String(error)}`);
        }
      }
      return {
        id: reference.id,
        sha256: reference.sha256,
        provenance: { type: reference.provenance.type, source: reference.provenance.source },
        licence: reference.licence.status,
        viewport: reference.viewport,
        authorizedScope: reference.authorizedScope,
        stages,
        comparison,
      };
    });
    const stageStates = references.flatMap((reference) => Object.values(reference.stages));
    const comparisonStates = references.map((reference) => reference.comparison?.status).filter(Boolean);
    const status = issues.length || stageStates.includes('invalid') ? 'invalid'
      : stageStates.includes('missing') ? 'incomplete'
        : comparisonStates.every((value) => value === 'match') ? 'complete'
          : 'needs-repair';
    return {
      schema: 'axion-reference-status/v1', status,
      manifest: { path: manifestResult.path, sha256: manifestResult.sha256 },
      references, issues: issues.slice(0, 24),
    };
  }

  verifyManifestAssets(manifest) {
    assertValidReferenceArtifact(manifest);
    for (const reference of manifest.references) {
      const loaded = readRegularFileInside(this.projectRoot, reference.storedPath, {
        label: `stored reference ${reference.id}`,
        maxBytes: REFERENCE_LIMITS.maxBytesPerReference,
      });
      const metadata = inspectImage(loaded.bytes, extname(loaded.relative));
      if (metadata.sha256 !== reference.sha256 || metadata.bytes !== reference.bytes
        || metadata.width !== reference.width || metadata.height !== reference.height
        || metadata.format !== reference.format) {
        throw new ReferenceSystemError('DK_REFERENCE_INTEGRITY', `stored asset does not match manifest: ${reference.id}`);
      }
    }
    return true;
  }

  verifyComparisonAsset(comparison, manifest) {
    const candidate = comparison.candidate;
    const expectedExtension = { png: 'png', jpeg: 'jpg', webp: 'webp' }[candidate.format];
    const expectedPath = `${this.directory}/assets/${candidate.sha256}.${expectedExtension}`;
    if (candidate.path !== expectedPath) {
      throw new ReferenceSystemError('DK_REFERENCE_INTEGRITY', 'comparison candidate path is not content-addressed');
    }
    const loaded = readRegularFileInside(this.projectRoot, candidate.path, {
      label: 'comparison candidate',
      maxBytes: REFERENCE_LIMITS.maxBytesPerReference,
    });
    const metadata = inspectImage(loaded.bytes, extname(candidate.path));
    if (metadata.sha256 !== candidate.sha256 || metadata.bytes !== candidate.bytes
      || metadata.width !== candidate.width || metadata.height !== candidate.height
      || metadata.format !== candidate.format) {
      throw new ReferenceSystemError('DK_REFERENCE_INTEGRITY', 'comparison candidate does not match its recorded evidence');
    }
    const reference = requireReference(manifest, comparison.referenceId);
    const referenceFile = readRegularFileInside(this.projectRoot, reference.storedPath, {
      label: `stored reference ${reference.id}`,
      maxBytes: REFERENCE_LIMITS.maxBytesPerReference,
    });
    const recomputed = compareImageEvidence(reference, referenceFile.bytes, candidate.path, loaded.bytes);
    if (JSON.stringify(recomputed.metrics) !== JSON.stringify(comparison.metrics)) {
      throw new ReferenceSystemError('DK_REFERENCE_INTEGRITY', 'comparison metrics do not match the stored reference and candidate bytes');
    }
    return true;
  }

  verifyComparisonSources(comparison, manifest, plan) {
    const current = scanWholeReferenceBackground(
      this.projectRoot,
      manifest,
      plan.verification.implementationFiles,
    );
    if (JSON.stringify(current) !== JSON.stringify(comparison.policy.noWholeReferenceBackground)) {
      throw new ReferenceSystemError(
        'DK_REFERENCE_STALE',
        'comparison source evidence is stale; implementation files changed after the comparison',
      );
    }
    return true;
  }

  verifyComparisonCapture(comparison, manifest, plan) {
    // An unattested comparison is intentionally durable advisory evidence. It
    // may remain `review`, but schema/status validation prevents it from ever
    // becoming `match` or making repository status complete.
    if (comparison.capture.status !== 'attested') return true;
    const reference = requireReference(manifest, comparison.referenceId);
    const current = buildAppProofCaptureAttestation(this.projectRoot, {
      candidatePath: comparison.capture.case.screenshot.path,
      candidate: comparison.candidate,
      reference,
      viewport: plan.verification.viewports[0],
    });
    if (current.status !== 'attested') {
      const stale = /stale|current|source changed/i.test(current.reason ?? '');
      throw new ReferenceSystemError(
        stale ? 'DK_REFERENCE_STALE' : 'DK_REFERENCE_ATTESTATION',
        `comparison capture attestation is no longer valid: ${current.reason}`,
      );
    }
    if (JSON.stringify(current) !== JSON.stringify(comparison.capture)) {
      throw new ReferenceSystemError(
        'DK_REFERENCE_ATTESTATION',
        'comparison capture attestation no longer matches the trusted App Proof and evidence ledger',
      );
    }
    return true;
  }

  readLinkedArtifact(link, expectedKind) {
    if (!link || typeof link.path !== 'string' || typeof link.sha256 !== 'string') {
      throw new ReferenceValidationError(['linked artifact reference is invalid']);
    }
    const loaded = this.readArtifact(link.path);
    if (loaded.sha256 !== link.sha256) throw new ReferenceSystemError('DK_REFERENCE_INTEGRITY', `linked artifact digest mismatch: ${link.path}`);
    if (loaded.artifact.kind !== expectedKind) throw new ReferenceValidationError([`${link.path} must be ${expectedKind}`]);
    if (expectedKind === REFERENCE_KINDS.manifest) this.verifyManifestAssets(loaded.artifact);
    return loaded;
  }

  assertArtifactPath(path) {
    const relativePath = relativeProjectPath(this.projectRoot, path, 'artifact path');
    if (relativePath !== this.paths.manifest && !relativePath.startsWith(`${this.directory}/`)) {
      throw new ReferenceSystemError('DK_REFERENCE_UNSAFE_PATH', 'artifact must stay inside the configured reference directory');
    }
    if (!relativePath.endsWith('.json')) throw new ReferenceValidationError(['reference artifact path must end in .json']);
    return relativePath;
  }

  writeJson(path, artifact) {
    if (artifact.projectRootSha256 !== this.projectRootSha256) {
      throw new ReferenceValidationError(['refusing to write an artifact bound to another project root']);
    }
    const relativePath = this.assertArtifactPath(path);
    const bytes = Buffer.from(`${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    if (bytes.length > REFERENCE_LIMITS.maxArtifactBytes) {
      throw new ReferenceSystemError('DK_REFERENCE_FILE_SIZE', `artifact exceeds ${REFERENCE_LIMITS.maxArtifactBytes} bytes`);
    }
    const absolute = resolveInsideProject(this.projectRoot, relativePath, 'artifact path');
    safeWriteFileSync(this.projectRoot, absolute, bytes, { mode: 0o644 });
    return { path: relativePath, sha256: sha256(bytes), bytes: bytes.length, artifact };
  }

  writeContentAddressedAsset(path, bytes, expectedSha256) {
    const relativePath = relativeProjectPath(this.projectRoot, path, 'asset path');
    if (!relativePath.startsWith(`${this.directory}/assets/`)) {
      throw new ReferenceSystemError('DK_REFERENCE_UNSAFE_PATH', 'reference assets must stay inside the reference assets directory');
    }
    const expectedName = `${expectedSha256}${extname(relativePath).toLowerCase()}`;
    if (!relativePath.endsWith(`/${expectedName}`)) {
      throw new ReferenceSystemError('DK_REFERENCE_INTEGRITY', 'reference asset filename must be content-addressed');
    }
    const absolute = resolveInsideProject(this.projectRoot, relativePath, 'asset path');
    if (existsSync(absolute)) {
      const st = lstatSync(absolute);
      if (st.isSymbolicLink() || !st.isFile()) throw new ReferenceSystemError('DK_REFERENCE_UNSAFE_PATH', 'existing asset is not a regular file');
      const loaded = readRegularFileInside(this.projectRoot, relativePath, { label: 'existing reference asset', maxBytes: REFERENCE_LIMITS.maxBytesPerReference });
      if (sha256(loaded.bytes) !== expectedSha256) throw new ReferenceSystemError('DK_REFERENCE_INTEGRITY', 'content-addressed asset contains unexpected bytes');
      return relativePath;
    }
    safeWriteFileSync(this.projectRoot, absolute, bytes, { mode: 0o644 });
    return relativePath;
  }

  timestamp() {
    const value = this.clock();
    const date = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(date.getTime())) throw new ReferenceSystemError('DK_REFERENCE_CLOCK', 'clock must return a valid date');
    return date.toISOString();
  }
}

export function createReferenceSystem(projectRoot, options = {}) {
  return new ReferenceSystem(projectRoot, options);
}

function normalizeRegistrationInput(value, index, now) {
  requireInputObject(value, `references[${index}]`);
  const id = safeId(value.id, `references[${index}].id`);
  if (typeof value.path !== 'string' || !value.path.trim()) throw new ReferenceValidationError([`references[${index}].path is required`]);
  const provenance = {
    type: value.provenance?.type,
    source: value.provenance?.source,
    capturedAt: value.provenance?.capturedAt ?? (value.provenance?.type === 'url-capture' ? now : null),
    author: value.provenance?.author ?? null,
    notes: value.provenance?.notes ?? null,
  };
  const licence = {
    status: value.licence?.status,
    identifier: value.licence?.identifier ?? null,
    termsUrl: value.licence?.termsUrl ?? null,
    attribution: value.licence?.attribution ?? null,
    notes: value.licence?.notes ?? null,
  };
  const viewport = {
    width: value.viewport?.width,
    height: value.viewport?.height,
    deviceScaleFactor: value.viewport?.deviceScaleFactor ?? 1,
  };
  const authorizedScope = {
    projectPaths: value.authorizedScope?.projectPaths ?? [],
    routes: value.authorizedScope?.routes ?? [],
    operations: value.authorizedScope?.operations ?? [],
    notes: value.authorizedScope?.notes ?? null,
  };
  // Reuse the manifest validator as the authoritative metadata contract.
  const probe = {
    kind: REFERENCE_KINDS.manifest,
    artifactId: 'reference-manifest',
    createdAt: now,
    projectRootSha256: '0'.repeat(64),
    limits: {
      maxReferences: REFERENCE_LIMITS.maxReferences,
      maxBytesPerReference: REFERENCE_LIMITS.maxBytesPerReference,
      allowedFormats: [...REFERENCE_LIMITS.allowedFormats],
    },
    references: [{
      id, originalPath: 'placeholder.png', storedPath: 'placeholder.png', format: 'png', mediaType: 'image/png',
      bytes: 1, width: 1, height: 1, sha256: '0'.repeat(64), provenance, licence, viewport, authorizedScope,
    }],
  };
  const metadataIssues = validateReferenceArtifact(probe).filter((issue) => !issue.startsWith('projectRootSha256'));
  if (metadataIssues.length) throw new ReferenceValidationError(metadataIssues);
  return { id, path: value.path, provenance, licence, viewport, authorizedScope };
}

function normalizeAuthor(value = {}) {
  return { type: value.type ?? 'codex', name: value.name ?? null, model: value.model ?? null };
}

function requireInputObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ReferenceValidationError([`${label} input must be an object`]);
}

function requireReference(manifest, id) {
  const safe = safeId(id, 'referenceId');
  const reference = manifest.references.find((entry) => entry.id === safe);
  if (!reference) throw new ReferenceValidationError([`referenceId is not registered: ${safe}`]);
  return reference;
}

function safeId(value, label) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,127}$/.test(value)) {
    throw new ReferenceValidationError([`${label} must be a lowercase safe id`]);
  }
  return value;
}

function artifactReference(result) {
  return { path: result.path, sha256: result.sha256 };
}
