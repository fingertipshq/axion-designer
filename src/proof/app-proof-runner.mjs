/* ============================================================
   App Proof Playwright runner.

   Input: JSON plan on stdin (normalized again in this process).
   Output: one JSON document on stdout. Per-case failures are structured results
   so the gate can emit precise blocking Findings; browser/import/config failures
   use non-zero exit and are treated as incomplete infrastructure upstream.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  AppProofConfigError,
  normalizeAppProofConfig,
  normalizeDiscoveredRoutes,
  buildAppProofMatrix,
  appProofConfigHash,
} from './app-proof.mjs';
import { safeWriteFileSync } from '../core/safe-write.mjs';
import { normalizeA11yTags, validateA11yTags } from '../core/a11y-tags.mjs';

const SCREENSHOT_DIR = '.dk/proof/screenshots';

async function main() {
  let raw;
  try { raw = JSON.parse(readFileSync(0, 'utf8') || '{}'); }
  catch (error) { return fatal(2, `app-proof plan is not valid JSON: ${oneLine(error)}`); }

  let plan;
  try { plan = normalizeAppProofConfig(raw.proof ?? raw); }
  catch (error) { return fatal(2, oneLine(error)); }
  const inputTags = raw.tags === undefined ? [] : raw.tags;
  const tagIssues = validateA11yTags(inputTags, 'tags');
  if (tagIssues.length) return fatal(2, `invalid app-proof Axe tags: ${tagIssues.map((issue) => issue.message).join('; ')}`);
  const tags = normalizeA11yTags(inputTags, 'tags');

  let chromium, AxeBuilder;
  try {
    ({ chromium } = await import('@playwright/test'));
    ({ default: AxeBuilder } = await import('@axe-core/playwright'));
  } catch (error) {
    return fatal(3, `app-proof dependencies could not be imported: ${oneLine(error)}`);
  }

  let browser;
  try { browser = await chromium.launch(); }
  catch (error) { return fatal(4, `chromium could not start: ${oneLine(error)}`); }

  const startedAt = new Date().toISOString();
  try {
    const routes = plan.routes === 'auto' ? await discoverRoutes(browser, plan) : plan.routes;
    const matrix = buildAppProofMatrix(plan, routes);
    const results = [];
    for (const target of matrix) results.push(await scanTarget(browser, plan, target, AxeBuilder, tags, process.cwd()));
    const failed = results.filter((entry) => entry.error).length;
    const violationCount = results.reduce((sum, entry) => sum + (entry.violations?.length ?? 0), 0);
    const usedTokens = [...new Set(results.flatMap((entry) => entry.usedTokens ?? []))].sort();
    process.stdout.write(JSON.stringify({
      schemaVersion: 2,
      kind: 'axion-app-proof',
      configHash: appProofConfigHash(plan, tags),
      tags,
      coverageStatus: failed ? 'incomplete' : 'complete',
      qualityStatus: violationCount ? 'violations' : 'clean',
      startedAt,
      finishedAt: new Date().toISOString(),
      discovery: plan.routes === 'auto' ? 'same-origin-linked-routes' : 'explicit-routes',
      coverage: {
        routes: routes.map((route) => ({ name: route.name, url: route.url })),
        states: [...new Set(matrix.map((entry) => entry.state.name))],
        viewports: plan.viewports,
        themes: plan.themes.map((theme) => ({ name: theme.name, colorScheme: theme.colorScheme })),
        plannedCases: matrix.length,
        completedCases: results.length - failed,
        failedCases: failed,
        screenshotCases: results.filter((entry) => entry.screenshot).length,
      },
      summary: { cases: matrix.length, failed, violations: violationCount },
      results,
      usedTokens,
    }));
  } catch (error) {
    if (error instanceof AppProofConfigError) return fatal(2, oneLine(error));
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function discoverRoutes(browser, plan) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let hrefs;
  try {
    const response = await page.goto(plan.baseUrl, { waitUntil: 'domcontentloaded', timeout: plan.timeoutMs });
    if (!response) throw new Error('navigation returned no HTTP response');
    if (response.status() >= 400) throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
    assertSameOrigin(page.url(), plan.baseUrl);
    hrefs = await page.locator('a[href]').evaluateAll((anchors) => anchors
      .filter((anchor) => {
        const style = getComputedStyle(anchor);
        return style.display !== 'none' && style.visibility !== 'hidden' && anchor.getClientRects().length > 0;
      })
      .map((anchor) => anchor.href));
  } catch (error) {
    throw new Error(`auto route discovery failed at ${plan.baseUrl}: ${oneLine(error)}`);
  } finally {
    await context.close().catch(() => {});
  }
  return normalizeDiscoveredRoutes(plan, hrefs);
}

async function scanTarget(browser, plan, target, AxeBuilder, tags, root) {
  const context = await browser.newContext({
    viewport: { width: target.viewport.width, height: target.viewport.height },
    colorScheme: target.theme.colorScheme,
  });
  const page = await context.newPage();
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(`uncaught page error: ${oneLine(error)}`));
  page.on('crash', () => runtimeErrors.push('page crashed'));
  const result = {
    id: target.id,
    file: target.label,
    target: target.label,
    url: target.url,
    matrix: target.matrix,
    violations: [],
    usedTokens: [],
  };
  try {
    await page.addInitScript(applyTheme, target.theme);
    const response = await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: plan.timeoutMs });
    if (!response) throw new Error('navigation returned no HTTP response');
    if (response.status() >= 400) throw new Error(`HTTP ${response.status()} ${response.statusText()}`);
    assertProofTarget(page.url(), target.url, plan.baseUrl);
    await page.evaluate(applyTheme, target.theme);
    assertProofTarget(page.url(), target.url, plan.baseUrl);
    if (target.route.waitFor) {
      await page.locator(target.route.waitFor).waitFor({ state: 'visible', timeout: plan.timeoutMs });
      assertProofTarget(page.url(), target.url, plan.baseUrl);
    }
    for (const action of target.state.actions) {
      await runAction(page, action, plan.timeoutMs);
      assertProofTarget(page.url(), target.url, plan.baseUrl);
    }
    if (target.state.waitFor) {
      await page.locator(target.state.waitFor).waitFor({ state: 'visible', timeout: plan.timeoutMs });
      assertProofTarget(page.url(), target.url, plan.baseUrl);
    }
    // Yield once so synchronous and queued errors caused by navigation/state
    // setup reach Playwright's pageerror event before we certify the state.
    await page.waitForTimeout(0);
    assertProofTarget(page.url(), target.url, plan.baseUrl);
    assertNoRuntimeErrors(runtimeErrors);
    let axe = new AxeBuilder({ page });
    if (tags.length) axe = axe.withTags(tags);
    const { violations } = await axe.analyze();
    assertProofTarget(page.url(), target.url, plan.baseUrl);
    assertNoRuntimeErrors(runtimeErrors);
    result.violations = violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      helpUrl: violation.helpUrl,
      nodes: (violation.nodes ?? []).slice(0, 5).map((node) => ({ target: node.target, html: node.html })),
    }));
    result.usedTokens = await page.evaluate(collectRuntimeCssTokens);
    await page.waitForTimeout(0);
    assertProofTarget(page.url(), target.url, plan.baseUrl);
    assertNoRuntimeErrors(runtimeErrors);
    assertProofTarget(page.url(), target.url, plan.baseUrl);
    const screenshot = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide' });
    await page.waitForTimeout(0);
    assertProofTarget(page.url(), target.url, plan.baseUrl);
    assertNoRuntimeErrors(runtimeErrors);
    const screenshotPath = `${SCREENSHOT_DIR}/${target.id}.png`;
    safeWriteFileSync(root, join(root, screenshotPath), screenshot);
    result.screenshot = {
      path: screenshotPath,
      sha256: createHash('sha256').update(screenshot).digest('hex'),
      bytes: screenshot.length,
      width: target.viewport.width,
      height: target.viewport.height,
      fullPage: true,
    };
  } catch (error) {
    result.error = oneLine(error);
    delete result.violations;
  } finally {
    await context.close().catch(() => {});
  }
  return result;
}

function assertNoRuntimeErrors(errors) {
  if (errors.length) throw new Error(errors.slice(0, 3).join(' | '));
}

// Serialized into the page. This records CSS custom properties referenced by
// the stylesheets and inline styles actually loaded for the concrete state.
// Cross-origin CSSOM access is intentionally skipped when the browser denies it.
function collectRuntimeCssTokens() {
  const used = new Set();
  const scan = (text) => {
    for (const match of String(text || '').matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) used.add(match[1]);
  };
  const walkRules = (rules) => {
    for (const rule of Array.from(rules || [])) {
      scan(rule.cssText);
      try { if (rule.cssRules) walkRules(rule.cssRules); } catch { /* inaccessible nested rules */ }
    }
  };
  for (const sheet of Array.from(document.styleSheets || [])) {
    try { walkRules(sheet.cssRules); } catch { /* cross-origin stylesheet */ }
  }
  for (const element of document.querySelectorAll('[style]')) scan(element.getAttribute('style'));
  return [...used].sort();
}

async function runAction(page, action, defaultTimeout) {
  const timeout = action.timeoutMs ?? defaultTimeout;
  const locator = page.locator(action.selector);
  switch (action.type) {
    case 'click': await locator.click({ timeout }); break;
    case 'fill': await locator.fill(action.value, { timeout }); break;
    case 'check': await locator.check({ timeout }); break;
    case 'uncheck': await locator.uncheck({ timeout }); break;
    case 'select': await locator.selectOption(action.value, { timeout }); break;
    case 'press': await locator.press(action.key, { timeout }); break;
    case 'waitFor': await locator.waitFor({ state: action.state ?? 'visible', timeout }); break;
    default: throw new Error(`unsupported app-proof action: ${action.type}`);
  }
}

// Serialized into the page by Playwright. Keep self-contained: no closures.
function applyTheme(theme) {
  const apply = () => {
    const root = document.documentElement;
    if (!root) return false;
    for (const [key, value] of Object.entries(theme.attributes || {})) root.setAttribute(key, value);
    for (const name of theme.classes || []) root.classList.add(name);
    root.style.colorScheme = theme.colorScheme === 'light' || theme.colorScheme === 'dark' ? theme.colorScheme : '';
    return true;
  };
  if (!apply()) {
    const observer = new MutationObserver(() => { if (apply()) observer.disconnect(); });
    observer.observe(document, { childList: true, subtree: true });
  }
}

function assertSameOrigin(actual, expected) {
  if (new URL(actual).origin !== new URL(expected).origin) {
    throw new Error(`navigation escaped proof.baseUrl origin (${actual})`);
  }
}
function assertProofTarget(actual, expected, baseUrl) {
  assertSameOrigin(actual, baseUrl);
  const current = new URL(actual);
  const declared = new URL(expected);
  // Route normalization deliberately removes fragments, so in-document hash
  // navigation remains the same proof target. Path and query stay exact.
  current.hash = '';
  declared.hash = '';
  if (current.href !== declared.href) {
    throw new Error(`navigation left declared proof route (${declared.href} -> ${current.href})`);
  }
}
function oneLine(error) { return String(error?.message ?? error).replace(/[\r\n\u2028\u2029]+/g, ' ').trim(); }
function fatal(code, message) { process.stderr.write(`${message}\n`); process.exitCode = code; }

main().catch((error) => fatal(5, `app-proof runner failed unexpectedly: ${error?.stack ?? error}`));
