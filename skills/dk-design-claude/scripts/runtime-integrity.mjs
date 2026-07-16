import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const AXION_RUNTIME_DIGEST_SCHEMA = 'axion-runtime-digest/v1';
export const AXION_RUNTIME_PATHS = [
  '.codex-plugin/plugin.json',
  '.mcp.json',
  'bin',
  'bridge.schema.json',
  'direction.schema.json',
  'reference.schema.json',
  'dk.schema.json',
  'index.d.ts',
  'index.mjs',
  'package.json',
  'skills/dk-design',
  'skills/dk-design-claude',
  'src',
  'templates/scaffold',
];

const RECEIPT_FILE = '.axion-install.json';
const MAX_FILES = 10_000;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export class AxionRuntimeIntegrityError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AxionRuntimeIntegrityError';
    this.code = 'DK_CODEX_RUNTIME_INTEGRITY';
  }
}

function slash(value) { return value.split(sep).join('/'); }

function digestEntries(root, entries, options = {}) {
  const hash = createHash('sha256');
  let files = 0;
  let bytes = 0;
  const excluded = new Set(options.excludeNames ?? []);

  const addFile = (path, key) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new AxionRuntimeIntegrityError(`runtime digest refuses symbolic link: ${key}`);
    if (!stat.isFile()) throw new AxionRuntimeIntegrityError(`runtime digest expected a regular file: ${key}`);
    const source = readFileSync(path);
    files++;
    bytes += source.length;
    if (files > MAX_FILES || bytes > MAX_TOTAL_BYTES) {
      throw new AxionRuntimeIntegrityError('runtime digest exceeded its file or byte budget');
    }
    hash.update(key);
    hash.update('\0');
    hash.update(source);
    hash.update('\0');
  };

  const visit = (path, key) => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new AxionRuntimeIntegrityError(`runtime digest refuses symbolic link: ${key}`);
    if (stat.isFile()) { addFile(path, key); return; }
    if (!stat.isDirectory()) throw new AxionRuntimeIntegrityError(`runtime digest expected a file or directory: ${key}`);
    for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.has(entry.name) || entry.name === '.DS_Store') continue;
      visit(join(path, entry.name), `${key}/${entry.name}`);
    }
  };

  for (const entry of [...entries].sort()) visit(join(root, entry), slash(entry));
  return { digest: hash.digest('hex'), files, bytes };
}

export function axionSkillDigest(skillRoot) {
  const root = resolve(skillRoot);
  const entries = readdirSync(root).filter((name) => name !== RECEIPT_FILE && name !== '.DS_Store');
  return digestEntries(root, entries, { excludeNames: [RECEIPT_FILE] }).digest;
}

export function axionRuntimeDigest(packageRoot) {
  return digestEntries(resolve(packageRoot), AXION_RUNTIME_PATHS).digest;
}

export function inspectAxionRuntime(packageRoot, expected = {}) {
  const root = resolve(packageRoot);
  let canonicalRoot = null;
  let metadata = null;
  let runtimeDigest = null;
  let skillDigest = null;
  try {
    canonicalRoot = realpathSync(root);
    metadata = JSON.parse(readFileSync(join(canonicalRoot, 'package.json'), 'utf8'));
    if (expected.name && metadata.name !== expected.name) throw new Error(`expected package ${expected.name}, got ${metadata.name ?? 'missing'}`);
    if (expected.version && metadata.version !== expected.version) throw new Error(`expected version ${expected.version}, got ${metadata.version ?? 'missing'}`);
    runtimeDigest = axionRuntimeDigest(canonicalRoot);
    skillDigest = axionSkillDigest(join(canonicalRoot, 'skills', 'dk-design'));
    if (expected.runtimeDigest && runtimeDigest !== expected.runtimeDigest) throw new Error('runtime digest does not match the activating Axion bundle');
    if (expected.skillDigest && skillDigest !== expected.skillDigest) throw new Error('runtime skill digest does not match the activating $dk-design bundle');
    return {
      status: 'ready',
      root: canonicalRoot,
      name: metadata.name,
      version: metadata.version,
      runtimeDigest,
      skillDigest,
      issue: null,
    };
  } catch (error) {
    return {
      status: 'invalid',
      root: canonicalRoot ?? root,
      name: metadata?.name ?? null,
      version: metadata?.version ?? null,
      runtimeDigest,
      skillDigest,
      issue: error?.message ?? String(error),
    };
  }
}

export function pathInside(root, target) {
  const value = relative(resolve(root), resolve(target));
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`));
}

function hasGitBoundary(path) {
  try {
    const stat = lstatSync(join(path, '.git'));
    return stat.isDirectory() || stat.isFile();
  } catch { return false; }
}

/** Resolve a dependency from the project or its containing Git workspace only. */
export function findProjectAxionRuntime(projectRoot, packageName = 'axion-designer') {
  const root = realpathSync(resolve(projectRoot));
  let boundary = root;
  for (let current = root; ; current = dirname(current)) {
    if (hasGitBoundary(current)) { boundary = current; break; }
    if (dirname(current) === current) break;
  }
  for (let current = root; ; current = dirname(current)) {
    const linkPath = join(current, 'node_modules', packageName);
    try {
      return { status: 'found', root: realpathSync(linkPath), linkPath, projectRoot: root, boundary };
    } catch { /* try the next workspace ancestor */ }
    if (current === boundary || dirname(current) === current) break;
  }
  return {
    status: 'missing',
    root: null,
    linkPath: join(root, 'node_modules', packageName),
    projectRoot: root,
    boundary,
  };
}
