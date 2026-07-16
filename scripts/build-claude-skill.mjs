#!/usr/bin/env node

/**
 * Deterministically derive the Claude Code skill bundle from the canonical
 * Codex bundle at skills/dk-design.
 *
 * skills/dk-design is the single source of truth; skills/dk-design-claude is a
 * generated artifact, exactly like styles/tokens.css is generated from
 * design/tokens.json. Every host-specific rewrite below asserts that its
 * search text still exists in the canonical file, so canonical drift breaks
 * this build instead of silently forking the two bundles.
 *
 * tests/claude-integration.mjs rebuilds the bundle into a temporary directory
 * and requires digest equality with the committed one (ssot-sync semantics).
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL = join(repo, 'skills', 'dk-design');
const DEFAULT_OUT = join(repo, 'skills', 'dk-design-claude');

const outFlag = process.argv.indexOf('--out');
const OUT = outFlag !== -1 && process.argv[outFlag + 1] ? resolve(process.argv[outFlag + 1]) : DEFAULT_OUT;

function transform(source, replacements, label) {
  let text = source;
  for (const [from, to] of replacements) {
    if (!text.includes(from)) {
      throw new Error(`build-claude-skill: canonical ${label} no longer contains the expected text:\n  ${from}\nUpdate scripts/build-claude-skill.mjs alongside the canonical bundle.`);
    }
    text = text.split(from).join(to);
  }
  return text;
}

function assertNoHostLeak(text, label, allowed = []) {
  const scrubbed = allowed.reduce((value, phrase) => value.split(phrase).join(''), text);
  const leak = scrubbed.match(/codex/i);
  if (leak) {
    throw new Error(`build-claude-skill: generated ${label} still mentions "${leak[0]}"; add a rewrite rule.`);
  }
}

/* ---- SKILL.md ---- */
const skill = transform(readFileSync(join(CANONICAL, 'SKILL.md'), 'utf8'), [
  [
    'or any Codex task that must turn approved visual intent into code without later AI style drift.',
    'or any Claude Code task that must turn approved visual intent into code without later AI style drift.',
  ],
  [
    'Run this skill only after explicit `$dk-design` invocation. Never enable it implicitly or install it globally. Do not write `$HOME/.codex`, `~/.codex`, `$HOME/.agents`, `~/.agents`, `/etc/codex`, a personal marketplace, or the Codex plugin cache. Do not run `npm link`, `npm install -g`, `codex plugin add`, or `codex mcp add`. Project files, the bundled plugin, and an existing project dependency are the only allowed integration surfaces.',
    'Run this skill only after the user explicitly invokes `/dk-design` or names the dk-design skill. Never trigger it implicitly and never install it globally. Do not write `$HOME/.claude`, `~/.claude`, `$HOME/.agents`, `~/.agents`, a personal marketplace, or any plugin cache. Do not run `npm link`, `npm install -g`, or any user-scoped `claude mcp add`. Project files and an existing project dependency are the only allowed integration surfaces.',
  ],
  [
    'For the bundled plugin skill, it verifies the colocated runtime and skill digest, binds the invocation to the explicitly supplied target repository, and rejects filesystem-root, home, Codex-global, or user-global targets.',
    'For the bundled plugin skill, it verifies the colocated runtime and skill digest, binds the invocation to the explicitly supplied target repository, and rejects filesystem-root, home, agent-global, or user-global targets.',
  ],
  ['run `dk codex context --json` first', 'run `dk claude context --json` first'],
  [
    'read [references/codex-surfaces.md](references/codex-surfaces.md)',
    'read [references/claude-surfaces.md](references/claude-surfaces.md)',
  ],
  ['In the Codex desktop app, show the actual local PNGs', 'In the Claude Code desktop app, show the actual local PNGs'],
], 'SKILL.md');
assertNoHostLeak(skill, 'SKILL.md');

/* ---- references/claude-surfaces.md (from codex-surfaces.md) ---- */
const surfaces = transform(readFileSync(join(CANONICAL, 'references', 'codex-surfaces.md'), 'utf8'), [
  ['# Codex surface kernel', '# Claude Code surface kernel'],
  [
    'when deciding how to use Codex subagents, CLI, or the desktop app.',
    'when deciding how to use Claude Code subagents (the Agent tool), the CLI, or the desktop app.',
  ],
  ['Prefer `dk codex context --json`', 'Prefer `dk claude context --json`'],
], 'references/codex-surfaces.md');
assertNoHostLeak(surfaces, 'references/claude-surfaces.md');

/* ---- references/reconstruct.md ---- */
const reconstruct = transform(readFileSync(join(CANONICAL, 'references', 'reconstruct.md'), 'utf8'), [
  ['Codex may fill the decomposition, mapping, and plan', 'Claude may fill the decomposition, mapping, and plan'],
  ['Write each Codex-authored input as a project-local JSON draft', 'Write each Claude-authored input as a project-local JSON draft'],
], 'references/reconstruct.md');
assertNoHostLeak(reconstruct, 'references/reconstruct.md');

/* ---- scripts/preflight.mjs ---- */
const preflight = transform(readFileSync(join(CANONICAL, 'scripts', 'preflight.mjs'), 'utf8'), [
  ["const RECEIPT_SCHEMA = 'axion-codex-skill-install/v1';", "const RECEIPT_SCHEMA = 'axion-claude-skill-install/v1';"],
  [
    "    process.env.CODEX_HOME,\n    ...homes.flatMap((home) => [join(home, '.codex'), join(home, '.agents')]),\n    '/etc/codex',",
    "    process.env.CODEX_HOME,\n    process.env.CLAUDE_CONFIG_DIR,\n    ...homes.flatMap((home) => [join(home, '.codex'), join(home, '.claude'), join(home, '.agents')]),\n    '/etc/codex',",
  ],
  [
    "return owner ? `Codex global state cannot be used as a target repository (${owner})` : null;",
    "return owner ? `Agent-global state cannot be used as a target repository (${owner})` : null;",
  ],
  [
    "if (!sameRealPath(join(repository, '.agents', 'skills', SKILL_NAME), skillRoot)) {",
    "if (!sameRealPath(join(repository, '.claude', 'skills', SKILL_NAME), skillRoot)) {",
  ],
  [
    "issue: 'preflight --cwd must match the repository that owns .agents/skills/dk-design' };",
    "issue: 'preflight --cwd must match the repository that owns .claude/skills/dk-design' };",
  ],
  ["  schema: 'axion-codex-preflight/v1',", "  schema: 'axion-claude-preflight/v1',"],
  // The bundled-plugin path must recognize the generated Claude bundle location.
  [
    "      || !sameRealPath(join(root, 'skills', SKILL_NAME), skillRoot)) return null;",
    "      || !sameRealPath(join(root, 'skills', 'dk-design-claude'), skillRoot)) return null;",
  ],
  // inspectAxionRuntime hashes the canonical Codex bundle internally, so the
  // Claude bundle digest must not be passed as that expectation. The runtime
  // digest already attests both bundles (AXION_RUNTIME_PATHS includes
  // skills/dk-design-claude), and the receipt separately pins installed bytes.
  [
    'const inspected = inspectAxionRuntime(root, { name: PACKAGE_NAME, skillDigest: currentSkillDigest });',
    'const inspected = inspectAxionRuntime(root, { name: PACKAGE_NAME });',
  ],
  [
    "  const inspected = inspectAxionRuntime(candidate.root, {\n    name: PACKAGE_NAME,\n    version: receipt.version,\n    runtimeDigest: receipt.runtimeDigest,\n    skillDigest: receipt.sourceDigest,\n  });",
    "  const inspected = inspectAxionRuntime(candidate.root, {\n    name: PACKAGE_NAME,\n    version: receipt.version,\n    runtimeDigest: receipt.runtimeDigest,\n  });",
  ],
], 'scripts/preflight.mjs');

/* ---- agents/claude.json (explicit-invocation policy marker) ---- */
const policy = `${JSON.stringify({
  schema: 'axion-claude-skill-policy/v1',
  displayName: 'Axion Designer for Claude Code',
  shortDescription: 'Art-direct, build, inspect, and prove production Web UI.',
  defaultPrompt: 'Use the dk-design skill to art-direct or reconstruct this Web UI in the real repository, inspect mobile and desktop pixels, and prove the result without weakening policy.',
  policy: { allowImplicitInvocation: false },
}, null, 2)}\n`;

/* ---- assemble ---- */
rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'agents'), { recursive: true });
mkdirSync(join(OUT, 'references'), { recursive: true });
mkdirSync(join(OUT, 'scripts'), { recursive: true });

writeFileSync(join(OUT, 'SKILL.md'), skill);
writeFileSync(join(OUT, 'agents', 'claude.json'), policy);
writeFileSync(join(OUT, 'references', 'claude-surfaces.md'), surfaces);
writeFileSync(join(OUT, 'references', 'reconstruct.md'), reconstruct);
writeFileSync(join(OUT, 'scripts', 'preflight.mjs'), preflight);
for (const passthrough of ['evidence.md', 'product-ui.md', 'taste.md', 'visual-review.md']) {
  cpSync(join(CANONICAL, 'references', passthrough), join(OUT, 'references', passthrough));
}
cpSync(join(CANONICAL, 'scripts', 'runtime-integrity.mjs'), join(OUT, 'scripts', 'runtime-integrity.mjs'));

process.stdout.write(`claude skill bundle built: ${OUT}\n`);
