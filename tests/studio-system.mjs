#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendApproval } from '../src/core/approvals.mjs';
import { createDirectionLock, hashDirection, hashDirectionBindings } from '../src/core/direction.mjs';
import { loadTokens, resolve as resolveToken } from '../src/core/tokens.mjs';
import { appProofCaseId } from '../src/proof/app-proof.mjs';
import { indexRepository } from '../src/system/indexer.mjs';
import { collectStudioSnapshot } from '../src/studio/data.mjs';
import { createStudioServer, startStudio } from '../src/studio/server.mjs';

const root = mkdtempSync(join(tmpdir(), 'axion-studio-'));
const outsideSource = join(dirname(root), `outside-${Date.now()}.tsx`);
const outsideHtml = join(dirname(root), `outside-${Date.now()}.html`);
let studio;

try {
  const tokens = {
    color: {
      brand: { accent: { $type: 'color', $value: '#8cff52', $extensions: { modes: { dark: '#b9f56a' } } } },
      surface: { page: { $type: 'color', $value: '#101410' } },
      text: { primary: { $type: 'color', $value: '#f4f6ef' } },
    },
  };
  const direction = {
    schema: 'dk-direction/v2', status: 'approved', name: 'Signal Grid',
    context: { register: 'product', product: 'A compact release control surface.', audience: ['Operators'], task: 'Review releases.', action: 'Approve one release.', constraints: [] },
    identity: {
      thesis: 'Make operational confidence visible through one precise status grid.',
      qualities: ['precise', 'quiet', 'legible'], signature: 'A luminous status rail anchors every release.',
      composition: 'One status rail and a dense content plane.', responsive: 'The rail becomes a compact header.',
      typography: 'System sans for actions and mono for evidence.', color: 'Dark surfaces with one acid signal.',
      form: 'Hairlines and compact controls.', motion: 'Only state transitions animate.',
      media: 'No decorative media.', avoid: ['floating glass cards', 'decorative gradients'],
    },
    bindings: { accent: 'color.brand.accent', surface: 'color.surface.page', text: 'color.text.primary' },
  };

  put('design/tokens.json', JSON.stringify(tokens, null, 2));
  put('design/direction.json', JSON.stringify(direction, null, 2));
  put('src/Button.tsx', `export function Button({ disabled = false }) {\n  return <button disabled={disabled} style={{ color: 'var(--color-brand-accent)' }}>Ship</button>;\n}\n`);
  put('src/Button.stories.tsx', `import { Button } from './Button';\nexport default { title: 'System/Button', component: Button };\nexport const Default = {};\nexport const Disabled = { args: { disabled: true } };\n`);
  put('src/pages/index.tsx', `import { Button } from '../Button';\nexport default function Home() { return <main><Button /></main>; }\n`);
  put('src/pages/unverified.tsx', `export default function Unverified() { return <main>Declared, not executed</main>; }\n`);
  put('styles/app.css', `:root { --color-brand-accent: #8cff52; }\n.button { color: var(--color-brand-accent); }\n`);
  put('index.html', `<!doctype html><html><head><link rel="stylesheet" href="/styles/app.css"></head><body><main data-component="ReleaseHome"><button class="button">Ship</button></main><script>fetch('/api/snapshot').then((response) => response.text()).then((text) => parent.postMessage({ source: 'studio-security-leak', text }, '*')).catch(() => parent.postMessage({ source: 'studio-security-blocked' }, '*'));</script></body></html>`);
  put('dk-report.html', '<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src \'none\'"><title>Generated report</title>');
  put('tests/home.spec.mjs', `test('home mobile success', async ({ page }) => {\n  await page.setViewportSize({ width: 390, height: 844 });\n  await page.goto('/');\n  await page.toHaveScreenshot('home-mobile-success.png');\n});\ntest('unverified declared route', async ({ page }) => { await page.goto('/unverified'); });\n`);
  put('assets/unverified-mobile.png', 'ordinary product image, not execution proof');
  put('.dk/report.json', JSON.stringify({
    generatedAt: '2026-07-15T01:00:00.000Z', status: 'passed', exitCode: 0, filesScanned: 4,
    counts: { error: 0, warn: 1, info: 0 },
    gates: [{ id: 'contract', status: 'ran', findings: 0 }, { id: 'visual', status: 'ran', findings: 0 }],
    findings: [{ ruleId: 'slop/example', severity: 'warn', file: 'src/Button.tsx', line: 2, message: 'Example evidence.' }],
  }, null, 2));
  writeFileSync(outsideSource, 'export const Outside = () => null;\n');
  writeFileSync(outsideHtml, '<!doctype html><title>outside</title>\n');
  symlinkSync(outsideSource, join(root, 'src', 'escape.tsx'));
  symlinkSync(outsideHtml, join(root, 'escape.html'));

  const tokenDoc = loadTokens(join(root, 'design/tokens.json'));
  const directionHash = hashDirection(direction);
  const bindingHash = hashDirectionBindings(direction, (path, mode) => resolveToken(tokenDoc, path, mode));
  const approval = appendApproval(root, join(root, 'design/approval-history.json'), {
    directionName: direction.name, directionHash, bindingHash,
    actor: 'Studio Test', reason: 'Approved after route, state, and responsive evidence review.',
  }, { now: '2026-07-15T01:01:00.000Z' });
  const lock = createDirectionLock(direction, null, { bindingHash, approvalHeadHash: approval.headHash });
  put('design/direction.lock.json', JSON.stringify(lock, null, 2));

  const proofConfigHash = 'a'.repeat(64);
  const proofMatrix = { route: 'home', state: 'default', viewport: 'mobile', theme: 'light' };
  const proofCaseId = appProofCaseId(proofMatrix);
  const proofScreenshotPath = `.dk/proof/screenshots/${proofCaseId}.png`;
  // A real 1×1 PNG is sufficient for the fixture; the production runner records
  // the configured viewport dimensions while the trust boundary verifies the
  // durable bytes and digest rather than decoding image pixels.
  const proofScreenshot = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  mkdirSync(dirname(join(root, proofScreenshotPath)), { recursive: true });
  writeFileSync(join(root, proofScreenshotPath), proofScreenshot);
  const proofScreenshotHash = createHash('sha256').update(proofScreenshot).digest('hex');
  put('.dk/proof/app-proof.json', JSON.stringify({
    schemaVersion: 2, kind: 'axion-app-proof', coverageStatus: 'complete', qualityStatus: 'clean',
    configHash: proofConfigHash,
    startedAt: '2026-07-15T02:00:00.000Z', finishedAt: '2026-07-15T02:00:01.000Z', discovery: 'explicit-routes',
    coverage: {
      routes: [{ name: 'home', url: 'http://127.0.0.1:3000/' }], states: ['default'],
      viewports: [{ name: 'mobile', width: 390, height: 844 }], themes: [{ name: 'light', colorScheme: 'light' }],
      plannedCases: 1, completedCases: 1, failedCases: 0, screenshotCases: 1,
    },
    summary: { cases: 1, failed: 0, violations: 0 },
    results: [{
      id: proofCaseId,
      file: 'app:/ [state=default, viewport=mobile, theme=light]',
      target: 'app:/ [state=default, viewport=mobile, theme=light]',
      url: 'http://127.0.0.1:3000/', matrix: proofMatrix, violations: [],
      usedTokens: ['--color-brand-accent'],
      screenshot: {
        path: proofScreenshotPath, sha256: proofScreenshotHash, bytes: proofScreenshot.length,
        width: 390, height: 844, fullPage: true,
      },
    }],
    usedTokens: ['--color-brand-accent'],
  }, null, 2));
  put('.dk/report.json', JSON.stringify({
    generatedAt: '2026-07-15T02:00:02.000Z', status: 'passed', exitCode: 0, filesScanned: 4,
    counts: { error: 0, warn: 1, info: 0 },
    gates: [{ id: 'contract', status: 'ran', findings: 0 }, { id: 'a11y', status: 'ran', findings: 0 }, { id: 'visual', status: 'ran', findings: 7 }],
    findings: [{ ruleId: 'slop/example', severity: 'warn', file: 'src/Button.tsx', line: 2, message: 'Example evidence.' }],
    emits: {
      appProofArtifact: '.dk/proof/app-proof.json', appProofConfigHash: proofConfigHash,
      appProofDiscovery: 'explicit-routes', appProofCoverage: { plannedCases: 1, completedCases: 1, failedCases: 0, screenshotCases: 1 },
      appProofSummary: { cases: 1, failed: 0, violations: 0 },
    },
  }, null, 2));

  const graph = indexRepository(root, { now: '2026-07-15T02:00:00.000Z' });
  assert.equal(graph.schema, 'dk-system-graph/v1');
  assert(graph.nodes.some((node) => node.kind === 'component' && node.label === 'Button'));
  assert(graph.nodes.some((node) => node.kind === 'story' && node.label === 'Disabled'));
  assert(graph.nodes.some((node) => node.kind === 'token' && node.label === 'color.brand.accent'));
  assert(graph.nodes.some((node) => node.kind === 'route' && node.label === '/'));
  assert(graph.edges.some((edge) => edge.type === 'storyFor'));
  assert(graph.edges.some((edge) => edge.type === 'tokenUses'));
  assert(graph.proof.routes.some((route) => route.route === '/' && route.status === 'proven'));
  assert.equal(graph.proof.routes.filter((route) => route.route === '/').length, 1, 'same logical route is deduplicated across source files');
  assert(graph.proof.routes.some((route) => route.route === '/unverified' && route.status === 'evidence-linked'));
  assert.equal(graph.proof.summary.screenshotCount, 0, 'ordinary product images never count as proof screenshots');
  assert.equal(graph.proof.appProof.status, 'complete');
  assert(graph.proof.summary.states.includes('success'));
  assert(!graph.proof.summary.states.includes('mobile'));
  assert(graph.proof.routes.find((route) => route.route === '/')?.viewports.includes('mobile'));
  assert(graph.proof.routes.find((route) => route.route === '/')?.themes.includes('light'));

  const snapshot = await collectStudioSnapshot(root, { graph, now: '2026-07-15T02:00:00.000Z' });
  assert.equal(snapshot.schema, 'dk-studio-snapshot/v1');
  assert.equal(snapshot.direction.matches, true);
  assert.equal(snapshot.approvals.status, 'verified');
  assert.equal(snapshot.approvals.count, 1);
  assert.equal(snapshot.approvals.latest.actor, 'Studio Test');
  assert.equal(snapshot.ledger.status, 'passed');
  assert(snapshot.previews.some((preview) => preview.file === 'index.html'));
  assert(!snapshot.previews.some((preview) => preview.file === 'dk-report.html'), 'generated reports never auto-open as product previews');
  assert.equal(snapshot.ledger.gates.find((gate) => gate.id === 'visual')?.findingCount, 0,
    'Studio displays final actionable gate findings, not pre-policy raw counts');
  assert.equal(snapshot.ledger.gates.find((gate) => gate.id === 'visual')?.rawFindingCount, 7,
    'raw gate evidence remains available for diagnostics');

  assert.throws(() => createStudioServer({ root, host: '0.0.0.0', port: 0 }), /non-loopback/);
  studio = await startStudio({ root, port: 0, cacheTtl: 0 });
  assert.match(studio.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const health = await getJson('/api/health');
  assert.equal(health.ok, true);
  const apiSnapshot = await getJson('/api/snapshot');
  assert.equal(apiSnapshot.approvals.status, 'verified');
  const apiGraph = await getJson('/api/graph');
  assert.equal(apiGraph.schema, 'dk-system-graph/v1');
  const proof = await getJson('/api/proof');
  assert.equal(proof.schema, 'dk-proof-surfaces/v1');

  const shell = await fetch(`${studio.url}/`);
  assert.equal(shell.status, 200);
  assert.match(await shell.text(), /Axion Studio/);
  assert.match(shell.headers.get('content-security-policy') ?? '', /style-src 'self' 'unsafe-inline'/);
  for (const asset of ['app.css', 'app.js', 'inspector.js']) {
    const response = await fetch(`${studio.url}/_studio/${asset}`);
    assert.equal(response.status, 200, asset);
    assert((await response.text()).length > 500, asset);
  }

  const preview = await fetch(`${studio.url}/preview/index.html`);
  const previewHtml = await preview.text();
  assert.equal(preview.status, 200);
  assert.match(previewHtml, /data-dk-studio-inspector/);
  assert.match(previewHtml, /data-dk-studio-rules/);
  const noncePreview = await fetch(`${studio.url}/preview/index.html?__dk_studio_nonce=studio_nonce_123456789`);
  assert.match(await noncePreview.text(), /data-dk-studio-nonce="studio_nonce_123456789"/);
  const absoluteAsset = await fetch(`${studio.url}/styles/app.css`);
  assert.equal(absoluteAsset.status, 200);

  const source = await getJson('/api/source?file=src%2FButton.tsx&line=2&context=1');
  assert.equal(source.file, 'src/Button.tsx');
  assert.equal(source.line, 2);
  assert(source.lines.some((line) => line.text.includes('var(--color-brand-accent)')));
  const escaped = await fetch(`${studio.url}/api/source?file=${encodeURIComponent('../' + outsideSource.split('/').at(-1))}`);
  assert.equal(escaped.status, 400);
  const symlinkSource = await fetch(`${studio.url}/api/source?file=src%2Fescape.tsx`);
  assert.equal(symlinkSource.status, 400);
  const symlinkPreview = await fetch(`${studio.url}/preview/escape.html?__dk_studio_nonce=studio_nonce_123456789`);
  assert.equal(symlinkPreview.status, 400);
  assert.equal((await fetch(`${studio.url}/api/snapshot`)).headers.get('access-control-allow-origin'), null);

  const shellHtml = await (await fetch(`${studio.url}/`)).text();
  assert.match(shellHtml, /sandbox="allow-scripts allow-forms"/);
  assert.doesNotMatch(shellHtml, /sandbox="[^"]*allow-same-origin/);
  await browserSecurityCheck();

  const proofPath = join(root, '.dk/proof/app-proof.json');
  const validProof = JSON.parse(readFileSync(proofPath, 'utf8'));
  const proofLedgerPath = join(root, '.dk/report.json');
  const validProofLedger = JSON.parse(readFileSync(proofLedgerPath, 'utf8'));

  const violatedProof = structuredClone(validProof);
  violatedProof.qualityStatus = 'violations';
  violatedProof.summary.violations = 1;
  violatedProof.results[0].violations = [{ id: 'button-name', impact: 'serious', nodes: [] }];
  const violatedLedger = structuredClone(validProofLedger);
  violatedLedger.status = 'failed';
  violatedLedger.exitCode = 1;
  violatedLedger.counts.error = 1;
  writeFileSync(proofPath, JSON.stringify(violatedProof, null, 2));
  writeFileSync(proofLedgerPath, JSON.stringify(violatedLedger, null, 2));
  const qualityRejected = await getJson('/api/graph?refresh=1');
  assert.equal(qualityRejected.proof.appProof.status, 'quality-failed');
  assert(!qualityRejected.proof.routes.some((route) => route.status === 'proven'), 'axe violations cannot masquerade as a proven route');

  const failedLedger = structuredClone(validProofLedger);
  failedLedger.status = 'failed';
  failedLedger.exitCode = 1;
  failedLedger.counts.error = 1;
  writeFileSync(proofPath, JSON.stringify(validProof, null, 2));
  writeFileSync(proofLedgerPath, JSON.stringify(failedLedger, null, 2));
  const ledgerRejected = await getJson('/api/graph?refresh=1');
  assert.equal(ledgerRejected.proof.appProof.status, 'quality-failed');
  assert(!ledgerRejected.proof.routes.some((route) => route.status === 'proven'), 'a failed evidence ledger cannot prove a route');

  writeFileSync(proofPath, JSON.stringify({ ...validProof, schemaVersion: 1 }, null, 2));
  writeFileSync(proofLedgerPath, JSON.stringify(validProofLedger, null, 2));
  const legacyProof = await getJson('/api/graph?refresh=1');
  assert.equal(legacyProof.proof.appProof.status, 'invalid');
  assert(!legacyProof.proof.routes.some((route) => route.status === 'proven'), 'schema v1 artifacts can never prove a route');

  writeFileSync(proofPath, JSON.stringify(validProof, null, 2));
  writeFileSync(proofLedgerPath, JSON.stringify(validProofLedger, null, 2));
  writeFileSync(join(root, proofScreenshotPath), Buffer.concat([proofScreenshot, Buffer.from([0])]));
  const digestRejected = await getJson('/api/graph?refresh=1');
  assert.equal(digestRejected.proof.appProof.status, 'invalid');
  assert(!digestRejected.proof.routes.some((route) => route.status === 'proven'), 'modified screenshot bytes cannot prove a route');
  writeFileSync(join(root, proofScreenshotPath), proofScreenshot);

  const duplicateProof = structuredClone(validProof);
  duplicateProof.coverage.plannedCases = 2;
  duplicateProof.coverage.completedCases = 2;
  duplicateProof.coverage.screenshotCases = 2;
  duplicateProof.results.push({ ...duplicateProof.results[0] });
  writeFileSync(proofPath, JSON.stringify(duplicateProof, null, 2));
  const proofLedger = structuredClone(validProofLedger);
  proofLedger.emits.appProofCoverage.plannedCases = 2;
  proofLedger.emits.appProofCoverage.completedCases = 2;
  proofLedger.emits.appProofCoverage.screenshotCases = 2;
  writeFileSync(proofLedgerPath, JSON.stringify(proofLedger, null, 2));
  const rejectedProof = await getJson('/api/graph?refresh=1');
  assert.equal(rejectedProof.proof.appProof.status, 'invalid');
  assert(!rejectedProof.proof.routes.some((route) => route.status === 'proven'), 'duplicate claimed cases cannot prove a route');

  const historyPath = join(root, 'design/approval-history.json');
  const history = JSON.parse(readFileSync(historyPath, 'utf8'));
  history.entries[0].reason = 'silently rewritten';
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
  const refreshed = await getJson('/api/snapshot?refresh=1');
  assert.equal(refreshed.approvals.status, 'invalid');
  assert(refreshed.approvals.issues.some((issue) => issue.code === 'hash-mismatch'));

  const refresh = await fetch(`${studio.url}/api/refresh`, { method: 'POST' });
  assert.equal(refresh.status, 200);
  assert.equal((await refresh.json()).ok, true);

  console.log('Studio + System Graph: PASS (index, proof, approvals, APIs, preview, source boundary)');
} finally {
  if (studio) await studio.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(outsideSource, { force: true });
  rmSync(outsideHtml, { force: true });
}

function put(file, source) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, source.endsWith('\n') ? source : `${source}\n`, 'utf8');
}

async function getJson(path) {
  const response = await fetch(`${studio.url}${path}`);
  const body = await response.json();
  assert.equal(response.status, 200, `${path}: ${JSON.stringify(body)}`);
  return body;
}

async function browserSecurityCheck() {
  let chromium, AxeBuilder;
  try {
    ({ chromium } = await import('@playwright/test'));
    ({ default: AxeBuilder } = await import('@axe-core/playwright'));
  } catch { process.stdout.write('Studio browser quality: skipped (Playwright/axe dependency unavailable)\n'); return; }
  let browser;
  try { browser = await chromium.launch(); }
  catch { process.stdout.write('Studio browser quality: skipped (Chromium unavailable)\n'); return; }
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.addInitScript(() => {
      window.__studioSecurityMessages = [];
      window.addEventListener('message', (event) => {
        if (String(event.data?.source || '').startsWith('studio-security-')) window.__studioSecurityMessages.push(event.data);
      });
    });
    await page.goto(`${studio.url}/#preview`);
    await page.waitForFunction(() => window.__studioSecurityMessages?.length > 0);
    const messages = await page.evaluate(() => window.__studioSecurityMessages);
    assert(messages.some((message) => message.source === 'studio-security-blocked'), 'opaque preview origin blocks API response reads');
    assert(!messages.some((message) => message.source === 'studio-security-leak'), 'untrusted preview cannot exfiltrate Studio API JSON');
    await page.getByRole('button', { name: 'Inspect DOM' }).click();
    await page.locator('iframe[title="Axion live preview"]').contentFrame().getByRole('button', { name: 'Ship' }).click();
    await page.waitForFunction(() => document.querySelector('#dom-panel')?.textContent?.includes('--color-brand-accent'));
    assert.match(await page.locator('#dom-panel').textContent(), /ReleaseHome|button/);
    assert.match(await page.locator('#dom-panel').textContent(), /--color-brand-accent/);

    // The local preview knows its nonce by design, so its selection payload is
    // still untrusted. Exercise the renderer with oversized/malformed fields
    // and assert Studio bounds them without throwing or freezing navigation.
    const previewFrame = page.frames().find((frame) => frame !== page.mainFrame() && frame.url().includes('/preview/'));
    assert(previewFrame, 'local preview frame is available for payload-boundary regression');
    await previewFrame.evaluate(() => {
      const nonce = document.querySelector('script[data-dk-studio-inspector]')?.dataset.dkStudioNonce;
      parent.postMessage({
        source: 'dk-studio-preview', nonce, type: 'dk-studio:selection',
        payload: {
          tag: 'button', selector: 'x'.repeat(5000), text: 'y'.repeat(5000),
          tokens: Array.from({ length: 80 }, (_, index) => ({
            selector: `.item-${index}`, property: 'color', token: `--color-${index}`, value: '#fff',
          })),
          attributes: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`data-${index}`, `value-${index}`])),
          box: { x: Infinity, y: -Infinity, width: Number.NaN, height: 44 },
        },
      }, '*');
    });
    await page.waitForFunction(() => document.querySelectorAll('#dom-panel .token-clue').length === 50);
    assert.equal(await page.locator('#dom-panel .dom-selector').textContent().then((text) => text.length), 500);
    assert.equal(await page.locator('#dom-panel .token-clue').count(), 50);
    assert.equal(await page.locator('#dom-panel .node-meta').last().locator(':scope > div').count(), 24);

    const views = ['overview', 'direction', 'proof', 'system', 'preview', 'changes', 'connections'];
    for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      for (const view of views) {
        await page.locator(`.nav-item[data-view="${view}"]`).click();
        await page.waitForSelector(`#view-${view}.is-active`);
        // The iframe renders arbitrary project UI, which has its own App Proof
        // gate. This regression audits Studio chrome and deliberately excludes
        // preview-document findings from the workbench's accessibility result.
        const axe = await new AxeBuilder({ page }).exclude('#preview-frame').analyze();
        assert.equal(axe.violations.length, 0,
          `${view} @ ${viewport.width}px axe violations: ${axe.violations.map((item) => `${item.id} (${item.nodes.length})`).join(', ')}`);
        if (viewport.width === 390) {
          const widths = await page.evaluate(() => ({
            viewport: innerWidth,
            document: document.documentElement.scrollWidth,
            body: document.body.scrollWidth,
            offenders: [...document.querySelectorAll('*')].map((element) => {
              const rect = element.getBoundingClientRect();
              return { tag: element.tagName, id: element.id, className: String(element.className).slice(0, 80), left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width), scrollWidth: element.scrollWidth, text: String(element.textContent ?? '').trim().slice(0, 160) };
            }).filter((item) => item.right > innerWidth || item.left < 0 || item.scrollWidth > item.width + 1).slice(0, 30),
          }));
          assert(widths.document <= widths.viewport && widths.body <= widths.viewport,
            `${view} must not overflow horizontally at 390px: ${JSON.stringify(widths)}`);
        }
      }
    }
    const navGeometry = await page.locator('.nav-item').evaluateAll((items) => items.map((item) => {
      const box = item.getBoundingClientRect();
      return { left: box.left, right: box.right, width: box.width, visible: getComputedStyle(item).visibility !== 'hidden' };
    }));
    assert(navGeometry.every((item) => item.visible && item.width > 40 && item.left >= 0 && item.right <= 390),
      `all Studio mobile navigation controls remain usable: ${JSON.stringify(navGeometry)}`);
    assert.deepEqual(pageErrors, [], `Studio page errors: ${pageErrors.join(' | ')}`);
    await context.close();
    process.stdout.write('Studio browser quality: PASS (sandbox, bounded inspector, 14-view axe, 390px responsive navigation)\n');
  } finally { await browser.close(); }
}
