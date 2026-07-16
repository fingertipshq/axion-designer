#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  axionSkillDigest,
  findProjectAxionRuntime,
  inspectAxionRuntime,
} from './runtime-integrity.mjs';

const SKILL_NAME = 'dk-design';
const RECEIPT_SCHEMA = 'axion-codex-skill-install/v1';
const PACKAGE_NAME = 'axion-designer';
const skillRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const requested = process.argv[2] === '--cwd' && process.argv[3] ? resolve(process.argv[3]) : process.cwd();
const requestedRoot = realpathSync(requested);
const currentSkillDigest = axionSkillDigest(skillRoot);

function sameRealPath(left, right) {
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
}

function isInside(root, target) {
  const value = relative(resolve(root), resolve(target));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function projectScopeIssue(projectRoot) {
  if (dirname(projectRoot) === projectRoot) return 'the filesystem root is global scope, not a target repository';
  const homes = [process.env.HOME, process.env.USERPROFILE]
    .filter(Boolean)
    .map((path) => { try { return realpathSync(path); } catch { return resolve(path); } });
  if (homes.includes(projectRoot)) return 'the user home directory is global scope, not a target repository';
  const forbidden = [
    process.env.CODEX_HOME,
    ...homes.flatMap((home) => [join(home, '.codex'), join(home, '.agents')]),
    '/etc/codex',
  ].filter(Boolean).map((path) => { try { return realpathSync(path); } catch { return resolve(path); } });
  const owner = forbidden.find((path) => isInside(path, projectRoot));
  return owner ? `Codex global state cannot be used as a target repository (${owner})` : null;
}

function readReceipt(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value?.schema !== RECEIPT_SCHEMA
        || value.package !== PACKAGE_NAME
        || typeof value.version !== 'string'
        || !/^[a-f0-9]{64}$/i.test(value.sourceDigest ?? '')
        || !/^[a-f0-9]{64}$/i.test(value.runtimeDigest ?? '')) return null;
    return value;
  } catch { return null; }
}

function bundledRuntime() {
  const root = resolve(skillRoot, '..', '..');
  if (!existsSync(join(root, 'package.json'))
      || !existsSync(join(root, '.codex-plugin', 'plugin.json'))
      || !sameRealPath(join(root, 'skills', SKILL_NAME), skillRoot)) return null;
  const scopeIssue = projectScopeIssue(requestedRoot);
  if (scopeIssue) {
    return {
      status: 'invalid',
      repository: requestedRoot,
      issue: scopeIssue,
    };
  }
  const inspected = inspectAxionRuntime(root, { name: PACKAGE_NAME, skillDigest: currentSkillDigest });
  if (inspected.status !== 'ready') return { status: 'invalid', issue: inspected.issue };
  return {
    status: 'ready',
    repository: requestedRoot,
    kind: 'bundled-plugin',
    entry: join(inspected.root, 'bin', 'dk.mjs'),
    version: inspected.version,
    runtimeDigest: inspected.runtimeDigest,
  };
}

function copiedRuntime() {
  const repository = resolve(skillRoot, '..', '..', '..');
  if (!sameRealPath(join(repository, '.agents', 'skills', SKILL_NAME), skillRoot)) {
    return { status: 'invalid', repository: requestedRoot, issue: 'skill is neither a validated bundle nor a repository-scoped installation' };
  }
  if (requestedRoot !== realpathSync(repository)) {
    return { status: 'invalid', repository, issue: 'preflight --cwd must match the repository that owns .agents/skills/dk-design' };
  }
  const receipt = readReceipt(join(skillRoot, '.axion-install.json'));
  if (!receipt) return { status: 'invalid', repository, issue: 'repository skill is missing a valid Axion install receipt' };
  if (receipt.sourceDigest !== currentSkillDigest) {
    return { status: 'invalid', repository, issue: 'repository skill bytes do not match their install receipt' };
  }
  const candidate = findProjectAxionRuntime(repository, PACKAGE_NAME);
  if (candidate.status !== 'found') {
    return { status: 'missing', repository, issue: `matching ${PACKAGE_NAME}@${receipt.version} project dependency is missing` };
  }
  const inspected = inspectAxionRuntime(candidate.root, {
    name: PACKAGE_NAME,
    version: receipt.version,
    runtimeDigest: receipt.runtimeDigest,
    skillDigest: receipt.sourceDigest,
  });
  if (inspected.status !== 'ready') return { status: 'invalid', repository, issue: inspected.issue };
  return {
    status: 'ready',
    repository,
    kind: 'project-dependency',
    entry: join(inspected.root, 'bin', 'dk.mjs'),
    version: inspected.version,
    runtimeDigest: inspected.runtimeDigest,
  };
}

const resolved = bundledRuntime() ?? copiedRuntime();
const ready = resolved.status === 'ready' && existsSync(resolved.entry);
const result = {
  schema: 'axion-codex-preflight/v1',
  status: ready ? 'ready' : resolved.status,
  repository: resolved.repository ?? requestedRoot,
  skillRoot,
  runtime: ready ? {
    kind: resolved.kind,
    command: process.execPath,
    args: [realpathSync(resolved.entry)],
    version: resolved.version,
    digest: resolved.runtimeDigest,
  } : null,
  issue: ready ? null : resolved.issue,
  activation: 'explicit',
  scope: 'repository',
  globalWrites: false,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (!ready) process.exitCode = 2;
