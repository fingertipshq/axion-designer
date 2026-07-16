import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  REFERENCE_KINDS,
  REFERENCE_LIMITS,
  ReferenceSystemError,
  ReferenceValidationError,
  compareImageEvidence,
  createReferenceSystem,
  inspectImage,
  pngPixelStats,
  validateReferenceArtifact,
} from '../src/reference/index.mjs';
import { writeTrustedAppProofFixture } from './reference-proof-fixture.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
let assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions++; };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const throwsReference = (fn, pattern, message) => {
  assert.throws(fn, (error) => (
    (error instanceof ReferenceSystemError || error instanceof ReferenceValidationError)
    && pattern.test(error.message)
  ), message);
  assertions++;
};

const root = mkdtempSync(join(tmpdir(), 'axion-reference-'));
try {
  mkdirSync(join(root, 'fixtures'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  const referencePng = png(4, 3, (x, y) => [x * 40, y * 60, 120, 255]);
  const changedPng = png(4, 3, () => [240, 20, 10, 255]);
  const resizedPng = png(2, 2, () => [20, 30, 40, 255]);
  writeFileSync(join(root, 'fixtures', 'home.png'), referencePng);
  writeFileSync(join(root, 'fixtures', 'changed.png'), changedPng);
  writeFileSync(join(root, 'fixtures', 'resized.png'), resizedPng);
  writeFileSync(join(root, 'fixtures', 'photo.jpg'), jpeg(6, 5));
  writeFileSync(join(root, 'fixtures', 'panel.webp'), webp(7, 4));
  writeFileSync(join(root, 'src', 'App.tsx'), 'export function App() { return <main>Home</main>; }\n');

  const fixedTime = '2026-07-16T00:00:00.000Z';
  const system = createReferenceSystem(root, { clock: () => fixedTime });
  eq(system.paths.manifest, '.dk/reference/reference-manifest.json', 'default evidence directory is project-local and stable');
  eq(system.projectRootSha256, createHash('sha256').update(realpathSync(root)).digest('hex'), 'project binding hashes the canonical project root');

  const manifestResult = system.registerReferences([
    registration('home', 'fixtures/home.png', 4, 3),
    registration('photo', 'fixtures/photo.jpg', 6, 5),
    registration('panel', 'fixtures/panel.webp', 7, 4),
  ]);
  eq(manifestResult.artifact.kind, REFERENCE_KINDS.manifest, 'registration writes the versioned manifest artifact');
  eq(manifestResult.artifact.references.map((entry) => entry.format), ['png', 'jpeg', 'webp'], 'PNG, JPEG, and WebP magic and dimensions are registered');
  ok(manifestResult.artifact.references.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)), 'every reference records a SHA-256 digest');
  ok(manifestResult.artifact.references.every((entry) => /^\.dk\/reference\/assets\/[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(entry.storedPath)),
    'stored assets are content-addressed under the safe reference directory');
  eq(system.readManifest().sha256, manifestResult.sha256, 'manifest round-trips with its durable file digest');
  eq(system.validateArtifact(system.paths.manifest), [], 'public read/validate API accepts a fully linked manifest');

  const appended = system.registerReferences([
    registration('home-copy', 'fixtures/home.png', 4, 3),
    registration('small', 'fixtures/resized.png', 2, 2),
  ]);
  eq(appended.artifact.references.length, 5, 'the manifest supports exactly five registered references');
  eq(appended.artifact.references[0].storedPath, appended.artifact.references[3].storedPath,
    'identical bytes safely reuse the same content-addressed asset');
  throwsReference(() => system.registerReferences([registration('sixth', 'fixtures/home.png', 4, 3)]), /at most 5/,
    'a sixth reference fails closed');

  const decomposition = system.writeVisualDecomposition({
    referenceId: 'home',
    authoredBy: { type: 'codex', name: 'Axion', model: 'gpt-test' },
    global: {
      summary: 'Compact product landing page.',
      layout: ['single-column shell', 'hero above action row'],
      palette: ['navy surface', 'warm accent'],
      typography: ['display heading', 'compact body'],
      spacing: ['8px base rhythm'],
    },
    regions: [
      region('hero', 'Hero', 'section', { x: 0, y: 0, width: 4, height: 2 }),
      region('action', 'Primary action', 'control', { x: 0, y: 2, width: 4, height: 1 }),
    ],
    assumptions: ['The lower row is interactive.'],
    unresolved: [],
  });
  eq(decomposition.artifact.kind, REFERENCE_KINDS.decomposition, 'Codex-authored decomposition is a versioned artifact');
  eq(decomposition.artifact.canvas, { width: 4, height: 3 }, 'decomposition canvas is mechanically bound to registered dimensions');
  eq(system.validateArtifact(decomposition.path), [], 'decomposition validates against its manifest digest and reference id');
  throwsReference(() => system.writeVisualDecomposition({
    referenceId: 'home',
    global: decomposition.artifact.global,
    regions: [region('outside', 'Outside', 'section', { x: 3, y: 0, width: 2, height: 1 })],
  }), /exceeds canvas width/, 'region bounds cannot claim pixels outside the registered reference');

  // Restore the valid decomposition after the deliberately rejected write.
  eq(system.readArtifact(decomposition.path).sha256, decomposition.sha256, 'failed validation cannot replace the previous artifact');

  const mapping = system.writeComponentMapping({
    referenceId: 'home',
    authoredBy: { type: 'codex', name: null, model: null },
    mappings: [{
      id: 'landing-shell',
      regionIds: ['hero', 'action'],
      target: { projectPath: 'src/App.tsx', exportName: 'App', route: '/' },
      strategy: 'adapt',
      rationale: 'The existing route owns both regions.',
      confidence: 0.95,
    }],
    unmappedRegions: [],
  });
  eq(mapping.artifact.kind, REFERENCE_KINDS.mapping, 'component mapping is versioned and linked to decomposition evidence');
  eq(system.validateArtifact(mapping.path), [], 'mapping covers every decomposition region exactly once');
  throwsReference(() => system.writeComponentMapping({
    referenceId: 'home',
    mappings: [{
      id: 'unsafe', regionIds: ['hero', 'action'],
      target: { projectPath: 'server/secrets.ts', exportName: null, route: '/' },
      strategy: 'create', rationale: 'Unsafe target.', confidence: 0.5,
    }],
    unmappedRegions: [],
  }), /outside the reference authorized scope/, 'mapping cannot target a path outside declared authorization');
  throwsReference(() => system.writeComponentMapping({
    referenceId: 'home',
    mappings: [{
      id: 'partial', regionIds: ['hero'],
      target: { projectPath: 'src/App.tsx', exportName: null, route: '/' },
      strategy: 'adapt', rationale: 'Only one region.', confidence: 0.5,
    }],
    unmappedRegions: [],
  }), /does not account for region: action/, 'mapping cannot silently omit a decomposed region');

  const plan = system.writeReconstructionPlan({
    referenceId: 'home',
    authoredBy: { type: 'codex', name: 'Axion', model: null },
    rules: { assetReuse: 'exact-or-cropped' },
    steps: [
      {
        id: 'build-ui', order: 1, title: 'Adapt the landing shell', action: 'modify',
        targets: ['src/App.tsx'], mappingIds: ['landing-shell'], dependsOn: [],
        acceptance: ['Both mapped regions are represented with real elements.'],
      },
      {
        id: 'verify-ui', order: 2, title: 'Compare the render', action: 'verify',
        targets: [], mappingIds: ['landing-shell'], dependsOn: ['build-ui'],
        acceptance: ['Desktop comparison is current and the background-cheat scan passes.'],
      },
    ],
    verification: {
      viewports: [{ name: 'reference', width: 4, height: 3, deviceScaleFactor: 1 }],
      implementationFiles: ['src/App.tsx'],
      requiredComparisons: 1,
    },
  });
  eq(plan.artifact.kind, REFERENCE_KINDS.plan, 'reconstruction plan is a versioned artifact');
  eq(plan.artifact.rules.noWholeReferenceBackground, true, 'whole-reference background prevention is mandatory, not an author choice');
  eq(system.validateArtifact(plan.path), [], 'plan validates mapping ids, dependency order, scope, verification, and mandatory rules');
  throwsReference(() => system.writeReconstructionPlan({
    referenceId: 'home',
    steps: [{
      id: 'only-build', order: 1, title: 'Build', action: 'modify', targets: ['src/App.tsx'],
      mappingIds: ['landing-shell'], dependsOn: [], acceptance: ['Build succeeds.'],
    }],
    verification: plan.artifact.verification,
  }), /verify action/, 'a plan without a mechanical verification step is rejected');

  throwsReference(() => system.writeReconstructionPlan({
    referenceId: 'home',
    steps: [
      {
        id: 'hidden-target', order: 1, title: 'Change an unscanned file', action: 'modify', targets: ['src/Hidden.tsx'],
        mappingIds: ['landing-shell'], dependsOn: [], acceptance: ['Hidden target changed.'],
      },
      {
        id: 'verify-hidden', order: 2, title: 'Verify', action: 'verify', targets: [],
        mappingIds: ['landing-shell'], dependsOn: ['hidden-target'], acceptance: ['Comparison runs.'],
      },
    ],
    verification: plan.artifact.verification,
  }), /targets must be included in verification\.implementationFiles/,
  'every non-verify plan target must be covered by the anti-cheat scan');

  throwsReference(() => system.writeReconstructionPlan({
    referenceId: 'home',
    steps: [
      {
        id: 'other-target', order: 1, title: 'Change another file', action: 'modify', targets: ['src/Other.tsx'],
        mappingIds: ['landing-shell'], dependsOn: [], acceptance: ['Other target changed.'],
      },
      {
        id: 'verify-other', order: 2, title: 'Verify', action: 'verify', targets: [],
        mappingIds: ['landing-shell'], dependsOn: ['other-target'], acceptance: ['Comparison runs.'],
      },
    ],
    verification: { ...plan.artifact.verification, implementationFiles: ['src/Other.tsx'] },
  }), /must include mapped target: src\/App\.tsx/,
  'verification files cannot omit a mapped component target');

  throwsReference(() => system.writeReconstructionPlan({
    referenceId: 'home', steps: plan.artifact.steps,
    verification: {
      ...plan.artifact.verification,
      viewports: [
        ...plan.artifact.verification.viewports,
        { name: 'extra', width: 4, height: 3, deviceScaleFactor: 1 },
      ],
      requiredComparisons: 2,
    },
  }), /exactly one viewport|requiredComparisons must be 1/,
  'v1 refuses a multi-comparison contract it cannot preserve faithfully');

  throwsReference(() => system.writeReconstructionPlan({
    referenceId: 'home', steps: plan.artifact.steps,
    verification: {
      ...plan.artifact.verification,
      viewports: [{ name: 'wrong', width: 3, height: 3, deviceScaleFactor: 1 }],
    },
  }), /must match the registered reference viewport/,
  'the comparison plan viewport is bound to the registered capture viewport');

  const copiedBytes = system.compareReference({
    referenceId: 'home',
    candidatePath: 'fixtures/home.png',
    implementationFiles: ['src/App.tsx'],
  });
  eq(copiedBytes.artifact.capture.status, 'unattested', 'an arbitrary repository image has no browser-capture attestation');
  eq(copiedBytes.artifact.status, 'review', 'reference-identical bytes cannot match without an attested App Proof case');
  ok(copiedBytes.artifact.highestDeltas.some((delta) => delta.source === 'attestation'
      && /App Proof|capture attestation/i.test(delta.summary)),
  'unattested same-byte evidence explains the exact reason in the bounded delta surface');

  const proofFixture = writeTrustedAppProofFixture(root, {
    screenshotBytes: referencePng,
    width: 4,
    height: 3,
    viewportName: 'reference',
    sourcePaths: ['src/App.tsx'],
    startedAt: '2026-07-15T00:00:00.000Z',
  });
  const exact = system.compareReference({
    referenceId: 'home',
    candidatePath: proofFixture.screenshotPath,
    implementationFiles: ['src/App.tsx'],
  });
  eq(exact.artifact.kind, REFERENCE_KINDS.comparison, 'comparison is a versioned artifact');
  eq(exact.artifact.reconstructionPlan.path, plan.path, 'comparison is digest-bound to the validated reconstruction plan');
  eq(exact.artifact.reconstructionPlan.sha256, plan.sha256, 'comparison records the exact reconstruction plan digest');
  eq(exact.artifact.metrics.exactHashMatch, true, 'comparison reports exact image hash equality');
  eq(exact.artifact.metrics.dimensions.match, true, 'comparison reports exact PNG dimensions');
  eq(exact.artifact.metrics.pixelStats.normalizedMeanDelta, 0, 'supported PNGs receive deterministic optional pixel statistics');
  eq(exact.artifact.highestDeltas, [], 'an exact comparison has no invented delta');
  eq(exact.artifact.policy.noWholeReferenceBackground.status, 'pass', 'clean source files produce a mechanical anti-cheat pass');
  eq(exact.artifact.capture.status, 'attested', 'the exact successful App Proof screenshot path is mechanically attested');
  eq(exact.artifact.capture.case.route.path, '/', 'capture attestation binds the concrete route');
  eq(exact.artifact.capture.case.state, 'default', 'capture attestation binds the concrete state');
  eq(exact.artifact.capture.case.theme, 'light', 'capture attestation binds the concrete theme');
  eq(exact.artifact.capture.case.viewport, plan.artifact.verification.viewports[0],
    'capture attestation binds reference width, height, viewport name, and DPR');
  eq(exact.artifact.capture.case.screenshot.sha256, exact.artifact.candidate.sha256,
    'capture attestation binds the durable candidate bytes to the browser screenshot digest');
  eq(exact.artifact.status, 'match', 'exact bytes plus a passed policy produce match status');
  ok(/^\.dk\/reference\/assets\/[a-f0-9]{64}\.png$/.test(exact.artifact.candidate.path),
    'candidate evidence is copied to an authorized content-addressed asset path');
  eq(system.validateArtifact(exact.path), [], 'public validation verifies comparison and manifest binding');
  const exactBytes = readFileSync(join(root, exact.path));
  const tamperedStatus = JSON.parse(exactBytes.toString('utf8'));
  tamperedStatus.status = 'review';
  writeFileSync(join(root, exact.path), `${JSON.stringify(tamperedStatus, null, 2)}\n`);
  ok(system.validateArtifact(exact.path).some((issue) => /status must be match|inputsSha256/.test(issue)),
    'a hand-edited passing status cannot survive deterministic validation');
  writeFileSync(join(root, exact.path), exactBytes);
  const tamperedPlanLink = JSON.parse(exactBytes.toString('utf8'));
  tamperedPlanLink.reconstructionPlan.sha256 = '0'.repeat(64);
  writeFileSync(join(root, exact.path), `${JSON.stringify(tamperedPlanLink, null, 2)}\n`);
  ok(system.validateArtifact(exact.path).some((issue) => /linked artifact digest mismatch/.test(issue)),
    'a comparison cannot silently detach from its reconstruction plan');
  writeFileSync(join(root, exact.path), exactBytes);
  const appBytesBeforeStaleCheck = readFileSync(join(root, 'src', 'App.tsx'));
  const appStatBeforeStaleCheck = statSync(join(root, 'src', 'App.tsx'));
  writeFileSync(join(root, 'src', 'App.tsx'), Buffer.concat([
    appBytesBeforeStaleCheck,
    Buffer.from('// changed after compare\n'),
  ]));
  ok(system.validateArtifact(exact.path).some((issue) => /source evidence is stale/.test(issue)),
    'source changes after comparison invalidate the recorded anti-cheat evidence');
  writeFileSync(join(root, 'src', 'App.tsx'), appBytesBeforeStaleCheck);
  utimesSync(join(root, 'src', 'App.tsx'), appStatBeforeStaleCheck.atime, appStatBeforeStaleCheck.mtime);
  eq(system.validateArtifact(exact.path), [], 'restoring source bytes restores comparison freshness');

  const proofBytes = readFileSync(join(root, proofFixture.proofPath));
  const proofStat = statSync(join(root, proofFixture.proofPath));
  const tamperedProof = JSON.parse(proofBytes);
  tamperedProof.configHash = 'f'.repeat(64);
  writeFileSync(join(root, proofFixture.proofPath), `${JSON.stringify(tamperedProof, null, 2)}\n`);
  ok(system.validateArtifact(exact.path).some((issue) => /capture attestation|App Proof/i.test(issue)),
    'tampering the App Proof artifact invalidates an already-attested comparison on read');
  writeFileSync(join(root, proofFixture.proofPath), proofBytes);
  utimesSync(join(root, proofFixture.proofPath), proofStat.atime, proofStat.mtime);
  eq(system.validateArtifact(exact.path), [], 'restoring the exact App Proof bytes and timestamp restores its digest-bound comparison');

  const ledgerBytes = readFileSync(join(root, proofFixture.ledgerPath));
  const ledgerStat = statSync(join(root, proofFixture.ledgerPath));
  const tamperedLedger = JSON.parse(ledgerBytes);
  tamperedLedger.runtimeVersion = 'tampered-runtime';
  writeFileSync(join(root, proofFixture.ledgerPath), `${JSON.stringify(tamperedLedger)}\n`);
  ok(system.validateArtifact(exact.path).some((issue) => /capture attestation|evidence ledger/i.test(issue)),
    'changing the attesting ledger invalidates the proof-bound comparison even when its pass fields remain plausible');
  writeFileSync(join(root, proofFixture.ledgerPath), ledgerBytes);
  utimesSync(join(root, proofFixture.ledgerPath), ledgerStat.atime, ledgerStat.mtime);
  eq(system.validateArtifact(exact.path), [], 'restoring the exact evidence ledger restores capture attestation');

  writeFileSync(join(root, 'src', 'Unrelated.tsx'), 'export const changedAfterProof = true;\n');
  const afterProof = new Date(Date.parse(proofFixture.finishedAt) + 60_000);
  utimesSync(join(root, 'src', 'Unrelated.tsx'), afterProof, afterProof);
  ok(system.validateArtifact(exact.path).some((issue) => /capture attestation|stale|source changed|not current/i.test(issue)),
    'a source newer than App Proof makes the capture attestation stale even outside the comparison file list');
  rmSync(join(root, 'src', 'Unrelated.tsx'));
  eq(system.validateArtifact(exact.path), [], 'removing the post-proof source restores the previously attested repository state');

  const changed = system.compareReference({
    referenceId: 'home',
    candidatePath: 'fixtures/changed.png',
    implementationFiles: ['src/App.tsx'],
    regionFindings: [{
      id: 'hero-color', regionId: 'hero', type: 'color', severity: 'high', score: 0.8,
      summary: 'Hero palette diverges from the reference.', evidence: ['visual review'],
    }],
  });
  eq(changed.artifact.metrics.exactHashMatch, false, 'non-identical candidate bytes are explicit');
  ok(changed.artifact.metrics.pixelStats.normalizedMeanDelta > 0, 'pixel-stat delta is computed when compatible PNG dimensions match');
  ok(changed.artifact.highestDeltas.length >= 1 && changed.artifact.highestDeltas.length <= 3,
    'comparison returns only the highest one-to-three material deltas');
  eq(changed.artifact.highestDeltas[0].id, 'region-hero-color', 'highest deltas are deterministically score-sorted');
  eq(changed.artifact.status, 'mismatch', 'a high-scoring supplied region finding produces mismatch status');

  const resized = system.compareReference({
    referenceId: 'home', candidatePath: 'fixtures/resized.png', implementationFiles: ['src/App.tsx'],
  });
  eq(resized.artifact.metrics.dimensions, {
    match: false,
    reference: { width: 4, height: 3 }, candidate: { width: 2, height: 2 },
    widthDeltaPx: 2, heightDeltaPx: 1, aspectRatioDelta: 0.333333,
  }, 'dimension comparison records both sides and exact deltas');
  eq(resized.artifact.metrics.pixelStats, null, 'pixel statistics stay optional when dimensions cannot be compared safely');

  throwsReference(() => system.compareReference({ referenceId: 'home', candidatePath: 'fixtures/home.png' }),
    /explicitly include every file/, 'comparison fails closed when the implementation scan is omitted');
  throwsReference(() => system.compareReference({
    referenceId: 'home', candidatePath: 'fixtures/home.png', implementationFiles: ['src/App.tsx', 'src/Extra.tsx'],
  }), /exactly match/, 'comparison cannot scan a different file set than the reconstruction plan');
  throwsReference(() => system.compareReference({
    referenceId: 'small', candidatePath: 'fixtures/resized.png', implementationFiles: ['src/App.tsx'],
  }), /reconstruction plan is required/, 'comparison cannot skip decomposition, mapping, and planning');

  const referenceAsset = appended.artifact.references.find((entry) => entry.id === 'home').storedPath;
  writeFileSync(join(root, 'src', 'App.tsx'), `.page { background-image: url("/${referenceAsset}"); }\n`);
  const cheat = system.compareReference({
    referenceId: 'home', candidatePath: proofFixture.screenshotPath, implementationFiles: ['src/App.tsx'],
  });
  eq(cheat.artifact.policy.noWholeReferenceBackground.status, 'fail', 'whole registered reference used as a CSS background is detected');
  eq(cheat.artifact.highestDeltas[0].source, 'policy', 'anti-cheat failure outranks cosmetic differences');
  eq(cheat.artifact.highestDeltas[0].severity, 'critical', 'whole-image background cheating is a critical delta');
  eq(cheat.artifact.status, 'mismatch', 'anti-cheat failure cannot pass even with an exact screenshot');

  throwsReference(() => system.compareReference({
    referenceId: 'home', candidatePath: '../outside.png', implementationFiles: ['src/App.tsx'],
  }), /fixed project root/, 'candidate traversal cannot escape the fixed project root');

  const wrong = join(root, 'fixtures', 'wrong.png');
  writeFileSync(wrong, jpeg(2, 2));
  throwsReference(() => system.registerReferences([registration('wrong', 'fixtures/wrong.png', 2, 2)], { replace: true }), /bytes are jpeg.*declares \.png/,
    'extension spoofing is rejected by magic-byte inspection');
  const huge = join(root, 'fixtures', 'huge.png');
  writeFileSync(huge, Buffer.from([0]));
  truncateSync(huge, REFERENCE_LIMITS.maxBytesPerReference + 1);
  throwsReference(() => system.registerReferences([registration('huge', 'fixtures/huge.png', 1, 1)], { replace: true }), /maximum is 20971520/,
    'reference size is bounded before parsing');

  const schema = JSON.parse(readFileSync(join(repo, 'reference.schema.json'), 'utf8'));
  eq(schema.oneOf.length, 5, 'published JSON Schema exposes all five artifact contracts');
  eq([
    schema.$defs.referenceManifest.allOf[1].properties.kind.const,
    schema.$defs.visualDecomposition.properties.kind.const,
    schema.$defs.componentMapping.properties.kind.const,
    schema.$defs.reconstructionPlan.properties.kind.const,
    schema.$defs.referenceComparison.properties.kind.const,
  ], Object.values(REFERENCE_KINDS), 'runtime and published schema use the same versioned kinds');

  const structurallyBad = structuredClone(exact.artifact);
  structurallyBad.highestDeltas = [
    { id: 'low', type: 'x', severity: 'low', score: 0.1, summary: 'low', source: 'metric' },
    { id: 'high', type: 'x', severity: 'high', score: 0.9, summary: 'high', source: 'metric' },
  ];
  ok(validateReferenceArtifact(structurallyBad, { manifest: appended.artifact }).some((issue) => /descending score/.test(issue)),
    'pure public validator rejects a dishonest highest-delta ordering');

  const unknownLicenceManifest = structuredClone(appended.artifact);
  unknownLicenceManifest.references[0].licence.status = 'unknown';
  ok(validateReferenceArtifact(unknownLicenceManifest).some((issue) => /may only contain decompose/.test(issue)),
    'the public core API cannot authorize reconstruction operations under an unknown licence');
  unknownLicenceManifest.references[0].authorizedScope.operations = ['decompose'];
  ok(validateReferenceArtifact(mapping.artifact, {
    manifest: unknownLicenceManifest,
    decomposition: decomposition.artifact,
  }).some((issue) => /licence is unknown; map-components is not authorized/.test(issue)),
  'unknown-licence evidence may be decomposed but cannot advance to component mapping');

  const linkedBytes = readFileSync(join(root, mapping.path));
  const tampered = JSON.parse(linkedBytes);
  tampered.decomposition.sha256 = 'f'.repeat(64);
  writeFileSync(join(root, mapping.path), `${JSON.stringify(tampered, null, 2)}\n`);
  throwsReference(() => system.readArtifact(mapping.path), /digest mismatch/, 'linked artifact SHA prevents replaying altered decomposition evidence');
} finally {
  rmSync(root, { recursive: true, force: true });
}

const symlinkRoot = mkdtempSync(join(tmpdir(), 'axion-reference-symlink-'));
const symlinkOutside = mkdtempSync(join(tmpdir(), 'axion-reference-outside-'));
try {
  mkdirSync(join(symlinkRoot, '.dk'), { recursive: true });
  symlinkSync(symlinkOutside, join(symlinkRoot, '.dk', 'reference'));
  throwsReference(() => createReferenceSystem(symlinkRoot), /symbolic link/, 'reference output directory cannot redirect writes through a symlink');
} finally {
  rmSync(symlinkRoot, { recursive: true, force: true });
  rmSync(symlinkOutside, { recursive: true, force: true });
}

const sourceSymlinkRoot = mkdtempSync(join(tmpdir(), 'axion-reference-source-link-'));
const outsideImage = join(tmpdir(), `axion-reference-outside-${process.pid}.png`);
try {
  mkdirSync(join(sourceSymlinkRoot, 'fixtures'), { recursive: true });
  writeFileSync(outsideImage, png(1, 1, () => [0, 0, 0, 255]));
  symlinkSync(outsideImage, join(sourceSymlinkRoot, 'fixtures', 'linked.png'));
  const system = createReferenceSystem(sourceSymlinkRoot);
  throwsReference(() => system.registerReferences([registration('linked', 'fixtures/linked.png', 1, 1)]), /symbolic link/,
    'reference sources cannot escape through a symlink');
} finally {
  rmSync(sourceSymlinkRoot, { recursive: true, force: true });
  rmSync(outsideImage, { force: true });
}

eq(inspectImage(png(3, 2, () => [1, 2, 3, 255]), '.png').width, 3, 'public image inspector reads PNG metadata without an API or model');

const spatialReferenceBytes = png(2, 1, (x) => x === 0 ? [255, 0, 0, 255] : [0, 0, 255, 255]);
const spatialCandidateBytes = png(2, 1, (x) => x === 0 ? [0, 0, 255, 255] : [255, 0, 0, 255]);
const spatialMeta = inspectImage(spatialReferenceBytes, '.png');
const spatial = compareImageEvidence({
  id: 'spatial', format: 'png', width: spatialMeta.width, height: spatialMeta.height,
  sha256: spatialMeta.sha256, viewport: { width: 2, height: 1, deviceScaleFactor: 1 },
}, spatialReferenceBytes, 'spatial-candidate.png', spatialCandidateBytes);
eq(spatial.metrics.pixelStats.reference.meanRgba, spatial.metrics.pixelStats.candidate.meanRgba,
  'spatial fixture preserves the same global color mean');
eq(spatial.metrics.pixelStats.reference.standardDeviationRgba, spatial.metrics.pixelStats.candidate.standardDeviationRgba,
  'spatial fixture preserves the same global color distribution');
ok(spatial.metrics.pixelStats.normalizedMeanDelta > 0,
  'position-aware comparison detects pixels moved to different locations');
eq(spatial.metrics.pixelStats.changedPixelRatio, 1, 'spatial comparison records the changed-pixel coverage');

const tinyHeader = Buffer.alloc(13);
tinyHeader.writeUInt32BE(1, 0);
tinyHeader.writeUInt32BE(1, 4);
tinyHeader[8] = 8;
tinyHeader[9] = 6;
const inflateBomb = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', tinyHeader),
  chunk('IDAT', deflateSync(Buffer.alloc(1_000_000))),
  chunk('IEND', Buffer.alloc(0)),
]);
eq(pngPixelStats(inflateBomb), null, 'PNG pixel decoding caps inflation at the IHDR-declared output length');
console.log(`reference-system: ${assertions} assertions passed`);

function registration(id, path, width, height) {
  return {
    id,
    path,
    provenance: { type: 'user-provided', source: `local:${path}`, author: 'test user' },
    licence: { status: 'owned', identifier: 'test-owned' },
    viewport: { width, height, deviceScaleFactor: 1 },
    authorizedScope: {
      projectPaths: ['src/**'],
      routes: ['/'],
      operations: ['decompose', 'map-components', 'plan-reconstruction', 'reconstruct', 'compare', 'extract-assets'],
    },
  };
}

function region(id, label, role, bounds) {
  return {
    id, label, role, bounds: { ...bounds, unit: 'px' },
    description: `${label} region.`, confidence: 0.9,
    visual: {
      layout: 'bounded rectangle', colors: ['sampled from reference'], typography: [], spacing: [], assets: [],
    },
    evidence: [`bounds:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`],
  };
}

function png(width, height, pixel) {
  const rows = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 4);
    row[0] = 0;
    for (let x = 0; x < width; x++) {
      const rgba = pixel(x, y);
      for (let channel = 0; channel < 4; channel++) row[1 + x * 4 + channel] = rgba[channel];
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function jpeg(width, height) {
  const sof = Buffer.alloc(17);
  sof.writeUInt16BE(17, 0);
  sof[2] = 8;
  sof.writeUInt16BE(height, 3);
  sof.writeUInt16BE(width, 5);
  sof[7] = 3;
  sof.set([1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0], 8);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xc0]), sof, Buffer.from([0xff, 0xd9])]);
}

function webp(width, height) {
  const bytes = Buffer.alloc(30);
  bytes.write('RIFF', 0, 'ascii');
  bytes.writeUInt32LE(22, 4);
  bytes.write('WEBP', 8, 'ascii');
  bytes.write('VP8X', 12, 'ascii');
  bytes.writeUInt32LE(10, 16);
  bytes.writeUIntLE(width - 1, 24, 3);
  bytes.writeUIntLE(height - 1, 27, 3);
  return bytes;
}

function chunk(type, data) {
  const typeBytes = Buffer.from(type, 'ascii');
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  typeBytes.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return out;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
