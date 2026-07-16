#!/usr/bin/env node

/**
 * Reproducible, zero-dependency product proof for Axion Designer.
 *
 * The demo creates a fresh scaffold in the OS temp directory, introduces one
 * exact SSOT violation, captures a real red run, lets dk apply its allowlisted
 * mechanical correction, and captures the resulting green run. Only the
 * evidence bundle is copied back into output/market-demo.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const CLI = join(REPO_ROOT, 'bin', 'dk.mjs');
const OUTPUT = join(REPO_ROOT, 'output', 'market-demo');
const KEEP_WORKSPACE = process.env.DK_KEEP_DEMO_WORKSPACE === '1';
const MAX_BUFFER = 32 * 1024 * 1024;

// The scaffold uses this semantic token in more than one place. Replacing the
// first occurrence gives the proof exactly one deliberate, reversible defect.
const TOKEN_DECLARATION = 'background: var(--color-brand-accent);';
const HARDCODED_DECLARATION = 'background: #0071e3;';

const records = [];

function invariant(condition, message) {
  if (!condition) throw new Error(`demo invariant failed: ${message}`);
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replaceAll('\\', '/');
}

function displayArg(arg) {
  return /^[A-Za-z0-9_./:=@-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

function commandLabel(args) {
  return `dk ${args.map(displayArg).join(' ')}`;
}

function runCli(args, cwd, expectedExit) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    env: {
      ...process.env,
      DK_LANG: 'en',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
      LC_ALL: 'C',
      TZ: 'UTC',
    },
  });

  if (result.error) throw result.error;
  const exitCode = result.status ?? 2;
  const record = {
    command: commandLabel(args),
    cwd,
    exitCode,
    stdout: cleanText(result.stdout),
    stderr: cleanText(result.stderr),
  };
  records.push(record);
  invariant(expectedExit.includes(exitCode), `${record.command} exited ${exitCode}; expected ${expectedExit.join(' or ')}\n${record.stdout}${record.stderr}`);
  return record;
}

function captured(record) {
  return `${record.stdout}${record.stderr ? `${record.stdout && !record.stdout.endsWith('\n') ? '\n' : ''}${record.stderr}` : ''}`;
}

function stableRecord(record, tempRoot, workspace) {
  const normalize = (value) => cleanText(value)
    .replaceAll(cleanText(workspace), '<TEMP_WORKSPACE>')
    .replaceAll(cleanText(tempRoot), '<TEMP_ROOT>')
    .replaceAll(cleanText(REPO_ROOT), '<REPOSITORY>');
  const chunks = [`$ ${record.command}`, normalize(record.stdout).trimEnd()];
  if (record.stderr) chunks.push(`[stderr]\n${normalize(record.stderr).trimEnd()}`);
  chunks.push(`[exit ${record.exitCode}]`);
  return chunks.filter(Boolean).join('\n');
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function listFiles(root, dir = root) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else if (entry.isFile()) files.push(relative(root, absolute).split(sep).join('/'));
  }
  return files.sort();
}

async function writeChecksums(root) {
  const sums = {};
  for (const rel of await listFiles(root)) {
    if (rel === 'checksums.json') continue;
    const body = await readFile(join(root, rel));
    sums[rel] = createHash('sha256').update(body).digest('hex');
  }
  await writeFile(join(root, 'checksums.json'), `${JSON.stringify({ algorithm: 'sha256', files: sums }, null, 2)}\n`);
}

async function validateReports(stage, fail, pass) {
  invariant(fail.version === 2, 'fail JSON must use report schema v2');
  invariant(fail.exitCode === 1, 'red JSON must preserve exit 1');
  invariant(fail.counts?.error === 1 && fail.counts?.warn === 0 && fail.counts?.info === 0, 'red run must contain exactly one blocking error');
  invariant(fail.findings?.length === 1, 'red run must contain exactly one finding');
  invariant(fail.findings[0].ruleId === 'slop/hardcoded-color', 'red finding must be slop/hardcoded-color');
  invariant(fail.findings[0].file === 'index.html', 'red finding must point at index.html');
  invariant(fail.findings[0].message.includes('#0071e3') && fail.findings[0].message.includes('var(--color-brand-accent)'), 'red finding must reverse-map the exact hex to the semantic token');
  invariant(fail.findings[0].fix === 'Use var(--color-brand-accent)', 'red finding must carry a concrete fix');

  invariant(pass.version === 2, 'pass JSON must use report schema v2');
  invariant(pass.exitCode === 0, 'green JSON must preserve exit 0');
  invariant(pass.counts?.error === 0 && pass.counts?.warn === 0 && pass.counts?.info === 0, 'green run must contain zero findings');
  invariant(pass.findings?.length === 0, 'green run findings must be empty');
  invariant(fail.tokenHash === pass.tokenHash, 'source-only correction must not change tokenHash');

  const failSarif = await readJson(join(stage, 'fail', 'report.sarif'));
  const passSarif = await readJson(join(stage, 'pass', 'report.sarif'));
  invariant(failSarif.version === '2.1.0', 'fail SARIF must be 2.1.0');
  invariant(failSarif.runs?.[0]?.results?.length === 1, 'fail SARIF must contain the real finding');
  invariant(passSarif.version === '2.1.0', 'pass SARIF must be 2.1.0');
  invariant(passSarif.runs?.[0]?.results?.length === 0, 'pass SARIF must contain zero results');

  const failHtml = await readFile(join(stage, 'fail', 'report.html'), 'utf8');
  const passHtml = await readFile(join(stage, 'pass', 'report.html'), 'utf8');
  invariant(failHtml.includes('Hardcoded color #0071e3'), 'fail HTML must render the real finding');
  invariant(passHtml.includes('No findings'), 'pass HTML must render the real clean state');
}

async function main() {
  await access(CLI);
  const tempRoot = await mkdtemp(join(tmpdir(), 'dk-market-demo-'));
  const workspace = join(tempRoot, 'workspace');

  try {
    // 1. Start from the product's own shipped scaffold, not a hand-built fixture.
    runCli(['new', 'workspace'], tempRoot, [0]);
    const sourcePath = join(workspace, 'index.html');
    const pristine = await readFile(sourcePath, 'utf8');
    invariant(count(pristine, TOKEN_DECLARATION) >= 1, 'scaffold no longer contains the expected semantic-token declaration');

    // 2. Introduce one exact, explainable violation.
    const badSource = pristine.replace(TOKEN_DECLARATION, HARDCODED_DECLARATION);
    invariant(count(badSource, HARDCODED_DECLARATION) === 1, 'proof injection must introduce exactly one hardcoded declaration');
    await writeFile(sourcePath, badSource);

    const stage = join(workspace, '.market-demo-artifacts');
    await mkdir(join(stage, 'fail'), { recursive: true });
    await mkdir(join(stage, 'transition'), { recursive: true });
    await mkdir(join(stage, 'pass'), { recursive: true });
    await writeFile(join(stage, 'fail', 'source.html'), badSource);

    // 3. Capture red terminal + machine reports from real CLI runs.
    const failTerminal = runCli(['verify', '--no-cache'], workspace, [1]);
    const failJsonRun = runCli(['verify', '--no-cache', '--json'], workspace, [1]);
    const fail = JSON.parse(failJsonRun.stdout);
    await writeFile(join(stage, 'fail', 'terminal.txt'), captured(failTerminal));
    await writeFile(join(stage, 'fail', 'report.json'), failJsonRun.stdout);
    const explain = runCli(['explain', 'slop/hardcoded-color'], workspace, [0]);
    await writeFile(join(stage, 'fail', 'explain.txt'), captured(explain));
    runCli(['report', '--html', '.market-demo-artifacts/fail/report.html'], workspace, [0]);
    runCli(['report', '--sarif', '--out', '.market-demo-artifacts/fail/report.sarif'], workspace, [0]);

    // 4. Apply the deliberately narrow mechanical correction and prove the
    // source returns byte-for-byte to the shipped tokenized form.
    const fix = runCli(['fix', '--slop'], workspace, [0]);
    await writeFile(join(stage, 'transition', 'fix.txt'), captured(fix));
    const repaired = await readFile(sourcePath, 'utf8');
    invariant(repaired === pristine, 'mechanical correction must restore the scaffold byte-for-byte');
    await writeFile(join(stage, 'pass', 'source.html'), repaired);

    // 5. Capture green terminal + machine reports from real CLI runs.
    const passTerminal = runCli(['verify', '--no-cache'], workspace, [0]);
    const passJsonRun = runCli(['verify', '--no-cache', '--json'], workspace, [0]);
    const pass = JSON.parse(passJsonRun.stdout);
    await writeFile(join(stage, 'pass', 'terminal.txt'), captured(passTerminal));
    await writeFile(join(stage, 'pass', 'report.json'), passJsonRun.stdout);
    runCli(['report', '--html', '.market-demo-artifacts/pass/report.html'], workspace, [0]);
    runCli(['report', '--sarif', '--out', '.market-demo-artifacts/pass/report.sarif'], workspace, [0]);

    await validateReports(stage, fail, pass);

    const transcript = `${records.map((record) => stableRecord(record, tempRoot, workspace)).join('\n\n')}\n`;
    await writeFile(join(stage, 'transcript.txt'), transcript);

    const manifest = {
      schema: 'dk-market-demo/v1',
      reproduce: 'node scripts/market-demo.mjs',
      isolation: 'fresh OS temporary workspace; removed after a successful run',
      dependencyPolicy: 'Node.js built-ins and the repository CLI only',
      injectedChange: {
        file: 'index.html',
        before: TOKEN_DECLARATION,
        violation: HARDCODED_DECLARATION,
      },
      fail: {
        exitCode: fail.exitCode,
        counts: fail.counts,
        filesScanned: fail.filesScanned,
        tokenHash: fail.tokenHash,
        finding: fail.findings[0],
      },
      correction: {
        command: 'dk fix --slop',
        policy: 'exact semantic-token reverse lookup; no value invented',
        sourceRestoredByteForByte: repaired === pristine,
      },
      pass: {
        exitCode: pass.exitCode,
        counts: pass.counts,
        filesScanned: pass.filesScanned,
        tokenHash: pass.tokenHash,
      },
      assertions: {
        exactlyOneBlockingFinding: fail.findings.length === 1 && fail.counts.error === 1,
        sameTokenHashAcrossSourceFix: fail.tokenHash === pass.tokenHash,
        jsonHtmlSarifValidated: true,
      },
    };
    await writeFile(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    await writeChecksums(stage);

    // Publish only after every product assertion passed, so a broken run never
    // replaces the last known-good evidence bundle.
    await mkdir(dirname(OUTPUT), { recursive: true });
    await rm(OUTPUT, { recursive: true, force: true });
    await cp(stage, OUTPUT, { recursive: true });

    process.stdout.write([
      '',
      'Axion Designer reproducible proof: PASS',
      `  red:   exit ${fail.exitCode} · ${fail.counts.error} blocking finding · ${fail.findings[0].file}:${fail.findings[0].line}`,
      '  fix:   #0071e3 → var(--color-brand-accent) · byte-for-byte restoration',
      `  green: exit ${pass.exitCode} · ${pass.counts.error} findings · tokenHash unchanged`,
      `  proof:  ${relative(REPO_ROOT, OUTPUT)}`,
      '',
    ].join('\n'));
  } finally {
    if (KEEP_WORKSPACE) process.stderr.write(`kept temporary workspace: ${workspace}\n`);
    else await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
