import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeTrustedAppProofFixture } from './reference-proof-fixture.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI = join(ROOT, 'bin', 'dk.mjs');
const project = mkdtempSync(join(tmpdir(), 'axion-reference-cli-'));

try {
  mkdirSync(join(project, 'src'), { recursive: true });
  writeFileSync(join(project, 'reference.png'), png(2, 2, [20, 40, 80, 255]));
  writeFileSync(join(project, 'render.png'), png(2, 2, [20, 40, 80, 255]));
  writeFileSync(join(project, 'src', 'App.tsx'), 'export function App() { return <main>Real DOM</main>; }\n');

  const added = run([
    'reference', 'add', 'home', 'reference.png',
    '--source', 'user-provided fixture', '--license', 'owned',
    '--scope', 'src/**,/', '--viewport', '2x2', '--json',
  ]);
  assert.equal(added.status, 0, added.stderr);
  const registration = JSON.parse(added.stdout);
  assert.equal(registration.schema, 'axion-reference-command/v1');
  assert.equal(registration.status, 'registered');
  assert.equal(registration.reference.id, 'home');
  assert.equal(registration.reference.viewport.width, 2);
  assert.deepEqual(registration.reference.authorizedScope.projectPaths, ['src/**']);
  assert.deepEqual(registration.reference.authorizedScope.routes, ['/']);

  const premature = run(['reference', 'compare', 'home', 'render.png', 'src/App.tsx', '--json']);
  assert.equal(premature.status, 2);
  assert.match(JSON.parse(premature.stdout).error, /reconstruction plan is required/);

  writeDraft('decomposition.json', {
    referenceId: 'home', authoredBy: { type: 'codex', name: 'Axion', model: 'test' },
    global: {
      summary: 'Single real DOM surface.', layout: ['one bounded page'], palette: ['navy'],
      typography: ['clear hierarchy'], spacing: ['compact rhythm'],
    },
    regions: [{
      id: 'page', label: 'Page', role: 'page',
      bounds: { x: 0, y: 0, width: 2, height: 2, unit: 'px' },
      description: 'The complete page region.', confidence: 1,
      visual: { layout: 'single region', colors: ['navy'], typography: ['body'], spacing: ['compact'], assets: [] },
      evidence: ['full 2x2 canvas'],
    }],
    assumptions: [], unresolved: [],
  });
  assert.equal(run(['reference', 'decompose', 'decomposition.json', '--json']).status, 0);
  writeDraft('mapping.json', {
    referenceId: 'home', authoredBy: { type: 'codex', name: 'Axion', model: 'test' },
    mappings: [{
      id: 'app', regionIds: ['page'],
      target: { projectPath: 'src/App.tsx', exportName: 'App', route: '/' },
      strategy: 'adapt', rationale: 'The existing App owns the page.', confidence: 1,
    }],
    unmappedRegions: [],
  });
  assert.equal(run(['reference', 'map', 'mapping.json', '--json']).status, 0);
  writeDraft('plan.json', {
    referenceId: 'home', authoredBy: { type: 'codex', name: 'Axion', model: 'test' },
    rules: { assetReuse: 'exact-or-cropped' },
    steps: [
      {
        id: 'build', order: 1, title: 'Build the page', action: 'modify', targets: ['src/App.tsx'],
        mappingIds: ['app'], dependsOn: [], acceptance: ['Real DOM remains present.'],
      },
      {
        id: 'verify', order: 2, title: 'Verify the render', action: 'verify', targets: [],
        mappingIds: ['app'], dependsOn: ['build'], acceptance: ['Reference comparison is current.'],
      },
    ],
    verification: {
      viewports: [{ name: 'reference', width: 2, height: 2, deviceScaleFactor: 1 }],
      implementationFiles: ['src/App.tsx'], requiredComparisons: 1,
    },
  });
  assert.equal(run(['reference', 'plan', 'plan.json', '--json']).status, 0);

  const copied = run(['reference', 'compare', 'home', 'render.png', 'src/App.tsx', '--json']);
  assert.equal(copied.status, 0, copied.stderr);
  const copiedComparison = JSON.parse(copied.stdout);
  assert.equal(copiedComparison.status, 'review');
  assert.equal(copiedComparison.metrics.exactHashMatch, true);
  assert.equal(copiedComparison.policy.noWholeReferenceBackground.status, 'pass');
  assert.match(copiedComparison.highestDeltas.find((delta) => delta.source === 'attestation')?.summary ?? '',
    /App Proof|capture attestation/i);

  const reviewStatus = run(['reference', 'status', '--json']);
  assert.equal(reviewStatus.status, 0, reviewStatus.stderr);
  assert.equal(JSON.parse(reviewStatus.stdout).status, 'needs-repair');
  const reviewValidation = run(['reference', 'validate', '--json']);
  assert.equal(reviewValidation.status, 1, 'an unattested same-byte image cannot make reference validation complete');

  const proof = writeTrustedAppProofFixture(project, {
    screenshotBytes: readFileSync(join(project, 'render.png')),
    width: 2,
    height: 2,
    viewportName: 'reference',
    sourcePaths: ['src/App.tsx', 'decomposition.json', 'mapping.json', 'plan.json'],
  });
  const compared = run(['reference', 'compare', 'home', proof.screenshotPath, 'src/App.tsx', '--json']);
  assert.equal(compared.status, 0, compared.stderr);
  const comparison = JSON.parse(compared.stdout);
  assert.equal(comparison.status, 'match');
  assert.equal(comparison.metrics.exactHashMatch, true);
  assert.equal(comparison.policy.noWholeReferenceBackground.status, 'pass');

  const status = run(['reference', 'status', '--json']);
  assert.equal(status.status, 0, status.stderr);
  const statusJson = JSON.parse(status.stdout);
  assert.equal(statusJson.status, 'complete');
  assert.equal(statusJson.references[0].stages.comparison, 'valid');
  assert.equal(statusJson.references[0].stages.decomposition, 'valid');

  const validated = run(['reference', 'validate', '--json']);
  assert.equal(validated.status, 0, validated.stderr);
  assert.equal(JSON.parse(validated.stdout).status, 'complete');

  const unknown = run([
    'reference', 'add', 'unknown', 'reference.png', '--source', 'unverified fixture', '--license', 'unknown',
    '--scope', 'src/**', '--viewport', '2x2', '--json',
  ]);
  assert.equal(unknown.status, 0, unknown.stderr);
  assert.deepEqual(JSON.parse(unknown.stdout).reference.authorizedScope.operations, ['decompose']);

  const badViewport = run([
    'reference', 'add', 'bad', 'reference.png', '--source', 'fixture', '--license', 'owned',
    '--scope', 'src/**', '--viewport', 'wide', '--json',
  ]);
  assert.equal(badViewport.status, 2);
  assert.equal(JSON.parse(badViewport.stdout).code, 'DK_REFERENCE_VALIDATION');

  const traversal = run([
    'reference', 'add', 'bad', '../outside.png', '--source', 'fixture', '--license', 'owned',
    '--scope', 'src/**', '--viewport', '2x2', '--json',
  ]);
  assert.equal(traversal.status, 2);
  assert.match(JSON.parse(traversal.stdout).error, /fixed project root/);

  process.stdout.write('reference-cli-system: registration, fixed-root metadata, comparison, status, validation and JSON errors passed\n');
} finally {
  rmSync(project, { recursive: true, force: true });
}

function run(args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: project, encoding: 'utf8', env: { ...process.env, DK_LANG: 'en', NO_COLOR: '1' } });
}

function writeDraft(name, value) {
  writeFileSync(join(project, name), `${JSON.stringify(value, null, 2)}\n`);
}

function png(width, height, rgba) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y++) rows.push(Buffer.from([0, ...Array.from({ length: width }, () => rgba).flat()]));
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])) >>> 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
