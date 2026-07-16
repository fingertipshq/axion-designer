/* ============================================================
   P3 drift benchmark — ten real mutations against an isolated copy of the
   shipped scaffold. Every round must be detected by the expected rule and
   must return to green after byte-for-byte restoration.

   This is product proof, not a mocked score: each assertion invokes the same
   public `dk verify --json --no-cache` command users and CI run.
   ============================================================ */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDirectionLock,
  hashDirectionBindings,
} from '../core/direction.mjs';
import { appendApproval, defaultApprovalHistoryPath } from '../core/approvals.mjs';
import { loadTokens, resolve as resolveToken } from '../core/tokens.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = join(HERE, '..', '..');
const DEFAULT_CLI = join(PACKAGE_ROOT, 'bin', 'dk.mjs');
const DEFAULT_SCAFFOLD = join(PACKAGE_ROOT, 'templates', 'scaffold');
const MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 300_000;

export const DRIFT_BENCHMARK_SCHEMA = 'dk-drift-benchmark/v1';

export async function runDriftBenchmark(options = {}) {
  const cli = options.cli ?? DEFAULT_CLI;
  const scaffold = options.scaffold ?? DEFAULT_SCAFFOLD;
  const timeoutMs = benchmarkTimeout(options.timeoutMs);

  // Validate caller-owned paths before allocating a temporary directory. A
  // typo in the public API must not leave an empty benchmark workspace behind.
  if (!existsSync(cli)) throw new Error(`Axion CLI not found: ${cli}`);
  if (!existsSync(scaffold)) throw new Error(`Axion scaffold not found: ${scaffold}`);

  const tempRoot = mkdtempSync(join(options.tempRoot ?? tmpdir(), 'axion-p3-benchmark-'));
  const workspace = join(tempRoot, 'workspace');
  const started = new Date();
  const keepWorkspace = options.keepWorkspace === true;
  const rounds = [];
  const planned = scenarios();
  let initialFindingCount = 0;
  let cleanChecks = 0;
  let failure = null;

  try {
    cpSync(scaffold, workspace, { recursive: true });
    prepareGovernedWorkspace(workspace);
    const initial = verify(cli, workspace, timeoutMs);
    if (initial.timedOut) {
      failure = timeoutFailure('baseline', null, null, timeoutMs);
    } else {
      initialFindingCount = initial.report.findings?.length ?? 0;
      if (initial.exitCode !== 0 || initialFindingCount) {
        throw new Error(`Benchmark baseline is not green: ${JSON.stringify(initial.report.findings ?? [])}`);
      }
      cleanChecks++;
    }

    for (const scenario of failure ? [] : planned) {
      const originals = snapshot(workspace, scenario.files);
      const iterationStarted = performance.now();
      let detected;
      try {
        scenario.mutate(workspace);
        detected = verify(cli, workspace, timeoutMs);
      } finally {
        // A timed-out or malformed verifier must not defeat the benchmark's
        // byte-restoration guarantee, including when --keep-workspace is used.
        restore(workspace, originals);
      }
      const detectionMs = performance.now() - iterationStarted;
      if (detected.timedOut) {
        rounds.push(timeoutRound(rounds.length + 1, scenario, 'detection', detectionMs));
        failure = timeoutFailure('detection', rounds.length, scenario.id, timeoutMs);
        break;
      }
      const observedRules = [...new Set((detected.report.findings ?? []).map((finding) => finding.ruleId))].sort();
      const expectedDetected = detected.exitCode === 1 && observedRules.includes(scenario.expectedRule);

      const recoveryStarted = performance.now();
      const recovered = verify(cli, workspace, timeoutMs);
      const recoveryMs = performance.now() - recoveryStarted;
      if (recovered.timedOut) {
        rounds.push({
          round: rounds.length + 1,
          id: scenario.id,
          dimension: scenario.dimension,
          mutation: scenario.mutation,
          expectedRule: scenario.expectedRule,
          expectedDetected,
          observedRules,
          exitCode: detected.exitCode,
          findingCount: detected.report.findings?.length ?? 0,
          detectionMs: roundMs(detectionMs),
          recoveryClean: false,
          recoveryExitCode: 2,
          recoveryFindingCount: 0,
          recoveryMs: roundMs(recoveryMs),
          timeoutPhase: 'recovery',
        });
        failure = timeoutFailure('recovery', rounds.length, scenario.id, timeoutMs);
        break;
      }
      const recoveryClean = recovered.exitCode === 0 && (recovered.report.findings ?? []).length === 0;
      cleanChecks++;

      rounds.push({
        round: rounds.length + 1,
        id: scenario.id,
        dimension: scenario.dimension,
        mutation: scenario.mutation,
        expectedRule: scenario.expectedRule,
        expectedDetected,
        observedRules,
        exitCode: detected.exitCode,
        findingCount: detected.report.findings?.length ?? 0,
        detectionMs: roundMs(detectionMs),
        recoveryClean,
        recoveryExitCode: recovered.exitCode,
        recoveryFindingCount: recovered.report.findings?.length ?? 0,
        recoveryMs: roundMs(recoveryMs),
      });
    }

    const finished = new Date();
    const detectedCount = rounds.filter((round) => round.expectedDetected).length;
    const recoveredCount = rounds.filter((round) => round.recoveryClean).length;
    const unexpectedFindings = rounds.reduce((sum, round) => sum + round.recoveryFindingCount, 0)
      + initialFindingCount;
    const report = {
      schema: DRIFT_BENCHMARK_SCHEMA,
      status: !failure && detectedCount === planned.length && recoveredCount === planned.length && unexpectedFindings === 0
        ? 'passed' : 'failed',
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      isolation: 'fresh OS temporary workspace copied from the shipped scaffold',
      command: 'dk verify --json --no-cache',
      timeoutMs,
      rounds: planned.length,
      completedRounds: rounds.filter((round) => !round.timeoutPhase).length,
      detected: detectedCount,
      recovered: recoveredCount,
      detectionRate: ratio(detectedCount, planned.length),
      recoveryRate: ratio(recoveredCount, planned.length),
      cleanChecks,
      timeouts: failure?.kind === 'timeout' ? 1 : 0,
      unexpectedFindings,
      medianDetectionMs: median(rounds.map((round) => round.detectionMs)),
      p95DetectionMs: percentile(rounds.map((round) => round.detectionMs), 0.95),
      dimensions: [...new Set(planned.map((round) => round.dimension))],
      results: rounds,
      failure,
      proofHash: null,
      workspace: keepWorkspace ? workspace : null,
    };
    report.proofHash = sha256(stableStringify({ ...report, proofHash: null, workspace: null }));
    if (report.status !== 'passed' && options.throwOnFailure !== false) {
      const error = new Error(failure?.message
        ?? `P3 drift benchmark failed: ${detectedCount}/${planned.length} detected, ${recoveredCount}/${planned.length} recovered.`);
      error.report = report;
      throw error;
    }
    return report;
  } finally {
    if (!keepWorkspace) rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function renderDriftBenchmarkHtml(report) {
  const rows = report.results.map((round) => `<tr>
    <td><span class="round">${round.round}</span></td>
    <td><strong>${escapeHtml(round.dimension)}</strong><br><span>${escapeHtml(round.mutation)}</span></td>
    <td><code>${escapeHtml(round.expectedRule)}</code><br><small>${escapeHtml(round.observedRules.join(', '))}</small></td>
    <td class="result ${round.expectedDetected ? 'pass' : 'fail'}">${round.expectedDetected ? 'Detected' : 'Missed'}<br><small>${round.detectionMs} ms</small></td>
    <td class="result ${round.recoveryClean ? 'pass' : 'fail'}">${round.recoveryClean ? 'Clean' : 'Failed'}<br><small>${round.recoveryMs} ms</small></td>
  </tr>`).join('\n');
  const status = report.status === 'passed' ? 'PASS' : 'FAIL';
  const headline = report.status === 'passed'
    ? 'Ten edits entered. Ten drifts were caught.'
    : report.failure?.kind === 'timeout'
      ? 'The benchmark stopped at its safety boundary.'
      : 'The drift proof did not complete cleanly.';
  const lede = report.status === 'passed'
    ? 'A fresh shipped scaffold was mutated one dimension at a time. Each round invoked the public CLI, required the exact expected rule, restored the original bytes, and proved the workspace returned to zero findings.'
    : 'This report is failed evidence, not a partial pass. Completed rounds remain visible below; missing rounds were never credited.';
  const failure = report.failure
    ? `<p class="failure"><strong>${escapeHtml(report.failure.kind)}</strong> · ${escapeHtml(report.failure.message)}</p>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Axion P3 Drift Benchmark</title><style>
:root{color-scheme:light dark;--bg:#f3f0e8;--ink:#171713;--muted:#6b685e;--card:#fffdf7;--line:#d8d2c4;--accent:#0b6b53;--bad:#a63131;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media(prefers-color-scheme:dark){:root{--bg:#111310;--ink:#f4f0e7;--muted:#aaa597;--card:#191c18;--line:#34392f;--accent:#72d9b5;--bad:#ff8c82}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,sans-serif}main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:64px 0 80px}
.eyebrow{font:700 12px/1 var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}h1{font:650 clamp(38px,7vw,84px)/.96 Georgia,serif;letter-spacing:-.045em;margin:18px 0 20px;max-width:900px}.lede{max-width:720px;color:var(--muted);font-size:18px}
.score{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:38px 0}.metric{background:var(--card);border:1px solid var(--line);padding:22px}.metric b{display:block;font:650 32px/1 Georgia,serif}.metric span{color:var(--muted)}
.stamp{display:inline-flex;border:1px solid var(--accent);color:var(--accent);padding:8px 12px;font:700 12px var(--mono);letter-spacing:.12em}.failure{padding:14px 16px;border:1px solid var(--bad);color:var(--bad);font:13px var(--mono)}table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line)}th,td{padding:16px;text-align:left;border-bottom:1px solid var(--line);vertical-align:top}th{font:700 11px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted)}code,small,.round{font-family:var(--mono)}small{color:var(--muted)}.round{display:grid;place-items:center;width:28px;height:28px;border:1px solid var(--line);border-radius:50%}.result{font:700 12px var(--mono);text-transform:uppercase}.pass{color:var(--accent)}.fail{color:var(--bad)}footer{margin-top:18px;color:var(--muted);font:12px var(--mono);overflow-wrap:anywhere}
@media(max-width:760px){.score{grid-template-columns:1fr 1fr}table,thead,tbody,tr,th,td{display:block}thead{display:none}tr{padding:12px;border-bottom:1px solid var(--line)}td{border:0;padding:7px 4px}}
</style></head><body><main>
<div class="eyebrow">Axion Designer · deterministic product proof</div><h1>${escapeHtml(headline)}</h1>
<p class="lede">${escapeHtml(lede)}</p>${failure}
<div class="stamp">${status} · ${escapeHtml(report.proofHash.slice(0, 16))}</div>
<section class="score"><div class="metric"><b>${report.detected}/${report.rounds}</b><span>expected drifts detected</span></div><div class="metric"><b>${report.recovered}/${report.rounds}</b><span>restorations returned green</span></div><div class="metric"><b>${report.unexpectedFindings}</b><span>findings across ${report.cleanChecks} clean checks</span></div><div class="metric"><b>${report.medianDetectionMs} ms</b><span>median detection latency</span></div></section>
<table><thead><tr><th>Round</th><th>Mutation</th><th>Evidence</th><th>Detection</th><th>Recovery</th></tr></thead><tbody>${rows}</tbody></table>
<footer>${escapeHtml(report.schema)} · ${escapeHtml(report.isolation)} · proof sha256 ${escapeHtml(report.proofHash)}</footer>
</main></body></html>`;
}

function prepareGovernedWorkspace(workspace) {
  writeFileSync(join(workspace, 'dk.config.mjs'), `export default {
  preset: 'recommended',
  tokens: { source: 'design/tokens.json', output: { css: 'styles/tokens.css' } },
  direction: { source: 'design/direction.json', lock: 'design/direction.lock.json', required: true },
  targets: ['index.html'],
  ignore: ['**/node_modules/**', '**/.dk/**', '**/output/**'],
  failOn: 'warn',
  enforce: { spacing: 'warn', radius: 'warn', type: 'warn' },
  gates: { visual: { enabled: false } },
  baseline: '.dk/baseline.json',
};\n`);

  const direction = benchmarkDirection();
  const directionPath = join(workspace, 'design', 'direction.json');
  const lockPath = join(workspace, 'design', 'direction.lock.json');
  writeFileSync(directionPath, `${JSON.stringify(direction, null, 2)}\n`);
  const tokens = loadTokens(join(workspace, 'design', 'tokens.json'));
  const resolve = (path, mode) => resolveToken(tokens, path, mode);
  const bindingHash = hashDirectionBindings(direction, resolve);
  const directionHash = createDirectionLock(direction, null, { bindingHash }).directionHash;
  const approval = appendApproval(workspace, defaultApprovalHistoryPath(lockPath), {
    directionName: direction.name,
    directionHash,
    bindingHash,
    actor: 'Axion P3 benchmark',
    reason: 'Benchmark baseline approved before isolated mutation rounds.',
  }, { now: '2026-01-01T00:00:00.000Z' });
  const lock = createDirectionLock(direction, null, { bindingHash, approvalHeadHash: approval.headHash });
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
}

function benchmarkDirection() {
  return {
    $schema: 'https://unpkg.com/axion-designer/direction.schema.json',
    schema: 'dk-direction/v2',
    status: 'approved',
    name: 'Measured Calm',
    context: {
      register: 'product',
      product: 'A governed interface scaffold used to prove design drift detection and recovery.',
      audience: ['Product teams shipping AI-assisted interfaces'],
      task: 'Detect unintended visual-system drift before a change reaches production.',
      action: 'Review the exact finding and restore the approved system.',
      constraints: ['Every benchmark round must use the public CLI', 'Every mutation must recover to zero findings'],
    },
    identity: {
      thesis: 'Make design confidence feel measured, calm, and earned through visible evidence.',
      qualities: ['measured', 'calm', 'accountable'],
      signature: 'A compact evidence rail makes every design decision traceable to a deterministic check.',
      composition: 'A restrained reading column leads to a modular evidence grid with one dominant action.',
      responsive: 'Preserve task order on narrow screens while allowing evidence cards to stack without hiding status.',
      typography: 'Use a deliberate editorial display voice over a neutral system body and a compact mono evidence layer.',
      color: 'Neutral semantic surfaces carry the interface while one controlled accent marks decisions and focus.',
      form: 'Moderate tokenized radii, thin boundaries, and quiet elevation distinguish hierarchy without decoration.',
      motion: 'Use motion only to explain verification state changes and always honor reduced motion.',
      media: 'Use no filler media; every visual must carry verification or product meaning.',
      avoid: ['generic gradient hero decoration', 'unsourced vanity metrics', 'unbound one-off visual values'],
    },
    bindings: {
      accent: 'color.brand.accent',
      surface: 'color.surface.page',
      text: 'color.text.primary',
      displayFont: 'font.family.display',
      bodyFont: 'font.family.base',
      spacing: 'space.4',
      radius: 'radius.md',
    },
  };
}

function scenarios() {
  return [
    scenario('hardcoded-color', 'Token discipline', 'Replace a semantic brand color with a raw hex value.', 'slop/hardcoded-color', ['index.html'], (root) => {
      replaceIn(root, 'index.html', 'background: var(--color-brand-accent);', 'background: #0071e3;');
    }),
    scenario('off-scale-spacing', 'Rhythm', 'Introduce a 13px spacing value outside the approved ramp.', 'slop/hardcoded-spacing', ['index.html'], (root) => {
      replaceIn(root, 'index.html', 'padding: var(--space-3) var(--space-6);', 'padding: 13px var(--space-6);');
    }),
    scenario('default-ai-font', 'Typography', 'Replace deliberate typography with a denied AI-default font.', 'slop/ai-font', ['index.html'], (root) => {
      replaceIn(root, 'index.html', 'font-family: var(--font-family-base);', 'font-family: Inter, sans-serif;');
    }),
    scenario('placeholder-copy', 'Content integrity', 'Ship placeholder lorem ipsum as visible product copy.', 'slop/lorem', ['index.html'], (root) => {
      replaceIn(root, 'index.html', '從一份音準正確的畫布開始', 'Lorem ipsum dolor sit amet');
    }),
    scenario('vanity-metric', 'Trust', 'Add an unsourced “500+ teams” credibility claim.', 'slop/vanity-number', ['index.html'], (root) => {
      replaceIn(root, 'index.html', '由 Axion Designer 起手', 'Trusted by 500+ teams · 由 Axion Designer 起手');
    }),
    scenario('compiled-css-drift', 'SSOT integrity', 'Edit generated token CSS behind the source of truth.', 'tokens/ssot-sync', ['styles/tokens.css'], (root) => {
      replaceIn(root, 'styles/tokens.css', '--color-brand-accent: var(--color-base-accent-500);', '--color-brand-accent: #ff00aa;');
    }),
    scenario('identity-drift', 'Art direction', 'Silently rewrite the approved visual signature.', 'direction/drift', ['design/direction.json'], (root) => {
      mutateJson(root, 'design/direction.json', (doc) => { doc.identity.signature = 'A generic dashboard card grid silently replaces the approved evidence rail.'; });
    }),
    scenario('bound-token-drift', 'Taste Lock', 'Change the resolved value of an identity-bound accent token.', 'direction/drift', ['design/tokens.json'], (root) => {
      mutateJson(root, 'design/tokens.json', (tokens) => { tokens.color.base['accent-500'].$value = '#d4145a'; });
    }),
    scenario('unknown-token', 'Component contract', 'Reference a CSS token that does not exist in the manifest.', 'tokens/unknown-reference', ['index.html'], (root) => {
      replaceIn(root, 'index.html', 'color: var(--color-text-primary);', 'color: var(--color-does-not-exist);');
    }),
    scenario('contrast-regression', 'Accessibility', 'Move primary text close to the page surface until contrast fails.', 'tokens/contrast', ['design/tokens.json'], (root) => {
      mutateJson(root, 'design/tokens.json', (tokens) => { tokens.color.base['ink-900'].$value = '#fefefe'; });
    }),
  ];
}

function scenario(id, dimension, mutation, expectedRule, files, mutate) {
  return { id, dimension, mutation, expectedRule, files, mutate };
}

function verify(cli, cwd, timeoutMs) {
  const result = spawnSync(process.execPath, [cli, 'verify', '--json', '--no-cache'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    env: { ...process.env, DK_LANG: 'en', NO_COLOR: '1', FORCE_COLOR: '0', TZ: 'UTC', LC_ALL: 'C' },
  });
  if (result.error?.code === 'ETIMEDOUT') {
    return { exitCode: 2, report: { findings: [] }, stderr: result.stderr ?? '', timedOut: true };
  }
  if (result.error) throw result.error;
  let report;
  try { report = JSON.parse(result.stdout); }
  catch { throw new Error(`Benchmark could not parse dk JSON output (exit ${result.status}): ${result.stdout}\n${result.stderr}`); }
  return { exitCode: result.status ?? 2, report, stderr: result.stderr, timedOut: false };
}

function benchmarkTimeout(value) {
  const timeout = value == null ? DEFAULT_TIMEOUT_MS : value;
  if (!Number.isInteger(timeout) || timeout < MIN_TIMEOUT_MS || timeout > MAX_TIMEOUT_MS) {
    throw new RangeError(`benchmark timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return timeout;
}

function timeoutFailure(phase, round, scenarioId, timeoutMs) {
  const location = phase === 'baseline' ? 'baseline verification'
    : `${phase} verification for round ${round} (${scenarioId})`;
  return {
    kind: 'timeout', phase, round, scenarioId,
    message: `P3 drift benchmark timed out after ${timeoutMs} ms during ${location}.`,
  };
}

function timeoutRound(round, scenario, phase, durationMs) {
  return {
    round,
    id: scenario.id,
    dimension: scenario.dimension,
    mutation: scenario.mutation,
    expectedRule: scenario.expectedRule,
    expectedDetected: false,
    observedRules: [],
    exitCode: 2,
    findingCount: 0,
    detectionMs: roundMs(durationMs),
    recoveryClean: false,
    recoveryExitCode: 2,
    recoveryFindingCount: 0,
    recoveryMs: 0,
    timeoutPhase: phase,
  };
}

function snapshot(root, files) {
  return new Map(files.map((file) => [file, readFileSync(join(root, file))]));
}
function restore(root, files) {
  for (const [file, bytes] of files) writeFileSync(join(root, file), bytes);
}
function replaceIn(root, file, before, after) {
  const path = join(root, file);
  const source = readFileSync(path, 'utf8');
  if (!source.includes(before)) throw new Error(`Benchmark fixture changed: ${file} no longer contains ${JSON.stringify(before)}.`);
  writeFileSync(path, source.replace(before, after));
}
function mutateJson(root, file, mutation) {
  const path = join(root, file);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  mutation(value);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}
function ratio(value, total) { return total ? Number((value / total).toFixed(4)) : 0; }
function roundMs(value) { return Number(value.toFixed(1)); }
function median(values) { return percentile(values, 0.5); }
function percentile(values, rank) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return roundMs(sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * rank) - 1))]);
}
function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
