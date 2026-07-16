#!/usr/bin/env node
/* Claude Code integration: generated-bundle sync, scope guard, fail-closed
   install, receipt verification, and tamper detection. Mirrors the Codex
   integration contract for the `.claude/skills/dk-design` surface. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { axionSkillDigest } from '../skills/dk-design/scripts/runtime-integrity.mjs';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repo, 'bin', 'dk.mjs');
const root = mkdtempSync(join(tmpdir(), 'axion-claude-'));
const fakeHome = join(root, 'home');
const fakeClaudeConfig = join(root, 'claude-config');
mkdirSync(fakeHome, { recursive: true });
mkdirSync(fakeClaudeConfig, { recursive: true });

function run(cwd, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      DK_LANG: 'en',
      NO_COLOR: '1',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CLAUDE_CONFIG_DIR: fakeClaudeConfig,
      XDG_CACHE_HOME: join(root, 'xdg-cache'),
    },
  });
}

let failures = 0;
function check(name, fn) {
  try { fn(); process.stdout.write(`  ✓ ${name}\n`); }
  catch (error) { failures++; process.stdout.write(`  ✗ ${name}\n    ${error?.message ?? error}\n`); }
}

try {
  /* 1. Generated bundle must match a fresh deterministic rebuild (ssot-sync). */
  check('committed Claude bundle matches a fresh deterministic rebuild', () => {
    const rebuilt = join(root, 'rebuilt-bundle');
    const build = spawnSync(process.execPath, [join(repo, 'scripts', 'build-claude-skill.mjs'), '--out', rebuilt], { encoding: 'utf8' });
    assert.equal(build.status, 0, build.stderr);
    assert.equal(
      axionSkillDigest(join(repo, 'skills', 'dk-design-claude')),
      axionSkillDigest(rebuilt),
      'skills/dk-design-claude drifted from scripts/build-claude-skill.mjs output; rerun npm run build:claude-skill',
    );
  });

  /* 2. Generated SKILL.md carries no Codex host wording. */
  check('generated SKILL.md is host-clean', () => {
    const skill = readFileSync(join(repo, 'skills', 'dk-design-claude', 'SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /codex/i);
    assert.match(skill, /only after the user explicitly invokes/i);
    assert.match(skill, /~\/\.claude/);
  });

  /* 3. Global scopes are refused and never written. */
  check('home and CLAUDE_CONFIG_DIR scopes are refused', () => {
    const homeStatus = run(fakeHome, ['claude', 'status', '--json']);
    assert.equal(homeStatus.status, 2);
    assert.equal(JSON.parse(homeStatus.stdout).scopeGuard.status, 'forbidden');
    const homeInstall = run(fakeHome, ['claude', 'init', '--json']);
    assert.equal(homeInstall.status, 2);
    assert.equal(JSON.parse(homeInstall.stdout).code, 'DK_CLAUDE_SCOPE');
    const configInstall = run(fakeClaudeConfig, ['claude', 'init', '--json']);
    assert.equal(configInstall.status, 2);
    assert.equal(JSON.parse(configInstall.stdout).code, 'DK_CLAUDE_SCOPE');
    assert.equal(existsSync(join(fakeHome, '.claude')), false, 'refusal must write nothing to HOME');
    assert.equal(existsSync(join(fakeClaudeConfig, 'skills')), false, 'refusal must write nothing to CLAUDE_CONFIG_DIR');
  });

  /* 4. Install requires a matching project-local runtime. */
  const project = join(root, 'project');
  mkdirSync(project);
  writeFileSync(join(project, 'index.html'), '<!doctype html><title>Project</title>\n');

  check('missing runtime blocks install without partial writes', () => {
    const missing = run(project, ['claude', 'status', '--json']);
    assert.equal(missing.status, 2);
    assert.equal(JSON.parse(missing.stdout).status, 'missing');
    const blocked = run(project, ['claude', 'init', '--json']);
    assert.equal(blocked.status, 2);
    assert.equal(JSON.parse(blocked.stdout).code, 'DK_CLAUDE_RUNTIME');
    assert.equal(existsSync(join(project, '.claude')), false, 'runtime refusal writes no partial integration');
  });

  check('forged same-version runtime is rejected', () => {
    mkdirSync(join(project, 'node_modules'), { recursive: true });
    const forged = join(project, 'node_modules', 'axion-designer');
    mkdirSync(join(forged, 'bin'), { recursive: true });
    const version = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8')).version;
    writeFileSync(join(forged, 'package.json'), `${JSON.stringify({ name: 'axion-designer', version })}\n`);
    writeFileSync(join(forged, 'bin', 'dk.mjs'), '// forged same-version runtime\n');
    const blocked = run(project, ['claude', 'init', '--json']);
    assert.equal(blocked.status, 2);
    assert.equal(JSON.parse(blocked.stdout).code, 'DK_CLAUDE_RUNTIME');
    rmSync(forged, { recursive: true, force: true });
  });

  /* 5. Real dependency: install succeeds, is receipted, and is idempotent. */
  symlinkSync(repo, join(project, 'node_modules', 'axion-designer'), 'dir');
  const skillRoot = join(project, '.claude', 'skills', 'dk-design');

  check('install succeeds against a real project dependency', () => {
    const installed = run(project, ['claude', 'init', '--json']);
    assert.equal(installed.status, 0, installed.stderr || installed.stdout);
    const result = JSON.parse(installed.stdout);
    assert.equal(result.changed, true);
    assert.equal(result.scope, 'repository');
    assert.equal(result.activation, 'explicit');
    assert.equal(result.isolation.installerWritesGlobalConfig, false);
    assert(existsSync(join(skillRoot, 'SKILL.md')));
    const policy = JSON.parse(readFileSync(join(skillRoot, 'agents', 'claude.json'), 'utf8'));
    assert.equal(policy.policy.allowImplicitInvocation, false);
    const receipt = JSON.parse(readFileSync(join(skillRoot, '.axion-install.json'), 'utf8'));
    assert.equal(receipt.schema, 'axion-claude-skill-install/v1');
    assert.equal(receipt.scope, 'repository');
  });

  check('installed preflight resolves the project dependency runtime', () => {
    const preflight = spawnSync(process.execPath, [join(skillRoot, 'scripts', 'preflight.mjs'), '--cwd', project], {
      cwd: project,
      encoding: 'utf8',
      env: { ...process.env, HOME: fakeHome, CLAUDE_CONFIG_DIR: fakeClaudeConfig },
    });
    assert.equal(preflight.status, 0, preflight.stderr);
    const result = JSON.parse(preflight.stdout);
    assert.equal(result.schema, 'axion-claude-preflight/v1');
    assert.equal(result.runtime.kind, 'project-dependency');
  });

  check('repeat init is idempotent and status is ready', () => {
    const ready = run(project, ['claude', 'status', '--json']);
    assert.equal(ready.status, 0, ready.stderr || ready.stdout);
    assert.equal(JSON.parse(ready.stdout).status, 'ready');
    const repeated = run(project, ['claude', 'init', '--json']);
    assert.equal(repeated.status, 0);
    assert.equal(JSON.parse(repeated.stdout).changed, false);
  });

  check('claude context builds with claude-host commands', () => {
    const context = run(project, ['claude', 'context', '--json']);
    assert.equal(context.status, 0, context.stderr || context.stdout);
    const parsed = JSON.parse(context.stdout);
    assert.equal(parsed.host, 'claude');
    assert(parsed.authority.forbiddenGlobalWrites.includes('~/.claude'));
    assert(!JSON.stringify(parsed.nextCommands).includes('dk codex'));
  });

  /* 6. Tampering is detected; stale/invalid is never overwritten. */
  check('byte tampering invalidates the receipt and blocks re-init', () => {
    const skillFile = join(skillRoot, 'SKILL.md');
    writeFileSync(skillFile, `${readFileSync(skillFile, 'utf8')}\n<!-- tampered -->\n`);
    const status = run(project, ['claude', 'status', '--json']);
    assert.equal(status.status, 2);
    const parsed = JSON.parse(status.stdout);
    assert.equal(parsed.status, 'invalid');
    assert.match(parsed.skill.issue, /do not match their install receipt/);
    const blocked = run(project, ['claude', 'init', '--json']);
    assert.equal(blocked.status, 2);
    assert.equal(JSON.parse(blocked.stdout).code, 'DK_CLAUDE_EXISTS');
  });

  check('codex and claude integrations coexist independently', () => {
    rmSync(join(project, '.claude'), { recursive: true, force: true });
    const claude = run(project, ['claude', 'init', '--json']);
    assert.equal(claude.status, 0, claude.stderr || claude.stdout);
    const codex = run(project, ['codex', 'init', '--json']);
    assert.equal(codex.status, 0, codex.stderr || codex.stdout);
    assert(existsSync(join(project, '.claude', 'skills', 'dk-design', 'SKILL.md')));
    assert(existsSync(join(project, '.agents', 'skills', 'dk-design', 'SKILL.md')));
    const claudeReady = run(project, ['claude', 'status', '--json']);
    const codexReady = run(project, ['codex', 'status', '--json']);
    assert.equal(JSON.parse(claudeReady.stdout).status, 'ready');
    assert.equal(JSON.parse(codexReady.stdout).status, 'ready');
  });
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures) {
  process.stdout.write(`\nclaude integration: ${failures} failing check(s)\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('\nclaude integration: all checks passed\n');
}
