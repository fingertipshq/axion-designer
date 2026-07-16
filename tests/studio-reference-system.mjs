#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import { createReferenceSystem } from '../src/reference/index.mjs';
import { collectStudioReferenceState, collectStudioSnapshot } from '../src/studio/data.mjs';
import { startStudio } from '../src/studio/server.mjs';
import { writeTrustedAppProofFixture } from './reference-proof-fixture.mjs';

// Times are anchored to the real clock (offsets preserved) so the fixture's
// pinned artifact times and the indexer's REAL file mtimes stay in the same
// era forever. An absolute wall-clock literal here is a time bomb: the suite
// passes until that instant and fails permanently afterwards.
const CLOCK_BASE = Date.now() - 30 * 60_000;
const atOffset = (minutes) => new Date(CLOCK_BASE + minutes * 60_000).toISOString();

const root = mkdtempSync(join(tmpdir(), 'axion-studio-reference-'));
const outside = join(dirname(root), `axion-reference-outside-${Date.now()}.png`);
const referenceBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const candidateBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlKX7sAAAAASUVORK5CYII=', 'base64');
let studio;

try {
  put('design/tokens.json', JSON.stringify({
    color: { text: { primary: { $type: 'color', $value: '#111111' } } },
  }, null, 2));
  put('index.html', '<!doctype html><html><body><main data-component="Checkout"><button data-component="CheckoutButton">Pay now</button></main></body></html>');

  const empty = await collectStudioReferenceState(root);
  assert.equal(empty.status, 'absent');
  assert.equal(empty.available, false);
  assert.deepEqual(empty.items, []);

  putBytes('fixtures/checkout-reference.png', referenceBytes);
  putBytes('fixtures/checkout-render.png', candidateBytes);
  writeFileSync(outside, referenceBytes);

  let clockTick = 0;
  const referenceSystem = createReferenceSystem(root, {
    clock: () => new Date(CLOCK_BASE + clockTick++ * 60_000),
  });
  const manifestResult = referenceSystem.registerReferences([{
    id: 'checkout-mobile',
    path: 'fixtures/checkout-reference.png',
    provenance: {
      type: 'user-provided', source: 'Internal checkout design brief',
      capturedAt: atOffset(-5), author: 'Design team', notes: 'Approved mobile reference.',
    },
    licence: {
      status: 'owned', identifier: 'internal-owned', termsUrl: null,
      attribution: null, notes: 'Authorized for this repository.',
    },
    viewport: { width: 1, height: 1, deviceScaleFactor: 1 },
    authorizedScope: {
      projectPaths: ['index.html'], routes: ['/'],
      operations: ['decompose', 'map-components', 'plan-reconstruction', 'compare', 'reconstruct'],
      notes: 'Only the checkout surface is authorized.',
    },
  }]);
  referenceSystem.writeVisualDecomposition({
    referenceId: 'checkout-mobile',
    authoredBy: { type: 'codex', name: 'Studio test', model: null },
    global: {
      summary: 'A single compact checkout action.', layout: ['single-column'], palette: ['high-contrast'],
      typography: ['system sans'], spacing: ['compact'],
    },
    regions: [{
      id: 'checkout-action', label: 'Primary checkout action', role: 'control',
      bounds: { x: 0, y: 0, width: 1, height: 1, unit: 'px' },
      description: 'The main payment action.', confidence: 0.98,
      visual: { layout: 'single action', colors: ['primary'], typography: ['label'], spacing: ['compact'], assets: [] },
      evidence: ['registered reference pixel region'],
    }],
    assumptions: [], unresolved: [],
  });
  referenceSystem.writeComponentMapping({
    referenceId: 'checkout-mobile',
    authoredBy: { type: 'codex', name: 'Studio test', model: null },
    mappings: [{
      id: 'checkout', regionIds: ['checkout-action'],
      target: { projectPath: 'index.html', exportName: null, route: '/' },
      strategy: 'adapt', rationale: 'The local preview owns the checkout action.', confidence: 1,
    }],
    unmappedRegions: [],
  });
  const planResult = referenceSystem.writeReconstructionPlan({
    referenceId: 'checkout-mobile',
    authoredBy: { type: 'codex', name: 'Studio test', model: null },
    rules: { assetReuse: 'exact-or-cropped' },
    steps: [
      {
        id: 'build', order: 1, title: 'Adapt checkout', action: 'modify', targets: ['index.html'],
        mappingIds: ['checkout'], dependsOn: [], acceptance: ['The checkout remains real DOM.'],
      },
      {
        id: 'verify', order: 2, title: 'Verify checkout', action: 'verify', targets: [],
        mappingIds: ['checkout'], dependsOn: ['build'], acceptance: ['The scoped render comparison is current.'],
      },
    ],
    verification: {
      viewports: [{ name: 'fixture', width: 1, height: 1, deviceScaleFactor: 1 }],
      implementationFiles: ['index.html'], requiredComparisons: 1,
    },
  });
  const comparisonResult = referenceSystem.compareReference({
    referenceId: 'checkout-mobile',
    candidatePath: 'fixtures/checkout-render.png',
    implementationFiles: ['index.html'],
    regionFindings: [{
      id: 'checkout-action-color', regionId: 'checkout-action', type: 'color', severity: 'high', score: 0.82,
      summary: 'Primary action color and contrast do not match the approved reference.',
      evidence: ['candidate primary action is visually weaker'],
    }],
  });
  const reference = manifestResult.artifact.references[0];
  const candidate = comparisonResult.artifact.candidate;
  const referencePath = reference.storedPath;

  const surface = await collectStudioReferenceState(root);
  assert.equal(surface.schema, 'dk-studio-reference/v1');
  assert.equal(surface.available, true, JSON.stringify(surface));
  assert.equal(surface.status, 'ready');
  assert.equal(surface.items.length, 1);
  assert.equal(surface.items[0].status, 'mismatch');
  assert.equal(surface.items[0].exactMatch, false);
  assert.equal(surface.items[0].highestDeltas[0].dimension, 'color');
  assert.equal(surface.items[0].regions[0].label, 'Primary checkout action');
  assert.equal(surface.items[0].regions[0].bounds.width, 1);
  assert.equal(surface.items[0].provenance.source, 'Internal checkout design brief');
  assert.equal(surface.items[0].provenance.creator, 'Design team');
  assert.equal(surface.items[0].provenance.license, 'owned');
  assert.equal(surface.items[0].capture.status, 'unattested');
  assert.match(surface.items[0].capture.reason, /Candidate is not backed|App Proof/i);
  assert.equal(surface.items[0].capture.proof, null);
  assert.equal(surface.items[0].capture.ledger, null);
  assert.equal(surface.items[0].capture.case, null);
  assert(!['match', 'matched', 'complete', 'completed'].includes(surface.items[0].status),
    'unattested evidence can never surface as matched or complete');
  assert.match(surface.items[0].referenceAsset.url, /^\/api\/reference-asset\/[a-f0-9]{64}$/);
  assert(!JSON.stringify(surface).includes(referencePath), 'snapshot never exposes the authorized filesystem path');
  assert(!JSON.stringify(surface).includes(root), 'snapshot reference surface never exposes the absolute project root');
  assert(!JSON.stringify(surface.items[0].capture).includes('.dk/proof/'), 'Studio omits App Proof filesystem paths');
  assert(!JSON.stringify(surface.items[0].capture).includes('.dk/report.json'), 'Studio omits ledger filesystem paths');

  const snapshot = await collectStudioSnapshot(root, { now: atOffset(3) });
  assert.equal(snapshot.reference.status, 'ready');
  assert.equal(snapshot.reference.pairedCount, 1);

  studio = await startStudio({ root, port: 0, cacheTtl: 0 });
  const apiSnapshot = await getJson('/api/snapshot');
  const item = apiSnapshot.reference.items[0];
  const referenceResponse = await fetch(`${studio.url}${item.referenceAsset.url}`);
  assert.equal(referenceResponse.status, 200);
  assert.equal(referenceResponse.headers.get('content-type'), 'image/png');
  assert.equal(referenceResponse.headers.get('cache-control'), 'no-store');
  assert.match(referenceResponse.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(referenceResponse.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.equal(referenceResponse.headers.get('etag'), `"sha256-${reference.sha256}"`);
  assert.deepEqual(Buffer.from(await referenceResponse.arrayBuffer()), referenceBytes);

  assert.equal((await fetch(`${studio.url}/api/reference-asset/${'f'.repeat(64)}`)).status, 400, 'arbitrary opaque IDs are denied');
  assert.equal((await fetch(`${studio.url}/api/reference-asset/%2e%2e%2fsecret.png`)).status, 400, 'traversal-shaped asset tokens are denied');
  assert.equal((await fetch(`${studio.url}/api/reference-asset/.hidden`)).status, 400, 'dotfile-shaped tokens are denied');

  await browserReferenceCheck();

  const proofFixture = writeTrustedAppProofFixture(root, {
    width: 1,
    height: 1,
    viewportName: 'fixture',
    routeName: 'checkout',
    routePath: '/',
    state: 'ready',
    theme: 'light',
    screenshotBytes: candidateBytes,
    sourcePaths: ['index.html', 'design/tokens.json'],
    startedAt: atOffset(4),
  });
  const attestedComparison = referenceSystem.compareReference({
    referenceId: 'checkout-mobile',
    candidatePath: proofFixture.screenshotPath,
    implementationFiles: ['index.html'],
    regionFindings: [{
      id: 'checkout-action-color', regionId: 'checkout-action', type: 'color', severity: 'high', score: 0.82,
      summary: 'Primary action color and contrast do not match the approved reference.',
      evidence: ['candidate primary action is visually weaker'],
    }],
  });
  assert.equal(attestedComparison.artifact.capture.status, 'attested');

  const attestedSurface = await collectStudioReferenceState(root);
  const attestedItem = attestedSurface.items[0];
  assert.equal(attestedSurface.status, 'ready');
  assert.equal(attestedItem.capture.status, 'attested');
  assert.equal(attestedItem.capture.reason, null);
  assert.equal(attestedItem.capture.case.route.path, '/');
  assert.equal(attestedItem.capture.case.state, 'ready');
  assert.equal(attestedItem.capture.case.theme, 'light');
  assert.equal(attestedItem.capture.case.viewport.name, 'fixture');
  assert.equal(attestedItem.capture.case.capturedAt, proofFixture.finishedAt);
  assert.match(attestedItem.capture.proof.sha256, /^[a-f0-9]{64}$/);
  assert.match(attestedItem.capture.ledger.sha256, /^[a-f0-9]{64}$/);
  assert.equal(attestedItem.status, 'mismatch');
  const publicCaptureJson = JSON.stringify(attestedItem.capture);
  assert(!publicCaptureJson.includes(root), 'attested capture never exposes the project root');
  assert(!publicCaptureJson.includes('.dk/proof/'), 'attested capture never exposes App Proof paths');
  assert(!publicCaptureJson.includes('.dk/report.json'), 'attested capture never exposes the ledger path');
  assert(!publicCaptureJson.includes(proofFixture.screenshotPath), 'attested capture never exposes the screenshot path');

  await browserAttestedCheck();

  const planBytes = readFileSync(join(root, planResult.path));
  const changedPlan = JSON.parse(planBytes.toString('utf8'));
  changedPlan.steps[0].title = 'Tampered after comparison';
  writeFileSync(join(root, planResult.path), `${JSON.stringify(changedPlan, null, 2)}\n`);
  const stalePlan = await collectStudioReferenceState(root);
  assert.equal(stalePlan.status, 'invalid');
  assert(stalePlan.issues.some((issue) => /digest mismatch/i.test(issue.message)));
  assert.equal((await fetch(`${studio.url}${item.referenceAsset.url}`)).status, 400,
    'a stale reconstruction-plan link revokes the comparison asset URLs');
  writeFileSync(join(root, planResult.path), planBytes);
  assert.equal((await collectStudioReferenceState(root)).status, 'ready');

  writeFileSync(join(root, referencePath), Buffer.concat([referenceBytes, Buffer.from([0])]));
  const tampered = await collectStudioReferenceState(root);
  assert.equal(tampered.status, 'invalid');
  assert(tampered.issues.some((issue) => /digest|byte count/i.test(issue.message)));
  assert.equal((await fetch(`${studio.url}${item.referenceAsset.url}`)).status, 400, 'tampered bytes revoke the previously issued URL');

  unlinkSync(join(root, referencePath));
  symlinkSync(outside, join(root, referencePath));
  const linked = await collectStudioReferenceState(root);
  assert.equal(linked.status, 'invalid');
  assert(linked.issues.some((issue) => /symbolic link/i.test(issue.message)));
  assert.equal((await fetch(`${studio.url}${item.referenceAsset.url}`)).status, 400, 'symlink substitution cannot serve bytes');

  process.stdout.write('Studio Reference P3: PASS (validated surface, compare UI, repair prompt, opaque asset boundary)\n');
} finally {
  if (studio) await studio.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { force: true });
}

function put(file, source) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source.endsWith('\n') ? source : `${source}\n`, 'utf8');
}

function putBytes(file, bytes) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

async function getJson(path) {
  const response = await fetch(`${studio.url}${path}`);
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`);
  return body;
}

async function browserReferenceCheck() {
  let chromium, AxeBuilder;
  try {
    ({ chromium } = await import('@playwright/test'));
    ({ default: AxeBuilder } = await import('@axe-core/playwright'));
  } catch {
    process.stdout.write('Studio Reference browser checks: skipped (Playwright/axe unavailable)\n');
    return;
  }
  let browser;
  try { browser = await chromium.launch(); }
  catch {
    process.stdout.write('Studio Reference browser checks: skipped (Chromium unavailable)\n');
    return;
  }
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${studio.url}/#reference`);
    await page.waitForSelector('#view-reference.is-active');
    assert.match(await page.locator('#reference-content').textContent(), /Internal checkout design brief/);
    assert.match(await page.locator('#reference-content').textContent(), /Primary action color and contrast do not match/);
    const captureCard = page.locator('.summary-card').filter({ hasText: 'Browser capture' });
    assert.equal((await captureCard.locator('strong').textContent())?.trim(), 'UNATTESTED');
    assert.match(await page.locator('.capture-panel').textContent(), /Unattested advisory/);
    assert.match(await page.locator('.capture-panel').textContent(), /Do not treat this comparison as matched or complete/);
    assert.match(await page.locator('.capture-panel').textContent(), /Candidate is not backed|App Proof/i);
    const comparisonCard = page.locator('.summary-card').filter({ hasText: 'Comparison status' });
    assert.doesNotMatch((await comparisonCard.locator('strong').textContent()) ?? '', /^(?:match|matched|complete|completed)$/i);
    assert.equal(await page.locator('.comparison-pair img').count(), 2);
    await page.waitForFunction(() => [...document.querySelectorAll('.comparison-pair img')]
      .every((image) => image.complete && image.naturalWidth === 1));
    await page.getByRole('button', { name: 'Overlay' }).click();
    assert.equal(await page.locator('.overlay-stage img').count(), 2);
    await page.locator('#reference-overlay').fill('67');
    assert.equal(await page.locator('#reference-overlay-value').textContent(), '67%');
    assert.equal(await page.locator('#reference-content [data-copy-reference-repair]').isDisabled(), true);

    await page.locator('.nav-item[data-view="preview"]').click();
    await page.getByRole('button', { name: 'Inspect DOM' }).click();
    await page.locator('iframe[title="Axion live preview"]').contentFrame().getByRole('button', { name: 'Pay now' }).click();
    await page.waitForFunction(() => document.querySelector('#dom-panel')?.textContent?.includes('Reference repair'));
    await page.locator('.nav-item[data-view="reference"]').click();
    const request = page.locator('#reference-repair-request');
    assert.match(await request.inputValue(), /Use \$dk-design in Reconstruct repair mode/);
    assert.match(await request.inputValue(), /checkout-mobile/);
    assert.match(await request.inputValue(), /Primary action color and contrast do not match/);
    assert.match(await request.inputValue(), /Selector: \[data-component="CheckoutButton"\]/);
    assert.match(await request.inputValue(), /Authorized project paths: index\.html/);
    assert.match(await request.inputValue(), /Never edit outside the authorized project paths/);
    assert.match(await request.inputValue(), /Do not replace the implementation with the reference image/);
    assert.match(await request.inputValue(), /ADVISORY ONLY/);
    assert.match(await request.inputValue(), /Status: unattested/);
    assert.match(await request.inputValue(), /Before reporting matched or complete/);
    assert.doesNotMatch(await request.inputValue(), /(?:\/private)?\/(?:var|Users|home|tmp)\//,
      'the advisory request never exposes an absolute filesystem path');
    const copy = page.locator('#reference-content [data-copy-reference-repair]');
    assert.equal(await copy.isEnabled(), true);
    await copy.click();
    await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('copied'));

    const previewFrame = page.frames().find((frame) => frame !== page.mainFrame() && frame.url().includes('/preview/'));
    assert(previewFrame, 'local preview remains available for repair-scope boundary testing');
    await previewFrame.evaluate(() => {
      const nonce = document.querySelector('script[data-dk-studio-inspector]')?.dataset.dkStudioNonce;
      parent.postMessage({
        source: 'dk-studio-preview', nonce, type: 'dk-studio:selection',
        payload: {
          tag: 'button', selector: '#safe-checkout-action', text: 'Pay now',
          component: { name: 'Injected', source: '../../outside.tsx', depth: 0 },
          attributes: {}, tokens: [], box: { x: 0, y: 0, width: 40, height: 20 },
        },
      }, '*');
    });
    await page.waitForFunction(() => document.querySelector('#reference-repair-request')?.value?.includes('#safe-checkout-action'));
    assert.doesNotMatch(await request.inputValue(), /Editable scope: \.\.\/\.\.\/outside\.tsx/,
      'untrusted runtime source hints cannot expand the authorized repair scope');
    assert.match(await request.inputValue(), /Editable scope: #safe-checkout-action/);

    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      const axe = await new AxeBuilder({ page }).analyze();
      assert.equal(axe.violations.length, 0,
        `reference @ ${viewport.width}px axe violations: ${axe.violations.map((item) => item.id).join(', ')}`);
      if (viewport.width === 390) {
        const overflow = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        assert(overflow.document <= overflow.viewport && overflow.body <= overflow.viewport,
          `reference view must not overflow at 390px: ${JSON.stringify(overflow)}`);
      }
    }
    assert.deepEqual(errors, [], `Studio Reference page errors: ${errors.join(' | ')}`);
    await context.close();
  } finally {
    await browser.close();
  }
}

async function browserAttestedCheck() {
  let chromium, AxeBuilder;
  try {
    ({ chromium } = await import('@playwright/test'));
    ({ default: AxeBuilder } = await import('@axe-core/playwright'));
  } catch {
    process.stdout.write('Studio Reference attested browser checks: skipped (Playwright/axe unavailable)\n');
    return;
  }
  let browser;
  try { browser = await chromium.launch(); }
  catch {
    process.stdout.write('Studio Reference attested browser checks: skipped (Chromium unavailable)\n');
    return;
  }
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${studio.url}/#reference`);
    await page.waitForSelector('#view-reference.is-active');

    const captureCard = page.locator('.summary-card').filter({ hasText: 'Browser capture' });
    assert.equal((await captureCard.locator('strong').textContent())?.trim(), 'ATTESTED');
    const capturePanel = page.locator('.capture-panel');
    assert.match(await capturePanel.textContent(), /App Proof attested/);
    assert.match(await capturePanel.textContent(), /Route\s*checkout · \//);
    assert.match(await capturePanel.textContent(), /State\s*ready/);
    assert.match(await capturePanel.textContent(), /Theme\s*light/);
    assert.match(await capturePanel.textContent(), /Captured/);
    assert.match(await capturePanel.textContent(), /Proof digest\s*[a-f0-9]{8}…[a-f0-9]{4}/);
    assert.match(await capturePanel.textContent(), /Ledger digest\s*[a-f0-9]{8}…[a-f0-9]{4}/);
    const renderedText = await page.locator('#reference-content').textContent();
    assert.doesNotMatch(renderedText, /\.dk\/proof|\.dk\/report\.json|(?:\/private)?\/(?:var|Users|home|tmp)\//,
      'attested UI never renders evidence filesystem paths');

    await page.locator('.nav-item[data-view="preview"]').click();
    await page.getByRole('button', { name: 'Inspect DOM' }).click();
    await page.locator('iframe[title="Axion live preview"]').contentFrame().getByRole('button', { name: 'Pay now' }).click();
    await page.waitForFunction(() => document.querySelector('#dom-panel')?.textContent?.includes('Reference repair'));
    await page.locator('.nav-item[data-view="reference"]').click();
    const requestValue = await page.locator('#reference-repair-request').inputValue();
    assert.match(requestValue, /Evidence trust: BROWSER CAPTURE ATTESTED/);
    assert.match(requestValue, /Status: attested/);
    assert.match(requestValue, /Route: \//);
    assert.match(requestValue, /State: ready/);
    assert.match(requestValue, /Theme: light/);
    assert.match(requestValue, /Proof SHA-256: [a-f0-9]{64}/);
    assert.match(requestValue, /Ledger SHA-256: [a-f0-9]{64}/);
    assert.doesNotMatch(requestValue, /ADVISORY ONLY/);
    assert.doesNotMatch(requestValue, /\.dk\/proof|\.dk\/report\.json|(?:\/private)?\/(?:var|Users|home|tmp)\//,
      'attested repair request never exposes evidence filesystem paths');

    const axe = await new AxeBuilder({ page }).analyze();
    assert.equal(axe.violations.length, 0,
      `attested reference axe violations: ${axe.violations.map((item) => item.id).join(', ')}`);
    assert.deepEqual(errors, [], `Studio attested Reference page errors: ${errors.join(' | ')}`);
    await context.close();
  } finally {
    await browser.close();
  }
}
