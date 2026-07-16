/* ============================================================
   Claude Code project integration.

   Mirrors the Codex integration contract with the same small
   authority surface:
     - inspect the repository-scoped dk-design skill for Claude Code;
     - copy the generated Claude bundle into `.claude/skills/dk-design`;
     - never write user config, marketplaces, plugin caches, ~/.claude,
       or CLAUDE_CONFIG_DIR.

   The installer is fail-closed and non-overwriting. Existing installations
   are either accepted byte-for-byte or reported as stale/invalid.
   ============================================================ */
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { safeCopyDirectorySync, safeWriteFileSync } from '../core/safe-write.mjs';
import {
  axionRuntimeDigest,
  axionSkillDigest,
  findProjectAxionRuntime,
  inspectAxionRuntime,
} from '../../skills/dk-design/scripts/runtime-integrity.mjs';

export const CLAUDE_INTEGRATION_SCHEMA = 'axion-claude-integration/v1';
export const CLAUDE_INSTALL_RECEIPT_SCHEMA = 'axion-claude-skill-install/v1';
export const CLAUDE_SKILL_NAME = 'dk-design';
export const CLAUDE_SKILL_PATH = '.claude/skills/dk-design';

const packageRoot = realpathSync(resolve(fileURLToPath(new URL('../..', import.meta.url))));
const bundledSkillPath = join(packageRoot, 'skills', 'dk-design-claude');
const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
const RECEIPT_FILE = '.axion-install.json';
const expectedSkillDigest = axionSkillDigest(bundledSkillPath);
const expectedCanonicalSkillDigest = axionSkillDigest(join(packageRoot, 'skills', 'dk-design'));
const expectedRuntimeDigest = axionRuntimeDigest(packageRoot);

export class ClaudeIntegrationError extends Error {
  constructor(message, code = 'DK_CLAUDE_INTEGRATION') {
    super(message);
    this.name = 'ClaudeIntegrationError';
    this.code = code;
  }
}

function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function canonicalPath(path) {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function inspectProjectScope(projectRoot) {
  if (dirname(projectRoot) === projectRoot) {
    return { status: 'forbidden', issue: 'the filesystem root cannot be used as a project integration root' };
  }
  const homes = [process.env.HOME, process.env.USERPROFILE].filter(Boolean).map(canonicalPath);
  if (homes.includes(projectRoot)) {
    return { status: 'forbidden', issue: 'the user home directory is global scope, not a project repository' };
  }
  const forbiddenRoots = [
    process.env.CLAUDE_CONFIG_DIR,
    process.env.CODEX_HOME,
    ...homes.flatMap((home) => [join(home, '.claude'), join(home, '.codex'), join(home, '.agents')]),
  ].filter(Boolean).map(canonicalPath);
  const forbidden = forbiddenRoots.find((root) => isInside(root, projectRoot));
  if (forbidden) {
    return { status: 'forbidden', issue: `agent-global state cannot be used as a project integration root (${forbidden})` };
  }
  return { status: 'ready', issue: null };
}

/** Stable digest of every managed skill file, including its relative path. */
export function claudeSkillDigest(directory = bundledSkillPath) {
  return axionSkillDigest(directory);
}

function resolveInstalledSkill(root, destination) {
  let stat;
  try { stat = lstatSync(destination); }
  catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, kind: 'missing', actual: null, issue: null };
    throw error;
  }
  if (stat.isSymbolicLink()) {
    let actual;
    try { actual = realpathSync(destination); }
    catch (error) {
      return {
        exists: true,
        kind: 'symlink',
        actual: destination,
        issue: error?.code === 'ENOENT' ? 'skill symlink target is missing' : `skill symlink cannot be resolved: ${error?.message ?? error}`,
      };
    }
    if (!isInside(root, actual)) {
      return { exists: true, kind: 'symlink', actual, issue: 'skill symlink escapes the repository' };
    }
    if (!lstatSync(actual).isDirectory()) {
      return { exists: true, kind: 'symlink', actual, issue: 'skill symlink target is not a directory' };
    }
    return { exists: true, kind: 'symlink', actual, issue: null };
  }
  if (!stat.isDirectory()) {
    return { exists: true, kind: 'file', actual: destination, issue: 'skill destination is not a directory' };
  }
  return { exists: true, kind: 'directory', actual: destination, issue: null };
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch { return ''; }
}

function readInstallReceipt(skillRoot) {
  try {
    const receipt = JSON.parse(readFileSync(join(skillRoot, RECEIPT_FILE), 'utf8'));
    if (receipt?.schema !== CLAUDE_INSTALL_RECEIPT_SCHEMA
        || receipt.package !== pkg.name
        || typeof receipt.version !== 'string'
        || !/^[a-f0-9]{64}$/i.test(receipt.sourceDigest ?? '')
        || !/^[a-f0-9]{64}$/i.test(receipt.runtimeDigest ?? '')) return null;
    return receipt;
  } catch { return null; }
}

function inspectProjectRuntime(projectRoot) {
  if (projectRoot === packageRoot) {
    return {
      status: 'ready',
      kind: 'source-repository',
      path: 'bin/dk.mjs',
      version: pkg.version,
      digest: expectedRuntimeDigest,
      expectedDigest: expectedRuntimeDigest,
      issue: null,
    };
  }
  const candidate = findProjectAxionRuntime(projectRoot, pkg.name);
  if (candidate.status === 'found') {
    const inspected = candidate.root === packageRoot
      ? {
        status: 'ready', version: pkg.version, runtimeDigest: expectedRuntimeDigest,
        skillDigest: expectedSkillDigest, issue: null,
      }
      : inspectAxionRuntime(candidate.root, {
        name: pkg.name,
        version: pkg.version,
        runtimeDigest: expectedRuntimeDigest,
        skillDigest: expectedCanonicalSkillDigest,
      });
    return {
      status: inspected.status,
      kind: 'project-dependency',
      path: `${relative(projectRoot, join(candidate.linkPath, 'bin', 'dk.mjs')).split(sep).join('/')}`,
      version: inspected.version,
      digest: inspected.runtimeDigest,
      expectedDigest: expectedRuntimeDigest,
      issue: inspected.issue,
    };
  }
  return {
    status: 'missing',
    kind: 'missing',
    path: `${relative(projectRoot, join(candidate.linkPath, 'bin', 'dk.mjs')).split(sep).join('/')}`,
    version: null,
    digest: null,
    expectedDigest: expectedRuntimeDigest,
    issue: `install ${pkg.name}@${pkg.version} as a project dependency before enabling the copied skill`,
  };
}

/** Read-only project readiness inspection shared by CLI, tests, and hosts. */
export function inspectClaudeIntegration(root = process.cwd()) {
  const projectRoot = canonicalPath(root);
  const destination = join(projectRoot, ...CLAUDE_SKILL_PATH.split('/'));
  const expectedDigest = expectedSkillDigest;
  const scopeGuard = inspectProjectScope(projectRoot);
  const resolved = scopeGuard.status === 'ready'
    ? resolveInstalledSkill(projectRoot, destination)
    : { exists: false, kind: 'missing', actual: null, issue: null };
  const runtime = scopeGuard.status === 'ready'
    ? inspectProjectRuntime(projectRoot)
    : {
      status: 'invalid', kind: 'missing', path: null, version: null,
      digest: null, expectedDigest: expectedRuntimeDigest, issue: scopeGuard.issue,
    };
  let actualDigest = null;
  let skillName = null;
  let explicitOnly = false;
  let isolationGuard = false;
  let issue = resolved.issue;

  if (resolved.exists && !issue) {
    try {
      const skill = readText(join(resolved.actual, 'SKILL.md'));
      let policy = null;
      try { policy = JSON.parse(readText(join(resolved.actual, 'agents', 'claude.json'))); } catch { policy = null; }
      skillName = skill.match(/^name:\s*([^\n]+)$/m)?.[1]?.trim() ?? null;
      explicitOnly = policy?.policy?.allowImplicitInvocation === false
        && /only after the user explicitly invokes/i.test(skill);
      isolationGuard = /(?:~\/\.claude|\$HOME\/\.claude)/.test(skill)
        && /(?:~\/\.agents|\$HOME\/\.agents)/.test(skill)
        && /marketplace|plugin cache/i.test(skill);
      actualDigest = claudeSkillDigest(resolved.actual);
      if (skillName !== CLAUDE_SKILL_NAME) issue = `unexpected skill name: ${skillName ?? 'missing'}`;
      else if (!explicitOnly) issue = 'skill is not explicit-invocation only';
      else if (!isolationGuard) issue = 'skill is missing repository-isolation guardrails';
      else if (runtime.status !== 'ready') issue = runtime.issue;
      else if (resolved.kind === 'directory') {
        const receipt = readInstallReceipt(resolved.actual);
        if (!receipt) issue = 'repository skill is missing a valid Axion install receipt';
        else if (receipt.sourceDigest !== actualDigest) issue = 'repository skill bytes do not match their install receipt';
        else if (receipt.runtimeDigest !== runtime.digest || receipt.version !== runtime.version) {
          issue = 'repository skill receipt does not match the project-local runtime';
        }
      }
    } catch (error) {
      issue = error?.message ?? String(error);
    }
  }

  let status = scopeGuard.status === 'ready' ? 'missing' : 'invalid';
  if (scopeGuard.status === 'ready' && resolved.exists) {
    if (issue) status = 'invalid';
    else if (actualDigest !== expectedDigest) status = 'stale';
    else status = 'ready';
  }

  return {
    schema: CLAUDE_INTEGRATION_SCHEMA,
    status,
    project: basename(projectRoot),
    scope: 'repository',
    activation: 'explicit',
    scopeGuard,
    skill: {
      name: CLAUDE_SKILL_NAME,
      path: CLAUDE_SKILL_PATH,
      kind: resolved.kind,
      explicitOnly,
      digest: actualDigest,
      expectedDigest,
      issue,
    },
    runtime,
    surfaces: {
      cli: status === 'ready' ? 'ready' : 'setup-required',
      desktop: status === 'ready' ? 'ready' : 'setup-required',
      trustedProjectRequiredForProjectConfig: true,
    },
    isolation: {
      installerWrites: [CLAUDE_SKILL_PATH],
      installerWritesGlobalConfig: false,
      implicitInvocation: false,
      neverWrites: ['~/.claude', '~/.agents', 'CLAUDE_CONFIG_DIR', 'plugin caches', 'personal marketplace'],
    },
  };
}

/**
 * Install the generated Claude bundle into the current repository only.
 * Existing stale/custom content is never replaced.
 */
export function installClaudeIntegration(root = process.cwd(), options = {}) {
  const projectRoot = canonicalPath(root);
  const before = inspectClaudeIntegration(projectRoot);
  if (before.scopeGuard.status !== 'ready') {
    throw new ClaudeIntegrationError(
      `Refusing global Claude Code integration: ${before.scopeGuard.issue}.`,
      'DK_CLAUDE_SCOPE',
    );
  }
  if (before.status === 'ready') return { ...before, changed: false };
  if (before.status !== 'missing') {
    throw new ClaudeIntegrationError(
      `Refusing to overwrite ${CLAUDE_SKILL_PATH}: existing integration is ${before.status}${before.skill.issue ? ` (${before.skill.issue})` : ''}.`,
      'DK_CLAUDE_EXISTS',
    );
  }
  if (before.runtime.status !== 'ready') {
    throw new ClaudeIntegrationError(
      `Refusing to install a skill without its matching project-local runtime: ${before.runtime.issue}.`,
      'DK_CLAUDE_RUNTIME',
    );
  }

  const destination = join(projectRoot, ...CLAUDE_SKILL_PATH.split('/'));
  safeCopyDirectorySync(projectRoot, bundledSkillPath, destination);
  safeWriteFileSync(projectRoot, join(destination, RECEIPT_FILE), `${JSON.stringify({
    schema: CLAUDE_INSTALL_RECEIPT_SCHEMA,
    package: pkg.name,
    version: pkg.version,
    installedAt: options.now ?? new Date().toISOString(),
    scope: 'repository',
    activation: 'explicit',
    sourceDigest: claudeSkillDigest(bundledSkillPath),
    runtimeDigest: expectedRuntimeDigest,
  }, null, 2)}\n`);

  const after = inspectClaudeIntegration(projectRoot);
  if (after.status !== 'ready') {
    throw new ClaudeIntegrationError(`Installed Claude Code skill failed self-check: ${after.skill.issue ?? after.status}`, 'DK_CLAUDE_SELF_CHECK');
  }
  return { ...after, changed: true };
}

const STARTER_PROMPTS = {
  auto: 'Use the dk-design skill (/dk-design) to create or refine this interface. Keep the integration repository-scoped, inspect the real repository and rendered pixels, and prove the result before claiming success.',
  explore: 'Use the dk-design skill (/dk-design) in Explore lane. Keep the content and task fixed, compare three structurally distinct complete-surface directions, then implement and prove the strongest reviewed direction.',
  refine: 'Use the dk-design skill (/dk-design) in Refine lane. Preserve the approved direction, framework, routes, data flow, and unrelated code; fix only the highest-impact rendered gaps and rerun the relevant proof.',
  reconstruct: 'Use the dk-design skill (/dk-design) in Reconstruct lane. Register the authorized reference with provenance, decompose relationships instead of copying expression, map it onto the existing stack and components, then compare real rendered pixels and repair only the top scoped deltas.',
  reimagine: 'Use the dk-design skill (/dk-design) in Reimagine lane. Preserve real functionality and content, explore three materially different directions, and do not update the Taste Lock until I explicitly review the pixels.',
  verify: 'Use the dk-design skill (/dk-design) in Verify lane. Do not weaken policy or refresh locks and baselines; inspect compact evidence, fix deterministic findings, and report passed, incomplete, or failed honestly.',
};

export function claudeStarterPrompt(lane = 'auto') {
  const key = String(lane || 'auto').toLowerCase();
  if (!(key in STARTER_PROMPTS)) {
    throw new ClaudeIntegrationError(`Unknown Claude Code design lane: ${lane}`, 'DK_CLAUDE_LANE');
  }
  return STARTER_PROMPTS[key];
}

export function claudeStarterPrompts() {
  return { ...STARTER_PROMPTS };
}
