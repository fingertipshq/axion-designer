import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

import { loadConfig } from '../src/core/config.mjs';
import { run } from '../src/core/ledger.mjs';
import { renderHtml, renderJson, renderTerminal } from '../src/core/report.mjs';
import { compile, validateTokens } from '../src/core/tokens.mjs';
import {
  a11yResultsToFindings,
  parseStylelintJson,
  resolveVisualMatrix,
  visualGate,
  visualMatrixEnvironment,
} from '../src/gates/heavy.mjs';
import { slopGate } from '../src/gates/slop.mjs';
import { readVisualMatrix, visualCases } from '../templates/scaffold/gates/visual-matrix.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
let assertions = 0;
const ok = (value, message) => { assert.ok(value, message); assertions++; };
const eq = (actual, expected, message) => { assert.equal(actual, expected, message); assertions++; };

// npm/npx on the supported Node floor can prefix launcher warnings. A valid
// stylelint payload must still be consumed instead of turning into a skipped gate.
const noisyStylelint = `npm WARN EBADENGINE Unsupported engine\n[{
  "source":"index.css","warnings":[]
}]\nnpm notice done`;
eq(parseStylelintJson(noisyStylelint)?.[0]?.source, 'index.css',
  'stylelint JSON survives npm warning noise');

eq(a11yResultsToFindings([{ file: '/tmp/broken.html', error: 'navigation failed' }], '/tmp')[0]?.severity,
  'error', 'an unscanned a11y target is blocking and cannot count as a verified pass');

// An explicit font allow is a project-level approval and must override both
// the built-in AI-font list and a conflicting custom deny entry.
const fontFindings = (font, fonts) => slopGate({
  manifest: { flat: new Map() },
  files: [{ path: 'font.css', source: `.x { font-family: "${font}", sans-serif; }` }],
  config: { fonts, slopRules: [], enforce: {} },
}).findings.filter((f) => f.ruleId === 'slop/ai-font');
eq(fontFindings('Inter', { allow: [], deny: [] }).length, 1,
  'builtin font is denied when it has not been explicitly approved');
eq(fontFindings('Inter', { allow: ['  "INTER"  '], deny: ['Inter'] }).length, 0,
  'normalized explicit allow overrides builtin and conflicting custom deny');
eq(fontFindings('Brand Sans', { allow: ['Brand  Sans'], deny: ['Brand Sans'] }).length, 0,
  'explicit allow overrides a custom deny with normalized whitespace');
eq(fontFindings('Brand Sans', { allow: [], deny: ['Brand Sans'] }).length, 1,
  'custom deny remains active when there is no explicit allow');

// gates.visual.viewports/themes is an executable coverage contract: the gate
// serializes it into the runner environment and the scaffold expands exactly
// one stable case per viewport × theme.
const visualMatrix = resolveVisualMatrix({ gates: { visual: {
  viewports: [390, 1280, 390, -1, 1.5],
  themes: [' light ', 'brand/night', 'light', ''],
} } });
eq(JSON.stringify(visualMatrix), JSON.stringify({
  viewports: [390, 1280], themes: ['light', 'brand/night'],
}), 'visual matrix normalizes, de-duplicates, and preserves configured coverage');
const visualEnv = visualMatrixEnvironment(visualMatrix);
eq(JSON.stringify(readVisualMatrix(visualEnv)), JSON.stringify(visualMatrix),
  'scaffold consumes the exact visual matrix emitted by the gate runner');
const visualCasesResolved = visualCases(readVisualMatrix(visualEnv));
eq(visualCasesResolved.length, 4, 'scaffold expands viewport × theme into four screenshot cases');
eq(new Set(visualCasesResolved.map((c) => c.snapshotKey)).size, 4,
  'each visual matrix case has a distinct portable snapshot key');
eq(JSON.stringify(resolveVisualMatrix({ gates: { visual: { viewports: [], themes: [] } } })),
  JSON.stringify({ viewports: [375, 1024], themes: ['light', 'dark'] }),
  'an empty matrix fails safe to documented coverage instead of registering zero tests');

// Default discovery covers standalone styles, scripts, and Astro—not only
// component/template extensions.
const defaultConfigRoot = mkdtempSync(join(tmpdir(), 'dk-config-p0-'));
try {
  const cfg = await loadConfig(defaultConfigRoot);
  const defaults = cfg.targets.join(',');
  for (const ext of ['css', 'scss', 'less', 'js', 'ts', 'astro']) {
    ok(defaults.includes(ext), `default targets include ${ext}`);
  }
  eq(cfg.failOnSkipped, false, 'recommended keeps benign first-run skips non-blocking');
} finally { rmSync(defaultConfigRoot, { recursive: true, force: true }); }

const strictConfigRoot = mkdtempSync(join(tmpdir(), 'dk-config-strict-p0-'));
try {
  writeFileSync(join(strictConfigRoot, 'dk.config.mjs'), 'export default { preset: "strict" };\n');
  const strict = await loadConfig(strictConfigRoot);
  eq(strict.failOnSkipped, true, 'strict preset requires every attempted gate');
} finally { rmSync(strictConfigRoot, { recursive: true, force: true }); }

// Machine, terminal, and HTML surfaces must never call an incomplete pipeline
// "All passed" merely because it has zero findings.
const incomplete = {
  status: 'incomplete', exitCode: 1,
  counts: { error: 0, warn: 0, info: 0 }, findings: [],
  gates: [{ id: 'a11y', status: 'skipped', attempted: true, blocking: true,
    kind: 'missing-dependency', reason: 'missing dependency' }],
  filesScanned: 1, tokenHash: 'test-token-hash', emits: {}, suppressed: 0,
};
const terminal = renderTerminal(incomplete, { presetName: 'recommended' }, { color: false });
ok(terminal.includes('管線未完成') || terminal.includes('Pipeline incomplete'),
  'terminal identifies an incomplete pipeline');
ok(!terminal.includes('全數通過') && !terminal.includes('All passed'),
  'terminal does not claim all passed');
const html = renderHtml(incomplete, { presetName: 'recommended' });
ok(html.includes('管線未完成') || html.includes('Pipeline incomplete'),
  'HTML identifies an incomplete pipeline');
ok(!html.includes('全數通過') && !html.includes('All passed'),
  'HTML does not claim all passed');
const json = JSON.parse(renderJson(incomplete, { presetName: 'recommended' }));
eq(json.status, 'incomplete', 'JSON exposes the run status');

// The zh surfaces honor the same contract: an incomplete run may not contain
// the literal success marker anywhere — not even inside a negation — because
// humans and scripts grep terminals for that exact phrase. CI runs in an
// English locale, so this is exercised through an explicit zh subprocess.
{
  const zhProbe = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { renderTerminal, renderHtml } from ${JSON.stringify(new URL('../src/core/report.mjs', import.meta.url).href)};
    const incomplete = ${JSON.stringify(incomplete)};
    const terminal = renderTerminal(incomplete, { presetName: 'recommended' }, { color: false });
    const html = renderHtml(incomplete, { presetName: 'recommended' });
    if (terminal.includes('全數通過') || html.includes('全數通過')) {
      console.error('zh incomplete surface leaks the success marker');
      process.exit(1);
    }
    if (!terminal.includes('管線未完成')) {
      console.error('zh terminal must identify the incomplete pipeline');
      process.exit(1);
    }
  `], { encoding: 'utf8', env: { ...process.env, DK_LANG: 'zh-TW' } });
  eq(zhProbe.status, 0, `zh incomplete surfaces ban the success marker${zhProbe.stderr ? ` — ${zhProbe.stderr.trim()}` : ''}`);
}
eq(json.gates[0].blocking, true, 'JSON exposes blocking skip metadata');

// Generated CSS must reject structural injection without narrowing legitimate
// DTCG string values such as font stacks, functions, quoted semicolons, or data URLs.
const badIdentifier = { 'safe;}body{color:red': { $value: '#fff' } };
ok(validateTokens(badIdentifier).some((message) => /CSS custom-property identifier/.test(message)),
  'unsafe token names are reported before CSS generation');
let badIdentifierBlocked = false;
try { compile(badIdentifier); } catch (error) { badIdentifierBlocked = error?.code === 'DK_TOKEN'; }
ok(badIdentifierBlocked, 'unsafe token names cannot escape into generated CSS');

const badValue = { color: { attack: { $value: '#fff; } body { color: red' } } };
ok(validateTokens(badValue).some((message) => /top-level/.test(message)),
  'top-level CSS declaration terminators are reported');
let badValueBlocked = false;
try { compile(badValue); } catch (error) { badValueBlocked = error?.code === 'DK_TOKEN'; }
ok(badValueBlocked, 'unsafe token values cannot append another CSS rule');

const legalStrings = {
  font: { family: { $value: '"Iowan Old Style", system-ui, sans-serif' } },
  shadow: { card: { $value: '0 4px 24px rgba(0,0,0,0.06)' } },
  motion: { curve: { $value: 'cubic-bezier(0.16, 1, 0.3, 1)' } },
  content: { quoted: { $value: '"semi;colon"' } },
  asset: { inline: { $value: 'url("data:image/svg+xml;utf8,<svg></svg>")' } },
  '文字': { '尺度': { $value: '1rem' } },
};
eq(validateTokens(legalStrings).length, 0,
  'legal DTCG CSS strings and non-ASCII identifiers remain accepted');
const legalCss = compile(legalStrings).css;
ok(legalCss.includes('"semi;colon"') && legalCss.includes('data:image/svg+xml;utf8,<svg></svg>')
    && legalCss.includes('--文字-尺度: 1rem;'),
  'legal quoted, balanced, and non-ASCII values remain byte-preserved');

// A ledger is local project data, not trusted markup. Every dynamic field is
// escaped, malformed collection/count types fail closed, and the inline style
// is authorized by an exact CSP hash rather than unsafe-inline.
const htmlAttack = '"><img src=x onerror=alert(1)>';
const hostileHtml = renderHtml({
  status: 'failed', exitCode: 1,
  counts: { error: 1, warn: 0, info: 0 },
  findings: [{ ruleId: `slop/${htmlAttack}`, severity: 'error', file: htmlAttack,
    line: htmlAttack, col: htmlAttack, message: htmlAttack, fix: htmlAttack, evidence: htmlAttack }],
  gates: [{ id: `slop/${htmlAttack}`, status: 'skipped', reason: htmlAttack }],
  filesScanned: htmlAttack, tokenHash: htmlAttack, emits: { verifiedPairs: { length: htmlAttack } },
}, { presetName: htmlAttack });
ok(!hostileHtml.includes(htmlAttack) && !hostileHtml.includes('<img') && hostileHtml.includes('&lt;img'),
  'HTML report escapes every attacker-controlled ledger interpolation');
const styleText = /<style>([\s\S]*?)<\/style>/.exec(hostileHtml)?.[1] ?? '';
const styleDigest = createHash('sha256').update(styleText).digest('base64');
ok(hostileHtml.includes('http-equiv="Content-Security-Policy"')
    && hostileHtml.includes(`sha256-${styleDigest}`)
    && !hostileHtml.includes('unsafe-inline'),
  'HTML report carries a self-contained CSP with the exact inline-style hash');
let malformedHtml = '';
try {
  malformedHtml = renderHtml({ status: {}, counts: { error: '1' }, findings: 'bad', gates: {},
    filesScanned: htmlAttack, emits: { verifiedPairs: { length: htmlAttack } } }, { presetName: {} });
} catch { /* assertion below reports the regression */ }
ok(malformedHtml.includes('Pipeline incomplete') || malformedHtml.includes('管線未完成'),
  'HTML report type-checks malformed ledger collections and fails closed');

const terminalAttack = '\x1b]8;;https://evil.test\x07LABEL\x1b]8;;\x07\rFORGED\nNEXT\u009b31m\u202e';
const hostileTerminal = renderTerminal({
  status: 'failed', exitCode: 1,
  counts: { error: 1, warn: 0, info: 0 },
  findings: [{ ruleId: `slop/${terminalAttack}`, severity: 'error', file: terminalAttack,
    message: terminalAttack, fix: terminalAttack, docs: terminalAttack }],
  gates: [{ id: 'slop', status: 'ran' }], filesScanned: 1, tokenHash: terminalAttack, emits: {},
}, { presetName: terminalAttack }, { color: false });
ok(!/[\u001b\u0007\u000d\u009b\u202e]/.test(hostileTerminal)
    && !hostileTerminal.includes('FORGED\nNEXT') && hostileTerminal.includes('FORGED NEXT'),
  'terminal report removes ANSI/OSC/C1, carriage-return, newline, and bidi injection controls');

// An explicit full run with missing heavy infrastructure is non-zero. Use a
// temp cwd outside this repo so optional dependencies cannot resolve upward.
const missingDepsRoot = mkdtempSync(join(tmpdir(), 'dk-full-p0-'));
try {
  writeFileSync(join(missingDepsRoot, 'index.html'), '<!doctype html><html lang="en"><title>x</title><p>x</p></html>\n');
  const base = await loadConfig(repo);
  const cfg = {
    ...base,
    cwd: missingDepsRoot,
    targets: ['index.html'],
    baselinePath: join(missingDepsRoot, '.dk', 'baseline.json'),
    // Keep the repository's known-good token input/output while dependency
    // resolution and source scanning happen from the isolated cwd.
  };
  const result = run(cfg, { full: true, cache: false });
  eq(result.exitCode, 1, '--full fails when requested infrastructure is missing');
  ok(result.gates.some((g) => g.status === 'skipped' && g.blocking),
    'blocking skipped gate is recorded');
} finally { rmSync(missingDepsRoot, { recursive: true, force: true }); }

// `failOnSkipped` also covers benign/non-infrastructure skips: strict means the
// requested gate must actually run, not merely avoid crashing.
const strictSkipRoot = mkdtempSync(join(repo, '.tmp-p0-strict-skip-'));
try {
  writeFileSync(join(strictSkipRoot, 'only.css'), ':root{color:var(--color-text-primary)}\n');
  const base = await loadConfig(repo);
  const cfg = {
    ...base, cwd: strictSkipRoot, targets: ['only.css'], failOnSkipped: true,
    baselinePath: join(strictSkipRoot, '.dk', 'baseline.json'),
  };
  const result = run(cfg, { only: 'a11y', cache: false });
  eq(result.gates.find((g) => g.id === 'a11y')?.kind, 'not-applicable',
    'a11y records a non-applicable skip when there is no HTML');
  eq(result.exitCode, 1, 'failOnSkipped makes every attempted skip non-zero');
  eq(result.status, 'incomplete', 'skipped-only failure remains semantically incomplete');

  writeFileSync(join(strictSkipRoot, 'dk.config.mjs'), `export default {
    preset: 'recommended',
    tokens: { source: ${JSON.stringify(base.tokensPath)}, output: { css: ${JSON.stringify(base.output.css)} } },
    targets: ['only.css'], failOnSkipped: false
  };\n`);
  const cli = spawnSync(process.execPath,
    [join(repo, 'bin', 'dk.mjs'), 'verify', '--gate', 'a11y', '--require-gates', '--json'],
    { cwd: strictSkipRoot, encoding: 'utf8' });
  eq(cli.status, 1, '--require-gates exposes strict skip semantics on the CLI');
  eq(JSON.parse(cli.stdout).status, 'incomplete', 'CLI reports require-gates failure as incomplete');
} finally { rmSync(strictSkipRoot, { recursive: true, force: true }); }

// A changed global token hash is audit context, not proof that tokens caused a
// screenshot diff. Pixel changes remain errors, and ordinary baseline updates
// are fail-closed until force is explicit.
const visualRoot = mkdtempSync(join(repo, '.tmp-p0-visual-'));
const oldUpdate = process.env.DK_UPDATE_VISUAL;
try {
  writeFileSync(join(visualRoot, 'index.html'), '<!doctype html><html><style>body{margin:0;background:#fff}</style><p>before</p></html>\n');
  writeFileSync(join(visualRoot, 'gates-placeholder'), '');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(visualRoot, 'gates'), { recursive: true });
  writeFileSync(join(visualRoot, 'gates', 'visual.spec.mjs'), `
    import { test, expect } from '@playwright/test';
    test('p0', async ({ page }) => {
      await page.setViewportSize({ width: 480, height: 320 });
      await page.goto(new URL('../index.html', import.meta.url).href);
      await expect(page).toHaveScreenshot('p0.png', { animations: 'disabled' });
    });
  `);
  const ctx = (hash) => ({
    root: visualRoot, manifest: { tokenHash: hash }, files: [], config: {},
    emits: (key) => key === 'tokenHash' ? hash : undefined,
  });

  process.env.DK_UPDATE_VISUAL = '1';
  const created = visualGate(ctx('hash-before'));
  ok(!created.status, 'initial visual baseline can be created explicitly');

  writeFileSync(join(visualRoot, 'index.html'), '<!doctype html><html><style>body{margin:0;background:#000;color:#fff}</style><p>after</p></html>\n');
  delete process.env.DK_UPDATE_VISUAL;
  const diff = visualGate(ctx('hash-after'));
  eq(diff.findings?.[0]?.severity, 'error', 'tokenHash change never downgrades a pixel diff');
  eq(diff.findings?.[0]?.meta?.verification, 'UNVERIFIED',
    'tokenHash is recorded as unverified context, not causal attribution');

  process.env.DK_UPDATE_VISUAL = '1';
  const refused = visualGate(ctx('hash-after'));
  eq(refused.findings?.[0]?.severity, 'error', 'ordinary update refuses a changed baseline');
  eq(refused.findings?.[0]?.meta?.updateRefused, true, 'refusal is machine-visible');

  process.env.DK_UPDATE_VISUAL = 'force';
  const accepted = visualGate(ctx('hash-after'));
  ok(!accepted.status && accepted.findings?.[0]?.severity === 'info',
    'force explicitly accepts the new visual baseline');
} finally {
  if (oldUpdate == null) delete process.env.DK_UPDATE_VISUAL;
  else process.env.DK_UPDATE_VISUAL = oldUpdate;
  rmSync(visualRoot, { recursive: true, force: true });
}

process.stdout.write(`p0 gates: ${assertions} assertions, 0 failures\n`);
