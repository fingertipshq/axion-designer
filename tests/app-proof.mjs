import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AppProofConfigError,
  normalizeAppProofConfig,
  validateAppProofConfig,
  buildAppProofMatrix,
  normalizeDiscoveredRoutes,
  applyAppProofCliOverrides,
  appProofCaseId,
  appProofConfigHash,
} from '../src/proof/app-proof.mjs';
import { loadConfig, validateConfig } from '../src/core/config.mjs';
import { SUPPORTED_A11Y_TAGS } from '../src/core/a11y-tags.mjs';
import {
  a11yGate, a11yResultsToFindings, validA11yOutput,
  validAppProofAgainstPlan, validAppProofScreenshots,
} from '../src/gates/heavy.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
let assertions = 0;
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); assertions++; };
const ok = (value, message) => { assert.ok(value, message); assertions++; };
const throwsProof = (fn, pattern, message) => {
  assert.throws(fn, (error) => error instanceof AppProofConfigError && pattern.test(error.message), message);
  assertions++;
};

const raw = {
  baseUrl: 'http://127.0.0.1:4173',
  routes: ['/', { name: 'pricing', path: '/pricing', waitFor: 'main' }],
  states: [
    'default',
    { name: 'details-open', actions: [{ type: 'click', selector: '#open-menu' }], waitFor: '#details:not([hidden])' },
  ],
  viewports: [{ name: 'phone', width: 375, height: 812 }, { name: 'wide', width: 1280, height: 800 }],
  themes: ['light', { name: 'night', colorScheme: 'dark', attributes: { 'data-theme': 'night' }, classes: ['night'] }],
};
const plan = normalizeAppProofConfig(raw);
const matrix = buildAppProofMatrix(plan);
eq(matrix.length, 16, 'route × state × viewport × theme expands completely');
eq(new Set(matrix.map((entry) => entry.id)).size, 16, 'every matrix case has a stable unique id');
ok(matrix.every((entry) => entry.label.includes('state=') && entry.label.includes('viewport=') && entry.label.includes('theme=')),
  'every target label preserves all matrix dimensions');

const routeOverride = normalizeAppProofConfig({
  baseUrl: 'https://ui.test',
  routes: [{ path: '/checkout', states: [{ name: 'error', waitFor: '[role=alert]' }] }],
  states: ['default'], viewports: [390], themes: ['light'],
});
eq(buildAppProofMatrix(routeOverride).map((entry) => entry.state.name), ['error'],
  'route-specific state matrix intentionally overrides global states');

const auto = normalizeAppProofConfig({ baseUrl: 'https://ui.test/app', routes: 'auto', maxRoutes: 3 });
const found = normalizeDiscoveredRoutes(auto, [
  '/pricing#details', '/pricing', 'https://ui.test/help?mode=full',
  'https://evil.test/phish', 'mailto:hello@example.com',
]);
eq(found.map((route) => route.url), ['https://ui.test/app', 'https://ui.test/help?mode=full', 'https://ui.test/pricing'],
  'auto discovery canonicalizes, deduplicates, and rejects cross-origin/non-http links');
throwsProof(() => normalizeDiscoveredRoutes({ ...auto, maxRoutes: 2 }, ['/one', '/two']), /exceeding proof\.maxRoutes/,
  'auto discovery refuses to truncate route coverage silently');

throwsProof(() => normalizeAppProofConfig({ baseUrl: 'https://user:pass@ui.test' }), /credentials/,
  'base URL credentials are rejected');
throwsProof(() => normalizeAppProofConfig({ baseUrl: 'https://ui.test', routes: ['https://evil.test'] }), /remain on.*origin/,
  'explicit routes cannot turn proof into a cross-origin scanner');
throwsProof(() => normalizeAppProofConfig({ baseUrl: 'https://ui.test', states: ['modal-open'] }), /named states require/,
  'a named state cannot claim coverage without declarative setup');
throwsProof(() => normalizeAppProofConfig({ baseUrl: 'https://ui.test', states: [{ name: 'open', actions: [] }] }), /cannot be proven/,
  'an empty named state fails closed');
throwsProof(() => normalizeAppProofConfig({ baseUrl: 'https://ui.test', unknown: true }), /not supported/,
  'unknown proof keys are rejected instead of ignored');
throwsProof(() => normalizeAppProofConfig({
  baseUrl: 'https://ui.test', themes: [{ name: 'unsafe', attributes: { onload: 'alert(1)' } }],
}), /safe HTML attribute/,
  'theme configuration cannot smuggle event-handler JavaScript');
throwsProof(() => normalizeAppProofConfig({
  baseUrl: 'https://ui.test', themes: [{ name: 'contrast mode', classes: ['contrast mode'] }],
}), /class tokens/,
  'theme classes must be deterministic DOMTokenList tokens');
throwsProof(() => normalizeAppProofConfig({
  baseUrl: 'https://ui.test', routes: ['/', '/a'], states: ['default'],
  viewports: [320, 640], themes: ['light', 'dark'], maxCases: 7,
}), /expands to 8 cases/,
  'an oversized matrix fails before browser work begins');
ok(validateAppProofConfig({ baseUrl: 'file:///tmp/index.html' }).some((issue) => /http/.test(issue)),
  'validation helper returns actionable issues without throwing');

const unknownA11yTag = 'definitely-not-a-real-tag';
const invalidTagConfig = validateConfig({ gates: { a11y: { tags: ['wcag2aa', unknownA11yTag] } } });
const invalidTagFinding = invalidTagConfig.errors.find((finding) => finding.meta?.configPath === 'gates.a11y.tags[1]');
ok(invalidTagFinding?.meta?.configFatal, 'an unknown Axe tag is a config-fatal error at its exact array path');
eq(validateConfig({ gates: { a11y: { tags: [] } } }).errors.length, 0,
  'an explicit empty Axe tag list preserves the documented default-all semantics');
const normalizedTagConfig = validateConfig({ gates: { a11y: { tags: ['wcag2aa', 'wcag2a', 'wcag2aa'] } } });
eq(normalizedTagConfig.config.gates.a11y.tags, ['wcag2a', 'wcag2aa'],
  'Axe tags normalize to stable supported-profile order with duplicates removed');
const publishedSchema = JSON.parse(readFileSync(join(repo, 'dk.schema.json'), 'utf8'));
eq(publishedSchema.properties.gates.properties.a11y.properties.tags.items.enum, [...SUPPORTED_A11Y_TAGS],
  'published schema and runtime validation expose the same supported Axe tag contract');

// The child-process trust boundary must reject unsupported tags before it
// imports browser tooling or visits the declared broken page. Otherwise Axe
// accepts the typo, runs zero rules, and can return a false clean result.
const invalidTagRunner = spawnSync(process.execPath, [join(repo, 'src', 'proof', 'app-proof-runner.mjs')], {
  cwd: repo, encoding: 'utf8', timeout: 30_000,
  input: JSON.stringify({
    proof: {
      baseUrl: 'http://127.0.0.1:1', routes: ['/broken'], states: ['default'],
      viewports: [{ name: 'phone', width: 375, height: 812 }], themes: ['light'],
    },
    tags: [unknownA11yTag],
  }),
});
eq(invalidTagRunner.status, 2, 'direct app-proof runner rejects an unknown Axe tag before browser work');
ok(invalidTagRunner.stderr.includes('tags[0]') && invalidTagRunner.stderr.includes(unknownA11yTag),
  'runner rejection identifies the exact invalid tag and input path');

const overridden = applyAppProofCliOverrides({ proof: { themes: ['light'] } }, {
  app: 'http://127.0.0.1:3000', routes: '/,/pricing',
});
eq(overridden.proof.routes, ['/', '/pricing'], 'CLI helper parses an explicit comma-separated route list');
eq(applyAppProofCliOverrides({ proof: { baseUrl: 'http://127.0.0.1:3000' } }, { routes: 'auto' }).proof.routes,
  'auto', 'CLI helper preserves explicit automatic discovery');

const appMatrix = { route: 'home', state: 'default', viewport: 'phone', theme: 'light' };
const appId = appProofCaseId(appMatrix);
const appPlan = normalizeAppProofConfig({
  baseUrl: 'http://127.0.0.1:3000/', routes: ['/'], states: ['default'],
  viewports: [{ name: 'phone', width: 375, height: 812 }], themes: ['light'],
});
const appOutput = {
  schemaVersion: 2, kind: 'axion-app-proof', coverageStatus: 'complete', qualityStatus: 'clean',
  configHash: appProofConfigHash(appPlan), tags: [], usedTokens: [], summary: { cases: 1, failed: 0, violations: 0 },
  coverage: {
    routes: [{ name: 'home', url: 'http://127.0.0.1:3000/' }], states: ['default'],
    viewports: appPlan.viewports, themes: [{ name: 'light', colorScheme: 'light' }],
    plannedCases: 1, completedCases: 1, failedCases: 0, screenshotCases: 1,
  },
  results: [{
    id: appId, target: 'app:/', url: 'http://127.0.0.1:3000/', matrix: appMatrix,
    violations: [], usedTokens: [], screenshot: {
      path: `.dk/proof/screenshots/${appId}.png`, sha256: 'b'.repeat(64), bytes: 10,
      width: 375, height: 812, fullPage: true,
    },
  }],
};
ok(validA11yOutput(appOutput, true), 'complete internally consistent app coverage is accepted');
ok(validAppProofAgainstPlan(appOutput, appPlan), 'runner coverage is bound to the exact normalized parent plan');
ok(!validAppProofAgainstPlan({ ...appOutput, configHash: 'c'.repeat(64) }, appPlan), 'a proof from another config cannot be replayed');
const wcagAOutput = { ...appOutput, tags: ['wcag2a'], configHash: appProofConfigHash(appPlan, ['wcag2a']) };
ok(validAppProofAgainstPlan(wcagAOutput, appPlan, ['wcag2a']),
  'parent accepts child evidence bound to the exact normalized Axe tag scope');
ok(!validAppProofAgainstPlan(wcagAOutput, appPlan, ['wcag2aa']),
  'parent rejects child evidence produced for a different Axe tag scope');
ok(appProofConfigHash(appPlan, ['wcag2a']) !== appProofConfigHash(appPlan, ['wcag2aa']),
  'App Proof config hash changes when only the accessibility policy changes');
const screenshotRoot = mkdtempSync(join(tmpdir(), 'dk-proof-screenshot-'));
const outsideScreenshot = join(tmpdir(), `dk-proof-outside-${process.pid}.png`);
try {
  const path = join(screenshotRoot, '.dk', 'proof', 'screenshots', `${appId}.png`);
  mkdirSync(dirname(path), { recursive: true });
  const bytes = Buffer.from('proof-image');
  writeFileSync(path, bytes);
  const screenshotOutput = {
    results: [{ ...appOutput.results[0], screenshot: {
      ...appOutput.results[0].screenshot, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    } }],
  };
  ok(validAppProofScreenshots(screenshotOutput, screenshotRoot), 'regular screenshot bytes and digest form durable proof');
  rmSync(path);
  writeFileSync(outsideScreenshot, bytes);
  symlinkSync(outsideScreenshot, path);
  ok(!validAppProofScreenshots(screenshotOutput, screenshotRoot), 'a post-run screenshot symlink cannot replay external bytes as proof');
} finally {
  rmSync(screenshotRoot, { recursive: true, force: true });
  rmSync(outsideScreenshot, { force: true });
}
ok(!validA11yOutput({ ...appOutput, schemaVersion: 1 }, true), 'legacy proof schemas cannot be upgraded to current evidence');
const outputWithoutTags = { ...appOutput };
delete outputWithoutTags.tags;
ok(!validA11yOutput(outputWithoutTags, true),
  'App Proof output without its Axe tag contract is invalid evidence');
ok(!validA11yOutput({ ...appOutput, tags: ['wcag2aa', 'wcag2a'] }, true),
  'non-canonical child tag output cannot bypass exact parent-policy comparison');
ok(!validA11yOutput({ ...appOutput, results: [] }, true), 'a missing matrix result invalidates the entire runner output');
ok(!validA11yOutput({ ...appOutput, coverage: { plannedCases: 1, completedCases: 1, failedCases: 1 } }, true),
  'contradictory coverage counters cannot produce a false pass');
const duplicate = {
  ...appOutput,
  summary: { cases: 2, failed: 0, violations: 0 },
  coverage: { plannedCases: 2, completedCases: 2, failedCases: 0, screenshotCases: 2 },
  results: [appOutput.results[0], appOutput.results[0]],
};
ok(!validA11yOutput(duplicate, true), 'duplicate case ids/matrix results cannot impersonate missing coverage');
const failedCase = a11yResultsToFindings([{
  id: 'broken', target: 'app:/checkout [state=error, viewport=phone, theme=dark]',
  url: 'http://127.0.0.1:3000/checkout', matrix: { route: 'checkout', state: 'error', viewport: 'phone', theme: 'dark' },
  error: 'locator timed out',
}], '/tmp');
eq(failedCase[0]?.ruleId, 'a11y/scan-failed', 'a failed app case becomes a blocking scan-failed Finding');
eq(failedCase[0]?.meta?.matrix?.state, 'error', 'the Finding preserves route/state/viewport/theme evidence');

const configRoot = mkdtempSync(join(tmpdir(), 'dk-app-proof-config-'));
try {
  writeFileSync(join(configRoot, 'dk.config.mjs'), `export default {
    proof: { baseUrl: 'http://127.0.0.1:3000', routes: ['/'], states: ['default'], viewports: [375], themes: ['light'] }
  };\n`);
  const resolved = await loadConfig(configRoot);
  eq(resolved.proof?.baseUrl, 'http://127.0.0.1:3000', 'loadConfig carries the real-app proof contract into gate context');
  eq(resolved.errors.length, 0, 'a valid proof contract has no config-fatal findings');
  const noDepsRoot = mkdtempSync(join(tmpdir(), 'dk-app-proof-nodeps-'));
  try {
    const unavailable = a11yGate({ root: noDepsRoot, files: [], config: resolved, emits: () => [] });
    eq(unavailable.kind, 'missing-dependency', 'a URL proof is applicable even when there are no local HTML targets');
    eq(unavailable.blocking, true, 'missing browser infrastructure for an applicable URL matrix is blocking');
    const incompleteArtifact = JSON.parse(readFileSync(join(noDepsRoot, '.dk', 'proof', 'app-proof.json'), 'utf8'));
    eq(incompleteArtifact.failure?.kind, 'missing-dependency', 'an incomplete attempt replaces stale proof with an honest failure artifact');
  } finally { rmSync(noDepsRoot, { recursive: true, force: true }); }
} finally { rmSync(configRoot, { recursive: true, force: true }); }

// Optional real-browser golden. Pure matrix/config assertions above always run;
// dependency-light installations keep an honest skip instead of claiming browser proof.
const golden = await browserReady();
if (golden.ok && process.env.DK_GOLDEN !== '0') {
  const server = spawn(process.execPath, [join(repo, 'tests', 'fixtures', 'proof-app-server.mjs'), '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const { port } = await readFirstJsonLine(server);
    const runner = spawnSync(process.execPath, [join(repo, 'src', 'proof', 'app-proof-runner.mjs')], {
      cwd: repo, encoding: 'utf8', timeout: 120_000,
      input: JSON.stringify({
        proof: {
          baseUrl: `http://127.0.0.1:${port}`,
          routes: 'auto',
          states: ['default', { name: 'details-open', actions: [{ type: 'click', selector: '#open-menu' }], waitFor: '#details:not([hidden])' }],
          viewports: [{ name: 'phone', width: 375, height: 812 }, { name: 'desktop', width: 1024, height: 768 }],
          themes: ['light', 'dark'],
        },
        tags: ['wcag2a', 'wcag2aa'],
      }),
    });
    eq(runner.status, 0, `real app-proof runner exits cleanly: ${runner.stderr}`);
    const output = JSON.parse(runner.stdout);
    eq(output.discovery, 'same-origin-linked-routes', 'runner reports the honest auto-discovery boundary');
    eq(output.tags, ['wcag2a', 'wcag2aa'], 'runner records the normalized Axe tag policy in durable proof');
    eq(output.coverage.plannedCases, 16, 'runner covers two discovered routes across the full 2×2×2 matrix');
    eq(output.coverage.failedCases, 0, 'every real URL/state/viewport/theme case completed');
    ok(output.results.every((entry) => !entry.error && Array.isArray(entry.violations)),
      'every planned case has a concrete axe result');
    eq(output.coverage.screenshotCases, 16, 'every completed matrix case has a durable screenshot');
    ok(output.results.every((entry) => /^[a-f0-9]{64}$/.test(entry.screenshot?.sha256 ?? '')),
      'every case records a screenshot digest');
    ok(output.usedTokens.includes('--proof-fg') && output.usedTokens.includes('--proof-bg'),
      'runtime token usage is collected from the CSS actually loaded by the app');

    const brokenRunner = spawnSync(process.execPath, [join(repo, 'src', 'proof', 'app-proof-runner.mjs')], {
      cwd: repo, encoding: 'utf8', timeout: 120_000,
      input: JSON.stringify({
        proof: {
          baseUrl: `http://127.0.0.1:${port}`, routes: ['/broken'], states: ['default'],
          viewports: [{ name: 'phone', width: 375, height: 812 }], themes: ['light'],
        },
        tags: ['wcag2a'],
      }),
    });
    eq(brokenRunner.status, 0, `known WCAG tags scan the real broken route: ${brokenRunner.stderr}`);
    const brokenOutput = JSON.parse(brokenRunner.stdout);
    eq(brokenOutput.qualityStatus, 'violations', 'the /broken fixture is demonstrably not clean under WCAG A');
    ok(brokenOutput.results[0]?.violations?.some((violation) => violation.id === 'image-alt'),
      'the real /broken scan catches its missing image alternative');

    const crashRunner = spawnSync(process.execPath, [join(repo, 'src', 'proof', 'app-proof-runner.mjs')], {
      cwd: repo, encoding: 'utf8', timeout: 120_000,
      input: JSON.stringify({ proof: {
        baseUrl: `http://127.0.0.1:${port}`, routes: ['/crash'], states: ['default'],
        viewports: [{ name: 'phone', width: 375, height: 812 }], themes: ['light'],
      } }),
    });
    eq(crashRunner.status, 0, `page errors are returned as structured case failures: ${crashRunner.stderr}`);
    const crashOutput = JSON.parse(crashRunner.stdout);
    eq(crashOutput.coverageStatus, 'incomplete', 'an uncaught page exception cannot be certified as complete proof');
    ok(/intentional-crash/.test(crashOutput.results[0]?.error ?? ''), 'the failed case preserves the uncaught page error');

    const lateCrashRunner = spawnSync(process.execPath, [join(repo, 'src', 'proof', 'app-proof-runner.mjs')], {
      cwd: repo, encoding: 'utf8', timeout: 120_000,
      input: JSON.stringify({ proof: {
        baseUrl: `http://127.0.0.1:${port}`, routes: ['/late-crash'], states: ['default'],
        viewports: [{ name: 'phone', width: 375, height: 812 }], themes: ['light'],
      } }),
    });
    eq(lateCrashRunner.status, 0, `late page errors are returned as structured case failures: ${lateCrashRunner.stderr}`);
    const lateCrashOutput = JSON.parse(lateCrashRunner.stdout);
    eq(lateCrashOutput.coverageStatus, 'incomplete', 'an exception scheduled during runtime-token/screenshot evidence cannot pass');
    ok(/late-token-crash/.test(lateCrashOutput.results[0]?.error ?? ''), 'the final runtime-error check preserves the late exception');

    const routeDriftRunner = spawnSync(process.execPath, [join(repo, 'src', 'proof', 'app-proof-runner.mjs')], {
      cwd: repo, encoding: 'utf8', timeout: 120_000,
      input: JSON.stringify({ proof: {
        baseUrl: `http://127.0.0.1:${port}`, routes: ['/'],
        states: [{ name: 'route-drift', actions: [{ type: 'click', selector: 'a[href="/pricing"]' }] }],
        viewports: [{ name: 'phone', width: 375, height: 812 }], themes: ['light'],
      } }),
    });
    eq(routeDriftRunner.status, 0, `route drift is returned as a structured case failure: ${routeDriftRunner.stderr}`);
    const routeDriftOutput = JSON.parse(routeDriftRunner.stdout);
    eq(routeDriftOutput.coverageStatus, 'incomplete', 'a state action cannot certify a different same-origin route');
    ok(/left declared proof route/.test(routeDriftOutput.results[0]?.error ?? ''),
      'same-origin route drift preserves an exact declared-route error');

    const originEscapeRunner = spawnSync(process.execPath, [join(repo, 'src', 'proof', 'app-proof-runner.mjs')], {
      cwd: repo, encoding: 'utf8', timeout: 120_000,
      input: JSON.stringify({ proof: {
        baseUrl: `http://127.0.0.1:${port}`, routes: ['/'],
        states: [{ name: 'origin-escape', actions: [{ type: 'click', selector: '#escape-origin' }] }],
        viewports: [{ name: 'phone', width: 375, height: 812 }], themes: ['light'],
      } }),
    });
    eq(originEscapeRunner.status, 0, `origin escape is returned as a structured case failure: ${originEscapeRunner.stderr}`);
    const originEscapeOutput = JSON.parse(originEscapeRunner.stdout);
    eq(originEscapeOutput.coverageStatus, 'incomplete', 'a state action cannot escape the proof.baseUrl origin');
    ok(/escaped proof\.baseUrl origin/.test(originEscapeOutput.results[0]?.error ?? ''),
      'cross-origin action navigation preserves the origin-boundary error');

    // End-to-end through the real CLI/ledger: no local HTML target is needed,
    // coverage emits survive report serialization, and a broken state blocks.
    // Keep the fixture below the package root so optional peer tooling resolves
    // exactly as it does for a repository that installed Axion's full gates.
    const gateRoot = mkdtempSync(join(repo, '.tmp-app-proof-gate-'));
    try {
      writeFileSync(join(gateRoot, 'source.css'), ':root { color-scheme: light dark; }\n');
      const writeGateConfig = (state, { route = '/', tags } = {}) => writeFileSync(join(gateRoot, 'dk.config.mjs'), `export default {
        tokens: { source: ${JSON.stringify(join(repo, 'design', 'tokens.json'))}, output: {} },
        targets: ['source.css'],
        ${tags === undefined ? '' : `gates: { a11y: { tags: ${JSON.stringify(tags)} } },`}
        proof: {
          baseUrl: 'http://127.0.0.1:${port}', routes: [${JSON.stringify(route)}],
          states: ${JSON.stringify([state])},
          viewports: [{ name: 'phone', width: 375, height: 812 }], themes: ['light']
        }
      };\n`);

      writeGateConfig('default', { route: '/broken', tags: [unknownA11yTag] });
      const cliUnknownTag = spawnSync(process.execPath,
        [join(repo, 'bin', 'dk.mjs'), 'verify', '--gate', 'a11y', '--require-gates', '--json'],
        { cwd: gateRoot, encoding: 'utf8', timeout: 120_000 });
      eq(cliUnknownTag.status, 2, 'real CLI rejects an unknown Axe tag as usage/config failure before scanning /broken');
      ok(cliUnknownTag.stderr.includes('gates.a11y.tags[0]'),
        'CLI rejection reports the exact invalid gates.a11y.tags item path');

      writeGateConfig('default');
      const cliPass = spawnSync(process.execPath,
        [join(repo, 'bin', 'dk.mjs'), 'verify', '--gate', 'a11y', '--require-gates', '--json'],
        { cwd: gateRoot, encoding: 'utf8', timeout: 120_000 });
      const passLedger = JSON.parse(cliPass.stdout);
      eq(cliPass.status, 0, `real CLI accepts a fully scanned app matrix: ${cliPass.stderr} ${cliPass.stdout}`);
      eq(passLedger.gates.find((gate) => gate.id === 'a11y')?.status, 'ran', 'real a11y gate runs against URL proof without HTML files');
      const persistedPass = JSON.parse(readFileSync(join(gateRoot, '.dk', 'report.json'), 'utf8'));
      eq(persistedPass.emits?.appProofCoverage?.plannedCases, 1, 'persistent evidence ledger exposes exact app matrix coverage');
      const proofArtifact = JSON.parse(readFileSync(join(gateRoot, '.dk', 'proof', 'app-proof.json'), 'utf8'));
      eq(proofArtifact.results.length, 1, 'dedicated proof artifact preserves every concrete matrix result');
      eq(proofArtifact.coverageStatus, 'complete', 'successful artifact declares complete matrix execution');
      eq(proofArtifact.tags, ['wcag2a', 'wcag2aa'], 'proof artifact records the exact Axe standards profile');
      eq(persistedPass.emits?.appProofTags, ['wcag2a', 'wcag2aa'], 'persistent ledger attests the artifact Axe tag scope');

      writeGateConfig({ name: 'missing-control', actions: [{ type: 'click', selector: '[data-never-exists]', timeoutMs: 200 }] });
      const cliFail = spawnSync(process.execPath,
        [join(repo, 'bin', 'dk.mjs'), 'verify', '--gate', 'a11y', '--require-gates', '--json'],
        { cwd: gateRoot, encoding: 'utf8', timeout: 120_000 });
      const failLedger = JSON.parse(cliFail.stdout);
      eq(cliFail.status, 1, 'a state that cannot be entered blocks the real CLI');
      ok(failLedger.findings.some((finding) => finding.ruleId === 'a11y/scan-failed'
          && finding.meta?.matrix?.state === 'missing-control'),
      'the blocking CLI Finding identifies the exact failed matrix state');
      const failedArtifact = JSON.parse(readFileSync(join(gateRoot, '.dk', 'proof', 'app-proof.json'), 'utf8'));
      eq(failedArtifact.coverageStatus, 'incomplete', 'a failed state overwrites the previous complete artifact instead of leaving stale proof');
    } finally { rmSync(gateRoot, { recursive: true, force: true }); }
  } finally {
    server.kill('SIGTERM');
  }
} else {
  process.stdout.write(`app proof browser golden: skipped (${golden.reason})\n`);
}

process.stdout.write(`app proof: ${assertions} assertions, 0 failures\n`);

async function browserReady() {
  const require = createRequire(join(repo, 'x.js'));
  try { require.resolve('@playwright/test'); require.resolve('@axe-core/playwright'); }
  catch { return { ok: false, reason: 'missing @playwright/test or @axe-core/playwright' }; }
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { chromium } from '@playwright/test'; try { const b=await chromium.launch(); await b.close(); } catch(e) { process.stderr.write(e.message); process.exit(1); }`],
  { cwd: repo, encoding: 'utf8', timeout: 30_000 });
  return probe.status === 0 ? { ok: true } : { ok: false, reason: 'Chromium is not installed' };
}

function readFirstJsonLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = '', stderr = '';
    const timeout = setTimeout(() => reject(new Error(`proof fixture server did not start: ${stderr}`)), 10_000);
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try { resolve(JSON.parse(stdout.slice(0, newline))); }
      catch (error) { reject(error); }
    });
    child.once('exit', (code) => { if (code && !stdout.includes('\n')) { clearTimeout(timeout); reject(new Error(`server exited ${code}: ${stderr}`)); } });
  });
}
